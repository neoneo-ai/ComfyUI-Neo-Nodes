# SPDX-License-Identifier: Apache-2.0
"""NeoRefGrid 节点离线单测：宫格槽位（隐藏 refs）→ prompt + BUNDLE + image_1..image_12。

不依赖 ComfyUI 运行中的服务器与真实模型：server/comfy/folder_paths/nodes 用桩模块替换（同 test_bundle_expand）；
验证接口形状、宫格按槽位还原（坏文件保位空缺）、上限 12 裁剪、提示词取节点内 prompt_text。"""

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

import numpy as np

_TMP = tempfile.mkdtemp(prefix="neo_ref_grid_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

# 桩模块只在缺失时补装（本文件单独跑）；全量运行时复用其他测试文件已装的桩，
# 避免互相覆盖运行时状态（input/output 目录桩在 setUp/tearDown 里按测试临时切换）。
if "server" not in sys.modules:
    _server = types.ModuleType("server")
    _server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
        prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
    sys.modules["server"] = _server

if "comfy" not in sys.modules:
    _comfy = types.ModuleType("comfy")
    _comfy_cli = types.ModuleType("comfy.cli_args")
    _comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188, tls_keyfile=None, tls_certfile=None)
    sys.modules["comfy"] = _comfy
    sys.modules["comfy.cli_args"] = _comfy_cli
    _comfy_pe = types.ModuleType("comfy.patcher_extension")
    _comfy_pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="DIFFUSION_MODEL")
    _comfy_pe.add_wrapper_with_key = lambda *a, **k: None
    sys.modules["comfy.patcher_extension"] = _comfy_pe
    _comfy_utils = types.ModuleType("comfy.utils")
    _comfy_utils.common_upscale = lambda *a, **k: None
    sys.modules["comfy.utils"] = _comfy_utils
    _comfy_common_dit = types.ModuleType("comfy.ldm.common_dit")
    _comfy_common_dit.pad_to_patch_size = lambda *a, **k: None
    sys.modules["comfy.ldm.common_dit"] = _comfy_common_dit
    _comfy_flux_layers = types.ModuleType("comfy.ldm.flux.layers")
    _comfy_flux_layers.timestep_embedding = lambda *a, **k: None
    for _name in ("comfy.ldm", "comfy.ldm.flux"):
        sys.modules.setdefault(_name, types.ModuleType(_name))
    sys.modules["comfy.ldm.flux.layers"] = _comfy_flux_layers

if "comfy_execution" not in sys.modules:
    _comfy_exec = types.ModuleType("comfy_execution")
    _comfy_exec_prog = types.ModuleType("comfy_execution.progress")
    _comfy_exec_prog.get_progress_state = lambda: types.SimpleNamespace(prompt_id="", nodes={})
    sys.modules["comfy_execution"] = _comfy_exec
    sys.modules["comfy_execution.progress"] = _comfy_exec_prog

if "folder_paths" not in sys.modules:
    _fp = types.ModuleType("folder_paths")
    _fp.get_filename_list = lambda folder: []
    _fp.get_input_directory = lambda: _INPUT_DIR
    _fp.get_output_directory = lambda: _OUTPUT_DIR
    sys.modules["folder_paths"] = _fp
_folder_paths = sys.modules["folder_paths"]
_orig_input_dir = _folder_paths.get_input_directory
_orig_output_dir = _folder_paths.get_output_directory

if "nodes" not in sys.modules:
    _nodes = types.ModuleType("nodes")
    _nodes.NODE_CLASS_MAPPINGS = {}
    _nodes.MAX_RESOLUTION = 8192
    sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_ref_grid_pkg"
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


bundles = _load("bundles", "bundles.py")
_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
prompts = _load("prompts", "prompts.py")
bundle_expand = _load("bundle_expand", "bundle_expand.py")
ref_grid = _load("ref_grid", "ref_grid.py")


def _write_input_png(name, w=8, h=6, rgb=(255, 0, 0)):
    """在桩 input/ 目录写一张纯色 PNG，返回文件名。"""
    from PIL import Image
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    for c in range(3):
        arr[:, :, c] = rgb[c]
    path = os.path.join(_INPUT_DIR, name)
    Image.fromarray(arr).save(path, format="PNG")
    return name


