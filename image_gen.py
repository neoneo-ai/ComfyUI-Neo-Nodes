# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 内置 Krea2 出图（文生图 / 参考图四视图）
# API prompt 通过内部 HTTP API 压进执行队列，复用 ComfyUI 的排队、显存生命周期与
# 取消行为；任务状态由 _watch 协程按变化经 rs.image_gen.status 事件推给前端。
# 输出落在 output 目录的 <前缀>/<日期>/<slug> 下并写同名 .txt（提示词），
# Gallery 可直接浏览、搜索并把图发送回工作流节点。
# 参考图模式走内置 krea2_edit 路径（krea2_edit.py，vendor 自 comfyui-krea2edit）：
# 源 latent frame=1 + 目标空 latent frame=0，denoise 恒为 1.0，四视图 LoRA 自动追加。

from __future__ import annotations

import asyncio
import base64
import difflib
import hashlib
import json
import logging
import os
import random
import re
import shutil
import time
import uuid
from urllib.parse import quote, unquote

import aiohttp
from aiohttp import web
import folder_paths
from comfy.cli_args import args as cli_args
from comfy_execution.progress import get_progress_state
from server import PromptServer

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIGS_DIR = os.path.join(CURRENT_DIR, "configs")
SETTINGS_FILE = os.path.join(CONFIGS_DIR, "image_gen.json")

MAX_IMAGES = 8        # 单次请求最多张数（批量共用一个 base seed）
TASK_TTL = 3600       # 任务记录保留时长（秒）
MAX_TASKS = 32        # 任务记录上限

# 独立 client_id：出图任务的进度事件不混进前端 UI 的节点高亮
CLIENT_ID = str(uuid.uuid4())
# 任务快照推送事件：_watch 按变化 send_sync 给所有客户端，前端 watchTask 按 task_id 过滤
STATUS_EVENT = "rs.image_gen.status"

DEFAULT_SETTINGS = {
    "model": "",              # diffusion_models 相对名；空 = 自动挑选 Krea2 模型
    "text_encoder": "",       # text_encoders 相对名
    "vae": "",                # vae 相对名
    "clip_type": "krea2",
    "loras": [],              # [{name, strength, ref_only}]，LoraLoaderModelOnly；ref_only=true 仅参考图模式加载（四视图 LoRA 即勾此项者）
    "steps": 8,
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "base_resolution": 1280,  # 按比例算尺寸时的长边
    "default_ratio": "1:1",
    "count": 1,               # 单次出图张数（1-8，参考图模式强制为 1）
    "output_prefix": "NeoAgent",
}

# 自动挑选默认模型时的名称线索（按优先级）
_MODEL_HINTS = {
    "diffusion_models": ("krea2", "krea"),
    # Krea2 只吃 Qwen3-VL-4B（CLIPLoader type krea2 → TEModel.QWEN3VL_4B，12 层 tap×2560）；
    # 挑到 8B/32B 会在执行期报 conditioning 维度错误，因此只精确匹配 4b，不做宽泛兜底
    "text_encoders": ("qwen3vl_4b", "qwen3_vl_4b", "qwen_3_vl_4b", "qwen3-vl-4b"),
    # Krea2 沿用 Qwen-Image 的 VAE；社区 Krea2-* VAE 只在缺官方文件时兜底
    "vae": ("qwen_image", "krea2"),
}

# 四视图 LoRA 名称线索（参考图模式必需，缺失时报错不降级）
_QUADVIEW_HINTS = ("quadview", "四视图")

# 参考图模式固定结构指令（对齐 Krea2 四视图工作流的默认 prompt）：角色板布局由该指令 +
# 四视图 LoRA 提供，人物身份来自参考图；skill 正文的人物描述若填写会追加在指令之后
FOUR_VIEW_PREFIX = (
    "Convert the character in the image to a Character Sheet showing a face close-up, "
    "front full body, side full body and back full body views. "
)

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


# ===========================================================================
# 设置
# ===========================================================================

def get_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                settings.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
    except Exception as e:
        logger.warning(f"[NeoNodes] image_gen settings ignored ({e}); using defaults")
    return settings


def save_settings(patch: dict) -> dict:
    settings = get_settings()
    for key, value in (patch or {}).items():
        if key in DEFAULT_SETTINGS:
            settings[key] = value
    os.makedirs(CONFIGS_DIR, exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_FILE)
    return settings


