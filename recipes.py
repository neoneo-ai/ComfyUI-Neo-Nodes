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
from urllib.parse import quote, urlparse
import aiohttp
from aiohttp import web
from server import PromptServer

from .gallery import (
    AUDIO_EXTENSIONS,
    CIVITAI_BOOKMARK_DIR,
    IMG_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _copy_media_to_input,
    _json_safe,
    _load_settings,
)
from .gallery_lora import CIVITAI_API_BASE, LORA_CACHE_DIR, _load_lora_index
from .util import _extract_media_metadata

CURRENT_DIR = Path(__file__).parent.resolve()
RECIPES_DIR = CURRENT_DIR / "recipes"
CUSTOM_DIR = RECIPES_DIR / "custom"      # 用户保存的配方
PRESETS_DIR = RECIPES_DIR / "presets"    # 内置预设（只读）

_sanitize_name_re = re.compile(r"[^\w\- ]+")  # keep letters/digits/_/- and spaces

# Progress of the current bookmark example-image cache run (polled by the UI, like the Lora auto-cache).
_bookmark_cache_state: dict = {"running": False, "total": 0, "done": 0, "current": "", "error": ""}


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
    if asset_file.suffix.lower() in VIDEO_EXTENSIONS:
        return "video"
    if asset_file.suffix.lower() in AUDIO_EXTENSIONS:
        return "audio"
    return "image"


# ---------------------------------------------------------------------------
# Civitai sources — list bookmarked models, resolve pasted URLs, and build
# recipes from resolved metadata or locally-cached LORAs (gallery lora cache).
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
    # Image page URLs carry the owning model in the query string (?model=<id>)
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
    """Return [{url, prompt}] for a version's example images, in order (per-image prompt)."""
    out = []
    for img in version.get("images") or []:
        if not isinstance(img, dict):
            continue
        u = img.get("url")
        if not (isinstance(u, str) and u.startswith("http")):
            continue
        meta = img.get("meta")
        prompt = ""
        if isinstance(meta, dict):
            prompt = str(meta.get("prompt") or "").strip()
        out.append({"url": u, "prompt": prompt})
    return out


_civitai_key_re = re.compile(r"[^\w\-]+")


def _civitai_bookmark_key(model_id, name: str) -> str:
    """Filesystem-safe subdir key for a bookmarked model (name-based, id fallback)."""
    n = _civitai_key_re.sub("_", str(name or "").strip()).strip("._ ")[:60]
    return n or f"model_{model_id}"


def _civitai_local_cover(model_id, name: str) -> str:
    """Local cover URL for a model whose examples are already cached (fast path)."""
    key = _civitai_bookmark_key(model_id, name)
    cdir = CIVITAI_BOOKMARK_DIR / key
    if not cdir.is_dir():
        return ""
    for p in sorted(cdir.iterdir()):
        if p.is_file() and p.suffix.lower() in IMG_EXTENSIONS:
            return f"/neo_gallery/image?filename={quote(p.name)}&subfolder=civitai_bookmarks/{quote(key)}"
    return ""


def _civitai_cover_from_model(model: dict) -> str:
    """Best-effort preview image URL from a Civitai model object (list item or detail)."""
    if not isinstance(model, dict):
        return ""
    imgs = model.get("images")
    if isinstance(imgs, list) and imgs and isinstance(imgs[0], dict):
        u = imgs[0].get("url")
        if isinstance(u, str) and u.startswith("http"):
            return u
    for ver in model.get("modelVersions") or []:
        if not isinstance(ver, dict):
            continue
        for img in ver.get("images") or []:
            u = img.get("url") if isinstance(img, dict) else None
            if isinstance(u, str) and u.startswith("http"):
                return u
    return ""


# 内存缓存：模型 id -> 预览图 URL（仅存字符串，重启后按需重新拉取）
_civitai_cover_cache: dict = {}


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


