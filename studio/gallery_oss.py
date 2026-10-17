# SPDX-License-Identifier: Apache-2.0
# Neo Studio — OSS Remote Presets (Cloud Presets) module
#
# Split out of gallery.py. Self-contained for paths: computes them from the
# custom node directory (this file sits next to gallery.py). Routes register
# at import time; gallery.py imports this module to pick them up.

import json
import random
from pathlib import Path
import aiohttp
from aiohttp import web
routes = web.RouteTableDef()
import folder_paths

from . import plugin_paths
from .util import IMG_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS

# ---------------------------------------------------------------------------
# Paths (self-contained: this file lives next to gallery.py)
# ---------------------------------------------------------------------------
CONFIGS_DIR = plugin_paths.CONFIGS_DIR
GALLERY_DIR = plugin_paths.GALLERY_DIR
OSS_CACHE_DIR = GALLERY_DIR / "oss_cache"
OSS_INDEX_CACHE_FILE = OSS_CACHE_DIR / "_index.json"

# Module-level state
_oss_index_cache: dict | None = None
_oss_index_fetch_time: float = 0.0

# OSS preset categories: the index may group remote directories under a top-level
# "categories" mapping ({"StoryBoard": [...], "CharacterSheet": [...]}) for the plugin-owned
# main Gallery dirs. Directories not listed in any category stay "presets"
# (the legacy Cloud Presets section), so old indexes keep working unchanged.
OSS_CATEGORY_PRESETS = "presets"
OSS_CATEGORY_GRID = "StoryBoard"
OSS_CATEGORY_CHARACTER = "CharacterSheet"
# Navigation prefix of the OSS preset cards per category. Presets are top-level
# cards ("Cloud Presets/<dir>"); the Grid/Character caches live under a read-only
# "presets" folder inside their main dir ("Grid/presets/<dir>").
_OSS_CATEGORY_PATH_PREFIX = {
    OSS_CATEGORY_PRESETS: "Cloud Presets",
    OSS_CATEGORY_GRID: "StoryBoard/presets",
    OSS_CATEGORY_CHARACTER: "CharacterSheet/presets",
}
# Output main dirs that hold the grid/character content the 素材库 buttons browse.
# The read-only OSS preset cache lives in their "presets/" subdir.
OUTPUT_DIR = Path(folder_paths.output_directory).resolve()
GRID_MAIN_DIR = OUTPUT_DIR / "StoryBoard"
CHARACTER_MAIN_DIR = OUTPUT_DIR / "CharacterSheet"


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


def _oss_dir_entry(index: dict, dir_name: str) -> dict:
    """主索引里一个目录的条目。旧版索引的条目自带 items，直接当计数与封面来源。"""
    entry = (index or {}).get("directories", {}).get(dir_name)
    return entry if isinstance(entry, dict) else {}


def _oss_dir_count(index: dict, dir_name: str) -> int:
    """目录卡片计数：v2 主索引声明 count，旧版索引数 items。"""
    entry = _oss_dir_entry(index, dir_name)
    if "count" in entry:
        try:
            return int(entry["count"])
        except (TypeError, ValueError):
            return 0
    return len(entry.get("items", []))


