# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 生视频（MiniMax H3）全局设置：独立于生图 image_gen.json，
# 落盘 configs/video_gen.json；/neo_video_gen/* 路由在此注册。

from __future__ import annotations

import json
import logging
import os

import folder_paths
from aiohttp import web
from server import PromptServer

logger = logging.getLogger(__name__)

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIGS_DIR = os.path.join(CURRENT_DIR, "configs")
VIDEO_SETTINGS_FILE = os.path.join(CONFIGS_DIR, "video_gen.json")

# 空 = 未配置，节点回落到此再报错
DEFAULT_VIDEO_SETTINGS = {
    "video_model": "",                 # diffusion_models 相对名
    "video_text_encoder": "",          # text_encoders 相对名
    "video_vae": "",                   # vae 相对名（视频）
    "video_audio_vae": "",             # vae 相对名（H3 音频，独立 VAE）
}

routes = PromptServer.instance.routes


def get_video_settings() -> dict:
    settings = dict(DEFAULT_VIDEO_SETTINGS)
    try:
        if os.path.exists(VIDEO_SETTINGS_FILE):
            with open(VIDEO_SETTINGS_FILE, "r", encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                settings.update({k: v for k, v in stored.items() if k in DEFAULT_VIDEO_SETTINGS})
    except Exception as e:
        logger.warning(f"[NeoNodes] video_gen settings ignored ({e}); using defaults")
    return settings


def save_video_settings(patch: dict) -> dict:
    settings = get_video_settings()
    for key, value in (patch or {}).items():
        if key in DEFAULT_VIDEO_SETTINGS:
            settings[key] = value
    os.makedirs(CONFIGS_DIR, exist_ok=True)
    tmp = VIDEO_SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp, VIDEO_SETTINGS_FILE)
    return settings


# 生视频（MiniMax H3）自动挑选默认模型时的名称线索（按优先级），与 image_gen._MODEL_HINTS 同构。
# "h3" 精确命中 H3 系列，避开同名 minimax 的 Music3 音频模型；VAE 用 h3_video 避开 audio VAE。
_VIDEO_MODEL_HINTS = {
    "diffusion_models": ("minimax_h3",),
    "text_encoders": ("qwen3vl_32b_minimax_h3",),
    "vae": ("minimax_h3_video",),
}


def suggest_video_model(folder: str) -> str:
    """按 H3 名称线索挑默认视频模型（turbo 优先、短名优先）；无命中返回空串。与 image_gen.suggest_model 同构。"""
    try:
        files = sorted(folder_paths.get_filename_list(folder) or [])
    except Exception as e:
        logger.warning(f"[NeoNodes] video_gen: scan {folder} failed: {e}")
        return ""
    if not files:
        return ""
    for hint in _VIDEO_MODEL_HINTS.get(folder, ()):
        matches = [f for f in files if hint in f.lower()]
        if matches:
            matches.sort(key=lambda f: (("turbo" not in f.lower()), len(f)))
            return matches[0]
    return ""


def suggest_audio_vae() -> str:
    """按名称线索挑 H3 音频 VAE（文件名同时含 h3 与 audio），无命中返回空串。"""
    try:
        files = sorted(folder_paths.get_filename_list("vae") or [])
    except Exception as e:
        logger.warning(f"[NeoNodes] video_gen: scan vae failed: {e}")
        return ""
    for f in files:
        low = f.lower()
        if "h3" in low and "audio" in low:
            return f
    return ""


def _video_display_sort(files: list) -> list:
    """下拉展示排序：H3 相关（文件名含 h3）靠前，其余按名称（不区分大小写）。与 image_gen._display_sort 同构。"""
    return sorted(files, key=lambda f: ("h3" not in f.lower(), f.lower()))


def scan_video_models() -> dict:
    """列出 H3 生视频可选模型（H3 相关靠前）与 LoRA，供前端设置面板展示。"""
    out = {}
    for folder in ("diffusion_models", "text_encoders", "vae", "loras"):
        try:
            files = sorted(folder_paths.get_filename_list(folder) or [])
        except Exception as e:
            logger.warning(f"[NeoNodes] video_gen: scan {folder} failed: {e}")
            files = []
        out[folder] = _video_display_sort(files)
    return out


@routes.get("/neo_video_gen/models")
async def video_models_route(request):
    return web.json_response(scan_video_models())


@routes.get("/neo_video_gen/settings")
async def get_video_settings_route(request):
    return web.json_response(get_video_settings())


@routes.post("/neo_video_gen/settings")
async def post_video_settings_route(request):
    try:
        patch = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    if not isinstance(patch, dict):
        return web.json_response({"error": "请求体不是对象"}, status=400)
    return web.json_response(save_video_settings(patch))