async def _download_bytes(session, url: str) -> bytes | None:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status != 200:
                return None
            return await resp.read()
    except Exception:
        return None


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
    # 保存时按加载节点类型记录的 kind 优先；后缀判定仅兜底手动放入的文件
    kinds = meta.get("kinds") or {}
    if not empty_dir:
        for f in assets_dir.iterdir():
            if f.is_file() and f.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                if f.stem.startswith("_cover") or f.stem.startswith("_preview"):
                    continue  # 元数据封面，不视为资源资产
                existing[f.name] = {"file": f.name, "kind": kinds.get(f.name) or _kind_of(f)}

    assets = []
    for name in ordered:
        if name in existing:
            assets.append(existing.pop(name))
    # 目录里存在但未在 recipe.json 记录的（用户手动放入）按目录顺序补尾
    assets.extend(existing.values())

    # 示例结果（samples/，随保存与侧边栏追加累积，用于封面与预览展示）
    samples_dir = recipe_dir / "samples"
    sample_kinds = meta.get("sample_kinds") or {}
    samples = []
    if samples_dir.exists():
        for f in sorted(samples_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                if f.stem.startswith("_cover") or f.stem.startswith("_preview"):
                    continue
                samples.append({"file": f.name, "kind": sample_kinds.get(f.name) or _kind_of(f)})

    cover = None
    for name in ("_preview.jpg", "_preview.png", "_cover.jpg", "_cover.png"):
        if (assets_dir / name).exists():
            cover = name
            break
    if cover is None:
        cover = next((s["file"] for s in samples if s["kind"] == "image"), None)
    if cover is None:
        cover = next((a["file"] for a in assets if a["kind"] == "image"), None)

    return {
        "name": recipe_dir.name,
        "source": source,
        "prompt": meta.get("prompt", ""),
        "created_at": meta.get("created_at", ""),
        "mtime": meta_path.stat().st_mtime,
        "asset_count": len(assets),
        "sample_count": len(samples),
        "cover": cover,
        "assets": assets,
        "loras": meta.get("loras", []) or [],
        "samples": samples,
    }


def _copy_ref_into_dir(ref: dict, dest_dir: Path) -> str | None:
    """Resolve a Comfy file ref {filename, subfolder, type} to its physical path and
    copy it into dest_dir. Deduplicates by content (size + md5) against files already
    in dest_dir; renames on filename collision. Returns the destination filename or None."""
    filename = str(ref.get("filename", "")).strip()
    if not filename or ".." in filename:
        return None

    import folder_paths as _folder_paths
    import hashlib

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

    source_size = source_path.stat().st_size
    source_md5 = hashlib.md5()
    with source_path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            source_md5.update(chunk)
    source_md5 = source_md5.hexdigest()

    if dest_dir.exists():
        for f in dest_dir.iterdir():
            if not f.is_file() or f.stat().st_size != source_size:
                continue
            h = hashlib.md5()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(8192), b""):
                    h.update(chunk)
            if h.hexdigest() == source_md5:
                return f.name

    dest = dest_dir / Path(filename).name
    if dest.exists():
        stem = Path(filename).stem
        ext = Path(filename).suffix
        counter = 1
        while (dest_dir / f"{stem}_{counter}{ext}").exists():
            counter += 1
        dest = dest_dir / f"{stem}_{counter}{ext}"

    shutil.copy2(source_path, dest)
    return dest.name


