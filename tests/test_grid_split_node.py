# SPDX-License-Identifier: Apache-2.0
"""NeoGridSplit 节点离线单测：一张分镜宫格图（input/ 里选）→ 各格 IMAGE（行优先）+ 原图内嵌提示词。

不依赖 ComfyUI 运行中的服务器与真实模型：folder_paths 用桩模块替换（同 test_ref_grid）；
验证接口形状、自动检测切 3×3=9 格、手动行列、原图 PNG 元信息里「包含的提示词」提取（负向节点剔除）、
坏文件 / 目录穿越报错。像素核心复用 grid_split.py（其单测见 test_grid_split.py）。"""

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

import numpy as np
import torch

_TMP = tempfile.mkdtemp(prefix="neo_grid_split_node_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

if "folder_paths" not in sys.modules:
    _fp = types.ModuleType("folder_paths")
    _fp.get_filename_list = lambda folder: sorted(os.listdir(_INPUT_DIR)) if os.path.isdir(_INPUT_DIR) else []
    _fp.get_input_directory = lambda: _INPUT_DIR
    _fp.get_output_directory = lambda: _OUTPUT_DIR
    sys.modules["folder_paths"] = _fp
_folder_paths = sys.modules["folder_paths"]

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_grid_split_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


_load("grid_split", "grid_split.py")          # 先加载依赖（节点内 `from .grid_split import ...`）
gsn = _load("grid_split_node", "grid_split_node.py")

# 各格用互不相同的中间调纯色：行/列 std≈0 但亮度不极端 → 不被误判成间隙；白缝 mean=255 → 被检出为分隔。
_CELL_COLORS = [(120, 40, 90), (40, 120, 60), (60, 60, 140), (150, 90, 30), (30, 140, 140),
                (140, 30, 30), (90, 140, 30), (30, 70, 120), (150, 120, 40)]


def _write_grid_png(name, rows=3, cols=3, cw=40, ch=30, gap=6):
    """在桩 input/ 目录写一张 rows×cols 纯色格 + 白缝的宫格图，并内嵌 ComfyUI API prompt 元信息。"""
    from PIL import Image, PngImagePlugin
    W = cols * cw + (cols - 1) * gap
    H = rows * ch + (rows - 1) * gap
    img = Image.new("RGB", (W, H), (255, 255, 255))
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * (cw + gap), r * (ch + gap)
            col = _CELL_COLORS[(r * cols + c) % len(_CELL_COLORS)]
            for yy in range(ch):
                for xx in range(cw):
                    img.putpixel((x0 + xx, y0 + yy), col)
    meta = {
        "1": {"class_type": "NeoPromptEncoder", "inputs": {"text": "宫格提示词A"}},
        "2": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "宫格提示词B"}},
        "3": {"class_type": "KSampler", "inputs": {"positive": [2, 0], "negative": [9, 0]}},
        "9": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "负向提示词C"}},
    }
    pi = PngImagePlugin.PngInfo()
    pi.add_text("prompt", json.dumps(meta))
    img.save(os.path.join(_INPUT_DIR, name), format="PNG", pnginfo=pi)
    return name


class NeoGridSplitTests(unittest.TestCase):
    def setUp(self):
        # 节点调用期懒导入 folder_paths（查 sys.modules）：其他测试文件会在收集期替换桩条目，
        # 测试期间钉回本文件的桩，结束还原
        self._prev_folder_paths = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = _folder_paths
        _folder_paths.get_input_directory = lambda: _INPUT_DIR
        if not hasattr(_folder_paths, "get_filename_list"):
            _folder_paths.get_filename_list = lambda folder: []

    def tearDown(self):
        if self._prev_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._prev_folder_paths

    def test_input_and_return_types(self):
        spec = gsn.NeoGridSplit.INPUT_TYPES()
        self.assertIn("filename", spec["required"])
        row_opts = spec["optional"]["rows"][0]   # combo：1 元组包着选项列表
        self.assertEqual(row_opts[0], "auto")
        self.assertEqual(len(row_opts), 13)      # auto + 1..12
        self.assertEqual(gsn.NeoGridSplit.RETURN_TYPES, ("IMAGE", "STRING"))
        self.assertEqual(gsn.NeoGridSplit.RETURN_NAMES, ("image", "prompt"))

    def test_split_grid_and_prompts(self):
        name = _write_grid_png("gs_3x3.png", rows=3, cols=3)
        out = gsn.NeoGridSplit().split(filename=name)
        image, prompts = out["result"]
        # prompts：原图元信息里的正向提示词（负向节点 9 被剔除），换行分隔
        self.assertEqual(prompts, "宫格提示词A\n宫格提示词B")
        # image：单个批次 [N,H,W,C]，N=9（3×3）
        self.assertEqual(image.shape[0], 9)
        self.assertEqual(image.shape[3], 3)          # RGB
        self.assertTrue(image.dtype == torch.float32)
        self.assertGreaterEqual(image.min().item(), 0.0)
        self.assertLessEqual(image.max().item(), 1.0)
        self.assertEqual(out["ui"]["count"], [9])
        self.assertEqual(out["ui"]["rows"], [3])
        self.assertEqual(out["ui"]["cols"], [3])

    def test_manual_rows_cols(self):
        name = _write_grid_png("gs_2x2.png", rows=2, cols=2)
        out = gsn.NeoGridSplit().split(filename=name, rows="2", cols="2")
        image, _ = out["result"]
        self.assertEqual(out["ui"]["count"], [4])
        self.assertEqual(image.shape[0], 4)          # 批次 = 4 格
        self.assertEqual(image.shape[3], 3)

    def test_missing_file_raises(self):
        with self.assertRaises(ValueError):
            gsn.NeoGridSplit().split(filename="nope.png")

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            gsn.NeoGridSplit().split(filename="../secret.png")


if __name__ == "__main__":
    unittest.main()