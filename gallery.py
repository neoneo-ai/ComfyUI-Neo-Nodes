# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — Gallery Module (preset-based: image + .txt by same name)

import os
import re
import json
import base64
from pathlib import Path
from aiohttp import web
from server import PromptServer
import mimetypes

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
CURRENT_DIR = Path(__file__).parent.resolve()
GALLERY_DIR = CURRENT_DIR / "gallery"
PRESETS_DIR = GALLERY_DIR / "presets"
CUSTOM_DIR = GALLERY_DIR / "custom"
THUMBNAIL_DIR = GALLERY_DIR / "thumbnails"
THUMBNAIL_SIZE = 320  # Fixed thumbnail size in pixels

IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS


def _get_user_custom_dirs():
    """Get all user-configured custom directory paths from settings."""
    dirs = []
    try:
        settings_path = CURRENT_DIR / "gallery_settings.json"
        if settings_path.exists():
            with open(settings_path, "r") as f:
                settings = json.load(f)
                user_dirs = settings.get("custom_directories", [])
                if isinstance(user_dirs, list):
                    for d in user_dirs:
                        if d and Path(d).exists():
                            dirs.append(Path(d))
                elif user_dirs:
                    p = Path(user_dirs) if isinstance(user_dirs, str) else None
                    if p and p.exists():
                        dirs.append(p)
    except Exception:
        pass
    return dirs


def _ensure_dirs() -> None:
    for d in (GALLERY_DIR, PRESETS_DIR, CUSTOM_DIR, THUMBNAIL_DIR):
        d.mkdir(parents=True, exist_ok=True)



def _scan_gallery_entries_lightweight(directory: Path) -> list[dict]:
    """Lightweight gallery entry scan - only filename + name + style + content for search.
    
    Minimal txt parsing (only first 2 lines), no full field extraction.
    Used by /neo_gallery/list when search_mode=1 to avoid heavy txt parsing.
    """
    entries: list[dict] = []
    if not directory.exists():
        return entries

    stems: dict[str, list[Path]] = {}
    for p in directory.iterdir():
        if not p.is_file():
            continue
        lower = p.suffix.lower()
        if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
            continue
        stems.setdefault(p.stem, []).append(p)

    for stem, files in sorted(stems.items()):
        media_file = None
        txt_file = None
        media_type = None
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

        # Minimal txt parsing - only first 2 lines for style + content
        raw_txt = ""
        if txt_file and txt_file.exists():
            try:
                with open(txt_file, "r", encoding="utf-8") as tf:
                    raw_txt = tf.read(500)  # Only read first ~500 chars
            except Exception:
                pass

        entry: dict[str, object] = {
            "name": media_file.stem,
            "filename": media_file.name,
            "type": media_type or "image",
            "style": "",
            "content": "",
            "mtime": media_file.stat().st_mtime,
        }

        # Extract style and content from first 2 lines only
        if raw_txt:
            try:
                lines = raw_txt.strip().splitlines()[:2]
                for i, line in enumerate(lines):
                    m = re.match(r"^\d+\s*\|\s*(.*)", line)
                    cleaned = m.group(1).strip() if m else line.strip()
                    if i == 0:
                        entry["style"] = cleaned
                    elif i == 1:
                        entry["content"] = cleaned
            except Exception:
                pass

        entries.append(entry)

    return entries


def _scan_directory_structure_only(directory: Path) -> dict:
    """Scan directory and return only first-level subdirectory structure with image counts.
    
    This is the fastest possible scan - only one os.listdir() call per level, no recursion.
    Returns:
        {
            "subdirs": [{name: str, image_count: int, path: str}]
        }
    """
    result = {"subdirs": []}
    if not directory.exists():
        return result

    # Scan only first-level subdirectories - one os.listdir() call per dir
    for p in sorted(directory.iterdir()):
        if not p.is_dir():
            continue
        subdir_count = 0
        for sub_p in p.iterdir():
            if sub_p.is_file() and sub_p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
                subdir_count += 1
        result["subdirs"].append({
            "name": p.name,
            "image_count": subdir_count,
            "path": p.name
        })

    return result



def _scan_gallery_entries(directory: Path, subfolder: str = "") -> list[dict]:
    """Scan directory (non-recursive) and return gallery entries.
    
    Supports both image and video files, paired with .txt by same stem.
    The 'filename' field always contains the media filename, not .txt.
    Video entries have 'type': 'video', image entries have 'type': 'image'.
    
    NOTE: Parses .txt files to include txt_content for lightbox display.
    
    Args:
        directory: The directory to scan.
        subfolder: Optional relative path from the custom directory root.
            Used to set the 'subfolder' field for correct thumbnail URL resolution.
    """
    entries: list[dict] = []
    if not directory.exists():
        return entries

    # Determine category and subfolder from the subfolder parameter
    # When subfolder is provided, we're scanning a specific subdirectory,
    # so don't use subfolder name as category (that would group all entries under it)
    category = ""

    stems: dict[str, list[Path]] = {}
    for p in directory.iterdir():
        if not p.is_file():
            continue
        lower = p.suffix.lower()
        # Track media files and .txt files by stem
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

        # Only create entry if we found a media file
        if not media_file:
            continue

        # Parse .txt file for lightbox display (only when txt exists)
        raw_txt = ""
        if txt_file and txt_file.exists():
            try:
                with open(txt_file, "r", encoding="utf-8") as tf:
                    raw_txt = tf.read()
            except Exception:
                pass

        # Build entry with txt_content when available
        entry: dict[str, object] = {
            "name": media_file.stem,
            "filename": media_file.name,
            "type": media_type,
            "category": category,
            "subfolder": subfolder,
            "mtime": media_file.stat().st_mtime,
        }
        if raw_txt:
            cleaned_lines = [""] * 8
            try:
                lines = raw_txt.strip().splitlines()
                for i, line in enumerate(lines):
                    if i >= 8:
                        break
                    m = re.match(r"^\d+\s*\|\s*(.*)", line)
                    cleaned_lines[i] = m.group(1) if m else line
            except Exception:
                pass
            txt_content = "\n".join(cleaned_lines).strip()
            if txt_content:
                entry["txt_content"] = txt_content

        entries.append(entry)

    return entries


def _scan_gallery_entries_with_subdirs(directory: Path, subfolder: str = "") -> dict:
    """Scan directory and return entries grouped by FIRST-LEVEL subdirectory only.
    
    Only returns immediate children directories (one level), does NOT recurse into nested dirs.
    This ensures the presets home page shows only one level of subdirectories.
    
    NOTE: Does NOT parse .txt files - only returns filename + type info for performance.
    
    Supports both image and video files.
    """
    result = {"root": [], "subdirs": {}}
    if not directory.exists():
        return result

    root_stems: dict[str, list[Path]] = {}
    for p in directory.iterdir():
        if p.is_file():
            lower = p.suffix.lower()
            if lower in ALL_MEDIA_EXTENSIONS or lower == ".txt":
                root_stems.setdefault(p.stem, []).append(p)

    for stem, files in sorted(root_stems.items()):
        media_file = None
        media_type = None
        for f in files:
            if f.suffix.lower() in VIDEO_EXTENSIONS:
                media_file = f
                media_type = "video"
            elif f.suffix.lower() in IMG_EXTENSIONS:
                if media_file is None:
                    media_file = f
                    media_type = "image"

        if not media_file:
            continue

        # Lightweight entry - no txt parsing for performance
        result["root"].append({
            "name": media_file.stem,
            "filename": media_file.name,
            "type": media_type,
            "category": "",
            "subfolder": "",
            "mtime": media_file.stat().st_mtime,
        })

    # Only scan FIRST-LEVEL subdirectories (no recursion)
    for p in directory.iterdir():
        if p.is_dir():
            subdir_entries = _scan_gallery_entries(p, p.name)
            if subdir_entries:
                result["subdirs"][p.name] = subdir_entries

    return result



