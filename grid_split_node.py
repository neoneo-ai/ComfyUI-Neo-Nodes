# ComfyUI-Neo-Nodes - 宫格图拆分节点
# 把一张带分隔条/留白的分镜宫格图（input/ 里选一张）自动切成各格：复用 grid_split.py 的纯像素核心
# （均匀间隙检测，含细白条回退与大小一致性校验：漏检分隔条切出大小悬殊的格子时按最小格等分；trim_cell 清理四边白/黑框与底部字幕条），按行优先把各格
# 拼成一个 IMAGE 批次 [N,H,W,C]（统一到最大宽高）输出，并从原图 PNG 元信息提取「包含的提示词」
# （prompt，换行分隔）。本文件只做节点胶水，像素逻辑全在 grid_split.py。

from __future__ import annotations

import os

import numpy as np
import torch
from PIL import Image

GRID_MAX = 12   # 与 NeoRefGrid / grid_split.MAX_GRID_CELLS 一致：单轴格数上限


def _resolve_input_image(filename):
    """把 input/ 相对文件名解析成绝对路径（防目录穿越）；无效 / 缺失返回 None。"""
    import folder_paths as fp
    name = str(filename or "").strip().replace("\\", "/")
    if not name or ".." in name.split("/"):
        return None
    root = os.path.abspath(fp.get_input_directory())
    path = os.path.abspath(os.path.join(root, name))
    if not (path == root or path.startswith(root + os.sep)):
        return None
    return path if os.path.isfile(path) else None


def _axis(v):
    """手动行列 combo 值（"auto" / "1".."12"）→ int；auto / 非法返回 None。"""
    if v is None or str(v).strip().lower() == "auto":
        return None
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= GRID_MAX else None


def _cells_to_batch(cells):
    """各格 PIL → 单个 IMAGE 张量 [N,H,W,C] float32 0~1：统一到最大宽高（只放大不缩小），空则空批次。"""
    if not cells:
        return torch.zeros((0, 1, 1, 3))
    w = max(c.width for c in cells)
    h = max(c.height for c in cells)
    tensors = []
    for cell in cells:
        if (cell.width, cell.height) != (w, h):
            cell = cell.resize((w, h), Image.LANCZOS)
        tensors.append(torch.from_numpy(np.asarray(cell.convert("RGB"), dtype=np.float32) / 255.0))
    return torch.stack(tensors, dim=0)


class NeoGridSplit:
    """宫格图拆分节点：一张分镜宫格图 → 各格（行优先，清边框/字幕条）+ 原图内嵌提示词。

    - filename：input/ 里的宫格图（选一张）；从原图 PNG 元信息提取「包含的提示词」prompt。
    - rows / cols：可选手动指定行列（auto = 自动检测，含细白条回退与大小一致性校验）。
    - image：各格经 trim_cell 清理后按行优先拼成一个 IMAGE 批次 [N,H,W,C]（统一到最大宽高），
      可直接连到需要多图/多帧的下游；prompt 为原宫格图内嵌的 ComfyUI 提示词（换行分隔）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths as fp
        input_dir = fp.get_input_directory()
        files = sorted(f for f in os.listdir(input_dir)
                       if os.path.isfile(os.path.join(input_dir, f))
                       and f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))
        axis = ["auto"] + [str(i) for i in range(1, GRID_MAX + 1)]
        return {
            "required": {
                "filename": (files or ["(无图片，请先把宫格图放进 input/)"], {"image_upload": True}),
            },
            "optional": {
                "rows": (axis,),
                "cols": (axis,),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "prompt")
    OUTPUT_NODE = True
    FUNCTION = "split"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "宫格图拆分：一张分镜宫格图 → 各格（行优先，清边框/字幕条）+ 原图内嵌提示词。"

    def split(self, filename="", rows="auto", cols="auto"):
        from .grid_split import detect_grid, metadata_prompts, split_image, trim_cell

        path = _resolve_input_image(filename)
        if path is None:
            raise ValueError(f"无法定位 input/ 里的图片：{filename}")
        with Image.open(path) as src:
            info = dict(src.info)   # 原图元信息（PNG 文本块）：切出的格子不带元信息，提示词只能从原图取
            img = src.convert("RGB")
        grid = detect_grid(img, rows=_axis(rows), cols=_axis(cols))
        cells = [trim_cell(c) for c in split_image(img, grid)]
        return {
            "ui": {"count": [len(cells)], "rows": [grid["rows"]], "cols": [grid["cols"]]},
            "result": (_cells_to_batch(cells), "\n".join(metadata_prompts(info))),
        }


NODE_CLASS_MAPPINGS = {"NeoGridSplit": NeoGridSplit}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoGridSplit": "Neo Grid Split (宫格图拆分)"}