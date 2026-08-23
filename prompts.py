# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Prompts

from __future__ import annotations

import os
import json
import asyncio
import datetime
import server
import torch
from aiohttp import web
import threading
import copy
import logging
from pathlib import Path
from server import PromptServer

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROMPTS_DIR = os.path.join(CURRENT_DIR, "prompts")
TAGS_FILE = os.path.join(PROMPTS_DIR, "_tags_index.json")
PRESETS_DIR = os.path.join(PROMPTS_DIR, "presets")
CUSTOM_DIR = os.path.join(PROMPTS_DIR, "custom")
PRESETS_TAGS_FILE = os.path.join(PRESETS_DIR, "_tags_index.json")
CUSTOM_TAGS_FILE = os.path.join(CUSTOM_DIR, "_tags_index.json")

# ==========================================
# Template Management (System Prompt Templates)
# ==========================================
TEMPLATES_DIR = os.path.join(CURRENT_DIR, "prompts", "templates")
TEMPLATE_PRESETS_DIR = os.path.join(TEMPLATES_DIR, "presets")
TEMPLATE_CUSTOM_DIR = os.path.join(TEMPLATES_DIR, "custom")

if not os.path.exists(PROMPTS_DIR):
    os.makedirs(PROMPTS_DIR)
if not os.path.exists(PRESETS_DIR):
    os.makedirs(PRESETS_DIR)
if not os.path.exists(CUSTOM_DIR):
    os.makedirs(CUSTOM_DIR)
if not os.path.exists(TEMPLATES_DIR):
    os.makedirs(TEMPLATES_DIR)
if not os.path.exists(TEMPLATE_PRESETS_DIR):
    os.makedirs(TEMPLATE_PRESETS_DIR)
if not os.path.exists(TEMPLATE_CUSTOM_DIR):
    os.makedirs(TEMPLATE_CUSTOM_DIR)

PENDING_PROMPTS = {}

_tags_lock = threading.Lock()
_templates_lock = threading.Lock()


# 内置预设模版数据
DEFAULT_TEMPLATES = [
    {
        "id": "general_enhance",
        "name": "\u901a\u7528\u589e\u5f3a",
        "source": "presets",
        "tags": ["\u589e\u5f3a", "\u666e\u901a"],
        "content": (
            "You are an expert AI image prompt engineer. Your task is to enhance and expand the user's prompt.\n\n"
            "Rules:\n"
            "- Expand brief descriptions into detailed, vivid prompts\n"
            "- Include details about: subject appearance, clothing, pose, expression, lighting, background, atmosphere, style, quality tags\n"
            "- Use comma-separated descriptive phrases in English\n"
            "- Maintain the user's original intent and style preference\n"
            "- Output ONLY the enhanced prompt text, nothing else\n"
        ),
    },
    {
        "id": "cyberpunk_style",
        "name": "\u8d5b\u535a\u6717\u98ce\u683c",
        "source": "presets",
        "tags": ["\u98ce\u683c", "\u79d1\u5e7b"],
        "content": (
            "You are a cyberpunk-style AI image prompt specialist. Transform the user's input into vivid cyberpunk-themed prompts.\n\n"
            "Rules:\n"
            "- Emphasize neon lights, rain-slicked streets, holographic displays, futuristic architecture\n"
            "- Include: dark alleyways, glowing signs, chrome implants, synthwave color palette (cyan, magenta, purple)\n"
            "- Add atmosphere: dystopian, high-tech low-life, foggy, dramatic shadows\n"
            "- Use comma-separated descriptive phrases in English\n"
            "- Output ONLY the enhanced prompt text, nothing else\n"
        ),
    },
    {
        "id": "chinese_classical",
        "name": "\u4e2d\u56fd\u53e4\u98ce",
        "source": "presets",
        "tags": ["\u98ce\u683c", "\u56fd\u98ce"],
        "content": (
            "You are a Chinese classical art AI image prompt specialist. Transform the user's input into beautiful Chinese-style prompts.\n\n"
            "Rules:\n"
            "- Emphasize traditional Chinese aesthetics: ink wash painting, watercolor, silk painting style\n"
            "- Include: mountains, rivers, bamboo, plum blossoms, cranes, pagodas, misty landscapes\n"
            "- Add atmosphere: ethereal, poetic, serene, ancient elegance\n"
            "- Use comma-separated descriptive phrases in English\n"
            "- Output ONLY the enhanced prompt text, nothing else\n"
        ),
    },
    {
        "id": "realistic_photo",
        "name": "\u5199\u5b9e\u6444\u5f71",
        "source": "presets",
        "tags": ["\u98ce\u683c", "\u73b0\u5b9e"],
        "content": (
            "You are a realistic photography AI image prompt specialist. Transform the user's input into photorealistic prompts.\n\n"
            "Rules:\n"
            "- Emphasize camera settings, lighting conditions, photographic style\n"
            "- Include: lens type (35mm, 85mm, macro), aperture (f/1.4, f/2.8), ISO, film grain\n"
            "- Add photography terms: bokeh, depth of field, golden hour, natural lighting, HDR\n"
            "- Use comma-separated descriptive phrases in English\n"
            "- Output ONLY the enhanced prompt text, nothing else\n"
        ),
    },
    {
        "id": "translate",
        "name": "\u7ffb\u8bd1",
        "source": "presets",
        "tags": ["\u7ffb\u8bd1", "\u5de5\u5177"],
        "content": (
            "You are an expert translator for AI image prompts. Your task is to translate the user's prompt to English.\n\n"
            "Rules:\n"
            "- Translate the input text to natural, fluent English suitable for AI image generation\n"
            "- Preserve the original meaning and artistic intent\n"
            "- Use appropriate terminology for AI image prompts\n"
            "- Output ONLY the translated text, nothing else\n"
        ),
    },
]


