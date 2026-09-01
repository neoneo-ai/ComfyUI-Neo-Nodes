# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — Civitai LORA Example Sync module
#
# Split out of gallery.py. Self-contained for paths: computes them from the
# custom node directory (this file sits next to gallery.py). Routes register
# at import time; gallery.py imports this module to pick them up.

import re
import json
import time
import asyncio
import shutil
import hashlib
from pathlib import Path
import aiohttp
from aiohttp import web
from server import PromptServer
import folder_paths

from .gallery import _load_settings
from .util import _has_media_recursive

# ---------------------------------------------------------------------------
# Paths (self-contained: this file lives next to gallery.py)
# ---------------------------------------------------------------------------
CURRENT_DIR = Path(__file__).parent.resolve()
GALLERY_DIR = CURRENT_DIR / "gallery"
LORA_CACHE_DIR = GALLERY_DIR / "lora_cache"

# ---------------------------------------------------------------------------
# Constants / state
# ---------------------------------------------------------------------------
CIVITAI_API_BASE = "https://civitai.com/api/v1"
LORA_SYNC_BATCH = 20  # max loras fetched per auto-cache run
LORA_FILE_EXTENSIONS = {".safetensors", ".pt", ".ckpt", ".bin", ".sft"}
LORA_INDEX_FILE = LORA_CACHE_DIR / "_index.json"

_lora_index_cache: dict | None = None
_auto_queue: list = []
_auto_state: dict = {
    "running": False, "total": 0, "done": 0, "ok": 0, "failed": 0,
    "current": "", "remaining": 0, "error": "", "cancel": False,
}
_auto_task: "asyncio.Task | None" = None


