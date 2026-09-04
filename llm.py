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
import threading
from typing import Any, Dict, List, Optional, Generator
from pathlib import Path
import folder_paths
from collections import OrderedDict

from . import skill

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

_CONFIGS_DIR: str = os.path.join(os.path.dirname(__file__), "configs")


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
    # OpenRouter：OpenAI 兼容云聚合，模型列表来自其公开 /v1/models
    "openrouter": {
        "api_key": "",
        "base_url": "https://openrouter.ai/api/v1",
        "model": "",
        "max_tokens": 500,
        "temperature": 0.0,
        "timeout": 120,
    },
    # 本地 GGUF（llama.cpp 进程内推理）：models_dir 为空时使用默认 <ComfyUI>/models/LLM
    "local": {
        "model": "",
        "models_dir": "",
    },
}

# 走 OpenAI 兼容 HTTP 的 provider；local 为进程内 llama.cpp，不属于远程
_REMOTE_PROVIDERS = {"openai", "lmstudio", "ollama", "openrouter"}


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
                config = _migrate_remote_config(json.load(f))
            # 一次性：把旧 model_config.json 的 current_model 接手到 local provider
            local_slot = config.get("providers", {}).get("local")
            if local_slot is not None and not local_slot.get("model"):
                legacy = os.path.join(_CONFIGS_DIR, "model_config.json")
                if os.path.exists(legacy):
                    try:
                        with open(legacy, "r", encoding="utf-8") as f:
                            cur = json.load(f).get("current_model", "")
                        if cur and cur.strip():
                            local_slot["model"] = cur
                            _save_remote_config(config)
                    except Exception:
                        pass
            return config
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
        saved = _migrate_remote_config(merged)
        _save_remote_config(saved)
        if saved.get("active_provider") != "local":
            _unload_local_if_inactive()
        return

    # 扁平结构：只更新对应 provider 的槽位，不影响其它 provider
    current = _load_remote_config()
    provider = config.get("provider")
    if provider in current.get("providers", {}):
        slot = current["providers"][provider]
        for key in ("base_url", "model", "models_dir", "max_tokens", "temperature", "timeout"):
            if key in config:
                slot[key] = config[key]
        if config.get("api_key"):
            slot["api_key"] = config["api_key"]
        if config.get("enabled"):
            current["enabled"] = True
        else:
            current["enabled"] = False
        current["active_provider"] = provider
        if "auto_unload_local" in config:
            current["auto_unload_local"] = bool(config["auto_unload_local"])
        _save_remote_config(current)
        logger.info(f"Remote LLM provider '{provider}' config updated")
        if provider != "local":
            _unload_local_if_inactive()
        return

    # 未知 provider：只更新启用状态
    current["enabled"] = bool(config.get("enabled", current.get("enabled", False)))
    _save_remote_config(current)

# 远程 LLM 模式常量
LLM_MODE_LOCAL = "local"
LLM_MODE_REMOTE = "remote"

def get_current_mode() -> str:
    """获取当前 LLM 模式：local 或 remote（基于 provider 值判断）"""
    config = _load_remote_config()
    if config.get("enabled") and config.get("active_provider") in _REMOTE_PROVIDERS:
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
# Local Model Helpers (realtime scan)
# ==========================================

def _resolve_llm_dir(models_dir: str = "") -> str:
    """解析本地模型目录：自定义路径优先，空值回退默认 <ComfyUI>/models/LLM"""
    custom = str(models_dir or "").strip()
    if custom:
        return os.path.abspath(custom)
    return os.path.join(folder_paths.base_path, "models", "LLM")


def _is_mmproj_file(fname: str) -> bool:
    """判断是否为多模态投影文件：兼容 mmproj-f16.gguf 与 <模型名>.mmproj-f16.gguf 两种命名"""
    name = fname.lower()
    return name.endswith(".gguf") and "mmproj" in name