class NeoRefGridTests(unittest.TestCase):
    def setUp(self):
        bundles._registry.clear()
        # 临时把目录桩指向本文件的临时目录（其他测试文件运行时不受影响）
        _folder_paths.get_input_directory = lambda: _INPUT_DIR
        _folder_paths.get_output_directory = lambda: _OUTPUT_DIR

    def tearDown(self):
        _folder_paths.get_input_directory = _orig_input_dir
        _folder_paths.get_output_directory = _orig_output_dir

    def _pack(self, **kw):
        args = {"refs": "", "prompt_text": ""}
        args.update(kw)
        return ref_grid.NeoRefGrid().pack(**args)

    def test_input_and_return_types(self):
        spec = ref_grid.NeoRefGrid.INPUT_TYPES()
        self.assertEqual(spec["required"]["refs"], ("STRING", {"default": "", "hidden": True}))
        self.assertNotIn("optional", spec)   # bundle 输入口已移除，仅保留隐藏 refs / prompt_text
        n = ref_grid.GRID_MAX
        self.assertEqual(n, 12)
        self.assertEqual(ref_grid.NeoRefGrid.RETURN_TYPES, ("STRING", "STRING") + ("IMAGE",) * n)
        self.assertEqual(ref_grid.NeoRefGrid.RETURN_NAMES,
                         ("prompt", "BUNDLE") + tuple(f"image_{i}" for i in range(1, n + 1)))

    def test_grid_files_fill_slots_positionally(self):
        a = _write_input_png("rg_a.png", rgb=(255, 0, 0))
        b = _write_input_png("rg_b.png", w=4, h=3, rgb=(0, 255, 0))
        out = self._pack(refs=json.dumps([a, b]), prompt_text="本地提示词")
        result = out["result"]
        # prompt / BUNDLE / image_1..image_12
        self.assertEqual(result[0], "本地提示词")
        self.assertTrue(result[1].startswith("bnd_"))
        self.assertEqual(tuple(result[2].shape), (1, 6, 8, 3))    # image_1 = a（纯红）
        self.assertGreater(result[2][0, 0, 0, 0].item(), 0.99)
        self.assertEqual(tuple(result[3].shape), (1, 3, 4, 3))    # image_2 = b
        self.assertEqual(result[4].shape[0], 0)                   # image_3 空占位
        payload = bundles.get_bundle(result[1])
        self.assertEqual(payload["prompts"], ["本地提示词"])
        self.assertEqual(len(payload["references"]), 2)
        for ref in payload["references"]:
            self.assertEqual(ref["kind"], "data")
            self.assertTrue(ref["data"].startswith("data:image/png;base64,"))
        self.assertEqual(out["ui"]["count"], [2])
        self.assertEqual(out["ui"]["order"], ["格1", "格2"])

    def test_bad_grid_file_keeps_slot_gap(self):
        b = _write_input_png("rg_b2.png", w=4, h=3)
        out = self._pack(refs=json.dumps(["missing.png", b]))
        result = out["result"]
        self.assertEqual(result[2].shape[0], 0)                   # image_1 空（坏文件保位）
        self.assertEqual(tuple(result[3].shape), (1, 3, 4, 3))    # image_2 = b（不补位）
        self.assertEqual(len(bundles.get_bundle(result[1])["references"]), 1)
        self.assertEqual(out["ui"]["order"], ["格2"])

    def test_prompt_from_node_text(self):
        out = self._pack(prompt_text="节点内提示词")
        result = out["result"]
        self.assertEqual(result[0], "节点内提示词")
        self.assertEqual(bundles.get_bundle(result[1])["prompts"], ["节点内提示词"])
        self.assertEqual(result[2].shape[0], 0)   # 宫格为空 → image 槽全空占位
        self.assertEqual(out["ui"]["count"], [0])

    def test_cap_at_twelve(self):
        files = [_write_input_png(f"rg_c{i}.png") for i in range(13)]
        out = self._pack(refs=json.dumps(files))
        result = out["result"]
        # refs 超上限只取前 12 张
        for i in range(12):
            self.assertEqual(result[2 + i].shape[0], 1)
        self.assertEqual(len(bundles.get_bundle(result[1])["references"]), 12)
        self.assertEqual(out["ui"]["count"], [12])

    def test_invalid_refs_json_degrades(self):
        out = self._pack(refs="not-json", prompt_text="p")
        result = out["result"]
        self.assertEqual(result[2].shape[0], 0)
        self.assertEqual(out["ui"]["count"], [0])


if __name__ == "__main__":
    unittest.main()