# ===========================================================================
# 模型扫描 / 解析
# ===========================================================================

def _folder_files(folder: str) -> list:
    try:
        return sorted(folder_paths.get_filename_list(folder) or [])
    except Exception as e:
        logger.warning(f"[NeoNodes] image_gen: scan {folder} failed: {e}")
        return []


def suggest_model(folder: str) -> str:
    """按名称线索挑一个默认模型（turbo 优先、短名优先）；无命中返回空串。"""
    files = _folder_files(folder)
    if not files:
        return ""
    for hint in _MODEL_HINTS.get(folder, ()):
        matches = [f for f in files if hint in f.lower()]
        if matches:
            matches.sort(key=lambda f: (("turbo" not in f.lower()), len(f)))
            return matches[0]
    return ""


def _first_quadview(files: list) -> str:
    """按名称线索挑第一个四视图 LoRA（与参考图模式自动挑选一致）；无命中返回空串。"""
    for hint in _QUADVIEW_HINTS:
        matches = [f for f in files if hint in f.lower()]
        if matches:
            return matches[0]
    return ""


def resolve_model(folder: str, wanted: str) -> tuple:
    """把设置里的模型名解析成 folder_paths 可用的相对名。

    返回 (resolved, error)：wanted 为空时自动挑选；找不到时给出候选名。
    """
    files = _folder_files(folder)
    if not files:
        return "", f"{folder} 目录里没有模型文件，请先放入模型"
    wanted = str(wanted or "").strip()
    if not wanted:
        suggested = suggest_model(folder)
        if suggested:
            return suggested, ""
        return "", f"{folder} 里没有找到可用的默认模型，请在设置中手动选择"
    variants = (wanted, wanted.replace("\\", "/"), wanted.replace("/", "\\"))
    for variant in variants:
        if variant in files:
            return variant, ""
    lowered = {f.lower(): f for f in files}
    for variant in variants:
        hit = lowered.get(variant.lower())
        if hit:
            return hit, ""
    candidates = difflib.get_close_matches(wanted, files, n=3, cutoff=0.4)
    hint = "；候选: " + ", ".join(candidates) if candidates else ""
    return "", f"找不到模型 {wanted}（{folder}）{hint}"


def _display_sort(files: list) -> list:
    """下拉展示排序：krea2 相关靠前，其余按名称（不区分大小写）。"""
    return sorted(files, key=lambda f: ("krea2" not in f.lower(), f.lower()))


def scan_models() -> dict:
    """列出可选模型与自动挑选结果，供前端设置面板展示。"""
    out = {}
    for folder in ("diffusion_models", "text_encoders", "vae", "loras"):
        files = _folder_files(folder)
        out[folder] = _display_sort(files)
        if folder == "loras":
            out["suggested_lora"] = _first_quadview(files)
        else:
            out["suggested_" + folder] = suggest_model(folder)
    return out


# ===========================================================================
# 尺寸工具
# ===========================================================================

_RATIO_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$", re.I)


def parse_ratio(ratio) -> float | None:
    """解析 "16:9" / "16x9" / "1.78" 之类的比例，非法返回 None。"""
    if ratio is None:
        return None
    text = str(ratio).strip()
    if not text:
        return None
    m = _RATIO_RE.match(text)
    if m:
        w, h = float(m.group(1)), float(m.group(2))
        return (w / h) if w > 0 and h > 0 else None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value > 0 else None


def _round_multiple(value: float, multiple: int = 16) -> int:
    return max(multiple, int(value / multiple + 0.5) * multiple)


def size_from_ratio(ratio_value: float, base_resolution: int) -> tuple:
    """按比例算出长边为 base_resolution 的宽高（对齐到 16）。"""
    long_side = max(256, int(base_resolution))
    if ratio_value >= 1.0:
        return _round_multiple(long_side), _round_multiple(long_side / ratio_value)
    return _round_multiple(long_side * ratio_value), _round_multiple(long_side)


def resolve_dimensions(settings: dict, *, ratio=None, width=0, height=0) -> tuple:
    """宽高优先级：显式宽高 > 显式比例 > 设置默认比例。"""
    try:
        w, h = int(width or 0), int(height or 0)
    except (TypeError, ValueError):
        w = h = 0
    if w > 0 and h > 0:
        return _round_multiple(w), _round_multiple(h)
    base = settings.get("base_resolution") or DEFAULT_SETTINGS["base_resolution"]
    value = parse_ratio(ratio)
    if value:
        return size_from_ratio(value, base)
    value = parse_ratio(settings.get("default_ratio")) or 1.0
    return size_from_ratio(value, base)