def _load_template_file(filepath: str) -> dict | None:
    """Load a single template file (YAML format only)."""
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            # Support YAML format only
            if filepath.endswith('.yaml') or filepath.endswith('.yml'):
                try:
                    import yaml
                    data = yaml.safe_load(f)
                except ImportError:
                    logger.warning(f"PyYAML not installed, cannot load YAML template: {filepath}")
                    return None
            else:
                logger.warning(f"Unsupported template file format (only YAML supported): {filepath}")
                return None
            
            # Ensure required fields
            data.setdefault('id', Path(filepath).stem)
            data.setdefault('name', data.get('id'))
            data.setdefault('source', 'custom')
            data.setdefault('tags', [])
            data.setdefault('content', '')
            if 'created_at' not in data:
                import datetime
                data['created_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            return data
    except Exception as e:
        logger.warning(f"Error loading template from {filepath}: {e}")
        return None


def _save_template_file(template: dict, filepath: str) -> bool:
    """Save a template to file (YAML format only)."""
    try:
        # Use YAML format for saving
        if filepath.endswith('.json'):
            # Convert to YAML format
            filepath = filepath.replace('.json', '.yaml')
        
        try:
            import yaml
            with open(filepath, 'w', encoding='utf-8') as f:
                yaml.dump(template, f, indent=2, allow_unicode=True, default_flow_style=False)
        except ImportError:
            logger.error(f"PyYAML not installed, cannot save template: {filepath}")
            return False
        return True
    except Exception as e:
        logger.error(f"Error saving template to {filepath}: {e}")
        return False


def _scan_templates_recursive(base_dir: str, source: str = "custom") -> list:
    """Recursively scan template directory (YAML format only)."""
    templates = []
    if not os.path.exists(base_dir):
        return templates

    for entry in sorted(os.listdir(base_dir)):
        full_path = os.path.join(base_dir, entry)
        if os.path.isdir(full_path):
            sub_prefix = f"{entry}/"
            templates.extend(_scan_templates_recursive(full_path, source))
        elif (entry.endswith('.yaml') or entry.endswith('.yml')) and not entry.startswith('_'):
            data = _load_template_file(full_path)
            if data:
                # Override source based on actual directory location
                data['source'] = source
                data['_mtime'] = os.path.getmtime(full_path)
                templates.append(data)
    return templates


def _ensure_builtin_templates():
    """Ensure all built-in preset templates exist on disk."""
    import datetime
    for tpl in DEFAULT_TEMPLATES:
        target_dir = TEMPLATE_PRESETS_DIR if tpl['source'] == 'presets' else TEMPLATE_CUSTOM_DIR
        filename = f"{tpl['id']}.yaml"  # Use YAML format
        filepath = os.path.join(target_dir, filename)
        if not os.path.exists(filepath):
            template_data = {
                "id": tpl["id"],
                "name": tpl["name"],
                "source": tpl["source"],
                "tags": tpl.get("tags", []),
                "content": tpl["content"],
                "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            _save_template_file(template_data, filepath)


# Initialize built-in templates on module load
_ensure_builtin_templates()


def _load_template_content(template_id: str) -> str | None:
    """Load template content by id (custom first, then presets)."""
    if not template_id:
        return None
    for base_dir in [TEMPLATE_CUSTOM_DIR, TEMPLATE_PRESETS_DIR]:
        for ext in ['.yaml', '.yml']:
            data = _load_template_file(os.path.join(base_dir, f"{template_id}{ext}"))
            if data and data.get("content"):
                return data["content"]
    logger.warning(f"Template not found or has no content: {template_id}")
    return None


def load_template_multi_result(template_id: str):
    """加载模板的 multi_result 输出契约（未声明则 None）。"""
    if not template_id:
        return None
    for base_dir in [TEMPLATE_CUSTOM_DIR, TEMPLATE_PRESETS_DIR]:
        for ext in ('.yaml', '.yml'):
            data = _load_template_file(os.path.join(base_dir, f"{template_id}{ext}"))
            if data and data.get("multi_result"):
                return data["multi_result"]
    return None


_tags_lock = threading.Lock()
_tags_lock = threading.Lock()

# 从 llm 模块导入 LLM 相关功能
from .llm import (
    handle_llm_api_request,
    handle_llm_api_stream,
    check_model_status,
    check_all_models_status,
    start_download,
    get_available_models,
    set_current_model,
    unload_local_model,
    get_remote_llm_config,
    set_remote_llm_config,
    get_current_mode,
    LLM_MODE_LOCAL,
    LLM_MODE_REMOTE,
    run_llm_task,
    LLM_TASKS,
    resolve_multi_result,
)


# ==========================================
# Skills - 统一 模板 / 任务 / 图片输入 的元数据视图
# skill 是"系统提示词 + 输入契约(text/image) + 触发方式(标记/下拉)"
# ==========================================
TASKS_DIR = os.path.join(TEMPLATES_DIR, "tasks")

# 内置使命级别的默认输入契约（任务 YAML 未声明 inputs 时使用）
_SKILL_DEFAULT_INPUTS = {
    "reverse_prompt": ["image", "text"],
    "smart_prompt": ["text"],
    "template_prompt": ["text"],
    "translate_prompt": ["text"],
    "extract_title": ["text"],
    "extract_classify": ["text"],
}

# 输入框 @ 标记 -> skill id 路由表
_SKILL_MARKERS = {
    "reverse_prompt": ["@图", "@反推", "@图片"],
}

# 仅内部使用的任务（实现细节），不对外展示为可选 skill
_SKILL_INTERNAL = {
    "template_prompt",
    "extract_title",
    "extract_classify",
}


def _skill_category(skill_id: str, data: dict) -> str:
    """推断 skill 分类：vision（含图像输入）/ task（任务）/ style（模板）。"""
    if data.get("category"):
        return data["category"]
    if "image" in data.get("inputs", []):
        return "vision"
    return "task"


def _scan_skills() -> list:
    """合并 tasks + templates(presets/custom) 为统一 skill 元数据列表。

    每个 skill 返回: {id, name, category, source, inputs, needs_image, markers, tags, description}
    保持与 list_templates 兼容：id/source/tags/description 字段不变。
    """
    skills = []

    # 1) 任务 (tasks/*.yaml) -> category=task/vision
    if os.path.isdir(TASKS_DIR):
        for entry in sorted(os.listdir(TASKS_DIR)):
            if not (entry.endswith('.yaml') or entry.endswith('.yml')) or entry.startswith('_'):
                continue
            data = _load_template_file(os.path.join(TASKS_DIR, entry))
            if not data:
                continue
            skill_id = data.get("id") or Path(entry).stem
            if skill_id in _SKILL_INTERNAL:
                continue
            inputs = data.get("inputs") or _SKILL_DEFAULT_INPUTS.get(skill_id, ["text"])
            skills.append({
                "id": skill_id,
                "name": data.get("name", skill_id),
                "category": _skill_category(skill_id, {**data, "inputs": inputs}),
                "source": "tasks",
                "tags": data.get("tags", []),
                "inputs": inputs,
                "needs_image": "image" in inputs,
                "markers": data.get("markers") or _SKILL_MARKERS.get(skill_id, []),
                "description": data.get("description", ""),
            })

    # 2) 模板 (presets + custom) -> category=style/custom
    with _templates_lock:
        preset_templates = _scan_templates_recursive(TEMPLATE_PRESETS_DIR, source="presets")
        custom_templates = _scan_templates_recursive(TEMPLATE_CUSTOM_DIR, source="custom")

    for tpl in preset_templates + custom_templates:
        tpl_id = tpl.get("id", "")
        if not tpl_id:
            continue
        inputs = tpl.get("inputs") or ["text"]
        skills.append({
            "id": tpl_id,
            "name": tpl.get("name", tpl_id),
            "category": tpl.get("category", "style"),
            "source": tpl.get("source", "custom"),
            "tags": tpl.get("tags", []),
            "inputs": inputs,
            "needs_image": "image" in inputs,
            "markers": [],
            "description": tpl.get("description", ""),
        })

    return skills


# ==========================================
# Image Helpers (前端传图 / 节点 IMAGE 输入)
# ==========================================

MAX_IMAGE_SIDE = 1024

# 节点 image 输入允许解析的图片扩展名
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def _read_image_raw(src: dict) -> bytes | None:
    """解析图片源为原始字节。

    kind="data":  {"data": "data:image/png;base64,..."}  前端粘贴/选择/拖拽
    kind="input": {"value": "sub/dir/img.png[output]"}   节点 image 输入上游（如 LoadImage）
    """
    import base64
    import folder_paths

    kind = src.get("kind", "data")
    if kind == "data":
        data_uri = src.get("data", "")
        if "," not in data_uri:
            return None
        try:
            return base64.b64decode(data_uri.split(",", 1)[1])
        except Exception as e:
            logger.warning(f"resolve_image_bytes: failed to decode base64 image: {e}")
            return None

    if kind == "input":
        name = str(src.get("value", "")).strip()
        if not name:
            return None
        # 解析 [input]/[output] 标注（LoadImage 的 widget 值可能带），默认 input 目录
        stem, tag = name, ""
        if name.endswith("]") and "[" in name:
            stem, _, tag = name[:-1].rpartition("[")
        base_dir = folder_paths.get_output_directory() if tag == "output" \
            else folder_paths.get_input_directory()
        real = os.path.realpath(os.path.join(base_dir, stem))
        base_real = os.path.realpath(base_dir)
        if not os.path.normcase(real).startswith(os.path.normcase(base_real) + os.sep):
            logger.warning(f"resolve_image_bytes: path escapes directory: {name}")
            return None
        if not os.path.isfile(real):
            logger.warning(f"resolve_image_bytes: image not found: {name}")
            return None
        if os.path.splitext(real)[1].lower() not in _IMAGE_EXTENSIONS:
            logger.warning(f"resolve_image_bytes: unsupported image type: {name}")
            return None
        try:
            with open(real, "rb") as f:
                return f.read()
        except Exception as e:
            logger.warning(f"resolve_image_bytes: failed to read {name}: {e}")
            return None

    return None


def resolve_image_bytes(src: dict, max_side: int = MAX_IMAGE_SIDE) -> bytes | None:
    """将前端传入的图片源解析为字节数据（超过最长边时等比缩放为 PNG）。"""
    import io
    from PIL import Image

    if not isinstance(src, dict):
        return None
    raw = _read_image_raw(src)
    if raw is None:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as img:
            w, h = img.size
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()
    except Exception as e:
        logger.warning(f"resolve_image_bytes: failed to process image: {e}")
        return None


def image_tensor_to_png(image: torch.Tensor) -> bytes | None:
    """将 ComfyUI IMAGE tensor ((1,H,W,3) float 0~1) 转为 PNG bytes（第一帧）。"""
    import io
    import numpy as np
    from PIL import Image

    try:
        arr = image[0].detach().cpu().numpy()
        arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"image_tensor_to_png: failed: {e}")
        return None


def _load_tags_index(tags_file: str = TAGS_FILE) -> dict:
    """Load tags index from the dedicated tags file."""
    if not os.path.exists(tags_file):
        return {}
    try:
        with open(tags_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, Exception) as e:
        logger.warning(f"Error loading tags index from {tags_file}: {e}")
        return {}


def _save_tags_index(index: dict, tags_file: str = TAGS_FILE) -> None:
    """Save tags index to the dedicated tags file."""
    try:
        with open(tags_file, 'w', encoding='utf-8') as f:
            json.dump(index, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error saving tags index to {tags_file}: {e}")


def _get_tags_file_path(source: str) -> str:
    """根据来源返回对应的标签索引文件路径"""
    if source == "presets":
        return PRESETS_TAGS_FILE
    return CUSTOM_TAGS_FILE


def _update_tags_index(prompt_name: str, tags: list[str] | None = None, source: str = "custom") -> None:
    """更新指定来源的标签索引"""
    tags_file = _get_tags_file_path(source)
    with _tags_lock:
        index = _load_tags_index(tags_file)
        if tags is None:
            index.pop(prompt_name, None)
        else:
            index[prompt_name] = tags
        _save_tags_index(index, tags_file)


def _get_tags_for_prompt(prompt_name: str, source: str = "custom") -> list:
    """获取指定来源的标签"""
    tags_file = _get_tags_file_path(source)
    index = _load_tags_index(tags_file)
    return index.get(prompt_name, [])


def _scan_prompts_recursive(base_dir: str, prefix: str = "", source: str = "custom") -> list:
    """递归扫描目录，返回 prompt 列表，支持多级子目录"""
    prompts = []
    if not os.path.exists(base_dir):
        return prompts

    for entry in sorted(os.listdir(base_dir)):
        full_path = os.path.join(base_dir, entry)
        if os.path.isdir(full_path):
            # 递归处理子目录
            sub_prefix = f"{prefix}{entry}/" if prefix else f"{entry}/"
            prompts.extend(_scan_prompts_recursive(full_path, sub_prefix, source))
        elif entry.endswith('.txt') and not entry.startswith('_'):
            name = entry[:-4]  # 去掉 .txt 后缀
            display_name = f"{prefix}{name}" if prefix else name
            mtime = os.path.getmtime(full_path)
            tags = _get_tags_for_prompt(display_name, source)
            prompts.append({
                "name": display_name,
                "tags": tags,
                "source": source,
                "_mtime": mtime
            })
    return prompts


# ==========================================
# Prompt Node Class
# ==========================================

class NeoPrompts:
    _encode_cache = {}
    _CACHE_MAX_SIZE = 50
    MIN_SIZE = (400, 300)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "text": ("STRING", {"multiline": True, "default": "", "hidden": True}),
                "disable_text_input": ("BOOLEAN", {"default": False, "hidden": True}),
                "auto_generate": ("BOOLEAN", {"default": False, "hidden": True}),
                "quick_input": ("STRING", {"default": "", "hidden": True}),
                "template_id": ("STRING", {"default": "", "hidden": True}),
                "quick_input_used": ("BOOLEAN", {"default": False, "hidden": True}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True}),
                "image": ("IMAGE",),
                "instance_uid": ("STRING", {"default": "", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("CONDITIONING",  "STRING")
    RETURN_NAMES = ("POSITIVE",  "PROMPT")
    FUNCTION = "encode_prompts"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "AI-powered text encoder supports save/select prompt, LLM-based prompt enhancement, translation, classification, title extraction, intelligent caching, and auto-generate."

    def encode_prompts(self, clip, disable_text_input=False, auto_generate=False, quick_input="",
                       text="", text_input=None, unique_id=None, instance_uid="", template_id="", image=None,
                       quick_input_used=False):
        """Encode prompts with optional auto-generate support.
        
        Logic:
        1. If auto_generate is enabled and (quick_input or image) has content, call LLM synchronously (ignore existing text)
        2. If image is provided, use the reverse_prompt skill (image-to-prompt)
        3. Otherwise, combine text and quick_input (same as frontend logic)
        """
        logger.info(f"encode_prompts called: auto_generate={auto_generate}, text='{text[:50]}...', quick_input='{quick_input[:50]}...', text_input={text_input is not None}, image={image is not None}")
        
        # If auto_generate is enabled and (quick_input or image) has content, generate synchronously
        # Image input connected -> always use the image (reverse_prompt) flow;
        # text-only generation still requires auto_generate.
        if ((auto_generate and quick_input.strip()) or image is not None) and text_input is None:
            logger.info(f"Auto-generate condition met, checking LLM mode...")
            current_mode = get_current_mode()
            logger.info(f"Current LLM mode: {current_mode}")
            try:
                image_bytes = image_tensor_to_png(image) if image is not None else None
                image_mode = image_bytes is not None
                if image_mode or current_mode == LLM_MODE_REMOTE:
                    # Use selected template as system prompt when available
                    task_name = "reverse_prompt" if image_mode else "smart_prompt"
                    system_prompt = None
                    if not image_mode and template_id.strip():
                        system_prompt = _load_template_content(template_id)
                        if system_prompt:
                            task_name = "template_prompt"
                            logger.info(f"Auto-generate using template '{template_id}' (length: {len(system_prompt)})")
                        else:
                            logger.warning(f"Template '{template_id}' not found, falling back to smart_prompt")
                    logger.info(f"Calling LLM with {task_name} task, quick_input: {quick_input[:100]}..., image: {image_mode}")
                    # Use stream generation for real-time update
                    from .llm import run_llm_task_stream
                    accumulated = ""
                    stream_kwargs = {"system_prompt": system_prompt}
                    if image_mode:
                        stream_kwargs["images"] = [image_bytes]
                    for chunk in run_llm_task_stream(task_name, quick_input, **stream_kwargs):
                        accumulated += chunk
                        # Send real-time update to frontend
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": False
                            })

                    if accumulated:
                        text = accumulated
                        logger.info(f"Auto-generated prompt: {accumulated[:100]}...")
                        # Send final update
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": True
                            })
                else:
                    logger.warning(f"Auto-generate only works in remote LLM mode, current mode: {current_mode}")
            except Exception as e:
                logger.error(f"Auto-generate failed: {e}")
                logger.exception(e)
        else:
            logger.info(f"Auto-generate condition not met: auto_generate={auto_generate}, quick_input_has_content={quick_input.strip()}, text_input_none={text_input is None}")
            # Combine text and quick_input (same logic as frontend)
            # quick_input 已作为生成指令被消费时不再拼入提示词
            if quick_input.strip() and not quick_input_used:
                if text.strip():
                    text = f"{text}\n\n---\n\n{quick_input}"
                else:
                    text = quick_input

        current_text = text
        if disable_text_input:
            effective_text_input = None
        else:
            effective_text_input = text_input
        
        if effective_text_input is not None and instance_uid:
            PromptServer.instance.send_sync("rs.prompt.update", {
                "instance_uid": instance_uid,
                "prompt": current_text
            })
        
        cache_key = (current_text, id(clip))
        
        if cache_key in NeoPrompts._encode_cache:
            pos_cond, neg_cond = NeoPrompts._encode_cache[cache_key]
        else:
            tokens_pos = clip.tokenize(current_text)
            pos_cond = clip.encode_from_tokens_scheduled(tokens_pos)
            
            neg_cond = []
            for t in pos_cond:
                d = t[1].copy() if len(t) > 1 else {}
                if "pooled_output" in d and d["pooled_output"] is not None:
                    d["pooled_output"] = torch.zeros_like(d["pooled_output"])
                neg_cond.append((torch.zeros_like(t[0]), d))
            
            if len(NeoPrompts._encode_cache) >= NeoPrompts._CACHE_MAX_SIZE:
                NeoPrompts._encode_cache.clear()
            NeoPrompts._encode_cache[cache_key] = (pos_cond, neg_cond)
        
        return {
            "ui": {"text": [current_text]},
            "result": (pos_cond, neg_cond, current_text)
        }

    @classmethod
    def IS_CHANGED(cls, auto_generate=False, quick_input="", image=None, **kwargs):
        # If auto_generate is enabled and (quick_input or image) has content, always re-execute
        if image is not None or (auto_generate and quick_input.strip()):
            import time
            return time.time()  # Return unique value to force re-execution
        # Otherwise, never change (use cached result)
        return float("nan")


