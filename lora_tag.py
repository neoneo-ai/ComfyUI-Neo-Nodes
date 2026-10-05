"""LoRA 打标：为画廊叶子图片目录批量生成标准化标签 .txt。

参照原 lora-train-tag 工作流（llama-cpp_vllm + GuHai_ImageLoaderPro + easy-use saveText）
的提示词逻辑，但不走 ComfyUI 执行队列：直接复用插件已有 LLM（本地 GGUF / 远程 API）
调用 lora_tag 任务 skill；可选先标准化目录（HEIC/HEIF→PNG + 001<ext>... 顺序编号）。

Routes:
- GET  /neo_gallery/tag_preflight  目录校验 + 图片数 + 建议触发词
- POST /neo_gallery/tag_dir        批量打标（SSE 进度）
"""
import asyncio
import json
import logging
import re
import threading
from pathlib import Path

from aiohttp import web
from server import PromptServer

from . import gallery
from .llm import run_llm_task

logger = logging.getLogger("NeoNodes.lora_tag")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"}
HEIF_EXTS = {".heic", ".heif"}
MAX_IMAGE_SIDE = 1024


def _sse_frame(obj) -> bytes:
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


def _sse_error_body(msg: str) -> bytes:
    return f"data: [ERROR] {msg}\n\ndata: [DONE]\n\n".encode("utf-8")