def scan_llm_directory(models_dir: str = "") -> List[Dict[str, str]]:
    """递归扫描本地模型目录下的 .gguf 文件（平铺 / 单层子目录 / LM Studio 多层嵌套均支持）。
    同目录恰好只有一个 mmproj 投影文件时绑定给该目录下的所有模型（用于图片反推）；投影文件本身不列为可选模型。"""
    llm_dir = _resolve_llm_dir(models_dir)
    discovered: List[Dict[str, str]] = []
    seen: set = set()

    if not os.path.isdir(llm_dir):
        return discovered

    def _register(key: str, model_dir: str, fname: str, mmproj: str = "", full: str = "", proj_size: int = 0) -> None:
        if key in seen:
            return
        seen.add(key)
        stem = fname[:-5] if fname.lower().endswith(".gguf") else fname
        file_size = 0
        try:
            if full and os.path.isfile(full):
                file_size = os.path.getsize(full)
        except OSError:
            file_size = 0
        # 多模态模型：所属目录的单张 mmproj 投影文件计入总体积
        if proj_size:
            file_size += proj_size
        discovered.append({
            "key": key,
            "name": stem,
            "filename": fname,
            "model_dir": model_dir,
            "mmproj": mmproj,
            "multimodal": bool(mmproj),
            "file_size": file_size,
        })

    for root, _dirs, files in os.walk(llm_dir):
        # 同目录恰好只有一个名字含 mmproj 的 gguf 时才绑定（多个候选时不猜测）
        ggufs = sorted(f for f in files if f.lower().endswith(".gguf"))
        projectors = [f for f in ggufs if _is_mmproj_file(f)]
        bind = projectors[0] if len(projectors) == 1 else ""
        # 单张 mmproj 投影文件服务该目录下所有模型，其体积计入每个模型的总体积
        proj_size = 0
        if bind:
            proj_full = os.path.join(root, bind)
            try:
                if os.path.isfile(proj_full):
                    proj_size = os.path.getsize(proj_full)
            except OSError:
                proj_size = 0
        for fname in ggufs:
            if _is_mmproj_file(fname):
                continue
            full = os.path.join(root, fname)
            # key 取相对路径去扩展名：根目录为 "stem"，深层为 "pub/model/stem"
            rel = os.path.relpath(full, llm_dir).replace("\\", "/")
            _register(rel[:-5], root, fname, bind, full=full, proj_size=proj_size)

        discovered.sort(key=lambda item: item["key"])
    return discovered


def unload_local_model():
    """卸载本地 LLM 模型（释放显存）"""
    global LLMSingleton
    if LLMSingleton._instance is not None:
        try:
            if hasattr(LLMSingleton._instance, 'model') and LLMSingleton._instance.model is not None:
                del LLMSingleton._instance.model
            LLMSingleton._instance = None
            msg = "Local LLM model unloaded successfully"
            logger.info(msg)
            print(f"[NeoNodes] {msg}")
            return {"success": True, "message": "Model unloaded"}
        except Exception as e:
            msg = f"Failed to unload local model: {e}"
            logger.error(msg)
            print(f"[NeoNodes] {msg}")
            return {"success": False, "error": str(e)}
    msg = "No local model loaded, nothing to unload"
    logger.info(msg)
    print(f"[NeoNodes] {msg}")
    return {"success": True, "message": "No model was loaded"}


def _unload_local_if_inactive():
    """激活 provider 已不是 local 时，驻留的本地模型不会再被使用，直接释放显存"""
    if LLMSingleton._instance is not None:
        unload_local_model()


def __reload_llm_singleton():
    """销毁并重建 LLM 单例，以加载新模型"""
    global LLMSingleton
    LLMSingleton._instance = None


def _bind_sibling_mmproj(model_key: str) -> str:
    """主模型选定后，若其所在目录恰好只有一个名字含 mmproj 的 gguf，
    自动绑定为该模型的投影文件（下载命名不规范时的兜底自愈）。返回 mmproj 文件名。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    for entry in scanned:
        if entry["key"] != model_key:
            continue
        target = _resolve_model_path(entry["model_dir"], entry["filename"])
        model_dir = os.path.dirname(target)
        base = os.path.basename(target).lower()
        try:
            siblings = [f for f in os.listdir(model_dir)
                        if f.lower().endswith(".gguf") and f.lower() != base and _is_mmproj_file(f)]
        except OSError:
            return ""
        if len(siblings) == 1:
            logger.info(f"Auto-bound mmproj '{siblings[0]}' to {model_key}")
            return siblings[0]
        return entry.get("mmproj", "")
    return ""


def set_current_model(model_key: str) -> bool:
    """设置当前本地模型；key 必须是扫描结果中的 key。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    keys = {item["key"] for item in scanned}
    if model_key not in keys:
        logger.warning(f"Unknown model key: {model_key}")
        return False
    _set_local_model(model_key)
    __reload_llm_singleton()
    return True


def _get_local_models_dir() -> str:
    """当前 local provider 配置的模型目录。"""
    cfg = _load_remote_config()
    return cfg.get("providers", {}).get("local", {}).get("models_dir", "")


def _set_local_model(model_key: str) -> None:
    """持久化当前选中的本地模型到 remote_llm_config.json。"""
    cfg = _load_remote_config()
    cfg.setdefault("providers", {}).setdefault("local", {})["model"] = model_key
    _save_remote_config(cfg)


def _resolve_model_path(model_dir: str, filename: str) -> str:
    """定位 gguf 文件绝对路径；model_dir 兼容相对子目录与扫描写入的绝对目录"""
    if model_dir and os.path.isabs(model_dir):
        return os.path.join(model_dir, filename)
    return os.path.join(folder_paths.base_path, "models", "LLM", model_dir, filename)


