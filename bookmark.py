# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — Bookmark module
# 收藏后端统一模块：本地收藏（仅记录路径信息，打开时基于路径查找）+
# C 站收藏（示例图边下边开，下载到一张即可打开）+
# OSS 预设收藏。收藏列表按需返回双图封面（取自该收藏项内容前两张媒体）。
# 从 recipes.py / gallery.py 收敛而来：gallery 只保留目录浏览，recipes 只保留配方。

import re
import json
import time
import uuid
import asyncio
import datetime
from pathlib import Path
from urllib.parse import urlparse
import aiohttp
from aiohttp import web
from server import PromptServer

from .util import (
    IMG_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _load_settings,
    _json_safe,
)

CURRENT_DIR = Path(__file__).parent.resolve()
GALLERY_DIR = CURRENT_DIR / "gallery"
CONFIGS_DIR = CURRENT_DIR / "configs"
CIVITAI_BOOKMARK_DIR = GALLERY_DIR / "civitai_bookmarks"  # cached example images for bookmarked C-site models
CIVITAI_DIR_NAME = "Civitai 收藏"  # first-level gallery dir for bookmarked C-site models (mirrors the Lora section)
BOOKMARKS_FILE = CONFIGS_DIR / "bookmarks.json"  # local bookmarks: path info only

CIVITAI_API_BASE = "https://civitai.com/api/v1"

# 当前 bookmark 示例图缓存进度（前端轮询，与后端 Lora auto-cache 用法一致）
_bookmark_cache_state: dict = {"running": False, "total": 0, "done": 0, "current": "", "error": ""}

# 内存缓存：模型 id -> 预览图 URL（仅存字符串，重启后按需重新拉取）
_civitai_cover_cache: dict = {}


def _is_civitai_bookmark_enabled() -> bool:
    """C 站收藏主开关（默认开启，与 Lora 板块的 civitai_lora_enabled 并列）。"""
    return bool(_load_settings().get("civitai_bookmark_enabled", True))


def _civitai_api_key() -> str:
    return str(_load_settings().get("civitai_api_key") or "").strip()


# ---------------------------------------------------------------------------
# 本地收藏（仅记录路径信息）
# ---------------------------------------------------------------------------

def _load_local_bookmarks() -> list:
    try:
        if BOOKMARKS_FILE.exists():
            data = json.loads(BOOKMARKS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("items"), list):
                return data["items"]
    except Exception:
        pass
    return []


def _save_local_bookmarks(items: list) -> None:
    try:
        BOOKMARKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = BOOKMARKS_FILE.with_name(BOOKMARKS_FILE.name + ".tmp")
        tmp.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        tmp.replace(BOOKMARKS_FILE)
    except Exception as e:
        print(f"[Neo Bookmark] Failed to save local bookmarks: {e}")


def _first_media_covers(directory: Path, subfolder: str, limit: int = 2) -> list:
    """Scan a bookmark target's content for its first `limit` media files (cover feed).

    与目录卡封面一致：按文件名排序取前两张，仅返回 filename + subfolder，
    缩略图 URL 由前端走 /neo_gallery/thumbnail 生成。
    """
    covers = []
    if not directory.is_dir():
        return covers
    exts = IMG_EXTENSIONS | VIDEO_EXTENSIONS
    for p in sorted(directory.iterdir()):
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith("_"):
            covers.append({"filename": p.name, "subfolder": subfolder})
            if len(covers) >= limit:
                break
    return covers


