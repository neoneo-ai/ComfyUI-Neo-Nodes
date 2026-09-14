# ComfyUI-Neo-Nodes - Runtime bundles
# 运行时「bundle」：NeoPromptAgent 出队执行时生成的临时生成包（prompt/参考图/gen_type/skill_id），
# 由下游 H3/Krea2 通过 bundle id 消费。仅存内存，TTL + LRU 淘汰；与磁盘持久化 recipe（配方）完全分离。

from __future__ import annotations

import time
import uuid
import threading
from collections import OrderedDict

_MAX_BUNDLES = 32
_TTL_SECONDS = 3600

_lock = threading.Lock()
_registry: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()


def create_bundle(payload: dict) -> str:
    """登记一个运行时 bundle，返回 id。payload 只放轻量数据（文本/文件名/base64），不放张量。"""
    bundle_id = f"bnd_{uuid.uuid4().hex}"
    now = time.time()
    with _lock:
        _evict_expired(now)
        _registry[bundle_id] = (now, dict(payload or {}))
        _registry.move_to_end(bundle_id)
        while len(_registry) > _MAX_BUNDLES:
            _registry.popitem(last=False)
    return bundle_id


def get_bundle(bundle_id: str) -> dict | None:
    """按 id 取 bundle payload；未命中/过期返回 None（下游据此安全回退本地行为）。"""
    if not bundle_id:
        return None
    now = time.time()
    with _lock:
        entry = _registry.get(bundle_id)
        if entry is None:
            return None
        created, payload = entry
        if now - created > _TTL_SECONDS:
            _registry.pop(bundle_id, None)
            return None
        _registry.move_to_end(bundle_id)
        return dict(payload)


def _evict_expired(now: float) -> None:
    """清理过期项（调用方需持锁）。"""
    stale = [k for k, (created, _) in _registry.items() if now - created > _TTL_SECONDS]
    for k in stale:
        _registry.pop(k, None)