# ---------------------------------------------------------------------------
# Helper Functions for Directory Processing
# ---------------------------------------------------------------------------

def _build_dir_response(dir_info: dict, scan_result: dict, include_dirs: bool, include_items: bool) -> dict:
    """Build a single directory response dict based on requested fields."""
    resp = {
        "name": dir_info["name"],
        "path": dir_info["path"],
        "read_only": dir_info.get("read_only", False),
    }
    
    if include_dirs:
        resp["subdirs"] = scan_result.get("subdirs", {})
        resp["root_count"] = len(scan_result.get("root", []))
    
    if include_items:
        resp["items"] = scan_result.get("root", [])
    
    return resp


def _process_single_directory(dir_path: Path, dir_name: str, rel_path: str, read_only: bool, 
                               include_dirs: bool, include_items: bool, search_mode: bool) -> dict:
    """Process a single directory: scan based on fields and build response."""
    # Resolve target directory
    if rel_path:
        parts = [p for p in rel_path.split("/") if p]
        target_dir = dir_path
        for part in parts:
            target_dir = target_dir / part
    else:
        target_dir = dir_path
    
    # Scan based on fields requested
    scan_result = {}
    if include_dirs or include_items:
        if search_mode and include_items:
            entries = _scan_gallery_entries_lightweight(target_dir)
            scan_result["root"] = entries
            scan_result["subdirs"] = {}
        elif include_items:
            # Use non-recursive scan for current directory only
            entries = _scan_gallery_entries(target_dir, rel_path)
            scan_result["root"] = entries
            # Only get subdirs structure if requested (not needed when include_dirs=False)
            if include_dirs:
                structure = _scan_directory_structure_only(target_dir)
                scan_result["subdirs"] = {s["name"]: {"image_count": s["image_count"]} for s in structure.get("subdirs", [])}
            else:
                scan_result["subdirs"] = {}
        else:
            # Only dirs needed, use lightweight scan
            structure = _scan_directory_structure_only(target_dir)
            scan_result["subdirs"] = {s["name"]: {"image_count": s["image_count"]} for s in structure.get("subdirs", [])}
            scan_result["root"] = []
    
    # Build directory info
    dir_info = {
        "name": dir_name,
        "path": f"{dir_name}/{rel_path}" if rel_path else dir_name,
        "read_only": read_only,
    }
    
    # Build response
    resp_dir = _build_dir_response(dir_info, scan_result, include_dirs, include_items)
    
    # Add custom_source for items
    if include_items and "items" in resp_dir:
        for entry in resp_dir["items"]:
            entry["custom_source"] = dir_name
    
    return resp_dir


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/neo_gallery/list")
async def get_gallery_list(request):
    """Return unified gallery listing (all directories, presets subdirs treated as read-only dirs).
    
    Query parameters:
    - fields: comma-separated list of fields to return. Supported values: dirs, items, covers
      Default: "dirs" when dir_name is provided, "dirs,items,covers" otherwise
    - dir_name: name of the custom directory or 'presets' (optional)
      If provided, returns data for that specific directory only (merges subdirs functionality)
    - path: relative subdirectory path within that directory (optional, "/" separated)
    
    Examples:
    - /neo_gallery/list -> full listing with dirs, items, covers
    - /neo_gallery/list?fields=dirs -> only directory structure (fast)
    - /neo_gallery/list?fields=items&dir_name=presets -> only items for presets
    - /neo_gallery/list?fields=dirs,covers&dir_name=myfolder&path=sub1/sub2
    
    Supports lightweight search mode via 'search_mode=1':
    - Returns only filename + name + style + content for each entry (no txt parsing overhead)
    
    Automatically includes cover images (samples: 2 per directory) to avoid a separate request.
    """
    fields_param = request.rel_url.query.get("fields", "")
    dir_name_param = request.rel_url.query.get("dir_name", "")
    rel_path_param = request.rel_url.query.get("path", "")
    search_mode = request.rel_url.query.get("search_mode", "0") == "1"
    
    # Parse fields parameter (comma-separated)
    if fields_param:
        requested_fields = {f.strip().lower() for f in fields_param.split(",") if f.strip()}
    else:
        requested_fields = set()
    
    user_custom_dirs = _get_user_custom_dirs()
    
    # Determine which fields to return
    has_dir_name = bool(dir_name_param)
    if has_dir_name:
        # When dir_name is provided, default to all fields
        include_dirs = "dirs" in requested_fields or not requested_fields
        include_items = "items" in requested_fields or not requested_fields
        include_covers = "covers" in requested_fields or not requested_fields
    else:
        # Default behavior for full listing
        include_dirs = "dirs" in requested_fields or not requested_fields
        include_items = "items" in requested_fields or not requested_fields
        include_covers = "covers" in requested_fields or not requested_fields
    
    directories = []
    
    # Handle dir_name parameter (merged subdirs functionality)
    if has_dir_name:
        # Resolve base directory from dir_name
        base: Path | None = None
        dir_name_lower = dir_name_param.lower()
        if dir_name_lower == "presets":
            base = PRESETS_DIR
        elif dir_name_lower.startswith("presets/"):
            base = PRESETS_DIR
            if not rel_path_param:
                rel_path_param = dir_name_lower[len("presets/"):]
        else:
            for dir_path in user_custom_dirs:
                d_name = dir_path.name if dir_path.name else str(dir_path)
                if d_name.lower() == dir_name_lower:
                    base = dir_path
                    break
        
        if base is None or not base.exists():
            return web.json_response({"error": "Directory not found"}, status=404)
        
        is_presets = dir_name_lower == "presets" or dir_name_lower.startswith("presets/")
        
        # For presets subdirectories (e.g., Presets/10秒), only show images without nested subdir cards
        # This prevents showing two levels of subdirectory structure on the home page
        is_presets_subdir = dir_name_lower.startswith("presets/") and not rel_path_param
        
        # Process single directory using unified function
        if is_presets_subdir:
            # For presets subdirs, only return items (no subdirs structure)
            resp_dir = _process_single_directory(base, dir_name_param, rel_path_param, True, 
                                                  include_dirs=False, include_items=True, search_mode=search_mode)
            # Override to ensure no subdirs are shown
            if "subdirs" not in resp_dir:
                resp_dir["subdirs"] = {}
        else:
            resp_dir = _process_single_directory(base, dir_name_param, rel_path_param, is_presets, 
                                                  include_dirs, include_items, search_mode)
        
        # Add covers if requested
        if include_covers:
            covers: dict[str, list[dict]] = {}
            # When has_dir_name, we need to use the actual target directory for covers
            # If rel_path is provided, use the target directory (e.g., Ai舞蹈素材/10秒)
            # If no rel_path, use the base directory (e.g., Ai舞蹈素材)
            target_dir = base
            if rel_path_param:
                parts = [p for p in rel_path_param.split("/") if p]
                for part in parts:
                    target_dir = target_dir / part
            
            # Use the full path as the key for covers
            full_key = f"{dir_name_param}/{rel_path_param}" if rel_path_param else dir_name_param
            _collect_all_dir_covers(covers, target_dir, full_key, 2)
            
            # Also collect covers for immediate child subdirectories (like homepage does)
            # This ensures subdir cards show cover images when entering a directory
            if include_dirs and "subdirs" in resp_dir:
                for subdir_name, subdir_info in resp_dir.get("subdirs", {}).items():
                    subdir_path = target_dir / subdir_name
                    child_key = f"{full_key}/{subdir_name}"
                    # Pass the subdir name as base_subfolder so thumbnails resolve correctly
                    _collect_all_dir_covers(covers, subdir_path, child_key, 2, base_subfolder=subdir_name)
            
            return web.json_response({
                "directories": [resp_dir],
                "total": len(resp_dir.get("items", [])),
                "covers": covers
            })
        
        return web.json_response({
            "directories": [resp_dir],
            "total": len(resp_dir.get("items", []))
        })
    
    # Original behavior: full listing (no dir_name) - process all directories using unified function
    
    # Custom dirs (writable)
    for dir_path in user_custom_dirs:
        dir_name = dir_path.name if dir_path.name else str(dir_path)
        resp_dir = _process_single_directory(dir_path, dir_name, "", False, 
                                              include_dirs, include_items, search_mode)
        directories.append(resp_dir)

    # Presets: process root and subdirs using unified function
    if include_dirs or include_items:
        # PERFORMANCE: When lazy-loaded (no items), use lightweight scan that only returns structure + counts.
        # This avoids scanning all .txt files on home page load.
        if include_items:
            presets_structure = _scan_gallery_entries_with_subdirs(PRESETS_DIR)
        else:
            # Lightweight mode: only directory names and image counts, no txt parsing
            lightweight_result = _scan_directory_structure_only(PRESETS_DIR)
            presets_structure = {"root": [], "subdirs": {}}
            for sd in lightweight_result.get("subdirs", []):
                presets_structure["subdirs"][sd["name"]] = []  # Empty list triggers card display
        
        presets_root = presets_structure.get("root", [])
        presets_subdirs = presets_structure.get("subdirs", {})

        # Root-level presets items go into a "Presets" read-only directory (lazy-loaded too when no items requested)
        resp_dir = _process_single_directory(PRESETS_DIR, "Presets", "", True, 
                                              include_dirs, include_items, search_mode)
        directories.append(resp_dir)

        # Each presets subdir becomes its own read-only directory (only first-level subdirs)
        # NOTE: Only show presets subdirectory cards when include_items=True.
        # When lazy-loaded (include_items=False), only show the root "Presets" dir.
        for subdir_name in sorted(presets_subdirs.keys()):
            subdir_items = presets_subdirs[subdir_name]
            if subdir_items or include_items:
                # For presets subdirectories, only return items when requested
                resp_dir = _process_single_directory(PRESETS_DIR, 
                                                      f"Presets/{subdir_name}", subdir_name, True,
                                                      include_dirs=False, include_items=include_items, search_mode=search_mode)
                # Ensure no subdirs are shown for presets children
                if "subdirs" not in resp_dir:
                    resp_dir["subdirs"] = {}
                directories.append(resp_dir)

    total = sum(len(d.get("items", [])) for d in directories)
    
    # Build response with covers if requested
    response_data: dict = {"directories": directories, "total": total}
    
    if include_covers:
        covers: dict[str, list[dict]] = {}
        # Collect cover images for all directories (max 2 per directory).
        # _collect_all_dir_covers scans root level first, then first subdir with media.
        _collect_all_dir_covers(covers, PRESETS_DIR, "presets", 2)
        for dir_path in user_custom_dirs:
            dir_name = dir_path.name if dir_path.name else str(dir_path)
            _collect_all_dir_covers(covers, dir_path, dir_name, 2)
        response_data["covers"] = covers
    
    return web.json_response(response_data)


