# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — Video Recipe Module
# A recipe = a named combination: prompt text + ordered assets (images/videos),
# stored in its own preset directory with an assets/ folder.

import re
import json
import shutil
import datetime
import mimetypes
from pathlib import Path
from aiohttp import web
from server import PromptServer

from .gallery import (
    IMG_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _copy_media_to_input,
)

CURRENT_DIR = Path(__file__).parent.resolve()
RECIPES_DIR = CURRENT_DIR / "recipes"
CUSTOM_DIR = RECIPES_DIR / "custom"      # 用户保存的配方
PRESETS_DIR = RECIPES_DIR / "presets"    # 内置预设（只读）

_sanitize_name_re = re.compile(r"[^\w\- ]+")  # keep letters/digits/_/- and spaces


def _ensure_dirs() -> None:
    for d in (RECIPES_DIR, CUSTOM_DIR, PRESETS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # 旧版直接放在 recipes/ 下的配方目录迁移到 custom/
    for p in RECIPES_DIR.iterdir():
        if p.is_dir() and p.name not in ("custom", "presets") and (p / "recipe.json").exists():
            target = CUSTOM_DIR / p.name
            if not target.exists():
                shutil.move(str(p), str(target))


def _valid_name(name: str) -> bool:
    return bool(name) and ".." not in name and "/" not in name and "\\" not in name


def _find_recipe_dir(name: str) -> Path | None:
    """Locate a recipe folder; user recipes (custom) take precedence over presets."""
    if not _valid_name(name):
        return None
    for base in (CUSTOM_DIR, PRESETS_DIR):
        if (base / name / "recipe.json").is_file():
            return base / name
    return None


def _kind_of(asset_file: Path) -> str:
    return "video" if asset_file.suffix.lower() in VIDEO_EXTENSIONS else "image"


def _scan_recipe_dir(recipe_dir: Path, source: str) -> dict | None:
    """Return recipe metadata (name, prompt, asset list + cover) for one folder."""
    meta_path = recipe_dir / "recipe.json"
    if not meta_path.exists():
        return None

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return None

    assets_dir = recipe_dir / "assets"
    if not assets_dir.exists():
        empty_dir = True
    else:
        empty_dir = False

    # 优先按 recipe.json 记录的 assets 顺序还原（保存时把前端按参数序号排好的顺序写入）
    ordered = meta.get("assets", [])
    if isinstance(ordered, str):
        ordered = [ordered]

    existing = {}
    if not empty_dir:
        for f in assets_dir.iterdir():
            if f.is_file() and f.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
                if f.stem.startswith("_cover") or f.stem.startswith("_preview"):
                    continue  # 元数据封面，不视为资源资产
                existing[f.name] = {"file": f.name, "kind": _kind_of(f)}

    assets = []
    for name in ordered:
        if name in existing:
            assets.append(existing.pop(name))
    # 目录里存在但未在 recipe.json 记录的（用户手动放入）按目录顺序补尾
    assets.extend(existing.values())

    cover = None
    for name in ("_preview.jpg", "_preview.png", "_cover.jpg", "_cover.png"):
        if (assets_dir / name).exists():
            cover = name
            break

    return {
        "name": recipe_dir.name,
        "source": source,
        "prompt": meta.get("prompt", ""),
        "created_at": meta.get("created_at", ""),
        "mtime": meta_path.stat().st_mtime,
        "asset_count": len(assets),
        "cover": cover,
        "assets": assets,
    }


def _copy_ref_into_assets(ref: dict, assets_dir: Path) -> str | None:
    """Resolve a Comfy file ref {filename, subfolder, type} to its physical path and
    copy it into the recipe's assets dir. Returns the destination filename or None."""
    filename = str(ref.get("filename", "")).strip()
    if not filename or ".." in filename:
        return None

    import folder_paths as _folder_paths

    base_dir = _folder_paths.get_input_directory()
    ftype = ref.get("type", "input")
    if ftype == "output":
        base_dir = _folder_paths.get_output_directory()
    elif ftype == "temp":
        base_dir = _folder_paths.get_temp_directory()

    name = filename
    subfolder = str(ref.get("subfolder", "") or "").strip("/")
    if subfolder:
        name = subfolder + "/" + filename

    try:
        source_path = Path(_folder_paths.get_annotated_filepath(name, base_dir))
    except ValueError:
        return None
    if not source_path.is_file():
        return None

    dest = assets_dir / Path(filename).name
    if dest.exists():
        stem = Path(filename).stem
        ext = Path(filename).suffix
        counter = 1
        while (assets_dir / f"{stem}_{counter}{ext}").exists():
            counter += 1
        dest = assets_dir / f"{stem}_{counter}{ext}"

    shutil.copy2(source_path, dest)
    return dest.name


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/rs_recipes/list")
async def rs_recipes_list(request):
    _ensure_dirs()
    recipes = []
    for source, base in (("preset", PRESETS_DIR), ("custom", CUSTOM_DIR)):
        for p in sorted(base.iterdir()):
            if not p.is_dir():
                continue
            meta = _scan_recipe_dir(p, source)
            if meta:
                recipes.append(meta)
    return web.json_response(recipes)


@PromptServer.instance.routes.post("/rs_recipes/load")
async def rs_recipes_load(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        source = "custom" if recipe_dir.parent == CUSTOM_DIR else "preset"
        meta = _scan_recipe_dir(recipe_dir, source)
        return web.json_response({"success": True, "recipe": meta})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post("/rs_recipes/save")
async def rs_recipes_save(request):
    try:
        data = await request.json()
        raw_name = str(data.get("name", "")).strip()
        if not raw_name:
            return web.json_response({"success": False, "error": "Name required"}, status=400)
        name = _sanitize_name_re.sub("", raw_name).strip().replace(" ", "-")
        if not name:
            return web.json_response({"success": False, "error": "Invalid name"}, status=400)

        _ensure_dirs()
        if (PRESETS_DIR / name / "recipe.json").is_file():
            return web.json_response({"success": False, "error": "Name already used by a preset recipe"}, status=409)
        recipe_dir = CUSTOM_DIR / name
        assets_dir = recipe_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        # Assets passed as Comfy file refs {filename, subfolder, type}; copy each in.
        copied = []
        for ref in data.get("assets", []) or []:
            if not isinstance(ref, dict):
                continue
            copied_name = _copy_ref_into_assets(ref, assets_dir)
            if copied_name:
                copied.append(copied_name)

        recipe = {
            "name": name,
            "prompt": data.get("prompt", ""),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "assets": copied,
        }
        with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
            json.dump(recipe, f, ensure_ascii=False, indent=2)

        return web.json_response({"success": True, "name": name, "asset_count": len(copied)})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/rs_recipes/delete")
async def rs_recipes_delete(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        shutil.rmtree(recipe_dir, ignore_errors=True)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/rs_recipes/asset")
async def rs_recipes_asset(request):
    recipe = request.rel_url.query.get("recipe", "")
    file = request.rel_url.query.get("file", "")
    if not recipe or not file or ".." in recipe or ".." in file or "/" in file or "\\" in file:
        return web.Response(status=400)

    recipe_dir = _find_recipe_dir(recipe)
    asset_path = recipe_dir / "assets" / file if recipe_dir else None
    if asset_path is None or not asset_path.is_file():
        return web.Response(status=404)

    suffix = asset_path.suffix.lower()
    content_type = "image/png"
    if suffix in VIDEO_EXTENSIONS:
        content_type = "video/mp4"
    elif suffix in IMG_EXTENSIONS:
        content_type = mimetypes.guess_type(asset_path.name)[0] or "image/png"

    with open(asset_path, "rb") as f:
        return web.Response(body=f.read(), content_type=content_type)


@PromptServer.instance.routes.post("/rs_recipes/send_to_workflow")
async def rs_recipes_send_to_workflow(request):
    """Copy every asset of a recipe into Comfy's input dir, returning the resolved
    Comfy filename per asset so the frontend can fill load widgets in one pass."""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        source = "custom" if recipe_dir.parent == CUSTOM_DIR else "preset"
        meta = _scan_recipe_dir(recipe_dir, source)

        assets_dir = recipe_dir / "assets"
        out_assets = []
        for asset in meta["assets"]:
            asset_path = assets_dir / asset["file"]
            if not asset_path.is_file():
                continue
            resolved, _ = _copy_media_to_input(asset_path, asset["file"])
            out_assets.append({"file": resolved, "kind": asset["kind"]})

        return web.json_response({"success": True, "name": name, "assets": out_assets})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)