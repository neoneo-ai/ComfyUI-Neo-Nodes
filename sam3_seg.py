# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — SAM3 点选分割（生图点选删除用）
# 模型为 checkpoints 目录下的 sam3 checkpoint（按名自动挑选，优先 SAM3.1），加载一次后缓存，
# 显存由 comfy.model_management 统一换入换出。分割进程内复用核心 SAM3_Detect 节点
# 的点提示路径（点 → union mask），二值遮罩落 Input/NeoAgent 供局部编辑管线使用。

from __future__ import annotations

import difflib
import json
import logging
import os
import time
import uuid

import folder_paths
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

# 自动挑选名称线索（SAM3.1 multiplex 优先）
_SAM3_HINTS = ("sam3.1", "sam3")

_MODEL_CACHE: dict[str, object] = {}


def list_sam3_models() -> list:
    """列出 checkpoints 目录里可用的 sam3 checkpoint（按名排序）。"""
    try:
        files = folder_paths.get_filename_list("checkpoints") or []
    except Exception as e:
        logger.warning(f"sam3_seg: scan checkpoints failed: {e}")
        return []
    return sorted(f for f in files if "sam3" in os.path.basename(f).lower())


def resolve_sam3_model(wanted: str = "") -> tuple:
    """把模型名解析成 folder_paths 可用的相对名。返回 (resolved, error)；空时自动挑选。"""
    files = list_sam3_models()
    if not files:
        return "", "未找到 SAM3 模型：请把 sam3 checkpoint（如 sam3.1_multiplex_fp16.safetensors）放入 models/checkpoints 目录"
    wanted = str(wanted or "").strip()
    if not wanted:
        for hint in _SAM3_HINTS:
            matches = [f for f in files if hint in os.path.basename(f).lower()]
            if matches:
                return sorted(matches, key=len)[0], ""
        return sorted(files, key=len)[0], ""
    variants = (wanted, wanted.replace("\\", "/"), wanted.replace("/", "\\"))
    for variant in variants:
        if variant in files:
            return variant, ""
    lowered = {f.lower(): f for f in files}
    for variant in variants:
        hit = lowered.get(variant.lower())
        if hit:
            return hit, ""
    candidates = difflib.get_close_matches(wanted, [os.path.basename(f) for f in files], n=3, cutoff=0.4)
    hint = "；候选: " + ", ".join(candidates) if candidates else ""
    return "", f"找不到 sam3 模型 {wanted}{hint}"


def _get_sam3_model(name: str):
    """加载 sam3 checkpoint（按名缓存），返回 ModelPatcher。"""
    cached = _MODEL_CACHE.get(name)
    if cached is not None:
        return cached
    import comfy.sd
    path = folder_paths.get_full_path_or_raise("checkpoints", name)
    model = comfy.sd.load_checkpoint_guess_config_model_only(path)
    _MODEL_CACHE[name] = model
    return model


def segment_points(ref_name: str, points: list) -> str:
    """SAM3 点选分割：原图 + 点击坐标 → 二值遮罩 PNG（存 Input/NeoAgent），返回相对名。

    进程内调用核心 SAM3_Detect 节点（阻塞推理，调用方需放线程池）；标记点未检测到物体时抛 ValueError。"""
    import numpy as np
    import torch
    from PIL import Image
    from comfy_extras.nodes_sam3 import SAM3_Detect

    input_dir = folder_paths.get_input_directory()
    try:
        with Image.open(os.path.join(input_dir, *ref_name.split("/"))) as img:
            img = img.convert("RGB")
    except Exception as e:
        raise ValueError(f"读取原图失败：{e}")

    name, err = resolve_sam3_model()
    if err:
        raise ValueError(err)
    model = _get_sam3_model(name)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    tensor = torch.from_numpy(arr).unsqueeze(0)   # [1, H, W, C] 0-1
    # 队列外调用：进度条 hook 取不到 prompt_id，本次调用临时禁用后恢复
    import comfy.utils
    old_hook = comfy.utils.PROGRESS_BAR_HOOK
    comfy.utils.PROGRESS_BAR_HOOK = None
    try:
        out = SAM3_Detect.execute(model=model, image=tensor,
                                  positive_coords=json.dumps(points), refine_iterations=2)
    finally:
        comfy.utils.PROGRESS_BAR_HOOK = old_hook
    mask = out.args[0]                            # [1, H, W] float 0/1 union mask
    if not bool(mask.any()):
        raise ValueError("SAM3 未在标记点检测到物体，请重新标记后重试")
    mask_img = Image.fromarray((mask[0].detach().cpu().numpy() * 255).astype("uint8"))
    tag = time.strftime("%Y%m%d-%H%M%S") + "_" + uuid.uuid4().hex[:6]
    mask_name = f"NeoAgent/_neo_sam3_mask_{tag}.png"
    os.makedirs(os.path.join(input_dir, "NeoAgent"), exist_ok=True)
    mask_img.save(os.path.join(input_dir, *mask_name.split("/")))
    return mask_name
