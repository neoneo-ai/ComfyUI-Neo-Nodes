# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — OSS Remote Presets (Cloud Presets) module
#
# Split out of gallery.py. Self-contained for paths: computes them from the
# custom node directory (this file sits next to gallery.py). Routes register
# at import time; gallery.py imports this module to pick them up.

import json
from pathlib import Path
import aiohttp
from aiohttp import web
from server import PromptServer

# ---------------------------------------------------------------------------
# Paths (self-contained: this file lives next to gallery.py)
# ---------------------------------------------------------------------------
CURRENT_DIR = Path(__file__).parent.resolve()
CONFIGS_DIR = CURRENT_DIR / "configs"
GALLERY_DIR = CURRENT_DIR / "gallery"
OSS_CACHE_DIR = GALLERY_DIR / "oss_cache"
OSS_INDEX_CACHE_FILE = OSS_CACHE_DIR / "_index.json"

# Module-level state
_oss_index_cache: dict | None = None
_oss_index_fetch_time: float = 0.0

# OSS preset categories: the index may group remote directories under a top-level
# "categories" mapping ({"grid": [...], "character": [...]}) for the plugin-owned
# main Gallery dirs. Directories not listed in any category stay "presets"
# (the legacy Cloud Presets section), so old indexes keep working unchanged.
OSS_CATEGORY_PRESETS = "presets"
OSS_CATEGORY_GRID = "grid"
OSS_CATEGORY_CHARACTER = "character"
# Navigation prefix of the OSS preset cards per category. Presets are top-level
# cards ("Cloud Presets/<dir>"); the Grid/Character caches live under a read-only
# "presets" folder inside their main dir ("Grid/presets/<dir>").
_OSS_CATEGORY_PATH_PREFIX = {
    OSS_CATEGORY_PRESETS: "Cloud Presets",
    OSS_CATEGORY_GRID: "Grid/presets",
    OSS_CATEGORY_CHARACTER: "Character/presets",
}


def _oss_index_categories(index: dict) -> dict[str, list[str]]:
    """Return the index's top-level category -> directory-name mapping."""
    categories = (index or {}).get("categories")
    if not isinstance(categories, dict):
        return {}
    result = {}
    for cat, names in categories.items():
        if isinstance(names, list):
            result[str(cat)] = [n for n in names if isinstance(n, str)]
    return result


def _oss_category_dirs(index: dict, category: str | None) -> list[str]:
    """Directory names belonging to a category (None = every non-root directory).

    Directories listed under another category are excluded from "presets", so
    the legacy Cloud Presets section only shows unlisted directories.
    """
    directories = (index or {}).get("directories", {})
    if not category:
        return [d for d in directories if d != "_root"]
    if category == OSS_CATEGORY_PRESETS:
        # Unlisted directories plus any explicitly listed under "presets";
        # directories owned by another category never show up in Cloud Presets.
        listed = set()
        for cat, names in _oss_index_categories(index).items():
            if cat != OSS_CATEGORY_PRESETS:
                listed.update(names)
        return [d for d in directories if d != "_root" and d not in listed]
    cat_names = _oss_index_categories(index).get(category, [])
    return [d for d in cat_names if d in directories]


def _get_oss_config() -> dict:
    """Read OSS presets configuration from configs/oss_presets.json."""
    try:
        config_path = CONFIGS_DIR / "oss_presets.json"
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _is_oss_enabled() -> bool:
    cfg = _get_oss_config()
    return bool(cfg.get("enabled")) and bool(cfg.get("index_url"))


def _get_oss_cache_dir(category: str | None = None) -> Path:
    """Local cache root for downloaded OSS files.

    grid/character presets are cached under the plugin-owned main Gallery dirs
    (gallery/grid/presets, gallery/character/presets); everything else keeps
    the legacy oss_cache location.
    """
    if category in (OSS_CATEGORY_GRID, OSS_CATEGORY_CHARACTER):
        return GALLERY_DIR / category / "presets"
    cfg = _get_oss_config()
    custom = cfg.get("cache_dir", "")
    if custom:
        p = Path(custom)
        p.mkdir(parents=True, exist_ok=True)
        return p
    OSS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return OSS_CACHE_DIR