# ==========================================
# API Routes for Prompt Management
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/save_prompt")
async def rs_prompts_save_prompt(request):
    try:
        data = await request.json()
        name = data.get("name", "").strip()
        if not name: 
            return web.Response(status=400, text="Name required")
        name = "".join(c for c in name if c.isalnum() or c in " _-").strip()
        if not name: 
            return web.Response(status=400, text="Invalid name")
        
        # 默认保存到 custom 目录
        base_dir = CUSTOM_DIR
        # 如果名称中包含 "presets/" 前缀，则保存到 presets
        if name.startswith("presets/"):
            base_dir = PRESETS_DIR
            name = name[len("presets/"):]
        
        # 构建文件路径（支持子目录）
        filepath = os.path.join(base_dir, f"{name}.txt")
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(base_dir, f"{name}-{counter}.txt")
            counter += 1
        
        # 确保目录存在
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(data.get("text", ""))
        
        # 确定来源
        source = "presets" if base_dir == PRESETS_DIR else "custom"
        _update_tags_index(name, data.get("tags", []), source=source)
        
        return web.Response(status=200, text="OK")
    except Exception as e:
        logger.error(f"Error saving prompt: {e}")
        return web.Response(status=500, text=str(e))

@server.PromptServer.instance.routes.post("/rs_prompts/list_prompts")
async def rs_prompts_list_prompts(request):
    try:
        # 递归扫描 presets 和 custom 目录
        presets_prompts = _scan_prompts_recursive(PRESETS_DIR, source="presets")
        custom_prompts = _scan_prompts_recursive(CUSTOM_DIR, source="custom")
        
        # 按 mtime 倒序排序（每组内最新的在前）
        def sort_key(x):
            return -x.get("_mtime", 0)
        
        custom_prompts.sort(key=sort_key)
        presets_prompts.sort(key=sort_key)
        
        # custom 在前，presets 在后
        prompts = custom_prompts + presets_prompts
        
        return web.json_response(prompts)
    except Exception as e:
        logger.error(f"Error listing prompts: {e}")
        return web.Response(status=500, text=str(e))

