# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - LLM (Large Language Model)
# LLM 公共代码模块，支持本地模型和远程 API

from __future__ import annotations

import os
import re
import json
import logging
import asyncio
import base64
import io
import hashlib
import socket
from typing import Any, Dict, List, Optional, Generator
from pathlib import Path
import folder_paths
from collections import OrderedDict

# ==========================================
# HuggingFace Endpoint Configuration
# ==========================================
# Allow override via environment variable, default to official HuggingFace endpoint
hf_endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co")
os.environ["HF_ENDPOINT"] = hf_endpoint

# ==========================================
# LiteLLM Configuration
# ==========================================
# Use local model cost map to avoid network requests
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
# Use local tiktoken cache to avoid network requests
tiktoken_cache_dir = os.path.join(os.path.dirname(__file__), ".tiktoken_cache")
os.makedirs(tiktoken_cache_dir, exist_ok=True)
os.environ.setdefault("TIKTOKEN_CACHE_DIR", tiktoken_cache_dir)

logger = logging.getLogger(__name__)

# Pre-load tiktoken to avoid network requests (skip if network unavailable)
try:
    import tiktoken
    tiktoken.get_encoding("cl100k_base")
except Exception as e:
    logger.warning(f"Failed to pre-load tiktoken (network unavailable): {e}")

# ==========================================
# LLM Configuration & Management
# ==========================================