# ===========================================================================
# 输出路径 / 参考图
# ===========================================================================

def safe_prefix(prefix: str) -> str:
    """清洗输出前缀（可含子目录）：拒绝上跳，逐段消毒非法字符。"""
    text = str(prefix or "").strip().replace("\\", "/")
    parts = []
    for raw in text.split("/"):
        if raw.strip() == "..":
            raise ValueError(f"非法输出路径: {prefix}")
        part = re.sub(r'[<>:"|?*\x00-\x1f]', "", raw).strip(" .")
        if not part or part == ".":
            continue
        parts.append(part)
    return "/".join(parts)


def slug_from_text(text: str, limit: int = 40) -> str:
    """从提示词取 ASCII slug（用作输出子目录名）；无可用字符返回空串。"""
    words = re.findall(r"[A-Za-z0-9]+", str(text or ""))
    slug = "_".join(words[:6]).lower()
    return slug[:limit].strip("_")


def _within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _split_tagged(value: str) -> tuple:
    """拆掉 LoadImage widget 值末尾的 [input]/[output] 标注。"""
    stem, tag = str(value or "").strip(), ""
    if stem.endswith("]") and "[" in stem:
        stem, _, tag = stem[:-1].rpartition("[")
    return stem.replace("\\", "/"), tag


def _reference_size(ref_name: str) -> tuple | None:
    """读参考图像素尺寸（等比适配计算用）；失败返回 None。"""
    try:
        from PIL import Image
        path = os.path.join(folder_paths.get_input_directory(), *ref_name.split("/"))
        with Image.open(path) as img:
            return img.size  # (w, h)
    except Exception as e:
        logger.warning(f"[NeoNodes] image_gen: read reference size failed ({ref_name}): {e}")
        return None


def _reference_name(src: dict) -> str | None:
    """把参考图落到 input 目录，返回 LoadImage 可用的相对名；无法解析返回 None。"""
    if not isinstance(src, dict):
        return None
    input_dir = os.path.realpath(folder_paths.get_input_directory())
    kind = src.get("kind", "input")

    if kind == "input":
        stem, tag = _split_tagged(src.get("value", ""))
        if not stem or ".." in stem.split("/"):
            return None
        if os.path.splitext(stem)[1].lower() not in _IMAGE_SUFFIXES:
            return None
        base = input_dir if tag != "output" else os.path.realpath(folder_paths.get_output_directory())
        real = os.path.realpath(os.path.join(base, *stem.split("/")))
        if not _within(real, base) or not os.path.isfile(real):
            logger.warning(f"[NeoNodes] image_gen: reference image not found: {src.get('value')}")
            return None
        if tag != "output":
            return stem
        # output 里的图 LoadImage 看不到，复制进 input 目录再用
        dest_dir = os.path.join(input_dir, "NeoAgent")
        os.makedirs(dest_dir, exist_ok=True)
        root, ext = os.path.splitext(os.path.basename(real))
        name = f"{root}_{time.strftime('%Y%m%d-%H%M%S')}{ext}"
        shutil.copy2(real, os.path.join(dest_dir, name))
        return f"NeoAgent/{name}"

    if kind == "data":
        data_uri = str(src.get("data", ""))
        if "," not in data_uri:
            return None
        try:
            raw = base64.b64decode(data_uri.split(",", 1)[1])
        except Exception as e:
            logger.warning(f"[NeoNodes] image_gen: bad base64 reference: {e}")
            return None
        dest_dir = os.path.join(input_dir, "NeoAgent")
        os.makedirs(dest_dir, exist_ok=True)
        digest = hashlib.sha1(raw).hexdigest()[:12]
        with open(os.path.join(dest_dir, f"ref_{digest}.png"), "wb") as f:
            f.write(raw)
        return f"NeoAgent/ref_{digest}.png"

    return None


# ===========================================================================
# 请求参数解析（设置 + 单次覆盖 + 模型解析 + 参考图落盘）
# ===========================================================================