@server.PromptServer.instance.routes.post("/rs_prompts/load_prompt")
async def rs_prompts_load_prompt(request):
    try:
        data = await request.json()
        name = data.get("name")
        if not name:
            return web.Response(status=400, text="Name required")
        
        # 根据名称中的路径判断来源目录
        if name.startswith("presets/"):
            base_dir = PRESETS_DIR
            name = name[len("presets/"):]
        else:
            base_dir = CUSTOM_DIR
        
        # 构建文件路径（支持子目录）
        filepath = os.path.join(base_dir, f"{name}.txt")
        if os.path.exists(filepath):
            with open(filepath, 'r', encoding='utf-8') as f:
                text_content = f.read()
                return web.json_response({"text": text_content})
        
        # 尝试在两个目录中查找
        for search_dir in [CUSTOM_DIR, PRESETS_DIR]:
            filepath = os.path.join(search_dir, f"{name}.txt")
            if os.path.exists(filepath):
                with open(filepath, 'r', encoding='utf-8') as f:
                    text_content = f.read()
                    return web.json_response({"text": text_content})
        
        return web.Response(status=404, text="Prompt not found")
    except Exception as e:
        logger.error(f"Error loading prompt: {e}")
        return web.Response(status=500, text=str(e))

@server.PromptServer.instance.routes.post("/rs_prompts/delete_prompt")
async def rs_prompts_delete_prompt(request):
    try:
        data = await request.json()
        name = data.get("name")
        if not name: 
            return web.Response(status=400, text="Name required")
        
        # 确定来源和基础目录
        if name.startswith("presets/"):
            base_dir = PRESETS_DIR
            name = name[len("presets/"):]
            source = "presets"
        else:
            base_dir = CUSTOM_DIR
            source = "custom"
        
        # 构建文件路径
        filepath = os.path.join(base_dir, f"{name}.txt")
        if os.path.exists(filepath):
            os.remove(filepath)
            _update_tags_index(name, tags=None, source=source)
            return web.Response(status=200, text="OK")
        
        # 尝试在两个目录中查找
        for search_dir in [CUSTOM_DIR, PRESETS_DIR]:
            filepath = os.path.join(search_dir, f"{name}.txt")
            if os.path.exists(filepath):
                os.remove(filepath)
                s = "custom" if search_dir == CUSTOM_DIR else "presets"
                _update_tags_index(name, tags=None, source=s)
                return web.Response(status=200, text="OK")
        
        return web.Response(status=404, text="Prompt not found")
    except Exception as e:
        logger.error(f"Error deleting prompt: {e}")
        return web.Response(status=500, text=str(e))