def _sse_error(msg: str) -> web.Response:
    return web.Response(body=_sse_error_body(msg), content_type="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _resolve_tag_dir(dir_param: str) -> Path:
    """把 "主目录/子路径" 解析为可写画廊目录的绝对路径。

    仅允许 Input 与用户自定义目录；presets/lora/civitai/oss 等只读来源拒绝。
    """
    dir_param = (dir_param or "").strip().replace("\\", "/")
    parts = [p for p in dir_param.split("/") if p]
    if not parts:
        raise ValueError("目录为空")
    if any(p in ("..", ".") for p in parts):
        raise ValueError("非法目录路径")
    head = parts[0].lower()
    if head in ("presets", "lora", gallery.CIVITAI_DIR_KEY.lower(), "cloud presets"):
        raise ValueError("只读目录不支持打标")

    target: Path | None = None
    system = gallery._resolve_system_dir(dir_param)
    if system:
        base, rel = system
        # Output 在画廊中是只读来源，与前端菜单可见性保持一致
        if base.name.lower() != "input":
            raise ValueError("该目录不支持打标")
        target = base / rel if rel else base
    else:
        for dir_path in gallery._get_user_custom_dirs():
            if dir_path.name.lower() == parts[0].lower():
                target = dir_path / "/".join(parts[1:]) if len(parts) > 1 else dir_path
                break
    if target is None:
        raise ValueError(f"目录不存在: {dir_param}")
    target = target.resolve()
    if not target.is_dir():
        raise ValueError(f"目录不存在: {dir_param}")
    return target


def _heif_available() -> bool:
    try:
        import pillow_heif  # noqa: F401
        return True
    except ImportError:
        return False


def _open_image(path: Path):
    from PIL import Image
    try:
        return Image.open(path)
    except Exception:
        if not _heif_available():
            raise
        import pillow_heif
        pillow_heif.register_heif_opener()
        return Image.open(path)


def _load_image_bytes(path: Path) -> bytes:
    """读取图片字节，最长边缩到 MAX_IMAGE_SIDE（与反推提示词一致），HEIF 编码为 PNG。"""
    import io
    from PIL import Image
    img = _open_image(path)
    w, h = img.size
    if max(w, h) > MAX_IMAGE_SIDE:
        ratio = MAX_IMAGE_SIDE / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    fmt = "PNG" if path.suffix.lower() in HEIF_EXTS else (img.format or "PNG")
    img.save(buf, format=fmt)
    return buf.getvalue()


def _random_trigger() -> str:
    """随机 4 字符非词（辅元交替），短目录名的触发词兜底。"""
    import random
    cons, vow = "bcdfghjklmnpqrstvwz", "aeiou"
    return (random.choice(cons) + random.choice(vow)) * 2


def _suggest_trigger(folder_name: str) -> str:
    """文件夹名 → 全拼连写（非中文字符原样保留），作为建议触发词；不足 4 字符时用随机非词兜底。"""
    from pypinyin import Style, lazy_pinyin
    raw = "".join(lazy_pinyin(folder_name, style=Style.NORMAL))
    letters = "".join(ch for ch in raw if ch.isascii() and ch.isalpha()).lower()
    return letters if len(letters) >= 4 else _random_trigger()


def _iter_tag_images(dir_path: Path) -> list[Path]:
    return sorted((f for f in dir_path.iterdir()
                   if f.is_file() and f.suffix.lower() in IMAGE_EXTS),
                  key=lambda f: f.name.lower())


def _backup_dir(dir_path: Path) -> str:
    """整目录复制到 <dir>.bak（旧 .bak 先替换），返回备份目录名。"""
    import shutil
    bak = dir_path.with_name(dir_path.name + ".bak")
    if bak.exists():
        shutil.rmtree(bak)
    shutil.copytree(dir_path, bak)
    return bak.name


def _standardize_dir(dir_path: Path) -> dict:
    """HEIC/HEIF → PNG 转换 + 按名称排序重命名为 001<ext>...（同名 .txt 跟随移动）。"""
    converted, renamed, skipped = [], [], []
    heif_ok = _heif_available()
    for f in sorted((p for p in dir_path.iterdir() if p.is_file()), key=lambda p: p.name.lower()):
        if f.suffix.lower() not in HEIF_EXTS:
            continue
        if not heif_ok:
            skipped.append(f.name)
            continue
        img = _open_image(f)
        out = f.with_suffix(".png")
        n = 1
        while out.exists():
            out = f.with_name(f"{f.stem}_{n}.png")
            n += 1
        img.convert("RGB").save(out, format="PNG")
        f.unlink()
        converted.append(f"{f.name} → {out.name}")

    for i, f in enumerate(_iter_tag_images(dir_path), start=1):
        target = dir_path / f"{i:03d}{f.suffix.lower()}"
        if target.exists() and target.resolve() != f.resolve():
            # 全部图片都参与顺序编号，正常不会撞名；保险起见防覆盖
            from folder_paths import unique_path
            target = Path(unique_path(str(dir_path), target.name))
        if target.resolve() == f.resolve():
            continue
        txt = f.with_suffix(".txt")
        f.rename(target)
        if txt.exists():
            txt.rename(target.with_suffix(".txt"))
        renamed.append(f"{f.name} → {target.name}")

    return {"converted": converted, "renamed": renamed, "skipped": skipped}


def _clean_caption(text: str, trigger_word: str = "") -> str:
    """清洗 LLM 输出：去代码围栏/引号，多行合并，标签统一为「, 」分隔（触发词开头）。"""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
    text = text.strip().strip('"').strip("'").strip()
    parts = [p.strip() for p in re.split(r"[,，;；\n]", text) if p.strip()]
    if trigger_word and (not parts or parts[0].lower() != trigger_word.lower()):
        parts.insert(0, trigger_word)
    return ", ".join(parts)


def _tag_batch(dir_path: Path, trigger_word: str, cancel: threading.Event | None = None):
    """逐张打标并写同名 .txt（覆盖）；单张失败不中断整批，cancel 置位后跑完当前张即停。yield 进度帧。"""
    images = _iter_tag_images(dir_path)
    total = len(images)
    done, failed = 0, []
    for i, f in enumerate(images, start=1):
        if cancel is not None and cancel.is_set():
            yield {"meta": {"status": "cancelled", "done": done, "total": total, "failed": failed}}
            return
        try:
            image_bytes = _load_image_bytes(f)
            result = run_llm_task("lora_tag", f"触发词: {trigger_word}", images=[image_bytes])
            if not isinstance(result, dict) or result.get("error"):
                err = (result or {}).get("error") if isinstance(result, dict) else "LLM 返回空结果"
                raise RuntimeError(str(err))
            text = _clean_caption(str(result.get("prompt") or ""), trigger_word)
            if not text:
                raise RuntimeError("LLM 返回空标签")
            f.with_suffix(".txt").write_text(text, encoding="utf-8")
            done += 1
            yield {"progress": {"index": i, "total": total, "file": f.name, "status": "ok", "caption": text}}
        except Exception as e:
            failed.append({"file": f.name, "error": str(e)})
            logger.warning(f"打标失败 {f.name}: {e}")
            yield {"progress": {"index": i, "total": total, "file": f.name, "status": "error", "error": str(e)}}
    yield {"meta": {"status": "success" if not failed else "partial",
                    "done": done, "total": total, "failed": failed}}


@PromptServer.instance.routes.get("/neo_gallery/tag_preflight")
async def neo_gallery_tag_preflight(request):
    """目录校验 + 图片数 + 建议触发词（文件夹名拼音首字母）。"""
    dir_param = request.query.get("dir", "")
    try:
        target = _resolve_tag_dir(dir_param)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    images = _iter_tag_images(target)
    return web.json_response({
        "image_count": len(images),
        "suggested_trigger": _suggest_trigger(target.name),
        "has_heif": any(f.suffix.lower() in HEIF_EXTS for f in images),
        "heif_available": _heif_available(),
    })


@PromptServer.instance.routes.post("/neo_gallery/tag_dir")
async def neo_gallery_tag_dir(request):
    """批量打标叶子图片目录（SSE 进度）；standardize=true 时先标准化目录。"""
    data = await request.json()
    dir_param = str(data.get("dir") or "")
    trigger_word = str(data.get("trigger_word") or "").strip()
    standardize = bool(data.get("standardize", True))
    if not trigger_word:
        return _sse_error("触发词不能为空")
    try:
        target = _resolve_tag_dir(dir_param)
    except ValueError as e:
        return _sse_error(str(e))
    if not _iter_tag_images(target):
        return _sse_error("该目录没有可打标的图片")

    cancel = threading.Event()

    def gen():
        if standardize:
            try:
                backup = _backup_dir(target)
                summary = _standardize_dir(target)
            except Exception as e:
                logger.error(f"标准化目录失败: {e}")
                yield {"meta": {"status": "error", "error": f"标准化目录失败: {e}"}}
                return
            yield {"progress": {"phase": "standardize", "backup": backup, **summary}}
        yield from _tag_batch(target, trigger_word, cancel)

    async def stream():
        g = gen()
        loop = asyncio.get_running_loop()

        def next_chunk():
            try:
                return next(g)
            except StopIteration:
                return None

        try:
            while True:
                try:
                    chunk = await loop.run_in_executor(None, next_chunk)
                except Exception as e:
                    logger.error(f"打标流错误: {e}")
                    yield _sse_error_body(str(e))
                    break
                if chunk is None:
                    break
                yield _sse_frame(chunk)
            yield b"data: [DONE]\n\n"
        finally:
            # 客户端中止（断开 / 取消）会取消本流：置位让执行器线程跑完当前这张就收工
            cancel.set()

    return web.Response(body=stream(), content_type="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

