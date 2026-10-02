"""Neo Studio Backyard：Gallery 预处理 + OSS 上传管理（独立 Web 页面）。

页面路径 /neo-studio-backyard → web/backyard/index.html。
配置独立存储在 configs/backyard_oss.json，与 oss_presets.json 互不干扰。
"""

import asyncio
import json
import logging
import shutil
import subprocess
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CONFIG_PATH = Path(__file__).parent / "configs" / "backyard_oss.json"


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_config(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def _mask_config(cfg: dict) -> dict:
    out = dict(cfg)
    for key in ("access_key_id", "access_key_secret"):
        val = out.get(key, "")
        if len(val) > 8:
            out[key] = val[:4] + "*" * (len(val) - 8) + val[-4:]
        elif val:
            out[key] = "*" * len(val)
    return out


PLUGIN_ROOT = Path(__file__).parent


def _resolve_dir(p: str) -> Path:
    """相对路径基于插件根目录解析，绝对路径原样返回。"""
    path = Path(p)
    if not path.is_absolute():
        path = PLUGIN_ROOT / path
    return path.resolve()


# ====== SSE helper ======

async def _sse_stream(response: web.StreamResponse, run_fn, done_event: asyncio.Event):
    """将 run_fn 的 stdout 以 SSE 帧推送到前端，完成后发 done 帧。"""
    import io
    import contextlib

    queue: asyncio.Queue = asyncio.Queue()

    async def _runner():
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                run_fn()
            remaining = buf.getvalue()
            if remaining:
                for line in remaining.splitlines(keepends=True):
                    queue.put_nowait(line)
        except Exception as e:
            queue.put_nowait(f"[ERROR] {e}\n")
        finally:
            done_event.set()

    runner_task = asyncio.create_task(_runner())

    try:
        while True:
            get_task = asyncio.ensure_future(queue.get())
            done_task = asyncio.ensure_future(done_event.wait())
            done_task.add_done_callback(lambda _: get_task.cancel())
            get_task.add_done_callback(lambda _: done_task.cancel() if not done_task.done() else None)

            done, _ = await asyncio.wait([get_task, done_task], return_when=asyncio.FIRST_COMPLETED)
            if done_event.is_set() and get_task.cancelled():
                while not queue.empty():
                    line = queue.get_nowait()
                    payload = json.dumps({"msg": line}, ensure_ascii=False)
                    await response.write(f"data: {payload}\n\n".encode())
                break
            if get_task in done:
                line = get_task.result()
                payload = json.dumps({"msg": line}, ensure_ascii=False)
                await response.write(f"data: {payload}\n\n".encode())
    except (ConnectionResetError, asyncio.CancelledError):
        runner_task.cancel()
    finally:
        if not runner_task.done():
            runner_task.cancel()
        payload = json.dumps({"done": True}, ensure_ascii=False)
        try:
            await response.write(f"data: {payload}\n\n".encode())
        except Exception:
            pass


# ====== Preprocess core ======

IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS


def _generate_image_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        from PIL import Image
        with Image.open(source_path) as img:
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"  [WARN] thumbnail failed {source_path.name}: {e}")
        return False


def _generate_video_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            print("  [WARN] ffmpeg not found, skipping video thumbnail")
            return False
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [ffmpeg_path, "-ss", "00:00:00.500", "-i", str(source_path), "-vframes", "1", "-y", str(cache_path)]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            cmd = [ffmpeg_path, "-i", str(source_path), "-vframes", "1", "-y", str(cache_path)]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                return False
        if cache_path.stat().st_size < 1024:
            cache_path.unlink(missing_ok=True)
            return False
        return True
    except Exception:
        return False


def _generate_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    if source_path.suffix.lower() in VIDEO_EXTENSIONS:
        return _generate_video_thumbnail(source_path, cache_path, size)
    return _generate_image_thumbnail(source_path, cache_path, size)


def _parse_txt_preview(txt_path: Path, max_chars: int = 500) -> str:
    import re
    if not txt_path or not txt_path.exists():
        return ""
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            raw = f.read(max_chars)
        lines = raw.strip().splitlines()[:2]
        result = []
        for line in lines:
            m = re.match(r"^\d+\s*\|\s*(.*)", line)
            result.append(m.group(1).strip() if m else line.strip())
        return "\n".join(result)
    except Exception:
        return ""


