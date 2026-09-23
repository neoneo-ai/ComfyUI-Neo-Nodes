# SPDX-License-Identifier: Apache-2.0
"""image_gen_edit 的离线单测：mini-executor 拓扑/引用/输出收集、张量编码、节点请求组装（含 Autogrow 参考图）。

不依赖 ComfyUI 运行中的服务器与真实模型：server/comfy/folder_paths/nodes 用桩模块替换，
comfy_api（V3 io）从 ComfyUI 根目录真实导入，mini-executor 用注入的纯张量假节点验证执行逻辑。"""

import asyncio
import base64
import importlib.util
import io
import json
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
_comfy_exec_prog.PreviewImageTuple = tuple
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog
# comfy_api（V3 io）在导入期会拉这两个子模块：桩掉即可离线加载
_comfy_exec_utils = types.ModuleType("comfy_execution.utils")
_comfy_exec_utils.get_executing_context = lambda: None
sys.modules["comfy_execution.utils"] = _comfy_exec_utils
_comfy_exec_graph = types.ModuleType("comfy_execution.graph_utils")
_comfy_exec_graph.ExecutionBlocker = type("ExecutionBlocker", (), {})
sys.modules["comfy_execution.graph_utils"] = _comfy_exec_graph

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 16384
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)
# V3 节点（image_gen_edit）导入期要 comfy_api.latest：先备好 ComfyUI 根目录与占位子模块
import _comfy_api_bootstrap  # noqa: E402
_comfy_api_bootstrap.bootstrap(PLUGIN_DIR)

_PKG = "_neo_image_gen_edit_pkg"
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
_image_gen = _load("image_gen", "image_gen.py")
image_gen_edit = _load("image_gen_edit", "image_gen_edit.py")

# V3 节点的 schema 展开用真实 _io 校验（comfy_api 已可离线导入）
from comfy_api.latest import _io as _comfy_io  # noqa: E402

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
        order = image_gen_edit._topo_order(graph)
        self.assertEqual(set(order), {"1", "2", "3"})
        self.assertLess(order.index("1"), order.index("2"))
        self.assertLess(order.index("3"), order.index("2"))

    def test_cycle_raises(self):
        graph = {
            "1": {"class_type": "_Add", "inputs": {"a": ["2", 0], "b": ["1", 0]}},
            "2": {"class_type": "_Add", "inputs": {"a": ["1", 0], "b": ["2", 0]}},
        }
        with self.assertRaises(RuntimeError):
            image_gen_edit._topo_order(graph)


class NormalizeTests(unittest.TestCase):
    def test_single_value(self):
        self.assertEqual(image_gen_edit._normalize_outputs(5, ("IMAGE",)), [5])

    def test_single_1tuple(self):
        self.assertEqual(image_gen_edit._normalize_outputs((7,), ("IMAGE",)), [7])

    def test_multi(self):
        self.assertEqual(image_gen_edit._normalize_outputs((1, 2), ("A", "B")), [1, 2])