async def _fetch_oss_index(force: bool = False) -> dict | None:
    """Download and cache the OSS index.json. Returns parsed dict or None.

    Respects sync_interval_hours unless force=True.
    """
    global _oss_index_cache, _oss_index_fetch_time

    if not _is_oss_enabled():
        return None

    import time as _time

    cfg = _get_oss_config()
    interval_hours = cfg.get("sync_interval_hours", 24)

    if not force and _oss_index_cache is not None:
        elapsed_hours = (_time.time() - _oss_index_fetch_time) / 3600
        if elapsed_hours < interval_hours:
            return _oss_index_cache

    index_url = cfg["index_url"]

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(index_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    print(f"[Neo Gallery] OSS index fetch failed: HTTP {resp.status}")
                    return _oss_index_cache
                data = await resp.read()

        index = json.loads(data.decode("utf-8"))

        cache_dir = _get_oss_cache_dir()
        cache_file = cache_dir / "_index.json"
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

        _oss_index_cache = index
        _oss_index_fetch_time = _time.time()
        print(f"[Neo Gallery] OSS index synced: {len(index.get('directories', {}))} directories")
        return index

    except Exception as e:
        print(f"[Neo Gallery] OSS index fetch error: {e}")
        if OSS_INDEX_CACHE_FILE.exists():
            try:
                with open(OSS_INDEX_CACHE_FILE, "r", encoding="utf-8") as f:
                    _oss_index_cache = json.load(f)
                return _oss_index_cache
            except Exception:
                pass
        return _oss_index_cache


def _load_oss_index_from_disk() -> dict | None:
    """Load cached index.json from disk (used at startup before any async fetch)."""
    global _oss_index_cache, _oss_index_fetch_time
    if _oss_index_cache is not None:
        return _oss_index_cache
    cache_file = _get_oss_cache_dir() / "_index.json"
    if cache_file.exists():
        try:
            import time as _time
            with open(cache_file, "r", encoding="utf-8") as f:
                _oss_index_cache = json.load(f)
            _oss_index_fetch_time = _time.time()
            return _oss_index_cache
        except Exception:
            pass
    return None


async def _download_oss_file(remote_rel_path: str, category: str | None = None) -> Path | None:
    """Download a single file from OSS to local cache. Returns local cache path or None."""
    cfg = _get_oss_config()
    base_url = cfg.get("base_url", "").rstrip("/")
    if not base_url:
        return None

    cache_dir = _get_oss_cache_dir(category)
    local_path = cache_dir / remote_rel_path
    if local_path.exists():
        return local_path

    local_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"{base_url}/{remote_rel_path}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    print(f"[Neo Gallery] OSS download failed ({resp.status}): {remote_rel_path}")
                    return None
                data = await resp.read()

        with open(local_path, "wb") as f:
            f.write(data)
        return local_path

    except Exception as e:
        print(f"[Neo Gallery] OSS download error: {e}")
        return None


def _find_in_oss_index(filename: str, subdir: str, category: str | None = None) -> str | None:
    """Look up a file in the OSS index. Returns the remote relative path or None."""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    directories = {d: v for d, v in index.get("directories", {}).items()
                   if d in set(_oss_category_dirs(index, category))}

    if subdir:
        dir_data = directories.get(subdir)
        if dir_data:
            for item in dir_data.get("items", []):
                if item["filename"] == filename:
                    return f"{subdir}/{filename}"
        for dir_name, dir_data in directories.items():
            for item in dir_data.get("items", []):
                if item["filename"] == filename:
                    return f"{dir_name}/{filename}"
    else:
        for dir_name, dir_data in directories.items():
            for item in dir_data.get("items", []):
                if item["filename"] == filename:
                    return f"{dir_name}/{filename}"

    return None


def _find_thumbnail_in_oss_index(filename: str, subdir: str, category: str | None = None) -> str | None:
    """Look up a thumbnail in the OSS index. Returns the remote relative path or None."""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    stem = Path(filename).stem
    directories = {d: v for d, v in index.get("directories", {}).items()
                   if d in set(_oss_category_dirs(index, category))}

    if subdir:
        dir_data = directories.get(subdir)
        if dir_data:
            for item in dir_data.get("items", []):
                if item["filename"] == filename and item.get("thumbnail"):
                    return item["thumbnail"]
        for dir_name, dir_data in directories.items():
            for item in dir_data.get("items", []):
                if item["filename"] == filename and item.get("thumbnail"):
                    return item["thumbnail"]
    else:
        for dir_name, dir_data in directories.items():
            for item in dir_data.get("items", []):
                if item["filename"] == filename and item.get("thumbnail"):
                    return item["thumbnail"]

    return None


def _oss_directories_to_gallery_dirs(index: dict, category: str | None = OSS_CATEGORY_PRESETS) -> list[dict]:
    """Convert OSS index directories to gallery directory response format.

    `path_prefix` controls the navigation prefix ("Cloud Presets" for the legacy
    section, "Grid"/"Character" for the main-dir preset cards).
    """
    path_prefix = _OSS_CATEGORY_PATH_PREFIX.get(category or OSS_CATEGORY_PRESETS, "Cloud Presets")
    result = []
    for dir_name in _oss_category_dirs(index, category):
        items = index.get("directories", {}).get(dir_name, {}).get("items", [])
        result.append({
            "name": dir_name,
            "path": f"{path_prefix}/{dir_name}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": len(items),
            "items": [],
        })

    return result


def _collect_oss_covers(covers: dict, index: dict, category: str | None = OSS_CATEGORY_PRESETS):
    """Collect cover images from OSS index for each remote directory."""
    path_prefix = _OSS_CATEGORY_PATH_PREFIX.get(category or OSS_CATEGORY_PRESETS, "Cloud Presets")
    for dir_name in _oss_category_dirs(index, category):
        dir_data = index.get("directories", {}).get(dir_name, {})
        items = dir_data.get("items", [])
        cover_items = []
        for item in items[:2]:
            thumb = item.get("thumbnail", "")
            if thumb:
                cover_items.append({
                    "filename": item["filename"],
                    "name": Path(item["filename"]).stem,
                    "subfolder": f"{path_prefix}/{dir_name}",
                    "oss_thumbnail": thumb,
                })
        if cover_items:
            covers[f"{path_prefix}/{dir_name}"] = cover_items


def _oss_dir_cards(index: dict, category: str) -> dict:
    """subdirs mapping (dir name -> image_count) for one OSS category."""
    return {dname: {"image_count": len(index.get("directories", {}).get(dname, {}).get("items", []))}
            for dname in _oss_category_dirs(index, category)}


def _oss_dir_items(index: dict, dir_name: str, subfolder_prefix: str) -> list[dict]:
    """Item entries of one OSS remote directory, with the navigation subfolder prefix."""
    items = []
    for item in index.get("directories", {}).get(dir_name, {}).get("items", []):
        entry = {
            "name": Path(item["filename"]).stem,
            "filename": item["filename"],
            "type": item.get("type", "image"),
            "category": "",
            "subfolder": f"{subfolder_prefix}/{dir_name}",
            "mtime": item.get("mtime", 0),
            "source": "oss",
        }
        txt = item.get("txt_content", "")
        if txt:
            entry["txt_content"] = txt
        items.append(entry)
    return items


async def _handle_oss_gallery_list(dir_name_param: str, rel_path_param: str,
                                    include_dirs: bool, include_items: bool,
                                    include_covers: bool, search_mode: bool) -> web.Response:
    """Handle /neo_gallery/list for Cloud Presets (OSS remote directories)."""
    oss_index = await _fetch_oss_index()
    if not oss_index:
        return web.json_response({"error": "OSS not configured or index unavailable"}, status=404)

    dir_name_lower = dir_name_param.lower()

    # "Cloud Presets" — show subdirectory cards
    if dir_name_lower == "cloud presets":
        resp_dir = {
            "name": "Cloud Presets",
            "path": "Cloud Presets",
            "read_only": True,
            "source": "oss",
            "subdirs": _oss_dir_cards(oss_index, OSS_CATEGORY_PRESETS),
            "root_count": 0,
            "items": [],
        }

        response_data = {"directories": [resp_dir], "total": 0}
        if include_covers:
            covers = {}
            _collect_oss_covers(covers, oss_index)
            response_data["covers"] = covers
        return web.json_response(response_data)

    # "Cloud Presets/<subdir>" — show items from that subdir
    if dir_name_lower.startswith("cloud presets/"):
        subdir_name = dir_name_param[len("Cloud Presets/"):]
        if subdir_name not in _oss_category_dirs(oss_index, OSS_CATEGORY_PRESETS):
            return web.json_response({"error": f"OSS directory not found: {subdir_name}"}, status=404)

        items = _oss_dir_items(oss_index, subdir_name, "Cloud Presets")

        resp_dir = {
            "name": f"Cloud Presets/{subdir_name}",
            "path": f"Cloud Presets/{subdir_name}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": len(items),
            "items": items,
        }

        response_data = {"directories": [resp_dir], "total": len(items)}
        if include_covers:
            covers = {}
            _collect_oss_covers(covers, oss_index)
            response_data["covers"] = covers
        return web.json_response(response_data)

    return web.json_response({"error": "Invalid Cloud Presets path"}, status=400)


@PromptServer.instance.routes.post("/neo_gallery/sync_oss")
async def sync_oss_index(request):
    """Manually trigger OSS index sync (force re-download of index.json)."""
    if not _is_oss_enabled():
        return web.json_response({"success": False, "error": "OSS not configured"}, status=400)

    try:
        index = await _fetch_oss_index(force=True)
        if index:
            dirs = index.get("directories", {})
            total_items = sum(len(d.get("items", [])) for d in dirs.values())
            return web.json_response({
                "success": True,
                "directories": len(dirs),
                "items": total_items,
                "generated_at": index.get("generated_at", ""),
            })
        return web.json_response({"success": False, "error": "Failed to fetch index"}, status=500)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/neo_gallery/oss_status")
async def oss_status(request):
    """Return OSS connection status and cached index info."""
    cfg = _get_oss_config()
    enabled = _is_oss_enabled()
    index = _load_oss_index_from_disk()

    result = {
        "enabled": enabled,
        "index_url": cfg.get("index_url", ""),
        "base_url": cfg.get("base_url", ""),
        "available": index is not None,
    }

    if index:
        dirs = index.get("directories", {})
        result["directories"] = len(dirs)
        result["items"] = sum(len(d.get("items", [])) for d in dirs.values())
        result["generated_at"] = index.get("generated_at", "")

    return web.json_response(result)