CURRENT_WEB_DIR = CURRENT_DIR / "web"

_PLACEHOLDER_PNG = bytes([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
])


@PromptServer.instance.routes.get("/neo_gallery/css")
async def serve_css(request):
    css_path = CURRENT_WEB_DIR / "gallery.css"
    if css_path.exists():
        with open(css_path, "r", encoding="utf-8") as f:
            css_content = f.read()
        return web.Response(text=css_content, content_type="text/css")
    return web.Response(status=404)


@PromptServer.instance.routes.get("/neo_gallery/placeholder.png")
async def serve_placeholder(request):
    return web.Response(body=_PLACEHOLDER_PNG, content_type="image/png")


@PromptServer.instance.routes.get("/neo_gallery/copy_to_input")
async def copy_to_input(request):
    try:
        import folder_paths as _folder_paths
        import shutil

        filename = request.rel_url.query.get("filename", "")
        subfolder = request.rel_url.query.get("subfolder", "")

        if not filename or ".." in filename or "/" in filename:
            return web.json_response({"success": False, "error": "Invalid filename"}, status=400)

        source_path = None
        user_custom_dirs = _get_user_custom_dirs()

        if subfolder:
            dir_parts = [p for p in subfolder.split("/") if p]
            if dir_parts[0] == "presets":
                candidate = PRESETS_DIR
                for part in dir_parts[1:]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            else:
                for dir_path in user_custom_dirs:
                    d_name = dir_path.name if dir_path.name else str(dir_path)
                    if dir_parts[0] == d_name:
                        candidate = dir_path
                        for part in dir_parts[1:]:
                            candidate = candidate / part
                        candidate = candidate / filename
                        if candidate.exists():
                            source_path = candidate
                            break

        if not source_path:
            for dir_path in user_custom_dirs:
                candidate = dir_path / filename
                if candidate.exists():
                    source_path = candidate
                    break

        # Fallback: try subfolder as relative path under any custom dir
        if not source_path and subfolder:
            for dir_path in user_custom_dirs:
                candidate = dir_path / subfolder / filename
                if candidate.exists():
                    source_path = candidate
                    break

        if not source_path:
            candidate = PRESETS_DIR / filename
            if candidate.exists():
                source_path = candidate

        if not source_path:
            candidate = CUSTOM_DIR / filename
            if candidate.exists():
                source_path = candidate

        if not source_path:
            return web.json_response({"success": False, "error": "Image not found"}, status=404)

        input_dir = Path(_folder_paths.input_directory).resolve()
        resolved_source = source_path.resolve()
        if resolved_source.parent == input_dir:
            return web.json_response({"success": True, "filename": filename, "skipped": True})

        # Content dedup: check if input dir already has same content
        import hashlib
        source_size = source_path.stat().st_size
        source_hash = hashlib.md5()
        with source_path.open("rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                source_hash.update(chunk)
        source_md5 = source_hash.hexdigest()

        found_existing = None
        for f in input_dir.iterdir():
            if not f.is_file():
                continue
            if f.suffix.lower() not in IMG_EXTENSIONS and f.suffix.lower() not in VIDEO_EXTENSIONS:
                continue
            if f.stat().st_size != source_size:
                continue
            h = hashlib.md5()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(8192), b""):
                    h.update(chunk)
            if h.hexdigest() == source_md5:
                found_existing = f
                break

        if found_existing:
            return web.json_response({"success": True, "filename": found_existing.name, "skipped": True})

        dest_path = input_dir / filename
        if dest_path.exists():
            stem = Path(filename).stem
            ext = Path(filename).suffix
            counter = 1
            while (input_dir / f"{stem}_{counter}{ext}").exists():
                counter += 1
            dest_path = input_dir / f"{stem}_{counter}{ext}"

        shutil.copy2(source_path, dest_path)
        return web.json_response({"success": True, "filename": dest_path.name})
    except Exception as e:
        print(f"[Neo Gallery] Error copying to input: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/neo_gallery/resolve_path")
