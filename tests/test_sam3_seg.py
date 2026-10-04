# SPDX-License-Identifier: Apache-2.0
"""sam3_seg 的离线单测：模型扫描/解析与点选分割（SAM3_Detect 用桩替换）。

不依赖 ComfyUI 运行中的服务器：folder_paths / comfy_extras 用桩模块替换。
"""

import importlib.util
import os
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_sam3_seg_")
_INPUT_DIR = os.path.join(_TMP, "input")
os.makedirs(_INPUT_DIR, exist_ok=True)

_SAM3_FILES = ["sam3-fp16.safetensors", "sam3.1_multiplex_fp16.safetensors",
               "krea2/krea2_turbo_fp16.safetensors"]

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_SAM3_FILES) if folder == "checkpoints" else []
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_full_path_or_raise = lambda folder, name: os.path.join(_TMP, name)
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# sam3_seg 含相对导入（from .util import ...），需先建虚拟包再加载
_pkg = types.ModuleType("_neo_sam3_pkg")
_pkg.__path__ = [PLUGIN_DIR]
sys.modules["_neo_sam3_pkg"] = _pkg

_util_mod = types.ModuleType("_neo_sam3_pkg.util")
import logging as _logging


class _PF(_logging.Filter):
    def filter(self, record):
        return True


_util_mod.PrefixFilter = _PF
sys.modules["_neo_sam3_pkg.util"] = _util_mod
_pkg.util = _util_mod

_spec = importlib.util.spec_from_file_location(
    "_neo_sam3_pkg.sam3_seg", os.path.join(PLUGIN_DIR, "sam3_seg.py"))
sam3_seg = importlib.util.module_from_spec(_spec)
sys.modules["_neo_sam3_pkg.sam3_seg"] = sam3_seg
_spec.loader.exec_module(sam3_seg)
_pkg.sam3_seg = sam3_seg


def write_png(path: str, width: int, height: int) -> None:
    from PIL import Image
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with Image.new("RGB", (width, height), (200, 30, 30)) as img:
        img.save(path, format="PNG")


class TestSam3ModelResolve(unittest.TestCase):

    def test_list_filters_sam3_names(self):
        files = sam3_seg.list_sam3_models()
        self.assertEqual(files, ["sam3-fp16.safetensors", "sam3.1_multiplex_fp16.safetensors"])

    def test_auto_pick_prefers_sam31(self):
        name, err = sam3_seg.resolve_sam3_model("")
        self.assertEqual(err, "")
        self.assertEqual(name, "sam3.1_multiplex_fp16.safetensors")

    def test_explicit_and_case_insensitive(self):
        self.assertEqual(sam3_seg.resolve_sam3_model("sam3-fp16.safetensors"), ("sam3-fp16.safetensors", ""))
        self.assertEqual(sam3_seg.resolve_sam3_model("SAM3-FP16.SAFETENSORS"), ("sam3-fp16.safetensors", ""))

    def test_missing_model_error_lists_candidates(self):
        name, err = sam3_seg.resolve_sam3_model("seg_anything.safetensors")
        self.assertEqual(name, "")
        self.assertIn("seg_anything.safetensors", err)
        self.assertIn("sam3-fp16.safetensors", err)


class TestSam3SegmentPoints(unittest.TestCase):

    def _stub_detect(self, mask):
        """注入桩 comfy_extras.nodes_sam3，execute 返回给定 union mask；返回调用记录。"""
        calls = []
        fake = types.ModuleType("comfy_extras")
        fake_nodes = types.ModuleType("comfy_extras.nodes_sam3")

        class SAM3_Detect:
            @staticmethod
            def execute(model, image, positive_coords=None, refine_iterations=2):
                calls.append(positive_coords)
                return types.SimpleNamespace(args=(mask,))

        fake_nodes.SAM3_Detect = SAM3_Detect
        fake.nodes_sam3 = fake_nodes
        sys.modules["comfy_extras"] = fake
        sys.modules["comfy_extras.nodes_sam3"] = fake_nodes
        return calls

    def test_segment_saves_binary_mask(self):
        import json
        import torch
        mask = torch.zeros(1, 64, 64)
        mask[0, 10:20, 10:20] = 1.0
        calls = self._stub_detect(mask)
        sam3_seg._MODEL_CACHE.clear()
        sam3_seg._MODEL_CACHE["sam3.1_multiplex_fp16.safetensors"] = object()
        write_png(os.path.join(_INPUT_DIR, "scene.png"), 64, 64)
        try:
            name = sam3_seg.segment_points("scene.png", [{"x": 15, "y": 15}])
        finally:
            sys.modules.pop("comfy_extras", None)
            sys.modules.pop("comfy_extras.nodes_sam3", None)
        self.assertTrue(name.startswith("NeoAgent/_neo_sam3_mask_"))
        full = os.path.join(_INPUT_DIR, *name.split("/"))
        self.assertTrue(os.path.isfile(full))
        from PIL import Image
        with Image.open(full) as m:
            self.assertEqual(m.mode, "L")
            self.assertEqual(m.size, (64, 64))
            self.assertGreater(m.getbbox()[2], 10)   # 遮罩非空
        self.assertEqual(json.loads(calls[0]), [{"x": 15, "y": 15}])

    def test_empty_mask_raises(self):
        import torch
        self._stub_detect(torch.zeros(1, 32, 32))
        sam3_seg._MODEL_CACHE.clear()
        sam3_seg._MODEL_CACHE["sam3.1_multiplex_fp16.safetensors"] = object()
        write_png(os.path.join(_INPUT_DIR, "empty.png"), 32, 32)
        try:
            with self.assertRaises(ValueError) as ctx:
                sam3_seg.segment_points("empty.png", [{"x": 5, "y": 5}])
            self.assertIn("检测到物体", str(ctx.exception))
        finally:
            sys.modules.pop("comfy_extras", None)
            sys.modules.pop("comfy_extras.nodes_sam3", None)


if __name__ == "__main__":
    unittest.main()