def _append_samples(recipe_dir: Path, refs: list) -> tuple[int, int]:
    """Append executed-output refs into the recipe's samples dir (content-deduped),
    merging into recipe.json. Returns (added, skipped)."""
    meta_path = recipe_dir / "recipe.json"
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        meta = {}

    samples = meta.get("samples", []) or []
    if isinstance(samples, str):
        samples = [samples]
    sample_kinds = meta.get("sample_kinds", {}) or {}

    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    added = 0
    skipped = 0
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        copied_name = _copy_ref_into_dir(ref, samples_dir)
        if not copied_name:
            continue
        if copied_name in samples:
            skipped += 1
            continue
        samples.append(copied_name)
        kind = str(ref.get("kind", "") or "")
        if kind in ("image", "video", "audio"):
            sample_kinds[copied_name] = kind
        added += 1

    meta["samples"] = samples
    meta["sample_kinds"] = sample_kinds
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return added, skipped


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

        # Assets passed as Comfy file refs {filename, subfolder, type, kind}; copy each in.
        # kind 由前端按加载节点类型判定（同一 mp4 既可作视频也可作音频），记录进
        # kinds 映射，扫描时优先使用；后缀判定仅作手动放文件时的兜底。
        copied = []
        kinds = {}
        for ref in data.get("assets", []) or []:
            if not isinstance(ref, dict):
                continue
            copied_name = _copy_ref_into_dir(ref, assets_dir)
            if copied_name:
                copied.append(copied_name)
                kind = str(ref.get("kind", "") or "")
                if kind in ("image", "video", "audio"):
                    kinds[copied_name] = kind

        # 重复保存同一配方时保留既有示例结果（samples 随保存/追加累积）
        old_samples = []
        old_sample_kinds = {}
        meta_path = recipe_dir / "recipe.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    old_meta = json.load(f)
                old_samples = old_meta.get("samples", []) or []
                old_sample_kinds = old_meta.get("sample_kinds", {}) or {}
            except Exception:
                pass

        # 记录当前工作流加载的 LoRA（名称 + 强度），随配方保存便于还原参考
        loras = []
        for lo in (data.get("loras") or []):
            if not isinstance(lo, dict):
                continue
            nm = str(lo.get("name", "") or "").strip()
            if not nm:
                continue
            try:
                st = float(lo.get("strength", 1.0))
            except (TypeError, ValueError):
                st = 1.0
            loras.append({"name": nm, "strength": st})

        recipe = {
            "name": name,
            "prompt": data.get("prompt", ""),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "assets": copied,
            "kinds": kinds,
            "loras": loras,
            "samples": old_samples,
            "sample_kinds": old_sample_kinds,
        }
        with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
            json.dump(recipe, f, ensure_ascii=False, indent=2)

        # 勾选「同时保存结果」时，本次执行的输出追加进 samples/（内容去重）
        sample_added = 0
        results_refs = [r for r in (data.get("results") or []) if isinstance(r, dict)]
        if results_refs:
            sample_added, _ = _append_samples(recipe_dir, results_refs)

        return web.json_response({"success": True, "name": name, "asset_count": len(copied), "sample_added": sample_added})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/rs_recipes/append_results")
async def rs_recipes_append_results(request):
    """把当前工作流最近一次执行的输出追加为配方示例结果（内容去重）。"""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        refs = [r for r in (data.get("results") or []) if isinstance(r, dict)]
        added, skipped = _append_samples(recipe_dir, refs)
        return web.json_response({"success": True, "added": added, "skipped": skipped})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/rs_recipes/delete_sample")