async def resolve_comfyui_path(request):
    """Resolve ComfyUI's built-in input/output directory paths."""
    path_type = request.rel_url.query.get("path_type", "").lower()

    if path_type not in ("input", "output"):
        return web.json_response({"success": False, "error": "Invalid path_type"}, status=400)

    try:
        import folder_paths as _folder_paths

        if path_type == "input":
            base_dir = _folder_paths.input_directory
        else:
            base_dir = _folder_paths.output_directory

        resolved_path = Path(base_dir).resolve()
        if not resolved_path.exists():
            return web.json_response({
                "success": False,
                "error": f"Directory does not exist: {resolved_path}"
            }, status=404)

        comfy_root = Path(__file__).parent.parent.parent.resolve()
        if not str(resolved_path).startswith(str(comfy_root)):
            return web.json_response({
                "success": False,
                "error": f"Path outside ComfyUI directory: {resolved_path}"
            }, status=400)

        return web.json_response({
            "success": True,
            "path": str(resolved_path),
            "display_name": resolved_path.name
        })
    except Exception as e:
        print(f"[Neo Gallery] Error resolving {path_type} path: {e}")
        return web.json_response({
            "success": False,
            "error": f"Failed to resolve {path_type} directory: {str(e)}"
        }, status=500)


def _has_media_in_dir_any(dir_path: Path) -> bool:
    """Check if a directory contains any media files (images OR videos) directly."""
    for p in dir_path.iterdir():
        if p.is_file() and p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            return True
    return False


def _collect_cover_recursive(parent_dir: Path, current_subfolder: str, needed: int, result: list[dict]):
    """Recursively scan subdirectories for cover media (images + videos).
    
    Performance optimized: stops immediately when enough samples collected.
    Only descends into directories that don't already have direct media files.
    """
    if needed <= 0 or not parent_dir.exists():
        return
    
    for subdir in sorted(parent_dir.iterdir()):
        if len(result) >= needed:
            break
        
        if not subdir.is_dir():
            continue
        
        new_subfolder = f"{current_subfolder}/{subdir.name}" if current_subfolder else subdir.name
        
        # Check direct media files first (shallow scan at this level)
        found_direct = []
        for f in sorted(subdir.iterdir()):
            if len(result) >= needed:
                break
            if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTENSIONS:
                found_direct.append({
                    "filename": f.name,
                    "name": f.stem,
                    "subfolder": new_subfolder,
                })
        
        # If we found media at this level, add them and stop recursing deeper for this subdir
        if found_direct:
            result.extend(found_direct)
            # Check if we've collected enough - stop immediately
            if len(result) >= needed:
                return
        else:
            # No direct media - recurse into nested subdirectory
            _collect_cover_recursive(subdir, new_subfolder, needed, result)


def _collect_all_dir_covers(covers: dict, base_dir: Path, dir_name: str, sample_count: int, base_subfolder: str = ""):
    """Collect cover images for a directory.
    
    Scans root level first, then recursively descends into subdirectories if needed.
    Total cover images limited to sample_count (default 2).
    
    Args:
        covers: Dict to populate with results (keyed by "dir_name")
        base_dir: Root directory path
        dir_name: Display name of the root directory
        sample_count: Number of samples per directory (max cover images)
        base_subfolder: Base subfolder prefix for correct thumbnail URL resolution
    """
    if not base_dir.exists():
        return
    
    result: list[dict] = []
    
    # Level 1: Scan root level files first
    for p in sorted(base_dir.iterdir()):
        if len(result) >= sample_count:
            break
        if p.is_file() and p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            result.append({
                "filename": p.name,
                "name": p.stem,
                "subfolder": base_subfolder,
            })
    
    # Level 2+: Recursively scan subdirectories if not enough at root level
    _collect_covers_recursive(base_dir, sample_count - len(result), result, sample_count, base_subfolder)
    
    covers[f"{dir_name}"] = result


def _collect_covers_recursive(parent_dir: Path, needed: int, result: list[dict], sample_count: int, base_subfolder: str = ""):
    """Recursively scan subdirectories for cover media (images + videos).
    
    Args:
        parent_dir: Directory to scan
        needed: How many more samples we need (decrements with recursion)
        result: List to append results to
        sample_count: Maximum number of samples total (CONSTANT, never changes during recursion)
        base_subfolder: Base subfolder prefix for correct thumbnail URL resolution
    """
    if needed <= 0 or len(result) >= sample_count or not parent_dir.exists():
        return
    
    for subdir in sorted(parent_dir.iterdir()):
        if len(result) >= sample_count:
            break
        
        if not subdir.is_dir():
            continue
        
        # Build full subfolder path by prepending base_subfolder
        if base_subfolder:
            new_subfolder = f"{base_subfolder}/{subdir.name}"
        else:
            new_subfolder = subdir.name
        
        # Check direct media files at this subdirectory level (limit per-subdir contribution)
        found_direct = []
        remaining = sample_count - len(result)
        for f in sorted(subdir.iterdir()):
            if len(found_direct) >= remaining:
                break
            if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTENSIONS:
                found_direct.append({
                    "filename": f.name,
                    "name": f.stem,
                    "subfolder": new_subfolder,
                })
        
        # If we found media at this level, add them and stop recursing deeper for this subdir
        if found_direct:
            result.extend(found_direct)
        else:
            # No direct media - recurse into nested subdirectory (pass base_subfolder through)
            _collect_covers_recursive(subdir, max(needed - 1, 0), result, sample_count, base_subfolder)
        
        # Check if we've collected enough after processing this subdir
        if len(result) >= sample_count:
            break


def _collect_subdirs_with_media(directory: Path, prefix: str = "") -> list[str]:
    """Collect first-level subdirectory paths that contain media (images or videos).

    Returns a flat list of relative directory names (e.g., ["dir1", "dir2"]).
    Only returns immediate children directories, does NOT recurse into nested dirs.
    This ensures the home page only shows one level of subdirectories.
    """
    result = []

    if not directory.exists():
        return result

    for p in sorted(directory.iterdir()):
        if not p.is_dir():
            continue

        subdir_name = p.name
        if _has_media_in_dir_any(p):
            full_path = prefix + "/" + subdir_name if prefix else subdir_name
            result.append(full_path)

    return result


# Keep old name as alias for backward compatibility
def _collect_subdirs_with_images(directory: Path, prefix: str = "") -> list[str]:
    """Alias to _collect_subdirs_with_media for backward compatibility."""
    return _collect_subdirs_with_media(directory, prefix)