def _load_existing_index(index_path: Path) -> dict | None:
    """加载已有 index.json 用于增量合并。"""
    if not index_path.exists():
        return None
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("directories"), dict):
            return data
    except Exception as e:
        print(f"  [WARN] 加载已有 index 失败: {e}")
    return None


def run_preprocess(source_dir: str, output_dir: str, size: int = 320, copy_media: bool = True, dirs: list | None = None) -> dict:
    """执行预处理，返回摘要。dirs 非空时为增量模式（合并到已有 index）。"""
    src = Path(source_dir).resolve()
    out = Path(output_dir).resolve()
    if not src.exists():
        raise FileNotFoundError(f"源目录不存在: {src}")
    out.mkdir(parents=True, exist_ok=True)

    thumb_dir = out / "thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    # 增量模式：加载已有 index 作为合并基础
    index_path = out / "index.json"
    existing = None
    if dirs:
        existing = _load_existing_index(index_path)
        if existing:
            print(f"  增量模式: 合并到已有 {len(existing['directories'])} 个目录")

    index = {"version": 1, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "base_url": "", "directories": {}}
    if existing:
        index["base_url"] = existing.get("base_url", "")

    if dirs:
        subdirs = []
        for d in dirs:
            p = src / d
            if not p.is_dir():
                print(f"  [WARN] 目录不存在，跳过: {p}")
                continue
            subdirs.append(p)
        if not subdirs:
            raise ValueError("没有有效的子目录可处理")
    else:
        subdirs = sorted([p for p in src.iterdir() if p.is_dir()])

    total_items = 0
    total_thumbs = 0

    for subdir in subdirs:
        dir_name = subdir.name
        print(f"\n[{dir_name}] 扫描中...")
        dir_entries = []
        stems: dict[str, list[Path]] = {}

        for p in subdir.iterdir():
            if not p.is_file():
                continue
            lower = p.suffix.lower()
            if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
                continue
            stems.setdefault(p.stem, []).append(p)

        for stem, files in sorted(stems.items()):
            media_file = None
            media_type = None
            txt_file = None
            for f in files:
                if f.suffix.lower() in VIDEO_EXTENSIONS:
                    media_file = f
                    media_type = "video"
                elif f.suffix.lower() in IMG_EXTENSIONS:
                    if media_file is None:
                        media_file = f
                        media_type = "image"
                elif f.suffix.lower() == ".txt":
                    txt_file = f
            if not media_file:
                continue

            thumb_path = thumb_dir / dir_name / f"{stem}.jpg"
            thumb_ok = False
            if not thumb_path.exists():
                thumb_ok = _generate_thumbnail(media_file, thumb_path, size)
                if thumb_ok:
                    total_thumbs += 1
            else:
                thumb_ok = True

            thumb_rel = f"thumbnails/{dir_name}/{stem}.jpg" if thumb_ok else ""
            txt_content = _parse_txt_preview(txt_file)
            dir_entries.append({
                "filename": media_file.name,
                "type": media_type,
                "size": media_file.stat().st_size,
                "mtime": media_file.stat().st_mtime,
                "txt_content": txt_content,
                "thumbnail": thumb_rel,
            })

            if copy_media:
                dest_subdir = out / dir_name
                dest_subdir.mkdir(parents=True, exist_ok=True)
                dest_media = dest_subdir / media_file.name
                if not dest_media.exists():
                    shutil.copy2(media_file, dest_media)
                if txt_file:
                    dest_txt = dest_subdir / txt_file.name
                    if not dest_txt.exists():
                        shutil.copy2(txt_file, dest_txt)

            total_items += 1

        index["directories"][dir_name] = {"name": dir_name, "items": dir_entries}
        print(f"  {len(dir_entries)} 个文件, {sum(1 for e in dir_entries if e['thumbnail'])} 张缩略图")

    # 增量合并：保留未触及的目录
    if existing:
        merged = dict(existing["directories"])
        merged.update(index["directories"])
        index["directories"] = merged
        # 保留 categories
        if existing.get("categories"):
            index["categories"] = existing["categories"]

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    total_dirs = len(index["directories"])
    print(f"\n{'='*50}")
    print(f"完成: {total_items} 个新文件, {total_thumbs} 张新缩略图")
    print(f"索引共 {total_dirs} 个目录 → {index_path}")
    return {"items": total_items, "thumbnails": total_thumbs, "total_dirs": total_dirs, "index_path": str(index_path)}