async def rs_recipes_delete_sample(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        file = str(data.get("file", ""))
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        if not file or ".." in file or "/" in file or "\\" in file:
            return web.json_response({"success": False, "error": "Invalid file"}, status=400)

        meta_path = recipe_dir / "recipe.json"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            return web.json_response({"success": False, "error": "Recipe meta unreadable"}, status=500)

        meta["samples"] = [s for s in (meta.get("samples", []) or []) if s != file]
        meta["sample_kinds"] = {k: v for k, v in (meta.get("sample_kinds", {}) or {}).items() if k != file}
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        target = recipe_dir / "samples" / file
        if target.is_file():
            target.unlink()
        return web.json_response({"success": True})
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

    dir_param = request.rel_url.query.get("dir", "")
    recipe_dir = _find_recipe_dir(recipe)
    asset_path = None
    if recipe_dir is not None:
        # dir=samples 读示例结果；未指定时先 assets 后 samples 兜底
        search_dirs = [recipe_dir / "samples"] if dir_param == "samples" else [recipe_dir / "assets", recipe_dir / "samples"]
        for base in search_dirs:
            candidate = base / file
            if candidate.is_file():
                asset_path = candidate
                break
    if asset_path is None:
        return web.Response(status=404)

    suffix = asset_path.suffix.lower()
    content_type = "image/png"
    if suffix in VIDEO_EXTENSIONS:
        content_type = "video/mp4"
    elif suffix in AUDIO_EXTENSIONS:
        content_type = mimetypes.guess_type(asset_path.name)[0] or "audio/mpeg"
    elif suffix in IMG_EXTENSIONS:
        content_type = mimetypes.guess_type(asset_path.name)[0] or "image/png"

    with open(asset_path, "rb") as f:
        return web.Response(body=f.read(), content_type=content_type)


@PromptServer.instance.routes.get("/rs_recipes/workflow")
async def rs_recipes_workflow(request):
    """Read the ComfyUI workflow/prompt embedded in a recipe sample's metadata."""
    recipe = request.rel_url.query.get("recipe", "")
    file = request.rel_url.query.get("file", "")
    if not recipe or not file or ".." in recipe or ".." in file or "/" in file or "\\" in file:
        return web.Response(status=400)
    recipe_dir = _find_recipe_dir(recipe)
    sample_path = recipe_dir / "samples" / file if recipe_dir else None
    if sample_path is None or not sample_path.is_file():
        return web.Response(status=404)

    raw = _extract_media_metadata(sample_path)
    for key in ("prompt", "workflow"):
        val = raw.get(key)
        if isinstance(val, str):
            try:
                raw[key] = json.loads(val)
            except ValueError:
                raw[key] = None
    prompt = raw.get("prompt")
    workflow = raw.get("workflow")
    return web.json_response(_json_safe({
        "has": bool(prompt or workflow),
        "workflow": workflow if isinstance(workflow, dict) else None,
        "prompt": prompt if isinstance(prompt, dict) else None,
    }))



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


def _normalize_loras(raw) -> list:
    """Coerce an untrusted loras payload into [{name, strength}] (strength default 1.0)."""
    out = []
    for lo in (raw or []):
        if not isinstance(lo, dict):
            continue
        nm = str(lo.get("name", "") or "").strip()
        if not nm:
            continue
        try:
            st = float(lo.get("strength", 1.0))
        except (TypeError, ValueError):
            st = 1.0
        out.append({"name": nm, "strength": st})
    return out


@PromptServer.instance.routes.post("/rs_recipes/civitai_bookmarks")
async def rs_recipes_civitai_bookmarks(request):
    """List the user's bookmarked Civitai models (requires a configured API key)."""
    api_key = str(_load_settings().get("civitai_api_key") or "").strip()
    if not api_key:
        return web.json_response({"success": False, "needs_api_key": True,
                                  "error": "未配置 Civitai API KEY"}, status=400)
    try:
        data = await request.json()
    except Exception:
        data = {}
    page = int(data.get("page", 0) or 0)
    limit = 24
    async with aiohttp.ClientSession() as session:
        status, body = await _civitai_get(session, "/models", {
            "favorites": "true", "type": "Model", "limit": str(limit), "skip": str(page * limit),
        }, api_key)
    if status in (401, 403):
        return web.json_response({"success": False, "error": "Civitai API KEY 无效"}, status=401)
    if status != 200 or not isinstance(body, dict):
        return web.json_response({"success": False, "error": f"Civitai HTTP {status or 'error'}"}, status=502)
    items = []
    for it in body.get("items") or []:
        if not isinstance(it, dict):
            continue
        mid = it.get("id")
        mname = it.get("name") or ""
        items.append({
            "id": mid,
            "name": mname,
            "type": it.get("type") or "",
            "baseModel": it.get("baseModel") or "",
            "nsfw": bool(it.get("nsfw")),
            "cover": _civitai_local_cover(mid, mname) or _civitai_cover_from_model(it),
        })
    return web.json_response({"success": True, "items": items, "page": page,
                              "has_more": len(items) >= limit})


@PromptServer.instance.routes.post("/rs_recipes/civitai_model_cover")
async def rs_recipes_civitai_model_cover(request):
    """Return a preview image URL for one Civitai model (cached in memory), used as the
    lazy-loaded gallery cover for a bookmarked model card."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    model_id = data.get("id")
    if not model_id:
        return web.json_response({"success": False, "error": "缺少模型 id"}, status=400)
    api_key = str(_load_settings().get("civitai_api_key") or "").strip()
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


@PromptServer.instance.routes.post("/rs_recipes/civitai_resolve")
async def rs_recipes_civitai_resolve(request):
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
    api_key = str(_load_settings().get("civitai_api_key") or "").strip()
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


@PromptServer.instance.routes.post("/rs_recipes/civitai_bookmark_media")
async def rs_recipes_civitai_bookmark_media(request):
    """Cache a bookmarked model's example images (+ per-image prompt .txt) locally,
    mirroring the Lora cache, so the standard gallery grid + lightbox can browse them
    and send-image / send-prompt work on real files."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    model_id = data.get("id")
    if not model_id:
        return web.json_response({"success": False, "error": "缺少模型 id"}, status=400)
    api_key = str(_load_settings().get("civitai_api_key") or "").strip()
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

    # Fast path: example images already cached locally (prefer the local copy).
    if meta_path.is_file() and any(p.is_file() and p.suffix.lower() in IMG_EXTENSIONS for p in cache_dir.iterdir()):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = {}
        files = sorted(p.name for p in cache_dir.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXTENSIONS)
        return web.json_response({
            "success": True,
            "model_key": key,
            "subfolder": subfolder,
            "prompt": str(meta.get("prompt") or ""),
            "images": [{"filename": fn, "subfolder": subfolder} for fn in files],
        })

    # Slow path: fetch version detail and download example images (+ prompt .txt).
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
    examples = _civitai_example_images(version)[:12]
    prompt = next((ex["prompt"] for ex in examples if ex["prompt"]), "")

    cache_dir.mkdir(parents=True, exist_ok=True)
    # Clear stale samples from a previous partial run (keep meta.json).
    for stale in cache_dir.iterdir():
        if stale.is_file() and stale.name.startswith("sample_"):
            stale.unlink()

    images = []
    _bookmark_cache_state.update({"running": True, "total": len(examples), "done": 0, "current": "", "error": ""})
    try:
        async with aiohttp.ClientSession() as session:
            for ex in examples:
                if len(images) >= 8:
                    break
                _bookmark_cache_state["current"] = (ex["url"].rsplit("/", 1)[-1] or "")[:60]
                blob = await _download_bytes(session, ex["url"])
                _bookmark_cache_state["done"] += 1
                if not blob:
                    continue
                ext = _media_ext_from_url_or_bytes(ex["url"], blob)
                if ext not in IMG_EXTENSIONS:
                    continue
                stem = f"sample_{len(images):02d}"
                (cache_dir / f"{stem}{ext}").write_bytes(blob)
                if ex["prompt"]:
                    (cache_dir / f"{stem}.txt").write_text(ex["prompt"], encoding="utf-8")
                images.append({"filename": f"{stem}{ext}", "subfolder": subfolder})
    finally:
        _bookmark_cache_state.update({"running": False, "current": ""})

    if not images:
        _bookmark_cache_state["error"] = "No downloadable sample images"

    if images:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"prompt": prompt}, f, ensure_ascii=False)

    return web.json_response({
        "success": True,
        "model_key": key,
        "subfolder": subfolder,
        "prompt": prompt,
        "images": images,
    })