def get_available_models() -> Dict[str, Any]:
    """获取当前配置目录下的所有可用本地模型（实时扫描磁盘，不落盘）。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    model_list: List[Dict[str, Any]] = []
    for item in scanned:
        model_list.append({
            "key": item["key"],
            "name": item["name"],
            "filename": item["filename"],
            "model_dir": item["model_dir"],
            "multimodal": item.get("multimodal", False),
            "file_size": item.get("file_size", 0),
        })
    cfg = _load_remote_config()
    cur = cfg.get("providers", {}).get("local", {}).get("model", "")
    return {
        "current_model": cur,
        "models": model_list,
    }


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
                        stream: bool = False,
                        tools: Optional[List[Dict[str, Any]]] = None) -> Any:
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
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        if not self.model:
            raise RuntimeError(
                f"No model selected for provider '{self.provider}'. "
                "Open Settings and pick a model first."
            )

        logger.info(f"Sending request to remote LLM: url={url}, model={self.model}, stream={stream}")

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
            # 带上服务端错误体（OpenRouter/OpenAI 的 4xx 会说明具体原因，如模型不存在）
            detail = ""
            resp = getattr(e, "response", None)
            if resp is not None:
                try:
                    detail = resp.text[:500]
                except Exception:
                    detail = ""
            logger.error(f"Remote LLM HTTP error: {e} | body={detail}")
            raise RuntimeError(f"Remote LLM HTTP {resp.status_code if resp is not None else '?'}: {detail or e}")
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
        out_message = {"role": message.get("role", "assistant"), "content": content}
        tool_calls = message.get("tool_calls")
        if tool_calls:
            out_message["tool_calls"] = tool_calls
        return {
            "choices": [{
                "message": out_message
            }]
        }

    def _stream_response_generator(self, url: str, headers: Dict[str, str], payload: Dict[str, Any]):  # type: ignore[misc, empty-body]
        """流式响应生成器"""
        import requests

        with requests.post(url, headers=headers, json=payload, stream=True, timeout=self.timeout) as response:
            if response.status_code >= 400:
                # 带上服务端错误体（OpenRouter/OpenAI 的 4xx 会说明具体原因，如模型不存在）
                try:
                    detail = response.text[:500]
                except Exception:
                    detail = ""
                logger.error(f"Remote LLM HTTP {response.status_code}: url={url} | body={detail}")
                raise RuntimeError(f"Remote LLM HTTP {response.status_code}: {detail or response.reason}")
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
        remote_cfg = _load_remote_config()
        local_slot = remote_cfg.get("providers", {}).get("local", {})
        current_model_key: str = local_slot.get("model", "")
        models_dir = local_slot.get("models_dir", "")

        scanned = scan_llm_directory(models_dir)
        model_cfg: Dict[str, Any] = {}
        for item in scanned:
            if item["key"] == current_model_key:
                model_cfg = item
                break

        if not model_cfg:
            filename = current_model_key or "no model"
            raise RuntimeError(
                f"LLM model not found: {filename}\n"
                f"Please select a model in the node settings (Settings → Neo LLM → Local).\n"
                f"Or switch to remote API mode."
            )

        target_path = _resolve_model_path(model_cfg["model_dir"], model_cfg["filename"])
        model_dir = os.path.dirname(target_path)
        mmproj_name = str(model_cfg.get("mmproj", "") or "")
        if not mmproj_name:
            mmproj_name = _bind_sibling_mmproj(current_model_key)
        mmproj_path = os.path.join(model_dir, mmproj_name) if mmproj_name else None

        logger.info(f"Loading LLM model: {target_path}")
        logger.info(f"mmproj path: {mmproj_path}")

        if not os.path.exists(target_path):
            filename = os.path.basename(target_path) or "unknown.gguf"
            raise RuntimeError(
                f"LLM model not found: {filename}\n"
                f"Expected path: {target_path}\n"
                f"Please place the model file in: {model_dir}/\n"
                f"Or switch to remote API mode in the node settings."
            )

        if not mmproj_path or not os.path.exists(mmproj_path):
            logger.warning(
                f"mmproj file not found: {mmproj_path}. "
                f"Image understanding will not work."
            )
            mmproj_path = None

        try:
            from llama_cpp import Llama
        except ImportError as e:
            # 延迟导入：未安装时插件与远程模式照常工作，仅本地推理给出明确指引
            raise RuntimeError(
                "本地推理需要 llama-cpp-python 但未安装。"
                "请按 README「本地 LLM 推理安装（可选）」章节安装预编译 wheel，"
                "或在 Settings 中切换到远程 API（OpenAI Compatible / OpenRouter / LM Studio / Ollama）。"
            ) from e

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
        print(f"[NeoNodes] LLM model loaded: {os.path.basename(target_path)} | has_mmproj={self.has_mmproj}")

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
# LLM Task Definitions - Load from task skills (skills/tasks/<task>/skill.md)
# ==========================================


def _build_llm_tasks() -> Dict[str, Any]:
    """Build LLM_TASKS from task skills."""
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
        template = skill.load_task_template(task_name)
        if template is not None:
            tasks[task_name] = {
                "system": template.get("content", ""),
                "max_tokens": template.get("max_tokens", 500),
                "result_key": template.get("result_key", "prompt"),
                "description": template.get("description", ""),
                "multi_result": template.get("multi_result"),
            }
        else:
            logger.warning(f"Failed to load task skill: {task_name}")

    return tasks


# LLM_TASKS is now dynamically loaded from task skills
LLM_TASKS = _build_llm_tasks()

DEFAULT_MULTI_SEPARATOR = "\n---\n"


def resolve_multi_result(text: str, rule: Optional[Dict[str, Any]] = None) -> List[str]:
    """按 skill 的 multi_result 输出契约把 LLM 文本拆分为提示词列表。

    rule 为 None 表示该 skill 未声明多结果，返回空列表（调用方回退为整段文本）。

    rule 格式（来自任务/模板 skill.md frontmatter 的 multi_result 字段）：
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