def _collect_sample_images_recursive(directory: Path, prefix: str, max_samples: int, result: list):
    """Recursively collect up to max_samples media entries from any depth.

    Lightweight version - only collects filename + subfolder for cover thumbnails.
    No txt parsing overhead. Includes both images and videos.
    
    The prefix should be a complete relative path (e.g., "mygallery/child/grandchild/images")
    so that the returned entry's subfolder field can be used to correctly construct image URLs.
    """
    if len(result) >= max_samples:
        return
    
    if not directory.exists():
        return
    
    # Collect lightweight entries (filename + subfolder only, no txt parsing)
    for p in sorted(directory.iterdir()):
        if len(result) >= max_samples:
            return
        
        if p.is_file() and p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            result.append({
                "filename": p.name,
                "name": p.stem,
                "subfolder": prefix,
            })
        
        elif p.is_dir():
            subdir_name = p.name
            new_prefix = prefix + "/" + subdir_name if prefix else subdir_name
            
            # If this subdir has direct media, collect them as samples
            if _has_media_in_dir_any(p):
                for sub_p in sorted(p.iterdir()):
                    if len(result) >= max_samples:
                        return
                    if sub_p.is_file() and sub_p.suffix.lower() in ALL_MEDIA_EXTENSIONS:
                        result.append({
                            "filename": sub_p.name,
                            "name": sub_p.stem,
                            "subfolder": new_prefix,
                        })
            else:
                # Recurse into nested subdirs (empty intermediate dir)
                _collect_sample_images_recursive(p, new_prefix, max_samples, result)


def _scan_directory_structure_flattened(directory: Path, base_dir: Path, sample_count: int = 0, dir_name: str = "") -> dict:
    """Scan directory and return hierarchical structure, skipping empty intermediate subdirectories.

    If an immediate subdirectory has no direct images but contains nested subdirectories
    with images, those deeper directories are returned directly (flattened), skipping the
    empty intermediate directory.

    When sample_count > 0, also collects up to that many image entries from anywhere in
    the tree for use as cover thumbnails on directory cards.
    
    The dir_name parameter is used to build complete subfolder paths for sample images,
    so they can be correctly resolved by the /neo_gallery/image endpoint.
    
    Performance optimization: when sample_count=0 (no samples needed), skip full txt parsing
    and use lightweight entry scanning instead.
    """
    if not directory.exists():
        return {"subdirs": [], "images": [], "sample_images": []}

    # Compute the subfolder for this directory level
    try:
        rel = directory.relative_to(base_dir)
        subfolder = str(rel)
    except ValueError:
        subfolder = ""

    all_subdirs = _collect_subdirs_with_images(directory)

    # Performance optimization: when sample_count=0, use lightweight scan (no txt parsing)
    if sample_count == 0:
        images = _scan_gallery_entries_lightweight(directory)
        
        return {
            "subdirs": all_subdirs,
            "images": images,
            "has_subdirs": len(all_subdirs) > 0,
            "image_count": len(images),
            "total_images": len(images),
            "sample_images": [],
        }

    # Full scan with txt parsing (needed for sample collection or detailed view)
    all_entries = _scan_gallery_entries(directory, subfolder)

    subdir_map = {}
    immediate_subdirs_with_images = []

    for entry in all_entries:
        cat = entry.get("category", "")
        if cat:
            if cat not in subdir_map:
                subdir_map[cat] = []
                immediate_subdirs_with_images.append(cat)
            subdir_map[cat].append(entry)

    images = [e for e in all_entries if not e.get("category")]

    # Collect sample images from any depth, using dir_name as the root prefix
    sample_images: list[dict] = []
    if sample_count > 0 and dir_name:
        _collect_sample_images_recursive(directory, dir_name, sample_count, sample_images)

    return {
        "subdirs": all_subdirs,
        "images": images,
        "has_subdirs": len(all_subdirs) > 0,
        "image_count": len(images),
        "total_images": len(all_entries) + len(sample_images),
        "sample_images": sample_images,
    }


@PromptServer.instance.routes.post("/neo_gallery/dir_cover_images")
async def get_directory_cover_images(request):
    """Batch endpoint to collect cover images for all known directories.
    
    Returns lightweight cover image entries (filename + subfolder only, no txt parsing)
    for every custom directory and presets directory/subdirectory in a single request.
    
    Request body: { "samples": 2 } (optional, default 2 per directory)
    Response: { "covers": { "dir_name/key": [{...}], ... } }
    """
    try:
        data = await request.json() if await request.content_type == "application/json" else {}
        sample_count = int(data.get("samples", 2))
        
        covers: dict[str, list[dict]] = {}
        
        # Collect from presets (use real path name consistently)
        _collect_all_dir_covers(covers, PRESETS_DIR, "presets", sample_count)
        
        # Collect from all custom directories (use real path names, no case conversion)
        for dir_path in _get_user_custom_dirs():
            dir_name = dir_path.name if dir_path.name else str(dir_path)
            _collect_all_dir_covers(covers, dir_path, dir_name, sample_count)
        
        return web.json_response({"covers": covers})
    except Exception as e:
        print(f"[Neo Gallery] Error collecting cover images: {e}")
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/neo_gallery/subdirs")
async def get_subdirs(request):
    """Get first-level subdirectory structure with image counts.

    Query params:
    - dir_name: name of the custom directory or 'presets' (required)
    - path: relative subdirectory path within that directory (optional, "/" separated)
    
    Returns only first-level subdirectories with their image counts.
    Fastest possible scan - one os.listdir() call per level, no recursion.
    
    Returns format:
        {
            "dir_name": str,
            "path": str,
            "subdirs": [{name: str, image_count: int, path: str}]
        }
    """
    if "dir_name" not in request.rel_url.query:
        return web.json_response({"error": "Missing dir_name"}, status=400)

    dir_name = request.rel_url.query["dir_name"]
    rel_path = request.rel_url.query.get("path", "")

    # Security check for path traversal
    if ".." in rel_path:
        return web.json_response({"error": "Invalid path"}, status=400)

    base: Path | None = None
    dir_name_lower = dir_name.lower()
    if dir_name_lower == "presets":
        base = PRESETS_DIR
    elif dir_name_lower.startswith("presets/"):
        base = PRESETS_DIR
        if not rel_path:
            rel_path = dir_name_lower[len("presets/"):]
    else:
        user_custom_dirs = _get_user_custom_dirs()
        for dir_path in user_custom_dirs:
            d_name = dir_path.name if dir_path.name else str(dir_path)
            if d_name.lower() == dir_name_lower:
                base = dir_path
                break

    if base is None or not base.exists():
        return web.json_response({"error": "Directory not found"}, status=404)

    if rel_path:
        parts = [p for p in rel_path.split("/") if p]
        target_dir = base
        for part in parts:
            target_dir = target_dir / part
    else:
        target_dir = base

    # Use lightweight structure-only scan (no txt parsing, no images)
    structure = _scan_directory_structure_only(target_dir)

    return web.json_response({
        "dir_name": dir_name,
        "path": rel_path,
        "subdirs": structure.get("subdirs", []),
    })


# ---------------------------------------------------------------------------
# Thumbnail Routes
# ---------------------------------------------------------------------------


def _generate_thumbnail(source_path: Path, cache_path: Path, size: int = THUMBNAIL_SIZE) -> bool:
    """Generate a thumbnail image and save to cache_path.
    
    For video files, extracts first frame using ffmpeg.
    Returns True if successful, False otherwise.
    """
    try:
        # Check if source is a video file
        if source_path.suffix.lower() in VIDEO_EXTENSIONS:
            return _generate_video_thumbnail(source_path, cache_path, size)
        
        from PIL import Image
        with Image.open(source_path) as img:
            # Convert to RGB if necessary (handle RGBA, P mode, etc.)
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            
            # Create thumbnail (in-place resize)
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            
            # Ensure directory exists
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Save as JPEG
            if img.mode == "RGBA":
                # Create white background for RGBA images
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"[Neo Gallery] Failed to generate thumbnail: {e}")
        return False