@PromptServer.instance.routes.get("/rs_recipes/civitai_bookmark_status")
async def rs_recipes_civitai_bookmark_status(request):
    return web.json_response(dict(_bookmark_cache_state))


@PromptServer.instance.routes.post("/rs_recipes/save_from_civitai")
async def rs_recipes_save_from_civitai(request):
    """Create a user recipe from resolved Civitai metadata, downloading example media."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)

    name = _sanitize_name_re.sub("_", str(data.get("name") or "").strip())[:60]
    if not name:
        name = f"civitai_{int(datetime.datetime.now().timestamp())}"
    prompt = str(data.get("prompt") or "")
    images = data.get("images") or []
    if isinstance(images, str):
        images = [images]
    loras = _normalize_loras(data.get("loras"))

    recipe_dir = CUSTOM_DIR / name
    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    # 下载示例图到 samples/（作为配方封面与预览）
    samples = []
    sample_kinds = {}
    async with aiohttp.ClientSession() as session:
        for url in images[:8]:
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            blob = await _download_bytes(session, url)
            if not blob:
                continue
            target = samples_dir / (f"sample_{len(samples):02d}" + _media_ext_from_url_or_bytes(url, blob))
            with open(target, "wb") as f:
                f.write(blob)
            samples.append(target.name)
            sample_kinds[target.name] = _kind_of(target)

    recipe = {
        "name": name,
        "prompt": prompt,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "assets": [],
        "kinds": {},
        "loras": loras,
        "samples": samples,
        "sample_kinds": sample_kinds,
        "source": "civitai",
        "civitai_model_id": data.get("model_id"),
    }
    with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
        json.dump(recipe, f, indent=2)
    return web.json_response({"success": True, "name": name, "samples": samples})


@PromptServer.instance.routes.get("/rs_recipes/cached_loras")
async def rs_recipes_cached_loras(request):
    """List locally-cached Civitai LORAs (gallery lora cache) usable as recipe sources."""
    index = _load_lora_index()
    items = []
    for rel, info in index.items():
        if not isinstance(info, dict) or info.get("status") != "ok" or not info.get("cache_dir"):
            continue
        cache_dir = info["cache_dir"]
        preview = None
        cdir = LORA_CACHE_DIR.joinpath(*cache_dir.split("/"))
        if cdir.is_dir():
            for p in sorted(cdir.iterdir()):
                if p.is_file() and p.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
                    preview = {"filename": p.name, "subfolder": f"Lora/{cache_dir}"}
                    break
        items.append({
            "lora_rel": rel,
            "model_name": info.get("model_name") or "",
            "version_name": info.get("version_name") or "",
            "images": int(info.get("images") or 0),
            "preview": preview,
        })
    return web.json_response({"success": True, "items": items})


@PromptServer.instance.routes.post("/rs_recipes/save_from_cached_lora")
async def rs_recipes_save_from_cached_lora(request):
    """Create a user recipe from a locally-cached Civitai LORA (media + prompt from cache)."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    lora_rel = str(data.get("lora_rel") or "").strip()
    info = _load_lora_index().get(lora_rel)
    if not isinstance(info, dict) or info.get("status") != "ok" or not info.get("cache_dir"):
        return web.json_response({"success": False, "error": "该 LORA 无缓存数据"}, status=404)

    cdir = LORA_CACHE_DIR.joinpath(*info["cache_dir"].split("/"))
    if not cdir.is_dir():
        return web.json_response({"success": False, "error": "缓存目录不存在"}, status=404)

    model_name = info.get("model_name") or Path(lora_rel).stem
    name = _sanitize_name_re.sub("_", str(data.get("name") or model_name).strip())[:60]
    if not name:
        name = f"lora_{int(datetime.datetime.now().timestamp())}"
    recipe_dir = CUSTOM_DIR / name
    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    # 复制缓存示例图到 samples/，并读取首个示例的提示词
    prompt = ""
    samples = []
    sample_kinds = {}
    for p in sorted(cdir.iterdir()):
        if not p.is_file() or p.suffix.lower() not in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
            continue
        if len(samples) >= 8:
            break
        dest = samples_dir / p.name
        shutil.copy2(p, dest)
        samples.append(dest.name)
        sample_kinds[dest.name] = _kind_of(dest)
        if not prompt:
            txt = p.with_suffix(".txt")
            if txt.is_file():
                try:
                    prompt = txt.read_text(encoding="utf-8").strip()
                except Exception:
                    pass

    recipe = {
        "name": name,
        "prompt": prompt,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "assets": [],
        "kinds": {},
        "loras": [{"name": Path(lora_rel).stem, "strength": 1.0}],
        "samples": samples,
        "sample_kinds": sample_kinds,
        "source": "civitai",
    }
    with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
        json.dump(recipe, f, indent=2)
    return web.json_response({"success": True, "name": name, "samples": samples})