def _load_model_config(config_dir: str | None = None):
    """从 model_config.json 加载用户模型配置"""
    if config_dir is None:
        config_dir = _CONFIGS_DIR
    config_path = os.path.join(config_dir, "model_config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return config
    except Exception as e:
        logger.error(f"Failed to load model config: {e}")
        return {}

def _load_presets(config_dir: str | None = None):
    """从 model_presets.json 加载预设模型"""
    if config_dir is None:
        config_dir = _CONFIGS_DIR
    presets_path = os.path.join(config_dir, "model_presets.json")
    try:
        with open(presets_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load model presets: {e}")
        return {}

_CONFIGS_DIR: str = os.path.join(os.path.dirname(__file__), "configs")

_MODEL_CONFIG: Dict[str, Any] = _load_model_config(_CONFIGS_DIR)
_MODEL_PRESETS: Dict[str, Any] = _load_presets(_CONFIGS_DIR)

def get_model_config():
    """获取模型配置"""
    if not _MODEL_CONFIG:
        return {
            "model": {
                "ms_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "hf_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "filename": "Qwen3.5-0.8B-UD-Q4_K_XL.gguf"
            },
            "mmproj": {
                "filename": "mmproj-BF16.gguf"
            }
        }
    return _MODEL_CONFIG


# ==========================================
# Text Normalization Utility
# ==========================================

def _normalize_text(text):
    """标准化文本，用于缓存键的生成"""
    if not text:
        return ""
    text = text.strip()
    text = re.sub(r'\s+', ' ', text)
    return text


# ==========================================
# Translation Cache Configuration
# ==========================================

class TranslationCache:
    """翻译缓存，支持双向缓存和自动淘汰"""
    
    _KEY_TEXT = "T:"
    _KEY_RESULT = "R:"
    
    def __init__(self, max_size=200):
        self._store = OrderedDict()
        self.max_size = max_size
    
    def get(self, text):
        normalized = _normalize_text(text)
        result = self._store.get(f"{self._KEY_TEXT}{normalized}")
        if result:
            return result
        return self._store.get(f"{self._KEY_RESULT}{normalized}")
    
    def set(self, text, result):
        normalized_text = _normalize_text(text)
        normalized_result = _normalize_text(result)
        
        text_key = f"{self._KEY_TEXT}{normalized_text}"
        result_key = f"{self._KEY_RESULT}{normalized_result}"
        
        if text_key in self._store:
            del self._store[text_key]
        if result_key in self._store:
            del self._store[result_key]
        
        self._store[text_key] = normalized_result
        self._store[result_key] = normalized_text
        
        while len(self._store) > self.max_size:
            self._evict_oldest()
    
    def _evict_oldest(self):
        if not self._store:
            return
        oldest_key = next(iter(self._store))
        self._store.pop(oldest_key)
        logger.info(f"Cache full, evicted oldest entry: '{oldest_key[:20]}...'")
    
    def size(self):
        return len(self._store)
    
    def clear(self):
        self._store.clear()


# 全局翻译缓存实例
TRANSLATION_CACHE = TranslationCache(max_size=200)


# ==========================================
# Remote LLM Configuration
# ==========================================

_REMOTE_CONFIG_PATH = os.path.join(_CONFIGS_DIR, "remote_llm_config.json")

# 各远程 provider 的独立默认配置，切换 provider 时互不影响
_REMOTE_PROVIDER_DEFAULTS = {
    "openai": {
        "api_key": "",
        "base_url": "",
        "model": "gpt-4o-mini",
        "max_tokens": 500,
        "temperature": 0.0,
        "timeout": 60,
    },
    "lmstudio": {
        "api_key": "",
        "base_url": "http://localhost:1234/v1",
        "model": "",
        "max_tokens": 500,
        "temperature": 0.0,
        "timeout": 60,
    },
    "ollama": {
        "api_key": "",
        "base_url": "http://localhost:11430/v1",
        "model": "",
        "max_tokens": 500,
        "temperature": 0.0,
        "timeout": 60,
    },
}


def _default_remote_config() -> Dict[str, Any]:
    """默认远程配置：按 provider 分槽存储，互不覆盖"""
    return {
        "enabled": False,
        "active_provider": "openai",
        "auto_unload_local": False,
        "providers": {key: dict(defaults) for key, defaults in _REMOTE_PROVIDER_DEFAULTS.items()},
    }


def _migrate_remote_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """兼容旧版扁平配置格式，迁移为按 provider 分槽存储"""
    providers = config.get("providers")
    if isinstance(providers, dict):
        # 已是最新格式，补齐缺失的 provider 槽位
        for key, defaults in _REMOTE_PROVIDER_DEFAULTS.items():
            providers.setdefault(key, dict(defaults))
        config.setdefault("enabled", False)
        config.setdefault("auto_unload_local", False)
        active = config.get("active_provider") or "openai"
        if active not in _REMOTE_PROVIDER_DEFAULTS:
            active = "openai"
        config["active_provider"] = active
        return config

    # 旧格式：单 provider 扁平结构
    new = _default_remote_config()
    new["auto_unload_local"] = bool(config.get("auto_unload_local", False))
    new["enabled"] = bool(config.get("enabled", False))
    provider = config.get("provider", "openai")
    if provider not in _REMOTE_PROVIDER_DEFAULTS:
        # 旧配置可能把远程连接信息放在 "local" 下，按 base_url 推断归属
        base_url = str(config.get("base_url", "") or "")
        if "1234" in base_url:
            provider = "lmstudio"
        elif "11430" in base_url or "11434" in base_url:
            provider = "ollama"
        else:
            provider = "openai"
        new["enabled"] = False
        new["active_provider"] = provider
    # LM Studio / Ollama 的 model 只能来自服务端模型列表，不能迁移旧的 OpenAI 默认值
    for key in ("api_key", "base_url", "max_tokens", "temperature", "timeout"):
        if key in config:
            new["providers"][provider][key] = config[key]
    if provider == "openai" and "model" in config:
        new["providers"][provider]["model"] = config["model"]
    return new


def _get_active_remote_config() -> Dict[str, Any]:
    """返回当前激活 provider 的扁平配置（含 provider/enabled 字段），供远程推理使用"""
    config = _load_remote_config()
    provider = config.get("active_provider", "openai")
    slot = config.get("providers", {}).get(provider)
    merged = dict(_REMOTE_PROVIDER_DEFAULTS.get(provider, {}))
    if isinstance(slot, dict):
        merged.update(slot)
    merged["provider"] = provider
    merged["enabled"] = bool(config.get("enabled", False))
    return merged



def _load_remote_config() -> Dict[str, Any]:
    """加载远程 LLM 配置"""
    try:
        if os.path.exists(_REMOTE_CONFIG_PATH):
            with open(_REMOTE_CONFIG_PATH, "r", encoding="utf-8") as f:
                return _migrate_remote_config(json.load(f))
    except Exception as e:
        logger.error(f"Failed to load remote LLM config: {e}")
    return _default_remote_config()

def _save_remote_config(config: Dict[str, Any]):
    """保存远程 LLM 配置"""
    try:
        with open(_REMOTE_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info("Remote LLM config saved")
    except Exception as e:
        logger.error(f"Failed to save remote LLM config: {e}")

def get_remote_llm_config() -> Dict[str, Any]:
    """获取远程 LLM 配置"""
    return _load_remote_config()

def set_remote_llm_config(config: Dict[str, Any]):
    """设置远程 LLM 配置"""
    if isinstance(config.get("providers"), dict):
        # 完整结构：合并保存
        merged = _load_remote_config()
        merged.update(config)
        _save_remote_config(_migrate_remote_config(merged))
        return

    # 扁平结构：只更新对应 provider 的槽位，不影响其它 provider
    current = _load_remote_config()
    provider = config.get("provider")
    if provider in current.get("providers", {}):
        slot = current["providers"][provider]
        for key in ("base_url", "model", "max_tokens", "temperature", "timeout"):
            if key in config:
                slot[key] = config[key]
        if config.get("api_key"):
            slot["api_key"] = config["api_key"]
        if config.get("enabled"):
            current["enabled"] = True
            current["active_provider"] = provider
        else:
            current["enabled"] = False
        if "auto_unload_local" in config:
            current["auto_unload_local"] = bool(config["auto_unload_local"])
        _save_remote_config(current)
        logger.info(f"Remote LLM provider '{provider}' config updated")
        return

    # provider 为 local 或未知：只更新启用状态
    current["enabled"] = bool(config.get("enabled", current.get("enabled", False)))
    _save_remote_config(current)

# 远程 LLM 模式常量
LLM_MODE_LOCAL = "local"
LLM_MODE_REMOTE = "remote"

def get_current_mode() -> str:
    """获取当前 LLM 模式：local 或 remote（基于 provider 值判断）"""
    config = _load_remote_config()
    if config.get("enabled") and config.get("active_provider") in _REMOTE_PROVIDER_DEFAULTS:
        return LLM_MODE_REMOTE
    return LLM_MODE_LOCAL


# ==========================================
# Model-Specific System Prompts (for remote mode)
# ==========================================

_TASK_MODEL_CONFIGS = {
    "extract_title": {"max_tokens": 20, "model_override": None},
    "extract_classify": {"max_tokens": 50, "model_override": None},
    "enhance_prompt": {"max_tokens": 500, "model_override": None},
    "translate_prompt": {"max_tokens": 500, "model_override": None},
}

def get_task_config(task_name: str) -> Dict[str, Any]:
    """获取任务配置"""
    return _TASK_MODEL_CONFIGS.get(task_name, {"max_tokens": 500, "model_override": None})


# ==========================================
# Model Config Helpers (presets + user config)
# ==========================================

def _get_all_models() -> Dict[str, Any]:
    """合并预设模型和用户自定义模型（用户模型覆盖预设）"""
    return {**_MODEL_PRESETS, **_MODEL_CONFIG.get("models", {})}


def _get_current_model_cfg() -> Dict[str, Any]:
    """获取当前模型的配置"""
    all_models = _get_all_models()
    current_key = _MODEL_CONFIG.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"
    if current_key in all_models:
        return all_models[current_key]
    first_key = list(all_models.keys())[0] if all_models else ""
    return all_models.get(first_key, {})


def scan_llm_directory() -> List[Dict[str, str]]:
    """扫描 models/LLM/ 目录，发现所有 .gguf 文件，并自动补充到 model_config.json"""
    base_dir = folder_paths.base_path
    llm_dir = os.path.join(base_dir, "models", "LLM")
    discovered: List[Dict[str, str]] = []
    seen: set = set()

    if not os.path.isdir(llm_dir):
        return discovered

    for entry in sorted(os.listdir(llm_dir)):
        subdir = os.path.join(llm_dir, entry)
        if not os.path.isdir(subdir):
            continue
        for fname in sorted(os.listdir(subdir)):
            if fname.lower().endswith(".gguf"):
                key = f"{entry}/{fname.replace('.gguf', '')}"
                if key in seen:
                    continue
                seen.add(key)
                discovered.append({
                    "key": key,
                    "name": key,
                    "filename": fname,
                    "model_dir": entry,
                })
                _ensure_model_in_config(key, entry, fname)
    return discovered


def _ensure_model_in_config(model_key: str, model_dir: str, filename: str) -> None:
    """将扫描发现的模型自动写入 model_config.json（如果尚未存在）"""
    global _MODEL_CONFIG
    models: Dict[str, Any] = _MODEL_CONFIG.get("models", {})
    if model_key not in models:
        models[model_key] = {
            "ms_repo_id": "",
            "hf_repo_id": "",
            "filename": filename,
            "model_dir": model_dir,
        }
        _save_model_config()
        logger.info(f"Auto-added model to config: {model_key}")


def unload_local_model():
    """卸载本地 LLM 模型（释放显存）"""
    global LLMSingleton
    if LLMSingleton._instance is not None:
        try:
            if hasattr(LLMSingleton._instance, 'model') and LLMSingleton._instance.model is not None:
                del LLMSingleton._instance.model
            LLMSingleton._instance = None
            logger.info("Local LLM model unloaded successfully")
            return {"success": True, "message": "Model unloaded"}
        except Exception as e:
            logger.error(f"Failed to unload local model: {e}")
            return {"success": False, "error": str(e)}
    logger.info("No local model loaded, nothing to unload")
    return {"success": True, "message": "No model was loaded"}


def __reload_llm_singleton():
    """销毁并重建 LLM 单例，以加载新模型"""
    global LLMSingleton
    LLMSingleton._instance = None


def set_current_model(model_key: str) -> bool:
    """设置当前模型（支持预设模型和用户自定义模型）"""
    global _MODEL_CONFIG
    all_models = _get_all_models()

    if model_key not in all_models:
        parts = model_key.split("/", 1)
        if len(parts) == 2:
            model_dir, filename = parts
            _ensure_model_in_config(model_key, model_dir, filename)
            _MODEL_CONFIG = _read_model_config_from_file() or _MODEL_CONFIG
            all_models = _get_all_models()

    if model_key in all_models:
        _MODEL_CONFIG["current_model"] = model_key
        _save_model_config()
        __reload_llm_singleton()
        return True
    return False


def _save_model_config():
    """保存用户模型配置到文件"""
    config_path = os.path.join(_CONFIGS_DIR, "model_config.json")
    try:
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(_MODEL_CONFIG, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save model config: {e}")


def _read_model_config_from_file():
    """从文件重新读取用户模型配置（用于运行时动态获取最新配置）"""
    config_path = os.path.join(_CONFIGS_DIR, "model_config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read model config from file: {e}")
        return {}


def get_available_models() -> Dict[str, Any]:
    """获取所有可用模型列表（合并预设 + 用户自定义 + 目录扫描）"""
    global _MODEL_CONFIG
    config = _read_model_config_from_file()
    if config:
        _MODEL_CONFIG.clear()
        _MODEL_CONFIG.update(config)

    all_models = _get_all_models()
    model_list: List[Dict[str, str]] = []
    seen_keys: set = set()

    for key, cfg in all_models.items():
        cfg_dict: Dict[str, Any] = cfg  # type: ignore[assignment]
        model_list.append({
            "key": key,
            "name": key,
            "filename": cfg_dict.get("filename", ""),
            "model_dir": cfg_dict.get("model_dir", ""),
        })
        seen_keys.add(key)

    scanned = scan_llm_directory()
    for item in scanned:
        if item["key"] not in seen_keys:
            model_list.append({
                "key": item["key"],
                "name": item["name"],
                "filename": item["filename"],
                "model_dir": item["model_dir"],
            })
            seen_keys.add(item["key"])

    return {
        "current_model": _MODEL_CONFIG.get("current_model", "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"),
        "models": model_list,
    }


# ==========================================
# Download Status Management (for local mode)
# ==========================================

import threading

_download_status = {
    "model": {"downloading": False, "progress": 0, "error": None},
    "mmproj": {"downloading": False, "progress": 0, "error": None}
}
_download_lock = threading.Lock()

def get_model_paths():
    """获取模型文件路径 - 每次都从文件读取最新配置"""
    config = _read_model_config_from_file()
    if not config:
        config = _MODEL_CONFIG

    all_models = _get_all_models()
    current_model_key: str = config.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"

    model_cfg = all_models.get(current_model_key, {})

    MODEL_FILENAME = model_cfg.get("filename", "")
    MODEL_DIR = model_cfg.get("model_dir", "Qwen-0.8B")

    base_dir = folder_paths.base_path
    model_dir = os.path.join(base_dir, "models", "LLM", MODEL_DIR)
    target_path = os.path.join(model_dir, MODEL_FILENAME)

    MMPROJ_FILENAME = config.get("mmproj", {}).get("filename", "mmproj-BF16.gguf")
    mmproj_path = os.path.join(model_dir, MMPROJ_FILENAME)
    return target_path, mmproj_path

def check_model_status():
    """检查模型文件是否存在，返回状态信息"""
    target_path, mmproj_path = get_model_paths()

    model_exists = os.path.exists(target_path)
    mmproj_exists = os.path.exists(mmproj_path)

    config = _read_model_config_from_file()
    if not config:
        config = _MODEL_CONFIG

    all_models = _get_all_models()
    current_model_key: str = config.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"
    model_cfg = all_models.get(current_model_key, {})

    MS_REPO_ID = model_cfg.get("ms_repo_id", "")
    HF_REPO_ID = model_cfg.get("hf_repo_id", "")
    MODEL_FILENAME = model_cfg.get("filename", "")
    MMPROJ_FILENAME = config.get("mmproj", {}).get("filename", "mmproj-BF16.gguf")

    if _download_status["model"]["downloading"]:
        logger.info(f"Download status check: downloading={_download_status['model']['downloading']}, "
                    f"progress={_download_status['model']['progress']}%, "
                    f"model_exists={model_exists}, target_path={target_path}")

    return {
        "model_available": model_exists,
        "mmproj_available": mmproj_exists,
        "model_filename": MODEL_FILENAME,
        "mmproj_filename": MMPROJ_FILENAME,
        "model_repo_id": MS_REPO_ID,
        "hf_repo_id": HF_REPO_ID,
        "model_path": target_path if model_exists else None,
        "mmproj_path": mmproj_path if mmproj_exists else None,
        "download_status": _download_status
    }

def check_all_models_status():
    """检查所有模型文件的状态（合并预设 + 用户自定义 + 目录扫描）"""
    base_dir = folder_paths.base_path
    all_models = _get_all_models()

    models_status: List[Dict[str, Any]] = []
    seen_keys: set = set()

    for key, config in all_models.items():
        config_dict: Dict[str, Any] = config  # type: ignore[assignment]
        model_dir: str = config_dict.get("model_dir", "")
        filename: str = config_dict.get("filename", "")

        model_path = os.path.join(base_dir, "models", "LLM", model_dir, filename)
        exists = os.path.exists(model_path)

        models_status.append({
            "key": key,
            "name": key,
            "filename": filename,
            "model_dir": model_dir,
            "available": exists
        })
        seen_keys.add(key)

    # 补充扫描目录中发现但尚未在配置中的模型
    scanned = scan_llm_directory()
    for item in scanned:
        if item["key"] not in seen_keys:
            model_path = os.path.join(base_dir, "models", "LLM", item["model_dir"], item["filename"])
            models_status.append({
                "key": item["key"],
                "name": item["name"],
                "filename": item["filename"],
                "model_dir": item["model_dir"],
                "available": os.path.exists(model_path)
            })
            seen_keys.add(item["key"])

    return {
        "models": models_status,
        "current_model": _MODEL_CONFIG.get("current_model", "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL")
    }

def start_download(file_type):
    """启动后台下载任务（非阻塞）"""
    if file_type not in ["model", "mmproj"]:
        return {"error": "Invalid file type"}

    target_path, _ = get_model_paths()
    if file_type == "model" and os.path.exists(target_path):
        return {"status": "already_exists"}

    _, mmproj_path = get_model_paths()
    if file_type == "mmproj" and os.path.exists(mmproj_path):
        return {"status": "already_exists"}

    thread = threading.Thread(target=_download_file_background, args=(file_type,), daemon=True)
    thread.start()

    return {"status": "started", "file_type": file_type}

def _download_file_background(file_type):
    """后台下载文件（在独立线程中运行）"""
    global _download_status

    with _download_lock:
        if _download_status[file_type]["downloading"]:
            logger.warning(f"Download already in progress for {file_type}")
            return False

        _download_status[file_type]["downloading"] = True
        _download_status[file_type]["progress"] = 0
        _download_status[file_type]["error"] = None

    try:
        base_dir = folder_paths.base_path

        if file_type == "model":
            all_models = _get_all_models()
            config = _read_model_config_from_file()
            if not config:
                config = _MODEL_CONFIG
            current_model_key: str = config.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"
            model_cfg = all_models.get(current_model_key, {})
            filename = model_cfg.get("filename", "")
            MODEL_DIR = model_cfg.get("model_dir", "Qwen-0.8B")
            MS_REPO_ID = model_cfg.get("ms_repo_id", "")
            HF_REPO_ID = model_cfg.get("hf_repo_id", "")
        else:
            filename = _MODEL_CONFIG.get("mmproj", {}).get("filename", "")
            all_models = _get_all_models()
            current_model_key = _MODEL_CONFIG.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"
            model_cfg = all_models.get(current_model_key, {})
            MODEL_DIR = model_cfg.get("model_dir", "Qwen-0.8B")
            MS_REPO_ID = ""
            HF_REPO_ID = ""

        model_dir = os.path.join(base_dir, "models", "LLM", MODEL_DIR)
        os.makedirs(model_dir, exist_ok=True)

        target_path = os.path.join(model_dir, filename)

        if os.path.exists(target_path):
            _download_status[file_type]["downloading"] = False
            _download_status[file_type]["progress"] = 100
            logger.info(f"File already exists: {target_path}")
            return True

        success = _download_from_modelscope(model_dir, filename, file_type, MS_REPO_ID)
        if not success:
            logger.info("ModelScope download failed, trying HuggingFace...")
            success = _download_from_huggingface(model_dir, filename, file_type, HF_REPO_ID)

        if success:
            _download_status[file_type]["progress"] = 100
            _download_status[file_type]["downloading"] = False
            logger.info(f"Download complete: {target_path}")
            return True
        else:
            _download_status[file_type]["error"] = "Both ModelScope and HuggingFace downloads failed"
            _download_status[file_type]["downloading"] = False
            logger.error("All download attempts failed")
            return False
    except Exception as e:
        _download_status[file_type]["error"] = str(e)
        _download_status[file_type]["downloading"] = False
        logger.error(f"Download failed: {e}")
        return False

def _download_from_modelscope(model_dir, filename, file_type, ms_repo_id):
    """从 ModelScope 下载模型"""
    try:
        if not ms_repo_id:
            return False
        logger.info(f"Attempting download from ModelScope...")
        from modelscope import snapshot_download

        target_path = os.path.join(model_dir, filename)

        download_path = snapshot_download(
            ms_repo_id,
            allow_patterns=[filename],
            local_dir=model_dir,
            revision='master',
        )

        if os.path.exists(target_path):
            _download_status[file_type]["progress"] = 100
            logger.info(f"Downloaded from ModelScope: {target_path}")
            return True
        else:
            logger.warning("ModelScope download did not create expected file")
            return False
    except ImportError:
        logger.warning("modelscope not installed, trying HuggingFace...")
        return False
    except Exception as e:
        logger.error(f"ModelScope download failed: {e}")
        return False

def _download_from_huggingface(model_dir, filename, file_type, hf_repo_id):
    """从 HuggingFace 下载模型"""
    try:
        if not hf_repo_id:
            return False
        logger.info(f"Attempting download from HuggingFace...")
        from huggingface_hub import hf_hub_download

        target_path = os.path.join(model_dir, filename)

        downloaded_path = hf_hub_download(
            repo_id=hf_repo_id,
            filename=filename,
            local_dir=model_dir,
            force_download=False,
        )

        _download_status[file_type]["progress"] = 100
        logger.info(f"Downloaded from HuggingFace: {downloaded_path}")
        return True
    except Exception as e:
        logger.error(f"HuggingFace download failed: {e}")
        return False


# ==========================================
# Remote API LLM Client (requests)
# ==========================================

class RemoteLLMClient:
    """基于 requests 的远程 LLM 客户端，直接调用 OpenAI 兼容 API"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.provider = config.get("provider", "openai")
        self.api_key = config.get("api_key", "")
        self.base_url = config.get("base_url", "")
        self.model = config.get("model", "gpt-4o-mini")
        self.max_tokens = config.get("max_tokens", 500)
        self.temperature = config.get("temperature", 0.0)
        self.timeout = config.get("timeout", 60)

    def _add_images_to_messages(self, messages: List[Dict[str, Any]],
                                 image_bytes_list: List[bytes]) -> List[Dict[str, Any]]:
        """将图片添加到 user message 中"""
        result = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if image_bytes_list and isinstance(content, str) and role == "user":
                content_parts = []
                for img_bytes in image_bytes_list:
                    b64 = base64.b64encode(img_bytes).decode('utf-8')
                    content_parts.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}
                    })
                content_parts.append({"type": "text", "text": content})
                content = content_parts

            result.append({"role": role, "content": content})
        return result

    def chat_completion(self, messages: List[Dict[str, Any]],
                        max_tokens: Optional[int] = None,
                        image_bytes_list: Optional[List[bytes]] = None,
                        stream: bool = False) -> Any:
        """
        发送聊天补全请求

        Args:
            messages: 消息列表
            max_tokens: 最大 token 数
            image_bytes_list: 图片字节列表
            stream: 是否流式输出

        Returns:
            非流式：返回响应字典；流式：返回生成器
        """
        import requests

        effective_max_tokens = max_tokens or self.max_tokens

        # 处理图片
        if image_bytes_list:
            messages = self._add_images_to_messages(messages, image_bytes_list)

        # 构建请求 URL
        if self.base_url:
            base = self.base_url.rstrip('/')
            if not base.endswith('/v1'):
                base = f"{base}/v1"
            url = f"{base}/chat/completions"
        else:
            url = "https://api.openai.com/v1/chat/completions"

        # 构建请求头
        headers = {
            "Content-Type": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        # 构建请求体
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": effective_max_tokens,
            "temperature": self.temperature,
            "stream": stream,
        }

        logger.info(f"Sending request to remote LLM: url={url}, stream={stream}")

        try:
            if stream:
                return self._stream_response_generator(url, headers, payload)
            else:
                response = requests.post(url, headers=headers, json=payload, timeout=self.timeout)
                response.raise_for_status()
                return self._parse_response(response.json())
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"Remote LLM connection error: {e}")
            raise RuntimeError(f"Remote LLM network error: {e}")
        except requests.exceptions.Timeout as e:
            logger.warning(f"Remote LLM timeout: {e}")
            raise RuntimeError(f"Remote LLM timeout: {e}")
        except requests.exceptions.HTTPError as e:
            logger.error(f"Remote LLM HTTP error: {e}")
            raise RuntimeError(f"Remote LLM HTTP error: {e}")
        except Exception as e:
            logger.error(f"Remote LLM completion failed: {e}")
            raise

    def _parse_response(self, response_data: Dict[str, Any]) -> Dict[str, Any]:
        """解析响应为统一格式"""
        choices = response_data.get("choices", [])
        if not choices:
            return {"choices": []}
        
        message = choices[0].get("message", {})
        content = message.get("content", "")
        return {
            "choices": [{
                "message": {"role": message.get("role", "assistant"), "content": content}
            }]
        }

    def _stream_response_generator(self, url: str, headers: Dict[str, str], payload: Dict[str, Any]):  # type: ignore[misc, empty-body]
        """流式响应生成器"""
        import requests

        with requests.post(url, headers=headers, json=payload, stream=True, timeout=self.timeout) as response:
            response.raise_for_status()
            full_content = []
            for line in response.iter_lines():
                if line:
                    line = line.decode('utf-8')
                    if line.startswith('data: '):
                        data = line[6:]
                        if data == '[DONE]':
                            break
                        try:
                            chunk = json.loads(data)
                            choices = chunk.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    full_content.append(content)
                                    yield content
                        except json.JSONDecodeError:
                            pass
        return "".join(full_content)

    def is_available(self) -> bool:
        """检查客户端是否可用"""
        if not self.provider:
            return False
        # 本地提供商（ollama, lmstudio, llamacpp, vllm）不需要 API key
        local_providers = {"ollama", "lmstudio", "llamacpp", "vllm"}
        if self.provider not in local_providers and not self.api_key:
            return False
        return True


# ==========================================
# LLM Singleton (Local Mode)
# ==========================================

class LLMSingleton:
    """LLM 单例模式，确保模型只加载一次（本地模式）"""
    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.model = None
        self.has_mmproj = False
        self._load_model()

    def _load_model(self):
        """加载 LLM 模型，如果不存在则报错"""
        target_path, mmproj_path = get_model_paths()

        model_dir = os.path.dirname(target_path)
        os.makedirs(model_dir, exist_ok=True)

        logger.info(f"Loading LLM model: {target_path}")
        logger.info(f"mmproj path: {mmproj_path}")

        if not os.path.exists(target_path):
            config = _read_model_config_from_file()
            if not config:
                config = _MODEL_CONFIG

            all_models = _get_all_models()
            current_model_key: str = config.get("current_model", "") or "Qwen-0.8B/Qwen3.5-0.8B-UD-Q4_K_XL"
            model_cfg = all_models.get(current_model_key, {})

            MODEL_FILENAME = model_cfg.get("filename", "unknown.gguf")
            raise RuntimeError(
                f"LLM model not found: {MODEL_FILENAME}\n"
                f"Expected path: {target_path}\n"
                f"Please download the model and place it in: {model_dir}/\n"
                f"Or switch to remote API mode in the node settings."
            )

        if not os.path.exists(mmproj_path):
            MMPROJ_FILENAME = _MODEL_CONFIG.get("mmproj", {}).get("filename", "")
            logger.warning(
                f"mmproj file not found: {mmproj_path}. "
                f"Image understanding will not work."
            )
            mmproj_path = None

        from llama_cpp import Llama

        logger.info(f"Initializing Llama with n_ctx=2048, n_threads=4, n_gpu_layers=-1")
        llama_kwargs = {
            "model_path": target_path,
            "n_ctx": 2048,
            "n_threads": 4,
            "n_gpu_layers": -1,
            "verbose": False,
        }

        if mmproj_path:
            logger.info(f"Loading mmproj file: {mmproj_path}")
            llama_kwargs["mmproj"] = mmproj_path
            self.mmproj_path = mmproj_path
        else:
            logger.warning("No mmproj file found, loading text-only model.")

        self.model = Llama(**llama_kwargs)
        self.has_mmproj = mmproj_path is not None
        logger.info(f"LLM model loaded successfully, has_mmproj={self.has_mmproj}")

    def create_chat_completion(self, messages, max_tokens, image_bytes_list=None, stream=False):
        """创建聊天补全请求，支持图像输入和流式输出"""
        if self.model is None:
            raise RuntimeError("LLM Model not loaded")

        if image_bytes_list and len(image_bytes_list) > 0:
            new_messages = []
            for msg in messages:
                if msg.get("role") == "user":
                    content_list = []
                    for img_bytes in image_bytes_list:
                        if isinstance(img_bytes, (bytes, bytearray)):
                            b64 = base64.b64encode(img_bytes).decode('utf-8')
                            data_uri = f"data:image/png;base64,{b64}"
                        elif isinstance(img_bytes, str):
                            data_uri = img_bytes
                        else:
                            continue
                        content_list.append({"type": "image_url", "image_url": {"url": data_uri}})
                    content_list.append({"type": "text", "text": msg.get("content", "")})
                    new_messages.append({"role": "user", "content": content_list})
                else:
                    new_messages.append(msg)
            messages = new_messages

        return self.model.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            stream=stream,
        )


def get_llm_instance():
    """获取 LLM 单例实例（本地模式）"""
    return LLMSingleton.get_instance()


# ==========================================
# Unified LLM Inference Engine
# ==========================================

def _run_llm_inference(system_prompt: str, user_text: str, max_tokens: int,
                       images: Optional[Any] = None, use_remote: bool = False,
                       stream: bool = False) -> Any:  # type: ignore[return-type]
    """
    执行 LLM 推理，支持本地和远程模式

    Args:
        system_prompt: 系统提示词
        user_text: 用户文本
        max_tokens: 最大 token 数
        images: PIL Image 对象列表或字节数据列表（仅本地模式支持）
        use_remote: 是否使用远程 API
        stream: 是否流式输出

    Returns:
        非流式：LLM 响应文本；流式：返回生成器
    """
    if use_remote:
        result = _run_remote_inference(system_prompt, user_text, max_tokens, images, stream=stream)
        if result is not None:
            return result
        logger.warning("Remote LLM failed, falling back to local mode")
        return _run_local_inference(system_prompt, user_text, max_tokens, images, stream=stream)
    else:
        return _run_local_inference(system_prompt, user_text, max_tokens, images, stream=stream)


def _run_local_inference(system_prompt: str, user_text: str, max_tokens: int,
                         images: Optional[Any] = None, stream: bool = False) -> Any:  # type: ignore[return-type]
    """执行本地 LLM 推理"""
    llm = get_llm_instance()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text}
    ]

    try:
        image_bytes_list = None
        if images is not None and len(images) > 0:
            image_bytes_list = []
            for img in images:
                if hasattr(img, 'tobytes'):
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_bytes_list.append(buffer.getvalue())
                elif isinstance(img, (bytes, bytearray)):
                    image_bytes_list.append(img)
                elif hasattr(img, 'read'):
                    image_bytes_list.append(img.read())

        output = llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            image_bytes_list=image_bytes_list,
            stream=stream,
        )

        if stream:
            return output  # 返回生成器

        if not isinstance(output, dict):
            logger.warning(f"LLM returned non-dict output: {type(output)}")
            return None

        choices = output.get('choices')
        if not isinstance(choices, list) or len(choices) == 0:
            logger.warning("LLM response 'choices' is empty or invalid.")
            return None

        message = choices[0].get('message', {})
        content = message.get('content', '')

        if not content:
            logger.warning("LLM 'content' is None.")
            return ""

        return content.strip()
    except Exception as e:
        logger.exception(f"Error during local LLM inference: {e}")
        return None


def _run_remote_inference(system_prompt: str, user_text: str, max_tokens: int,
                          images: Optional[Any] = None, stream: bool = False) -> Any:  # type: ignore[return-type]
    """执行远程 LLM 推理"""
    config = _get_active_remote_config()

    if not config.get("enabled", False):
        raise RuntimeError("Remote LLM is not enabled. Please configure remote_llm_config.json")

    client = RemoteLLMClient(config)

    if not client.is_available():
        raise RuntimeError("Remote LLM client is not available (missing API key or provider)")

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text}
    ]

    try:
        image_bytes_list = None
        if images is not None and len(images) > 0:
            image_bytes_list = []
            for img in images:
                if hasattr(img, 'tobytes'):
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_bytes_list.append(buffer.getvalue())
                elif isinstance(img, (bytes, bytearray)):
                    image_bytes_list.append(img)
                elif hasattr(img, 'read'):
                    image_bytes_list.append(img.read())

        logger.info(f"Sending request to remote LLM: provider={client.provider}, model={client.model}")
        response = client.chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            image_bytes_list=image_bytes_list,
            stream=stream,
        )

        if stream:
            return response  # 返回生成器

        logger.info(f"Remote LLM response received")
        choices = response.get("choices", [])
        if not choices:
            logger.warning("Remote LLM response 'choices' is empty.")
            return ""

        message = choices[0].get("message", {})
        content = message.get("content", "")

        return content.strip() if content else ""
    except (RuntimeError, OSError, socket.gaierror) as e:
        # 网络相关错误已在上层捕获，直接返回
        logger.warning(f"Remote LLM inference failed (network): {e}")
        return None
    except Exception as e:
        logger.exception(f"Error during remote LLM inference: {e}")
        return None


# ==========================================
# Language Detection Utility
# ==========================================

def _detect_language(text):
    """检测文本语言"""
    if not text:
        return 'English'

    total_chars = len(text)
    if total_chars == 0:
        return 'English'

    chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
    chinese_percentage = (chinese_chars / total_chars) * 100

    if chinese_percentage >= 50:
        return 'Chinese'
    return 'English'


# ==========================================
# LLM Task Definitions - Load from template files
# ==========================================

_TASKS_DIR = os.path.join(os.path.dirname(__file__), "prompts", "templates", "tasks")

def _load_task_template(task_name: str) -> Dict[str, Any]:
    """Load task template from YAML file."""
    filepath = os.path.join(_TASKS_DIR, f"{task_name}.yaml")
    if not os.path.exists(filepath):
        # Fallback to .yml extension
        filepath = os.path.join(_TASKS_DIR, f"{task_name}.yml")
        if not os.path.exists(filepath):
            logger.warning(f"Task template not found: {task_name}")
            return {}
    
    try:
        import yaml
        with open(filepath, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
            return data or {}
    except ImportError:
        logger.warning(f"PyYAML not installed, cannot load task template: {task_name}")
        return {}
    except Exception as e:
        logger.warning(f"Error loading task template {task_name}: {e}")
        return {}


def _build_llm_tasks() -> Dict[str, Any]:
    """Build LLM_TASKS from template files."""
    tasks = {}
    task_names = [
        "extract_title",
        "extract_classify",
        "translate_prompt",
        "smart_prompt",
        "template_prompt",
        "reverse_prompt"
    ]
    
    for task_name in task_names:
        template = _load_task_template(task_name)
        if template:
            tasks[task_name] = {
                "system": template.get("content", ""),
                "max_tokens": template.get("max_tokens", 500),
                "result_key": template.get("result_key", "prompt"),
                "description": template.get("description", ""),
                "multi_result": template.get("multi_result"),
            }
        else:
            logger.warning(f"Failed to load task template: {task_name}")
    
    return tasks


# LLM_TASKS is now dynamically loaded from template files
LLM_TASKS = _build_llm_tasks()


DEFAULT_MULTI_SEPARATOR = "\n---\n"


def resolve_multi_result(text: str, rule: Optional[Dict[str, Any]] = None) -> List[str]:
    """按 skill 的 multi_result 输出契约把 LLM 文本拆分为提示词列表。

    rule 为 None 表示该 skill 未声明多结果，返回空列表（调用方回退为整段文本）。

    rule 格式（来自任务/模板 YAML 的 multi_result 字段）：
      {"format": "separator", "separator": "\n---\n"}   按分隔符拆分（默认分隔符）
      {"format": "json_array"}                            按 JSON 数组解析，失败回退分隔符
    """
    if not text or not text.strip():
        return []
    if not rule:
        return []

    fmt = str(rule.get("format", "separator"))
    candidates: List[str] = []

    if fmt == "json_array":
        try:
            data = json.loads(text)
        except Exception:
            data = None
        if isinstance(data, list):
            candidates = [str(x) for x in data]
        elif isinstance(data, dict):
            for value in data.values():
                if isinstance(value, list):
                    candidates = [str(x) for x in value]
                    break

    if not candidates:
        sep = str(rule.get("separator") or DEFAULT_MULTI_SEPARATOR)
        candidates = re.split(re.escape(sep), text)

    return [c.strip() for c in candidates if c and c.strip()]


# ==========================================
# Public LLM Task Runner
# ==========================================

def run_llm_task(task_name: str, text: str, extra_system_prompt: Optional[str] = None,
                 images: Optional[Any] = None, system_prompt: Optional[str] = None,
                 max_tokens_override: Optional[int] = None) -> Dict[str, Any]:
    """
    执行 LLM 任务

    Args:
        task_name: 任务名称，必须在 LLM_TASKS 中定义
        text: 输入文本
        extra_system_prompt: 额外的系统提示词（可选）
        images: 图像数据列表（可选，用于多模态任务）
        system_prompt: 完全自定义的系统提示词（可选，会覆盖默认系统提示词）

    Returns:
        dict: 包含 status 和结果的数据，或错误信息
    """
    if task_name not in LLM_TASKS:
        return {"error": f"Invalid task: {task_name}"}

    task_config = LLM_TASKS[task_name]

    # Debug logging
    logger.info(f"run_llm_task: task_name={task_name}, system_prompt provided={system_prompt is not None}, system_prompt_length={len(system_prompt) if system_prompt else 0}")

    # 如果提供了自定义 system_prompt（非空），使用它
    if system_prompt is not None and system_prompt.strip():
        # Use the provided system_prompt as-is
        logger.info(f"Using custom system_prompt (length: {len(system_prompt)})")
        pass
    # 如果没有提供 system_prompt，使用任务默认的
    elif system_prompt is None:
        system_prompt = task_config["system"]
        logger.info(f"Using default system_prompt (length: {len(system_prompt)})")
    # 如果是 template_prompt 且提供了空字符串，使用 extra_system_prompt
    elif task_name == "template_prompt" and extra_system_prompt:
        system_prompt = extra_system_prompt
        logger.info(f"Using extra_system_prompt for template_prompt (length: {len(system_prompt)})")
    # 否则使用任务默认的
    else:
        system_prompt = task_config["system"]
        logger.info(f"Using default system_prompt (fallback, length: {len(system_prompt)})")

    max_tokens = task_config["max_tokens"]
    if max_tokens_override:
        max_tokens = int(max_tokens_override)
    result_key = task_config["result_key"]

    use_remote = get_current_mode() == LLM_MODE_REMOTE

    if task_name == "translate_prompt":
        source_lang = _detect_language(text)

        if source_lang == 'Chinese':
            target_lang = 'English'
        else:
            target_lang = 'Chinese'

        system_prompt += f"\nTranslation Direction: {source_lang} to {target_lang}"
        logger.info(f"Auto-detected translation direction: {source_lang} -> {target_lang}")

        result = TRANSLATION_CACHE.get(text)
        if result:
            logger.info(f"Translation cache HIT for: '{text[:20]}...'")
            return {"status": "success", result_key: result}

    if extra_system_prompt and system_prompt is not None:
        system_prompt = system_prompt + extra_system_prompt

    try:
        result = _run_llm_inference(system_prompt, text, max_tokens, images=images, use_remote=use_remote)
    except Exception as e:
        logger.error(f"Failed to execute task {task_name}: {e}")
        return {"error": f"LLM inference failed: {str(e)}"}

    if not result:
        mode_str = "Remote API" if use_remote else "Local model"
        logger.warning(f"Failed to get response from {mode_str} for task: {task_name}")
        return {"error": f"failed to {task_name.replace('_', ' ')}"}

    if task_name == "translate_prompt":
        TRANSLATION_CACHE.set(text, result)
        logger.info(f"Saved result to cache: '{text[:20]}...' -> '{result[:20]}...'")

    logger.info(f"LLM task {task_name} completed: input='{text[:100]}...', output='{result[:100]}...'")
    return {"status": "success", result_key: result}


def run_llm_task_stream(task_name: str, text: str, extra_system_prompt: Optional[str] = None,
                        images: Optional[Any] = None, system_prompt: Optional[str] = None,
                        max_tokens_override: Optional[int] = None) -> Generator[str, None, None]:
    """
    流式执行 LLM 任务，返回生成器

    Args:
        task_name: 任务名称，必须在 LLM_TASKS 中定义
        text: 输入文本
        extra_system_prompt: 额外的系统提示词（可选，已废弃，请使用 system_prompt）
        images: 图像数据列表（可选，用于多模态任务）
        system_prompt: 完全自定义的系统提示词（可选，会覆盖默认系统提示词）

    Yields:
        str: 生成的文本块
    """
    if task_name not in LLM_TASKS:
        yield f"[ERROR] Invalid task: {task_name}"
        return

    task_config = LLM_TASKS[task_name]

    # 如果提供了自定义 system_prompt（非空），使用它
    if system_prompt is not None and system_prompt.strip():
        # Use the provided system_prompt as-is
        logger.info(f"run_llm_task_stream: Using custom system_prompt (length: {len(system_prompt)})")
        pass
    # 如果没有提供 system_prompt，使用任务默认的
    elif system_prompt is None:
        system_prompt = task_config["system"]
        logger.info(f"run_llm_task_stream: Using default system_prompt (length: {len(system_prompt)})")
    # 如果是 template_prompt 且提供了空字符串，使用 extra_system_prompt
    elif task_name == "template_prompt" and extra_system_prompt:
        system_prompt = extra_system_prompt
        logger.info(f"run_llm_task_stream: Using extra_system_prompt for template_prompt (length: {len(system_prompt)})")
    # 否则使用任务默认的
    else:
        system_prompt = task_config["system"]
        logger.info(f"run_llm_task_stream: Using default system_prompt (fallback, length: {len(system_prompt)})")

    max_tokens = task_config["max_tokens"]
    if max_tokens_override:
        max_tokens = int(max_tokens_override)

    use_remote = get_current_mode() == LLM_MODE_REMOTE

    if task_name == "translate_prompt":
        source_lang = _detect_language(text)
        if source_lang == 'Chinese':
            target_lang = 'English'
        else:
            target_lang = 'Chinese'
        system_prompt += f"\nTranslation Direction: {source_lang} to {target_lang}"

    # 兼容旧版：如果没有提供 system_prompt，但有 extra_system_prompt，追加到默认提示词
    # 注意：如果已经提供了 system_prompt，这个逻辑不会执行
    if extra_system_prompt and (system_prompt == task_config["system"]):
        system_prompt = system_prompt + extra_system_prompt

    try:
        result_gen = _run_llm_inference(system_prompt, text, max_tokens, images=images,
                                        use_remote=use_remote, stream=True)
        if hasattr(result_gen, '__iter__') and not isinstance(result_gen, str):
            for chunk in result_gen:
                # 提取 chunk 中的文本内容并逐字 yield
                if isinstance(chunk, dict):
                    choices = chunk.get("choices", [])
                    if choices and len(choices) > 0:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        # 逐字 yield，实现打字效果
                        for char in content:
                            yield char
                elif isinstance(chunk, str):
                    for char in chunk:
                        yield char
        else:
            yield result_gen or ""
    except Exception as e:
        logger.error(f"Failed to execute stream task {task_name}: {e}")
        yield f"[ERROR] {str(e)}"


# ==========================================
# API Handler Functions
# ==========================================

async def handle_llm_api_request(task_name, request):
    """
    处理 LLM API 请求

    Args:
        task_name: 任务名称
        request: 请求对象

    Returns:
        web.json_response: 响应对象
    """
    from aiohttp import web

    if task_name not in LLM_TASKS:
        return web.json_response({"error": "Invalid task"}, status=400)

    try:
        data = await request.json()
        text = data.get("text", "")

        logger.info(f"LLM API request: task={task_name}, text='{text[:100]}...'")

        if not text or not text.strip():
            return web.json_response({"error": "text content is empty"}, status=400)

        result_data = run_llm_task(task_name, text)

        if "error" in result_data:
            error_msg = result_data["error"]
            logger.warning(f"LLM API error: task={task_name}, error={error_msg}")

            if get_current_mode() == LLM_MODE_LOCAL and ("LLM model not found" in error_msg or "Model not loaded" in error_msg):
                return web.json_response({
                    "error": f"Local model is not available. Please download the model first, or switch to remote API mode."
                }, status=422)

            if get_current_mode() == LLM_MODE_REMOTE:
                return web.json_response({
                    "error": f"Remote API error: {error_msg}. Please check your remote_llm_config.json configuration."
                }, status=422)

            return web.json_response({"error": error_msg}, status=422)

        logger.info(f"LLM API response: task={task_name}, result='{result_data.get('prompt', result_data.get('enhanced', result_data.get('translated', '')))[:100]}...'")
        return web.json_response(result_data)

    except Exception as e:
        logger.error(f"Error handling LLM task {task_name}: {e}")
        logger.exception(e)
        return web.json_response({"error": str(e)}, status=500)


async def _load_template_content(template_id):
    """加载模板内容（仅支持 YAML 格式）"""
    if not template_id:
        return None

    from .prompts import (
        TEMPLATES_DIR, TEMPLATE_PRESETS_DIR, TEMPLATE_CUSTOM_DIR,
        _load_template_file
    )

    # 按优先级搜索模板文件（仅支持 YAML 格式）
    search_dirs = [TEMPLATE_CUSTOM_DIR, TEMPLATE_PRESETS_DIR]
    for base_dir in search_dirs:
        # 尝试 YAML 格式
        for ext in ['.yaml', '.yml']:
            filepath = os.path.join(base_dir, f"{template_id}{ext}")
            data = _load_template_file(filepath)
            if data and data.get("content"):
                return data["content"]

    logger.warning(f"Template not found or has no content: {template_id}")
    return None


async def handle_llm_api_stream(task_name, request):
    """
    处理流式 LLM API 请求（SSE）

    Args:
        task_name: 任务名称
        request: 请求对象

    Returns:
        web.Response: SSE 流式响应
    """
    from aiohttp import web

    if task_name not in LLM_TASKS:
        return web.Response(text="data: [ERROR] Invalid task\n\n", content_type="text/event-stream")

    try:
        data = await request.json()
        text = data.get("text", "")
        template_id = data.get("templateId", data.get("template_id", ""))
        skill_id = data.get("skillId", data.get("skill_id", ""))
        raw_images = data.get("images") or []
        auto_unload = data.get("autoUnload", data.get("auto_unload", False))

        logger.info(f"LLM API stream request: endpoint={task_name}, text='{text[:100]}...', templateId='{template_id}', skillId='{skill_id}', images={len(raw_images)}, autoUnload={auto_unload}")

        # 允许空文本：有图片输入（如反推）时合法
        images = []
        if raw_images:
            from .prompts import load_template_max_tokens, resolve_image_bytes
            images = [b for b in (resolve_image_bytes(src) for src in raw_images) if b]
            if not images:
                return web.Response(text="data: [ERROR] invalid image data\n\n", content_type="text/event-stream")

        if not text.strip() and not images:
            return web.Response(text="data: [ERROR] text content is empty\n\n", content_type="text/event-stream")

        # skill 路由：skillId 优先于 endpoint 的 task_name
        # （任务类 skill 如 reverse_prompt 直接用其默认系统提示词）
        if skill_id and skill_id in LLM_TASKS:
            task_name = skill_id
            logger.info(f"Skill route: task_name='{skill_id}'")
        elif skill_id:
            # 非任务类 skill：当作模板尝试加载
            template_id = skill_id

        system_prompt = None
        template_max_tokens = None
        if task_name == "reverse_prompt":
            logger.info("reverse_prompt skill: using default task system prompt")
        elif template_id:
            logger.info(f"Attempting to load template: {template_id}")
            system_prompt = await _load_template_content(template_id)
            logger.info(f"Template content loaded: {system_prompt is not None}, length: {len(system_prompt) if system_prompt else 0}")
            if system_prompt:
                logger.info(f"Loaded template '{template_id}' (length: {len(system_prompt)})")
                # 如果提供了模板，使用 template_prompt 任务
                task_name = "template_prompt"
                template_max_tokens = load_template_max_tokens(template_id)
                logger.info(f"Switched task from initial endpoint to: {task_name}, max_tokens={template_max_tokens}")
            else:
                logger.warning(f"Template '{template_id}' not found or has no content")
        elif images:
            # 有图但未指定 skill：默认走反推
            task_name = "reverse_prompt"
            logger.info("Image input without explicit skill, using reverse_prompt")
        else:
            logger.info("No template_id provided, using default task")

        async def event_stream():
            try:
                import asyncio
                # 将模板内容作为 system_prompt 传递；图片 byte 列表传给流式任务
                gen = run_llm_task_stream(task_name, text, system_prompt=system_prompt,
                                          images=images if images else None,
                                          max_tokens_override=template_max_tokens)
                for chunk in gen:
                    yield (f"data: {chunk}\n\n").encode()
                    await asyncio.sleep(0.01)  # 10ms 延迟，让浏览器逐字显示
                
                # 流式输出完成后，如果需要自动卸载则执行
                if get_current_mode() == LLM_MODE_LOCAL:
                    config = _load_remote_config()
                    enable_auto_unload = config.get("auto_unload_local", False)
                    if auto_unload or enable_auto_unload:
                        try:
                            unload_local_model()
                            logger.info("Auto-unloaded local model after stream completion")
                        except Exception as e:
                            logger.warning(f"Failed to auto-unload local model: {e}")
                
                yield b"data: [DONE]\n\n"
            except Exception as e:
                logger.error(f"Stream error for task {task_name}: {e}")
                yield (f"data: [ERROR] {str(e)}\n\n").encode()
                yield b"data: [DONE]\n\n"

        return web.Response(
            body=event_stream(),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )
    except Exception as e:
        logger.error(f"Error handling stream LLM task {task_name}: {e}")
        logger.exception(e)
        return web.Response(
            text=f"data: [ERROR] {str(e)}\n\ndata: [DONE]\n\n",
            content_type="text/event-stream"
        )


# ==========================================
# Module Exports
# ==========================================

__all__ = [
    "handle_llm_api_request",
    "handle_llm_api_stream",
    "run_llm_task",
    "run_llm_task_stream",
    "get_remote_llm_config",
    "set_remote_llm_config",
    "get_current_mode",
    "LLM_MODE_LOCAL",
    "LLM_MODE_REMOTE",
    "RemoteLLMClient",
    "check_model_status",
    "check_all_models_status",
    "start_download",
    "get_available_models",
    "set_current_model",
    "scan_llm_directory",
]