def _load_lora_index() -> dict:
    global _lora_index_cache
    if _lora_index_cache is not None:
        return _lora_index_cache
    try:
        if LORA_INDEX_FILE.exists():
            with open(LORA_INDEX_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    _lora_index_cache = data
                    return data
    except Exception as e:
        print(f"[Neo Gallery] Failed to load lora index: {e}")
    _lora_index_cache = {}
    return _lora_index_cache


def _save_lora_index(index: dict) -> None:
    global _lora_index_cache
    _lora_index_cache = index
    try:
        LORA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(LORA_INDEX_FILE, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Neo Gallery] Failed to save lora index: {e}")


def _sanitize_lora_dir_part(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "_"


def _cache_dir_for_lora(lora_rel: str, index: dict) -> Path:
    """Map a lora relative path (models/loras, posix) to its cache directory.

    The cache mirrors the lora tree as <lora_cache>/<subdirs>/<stem>/; parts are
    sanitized and a short hash suffix resolves collisions after sanitizing.
    """
    entry = index.get(lora_rel) or {}
    cached = entry.get("cache_dir")
    if cached:
        return LORA_CACHE_DIR.joinpath(*cached.split("/"))
    parts = [_sanitize_lora_dir_part(p) for p in Path(lora_rel).parts[:-1]]
    parts.append(_sanitize_lora_dir_part(Path(lora_rel).stem))
    rel = "/".join(parts)
    taken = {info["cache_dir"]: other for other, info in index.items() if info.get("cache_dir")}
    if rel in taken and taken[rel] != lora_rel:
        rel = f"{rel}_{hashlib.sha256(lora_rel.encode('utf-8')).hexdigest()[:8]}"
    return LORA_CACHE_DIR.joinpath(*rel.split("/"))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _collect_selected_loras(selected_dirs: list) -> list:
    """Return registered lora relative paths (posix) under the selected directories.

    Selecting a directory covers all of its descendants; "" selects loras root files.
    """
    try:
        all_loras = folder_paths.get_filename_list("loras") or []
    except Exception:
        return []
    # Empty string in the selection means "the loras root", i.e. all files not in a subdir.
    # Keep the empty entry so select_all (below) can detect it.
    selected = {str(d).replace("\\", "/").strip("/") for d in selected_dirs if str(d).strip() or str(d) == ""}
    # Empty string in the selection means "the loras root", i.e. all not-in-subdir files
    select_all = "" in selected
    result = []
    for rel in all_loras:
        rel_posix = rel.replace("\\", "/")
        parts = rel_posix.split("/")
        parent = "/".join(parts[:-1]) if len(parts) > 1 else ""
        if select_all or any(parent == d or parent.startswith(d + "/") for d in selected):
            result.append(rel_posix)
    return sorted(result)


async def _civitai_by_hash(session, sha256: str, api_key: str):
    """Fetch the Civitai model version for a file hash. Returns (http_status, json)."""
    url = f"{CIVITAI_API_BASE}/model-versions/by-hash/{sha256}"
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": "ComfyUI-Neo-Nodes"}
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status != 200:
                return resp.status, None
            return 200, await resp.json()
    except Exception as e:
        print(f"[Neo Gallery] Civitai request failed: {e}")
        return 0, None


def _sniff_media_ext(data: bytes) -> str | None:
    """Guess a media extension from magic bytes when Content-Type is missing/odd."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"GIF8":
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return ".mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm"
    return None


async def _download_example_image(session, sem: asyncio.Semaphore, url: str, dest: Path) -> bool:
    """Download a Civitai example image or video into the cache dir."""
    try:
        async with sem:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    return False
                data = await resp.read()
                ctype = (resp.headers.get("Content-Type") or "").lower()
        ext = None
        if ctype.startswith("image/"):
            ext = {"png": ".png", "jpeg": ".jpg", "webp": ".webp", "gif": ".gif"}.get(ctype.split("/")[-1])
        elif ctype.startswith("video/"):
            ext = {"mp4": ".mp4", "webm": ".webm", "quicktime": ".mov"}.get(ctype.split("/")[-1])
        if ext is None:
            ext = _sniff_media_ext(data)
        if ext is None:
            print(f"[Neo Gallery] Skipped unknown media from {url[:80]} (Content-Type: {ctype or 'none'})")
            return False
        dest.with_suffix(ext).write_bytes(data)
        return True
    except Exception as e:
        print(f"[Neo Gallery] Example image download failed: {e}")
        return False


def _lora_entry_up_to_date(index: dict, lora_rel: str, full: Path) -> bool:
    """True when the index entry matches the file (size+mtime) and its cache is intact.

    Avoids re-hashing multi-GB lora files on every sync run.
    """
    entry = index.get(lora_rel) or {}
    if entry.get("status") not in ("ok", "not_found"):
        return False
    try:
        st = full.stat()
    except OSError:
        return False
    if entry.get("size") != st.st_size or int(entry.get("mtime", 0)) != int(st.st_mtime):
        return False
    if entry.get("status") != "ok":
        return True
    if entry.get("images", 0) == 0:
        return True
    cache_dir = _cache_dir_for_lora(lora_rel, index)
    return cache_dir.is_dir() and any(p.is_file() for p in cache_dir.iterdir())


def _normalize_lora_dir(settings: dict) -> list:
    """Normalize first-level loras subdirs from settings ("" = loras root, selects all).

    Strips trailing slashes, drops nested dirs already covered by a selected
    ancestor, and keeps "" for the loras root.
    """
    raw = []
    for d in (settings.get("lora_sync_dirs") or []):
        if not isinstance(d, str):
            continue
        s = d.replace("\\", "/").strip("/").strip()
        if s in raw:
            continue
        raw.append(s)
    result = []
    for d in raw:
        if d and any(o and d != o and d.startswith(o + "/") for o in raw):
            continue
        result.append(d)
    return result


def _pending_lora_dirs() -> list:
    """Loras under the selected sync dirs that still need example caching.

    Selection comes from settings.lora_sync_dirs ("" = loras root, selects all).
    Loras with an ok/not_found index entry are skipped; missing/queued/failed
    entries are pending.
    """
    settings = _load_settings()
    if not settings.get("civitai_lora_enabled"):
        return []
    selected = _normalize_lora_dir(settings)
    if not selected:
        selected = [""]
    index = _load_lora_index()
    pending = []
    for rel in _collect_selected_loras(selected):
        entry = index.get(rel) or {}
        if entry.get("status") in ("ok", "not_found"):
            continue
        pending.append({"lora_path": rel, "status": entry.get("status", ""),
                        "cache_dir": entry.get("cache_dir", "")})
    return pending


def _lora_pending_subdirs() -> dict:
    """Map first-level lora cache dirs that are configured in settings but still
    have no cached example media to pending-card metadata.

    The gallery UI shows these as "Fetching from Civitai..." cards even before the
    auto-cache worker writes the first example, so a configured dir is never
    silently missing from the Lora section.
    """
    settings = _load_settings()
    if not settings.get("civitai_lora_enabled"):
        return {}
    selected = _normalize_lora_dir(settings)
    needs_key = not bool(str(settings.get("civitai_api_key") or "").strip())
    pending: dict[str, dict] = {}
    for d in selected:
        if not d:
            continue
        first = d.split("/")[0]
        target = LORA_CACHE_DIR / first
        if not target.exists() or not _has_media_recursive(target):
            pending[first] = {"pending": True,
                              "civitai": {"needs_api_key": needs_key}}
    return pending


async def _cache_one_lora(session, sem, index, rel, full, api_key, state) -> bool:
    """Fetch Civitai examples for one lora and write them into its cache dir.

    Returns True on success; False on transient failures (recorded as "failed"
    in the index so the retry endpoint can re-queue them).
    """
    full = Path(full)
    sha = _sha256_file(full)
    status, version = await _civitai_by_hash(session, sha, api_key)
    if status in (401, 403):
        state["error"] = "Civitai API KEY rejected"
        state["failed"] += 1
        return False
    if status == 404:
        # Not on Civitai (or hash unknown): record so future runs skip it
        index[rel] = {"status": "not_found", "sha256": sha,
                      "size": full.stat().st_size, "mtime": int(full.stat().st_mtime),
                      "synced_at": int(time.time())}
        _save_lora_index(index)
        state["failed"] += 1
        return False
    if status != 200 or not isinstance(version, dict):
        # Transient failure: record so the retry endpoint can re-queue it
        index[rel] = {"status": "failed", "sha256": sha,
                      "size": full.stat().st_size, "mtime": int(full.stat().st_mtime),
                      "error": f"Civitai HTTP {status or 'error'}", "synced_at": int(time.time())}
        _save_lora_index(index)
        state["failed"] += 1
        state["error"] = f"Civitai HTTP {status or 'error'}: {rel}"
        return False

    cache_dir = _cache_dir_for_lora(rel, index)
    old = index.get(rel) or {}
    if old.get("cache_dir") and old.get("sha256") != sha:
        shutil.rmtree(cache_dir, ignore_errors=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    for stale in cache_dir.iterdir():
        if stale.is_file():
            stale.unlink()

    downloaded = 0
    for i, img in enumerate(version.get("images") or []):
        if state["cancel"]:
            break
        url = img.get("url")
        if not url:
            continue
        meta = img.get("meta")
        prompt = str(meta.get("prompt") or "").strip() if isinstance(meta, dict) else ""
        stem = f"example_{i:02d}"
        if not await _download_example_image(session, sem, url, cache_dir / stem):
            continue
        written = next((p for p in cache_dir.iterdir()
                        if p.is_file() and p.stem == stem and p.suffix.lower() != ".txt"), None)
        if written and prompt:
            written.with_suffix(".txt").write_text(prompt, encoding="utf-8")
        downloaded += 1

    model_info = version.get("model") or {}
    index[rel] = {
        "status": "ok", "sha256": sha,
        "size": full.stat().st_size, "mtime": int(full.stat().st_mtime),
        "cache_dir": cache_dir.relative_to(LORA_CACHE_DIR).as_posix(),
        "model_name": model_info.get("name") or "",
        "version_name": version.get("name") or "",
        "images": downloaded, "synced_at": int(time.time()),
    }
    _save_lora_index(index)
    state["ok"] += 1
    return True


def _prune_lora_caches() -> None:
    """Delete index entries and cache dirs for loras no longer registered."""
    try:
        registered = {p.replace("\\", "/") for p in (folder_paths.get_filename_list("loras") or [])}
    except Exception:
        registered = set()
    if not registered:
        return
    index = _load_lora_index()
    pruned = 0
    for rel in list(index.keys()):
        if rel not in registered:
            info = index.pop(rel)
            cache_dir = info.get("cache_dir")
            if cache_dir:
                shutil.rmtree(LORA_CACHE_DIR.joinpath(*cache_dir.split("/")), ignore_errors=True)
            pruned += 1
    if pruned:
        _save_lora_index(index)
    if LORA_CACHE_DIR.is_dir():
        for p in sorted(LORA_CACHE_DIR.rglob("*"), reverse=True):
            if p.is_dir() and not any(p.iterdir()):
                p.rmdir()


def _attach_lora_meta(resp_dir: dict, rel_path: str) -> None:
    """Attach lora cache metadata to scanned items: rewrite subfolder to the
    unambiguous "Lora/..." prefix (resolved by image/thumbnail/copy_to_input)
    and add lora_path (relative to models/loras) for send-to-LoraLoader."""
    index = _load_lora_index()
    by_dir = {}
    for lora_rel, info in index.items():
        cache_dir = info.get("cache_dir")
        if cache_dir:
            by_dir[cache_dir] = lora_rel
    prefix = f"Lora/{rel_path}" if rel_path else "Lora"
    lora_rel = by_dir.get(rel_path)
    for entry in resp_dir.get("items", []):
        entry["subfolder"] = prefix
        if lora_rel:
            entry["lora_path"] = lora_rel


def _attach_lora_subdir_paths(resp_dir: dict, rel_path: str) -> None:
    """Attach lora_path to leaf lora subdir cards in a Lora view response.

    The Lora section shows one directory card per lora cache subdir. Non-leaf
    directories (containers holding many loras) have no single lora_path and stay
    visible; leaf lora cards get their exact models/loras relative path so the
    frontend "used in workflow" filter can match them.
    """
    index = _load_lora_index()
    # Exact cache_dir -> lora relative path (cache mirrors the models/loras tree).
    by_cache_dir = {}
    for lora_rel, info in index.items():
        cache_dir = info.get("cache_dir")
        if cache_dir:
            by_cache_dir[cache_dir] = lora_rel
    base = f"{rel_path}/" if rel_path else ""
    for sub_name, meta in (resp_dir.get("subdirs") or {}).items():
        if not isinstance(meta, dict) or meta.get("lora_path"):
            continue
        lora_rel = by_cache_dir.get(f"{base}{sub_name}")
        if lora_rel:
            meta["lora_path"] = lora_rel


async def _ensure_auto_cache() -> None:
    """Queue loras that still need example caching and start the worker if idle."""
    global _auto_task
    if _auto_state.get("running"):
        return
    settings = _load_settings()
    if not settings.get("civitai_lora_enabled"):
        return
    api_key = str(settings.get("civitai_api_key") or "").strip()
    if not api_key:
        return
    pending = _pending_lora_dirs()
    if not pending:
        return
    _auto_queue[:] = pending
    _auto_state.update({"running": True, "total": len(pending), "done": 0, "ok": 0,
                        "failed": 0, "current": "", "remaining": len(pending),
                        "error": "", "cancel": False})
    if _auto_task is None or _auto_task.done():
        _auto_task = asyncio.create_task(_auto_worker(api_key))


async def _auto_worker(api_key: str) -> None:
    """Process the auto-cache queue, then prune caches for unregistered loras."""
    global _auto_task
    index = _load_lora_index()
    sem = asyncio.Semaphore(3)
    try:
        async with aiohttp.ClientSession() as session:
            while _auto_queue:
                if _auto_state.get("cancel"):
                    break
                item = _auto_queue.pop(0)
                rel = item.get("lora_path") if isinstance(item, dict) else item
                _auto_state["current"] = rel
                try:
                    full = Path(folder_paths.get_full_path("loras", rel))
                except Exception:
                    full = None
                if not full or not full.is_file():
                    _auto_state["done"] += 1
                    _auto_state["failed"] += 1
                    continue
                if _lora_entry_up_to_date(index, rel, full):
                    _auto_state["done"] += 1
                    continue
                await _cache_one_lora(session, sem, index, rel, full, api_key, _auto_state)
                _auto_state["done"] += 1
                _auto_state["remaining"] = len(_auto_queue)
    except Exception as e:
        _auto_state["error"] = str(e)
    finally:
        _auto_state["running"] = False
        _auto_state["current"] = ""
        _auto_task = None
        _prune_lora_caches()


@PromptServer.instance.routes.get("/neo_gallery/lora_dirs")
async def lora_dirs(request):
    """List first-level loras subdirectories for the sync directory picker.

    Only the loras root ("") and its direct children are offered. The count is
    the number of .safetensors files in the whole subtree, so a first-level dir
    is selectable even when its loras are nested in deeper subdirectories.
    """
    result: dict = {}
    for root in (folder_paths.get_folder_paths("loras") or []):
        root = Path(root)
        if not root.exists():
            continue
        try:
            root_count = sum(1 for p in root.iterdir()
                             if p.is_file() and p.suffix.lower() in LORA_FILE_EXTENSIONS)
        except OSError:
            continue
        if root_count:
            result[""] = result.get("", 0) + root_count
        try:
            children = sorted(root.iterdir())
        except OSError:
            continue
        for p in children:
            if not p.is_dir():
                continue
            try:
                # Whole-subtree count: a first-level dir is selectable even when
                # its .safetensors files are nested in deeper subdirectories.
                count = sum(1 for f in p.rglob("*")
                            if f.is_file() and f.suffix.lower() in LORA_FILE_EXTENSIONS)
            except OSError:
                count = 0
            if count:
                result[p.name] = result.get(p.name, 0) + count
    dirs = [{"path": k, "count": v} for k, v in sorted(result.items())]
    return web.json_response({"dirs": dirs})


@PromptServer.instance.routes.post("/neo_gallery/civitai_test")
async def civitai_test(request):
    """Probe Civitai reachability and validate the configured API key."""
    settings = _load_settings()
    api_key = str(settings.get("civitai_api_key") or "").strip()
    if not api_key:
        return web.json_response({"success": False, "reachable": False,
                                  "key_ok": False, "http_status": 0,
                                  "message": "未配置 Civitai API KEY"})
    url = f"{CIVITAI_API_BASE}/model-versions/by-hash/0000000000000000000000000000000000000000000000000000000000000000"
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": "ComfyUI-Neo-Nodes"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=20)) as resp:
                status = resp.status
        reachable = True
        key_ok = status not in (401, 403)
        if status in (401, 403):
            message = "已连通 civitai.com，但 API KEY 无效 (401/403)"
        elif status == 200:
            message = "连通正常，API KEY 有效"
        else:
            message = f"已连通 civitai.com（HTTP {status}）"
        return web.json_response({"success": True, "reachable": reachable,
                                  "key_ok": key_ok, "http_status": status,
                                  "message": message})
    except asyncio.TimeoutError:
        return web.json_response({"success": False, "reachable": False,
                                  "key_ok": False, "http_status": 0,
                                  "message": "连接 civitai.com 超时（20 秒）"})
    except Exception as e:
        return web.json_response({"success": False, "reachable": False,
                                  "key_ok": False, "http_status": 0,
                                  "message": f"连接失败: {e}"})


@PromptServer.instance.routes.get("/neo_gallery/lora_cache_status")
async def lora_cache_status(request):
    """Return auto-cache worker state plus the flags the frontend polls."""
    settings = _load_settings()
    master_enabled = bool(settings.get("civitai_lora_enabled"))
    api_key = str(settings.get("civitai_api_key") or "").strip()
    state = dict(_auto_state)
    state["pending_count"] = len(_pending_lora_dirs()) if master_enabled else 0
    state["enabled"] = master_enabled and bool(api_key)
    state["master_enabled"] = master_enabled
    return web.json_response(state)


@PromptServer.instance.routes.post("/neo_gallery/lora_retry_failed")
async def lora_retry_failed(request):
    """Re-queue loras whose last cache attempt failed."""
    index = _load_lora_index()
    failed = [rel for rel, info in index.items() if info.get("status") == "failed"]
    for rel in failed:
        index[rel]["status"] = "queued"
    if failed:
        _save_lora_index(index)
    await _ensure_auto_cache()
    return web.json_response({"success": True, "count": len(failed)})