def _generate_video_thumbnail(source_path: Path, cache_path: Path, size: int = THUMBNAIL_SIZE) -> bool:
    """Generate a thumbnail from a video file using ffmpeg.
    
    Extracts the first frame and saves as JPEG thumbnail.
    """
    try:
        import subprocess
        import shutil
        
        # Check if ffmpeg is available
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            return False
        
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Extract first frame using ffmpeg
        # Note: -ss must be BEFORE -i for input seeking (works with most formats)
        cmd = [
            ffmpeg_path,
            "-ss", "00:00:00.500",
            "-i", str(source_path),
            "-vframes", "1",
            "-y",
            str(cache_path)
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            # Try without -ss for first frame (some formats don't support input seeking well)
            cmd = [
                ffmpeg_path,
                "-i", str(source_path),
                "-vframes", "1",
                "-y",
                str(cache_path)
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                return False
        
        # Validate that the output is a valid image file
        try:
            from PIL import Image
            with Image.open(cache_path) as img:
                img.verify()
            # Also check file size > 1KB to avoid empty/corrupt files
            if cache_path.stat().st_size < 1024:
                return False
        except Exception:
            # Invalid image, clean up and return failure
            try:
                cache_path.unlink(missing_ok=True)
            except Exception:
                pass
            return False
        
        return True
    except Exception as e:
        return False


def _get_thumbnail_path(filename: str, subfolder: str, size: int) -> Path:
    """Get the cache path for a thumbnail using hash based on file content.
    
    Uses date-based subdirectories (YYYY-MM) to avoid too many files in one directory.
    """
    import time
    # Find source path to compute hash from actual file properties
    source_path = _find_source_media(filename, subfolder)
    if source_path and source_path.exists():
        # Use absolute path + size + mtime for unique hash
        stat = source_path.stat()
        cache_key = f"{source_path.resolve().as_posix()}_{stat.st_size}_{stat.st_mtime}"
        # Create date-based subdirectory (YYYY-MM) from file modification time
        date_str = time.strftime("%Y-%m", time.localtime(stat.st_mtime))
    else:
        # Fallback to filename-based hash if source not found
        cache_key = f"{filename}_{subfolder}_{size}"
        date_str = time.strftime("%Y-%m")
    
    import hashlib
    hash_hex = hashlib.md5(cache_key.encode()).hexdigest()[:12]
    cache_path = THUMBNAIL_DIR / date_str / f"{hash_hex}_{size}.jpg"
    # Auto-create date directory if it doesn't exist
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    return cache_path


def _find_source_media(filename: str, subfolder: str) -> Path | None:
    """Find the source media file (image or video) for a given filename and subfolder."""
    user_custom_dirs = _get_user_custom_dirs()
    source_path = None
    
    # Search in custom dirs - try every dir directly first (most reliable)
    for dir_path in user_custom_dirs:
        candidate = dir_path / filename
        if candidate.exists():
            source_path = candidate
            break
    
    # Try subfolder under each custom dir (try all possible path combinations)
    if not source_path and subfolder:
        dir_parts = [p for p in subfolder.split("/") if p]
        
        # If there's only one part, it could be either:
        # 1. A direct subdir of a custom dir (e.g., "stars" -> dir_path / filename)
        # 2. A nested path under any custom dir (e.g., "stars/subdir")
        if len(dir_parts) == 1:
            # First try as root-level file under each custom dir
            for dir_path in user_custom_dirs:
                candidate = dir_path / filename
                if candidate.exists():
                    source_path = candidate
                    break
        
        # Try the full path under each custom dir (handles nested paths like "presets/subdir")
        if not source_path:
            for dir_path in user_custom_dirs:
                candidate = dir_path
                for part in dir_parts:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
                    break
        
        # Special handling: when the subfolder starts with a directory name that matches
        # a custom dir's name, skip that first part (e.g., "stars/stars1104x1472" 
        # should resolve to dir_path / "stars1104x1472", not dir_path / "stars" / "stars1104x1472")
        if not source_path and len(dir_parts) >= 2:
            for dir_path in user_custom_dirs:
                # Check if first part matches this directory's name or parent path
                dir_name = dir_path.name
                dir_stem = dir_path.stem
                full_path_str = str(dir_path).lower()
                
                for i, part in enumerate(dir_parts):
                    # FIX: Use .lower() on both sides for case-insensitive comparison
                    if (part.lower() == dir_name.lower() or 
                        part.lower() == dir_stem.lower() or 
                        part.lower() + "\\" in full_path_str or 
                        part.lower() + "/" in full_path_str):
                        # This part matches the directory name, try rest of path
                        remaining_parts = dir_parts[i+1:]
                        if not remaining_parts:
                            # Just use the directory itself
                            candidate = dir_path / filename
                        else:
                            candidate = dir_path
                            for rp in remaining_parts:
                                candidate = candidate / rp
                            candidate = candidate / filename
                        
                        if candidate.exists():
                            source_path = candidate
                            break
                
                if source_path:
                    break
    
    # Search in presets (including subfolders)
    if not source_path:
        subfolder_lower = (subfolder or "").lower()
        if subfolder_lower.startswith("presets/"):
            sub_path = subfolder_lower[len("presets/"):]
            candidate = PRESETS_DIR / sub_path / filename
            if candidate.exists():
                source_path = candidate
        elif subfolder_lower == "presets" or not subfolder:
            candidate = PRESETS_DIR / filename
            if candidate.exists():
                source_path = candidate
        else:
            # Fallback: treat subfolder as a direct subdirectory name under presets
            candidate = PRESETS_DIR / subfolder / filename
            if candidate.exists():
                source_path = candidate

    # Search in custom gallery dir
    if not source_path:
        candidate = CUSTOM_DIR / filename
        if candidate.exists():
            source_path = candidate
    
    # Fallback: try to find by extension (both image and video)
    if not source_path:
        for ext in [".jpeg", ".jpg", ".png", ".webp", ".gif", ".bmp", ".tiff",
                    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"]:
            candidate = PRESETS_DIR / (Path(filename).stem + ext)
            if candidate.exists():
                source_path = candidate
                break
    
    return source_path


def _find_source_image(filename: str, subfolder: str) -> Path | None:
    """Find the source image file for a given filename and subfolder."""
    return _find_source_media(filename, subfolder)


@PromptServer.instance.routes.get("/neo_gallery/thumbnail")
async def get_thumbnail(request):
    """Serve cached thumbnail for gallery images."""
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "presets")
    size = int(request.rel_url.query.get("size", THUMBNAIL_SIZE))
    
    # URL decode filename to handle special characters
    from urllib.parse import unquote
    filename = unquote(filename)
    subfolder = unquote(subfolder)
    
    if not filename or ".." in filename or "/" in filename:
        return web.Response(status=400)
    
    # Find the source image
    source_path = _find_source_image(filename, subfolder)
    
    if not source_path:
        return web.Response(status=404)
    
    # Get cache path
    cache_path = _get_thumbnail_path(filename, subfolder, size)
    
    # Check if cache is valid (exists and is newer than source)
    use_cache = False
    if cache_path.exists():
        try:
            cache_mtime = cache_path.stat().st_mtime
            source_mtime = source_path.stat().st_mtime
            if cache_mtime >= source_mtime:
                use_cache = True
        except Exception:
            pass
    
    if use_cache:
        # Return cached thumbnail with long-term caching headers
        # Since URL is deterministic (hash-based), browser can cache indefinitely
        with open(cache_path, "rb") as f:
            content = f.read()
        return web.Response(
            body=content, 
            content_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "ETag": f'"{cache_path.stat().st_mtime}-{cache_path.stat().st_size}"'
            }
        )
    
    # Generate thumbnail
    if _generate_thumbnail(source_path, cache_path, size):
        with open(cache_path, "rb") as f:
            content = f.read()
        return web.Response(
            body=content, 
            content_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "ETag": f'"{cache_path.stat().st_mtime}-{cache_path.stat().st_size}"'
            }
        )
    
    # Fallback: return original image
    with open(source_path, "rb") as f:
        content = f.read()
    content_type, _ = mimetypes.guess_type(str(source_path))
    if not content_type:
        content_type = "image/jpeg"
    return web.Response(body=content, content_type=content_type)