def _local_bookmark_covers(item: dict) -> list:
    """Resolve a local bookmark item's cover feed from its recorded path info."""
    source = item.get("source")
    dir_name = str(item.get("dir") or "")
    subfolder = str(item.get("subfolder") or "")
    if source == "civitai":
        key = dir_name or str(item.get("filename") or "")
        return _first_media_covers(CIVITAI_BOOKMARK_DIR / key, f"civitai_bookmarks/{key}")
    if source == "oss":
        # dir_name 已是完整 "Cloud Presets/<subdir>"；缓存目录与索引键用去前缀的 <subdir>
        oss_subdir = dir_name[len("Cloud Presets/"):] if dir_name.startswith("Cloud Presets/") else dir_name
        target = GALLERY_DIR / "oss_cache" / oss_subdir
        filename = str(item.get("filename") or "")
        if filename:
            # 单图收藏：仅显示本图（缩略图端点按需从索引/缓存拉取）
            return [{"filename": filename, "subfolder": dir_name}]
        return _first_media_covers(target, dir_name)
    # source == "local": 自定义目录或系统 Input/Output 目录
    from .gallery import _get_user_custom_dirs, _resolve_system_dir
    base = None
    for d in _get_user_custom_dirs():
        if d.name == dir_name or str(d) == dir_name:
            base = d
            break
    if base is None:
        resolved = _resolve_system_dir(dir_name)
        if resolved:
            base, subfolder = resolved[0], resolved[1]
    target = (base / subfolder) if base and subfolder else (base or Path())
    cover_sub = f"{dir_name}/{subfolder}" if subfolder else dir_name
    filename = str(item.get("filename") or "")
    if filename:
        # 单图收藏：仅显示本图，封面只取该文件（文件已删除则无封面）
        p = target / filename if target and target.is_dir() else None
        if p and p.exists():
            return [{"filename": filename, "subfolder": cover_sub}]
        return []
    return _first_media_covers(target, cover_sub)


def _dedupe_local_bookmark(item: dict, items: list) -> bool:
    key = (item.get("source"), item.get("dir") or "", item.get("subfolder") or "", item.get("filename") or "")
    return any(
        (it.get("source"), it.get("dir") or "", it.get("subfolder") or "", it.get("filename") or "") == key
        for it in items
    )
# ---------------------------------------------------------------------------
# Civitai sources — list bookmarked models, resolve pasted URLs, and cache
# example media locally so the standard gallery grid + lightbox can browse them.
# ---------------------------------------------------------------------------