# ====== OSS Upload core ======

def run_oss_upload(source_dir: str, cfg: dict, dry_run: bool = False) -> dict:
    """执行 OSS 上传。"""
    import hashlib
    import mimetypes

    try:
        import oss2
    except ImportError:
        raise RuntimeError("oss2 未安装，请运行: pip install oss2")

    src = Path(source_dir).resolve()
    if not src.exists():
        raise FileNotFoundError(f"源目录不存在: {src}")
    index_path = src / "index.json"
    if not index_path.exists():
        raise FileNotFoundError("index.json 不存在，请先执行预处理")

    bucket_name = cfg.get("bucket", "")
    prefix = cfg.get("prefix", "")
    endpoint = cfg.get("endpoint", "")
    access_key_id = cfg.get("access_key_id", "")
    access_key_secret = cfg.get("access_key_secret", "")

    if not dry_run:
        if not all([bucket_name, endpoint, access_key_id, access_key_secret]):
            raise ValueError("OSS 配置不完整（bucket/endpoint/access_key_id/access_key_secret）")
        auth = oss2.Auth(access_key_id, access_key_secret)
        bucket = oss2.Bucket(auth, endpoint, bucket_name)
        bucket.get_bucket_info()
        print(f"[OK] 已连接 bucket: {bucket_name}")

    files = []
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(src).as_posix()
        files.append((p, rel))

    total = len(files)
    print(f"共 {total} 个文件待上传")

    uploaded = 0
    skipped = 0
    failed = 0
    STATIC_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov"}

    for i, (local_path, rel_key) in enumerate(files):
        oss_key = f"{prefix}{rel_key}" if prefix else rel_key
        content_type = mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"
        file_size = local_path.stat().st_size
        pct = (i + 1) / total * 100
        print(f"  [{i+1}/{total}] ({pct:.0f}%) {rel_key} ({file_size:,} bytes)", end="")

        if dry_run:
            print(" [DRY RUN]")
            uploaded += 1
            continue

        try:
            remote_meta = bucket.head_object(oss_key)
            remote_etag = remote_meta.etag.lower().strip('"')
            h = hashlib.md5()
            with open(local_path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            if remote_etag == h.hexdigest():
                print(" [SKIP]")
                skipped += 1
                continue
        except oss2.exceptions.NoSuchKey:
            pass
        except Exception:
            pass

        headers = {"Content-Type": content_type}
        if local_path.suffix.lower() in STATIC_EXTENSIONS:
            headers["Cache-Control"] = "max-age=2592000"
        try:
            bucket.put_object_from_file(oss_key, str(local_path), headers=headers)
            print(" [OK]")
            uploaded += 1
        except Exception as e:
            print(f" [FAIL] {e}")
            failed += 1

    print(f"\n上传完成: {uploaded} 成功, {skipped} 跳过, {failed} 失败")
    if not dry_run and uploaded > 0:
        endpoint_base = endpoint.replace("https://", "").replace("http://", "")
        public_url = f"https://{bucket_name}.{endpoint_base}/{prefix}index.json"
        print(f"\nIndex URL: {public_url}")

    return {"uploaded": uploaded, "skipped": skipped, "failed": failed, "total": total}


# ====== Routes ======

@PromptServer.instance.routes.get("/neo-studio-backyard")
async def backyard_page_route(request):
    """Backyard 独立页面短路径。"""
    return web.FileResponse(Path(__file__).parent / "web" / "backyard" / "index.html")


@PromptServer.instance.routes.get("/neo_backyard/config")
async def get_config_route(request):
    cfg = _load_config()
    return web.json_response({"success": True, "config": _mask_config(cfg)})


@PromptServer.instance.routes.post("/neo_backyard/config")
async def save_config_route(request):
    body = await request.json()
    cfg = _load_config()
    for key in ("access_key_id", "access_key_secret", "endpoint", "bucket", "prefix", "source_dir", "output_dir"):
        val = body.get(key, "")
        if val and "*" not in val:
            cfg[key] = val
    _save_config(cfg)
    return web.json_response({"success": True, "config": _mask_config(cfg)})


@PromptServer.instance.routes.post("/neo_backyard/preprocess")
async def preprocess_route(request):
    body = await request.json()
    source_dir = body.get("source_dir", "")
    output_dir = body.get("output_dir", "")
    size = int(body.get("size", 320))
    copy_media = body.get("copy_media", True)
    dirs = body.get("dirs") or None

    if not source_dir or not output_dir:
        return web.json_response({"success": False, "error": "source_dir 和 output_dir 不能为空"}, status=400)

    source_dir = str(_resolve_dir(source_dir))
    output_dir = str(_resolve_dir(output_dir))

    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    done_event = asyncio.Event()

    def _run():
        try:
            run_preprocess(source_dir, output_dir, size, copy_media, dirs)
        except Exception as e:
            print(f"[ERROR] {e}")

    await _sse_stream(response, _run, done_event)
    return response


@PromptServer.instance.routes.post("/neo_backyard/upload")
async def upload_route(request):
    body = await request.json()
    source_dir = body.get("source_dir", "")
    dry_run = body.get("dry_run", False)

    if not source_dir:
        return web.json_response({"success": False, "error": "source_dir 不能为空"}, status=400)

    source_dir = str(_resolve_dir(source_dir))
    cfg = _load_config()
    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    done_event = asyncio.Event()

    def _run():
        try:
            run_oss_upload(source_dir, cfg, dry_run)
        except Exception as e:
            print(f"[ERROR] {e}")

    await _sse_stream(response, _run, done_event)
    return response


@PromptServer.instance.routes.get("/neo_backyard/index")
async def get_index_route(request):
    """返回当前输出目录的 index.json 摘要（已上传到 OSS 的数据）。"""
    cfg = _load_config()
    output_dir = cfg.get("output_dir", "")
    if not output_dir:
        return web.json_response({"success": False, "error": "未配置输出目录"}, status=400)
    index_path = _resolve_dir(output_dir) / "index.json"
    if not index_path.exists():
        return web.json_response({"success": True, "exists": False, "directories": {}})
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

    dirs_summary = {}
    for name, info in (data.get("directories") or {}).items():
        items = info.get("items", [])
        dirs_summary[name] = {
            "count": len(items),
            "images": sum(1 for i in items if i.get("type") == "image"),
            "videos": sum(1 for i in items if i.get("type") == "video"),
        }
    return web.json_response({
        "success": True,
        "exists": True,
        "base_url": data.get("base_url", ""),
        "generated_at": data.get("generated_at", ""),
        "total_dirs": len(dirs_summary),
        "total_items": sum(d["count"] for d in dirs_summary.values()),
        "directories": dirs_summary,
    })


@PromptServer.instance.routes.get("/neo_backyard/dirs")
async def list_dirs_route(request):
    """列出输出目录的结构（供前端浏览/管理）。"""
    output_dir = request.query.get("path", "")
    if not output_dir:
        return web.json_response({"success": False, "error": "path 参数不能为空"}, status=400)
    p = _resolve_dir(output_dir)
    if not p.exists() or not p.is_dir():
        return web.json_response({"success": False, "error": f"目录不存在: {p}"}, status=404)

    entries = []
    for item in sorted(p.iterdir()):
        entry = {"name": item.name, "is_dir": item.is_dir()}
        if item.is_file():
            entry["size"] = item.stat().st_size
        else:
            count = sum(1 for _ in item.rglob("*") if _.is_file())
            entry["file_count"] = count
        entries.append(entry)

    return web.json_response({"success": True, "path": str(p), "entries": entries})


@PromptServer.instance.routes.post("/neo_backyard/delete")
async def delete_route(request):
    """删除输出目录中的文件或子目录。"""
    body = await request.json()
    output_dir = body.get("output_dir", "")
    name = body.get("name", "")

    if not output_dir or not name:
        return web.json_response({"success": False, "error": "output_dir 和 name 不能为空"}, status=400)

    base = _resolve_dir(output_dir)
    target = (base / name).resolve()

    if not str(target).startswith(str(base)):
        return web.json_response({"success": False, "error": "路径越界"}, status=403)
    if not target.exists():
        return web.json_response({"success": False, "error": f"不存在: {name}"}, status=404)

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()

    return web.json_response({"success": True, "deleted": name})