@PromptServer.instance.routes.get("/neo_gallery/video")
async def view_video(request):
    """Serve gallery videos by filename."""
    if "filename" not in request.rel_url.query:
        return web.Response(status=400)

    filename = request.rel_url.query["filename"]
    subfolder = request.rel_url.query.get("subfolder", "presets")

    if ".." in filename or ".." in subfolder:
        return web.Response(status=400)

    source_path = _find_source_media(filename, subfolder)
    if not source_path:
        return web.Response(status=404)

    if source_path.suffix.lower() not in VIDEO_EXTENSIONS:
        return web.Response(status=400)

    with open(source_path, "rb") as f:
        content = f.read()
    content_type, _ = mimetypes.guess_type(str(source_path))
    if not content_type:
        content_type = "video/mp4"
    return web.Response(
        body=content,
        content_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{source_path.name}"'},
    )


@PromptServer.instance.routes.get("/neo_gallery/image")
async def view_image(request):
    """Serve gallery images by filename."""
    if "filename" not in request.rel_url.query:
        return web.Response(status=400)

    filename = request.rel_url.query["filename"]
    subfolder = request.rel_url.query.get("subfolder", "presets")
    category = request.rel_url.query.get("category", "")

    if ".." in filename or ".." in subfolder:
        return web.Response(status=400)

    if subfolder.startswith("__"):
        return web.Response(status=400)

    user_custom_dirs = _get_user_custom_dirs()
    base: Path | None = None

    dir_parts = [p for p in subfolder.split("/") if p]
    subfolder_lower = subfolder.lower()

    def _match_dir_name(parts_list):
        target = parts_list[0].lower()
        for dir_path in user_custom_dirs:
            if dir_path.name.lower() == target:
                return dir_path
        return None

    if subfolder_lower == "presets" or subfolder_lower == "":
        base = PRESETS_DIR
    elif subfolder_lower == "custom":
        base = CUSTOM_DIR
    elif len(dir_parts) > 0 and dir_parts[0].lower() == "presets":
        base = PRESETS_DIR / "/".join(dir_parts[1:])
    elif len(dir_parts) > 0 and len(dir_parts) == 1:
        candidate = PRESETS_DIR / dir_parts[0]
        if candidate.exists():
            base = candidate
        else:
            matched_dir = _match_dir_name(dir_parts)
            if matched_dir:
                base = matched_dir
            else:
                # Try as subdirectory under any custom dir
                for dir_path in user_custom_dirs:
                    candidate = dir_path / dir_parts[0]
                    if candidate.exists():
                        base = candidate
                        break
    elif len(dir_parts) > 1:
        matched_dir = _match_dir_name(dir_parts)
        if matched_dir:
            base = matched_dir / "/".join(dir_parts[1:])
    else:
        for dir_path in user_custom_dirs:
            d_name = dir_path.name if dir_path.name else str(dir_path)
            if subfolder_lower == d_name.lower():
                base = dir_path
                break

    if base is None or not base.exists():
        return web.Response(status=404)

    fullpath = None

    from pathlib import PurePath as _PurePath
    _p = _PurePath(filename)
    file_stem = _p.stem

    checked_paths = set()

    candidates_to_try = [filename]
    for ext in [".jpeg", ".jpg", ".png", ".webp", ".gif", ".bmp", ".tiff"]:
        candidates_to_try.append(file_stem + ext)

    use_category = category and not any(part in subfolder for part in category.split("/"))

    for candidate_filename in candidates_to_try:
        if candidate_filename in checked_paths:
            continue

        if use_category and category:
            candidate = base / category / candidate_filename
            if candidate.exists():
                fullpath = candidate
                checked_paths.add(str(candidate))
                break

        if not fullpath:
            candidate = base / candidate_filename
            if candidate.exists():
                fullpath = candidate
                checked_paths.add(str(candidate))
                break

    if fullpath is None:
        for p in base.rglob(f"{file_stem}*"):
            if p.is_file() and str(p) not in checked_paths:
                ext_lower = p.suffix.lower()
                if ext_lower in IMG_EXTENSIONS:
                    fullpath = p
                    break

    if fullpath and fullpath.exists():
        with open(fullpath, "rb") as f:
            content = f.read()
        content_type, _ = mimetypes.guess_type(str(fullpath))
        if not content_type:
            content_type = "application/octet-stream"
        return web.Response(
            body=content,
            content_type=content_type,
            headers={"Content-Disposition": f'inline; filename="{fullpath.name}"'},
        )
    return web.Response(status=404)


# ---------------------------------------------------------------------------
# Settings Routes (custom presets directory)
# ---------------------------------------------------------------------------

SETTINGS_FILE = CURRENT_DIR / "gallery_settings.json"


def _save_settings(settings: dict):
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception as e:
        print(f"[Neo Gallery] Failed to save settings: {e}")


def _load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
    except Exception as e:
        print(f"[Neo Gallery] Failed to load settings: {e}")
    return {}


@PromptServer.instance.routes.post("/neo_gallery/save_settings")
async def save_gallery_settings(request):
    """Save gallery settings (custom directories list)."""
    try:
        data = await request.json()
        current_settings = _load_settings()

        action = data.get("action")

        if action == "add":
            new_dir = data.get("path", "").strip()
            if not new_dir:
                return web.json_response({"success": False, "error": "No path provided"}, status=400)
            if not Path(new_dir).exists():
                return web.json_response(
                    {"success": False, "error": f"Directory not found: {new_dir}"},
                    status=400
                )
            dirs = current_settings.get("custom_directories", [])
            if new_dir not in dirs:
                dirs.append(new_dir)
            current_settings["custom_directories"] = dirs
            current_settings.pop("custom_directory", None)

        elif action == "remove":
            remove_path = data.get("path", "").strip()
            dirs = current_settings.get("custom_directories", [])
            if remove_path in dirs:
                dirs.remove(remove_path)
            current_settings["custom_directories"] = dirs

        elif action == "list":
            pass

        else:
            custom_dir = None
            if "presets_directory" in data:
                custom_dir = data["presets_directory"].strip()
            elif "custom_directory" in data:
                custom_dir = data["custom_directory"]

            if custom_dir is not None:
                if custom_dir and not Path(custom_dir).exists():
                    return web.json_response(
                        {"success": False, "error": f"Directory not found: {custom_dir}"},
                        status=400
                    )
                current_settings["custom_directories"] = [custom_dir]
                current_settings.pop("custom_directory", None)

        _save_settings(current_settings)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/neo_gallery/get_settings")