def _civitai_headers(api_key: str) -> dict:
    headers = {"User-Agent": "ComfyUI-Neo-Nodes"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def _civitai_get(session, path: str, params: dict, api_key: str):
    """GET a Civitai API path. Returns (http_status, parsed_json)."""
    url = f"{CIVITAI_API_BASE}{path}"
    try:
        async with session.get(url, params=params, headers=_civitai_headers(api_key),
                               timeout=aiohttp.ClientTimeout(total=25)) as resp:
            if resp.status != 200:
                return resp.status, None
            return resp.status, await resp.json()
    except Exception:
        return 0, None


def _parse_civitai_model_id(url: str) -> int | None:
    """Extract a Civitai model id from a pasted model page or image URL."""
    if not isinstance(url, str):
        return None
    m = re.search(r"/models/(\d+)", url)
    if m:
        return int(m.group(1))
    m = re.search(r"[?&]model=(\d+)", url)
    if m:
        return int(m.group(1))
    return None


def _civitai_loras_from_version(version: dict) -> list:
    """Collect LORA names + strengths from example-image meta.civitaiResources[].weight."""
    seen = {}
    order = []
    for img in version.get("images") or []:
        meta = img.get("meta")
        if not isinstance(meta, dict):
            continue
        for res in meta.get("civitaiResources") or []:
            if not isinstance(res, dict):
                continue
            name = str(res.get("name") or "").strip()
            if not name:
                continue
            try:
                weight = float(res.get("weight", 1.0))
            except (TypeError, ValueError):
                weight = 1.0
            if name not in seen:
                seen[name] = weight
                order.append(name)
    return [{"name": n, "strength": seen[n]} for n in order]


def _civitai_prompt_from_version(version: dict) -> str:
    for img in version.get("images") or []:
        meta = img.get("meta")
        if isinstance(meta, dict):
            p = str(meta.get("prompt") or "").strip()
            if p:
                return p
    return ""


def _civitai_example_urls(version: dict) -> list:
    urls = []
    for img in version.get("images") or []:
        u = img.get("url")
        if isinstance(u, str) and u.startswith("http"):
            urls.append(u)
    return urls


def _civitai_example_images(version: dict) -> list:
    """Return [{url, prompt}] for a version's example images, in order."""
    out = []
    for img in version.get("images") or []:
        if not isinstance(img, dict):
            continue
        u = img.get("url")
        if not (isinstance(u, str) and u.startswith("http")):
            continue
        meta = img.get("meta")
        prompt = str(meta.get("prompt") or "").strip() if isinstance(meta, dict) else ""
        out.append({"url": u, "prompt": prompt})
    return out


async def _civitai_version_examples(session, version: dict, api_key: str) -> list:
    """Example media for a version via GET /images — the /models response only
    carries a truncated preview subset of images[], so use the images endpoint
    to get the real first N (with per-image prompt)."""
    vid = version.get("id")
    if not vid:
        return _civitai_example_images(version)
    status, body = await _civitai_get(session, "/images",
                                      {"modelVersionId": str(vid), "limit": "12", "withMeta": "true"}, api_key)
    if status == 200 and isinstance(body, dict):
        out = []
        for img in body.get("items") or []:
            if not isinstance(img, dict):
                continue
            u = img.get("url")
            if not (isinstance(u, str) and u.startswith("http")):
                continue
            meta = img.get("meta")
            prompt = str(meta.get("prompt") or "").strip() if isinstance(meta, dict) else ""
            out.append({"url": u, "prompt": prompt})
        if out:
            return out
    return _civitai_example_images(version)


_civitai_key_re = re.compile(r"[^\w\-]+")


def _civitai_bookmark_key(model_id, name: str) -> str:
    """Filesystem-safe subdir key for a bookmarked model (name-based, id fallback)."""
    n = _civitai_key_re.sub("_", str(name or "").strip()).strip("._ ")[:60]
    return n or f"model_{model_id}"


def _civitai_local_covers(model_id, name: str) -> list:
    """Cover feed (≤2) from locally cached example images, if any."""
    key = _civitai_bookmark_key(model_id, name)
    return _first_media_covers(CIVITAI_BOOKMARK_DIR / key, f"civitai_bookmarks/{key}")


def _civitai_cover_from_model(model: dict) -> str:
    """Best-effort preview image URL from a Civitai model object (list item or detail)."""
    if not isinstance(model, dict):
        return ""
    candidates = []
    imgs = model.get("images")
    if isinstance(imgs, list):
        candidates.extend(i.get("url") for i in imgs if isinstance(i, dict))
    for ver in model.get("modelVersions") or []:
        if not isinstance(ver, dict):
            continue
        for img in ver.get("images") or []:
            if isinstance(img, dict):
                candidates.append(img.get("url"))
    urls = [u for u in candidates if isinstance(u, str) and u.startswith("http")]
    for u in urls:
        ext = urlparse(u).path.lower().rsplit(".", 1)[-1]
        if ext not in {e.lstrip(".") for e in VIDEO_EXTENSIONS}:
            return u
    return ""
def _media_ext_from_url_or_bytes(url: str, data: bytes) -> str:
    """Pick a media extension for downloaded bytes: trust the URL suffix when it is a
    known media type, otherwise sniff the magic header."""
    path = urlparse(url).path.lower()
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".gif"):
        if path.endswith(ext):
            return ext
    head = data[:16]
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[4:8] == b"ftyp":
        return ".mp4"
    return ".bin"