_OVERRIDE_KEYS = ("model", "text_encoder", "vae", "clip_type", "loras", "steps", "cfg",
                  "sampler", "scheduler", "base_resolution",
                  "default_ratio", "output_prefix")


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _resolve_loras(settings: dict) -> tuple:
    """解析设置里的 LoRA 列表，返回 ([{name, strength, ref_only}], warnings)。"""
    entries = settings.get("loras") or []
    if not isinstance(entries, list):
        return [], ["loras 配置不是列表，已忽略"]
    resolved = []
    warnings = []
    for entry in entries:
        if isinstance(entry, str):
            name, strength, ref_only = entry, 1.0, False
        elif isinstance(entry, dict):
            name = str(entry.get("name", "")).strip()
            strength = _float(entry.get("strength"), 1.0)
            ref_only = bool(entry.get("ref_only", False))
        else:
            continue
        if not name:
            continue
        hit, err = resolve_model("loras", name)
        if err:
            warnings.append(err)
            continue
        resolved.append({"name": hit, "strength": min(10.0, max(-10.0, strength)), "ref_only": ref_only})
    return resolved, warnings


def _quadview_lora(user_loras: list) -> tuple:
    """参考图模式必需的 Krea2 四视图 LoRA。

    用户在 LoRA 列表里配了名称含线索的则沿用（强度不变，返回 (entry, True)）；否则按
    名称线索扫描 loras 目录并追加到链尾（返回 (entry, False)）。找不到时抛 ValueError ——
    没有该 LoRA 只会退化成普通重绘，不如明确报错。勾了「依赖参考图」的 LoRA 由
    resolve_request 直接沿用，不会走到这里。
    """
    for entry in user_loras:
        if any(hint in str(entry.get("name", "")).lower() or hint in str(entry.get("name", ""))
               for hint in _QUADVIEW_HINTS):
            return dict(entry), True
    name = _first_quadview(_folder_files("loras"))
    if name:
        return {"name": name, "strength": 1.0}, False
    raise ValueError(
        "缺少 Krea2 四视图 LoRA：请在出图设置的 LoRA 列表里添加它并勾选「依赖参考图」，"
        "或在 models/loras 放一个文件名含 quadview / 四视图 的 LoRA（如 Krea2-QuadView_*.safetensors）后重试")


