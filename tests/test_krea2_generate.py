# SPDX-License-Identifier: Apache-2.0
"""krea2_generate 的离线单测：mini-executor 拓扑/引用/输出收集、张量编码、节点请求组装。

不依赖 ComfyUI 运行中的服务器与真实 Krea2 模型：server/comfy/folder_paths/nodes 用桩模块替换，
mini-executor 用注入的纯张量假节点验证执行逻辑。"""

import base64
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest

import torch

_TMP = tempfile.mkdtemp(prefix="neo_krea2gen_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors", "qwen_image/qwen_image_vae.safetensors"],
    "loras": ["style_a.safetensors"],
}

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

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

_comfy_exec = types.ModuleType("comfy_execution")
_comfy_exec_prog = types.ModuleType("comfy_execution.progress")
_comfy_exec_prog.get_progress_state = lambda: types.SimpleNamespace(prompt_id="", nodes={})
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_krea2gen_pkg"
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


_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
krea2_generate = _load("krea2_generate", "krea2_generate.py")

# 纯张量假节点：验证 mini-executor 执行逻辑，不加载真实 Krea2 模型
class _SourceA:
    FUNCTION = "src"
    RETURN_TYPES = ("IMAGE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {}}
    def src(self): return torch.ones(1, 2, 2, 3)


class _SourceB:
    FUNCTION = "src"
    RETURN_TYPES = ("IMAGE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {}}
    def src(self): return torch.full((1, 2, 2, 3), 0.5)


class _Add:
    FUNCTION = "add"
    RETURN_TYPES = ("IMAGE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"a": ("IMAGE",), "b": ("IMAGE",)}}
    def add(self, a, b): return a + b


class TopoOrderTests(unittest.TestCase):
    def test_linear_order(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "3": {"class_type": "_SourceB", "inputs": {}},
            "2": {"class_type": "_Add", "inputs": {"a": ["1", 0], "b": ["3", 0]}},
        }
        order = krea2_generate._topo_order(graph)
        self.assertEqual(set(order), {"1", "2", "3"})
        self.assertLess(order.index("1"), order.index("2"))
        self.assertLess(order.index("3"), order.index("2"))

    def test_cycle_raises(self):
        graph = {
            "1": {"class_type": "_Add", "inputs": {"a": ["2", 0], "b": ["1", 0]}},
            "2": {"class_type": "_Add", "inputs": {"a": ["1", 0], "b": ["2", 0]}},
        }
        with self.assertRaises(RuntimeError):
            krea2_generate._topo_order(graph)


class NormalizeTests(unittest.TestCase):
    def test_single_value(self):
        self.assertEqual(krea2_generate._normalize_outputs(5, ("IMAGE",)), [5])

    def test_single_1tuple(self):
        self.assertEqual(krea2_generate._normalize_outputs((7,), ("IMAGE",)), [7])

    def test_multi(self):
        self.assertEqual(krea2_generate._normalize_outputs((1, 2), ("A", "B")), [1, 2])


class ExecuteTests(unittest.TestCase):
    def setUp(self):
        self._orig = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update(
            {"_SourceA": _SourceA, "_SourceB": _SourceB, "_Add": _Add})

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig)

    def test_terminal_image_and_skip_save(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "3": {"class_type": "_SourceB", "inputs": {}},
            "2": {"class_type": "_Add", "inputs": {"a": ["1", 0], "b": ["3", 0]}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
        }
        out = krea2_generate.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 1.5)))

    def test_unknown_node_raises(self):
        graph = {"1": {"class_type": "NoSuchNode", "inputs": {}}}
        with self.assertRaises(RuntimeError):
            krea2_generate.execute_graph_inprocess(graph)


class ImageToUriTests(unittest.TestCase):
    def test_roundtrip(self):
        from PIL import Image
        uri = krea2_generate._image_to_data_uri(torch.full((1, 2, 3, 3), 0.5))
        self.assertTrue(uri.startswith("data:image/png;base64,"))
        img = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))
        self.assertEqual(img.size, (3, 2))


class GenerateTests(unittest.TestCase):
    def setUp(self):
        self._orig_map = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update({"_SourceA": _SourceA})
        self._saved = {k: getattr(krea2_generate, k) for k in
                       ("load_skill_workflow", "resolve_request", "render_template",
                        "get_settings", "get_skill_gen_config")}

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig_map)
        for k, v in self._saved.items():
            setattr(krea2_generate, k, v)

    def test_missing_workflow_raises(self):
        krea2_generate.load_skill_workflow = lambda sid: None
        with self.assertRaises(RuntimeError):
            krea2_generate.NeoKrea2Generate().generate("nope", prompt="hi")

    def test_happy_path_returns_image(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        krea2_generate.load_skill_workflow = lambda sid: {"template": True}
        krea2_generate.get_settings = lambda: {}
        krea2_generate.get_skill_gen_config = lambda sid: {}
        krea2_generate.resolve_request = lambda body, settings: {"p": 1}
        krea2_generate.render_template = lambda tpl, params: (graph, [])
        (out,) = krea2_generate.NeoKrea2Generate().generate("ok", prompt="hi", seed=42, count=1)
        self.assertTrue(torch.allclose(out, torch.ones(1, 2, 2, 3)))


class ResolveSkillIdTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(krea2_generate, k) for k in ("scan_skills", "load_skill_workflow")}

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(krea2_generate, k, v)

    def test_resolve_name_to_id(self):
        krea2_generate.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        krea2_generate.load_skill_workflow = lambda sid: {"t": True}
        self.assertEqual(krea2_generate._resolve_skill_id("Alpha"), "a")
        self.assertEqual(krea2_generate._resolve_skill_id("Beta"), "b")

    def test_resolve_fallback_to_id(self):
        krea2_generate.scan_skills = lambda: [{"id": "a", "name": "Alpha", "gen_image": True}]
        krea2_generate.load_skill_workflow = lambda sid: {"t": True}
        self.assertEqual(krea2_generate._resolve_skill_id("legacy-id"), "legacy-id")

    def test_input_types_uses_names(self):
        krea2_generate.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        krea2_generate.load_skill_workflow = lambda sid: {"t": True}
        it = krea2_generate.NeoKrea2Generate.INPUT_TYPES()
        values, opts = it["required"]["skill_id"]
        self.assertEqual(values, ["Alpha", "Beta"])
        self.assertEqual(opts["default"], "Alpha")

    def test_input_types_excludes_no_workflow(self):
        krea2_generate.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        krea2_generate.load_skill_workflow = lambda sid: {"t": True} if sid == "a" else None
        it = krea2_generate.NeoKrea2Generate.INPUT_TYPES()
        values, _ = it["required"]["skill_id"]
        self.assertEqual(values, ["Alpha"])


if __name__ == "__main__":
    unittest.main()
