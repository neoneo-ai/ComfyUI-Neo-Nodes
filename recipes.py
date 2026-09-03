# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — Video Recipe Module
# A recipe = a named combination: prompt text + ordered assets (images/videos),
# stored in its own preset directory with an assets/ folder.
# 收藏（本地/C 站）后端逻辑已统一收敛到 bookmark.py，本模块只保留配方职责。

import re
import json
import shutil
import datetime
import mimetypes
from pathlib import Path
import aiohttp
from aiohttp import web
from server import PromptServer

from .gallery import (
    AUDIO_EXTENSIONS,
    IMG_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _copy_media_to_input,
)
from .bookmark import (
    _download_bytes,
    _media_ext_from_url_or_bytes,
)
from .gallery_lora import LORA_CACHE_DIR, _load_lora_index
from .util import _extract_media_metadata, _json_safe

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
    if asset_file.suffix.lower() in VIDEO_EXTENSIONS:
        return "video"
    if asset_file.suffix.lower() in AUDIO_EXTENSIONS:
        return "audio"
    return "image"


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