class ModelInjectionTests(unittest.TestCase):
    """_model_injection_node：定位外部 MODEL 注入点 + 沿 model 边追纯模型链。"""

    def test_vdn_chain_injects_at_sigma_shift_source(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "60": {"class_type": "ApplyVDNH3Advanced", "inputs": {"model": ["1", 0]}},
            "5": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["60", 0]}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["5", 0], "steps": 8}},
        }
        x_id, pruned = image_gen_edit._model_injection_node(graph)
        self.assertEqual(x_id, "60")          # SigmaShift.model 的来源（VDN 节点）
        self.assertEqual(pruned, {"1"})       # 只追 model 边 → UNETLoader

    def test_k_sampler_direct_unet(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "10": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "steps": 8}},
        }
        x_id, pruned = image_gen_edit._model_injection_node(graph)
        self.assertEqual(x_id, "1")
        self.assertEqual(pruned, set())

    def test_lora_chain(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "20": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0]}},
            "10": {"class_type": "KSampler", "inputs": {"model": ["20", 0], "steps": 8}},
        }
        x_id, pruned = image_gen_edit._model_injection_node(graph)
        self.assertEqual(x_id, "20")
        self.assertEqual(pruned, {"1"})

    def test_shared_inputs_not_pruned(self):
        # Krea2EditModelPatch 除 model 外还吃 vae/latent：只追 model 边，共享节点不被误删
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "3": {"class_type": "VAELoader", "inputs": {}},
            "9": {"class_type": "EmptySD3LatentImage", "inputs": {}},
            "14": {"class_type": "Krea2EditModelPatch",
                   "inputs": {"model": ["1", 0], "vae": ["3", 0], "target_latent": ["9", 0]}},
            "10": {"class_type": "KSampler", "inputs": {"model": ["14", 0], "steps": 8}},
        }
        x_id, pruned = image_gen_edit._model_injection_node(graph)
        self.assertEqual(x_id, "14")
        self.assertEqual(pruned, {"1"})       # 只删 UNETLoader，VAE/latent 保留

    def test_no_sink_returns_none(self):
        graph = {"1": {"class_type": "UNETLoader", "inputs": {}}}
        x_id, pruned = image_gen_edit._model_injection_node(graph)
        self.assertIsNone(x_id)
        self.assertEqual(pruned, set())


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
        out = image_gen_edit.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 1.5)))

    def test_unknown_node_raises(self):
        graph = {"1": {"class_type": "NoSuchNode", "inputs": {}}}
        with self.assertRaises(RuntimeError):
            image_gen_edit.execute_graph_inprocess(graph)

    def test_overrides_skip_execution(self):
        # 命中的节点直接采用给定输出、跳过 forward（外部 MODEL 注入的执行侧）
        marker = torch.full((1, 2, 2, 3), 7.0)
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},   # 正常会产出 ones，被 override 覆盖
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        out = image_gen_edit.execute_graph_inprocess(graph, overrides={"1": [marker]})
        self.assertTrue(torch.allclose(out, marker))

    def test_overrides_none_preserves_behavior(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        out = image_gen_edit.execute_graph_inprocess(graph, overrides=None)
        self.assertTrue(torch.allclose(out, torch.ones(1, 2, 2, 3)))


class ImageToUriTests(unittest.TestCase):
    def test_roundtrip(self):
        from PIL import Image
        uri = image_gen_edit._image_to_data_uri(torch.full((1, 2, 3, 3), 0.5))
        self.assertTrue(uri.startswith("data:image/png;base64,"))
        img = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))
        self.assertEqual(img.size, (3, 2))


