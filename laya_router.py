# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - LAYA 轻量分类路由器
"""基于 convaiinnovations/laya 的本地文本分类器。

提供快速（~33ms）的 choice/score/noul 分类能力，用于：
- 智能选择增强 skill
- 提示词分类（替代 extract_classify LLM 调用）
- 意图预路由（image/video/edit）

降级策略：laya 包未安装 / 模型加载失败 → is_available()=False，classify() 返回 None。
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Dict, Optional

from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(CURRENT_DIR, "configs", "laya_config.json")
MODEL_DIR = os.path.join(os.path.dirname(CURRENT_DIR), "..", "models", "LAYA")


def _load_config() -> dict:
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {"enabled": True}


def _patch_tqdm_lock():
    """ComfyUI 启动器通过 tqdm_class 参数传入 _KKHfProgress（无 get_lock/set_lock），
    导致 huggingface_hub 的 thread_map → ensure_lock 失败。
    修复：直接 patch huggingface_hub._snapshot_download 中已绑定的 thread_map 引用。"""
    try:
        import huggingface_hub._snapshot_download as sd
        if getattr(sd, "_neo_nodes_patched", False):
            return
        _original_thread_map = sd.thread_map

        def _safe_thread_map(fn, *iterables, **tqdm_kwargs):
            cls = tqdm_kwargs.get("tqdm_class")
            if cls is not None and not hasattr(cls, "get_lock"):
                _shared = threading.Lock()
                cls.get_lock = classmethod(lambda c: getattr(c, "_lock", _shared))
                cls.set_lock = classmethod(lambda c, l: setattr(c, "_lock", l))
            return _original_thread_map(fn, *iterables, **tqdm_kwargs)

        sd.thread_map = _safe_thread_map
        sd._neo_nodes_patched = True
    except Exception:
        pass


class _LayaRouter:
    """LAYA 模型单例，惰性加载。"""

    def __init__(self):
        self._router = None
        self._load_attempted = False
        self._lock = threading.Lock()

    def _try_load(self) -> bool:
        with self._lock:
            if self._load_attempted:
                return self._router is not None
            self._load_attempted = True
            try:
                os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
                os.environ.setdefault("HF_HUB_OFFLINE", "1")
                _patch_tqdm_lock()
                from laya import Router
                self._router = Router(preload=False)
                logger.info("LAYA router loaded successfully")
                print("[NeoNodes] LAYA router loaded")
                return True
            except ImportError:
                logger.info("LAYA package not installed, classifier disabled")
                return False
            except Exception as e:
                logger.warning(f"Failed to load LAYA router: {e}")
                return False

    @property
    def available(self) -> bool:
        if not _load_config().get("enabled", True):
            return False
        if self._router is None:
            self._try_load()
        return self._router is not None

    def classify(self, text: str, questions: dict) -> Optional[Dict[str, Any]]:
        """执行 LAYA 分类推理。

        Args:
            text: 输入文本
            questions: LAYA 类型化问题定义

        Returns:
            分类结果 dict（如 {"category": "古风", "confidence": 0.91}），
            不可用或失败时返回 None。
        """
        if not self.available:
            return None
        try:
            with self._lock:
                saved_endpoint = os.environ.pop("HF_ENDPOINT", None)
                try:
                    result = self._router.predict(text, questions)
                finally:
                    if saved_endpoint is not None:
                        os.environ["HF_ENDPOINT"] = saved_endpoint
            logger.info(f"LAYA predict OK: {list(result.get('answers', {}).keys())}")
            # result 格式: {"answers": {"title": {"choice": "sitting", "confidence": 0.48, "answer_confidence": 0.88, ...}}}
            answers = result.get("answers", result)
            out = {}
            for key, val in answers.items():
                if isinstance(val, dict):
                    value = val.get("choice", val.get("value", val.get("label", "")))
                    confidence = val.get("answer_confidence", val.get("confidence", 0.0))
                    out[key] = {"value": value, "confidence": confidence}
                else:
                    out[key] = {"value": str(val), "confidence": 1.0}
            return out if out else None
        except Exception as e:
            import traceback
            logger.warning(f"LAYA classify failed: {e}\n{traceback.format_exc()}")
            return None


_router_instance: Optional[_LayaRouter] = None
_router_lock = threading.Lock()


def _get_router() -> _LayaRouter:
    global _router_instance
    if _router_instance is None:
        with _router_lock:
            if _router_instance is None:
                _router_instance = _LayaRouter()
    return _router_instance


def is_available() -> bool:
    """LAYA 分类器是否可用。"""
    return _get_router().available


def classify(text: str, questions: dict) -> Optional[Dict[str, Any]]:
    """执行分类，不可用时返回 None。"""
    if not text or not text.strip():
        return None
    return _get_router().classify(text, questions)