async def _download_bytes(session, url: str, max_bytes: int | None = None) -> bytes | None:
    try:
        timeout = aiohttp.ClientTimeout(total=300 if max_bytes else 30)
        async with session.get(url, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            data = await resp.read()
            if max_bytes and len(data) > max_bytes:
                return None
            return data
    except Exception:
        return None


async def _download_bookmark_media_bg(examples: list, cache_dir: Path,
                                      meta_path: Path, prompt: str,
                                      start_idx: int = 0) -> None:
    """Background worker: download a bookmark's remaining example media so the
    gallery list fills in progressively (总进度通过 _bookmark_cache_state 轮询).

    编号从 start_idx 续起（同步首张为 sample_00），避免与已写文件冲突。
    """
    written = 0
    _bookmark_cache_state.update({"running": True, "current": "", "error": ""})
    try:
        async with aiohttp.ClientSession() as session:
            for i, ex in enumerate(examples, start=start_idx):
                _bookmark_cache_state["current"] = (ex["url"].rsplit("/", 1)[-1] or "")[:60]
                blob = await _download_bytes(session, ex["url"], max_bytes=64 * 1024 * 1024)
                _bookmark_cache_state["done"] += 1
                if not blob:
                    continue
                ext = _media_ext_from_url_or_bytes(ex["url"], blob)
                if ext not in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
                    continue
                stem = f"sample_{i:02d}"
                (cache_dir / f"{stem}{ext}").write_bytes(blob)
                if ex["prompt"]:
                    (cache_dir / f"{stem}.txt").write_text(ex["prompt"], encoding="utf-8")
                written += 1
        if written:
            meta_path.write_text(json.dumps({"prompt": prompt}, ensure_ascii=False),
                                 encoding="utf-8")
        else:
            _bookmark_cache_state["error"] = "No downloadable sample media"
    except Exception as e:
        _bookmark_cache_state["error"] = str(e)
    finally:
        _bookmark_cache_state.update({"running": False, "current": ""})
# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/neo_bookmark/local/add")
async def neo_bookmark_local_add(request):
    """Add a local bookmark. Only path info is recorded; opening resolves by path."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    source = str(data.get("source") or "local").strip()
    if source not in ("local", "oss", "civitai"):
        source = "local"
    name = str(data.get("name") or "").strip() or str(data.get("filename") or "未命名").strip()
    if not name:
        return web.json_response({"success": False, "error": "缺少名称"}, status=400)
    if ".." in str(data.get("dir") or "") or ".." in str(data.get("subfolder") or ""):
        return web.json_response({"success": False, "error": "非法路径"}, status=400)

    items = _load_local_bookmarks()
    item = {
        "id": uuid.uuid4().hex,
        "name": name[:120],
        "source": source,
        "dir": str(data.get("dir") or ""),
        "subfolder": str(data.get("subfolder") or ""),
        "filename": str(data.get("filename") or ""),
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if _dedupe_local_bookmark(item, items):
        return web.json_response({"success": False, "error": "该路径已在收藏中"}, status=409)
    items.insert(0, item)
    _save_local_bookmarks(items)
    return web.json_response({"success": True, "item": item})


@PromptServer.instance.routes.get("/neo_bookmark/local")
async def neo_bookmark_local_list(request):
    """List local bookmarks with per-item cover feed (≤2) from their content."""
    items = _load_local_bookmarks()
    out = []
    for it in items:
        entry = dict(it)
        entry["covers"] = _local_bookmark_covers(it)
        out.append(entry)
    return web.json_response({"success": True, "items": out})


@PromptServer.instance.routes.post("/neo_bookmark/local/remove")
async def neo_bookmark_local_remove(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    bid = str(data.get("id") or "")
    items = _load_local_bookmarks()
    kept = [it for it in items if it.get("id") != bid]
    if len(kept) == len(items):
        return web.json_response({"success": False, "error": "收藏不存在"}, status=404)
    _save_local_bookmarks(kept)
    return web.json_response({"success": True})


BOOKMARK_LIST_TTL = 86400.0  # 24h — list is cache-first; explicit refresh bypasses it


def _load_bookmark_list_cache() -> dict:
    p = CIVITAI_BOOKMARK_DIR / "_list_cache.json"
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_bookmark_list_cache(data: dict) -> None:
    p = CIVITAI_BOOKMARK_DIR / "_list_cache.json"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
@PromptServer.instance.routes.post("/neo_bookmark/civitai/list")
async def neo_bookmark_civitai_list(request):
    """List the user's bookmarked Civitai models (paged). Cache-first; each item
    carries a ≤2-image cover feed from its locally cached examples when available."""
    if not _is_civitai_bookmark_enabled():
        return web.json_response({"success": False, "disabled": True,
                                  "error": "C 站收藏开关已关闭（可在 Manage Directories 开启）"}, status=403)
    api_key = _civitai_api_key()
    if not api_key:
        return web.json_response({"success": False, "needs_api_key": True,
                                  "error": "未配置 Civitai API KEY"}, status=400)
    try:
        data = await request.json()
    except Exception:
        data = {}
    page = int(data.get("page", 0) or 0)
    refresh = bool(data.get("refresh"))
    limit = 24
    cache = _load_bookmark_list_cache()
    entry = (cache.get("pages") or {}).get(str(page))
    if not refresh and entry and time.time() - float(cache.get("ts", 0)) < BOOKMARK_LIST_TTL:
        # 命中缓存也刷新一次本地封面：后台刚缓存/新下载示例时列表立即可见双图。
        items = list(entry["items"])
        for it in items:
            if it.get("id") is not None:
                lc = _civitai_local_covers(it.get("id"), it.get("name") or "")
                if lc:
                    it["covers"] = lc
        return web.json_response({"success": True, "items": items, "page": page,
                                  "has_more": entry["has_more"]})
    async with aiohttp.ClientSession() as session:
        status, body = await _civitai_get(session, "/models", {
            "favorites": "true", "type": "Model", "limit": str(limit), "skip": str(page * limit),
        }, api_key)
    if status in (401, 403):
        return web.json_response({"success": False, "error": "Civitai API KEY 无效"}, status=401)
    if status != 200 or not isinstance(body, dict):
        if entry:  # network failure: fall back to the stale cache
            return web.json_response({"success": True, "items": entry["items"], "page": page,
                                      "has_more": entry["has_more"]})
        return web.json_response({"success": False, "error": f"Civitai HTTP {status or 'error'}"}, status=502)
    items = []
    for it in body.get("items") or []:
        if not isinstance(it, dict):
            continue
        mid = it.get("id")
        mname = it.get("name") or ""
        covers = _civitai_local_covers(mid, mname)
        if not covers:
            remote = _civitai_cover_from_model(it)
            covers = [{"url": remote}] if remote else []
        items.append({
            "id": mid,
            "name": mname,
            "type": it.get("type") or "",
            "baseModel": it.get("baseModel") or "",
            "nsfw": bool(it.get("nsfw")),
            "covers": covers,
        })
    pages = cache.get("pages") or {}
    pages[str(page)] = {"items": items, "has_more": len(items) >= limit}
    _save_bookmark_list_cache({"ts": time.time(), "pages": pages})
    return web.json_response({"success": True, "items": items, "page": page,
                              "has_more": len(items) >= limit})
@PromptServer.instance.routes.post("/neo_bookmark/civitai/cover")
async def neo_bookmark_civitai_cover(request):
    """Return a preview image URL for one Civitai model (cached in memory), used as the
    lazy-loaded gallery cover for a bookmarked model card without local examples."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    model_id = data.get("id")
    if not model_id:
        return web.json_response({"success": False, "error": "缺少模型 id"}, status=400)
    api_key = _civitai_api_key()
    if not api_key:
        return web.json_response({"success": False, "needs_api_key": True}, status=400)

    key = str(model_id)
    if key in _civitai_cover_cache:
        return web.json_response({"success": True, "cover": _civitai_cover_cache[key]})

    async with aiohttp.ClientSession() as session:
        status, body = await _civitai_get(session, f"/models/{model_id}", {}, api_key)
    if status in (401, 403):
        return web.json_response({"success": False, "error": "Civitai API KEY 无效"}, status=401)
    if status != 200 or not isinstance(body, dict):
        return web.json_response({"success": False, "cover": "",
                                  "error": f"Civitai HTTP {status or 'error'}"})

    cover = _civitai_cover_from_model(body.get("model") or {})
    _civitai_cover_cache[key] = cover
    return web.json_response({"success": True, "cover": cover})


@PromptServer.instance.routes.post("/neo_bookmark/civitai/resolve")
async def neo_bookmark_civitai_resolve(request):
    """Resolve a pasted Civitai model/image URL into recipe-ready metadata."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    url = str(data.get("url") or "").strip()
    if not url:
        return web.json_response({"success": False, "error": "缺少链接"}, status=400)
    model_id = _parse_civitai_model_id(url)
    if model_id is None:
        return web.json_response({"success": False,
                                  "error": "无法从该链接解析 Civitai 模型（支持 civitai.com/models/<id> 或含 ?model=<id> 的图片链接）"}, status=400)
    api_key = _civitai_api_key()
    async with aiohttp.ClientSession() as session:
        status, body = await _civitai_get(session, f"/models/{model_id}", {"withVersionFiles": "true"}, api_key)
    if status in (401, 403):
        return web.json_response({"success": False, "error": "Civitai API KEY 无效（付费/私有模型需有效 KEY）"}, status=401)
    if status == 404:
        return web.json_response({"success": False, "error": "未找到该 Civitai 模型"}, status=404)
    if status != 200 or not isinstance(body, dict):
        return web.json_response({"success": False, "error": f"Civitai HTTP {status or 'error'}"}, status=502)

    model = body.get("model") or {}
    versions = body.get("modelVersions") or []
    version = versions[0] if versions and isinstance(versions[0], dict) else {}
    return web.json_response(_json_safe({
        "success": True,
        "model_id": model_id,
        "name": model.get("name") or "",
        "type": model.get("type") or "",
        "base_model": model.get("baseModel") or "",
        "nsfw": bool(model.get("nsfw")),
        "version_name": version.get("name") or "",
        "prompt": _civitai_prompt_from_version(version),
        "images": _civitai_example_urls(version)[:8],
        "loras": _civitai_loras_from_version(version),
    }))
@PromptServer.instance.routes.post("/neo_bookmark/civitai/media")
async def neo_bookmark_civitai_media(request):
    """Open a bookmarked model: cache its example images locally (mirroring the Lora
    cache). 边下边开：完全缓存时一次返回全部；否则同步下载第一张即返回，
    其余由后台任务续下，前端通过 /neo_bookmark/civitai/status 轮询进度并按需刷新。"""
    try:
        data = await request.json()
    except Exception:
        data = {}
    model_id = data.get("id")
    if not model_id:
        return web.json_response({"success": False, "error": "缺少模型 id"}, status=400)
    api_key = _civitai_api_key()
    if not api_key:
        return web.json_response({"success": False, "needs_api_key": True,
                                  "error": "未配置 Civitai API KEY"}, status=400)
    try:
        model_id = int(model_id)
    except (TypeError, ValueError):
        return web.json_response({"success": False, "error": "无效的模型 id"}, status=400)

    name = str(data.get("name") or "").strip()
    key = _civitai_bookmark_key(model_id, name)
    cache_dir = CIVITAI_BOOKMARK_DIR / key
    subfolder = f"civitai_bookmarks/{key}"
    meta_path = cache_dir / "meta.json"

    # Fast path: serve example media already cached locally (prefer the local copy).
    # 按需打开：只要本地已有示例图就直接返回，即使 meta.json 缺失（下载曾被中断/未完成）
    # 也优先展示已缓存内容，避免强制走 C 站网络导致「目录下已有图片却打不开」。
    media_exts = IMG_EXTENSIONS | VIDEO_EXTENSIONS
    if cache_dir.is_dir():
        files = sorted(p.name for p in cache_dir.iterdir() if p.is_file() and p.suffix.lower() in media_exts)
    else:
        files = []
    if files:
        meta = {}
        if meta_path.is_file():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                meta = {}
        return web.json_response({
            "success": True,
            "model_key": key,
            "subfolder": subfolder,
            "prompt": str(meta.get("prompt") or ""),
            "images": [{"filename": fn, "subfolder": subfolder} for fn in files],
            "complete": True,
            "total": len(files),
        })

    # Slow path: fetch version detail and example media list (with per-image prompt).
    async with aiohttp.ClientSession() as session:
        status, body = await _civitai_get(session, f"/models/{model_id}", {"withVersionFiles": "true"}, api_key)
    if status in (401, 403):
        return web.json_response({"success": False, "error": "Civitai API KEY 无效"}, status=401)
    if status == 404:
        return web.json_response({"success": False, "error": "未找到该 Civitai 模型"}, status=404)
    if status != 200 or not isinstance(body, dict):
        return web.json_response({"success": False, "error": f"Civitai HTTP {status or 'error'}"}, status=502)

    versions = body.get("modelVersions") or []
    version = versions[0] if versions and isinstance(versions[0], dict) else {}
    async with aiohttp.ClientSession() as session:
        examples = await _civitai_version_examples(session, version, api_key)
    if not examples:
        return web.json_response({"success": False, "error": "该模型暂无可缓存的示例图"}, status=404)

    prompt = next((ex["prompt"] for ex in examples if ex["prompt"]), "")
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Clear stale samples from a previous partial run (keep meta.json).
    for stale in cache_dir.iterdir():
        if stale.is_file() and stale.name.startswith("sample_"):
            stale.unlink()

    # 同步下载第一张，返回即可打开目录；剩余交给后台任务续下。
    async with aiohttp.ClientSession() as session:
        first = await _download_bytes(session, examples[0]["url"], max_bytes=64 * 1024 * 1024)
    images = []
    if first:
        ext = _media_ext_from_url_or_bytes(examples[0]["url"], first)
        if ext in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
            stem = "sample_00"
            (cache_dir / f"{stem}{ext}").write_bytes(first)
            if examples[0]["prompt"]:
                (cache_dir / f"{stem}.txt").write_text(examples[0]["prompt"], encoding="utf-8")
            images.append({"filename": f"{stem}{ext}", "subfolder": subfolder})

    # 其余示例图后台续下（同一缓存目录，编号从 sample_01 起，进度由 status 轮询）。
    remaining = examples[1:] if images else examples
    if len(remaining) > 1 or (not images and remaining):
        _bookmark_cache_state.update({"running": True, "total": len(examples),
                                      "done": 1 if images else 0, "current": "", "error": ""})
        asyncio.get_event_loop().create_task(
            _download_bookmark_media_bg(remaining, cache_dir, meta_path, prompt,
                                        start_idx=1 if images else 0))

    if not images:
        _bookmark_cache_state["error"] = "No downloadable sample media"

    return web.json_response({
        "success": True,
        "model_key": key,
        "subfolder": subfolder,
        "prompt": prompt,
        "images": images,
        "complete": False,
        "total": len(examples),
    })


@PromptServer.instance.routes.get("/neo_bookmark/civitai/status")
async def neo_bookmark_civitai_status(request):
    """Return the current bookmark example-cache worker state (polled by the UI)."""
    state = dict(_bookmark_cache_state)
    state["enabled"] = _is_civitai_bookmark_enabled()
    return web.json_response(state)


@PromptServer.instance.routes.get("/neo_bookmark/civitai/enabled")
async def neo_bookmark_civitai_enabled(request):
    return web.json_response({"success": True, "enabled": _is_civitai_bookmark_enabled()})