class GenerateTests(unittest.TestCase):
    def setUp(self):
        self._orig_map = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update({"_SourceA": _SourceA})
        self._saved = {k: getattr(image_gen_edit, k) for k in
                       ("load_skill_workflow", "resolve_request", "render_template",
                        "get_settings", "get_skill_gen_config", "get_bundle")}

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig_map)
        for k, v in self._saved.items():
            setattr(image_gen_edit, k, v)

    def run_node(self, **kwargs):
        """跑节点 execute 并取第一个输出（V3 返回 NodeOutput）。"""
        return image_gen_edit.NeoImageGenEdit.execute(**kwargs).args[0]

    def test_missing_workflow_raises(self):
        image_gen_edit.load_skill_workflow = lambda sid: None
        with self.assertRaises(RuntimeError):
            self.run_node(skill_id="nope", prompt="hi")

    def test_happy_path_returns_image(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: {"template": True}
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        image_gen_edit.resolve_request = lambda body, settings, **kw: {"p": 1}
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        out = self.run_node(skill_id="ok", prompt="hi", seed=42, count=1)
        self.assertTrue(torch.allclose(out, torch.ones(1, 2, 2, 3)))

    def test_generate_model_injection(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "20": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0]}},
            "10": {"class_type": "KSampler", "inputs": {"model": ["20", 0], "steps": 8}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: {"template": True}
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        image_gen_edit.resolve_request = lambda body, settings, **kw: {"p": 1}
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        orig_exec = image_gen_edit.execute_graph_inprocess
        captured = {}
        image_gen_edit.execute_graph_inprocess = (
            lambda g, output_type="IMAGE", overrides=None: (captured.update(graph=g, overrides=overrides), "img")[1])
        try:
            ext = object()
            out = self.run_node(skill_id="ok", prompt="hi", model=ext)
        finally:
            image_gen_edit.execute_graph_inprocess = orig_exec
        self.assertEqual(out, "img")
        self.assertEqual(captured["graph"]["10"]["inputs"]["steps"], 8)   # steps 由模板决定，节点不再覆盖
        self.assertNotIn("1", captured["graph"])                          # UNETLoader（纯模型链）被剪掉
        self.assertIn("20", captured["graph"])                            # LoRA 节点作为注入点保留
        self.assertEqual(captured["overrides"], {"20": [ext]})

    def test_generate_no_model_leaves_graph_untouched(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "10": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "steps": 8}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: {"template": True}
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        image_gen_edit.resolve_request = lambda body, settings, **kw: {"steps": 8}
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        orig_exec = image_gen_edit.execute_graph_inprocess
        captured = {}
        image_gen_edit.execute_graph_inprocess = (
            lambda g, output_type="IMAGE", overrides=None: (captured.update(graph=g, overrides=overrides), "img")[1])
        try:
            self.run_node(skill_id="ok", prompt="hi")
        finally:
            image_gen_edit.execute_graph_inprocess = orig_exec
        self.assertIsNone(captured["overrides"])                          # 无外部模型 → 不注入
        self.assertIn("1", captured["graph"])                             # UNETLoader 保留
        self.assertEqual(captured["graph"]["10"]["inputs"]["steps"], 8)   # steps 由模板决定，节点不再覆盖

    def test_generate_width_height_override(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: {"template": True}
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        captured = {}
        image_gen_edit.resolve_request = lambda body, settings, **kw: (captured.update(body=body), {"p": 1})[1]
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        # 显式宽高 >0 → 写入 body（覆盖 skill/preset 比例）
        self.run_node(skill_id="ok", prompt="hi", width=1024, height=768)
        self.assertEqual(captured["body"].get("width"), 1024)
        self.assertEqual(captured["body"].get("height"), 768)
        # 默认 -1 → 不写入 body，交由 skill/preset 比例
        captured.clear()
        self.run_node(skill_id="ok", prompt="hi")
        self.assertNotIn("width", captured["body"])
        self.assertNotIn("height", captured["body"])

    def test_generate_steps_override(self):
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: {"template": True}
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        captured = {}
        image_gen_edit.resolve_request = lambda body, settings, **kw: (captured.update(body=body), {"p": 1})[1]
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        # 显式 steps >0 → 写入 body（覆盖 skill config.json 默认值）
        self.run_node(skill_id="ok", prompt="hi", steps=8)
        self.assertEqual(captured["body"].get("steps"), 8)
        # 默认 -1 → 不写入 body，交由 skill config.json 的 steps（缺省 20）
        captured.clear()
        self.run_node(skill_id="ok", prompt="hi")
        self.assertNotIn("steps", captured["body"])

    def _capture_request(self, template, **node_kwargs):
        """跑节点并捕获 resolve_request 收到的 body / 参数。"""
        graph = {
            "1": {"class_type": "_SourceA", "inputs": {}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        }
        image_gen_edit.load_skill_workflow = lambda sid: template
        image_gen_edit.get_settings = lambda: {}
        image_gen_edit.get_skill_gen_config = lambda sid: {}
        captured = {}
        image_gen_edit.resolve_request = (
            lambda body, settings, **kw: (captured.update(body=body, **kw), {"p": 1})[1])
        image_gen_edit.render_template = lambda tpl, params: (graph, [])
        self.run_node(**node_kwargs)
        return captured

    def test_refs_become_ordered_references(self):
        # Autogrow 参考图 dict（乱序 + 空槽）→ body.references 按槽位序号排的 data URI 列表
        captured = self._capture_request(
            {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}}},
            skill_id="ok", prompt="hi",
            refs={"image_3": torch.zeros(1, 2, 2, 3), "image_1": torch.ones(1, 2, 2, 3)})
        refs = captured["body"]["references"]
        self.assertEqual([r["kind"] for r in refs], ["data", "data"])
        self.assertTrue(all(r["data"].startswith("data:image/png;base64,") for r in refs))
        png1 = base64.b64decode(refs[0]["data"].split(",", 1)[1])
        self.assertNotEqual(png1, base64.b64decode(refs[1]["data"].split(",", 1)[1]))  # 顺序未被 dict 打乱

    def test_no_refs_leaves_body_without_references(self):
        captured = self._capture_request({"1": {"class_type": "UNETLoader", "inputs": {}}},
                                         skill_id="ok", prompt="hi", refs={})
        self.assertNotIn("references", captured["body"])

    def test_bundle_references_win_over_node_refs(self):
        bundle_refs = [{"kind": "data", "data": "data:image/png;base64,AAA"}]
        image_gen_edit.get_bundle = lambda bid: {"references": bundle_refs}
        captured = self._capture_request({"1": {"class_type": "UNETLoader", "inputs": {}}},
                                         skill_id="ok", prompt="", bundle="b1",
                                         refs={"image_1": torch.ones(1, 2, 2, 3)})
        self.assertEqual(captured["body"]["references"], bundle_refs)

    def test_max_refs_and_quadview_follow_template(self):
        # 多路槽位模板（Qwen Image 2.1）：max_refs=槽位数、不自动挑选 Krea2 四视图 LoRA
        qwen = {"3": {"class_type": "TextEncodeQwenImage21",
                      "inputs": {"images.image_1": "{{REF_IMAGE_1}}", "images.image_4": "{{REF_IMAGE_4}}"}}}
        captured = self._capture_request(qwen, skill_id="ok", prompt="hi")
        self.assertEqual(captured["max_refs"], 4)
        self.assertFalse(captured["auto_quadview"])

        # Krea2 单路编辑模板：max_refs=1、保留四视图 LoRA 自动挑选
        krea2 = {"2": {"class_type": "Krea2EditModelPatch", "inputs": {"image": "{{REF_IMAGE}}"}}}
        captured = self._capture_request(krea2, skill_id="ok", prompt="hi")
        self.assertEqual(captured["max_refs"], 1)
        self.assertTrue(captured["auto_quadview"])


class OrderedRefsTests(unittest.TestCase):
    """_ordered_refs：Autogrow 槽位 dict → 按序号排序的参考图列表。"""

    def test_sorted_by_slot_index_and_skips_empty(self):
        a, b, c = object(), object(), object()
        refs = {"image_10": a, "image_2": b, "image_3": None, "image_1": c}
        self.assertEqual(image_gen_edit._ordered_refs(refs), [c, b, a])

    def test_empty_or_none(self):
        self.assertEqual(image_gen_edit._ordered_refs(None), [])
        self.assertEqual(image_gen_edit._ordered_refs({}), [])

    def test_unknown_key_keeps_insertion_order(self):
        a, b = object(), object()
        self.assertEqual(image_gen_edit._ordered_refs({"weird": a, "image_1": b}), [a, b])


class SchemaTests(unittest.TestCase):
    """V3 节点 schema：节点名 / 显示名 / 输出标签 + Autogrow 参考图槽位。"""

    def test_node_mappings_and_display_name(self):
        self.assertEqual(image_gen_edit.NODE_CLASS_MAPPINGS, {"NeoImageGenEdit": image_gen_edit.NeoImageGenEdit})
        self.assertEqual(image_gen_edit.NODE_DISPLAY_NAME_MAPPINGS,
                         {"NeoImageGenEdit": "Neo Image Gen & Edit"})

    def test_schema_identity_and_output_label(self):
        schema = image_gen_edit.NeoImageGenEdit.GET_SCHEMA()
        self.assertEqual(schema.node_id, "NeoImageGenEdit")
        self.assertEqual(schema.display_name, "Neo Image Gen & Edit")
        self.assertEqual(schema.category, "Neo-Nodes")
        self.assertEqual(len(schema.outputs), 1)
        # 输出标签沿用旧节点的 images（下游按序号连线，标签仅影响 UI 显示）
        self.assertEqual(schema.outputs[0].display_name, "images")

    def test_comfyui_registration_validation_passes(self):
        # ComfyUI 注册 V3 节点时走同一套校验（define_schema/execute 齐备 + schema.finalize 合法）
        image_gen_edit.NeoImageGenEdit.VALIDATE_CLASS()
        self.assertIs(image_gen_edit.NeoImageGenEdit.FINALIZE_SCHEMA().node_id, "NeoImageGenEdit")


class ResolveSkillIdTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(image_gen_edit, k) for k in ("scan_skills", "load_skill_workflow")}

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(image_gen_edit, k, v)

    def test_resolve_name_to_id(self):
        image_gen_edit.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        image_gen_edit.load_skill_workflow = lambda sid: {"t": True}
        self.assertEqual(image_gen_edit._resolve_skill_id("Alpha"), "a")
        self.assertEqual(image_gen_edit._resolve_skill_id("Beta"), "b")

    def test_resolve_fallback_to_id(self):
        image_gen_edit.scan_skills = lambda: [{"id": "a", "name": "Alpha", "gen_image": True}]
        image_gen_edit.load_skill_workflow = lambda sid: {"t": True}
        self.assertEqual(image_gen_edit._resolve_skill_id("legacy-id"), "legacy-id")

    def test_input_types_uses_names(self):
        image_gen_edit.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        image_gen_edit.load_skill_workflow = lambda sid: {"t": True}
        it = image_gen_edit.NeoImageGenEdit.INPUT_TYPES()
        io_type, opts = it["required"]["skill_id"]
        self.assertEqual(io_type, "COMBO")
        self.assertEqual(opts["options"], ["Alpha", "Beta"])
        self.assertEqual(opts["default"], "Alpha")

    def test_input_types_excludes_no_workflow(self):
        image_gen_edit.scan_skills = lambda: [
            {"id": "a", "name": "Alpha", "gen_image": True},
            {"id": "b", "name": "Beta", "gen_image": True},
        ]
        image_gen_edit.load_skill_workflow = lambda sid: {"t": True} if sid == "a" else None
        it = image_gen_edit.NeoImageGenEdit.INPUT_TYPES()
        self.assertEqual(it["required"]["skill_id"][1]["options"], ["Alpha"])

    def test_refs_is_autogrow_with_optional_slots(self):
        # 参考图走 io.Autogrow（min=0）：展开后是 refs.image_1..refs.image_10 全部可选，
        # 不挂参考图的文生图路径不受影响
        image_gen_edit.scan_skills = lambda: [{"id": "a", "name": "Alpha", "gen_image": True}]
        image_gen_edit.load_skill_workflow = lambda sid: {"t": True}
        it = image_gen_edit.NeoImageGenEdit.INPUT_TYPES()
        self.assertEqual(it["required"]["refs"][0], "COMFY_AUTOGROW_V3")

        expanded, _, v3_data = _comfy_io.get_finalized_class_inputs(
            it, {"skill_id": "Alpha", "prompt": ""})
        self.assertNotIn("refs", expanded["required"])
        self.assertNotIn("refs", expanded.get("optional", {}))
        slots = [k for k in expanded.get("optional", {}) if k.startswith("refs.image_")]
        self.assertEqual(len(slots), 10)
        # 一个槽位都没挂：dynamic_paths 给组名，主循环据此把 refs 传成空 dict（文生图路径）
        self.assertEqual(v3_data["dynamic_paths"], {"refs": "refs"})

        # 挂了第 2 张：dynamic_paths 指向该槽位，主循环收成 {"refs": {"image_2": ...}}
        expanded2, _, v3_data2 = _comfy_io.get_finalized_class_inputs(
            it, {"skill_id": "Alpha", "prompt": "", "refs.image_2": ["9", 0]})
        self.assertIn("refs.image_2", expanded2.get("optional", {}))
        self.assertEqual(v3_data2["dynamic_paths"], {"refs.image_2": "refs.image_2"})


class SkillDimsRouteTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(image_gen_edit, k) for k in
                       ("_resolve_skill_id", "get_skill_gen_config", "get_settings")}

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(image_gen_edit, k, v)

    @staticmethod
    def _req(skill_id):
        return types.SimpleNamespace(rel_url=types.SimpleNamespace(query={"skill_id": skill_id}))

    def test_returns_preset_dims(self):
        # 与 generate() 在 width/height/steps=-1 时同一路径：base_resolution + default_ratio → round 到 16，steps 取 skill config
        image_gen_edit._resolve_skill_id = lambda v: "sk_test"
        image_gen_edit.get_skill_gen_config = lambda sid: {"default_ratio": "16:9", "base_resolution": 1280, "steps": 25}
        image_gen_edit.get_settings = lambda: dict(_image_gen.DEFAULT_SETTINGS)
        resp = asyncio.run(image_gen_edit.skill_dims_route(self._req("Alpha")))
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertTrue(body["success"])
        self.assertEqual((body["width"], body["height"]), (1280, 720))
        self.assertEqual(body["steps"], 25)

    def test_steps_fallback_20_without_config(self):
        image_gen_edit._resolve_skill_id = lambda v: "sk_test"
        image_gen_edit.get_skill_gen_config = lambda sid: {"default_ratio": "16:9", "base_resolution": 1280}
        image_gen_edit.get_settings = lambda: dict(_image_gen.DEFAULT_SETTINGS)
        resp = asyncio.run(image_gen_edit.skill_dims_route(self._req("Alpha")))
        body = json.loads(resp.body)
        self.assertEqual(body["steps"], 20)

    def test_missing_skill_id_400(self):
        resp = asyncio.run(image_gen_edit.skill_dims_route(self._req("")))
        self.assertEqual(resp.status, 400)


if __name__ == "__main__":
    unittest.main()