@server.PromptServer.instance.routes.get("/rs_prompts/get_models")
async def rs_prompts_get_models(request):
    try:
        models = get_available_models()
        return web.json_response(models)
    except Exception as e:
        logger.error(f"Error getting models: {e}")
        return web.Response(status=500, text=str(e))

@server.PromptServer.instance.routes.post("/rs_prompts/set_model")
async def rs_prompts_set_model(request):
    try:
        data = await request.json()
        model_key = data.get("model_key")
        if not model_key:
            return web.Response(status=400, text="model_key required")
        
        success = set_current_model(model_key)
        if success:
            return web.json_response({"success": True, "current_model": model_key})
        else:
            return web.Response(status=400, text="Invalid model key")
    except Exception as e:
        logger.error(f"Error setting model: {e}")
        return web.Response(status=500, text=str(e))


# ==========================================
# Remote LLM Configuration API Routes
# ==========================================

def _mask_remote_config(config: dict) -> dict:
    """复制配置并隐藏所有 provider 的 api_key"""
    safe = copy.deepcopy(config)
    for slot in safe.get("providers", {}).values():
        if isinstance(slot, dict) and slot.get("api_key"):
            slot["api_key"] = "***"
    return safe


@server.PromptServer.instance.routes.get("/rs_prompts/remote_llm_config")
async def rs_prompts_get_remote_llm_config(request):
    """获取远程 LLM 配置（按 provider 分槽，返回时隐藏 api_key）"""
    try:
        config = get_remote_llm_config()
        return web.json_response(_mask_remote_config(config))
    except Exception as e:
        logger.error(f"Error getting remote LLM config: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/remote_llm_config")