def remote_chat_turn(messages: List[Dict[str, Any]], max_tokens: Optional[int] = None,
                     tools: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """对当前激活的远程 provider 执行一次（非流式）对话，返回 assistant message dict。

    供 skill 代理循环按需调用：传入带 tools 的 messages，返回含 content / tool_calls 的消息。
    远程未启用或不可用时抛出 RuntimeError。
    """
    config = _get_active_remote_config()
    if not config.get("enabled", False):
        raise RuntimeError("Remote LLM is disabled")
    client = RemoteLLMClient(config)
    if not client.is_available():
        raise RuntimeError(f"Remote provider '{client.provider}' is not available")
    response = client.chat_completion(messages=messages, max_tokens=max_tokens, tools=tools)
    choices = response.get("choices", [])
    if not choices:
        return {}
    return choices[0].get("message", {}) or {}


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

# 把同步阻塞调用（requests / llama.cpp 推理）丢进线程池执行。
# 直接在 async 路由里跑会卡死 aiohttp 事件循环：LLM 未返回期间 presets 列表等
# 所有其他请求都无法响应。
async def _run_blocking(fn):
    return await asyncio.get_running_loop().run_in_executor(None, fn)


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

        result_data = await _run_blocking(lambda: run_llm_task(task_name, text))

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
        skill_id = data.get("skillId", data.get("skill_id", ""))
        raw_images = data.get("images") or []

        logger.info(f"LLM API stream request: endpoint={task_name}, text='{text[:100]}...', skillId='{skill_id}', images={len(raw_images)}")

        # 允许空文本：有图片输入（如反推）时合法
        images = []
        if raw_images:
            from .prompts import resolve_image_bytes
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

        system_prompt = None
        template_max_tokens = None
        skill_agent = False
        if task_name == "reverse_prompt":
            logger.info("reverse_prompt skill: using default task system prompt")
        elif skill_id:
            # 非任务类 skill：走代理循环（按需读取引用 + 中英主文件互斥）
            logger.info(f"Attempting to load skill: {skill_id}")
            if skill.load_skill_content(skill_id):
                skill_agent = True
                logger.info(f"Routing skill '{skill_id}' through agent runner")
            else:
                logger.warning(f"Skill '{skill_id}' not found or has no content")
        elif images:
            # 有图但未指定 skill：默认走反推
            task_name = "reverse_prompt"
            logger.info("Image input without explicit skill, using reverse_prompt")
        else:
            logger.info("No skillId provided, using default task")

        async def event_stream():
            try:
                # 将模板内容作为 system_prompt 传递；图片 byte 列表传给流式任务。
                # 同步生成器在事件循环上直接迭代会阻塞整个 aiohttp loop（LLM 未出首包
                # 时其他请求全部卡住），因此每次 next() 都丢进线程池执行。
                if skill_agent:
                    gen = skill.run_skill_agent_stream(skill_id, text, images=images if images else None)
                else:
                    gen = run_llm_task_stream(task_name, text, system_prompt=system_prompt,
                                              images=images if images else None,
                                              max_tokens_override=template_max_tokens)
                loop = asyncio.get_running_loop()

                def next_chunk():
                    try:
                        return next(gen)
                    except StopIteration:
                        return None

                while True:
                    chunk = await loop.run_in_executor(None, next_chunk)
                    if chunk is None:
                        break
                    yield (f"data: {chunk}\n\n").encode()

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
    "get_available_models",
    "set_current_model",
    "scan_llm_directory",
]