def resolve_request(body: dict, settings: dict | None = None) -> dict:
    """把一次出图请求解析成出图参数；非法时抛 ValueError（消息可直接回前端）。"""
    body = body if isinstance(body, dict) else {}
    settings = settings or get_settings()
    merged = dict(settings)
    for key in _OVERRIDE_KEYS:
        if body.get(key) is not None:
            merged[key] = body[key]

    prompt_text = str(body.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("提示词为空")

    model, err = resolve_model("diffusion_models", merged.get("model"))
    if err:
        raise ValueError(err)
    encoder, err = resolve_model("text_encoders", merged.get("text_encoder"))
    if err:
        raise ValueError(err)
    vae, err = resolve_model("vae", merged.get("vae"))
    if err:
        raise ValueError(err)

    warnings = []
    loras, lora_warns = _resolve_loras(merged)
    warnings.extend(lora_warns)

    refs = body.get("references")
    refs = refs if isinstance(refs, list) else ([refs] if refs else [])
    names = []
    for src in refs:
        name = _reference_name(src)
        if name and name not in names:
            names.append(name)
    if refs and not names:
        raise ValueError("参考图无法读取，请确认图片仍然存在")
    ref_name = names[0] if names else None
    if len(names) > 1:
        warnings.append("四视图只使用第一张参考图")

    # 参考图模式：固定结构指令前缀 + 用户描述。四视图 LoRA 必需 —— 优先用用户在 LoRA
    # 列表里勾了「依赖参考图」的（直接沿用，不追加）；没有则按名称线索自动挑选/追加，
    # 仍找不到才报错。文生图模式跳过 ref_only 的 LoRA（它们只在有参考图时才有意义）。
    prompt_text = FOUR_VIEW_PREFIX + prompt_text if ref_name else prompt_text
    if ref_name:
        if not any(l.get("ref_only") for l in loras):
            quadview, already = _quadview_lora(loras)
            if not already:
                loras.append(quadview)
    else:
        loras = [l for l in loras if not l.get("ref_only")]

    count = max(1, min(MAX_IMAGES, _int(body.get("count"), _int(merged.get("count"), 1))))
    if ref_name and count > 1:
        count = 1
        warnings.append("四视图模式每次只出一张")

    width = _int(body.get("width"), 0)
    height = _int(body.get("height"), 0)
    if ref_name:
        # 四视图角色板固定 16:9 横版（出图 skill 约定），不读取参考图比例；显式宽高也被忽略
        base = merged.get("base_resolution") or DEFAULT_SETTINGS["base_resolution"]
        width, height = size_from_ratio(16.0 / 9.0, base)
        # 参考图长边限到 1024px（VAE encode + Qwen3-VL 接地的输入尺度）；
        # 剩余 AR 适配由 Krea2EditModelPatch 的 fit_mode=fit 在像素空间完成
        src_size = _reference_size(ref_name)
        if src_size and min(src_size) > 0:
            scale = 1024 / max(src_size)
            ref_scale = (max(8, int(src_size[0] * scale + 0.5)) // 8 * 8,
                         max(8, int(src_size[1] * scale + 0.5)) // 8 * 8)
        else:
            ref_scale = (1024, 1024)
    else:
        width, height = resolve_dimensions(
            merged, ratio=body.get("ratio"), width=width, height=height)

    seed = body.get("seed")
    seed = random.randint(0, 2**63 - 1) if seed is None else max(0, _int(seed, 0))

    prefix = safe_prefix(merged.get("output_prefix") or DEFAULT_SETTINGS["output_prefix"])
    if not prefix:
        prefix = DEFAULT_SETTINGS["output_prefix"]
    slug = slug_from_text(prompt_text)
    prefix = f"{prefix}/{time.strftime('%Y-%m-%d')}"
    if slug:
        prefix = f"{prefix}/{slug}"

    return {
        "prompt": prompt_text,
        "negative": str(body.get("negative") or "").strip(),
        "model": model,
        "text_encoder": encoder,
        "vae": vae,
        "clip_type": str(merged.get("clip_type") or DEFAULT_SETTINGS["clip_type"]),
        "loras": loras,
        "steps": max(1, min(200, _int(merged.get("steps"), DEFAULT_SETTINGS["steps"]))),
        "cfg": max(0.0, _float(merged.get("cfg"), DEFAULT_SETTINGS["cfg"])),
        "sampler": str(merged.get("sampler") or DEFAULT_SETTINGS["sampler"]),
        "scheduler": str(merged.get("scheduler") or DEFAULT_SETTINGS["scheduler"]),
        "seed": seed,
        "count": count,
        "width": width,
        "height": height,
        "denoise": 1.0,
        "ref_name": ref_name,
        "ref_scale": ref_scale if ref_name else None,
        "prefix": prefix,
        "warnings": warnings,
    }


# ===========================================================================
# 工作流构建（API prompt 格式，全部核心节点）
# ===========================================================================

def build_graph(params: dict) -> dict:
    """文本生成 / 参考图四视图共用的 Krea2 图：加载 → 编码 → 采样 → 解码 → 保存。

    参考图模式（krea2_edit 路径）：源 latent 作为 frame=1 clean token、目标空 latent
    作 frame=0，denoise 恒为 1.0；语义侧用 Krea2EditGroundedEncode 把指令与同一张
    参考图一起过 Qwen3-VL（negative 为空指令的 grounded encode）。
    """
    graph = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": params["model"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": params["text_encoder"], "type": params["clip_type"],
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": params["vae"]}},
    }

    model_src = ("1", 0)
    for offset, lora in enumerate(params.get("loras") or []):
        node = str(20 + offset)
        graph[node] = {"class_type": "LoraLoaderModelOnly",
                       "inputs": {"model": model_src, "lora_name": lora["name"],
                                  "strength_model": lora["strength"]}}
        model_src = (node, 0)

    if params.get("ref_name"):
        scale_w, scale_h = params.get("ref_scale") or (1024, 1024)
        graph["6"] = {"class_type": "LoadImage", "inputs": {"image": params["ref_name"]}}
        graph["7"] = {"class_type": "ImageScale",
                      "inputs": {"image": ("6", 0), "upscale_method": "lanczos",
                                 "width": scale_w, "height": scale_h, "crop": "disabled"}}
        graph["8"] = {"class_type": "VAEEncode",
                      "inputs": {"pixels": ("7", 0), "vae": ("3", 0)}}
        # positive/negative 都接地到同一张已缩放的参考图（与 VAE/patch 同源）：
        # positive 用 native 分辨率读指令、negative 空指令限 768，对齐 Krea2 四视图工作流
        graph["4"] = {"class_type": "Krea2EditGroundedEncode",
                      "inputs": {"clip": ("2", 0), "prompt": params["prompt"],
                                 "image": ("7", 0), "grounding_px": 0}}
        graph["5"] = {"class_type": "Krea2EditGroundedEncode",
                      "inputs": {"clip": ("2", 0), "prompt": "",
                                 "image": ("7", 0), "grounding_px": 768}}
        # target_latent 与 KSampler.latent_image 共用同一个空 latent：
        # 让源图在采样开始前就完成 VAE encode，避免采样中途挤掉扩散模型
        graph["9"] = {"class_type": "EmptySD3LatentImage",
                      "inputs": {"width": params["width"], "height": params["height"],
                                 "batch_size": 1}}
        graph["14"] = {"class_type": "Krea2EditModelPatch",
                       "inputs": {"model": model_src, "source_latent": ("8", 0),
                                  "fit_mode": "fit", "vae": ("3", 0),
                                  "source_image": ("7", 0), "target_latent": ("9", 0)}}
        model_src = ("14", 0)
        latent_src = ("9", 0)
    else:
        graph["4"] = {"class_type": "CLIPTextEncode",
                      "inputs": {"clip": ("2", 0), "text": params["prompt"]}}
        graph["5"] = {"class_type": "CLIPTextEncode",
                      "inputs": {"clip": ("2", 0), "text": params["negative"]}}
        graph["9"] = {"class_type": "EmptyLatentImage",
                      "inputs": {"width": params["width"], "height": params["height"],
                                 "batch_size": params["count"]}}
        latent_src = ("9", 0)

    graph["10"] = {"class_type": "KSampler",
                  "inputs": {"model": model_src, "seed": params["seed"], "steps": params["steps"],
                             "cfg": params["cfg"], "sampler_name": params["sampler"],
                             "scheduler": params["scheduler"], "positive": ("4", 0),
                             "negative": ("5", 0), "latent_image": latent_src,
                             "denoise": params["denoise"]}}
    graph["11"] = {"class_type": "VAEDecode",
                   "inputs": {"samples": ("10", 0), "vae": ("3", 0)}}
    graph["12"] = {"class_type": "SaveImage",
                   "inputs": {"images": ("11", 0), "filename_prefix": params["prefix"]}}
    return graph


# ===========================================================================
# 队列提交 / 状态查询（复用 ComfyUI 排队、显存与取消行为）
# ===========================================================================

POLL_INTERVAL = 0.5   # 轮询间隔（秒）
TASK_TIMEOUT = 3600.0  # 单个任务最长等待（秒）


def _is_tls() -> bool:
    return bool(getattr(cli_args, "tls_keyfile", None) and getattr(cli_args, "tls_certfile", None))


def _api_url(path: str) -> str:
    hosts = [h for h in str(cli_args.listen or "").split(",") if h and h not in ("0.0.0.0", "::")]
    host = hosts[0] if hosts else "127.0.0.1"
    return f"{'https' if _is_tls() else 'http'}://{host}:{cli_args.port}{path}"


def _prompt_queue():
    return PromptServer.instance.prompt_queue


async def submit_graph(graph: dict) -> str:
    """把图压进执行队列，返回 prompt_id；校验失败时抛 ValueError。"""
    url = _api_url("/prompt")
    # TLS 模式下服务端多为自签证书，跳过校验（只是本机内部回环调用）
    connector = aiohttp.TCPConnector(ssl=False) if _is_tls() else None
    try:
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.post(url, json={"prompt": graph, "client_id": CLIENT_ID},
                                    timeout=aiohttp.ClientTimeout(total=30)) as resp:
                payload = await resp.json()
                if resp.status == 200:
                    return payload["prompt_id"]
    except (aiohttp.ClientError, KeyError, json.JSONDecodeError) as e:
        raise ValueError(f"出图队列不可用: {e}") from e
    error = payload.get("error") or {}
    if isinstance(error, dict):
        message = " ".join(str(x) for x in (error.get("message"), error.get("details")) if x)
    else:
        message = str(error)
    raise ValueError(message or "工作流校验失败")


def _lookup(prompt_id: str) -> tuple:
    """返回 (state, info)：state 为 queued/running/done，info 为 history 条目或 None。"""
    queue = _prompt_queue()
    history = queue.get_history(prompt_id=prompt_id) or {}
    item = history.get(prompt_id)
    if item is not None:
        return "done", item
    running, pending = queue.get_current_queue_volatile()
    for entry in running:
        if entry[1] == prompt_id:
            return "running", None
    for entry in pending:
        if entry[1] == prompt_id:
            return "queued", None
    return "unknown", None


def _progress_for(prompt_id: str):
    """采样节点步数进度 {value, max}；registry 不属于本 prompt 或无步数信息时返回 None。"""
    registry = get_progress_state()
    if getattr(registry, "prompt_id", "") != prompt_id:
        return None
    best_max = 0.0
    best_value = 0.0
    for entry in registry.nodes.values():
        mx = float(entry.get("max") or 0)
        if mx <= 1:
            continue
        if mx > best_max:
            best_max, best_value = mx, float(entry.get("value") or 0)
    if best_max <= 1:
        return None
    return {"value": int(best_value), "max": int(best_max)}


def _error_from_history(item: dict) -> tuple:
    """返回 (错误文本, 是否被取消)。"""
    status = item.get("status") or {}
    if status.get("completed"):
        return "", False
    for message in status.get("messages") or []:
        if not (isinstance(message, (list, tuple)) and len(message) == 2):
            continue
        event = message[0]
        data = message[1] if isinstance(message[1], dict) else {}
        if event == "execution_interrupted":
            return "任务已取消", True
        if event == "execution_error":
            text = str(data.get("exception_message") or "").strip()
            node = data.get("node_id")
            if text:
                return (f"{text}（节点 {node}/{data.get('node_type')}）" if node else text), False
    return "执行失败", False


def _collect_images(item: dict) -> list:
    """取 history 里 SaveImage 落盘的图片，附带 /view 访问地址。"""
    output_root = os.path.realpath(folder_paths.get_output_directory())
    results = []
    for outputs in (item.get("outputs") or {}).values():
        for entry in (outputs or {}).get("images", []):
            subfolder = str(entry.get("subfolder") or "")
            filename = str(entry.get("filename") or "")
            if not filename:
                continue
            real = os.path.realpath(os.path.join(output_root, *subfolder.split("/"), filename))
            if not _within(real, output_root) or not os.path.isfile(real):
                continue
            results.append({"path": real, "subfolder": subfolder, "filename": filename,
                            "url": (f"/view?filename={quote(filename)}"
                                    f"&subfolder={quote(subfolder)}&type=output")})
    return results


def _sidecar_path(image_path: str) -> str:
    return os.path.splitext(image_path)[0] + ".txt"


def write_sidecar(image_path: str, params: dict) -> None:
    """图片旁写同名 .txt：首行提示词、次行参数摘要（Gallery 直接读前两行）。"""
    path = _sidecar_path(image_path)
    if os.path.exists(path):
        return
    loras = ",".join(f"{l['name']}@{l['strength']}" for l in params.get("loras") or [])
    meta = (f"steps={params['steps']} cfg={params['cfg']} {params['sampler']}/"
            f"{params['scheduler']} seed={params['seed']} denoise={params['denoise']} "
            f"{params['width']}x{params['height']} model={params['model']}"
            + (f" loras={loras}" if loras else ""))
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{params['prompt']}\n{meta}\n")
    except OSError as e:
        logger.warning(f"[NeoNodes] image_gen: sidecar write failed: {e}")


# ===========================================================================
# 任务表（进程内，TTL 清理；只存小记录不存图）
# ===========================================================================

TASKS: dict = {}
_WATCHERS: dict = {}


def _public_image(entry: dict) -> dict:
    return {"filename": entry["filename"], "subfolder": entry["subfolder"], "url": entry["url"]}


def _snapshot(task: dict) -> dict:
    return {
        "task_id": task["task_id"],
        "prompt_id": task["prompt_id"],
        "status": task["status"],
        "created": task["created"],
        "updated": task["updated"],
        "prompt": task["params"]["prompt"],
        "mode": "redraw" if task["params"]["ref_name"] else "t2i",
        "width": task["params"]["width"],
        "height": task["params"]["height"],
        "model": task["params"]["model"],
        "seed": task["params"]["seed"],
        "images": [_public_image(e) for e in task["images"]],
        "progress": task.get("progress"),
        "error": task["error"],
        "warnings": task.get("warnings") or [],
    }


def _prune_tasks() -> None:
    now = time.time()
    for task_id, task in list(TASKS.items()):
        if task["status"] in ("queued", "running"):
            continue
        if now - task["updated"] > TASK_TTL:
            TASKS.pop(task_id, None)
    while len(TASKS) > MAX_TASKS:
        oldest = min((t for t in TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            break
        TASKS.pop(oldest["task_id"], None)


def _notify(task: dict) -> None:
    """任务快照有变化时经 WebSocket 推给所有客户端（前端按 task_id 过滤）。"""
    PromptServer.instance.send_sync(STATUS_EVENT, _snapshot(task))


def _finish(task: dict, status: str, images: list, error: str) -> None:
    task["status"] = status
    task["images"] = images
    task["error"] = error
    task["progress"] = None
    task["updated"] = time.time()
    _WATCHERS.pop(task["task_id"], None)
    if error:
        logger.warning(f"[NeoNodes] image_gen task {task['task_id']} failed: {error}")
    _notify(task)


async def _watch(task_id: str) -> None:
    prompt_id = TASKS[task_id]["prompt_id"]
    deadline = time.monotonic() + TASK_TIMEOUT
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        state, item = _lookup(prompt_id)
        if state == "done":
            error, cancelled = _error_from_history(item)
            images = _collect_images(item)
            for entry in images:
                write_sidecar(entry["path"], task["params"])
            status = "cancelled" if cancelled else ("failed" if error else "succeeded")
            _finish(task, status, images, error)
            return
        if state == "running":
            changed = task["status"] != "running"
            task["status"] = "running"
            prog = _progress_for(prompt_id)
            if prog is not None and task.get("progress") != prog:
                task["progress"] = prog
                changed = True
            task["updated"] = time.time()
            if changed:
                _notify(task)
        elif time.monotonic() > deadline:
            _finish(task, "failed", [], "等待出图超时，任务已不在队列中")
            return


async def start_generation(body: dict) -> dict:
    params = resolve_request(body)
    prompt_id = await submit_graph(build_graph(params))
    _prune_tasks()
    now = time.time()
    task = {
        "task_id": str(uuid.uuid4()),
        "prompt_id": prompt_id,
        "status": "queued",
        "created": now,
        "updated": now,
        "params": params,
        "images": [],
        "progress": None,
        "error": "",
        "warnings": list(params.get("warnings") or []),
    }
    TASKS[task["task_id"]] = task
    _WATCHERS[task["task_id"]] = asyncio.create_task(_watch(task["task_id"]))
    return _snapshot(task)


# ===========================================================================
# 路由
# ===========================================================================

routes = PromptServer.instance.routes


@routes.get("/neo_image_gen/settings")
async def get_settings_route(request):
    return web.json_response(get_settings())


@routes.post("/neo_image_gen/settings")
async def post_settings_route(request):
    try:
        patch = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    if not isinstance(patch, dict):
        return web.json_response({"error": "请求体不是对象"}, status=400)
    return web.json_response(save_settings(patch))


@routes.get("/neo_image_gen/models")
async def models_route(request):
    return web.json_response(scan_models())


@routes.post("/neo_image_gen/generate")
async def generate_route(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    try:
        return web.json_response(await start_generation(body))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"[NeoNodes] image_gen generate failed: {e}")
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/neo_image_gen/status/{task_id}")
async def status_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    return web.json_response(_snapshot(task))


@routes.get("/neo_image_gen/tasks")
async def tasks_route(request):
    _prune_tasks()
    tasks = sorted(TASKS.values(), key=lambda t: t["created"], reverse=True)[:MAX_TASKS]
    return web.json_response([_snapshot(t) for t in tasks])


@routes.post("/neo_image_gen/cancel/{task_id}")
async def cancel_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    prompt_id = task["prompt_id"]
    queue = _prompt_queue()
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == prompt_id)
    interrupted = queue.interrupt_if_running(prompt_id)
    task["status"] = "cancelled"
    task["updated"] = time.time()
    watcher = _WATCHERS.pop(task["task_id"], None)
    if watcher is not None:
        watcher.cancel()
    _notify(task)
    return web.json_response({"dequeued": dequeued, "interrupted": interrupted})