def _oss_total_items(index: dict) -> int:
    return sum(_oss_dir_count(index, d) for d in (index or {}).get("directories", {}))


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

    StoryBoard/CharacterSheet presets are cached under the output main dirs' read-only
    "presets/" subdir (output/StoryBoard/presets, output/CharacterSheet/presets);
    everything else keeps the legacy oss_cache location.
    """
    if category == OSS_CATEGORY_GRID:
        return GRID_MAIN_DIR / "presets"
    if category == OSS_CATEGORY_CHARACTER:
        return CHARACTER_MAIN_DIR / "presets"
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


async def _fetch_oss_dir_index(index: dict, dir_name: str, category: str | None = None) -> list[dict]:
    """Items of one remote directory: the per-directory index is downloaded on entry.

    主索引只声明目录索引的路径与 rev；rev 不变就用 oss_cache/<dir>/_index.json 里的缓存，
    拉取失败退回旧缓存，断网时目录页不会变成空页。旧版索引条目自带 items，直接返回。"""
    entry = _oss_dir_entry(index, dir_name)
    items = entry.get("items")
    if isinstance(items, list):
        return items
    rel = str(entry.get("index", "")).strip("/")
    if not rel:
        return []

    cache_file = _get_oss_cache_dir(category) / dir_name / "_index.json"
    cached = None
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if isinstance(cached, dict) and cached.get("generated_at", "") == str(entry.get("rev", "")):
            return cached.get("items", [])

    base_url = str(index.get("base_url") or _get_oss_config().get("base_url", "")).rstrip("/")
    if base_url:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{base_url}/{rel}", timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status != 200:
                        print(f"[Neo Gallery] OSS dir index fetch failed ({resp.status}): {rel}")
                    else:
                        data = json.loads((await resp.read()).decode("utf-8"))
                        if isinstance(data.get("items"), list):
                            cache_file.parent.mkdir(parents=True, exist_ok=True)
                            cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                            return data["items"]
        except Exception as e:
            print(f"[Neo Gallery] OSS dir index fetch error: {e}")

    if isinstance(cached, dict):
        return cached.get("items", [])
    return []


def _oss_match_dir(dirs: list[str], subdir: str) -> str | None:
    """Resolve a navigation subfolder to an index directory name.

    路由传进来的 subfolder 是 lowercase 过的，索引里的目录名保留原大小写；
    精确匹配会让 Style_A 这种 ASCII 目录名查不到，媒体请求 404。"""
    if subdir in dirs:
        return subdir
    lowered = subdir.lower()
    for name in dirs:
        if name.lower() == lowered:
            return name
    return None


async def _find_in_oss_index(filename: str, subdir: str, category: str | None = None) -> str | None:
    """Look up a file in the OSS index. Returns the remote relative path or None.

    只查 subdir 自己的目录索引：调用方的 subfolder 就是从导航路径取出的目录名。"""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    dirs = _oss_category_dirs(index, category)
    if subdir:
        target = _oss_match_dir(dirs, subdir)
        if target is None:
            return None
        targets = [target]
    else:
        targets = dirs

    for dir_name in targets:
        for item in await _fetch_oss_dir_index(index, dir_name, category):
            if item.get("filename") == filename:
                return f"{dir_name}/{filename}"
    return None


async def _find_thumbnail_in_oss_index(filename: str, subdir: str, category: str | None = None) -> str | None:
    """Look up a thumbnail in the OSS index. Returns the remote relative path or None."""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    dirs = _oss_category_dirs(index, category)
    if subdir:
        target = _oss_match_dir(dirs, subdir)
        if target is None:
            return None
        targets = [target]
    else:
        targets = dirs

    for dir_name in targets:
        for item in await _fetch_oss_dir_index(index, dir_name, category):
            if item.get("filename") == filename and item.get("thumbnail"):
                return item["thumbnail"]
    return None


def _oss_directories_to_gallery_dirs(index: dict, category: str | None = OSS_CATEGORY_PRESETS) -> list[dict]:
    """Convert OSS index directories to gallery directory response format.

    `path_prefix` controls the navigation prefix ("Cloud Presets" for the legacy
    section, "StoryBoard"/"CharacterSheet" for the main-dir preset cards).
    """
    path_prefix = _OSS_CATEGORY_PATH_PREFIX.get(category or OSS_CATEGORY_PRESETS, "Cloud Presets")
    result = []
    for dir_name in _oss_category_dirs(index, category):
        result.append({
            "name": dir_name,
            "path": f"{path_prefix}/{dir_name}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": _oss_dir_count(index, dir_name),
            "items": [],
        })

    return result


def _oss_cover_kind(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMG_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "other"


def _collect_oss_covers(covers: dict, index: dict, category: str | None = OSS_CATEGORY_PRESETS):
    """Collect cover images from OSS index for each remote directory."""
    path_prefix = _OSS_CATEGORY_PATH_PREFIX.get(category or OSS_CATEGORY_PRESETS, "Cloud Presets")
    for dir_name in _oss_category_dirs(index, category):
        entry = _oss_dir_entry(index, dir_name)
        # v2 主索引给每个目录带一份 covers；旧版索引从 items 里现抽
        candidates = entry.get("covers")
        candidates = list(candidates) if isinstance(candidates, list) else list(entry.get("items", []))
        random.shuffle(candidates)
        cover_items = []
        for item in candidates[:2]:
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            kind = _oss_cover_kind(item["filename"])
            if kind == "audio":
                # Audio renders as a decorative waveform tile; no thumbnail needed.
                cover_items.append({
                    "filename": item["filename"],
                    "name": Path(item["filename"]).stem,
                    "subfolder": f"{path_prefix}/{dir_name}",
                    "kind": "audio",
                })
            elif item.get("thumbnail"):
                # Media covers resolve through the /neo_gallery/thumbnail proxy
                # (subfolder points at the OSS dir); the index "thumbnail" is a
                # remote relative path, not a browser URL.
                cover_items.append({
                    "filename": item["filename"],
                    "name": Path(item["filename"]).stem,
                    "subfolder": f"{path_prefix}/{dir_name}",
                    "kind": kind,
                })
        if cover_items:
            covers[f"{path_prefix}/{dir_name}"] = cover_items


def _oss_dir_cards(index: dict, category: str) -> dict:
    """subdirs mapping (dir name -> image_count) for one OSS category."""
    return {dname: {"image_count": _oss_dir_count(index, dname)}
            for dname in _oss_category_dirs(index, category)}


async def _oss_dir_items(index: dict, dir_name: str, subfolder_prefix: str,
                         category: str | None = None) -> list[dict]:
    """Item entries of one OSS remote directory, with the navigation subfolder prefix."""
    items = []
    for item in await _fetch_oss_dir_index(index, dir_name, category):
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


def _oss_dir_visible(dir_name: str, hidden: set) -> bool:
    """Home hide switch records cloud preset dirs by their card path "Cloud Presets/<dir>"."""
    return f"cloud presets/{dir_name}".lower() not in hidden


async def _handle_oss_gallery_list(dir_name_param: str, rel_path_param: str,
                                    include_dirs: bool, include_items: bool,
                                    include_covers: bool, search_mode: bool,
                                    hidden: set | None = None) -> web.Response:
    """Handle /neo_gallery/list for Cloud Presets (OSS remote directories)."""
    oss_index = await _fetch_oss_index()
    if not oss_index:
        return web.json_response({"error": "OSS not configured or index unavailable"}, status=404)

    hidden = hidden or set()
    dir_name_lower = dir_name_param.lower()

    # "Cloud Presets" — show subdirectory cards
    if dir_name_lower == "cloud presets":
        resp_dir = {
            "name": "Cloud Presets",
            "path": "Cloud Presets",
            "read_only": True,
            "source": "oss",
            "subdirs": {k: v for k, v in _oss_dir_cards(oss_index, OSS_CATEGORY_PRESETS).items()
                        if _oss_dir_visible(k, hidden)},
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

        if not _oss_dir_visible(subdir_name, hidden):
            return web.json_response({"directories": [], "total": 0})

        items = await _oss_dir_items(oss_index, subdir_name, "Cloud Presets", OSS_CATEGORY_PRESETS)

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


@routes.post("/neo_gallery/sync_oss")
async def sync_oss_index(request):
    """Manually trigger OSS index sync (force re-download of index.json)."""
    if not _is_oss_enabled():
        return web.json_response({"success": False, "error": "OSS not configured"}, status=400)

    try:
        index = await _fetch_oss_index(force=True)
        if index:
            return web.json_response({
                "success": True,
                "directories": len(index.get("directories", {})),
                "items": _oss_total_items(index),
                "generated_at": index.get("generated_at", ""),
            })
        return web.json_response({"success": False, "error": "Failed to fetch index"}, status=500)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.get("/neo_gallery/oss_status")
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
        result["directories"] = len(index.get("directories", {}))
        result["items"] = _oss_total_items(index)
        result["generated_at"] = index.get("generated_at", "")

    return web.json_response(result)