async def get_gallery_settings(request):
    """Get gallery settings."""
    return web.json_response(_load_settings())


@PromptServer.instance.routes.post("/neo_gallery/upload_txt")
async def upload_txt(request):
    """Upload / update a .txt metadata file alongside a preset image."""
    try:
        post = await request.post()
        txt_content = post.get("content", "")
        filename = post.get("filename", "")

        if not filename:
            return web.json_response({"error": "No filename provided"}, status=400)

        if not filename.endswith(".txt"):
            filename += ".txt"

        dest = PRESETS_DIR / filename
        dest.write_text(txt_content, encoding="utf-8")
        return web.json_response({"name": filename, "success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/neo_gallery/delete")
async def delete_gallery_item(request):
    """Delete a custom image + its .txt companion. Presets are read-only."""
    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "")

        # --- Input validation ---
        if not filename or ".." in filename:
            return web.json_response({"success": False, "error": "Invalid filename"}, status=400)

        # --- Read-only check for presets ---
        subfolder_lower = (subfolder or "").lower()
        if subfolder_lower == "presets" or subfolder_lower.startswith("presets/"):
            return web.json_response({"success": False, "error": "Cannot delete from read-only presets directory"}, status=403)

        # --- Resolve base directory and target path ---
        user_custom_dirs = _get_user_custom_dirs()
        
        print(f"[Neo Gallery] DELETE called: filename={filename!r}, subfolder={subfolder!r}")
        print(f"[Neo Gallery] Custom dirs count: {len(user_custom_dirs)}")
        for d in user_custom_dirs:
            print(f"  - {d}")

        base: Path | None = None
        found_path: Path | None = None
        
        # Single unified search: try every custom dir + subfolder + filename with every extension
        for dir_path in user_custom_dirs:
            if subfolder:
                candidate_base = dir_path / subfolder
            else:
                candidate_base = dir_path
            
            # Try exact filename first (without extension) — only if it exists as-is
            if (candidate_base / filename).is_file():
                base = dir_path
                found_path = candidate_base / filename
                print(f"[Neo Gallery] Found exact match: {found_path}")
                break
            
            # Try with every media extension
            for ext in ALL_MEDIA_EXTENSIONS:
                candidate = candidate_base / f"{filename}{ext}"
                if candidate.exists():
                    base = dir_path
                    found_path = candidate
                    print(f"[Neo Gallery] Found with extension {ext}: {candidate}")
                    break
            
            if base:
                break

        # Fallback: also check without subfolder prefix (root-level files)
        if not base:
            for dir_path in user_custom_dirs:
                for ext in ALL_MEDIA_EXTENSIONS:
                    candidate = dir_path / f"{filename}{ext}"
                    if candidate.exists():
                        base = dir_path
                        found_path = candidate
                        print(f"[Neo Gallery] Fallback found: {candidate}")
                        break
                if base:
                    break

        if not base or not found_path:
            return web.json_response({"success": False, "error": f"Source file not found (filename={filename!r}, subfolder={subfolder!r})"}, status=404)

        # --- Resolve target directory ---
        target_dir = found_path.parent
        delete_filename = found_path.name  # Use the full filename with extension

        print(f"[Neo Gallery] Target dir: {target_dir}, file: {delete_filename}")

        if not target_dir.exists():
            return web.json_response({"success": False, "error": f"Target directory not found: {target_dir}"}, status=404)

        # --- Delete media files (use found_path's exact name) ---
        img_deleted = False
        if found_path and found_path.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            try:
                found_path.unlink()
                img_deleted = True
                print(f"[Neo Gallery] Deleted media: {found_path}")
            except Exception as e:
                print(f"[Neo Gallery] Failed to delete {found_path}: {e}")

        # --- Delete .txt companion (use the same stem as found_path) ---
        txt_deleted = False
        txt_stem = found_path.stem  # Use the stem of the actual file, not the original filename
        txt = target_dir / f"{txt_stem}.txt"
        if txt.exists():
            try:
                txt.unlink()
                txt_deleted = True
                print(f"[Neo Gallery] Deleted txt: {txt}")
            except Exception as e:
                print(f"[Neo Gallery] Failed to delete {txt}: {e}")

        # Also check for .txt with the original filename stem (fallback)
        if not txt_deleted and filename:
            orig_txt = target_dir / f"{filename}.txt"
            if orig_txt.exists():
                try:
                    orig_txt.unlink()
                    txt_deleted = True
                except Exception as e:
                    print(f"[Neo Gallery] Failed to delete {orig_txt}: {e}")

        # Also check for .txt with the stem directly (no extension prefix)
        if not img_deleted and found_path.suffix.lower() != ".txt":
            stem_path = target_dir / found_path.name
            if stem_path.exists() and stem_path.suffix.lower() == ".txt":
                try:
                    stem_path.unlink()
                    txt_deleted = True
                except Exception as e:
                    print(f"[Neo Gallery] Failed to delete {stem_path}: {e}")

        # --- Delete cached thumbnails matching this file ---
        thumb_count = 0
        filename_stem = Path(filename).stem
        for date_dir in THUMBNAIL_DIR.iterdir():
            if not date_dir.is_dir():
                continue
            # Pattern 1: old format "{stem}_*.jpg"
            try:
                for thumb_file in date_dir.glob(f"{filename_stem}_*.jpg"):
                    try:
                        thumb_file.unlink()
                        thumb_count += 1
                    except Exception:
                        pass
            except Exception:
                pass

            # Pattern 2: hash-based cache (new format) — recompute and delete
            try:
                import hashlib as _hashlib
                source_path = _find_source_media(filename, subfolder)
                if source_path and source_path.exists():
                    stat = source_path.stat()
                    cache_key = f"{source_path.resolve().as_posix()}_{stat.st_size}_{stat.st_mtime}"
                    hash_hex = _hashlib.md5(cache_key.encode()).hexdigest()[:12]
                    for thumb_file in date_dir.glob(f"{hash_hex}_*.jpg"):
                        try:
                            thumb_file.unlink()
                            thumb_count += 1
                        except Exception:
                            pass
            except Exception:
                pass

        return web.json_response({
            "success": True,
            "deleted": img_deleted or txt_deleted,
            "image_deleted": img_deleted,
            "txt_deleted": txt_deleted,
            "thumbnails_cleared": thumb_count
        })
    except Exception as e:
        print(f"[Neo Gallery] delete_gallery_item error: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/neo_gallery/clear_thumbnails")
async def clear_thumbnails(request):
    """Clear all cached thumbnails for a given subfolder."""
    try:
        data = await request.json()
        subfolder = data.get("subfolder", "")
        
        if not subfolder:
            # Clear all thumbnails by removing date directories
            import shutil
            for date_dir in THUMBNAIL_DIR.iterdir():
                if date_dir.is_dir():
                    shutil.rmtree(date_dir)
            return web.json_response({"success": True, "cleared": "all"})
        
        # For specific subfolder, clear all date directories (hash-based cache)
        count = 0
        for date_dir in THUMBNAIL_DIR.iterdir():
            if not date_dir.is_dir():
                continue
            for thumb_file in date_dir.glob("*.jpg"):
                thumb_file.unlink()
                count += 1
        
        return web.json_response({"success": True, "cleared": count})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# Ensure gallery directories exist on module load
_ensure_dirs()