async def rs_prompts_set_remote_llm_config(request):
    """设置远程 LLM 配置（只更新对应 provider，不覆盖其它 provider）"""
    try:
        data = await request.json()
        set_remote_llm_config(data)
        config = get_remote_llm_config()
        # 返回成功，隐藏 api_key
        return web.json_response({
            "success": True,
            "config": _mask_remote_config(config)
        })
    except Exception as e:
        logger.error(f"Error setting remote LLM config: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.get("/rs_prompts/llm_mode")
async def rs_prompts_get_llm_mode(request):
    """获取当前 LLM 模式"""
    try:
        mode = get_current_mode()
        return web.json_response({"mode": mode})
    except Exception as e:
        logger.error(f"Error getting LLM mode: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/unload_local_model")
async def rs_prompts_unload_local_model(request):
    """卸载本地 LLM 模型（释放显存）"""
    try:
        result = unload_local_model()
        if result.get("success"):
            return web.json_response(result)
        else:
            return web.json_response(result, status=400)
    except Exception as e:
        logger.error(f"Error unloading local model: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ==========================================
# API Routes Registration (LLM API)
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/extract_title")
async def rs_prompts_extract_title(request):
    return await handle_llm_api_request("extract_title", request)

@server.PromptServer.instance.routes.post("/rs_prompts/extract_classify")
async def rs_prompts_extract_classify(request):
    return await handle_llm_api_request("extract_classify", request)

@server.PromptServer.instance.routes.post("/rs_prompts/enhance_prompt")
async def rs_prompts_enhance_prompt(request):
    return await handle_llm_api_request("enhance_prompt", request)

@server.PromptServer.instance.routes.post("/rs_prompts/translate_prompt")
async def rs_prompts_translate_prompt(request):
    return await handle_llm_api_request("translate_prompt", request)

@server.PromptServer.instance.routes.post("/rs_prompts/smart_prompt")
async def rs_prompts_smart_prompt(request):
    """智能提示词 - LLM 直接判断用户意图并生成/改写"""
    from aiohttp import web
    try:
        data = await request.json()
        text = data.get("text", "")  # 已拼接的提示词（前端拼接）
        template_id = data.get("templateId", data.get("template_id", ""))  # 模版 ID
        template = data.get("template", "")  # 可选的系统提示词内容（直接传递内容）

        logger.info(f"Smart prompt request: text='{text[:100]}...', template_id='{template_id}', template='{template[:100] if template else 'None'}...'")

        if not text or not text.strip():
            return web.json_response({"error": "text is required"}, status=400)

        from .llm import run_llm_task, get_current_mode, LLM_MODE_REMOTE, _load_template_content

        # 确定系统提示词：优先使用 template 内容，其次使用 template_id 加载模版
        system_prompt = None
        if template and template.strip():
            # 直接提供了系统提示词内容
            system_prompt = template
            logger.info(f"Using direct template content (length: {len(system_prompt)})")
        elif template_id:
            # 使用模版 ID 加载模版内容
            system_prompt = await _load_template_content(template_id)
            if system_prompt:
                logger.info(f"Loaded template '{template_id}' content (length: {len(system_prompt)})")
            else:
                logger.warning(f"Template '{template_id}' not found or has no content")

        # 如果提供了模板，使用模板作为系统提示词
        if system_prompt and system_prompt.strip():
            result_data = run_llm_task("template_prompt", text, system_prompt=system_prompt)
        else:
            result_data = run_llm_task("smart_prompt", text)
        
        if "error" in result_data:
            error_msg = result_data["error"]
            logger.warning(f"Smart prompt error: {error_msg}")
            
            # 如果是本地模式且模型未加载，提供有用的提示
            if get_current_mode() == LLM_MODE_LOCAL and ("LLM model not found" in error_msg or "Model not loaded" in error_msg):
                return web.json_response({
                    "error": f"Local model is not available. Please download the model first, or switch to remote API mode."
                }, status=422)
            
            # 如果是远程模式且配置不正确，提供有用的提示
            if get_current_mode() == LLM_MODE_REMOTE:
                return web.json_response({
                    "error": f"Remote API error: {error_msg}. Please check your remote_llm_config.json configuration."
                }, status=422)
            
            return web.json_response({"error": error_msg}, status=422)
        
        logger.info(f"Smart prompt response: result='{result_data.get('prompt', '')[:100]}...'")
        return web.json_response(result_data)
        
    except Exception as e:
        logger.error(f"Error handling smart prompt: {e}")
        logger.exception(e)
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/rs_prompts/reverse_prompt")
async def rs_prompts_reverse_prompt(request):
    """从图像反推提示词，结果保存为同名 .txt 文件"""
    from aiohttp import web
    import base64
    from pathlib import Path
    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "presets")
        
        if not filename:
            return web.json_response({"error": "filename is required"}, status=400)
        
        # 确定图像所在目录
        from .gallery import PRESETS_DIR, CUSTOM_DIR, _get_user_custom_dirs, IMG_EXTENSIONS
        base: Path | None = None
        
        if subfolder == "presets" or subfolder == "":
            base = PRESETS_DIR
        elif subfolder == "custom":
            base = CUSTOM_DIR
        else:
            user_custom_dirs = _get_user_custom_dirs()
            dir_parts = [p for p in subfolder.split("/") if p]
            if dir_parts[0] == "presets":
                base = PRESETS_DIR / "/".join(dir_parts[1:])
            else:
                for dir_path in user_custom_dirs:
                    d_name = dir_path.name if dir_path.name else str(dir_path)
                    if dir_parts[0] == d_name:
                        base = dir_path / "/".join(dir_parts[1:]) if len(dir_parts) > 1 else dir_path
                        break
        
        if base is None or not base.exists():
            return web.json_response({"error": "Directory not found"}, status=404)
        
        # 查找图像文件
        image_path: Path | None = None
        for ext in IMG_EXTENSIONS:
            candidate = base / f"{filename}{ext}"
            if candidate.exists():
                image_path = candidate
                break
        
        if image_path is None:
            # 尝试不带扩展名
            candidate = base / filename
            if candidate.exists():
                image_path = candidate
        
        if image_path is None:
            return web.json_response({"error": "Image not found"}, status=404)
        
        # 读取图像，如果过大则缩放到最长边 1024px
        MAX_REVERSE_SIDE = 1024
        image_bytes: bytes = b""
        try:
            from PIL import Image
            import io
            with Image.open(image_path) as img:
                w, h = img.size
                if max(w, h) > MAX_REVERSE_SIDE:
                    ratio = MAX_REVERSE_SIDE / max(w, h)
                    new_w = int(w * ratio)
                    new_h = int(h * ratio)
                    img_resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                    buf = io.BytesIO()
                    img_resized.save(buf, format=img.format or "PNG")
                    image_bytes = buf.getvalue()
                    logger.info(f"Reverse prompt: image={image_path.name}, resized {w}x{h} -> {new_w}x{new_h}")
                else:
                    with open(image_path, "rb") as f:
                        image_bytes = f.read()
                    logger.info(f"Reverse prompt: image={image_path.name}, size={len(image_bytes)} bytes")
        except Exception as resize_err:
            logger.warning(f"Failed to resize image, using original: {resize_err}")
            with open(image_path, "rb") as f:
                image_bytes = f.read()
        
        # 调用 LLM 反推
        result_data = run_llm_task("reverse_prompt", "", images=[image_bytes])
        
        if "error" in result_data:
            error_msg = result_data["error"]
            logger.warning(f"Reverse prompt error: {error_msg}")
            return web.json_response({"error": error_msg}, status=422)
        
        prompt_text = result_data.get("prompt", "")
        if not prompt_text:
            return web.json_response({"error": "Failed to generate prompt"}, status=500)
        
        # 保存为同名 .txt 文件
        txt_path = image_path.with_suffix(".txt")
        txt_path.write_text(prompt_text, encoding="utf-8")
        logger.info(f"Reverse prompt saved to: {txt_path}")
        
        return web.json_response({"status": "success", "prompt": prompt_text, "txt_file": txt_path.name})
        
    except Exception as e:
        logger.error(f"Error handling reverse prompt: {e}")
        logger.exception(e)
        return web.json_response({"error": str(e)}, status=500)


# ==========================================
# Stream LLM API Routes (SSE)
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/stream_{task_name}")
async def rs_prompts_stream_llm_api_request(request):
    """流式 LLM API 请求（SSE）"""
    task_name = request.match_info["task_name"]
    return await handle_llm_api_stream(task_name, request)


@server.PromptServer.instance.routes.post("/rs_prompts/stream_generate_prompt")
async def rs_prompts_stream_generate_prompt(request):
    """流式提示词生成请求（智能判断是否使用模版）"""
    # 默认使用 smart_prompt 任务，如果有 templateId 则会切换
    return await handle_llm_api_stream("smart_prompt", request)


@server.PromptServer.instance.routes.post("/rs_prompts/random_prompt")
async def rs_prompts_random_prompt(request):
    """Random prompt - pick a random preset from the list."""
    try:
        import random
        # 获取 preset list
        presets_prompts = _scan_prompts_recursive(PRESETS_DIR, source="presets")
        custom_prompts = _scan_prompts_recursive(CUSTOM_DIR, source="custom")
        all_prompts = custom_prompts + presets_prompts
        
        if not all_prompts:
            return web.json_response({"status": "error", "prompt": "", "error": "No presets available"})
        
        # 随机选择一个
        selected = random.choice(all_prompts)
        name = selected["name"]
        
        # 直接读取文件
        if name.startswith("presets/"):
            base_dir = PRESETS_DIR
            name = name[len("presets/"):]
        else:
            base_dir = CUSTOM_DIR
        
        filepath = os.path.join(base_dir, f"{name}.txt")
        if os.path.exists(filepath):
            with open(filepath, 'r', encoding='utf-8') as f:
                text_content = f.read()
            return web.json_response({"status": "success", "prompt": text_content})
        
        return web.json_response({"status": "error", "prompt": "", "error": "Prompt not found"})
    except Exception as e:
        logger.error(f"Error in random prompt: {e}")
        return web.json_response({"status": "error", "prompt": "", "error": str(e)})

@server.PromptServer.instance.routes.get("/rs_prompts/check_model")
async def rs_prompts_check_model(request):
    """检查当前 LLM 模型是否已下载，不触发下载"""
    try:
        status = check_model_status()
        return web.json_response(status)
    except Exception as e:
        logger.error(f"Error checking model status: {e}")
        return web.json_response({
            "model_available": False,
            "mmproj_available": False,
            "error": str(e)
        }, status=500)

@server.PromptServer.instance.routes.get("/rs_prompts/check_all_models")
async def rs_prompts_check_all_models(request):
    """检查所有 LLM 模型的下载状态"""
    try:
        status = check_all_models_status()
        return web.json_response(status)
    except Exception as e:
        logger.error(f"Error checking all models status: {e}")
        return web.json_response({
            "models": [],
            "current_model": "",
            "error": str(e)
        }, status=500)

# ==========================================
# Proxy API for fetching remote models (CORS workaround)
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/fetch_remote_models")
async def rs_prompts_fetch_remote_models(request):
    """Proxy request to fetch model list from LM Studio / Ollama"""
    try:
        import aiohttp
        data = await request.json()
        base_url = (data.get("base_url", "") or "").strip().rstrip("/")
        
        if not base_url:
            return web.Response(status=400, text="base_url required")
        
        # 兼容 LM Studio / Ollama 的各种 base URL 写法
        if base_url.endswith("/models"):
            url = base_url
        elif base_url.endswith("/api"):
            url = f"{base_url}/tags"      # Ollama 原生接口
        elif base_url.endswith("/v1"):
            url = f"{base_url}/models"
        else:
            url = f"{base_url}/v1/models"  # OpenAI 兼容接口
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status != 200:
                    return web.json_response({"success": False, "error": f"HTTP {resp.status}"}, status=502)
                payload = await resp.json()

        models = []
        data_list = payload.get("data")
        if isinstance(data_list, list):  # OpenAI 兼容: {"data": [{"id": ...}]}
            for item in data_list:
                if isinstance(item, str):
                    models.append(item)
                elif isinstance(item, dict):
                    models.append(item.get("id") or item.get("name") or "")
        models_list = payload.get("models")
        if isinstance(models_list, list):  # Ollama tags: {"models": [{"name": ...}]}
            for item in models_list:
                if isinstance(item, str):
                    models.append(item)
                elif isinstance(item, dict):
                    models.append(item.get("name") or item.get("id") or "")

        models = sorted({m for m in models if m})
        return web.json_response({"success": True, "models": models})
    except asyncio.TimeoutError:
        return web.json_response({"success": False, "error": "Timeout"}, status=504)
    except Exception as e:
        logger.error(f"Error fetching remote models: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=502)


# ==========================================
# Template Management API Routes
# ==========================================

@server.PromptServer.instance.routes.get("/rs_prompts/list_templates")
async def rs_prompts_list_templates(request):
    """列出所有提示词模版"""
    try:
        with _templates_lock:
            preset_templates = _scan_templates_recursive(TEMPLATE_PRESETS_DIR, source="presets")
            custom_templates = _scan_templates_recursive(TEMPLATE_CUSTOM_DIR, source="custom")
        
        # 按 mtime 倒序排序（每组内最新的在前）
        def sort_key(x):
            return -x.get("_mtime", 0)
        
        custom_templates.sort(key=sort_key)
        preset_templates.sort(key=sort_key)
        
        # custom 在前，presets 在后
        templates = custom_templates + preset_templates
        
        # 移除内部字段 _mtime
        for tpl in templates:
            tpl.pop("_mtime", None)
        
        return web.json_response(templates)
    except Exception as e:
        logger.error(f"Error listing templates: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.get("/rs_prompts/skills")
async def rs_prompts_list_skills(request):
    """列出所有 skill（任务 + 模板统一元数据，含图片输入契约与 @ 标记）。"""
    try:
        return web.json_response(_scan_skills())
    except Exception as e:
        logger.error(f"Error listing skills: {e}")
        return web.Response(status=500, text=str(e))
@server.PromptServer.instance.routes.post("/rs_prompts/load_template")
async def rs_prompts_load_template(request):
    """加载单个模版内容（支持 YAML 格式）"""
    try:
        data = await request.json()
        template_id = data.get("id")
        if not template_id:
            return web.Response(status=400, text="Template id required")

        with _templates_lock:
            # 先在 custom 目录查找，支持 YAML 格式
            for search_dir in [TEMPLATE_CUSTOM_DIR, TEMPLATE_PRESETS_DIR]:
                # 尝试多种 YAML 扩展
                for ext in ['.yaml', '.yml']:
                    filepath = os.path.join(search_dir, f"{template_id}{ext}")
                    if os.path.exists(filepath):
                        tpl_data = _load_template_file(filepath)
                        if tpl_data:
                            result = {k: v for k, v in tpl_data.items() if k != "_mtime"}
                            return web.json_response(result)

        return web.Response(status=404, text="Template not found")
    except Exception as e:
        logger.error(f"Error loading template: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/save_template")
async def rs_prompts_save_template(request):
    """保存/更新模版"""
    try:
        data = await request.json()
        template_id = data.get("id", "").strip()
        if not template_id:
            return web.Response(status=400, text="Template id required")
        
        # 验证 ID（允许 Unicode 字母、数字、下划线、连字符；不含路径分隔符等危险字符）
        import re
        template_id = re.sub(r'[^\w-]', '', template_id)
        if not template_id:
            return web.Response(status=400, text="Invalid template id")
        
        name = data.get("name", "").strip() or template_id
        content = data.get("content", "")
        tags = data.get("tags", [])
        source = data.get("source", "custom")
        
        # 确定保存目录
        target_dir = TEMPLATE_PRESETS_DIR if source == "presets" else TEMPLATE_CUSTOM_DIR
        
        filepath = os.path.join(target_dir, f"{template_id}.yaml")
        
        # 加载现有数据以保留 created_at
        existing_data = _load_template_file(filepath) or {}
        template_data = {
            "id": template_id,
            "name": name,
            "source": source,
            "tags": tags,
            "content": content,
            "created_at": existing_data.get("created_at", datetime.datetime.now(datetime.timezone.utc).isoformat()),
        }
        
        with _templates_lock:
            if not _save_template_file(template_data, filepath):
                return web.Response(status=500, text="Failed to save template")
        
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error saving template: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/delete_template")
async def rs_prompts_delete_template(request):
    """删除模版（预设不可删，仅支持 YAML 格式）"""
    try:
        data = await request.json()
        template_id = data.get("id")
        if not template_id:
            return web.Response(status=400, text="Template id required")

        with _templates_lock:
            # 尝试在两个目录中查找并删除（支持 YAML 格式）
            for search_dir in [TEMPLATE_CUSTOM_DIR, TEMPLATE_PRESETS_DIR]:
                # 尝试多种 YAML 扩展
                for ext in ['.yaml', '.yml']:
                    filepath = os.path.join(search_dir, f"{template_id}{ext}")

                    if os.path.exists(filepath):
                        # 根据文件所在目录确定来源
                        source = "custom" if search_dir == TEMPLATE_CUSTOM_DIR else "presets"

                        # 预设模版不允许删除
                        if source == "presets":
                            return web.Response(status=403, text="Cannot delete preset template")

                        os.remove(filepath)
                        return web.json_response({"success": True})

        return web.Response(status=404, text="Template not found")
    except Exception as e:
        logger.error(f"Error deleting template: {e}")
        return web.Response(status=500, text=str(e))


# ==========================================
# NeoPromptGenerator Node Class
# A simple prompt generator node with settings button only
# ==========================================

class NeoPromptGenerator:
    """
    A simple prompt generator node that outputs text only.
    - No clip input required
    - Supports external/internal input toggle
    - Output: STRING (the prompt text)
    - Has a settings button to select LLM model
    - Supports auto-generate option
    """

    _CACHE_MAX_SIZE = 50
    MIN_SIZE = (400, 300)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": "", "hidden": True}),
                "disable_text_input": ("BOOLEAN", {"default": False, "hidden": True}),
                "auto_generate": ("BOOLEAN", {"default": False, "hidden": True}),
                "quick_input": ("STRING", {"default": "", "hidden": True}),
                "template_id": ("STRING", {"default": "", "hidden": True}),
                "quick_input_used": ("BOOLEAN", {"default": False, "hidden": True}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True}),
                "image": ("IMAGE",),
                "instance_uid": ("STRING", {"default": "", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("PROMPT",)
    # 多结果 skill：输出按条目循环消费（OUTPUT_IS_LIST），单结果等价于原行为
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "get_prompt"
    CATEGORY = "Neo-Nodes"
    OUTPUT_NODE = True
    DESCRIPTION = "Simple prompt generator node with settings button. Supports external/internal input toggle and auto-generate. No clip encoder binding."

    def get_prompt(self, prompt="", disable_text_input=False, auto_generate=False, quick_input="", text_input=None, instance_uid="", unique_id=None, template_id="", image=None, quick_input_used=False):
        """Returns the prompt text as output.

        Logic:
        1. If auto_generate is enabled and quick_input has content, call LLM synchronously (ignore existing prompt)
        2. Otherwise, combine prompt and quick_input (same as frontend logic)
        """
        logger.info(f"get_prompt called: auto_generate={auto_generate}, prompt='{prompt[:50]}...', quick_input='{quick_input[:50]}...', text_input={text_input is not None}, image={image is not None}")
        gen_meta = {"task": None, "template_id": ""}
        
        # If auto_generate is enabled and (quick_input or image) has content, generate synchronously
        # Image input connected -> always use the image (reverse_prompt) flow;
        # text-only generation still requires auto_generate.
        if ((auto_generate and quick_input.strip()) or image is not None) and text_input is None:
            logger.info(f"Auto-generate condition met, checking LLM mode...")
            current_mode = get_current_mode()
            logger.info(f"Current LLM mode: {current_mode}")
            try:
                image_bytes = image_tensor_to_png(image) if image is not None else None
                image_mode = image_bytes is not None
                if image_mode or current_mode == LLM_MODE_REMOTE:
                    # Use selected template as system prompt when available
                    task_name = "reverse_prompt" if image_mode else "smart_prompt"
                    system_prompt = None
                    if not image_mode and template_id.strip():
                        system_prompt = _load_template_content(template_id)
                        if system_prompt:
                            task_name = "template_prompt"
                            logger.info(f"Auto-generate using template '{template_id}' (length: {len(system_prompt)})")
                        else:
                            logger.warning(f"Template '{template_id}' not found, falling back to smart_prompt")
                    gen_meta.update(task=task_name, template_id=template_id)
                    logger.info(f"Calling LLM with {task_name} task, quick_input: {quick_input[:100]}..., image: {image_mode}")
                    # Use stream generation for real-time update
                    from .llm import run_llm_task_stream
                    accumulated = ""
                    stream_kwargs = {"system_prompt": system_prompt}
                    if image_mode:
                        stream_kwargs["images"] = [image_bytes]
                    for chunk in run_llm_task_stream(task_name, quick_input, **stream_kwargs):
                        accumulated += chunk
                        # Send real-time update to frontend
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": False
                            })

                    if accumulated:
                        prompt = accumulated
                        logger.info(f"Auto-generated prompt: {accumulated[:100]}...")
                        # Send final update
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": True
                            })
                else:
                    logger.warning(f"Auto-generate only works in remote LLM mode, current mode: {current_mode}")
            except Exception as e:
                logger.error(f"Auto-generate failed: {e}")
                logger.exception(e)
        else:
            logger.info(f"Auto-generate condition not met: auto_generate={auto_generate}, quick_input_has_content={quick_input.strip()}, text_input_none={text_input is None}")
            # Combine prompt and quick_input (same logic as frontend)
            # quick_input 已作为生成指令被消费时不再拼入提示词
            if quick_input.strip() and not quick_input_used:
                if prompt.strip():
                    prompt = f"{prompt}\n\n---\n\n{quick_input}"
                else:
                    prompt = quick_input

        current_text = prompt
        if disable_text_input:
            effective_text_input = None
        else:
            effective_text_input = text_input

        if effective_text_input is not None and instance_uid:
            PromptServer.instance.send_sync("rs.prompt.update", {
                "instance_uid": instance_uid,
                "prompt": current_text
            })

        # 多结果 skill：按 multi_result 契约拆分；未声明或仅一段时为 [current_text]
        multi_rule = None
        if gen_meta["task"] == "template_prompt":
            multi_rule = load_template_multi_result(gen_meta["template_id"])
        elif gen_meta["task"]:
            multi_rule = LLM_TASKS.get(gen_meta["task"], {}).get("multi_result")
        elif template_id:
            # 节点未参与生成（如前端✨生成后直接出队）：按所选模板/任务契约拆分
            multi_rule = load_template_multi_result(template_id)
            if multi_rule is None and template_id in LLM_TASKS:
                multi_rule = LLM_TASKS[template_id].get("multi_result")
        prompts_list = resolve_multi_result(current_text, multi_rule) or [current_text]

        return {
            "ui": {"text": [current_text]},
            "result": (prompts_list,)
        }

    @classmethod
    def IS_CHANGED(cls, auto_generate=False, quick_input="", image=None, **kwargs):
        # If auto_generate is enabled and (quick_input or image) has content, always re-execute
        if image is not None or (auto_generate and quick_input.strip()):
            import time
            return time.time()  # Return unique value to force re-execution
        # Otherwise, never change (use cached result)
        return float("nan")


# ==========================================
# Node Class Mappings
# ==========================================
NODE_CLASS_MAPPINGS = {
    "NeoPromptEncoder": NeoPrompts,
    "NeoPromptGenerator": NeoPromptGenerator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NeoPromptEncoder": "Neo Prompt Encoder",
    "NeoPromptGenerator": "Neo Prompt Generator",
}
