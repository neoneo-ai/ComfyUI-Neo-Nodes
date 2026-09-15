# SPDX-License-Identifier: Apache-2.0
"""h3_video_gen 的离线单测：mini-executor 的 V3 API 节点分支、{{LENGTH}} 占位符、
视频参数解析、gen_video 技能过滤。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
API 节点分支用带 define_schema + classmethod execute（返回 NodeOutput(.args)）的假节点验证。"""

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
from PIL import Image as _PILImage

_TMP = tempfile.mkdtemp(prefix="neo_h3vidgen_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors",
                         "minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors",
                      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors", "minimax_h3_video_vae_fp16.safetensors",
            "minimax_h3_audio_vae_fp32.safetensors"],
    "loras": ["h3/style_lora.safetensors"],
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
_nodes.MAX_RESOLUTION = 8192
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_h3vidgen_pkg"
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
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
video_gen = _load("video_gen", "video_gen.py")


# ---- V3 API 节点假实现：define_schema + classmethod execute，返回 NodeOutput(.args) ----
class _FakeNodeOutput:
    def __init__(self, *args):
        self.args = args


def _data_uri(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


class _ApiSingle:
    """单 IMAGE 输出的 API 节点；execute 把标量 value 广播成张量。"""

    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def define_schema(cls):
        return object()

    @classmethod
    def execute(cls, value):
        return _FakeNodeOutput(torch.full((1, 2, 2, 3), float(value)))


class _ApiAV:
    """双输出 (CONDITIONING, LATENT) 的 API 节点。"""

    RETURN_TYPES = ("CONDITIONING", "LATENT")

    @classmethod
    def define_schema(cls):
        return object()

    @classmethod
    def execute(cls, clip, vae):
        return _FakeNodeOutput("cond", torch.full((1, 2, 2, 3), 9.0))


class _LegacyDecode:
    """legacy FUNCTION 节点：把 latent 原样当作 IMAGE 输出（终端）。"""

    FUNCTION = "decode"
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",)}}

    def decode(self, latent):
        return latent


class _LegacySource:
    FUNCTION = "src"
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def src(self):
        return torch.ones(1, 2, 2, 3)


class ApiNodeExecutorTests(unittest.TestCase):
    def setUp(self):
        self._orig = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update(
            {"_ApiSingle": _ApiSingle, "_ApiAV": _ApiAV,
             "_LegacyDecode": _LegacyDecode, "_LegacySource": _LegacySource})

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig)

    def test_api_single_output_terminal(self):
        graph = {"1": {"class_type": "_ApiSingle", "inputs": {"value": 5}}}
        out = krea2_generate.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 5.0)))

    def test_api_multi_output_downstream_ref(self):
        # _ApiAV 输出 [0]=cond [1]=latent；legacy 解码器取 index 1 作为终端 IMAGE
        graph = {
            "1": {"class_type": "_ApiAV", "inputs": {"clip": "c", "vae": "v"}},
            "2": {"class_type": "_LegacyDecode", "inputs": {"latent": ["1", 1]}},
        }
        out = krea2_generate.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 9.0)))

    def test_is_api_node_detection(self):
        self.assertTrue(krea2_generate._is_api_node(_ApiSingle))
        self.assertFalse(krea2_generate._is_api_node(_LegacySource))

    def test_api_outputs_unwrap_args(self):
        self.assertEqual(krea2_generate._api_outputs(_FakeNodeOutput(1, 2)), [1, 2])
        self.assertEqual(krea2_generate._api_outputs((3, 4)), [3, 4])
        self.assertEqual(krea2_generate._api_outputs(7), [7])


class LengthPlaceholderTests(unittest.TestCase):
    def test_length_substituted_as_int(self):
        template = {"1": {"class_type": "X", "inputs": {"length": "{{LENGTH}}", "n": 3}}}
        graph, _ = h3_video_gen.render_template(template, {"length": 124})
        self.assertEqual(graph["1"]["inputs"]["length"], 124)
        self.assertIsInstance(graph["1"]["inputs"]["length"], int)


class SecondsToFramesTests(unittest.TestCase):
    def test_aligns_to_17k_plus_5_grid(self):
        # 官方公式：24fps 取整后向上对齐到模型的 17k+5 网格
        self.assertEqual(h3_video_gen._seconds_to_frames(5), 124)   # ~5s（默认/训练下限）
        self.assertEqual(h3_video_gen._seconds_to_frames(3), 73)    # 参考工作流 length=73
        self.assertEqual(h3_video_gen._seconds_to_frames(10), 243)

    def test_small_values_clamp_to_min(self):
        self.assertEqual(h3_video_gen._seconds_to_frames(0), 5)     # max(5, ...) 下限
        self.assertEqual(h3_video_gen._seconds_to_frames(1), 39)    # 24 → 对齐到 39

    def test_output_is_on_grid(self):
        for s in (1, 2, 5, 8, 15):
            self.assertEqual(h3_video_gen._seconds_to_frames(s) % 17, 5)


class ResolveVideoParamsTests(unittest.TestCase):
    def _cfg(self):
        return {
            "model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "vae": "minimax_h3_video_vae_fp16.safetensors",
            "width": 1344, "height": 768, "length": 124,
        }

    def setUp(self):
        self._orig_get_video_settings = h3_video_gen.get_video_settings
        h3_video_gen.get_video_settings = lambda: {}

    def tearDown(self):
        h3_video_gen.get_video_settings = self._orig_get_video_settings

    def test_resolves_models_and_dims(self):
        p = h3_video_gen.resolve_video_params({"prompt": " a cat ", "seed": 42}, self._cfg())
        self.assertEqual(p["prompt"], "a cat")
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
        self.assertEqual(p["vae"], "minimax_h3_video_vae_fp16.safetensors")
        self.assertEqual((p["width"], p["height"], p["length"]), (1344, 768, 124))
        self.assertEqual(p["seed"], 42)
        self.assertIsNone(p["ref_name"])

    def test_steps_defaults_20_and_reads_from_cfg(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["steps"], 20)   # config 未指定 → 默认 20
        cfg = self._cfg()
        cfg["steps"] = 35
        self.assertEqual(h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)["steps"], 35)

    def test_steps_rendered_into_sampler_as_int(self):
        import json as _json
        cfg = self._cfg()
        cfg["steps"] = 30
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_t2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        graph, _ = h3_video_gen.render_template(template, p)
        sampler = next(n for n in graph.values() if n.get("class_type") == "KSampler")
        self.assertEqual(sampler["inputs"]["steps"], 30)   # {{STEPS}} 渲染为 int


    def test_loras_resolved_from_cfg(self):
        # LoRA 复用生图解析：校验存在性 + 强度裁剪；视频无 ref_only，默认 False
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 0.8}]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["loras"], [{"name": "h3/style_lora.safetensors", "strength": 0.8, "ref_only": False}])

    def test_no_loras_configured_defaults_empty(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["loras"], [])

    def test_lora_injected_into_h3_model_chain(self):
        # 模板无 LoRA 槽位：动态在 UNETLoader(1) → MiniMaxH3SigmaShift(5) 之间插入 LoraLoaderModelOnly
        import json as _json
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 0.8}]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_t2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        graph, _ = h3_video_gen.render_template(template, p)
        lora_nodes = {nid: n for nid, n in graph.items() if n.get("class_type") == "LoraLoaderModelOnly"}
        self.assertEqual(len(lora_nodes), 1)
        nid, node = next(iter(lora_nodes.items()))
        self.assertEqual(node["inputs"]["model"], ["1", 0])
        self.assertEqual(node["inputs"]["lora_name"], "h3/style_lora.safetensors")
        self.assertEqual(node["inputs"]["strength_model"], 0.8)
        self.assertEqual(graph["5"]["inputs"]["model"], [nid, 0])

    def test_node_input_overrides_cfg(self):
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "width": 512, "height": 512, "length": 97}, self._cfg())
        self.assertEqual((p["width"], p["height"], p["length"]), (512, 512, 97))

    def test_missing_prompt_raises(self):
        with self.assertRaises(ValueError):
            h3_video_gen.resolve_video_params({"prompt": "   "}, self._cfg())

    def test_missing_model_auto_picks_h3(self):
        # 空值 = 自动挑选 H3（与生图 suggest_model 一致）；_MODELS 里有 h3 模型，应兜底成功
        cfg = self._cfg()
        del cfg["model"]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_no_h3_model_available_raises(self):
        # 目录里没有 H3 模型、设置与 skill config 都未指定时才报错
        orig = h3_video_gen.suggest_video_model
        h3_video_gen.suggest_video_model = lambda folder: ""
        try:
            cfg = self._cfg()
            del cfg["model"]
            with self.assertRaises(ValueError):
                h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        finally:
            h3_video_gen.suggest_video_model = orig

    def test_cfg_model_wins_over_global(self):
        h3_video_gen.get_video_settings = lambda: {"video_model": "global_only.safetensors"}
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_falls_back_to_global_video_settings(self):
        cfg = self._cfg()
        del cfg["model"]
        h3_video_gen.get_video_settings = lambda: {"video_model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors"}
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_random_seed_when_absent(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertGreaterEqual(p["seed"], 0)

    def test_reference_image_resolved(self):
        buf = io.BytesIO()
        _PILImage.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
        uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "data", "data": uri}]}, self._cfg())
        self.assertIsNotNone(p["ref_name"])
        self.assertTrue(p["ref_name"].startswith("NeoAgent/"))

    def test_references_split_by_media(self):
        # references 按 media 分成三类参考；缺省 media 视为参考图，ref_name 取第一张图
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": [
            {"kind": "data", "data": _data_uri("image/png", b"img")},
            {"kind": "data", "data": _data_uri("video/mp4", b"vid"), "media": "video"},
            {"kind": "data", "data": _data_uri("audio/wav", b"aud"), "media": "audio"},
        ]}, self._cfg())
        self.assertEqual(len(p["ref_images"]), 1)
        self.assertEqual(len(p["ref_videos"]), 1)
        self.assertEqual(len(p["ref_audios"]), 1)
        self.assertEqual(p["ref_name"], p["ref_images"][0])
        self.assertTrue(p["ref_videos"][0].endswith(".mp4"))
        self.assertTrue(p["ref_audios"][0].endswith(".wav"))

    def test_reference_caps_match_official_slots(self):
        # 参考节点上限 9 图 / 3 视频 / 3 音频，超出的按顺序丢弃
        refs = ([{"kind": "data", "data": _data_uri("image/png", bytes([i]))} for i in range(11)]
                + [{"kind": "data", "data": _data_uri("video/mp4", bytes([i])), "media": "video"} for i in range(5)]
                + [{"kind": "data", "data": _data_uri("audio/wav", bytes([i])), "media": "audio"} for i in range(5)])
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": refs}, self._cfg())
        self.assertEqual(len(p["ref_images"]), 9)
        self.assertEqual(len(p["ref_videos"]), 3)
        self.assertEqual(len(p["ref_audios"]), 3)

    def test_reference_media_mismatch_dropped(self):
        # media=image 却给 mp4：后缀不符不解析，避免把视频塞进 LoadImage
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("video/mp4", b"vid")}]},
            self._cfg())
        self.assertEqual(p["ref_images"], [])
        self.assertIsNone(p["ref_name"])

    def test_input_media_refs_resolved_by_kind(self):
        # 导演配方走 kind=input（input/ 下的相对名）：图/视频/音频分别按后缀识别
        for name in ("ref_a.png", "ref_v.mp4", "ref_s.wav"):
            with open(os.path.join(_INPUT_DIR, name), "wb") as f:
                f.write(b"media")
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": [
            {"kind": "input", "value": "ref_a.png"},
            {"kind": "input", "value": "ref_v.mp4", "media": "video"},
            {"kind": "input", "value": "ref_s.wav", "media": "audio"},
        ]}, self._cfg())
        self.assertEqual(p["ref_images"], ["ref_a.png"])
        self.assertEqual(p["ref_videos"], ["ref_v.mp4"])
        self.assertEqual(p["ref_audios"], ["ref_s.wav"])

    def test_last_frame_resolved_and_absent_by_default(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertIsNone(p["ref_last"], "未给尾帧时 ref_last 为 None")
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}},
            self._cfg())
        self.assertIsNotNone(p["ref_last"])
        self.assertTrue(p["ref_last"].startswith("NeoAgent/"))

    def test_audio_vae_resolved(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")

    def test_cfg_audio_vae_wins_over_autopick(self):
        cfg = self._cfg()
        cfg["audio_vae"] = "minimax_h3_video_vae_fp16.safetensors"  # 用视频 VAE 文件名验证 cfg 优先于自动挑选
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["audio_vae"], "minimax_h3_video_vae_fp16.safetensors")

    def test_no_audio_vae_available_raises(self):
        orig = h3_video_gen.suggest_audio_vae
        h3_video_gen.suggest_audio_vae = lambda: ""
        try:
            with self.assertRaises(ValueError):
                h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        finally:
            h3_video_gen.suggest_audio_vae = orig

    def test_falls_back_to_global_audio_vae_settings(self):
        # 关掉自动挑选后仍解析成功 → 证明走的是「生视频模型」设置里的 video_audio_vae
        orig = h3_video_gen.suggest_audio_vae
        h3_video_gen.suggest_audio_vae = lambda: ""
        h3_video_gen.get_video_settings = lambda: {"video_audio_vae": "minimax_h3_audio_vae_fp32.safetensors"}
        try:
            p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
            self.assertEqual(p["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")
        finally:
            h3_video_gen.suggest_audio_vae = orig


class NeoH3VideoGenerateTests(unittest.TestCase):
    """节点层：尾帧输入进 body["last_frame"]，bundle 参考优先等既有行为不变。"""

    def _patch(self, expect):
        orig = (h3_video_gen._resolve_skill_id, h3_video_gen.load_skill_workflow,
                h3_video_gen.get_skill_gen_config, h3_video_gen.resolve_video_params,
                h3_video_gen.render_template, h3_video_gen.execute_graph_inprocess)
        bodies = []
        h3_video_gen._resolve_skill_id = lambda v: v
        h3_video_gen.load_skill_workflow = lambda id: {"1": {}}
        h3_video_gen.get_skill_gen_config = lambda id: {}
        h3_video_gen.resolve_video_params = lambda body, cfg, skip_model=False: bodies.append(dict(body)) or {"prompt": body.get("prompt", "")}
        h3_video_gen.render_template = lambda tpl, params: ({}, [])
        h3_video_gen.execute_graph_inprocess = lambda graph, output_type="IMAGE", overrides=None: expect
        return orig, bodies

    def _restore(self, orig):
        (h3_video_gen._resolve_skill_id, h3_video_gen.load_skill_workflow,
         h3_video_gen.get_skill_gen_config, h3_video_gen.resolve_video_params,
         h3_video_gen.render_template, h3_video_gen.execute_graph_inprocess) = orig

    def test_last_frame_input_reaches_body(self):
        orig, bodies = self._patch("video_out")
        try:
            h3_video_gen.NeoH3VideoGenerate().generate(
                "minimax_h3_fl2v", prompt="p", image=torch.zeros(1, 4, 4, 3),
                last_frame=torch.zeros(1, 4, 4, 3))
        finally:
            self._restore(orig)
        body = bodies[0]
        self.assertEqual(len(body["references"]), 1)
        self.assertIn("last_frame", body)
        self.assertTrue(body["last_frame"]["data"].startswith("data:image/png;base64,"))

    def test_without_last_frame_body_has_no_last_frame(self):
        orig, bodies = self._patch("video_out")
        try:
            h3_video_gen.NeoH3VideoGenerate().generate("minimax_h3_i2v", prompt="p", image=torch.zeros(1, 4, 4, 3))
        finally:
            self._restore(orig)
        self.assertNotIn("last_frame", bodies[0])


class GenVideoSkillsTests(unittest.TestCase):
    def test_new_presets_are_video_skills(self):
        ids = {s["id"] for s in h3_video_gen._gen_video_skills()}
        self.assertIn("minimax_h3_t2v", ids)
        self.assertIn("minimax_h3_i2v", ids)
        self.assertIn("minimax-h3-r2v", ids)
        self.assertIn("minimax_h3_fl2v", ids)

    def test_image_presets_not_video_skills(self):
        ids = {s["id"] for s in h3_video_gen._gen_video_skills()}
        self.assertNotIn("image_gen", ids)


# ---- 真实模板端到端：假节点替代 H3/加载器，跑 preset 里的真实 workflow.json ----
class _F_UNETLoader:
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"unet_name": ("x",), "weight_dtype": ("y",)}}
    def load(self, unet_name, weight_dtype): return (torch.zeros(1),)


class _F_CLIPLoader:
    FUNCTION = "load"
    RETURN_TYPES = ("CLIP",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"clip_name": ("x",), "type": ("y",), "device": ("z",)}}
    def load(self, clip_name, type, device): return (torch.zeros(1),)


class _F_VAELoader:
    FUNCTION = "load"
    RETURN_TYPES = ("VAE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"vae_name": ("x",)}}
    def load(self, vae_name): return (f"VAE:{vae_name}",)


class _F_LoadImage:
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK")
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"image": ("x",)}}
    def load(self, image): return (torch.zeros(1, 4, 4, 3), torch.zeros(1, 4, 4))


class _F_KSampler:
    FUNCTION = "sample"
    RETURN_TYPES = ("LATENT", "MODEL")
    @classmethod
    def INPUT_TYPES(cls): return {"required": {}}
    def sample(self, model, seed, steps, cfg, sampler_name, scheduler,
               positive, negative, latent_image, denoise=1.0):
        return (latent_image, model)


class _F_VAEDecode:
    FUNCTION = "decode"
    RETURN_TYPES = ("IMAGE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}
    def decode(self, samples, vae): return torch.zeros(1, 4, 8, 8, 3)


class _F_H3ImageToVideo:
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, clip, vae, prompt, width, height, length, first_frame=None, last_frame=None):
        return _FakeNodeOutput("cond", torch.zeros(1))


class _F_H3SigmaShift:
    RETURN_TYPES = ("MODEL",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, model, shift_video, shift_audio):
        return _FakeNodeOutput(model)


class _F_LTXVSeparateAV:
    RETURN_TYPES = ("LATENT", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, av_latent):
        return _FakeNodeOutput(torch.zeros(1), torch.zeros(1))


class _F_VAEDecodeAudio:
    RETURN_TYPES = ("AUDIO",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, vae, samples):
        if "audio" not in str(vae).lower():
            raise AssertionError(f"VAEDecodeAudio 必须接音频 VAE，实际: {vae}")
        return _FakeNodeOutput("audio")


class _F_LoadVideo:
    FUNCTION = "load"
    RETURN_TYPES = ("VIDEO",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"file": ("x",)}}
    def load(self, file): return (f"video:{file}",)


class _F_LoadAudio:
    FUNCTION = "load"
    RETURN_TYPES = ("AUDIO",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"audio": ("x",)}}
    def load(self, audio): return (f"audio:{audio}",)


class _F_GetVideoComponents:
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, video):
        return _FakeNodeOutput(torch.zeros(1, 4, 4, 3), "video_audio", 24.0, 8)


class _F_H3ReferenceToVideo:
    """假参考节点：校验点号 autogrow 输入被收成嵌套 dict（ref_images.ref_image_0 → {"ref_image_0": ...}）。"""

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, clip, vae, audio_vae, prompt, width, height, length, ref_image_size="match",
                ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None):
        for group in (ref_images, ref_videos, ref_audios):
            if group is not None:
                assert isinstance(group, dict), f"autogrow 参考应为嵌套 dict，实际: {type(group)}"
        return _FakeNodeOutput("cond", torch.zeros(1))


class _F_CreateVideo:
    RETURN_TYPES = ("VIDEO",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, images, fps, audio=None, bit_depth=8):
        return _FakeNodeOutput(("video", images, fps, audio))


class RealTemplateExecutionTests(unittest.TestCase):
    _FAKES = {
        "UNETLoader": _F_UNETLoader, "CLIPLoader": _F_CLIPLoader, "VAELoader": _F_VAELoader,
        "LoadImage": _F_LoadImage, "KSampler": _F_KSampler, "VAEDecode": _F_VAEDecode,
        "MiniMaxH3ImageToVideo": _F_H3ImageToVideo, "MiniMaxH3SigmaShift": _F_H3SigmaShift,
        "LTXVSeparateAVLatent": _F_LTXVSeparateAV,
        "VAEDecodeAudio": _F_VAEDecodeAudio, "CreateVideo": _F_CreateVideo,
        "MiniMaxH3ReferenceToVideo": _F_H3ReferenceToVideo, "LoadVideo": _F_LoadVideo,
        "LoadAudio": _F_LoadAudio, "GetVideoComponents": _F_GetVideoComponents,
    }

    def setUp(self):
        self._orig = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update(self._FAKES)

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig)

    def _run_preset(self, preset, with_ref):
        import json as _json
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "a cat walks"}
        if with_ref:
            buf = io.BytesIO()
            _PILImage.new("RGB", (4, 4)).save(buf, format="PNG")
            uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
            body["references"] = [{"kind": "data", "data": uri}]
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(template, params)
        out = krea2_generate.execute_graph_inprocess(graph, output_type="VIDEO")
        self.assertEqual(out[0], "video")      # 末端 CreateVideo 的 VIDEO marker
        self.assertEqual(out[2], 24)           # fps=24
        self.assertEqual(out[3], "audio")      # 音频来自 VAEDecodeAudio

    def test_t2v_template_executes(self):
        self._run_preset("minimax_h3_t2v", with_ref=False)

    def test_i2v_template_executes(self):
        self._run_preset("minimax_h3_i2v", with_ref=True)

    def _r2v_template(self):
        import json as _json
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax-h3-r2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            return _json.load(f)

    def _preset_template(self, preset):
        import json as _json
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json"), encoding="utf-8") as f:
            return _json.load(f)

    def _fl2v_cfg(self):
        return {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                "vae": "minimax_h3_video_vae_fp16.safetensors"}

    def test_fl2v_template_wires_first_and_last_frame(self):
        # 首尾帧：两个 LoadImage 分别接 first_frame / last_frame
        body = {"prompt": "a cat walks",
                "references": [{"kind": "data", "data": _data_uri("image/png", b"first")}],
                "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["13", "9"])
        self.assertEqual(graph["4"]["inputs"]["first_frame"], ["9", 0])
        self.assertEqual(graph["4"]["inputs"]["last_frame"], ["13", 0])
        self.assertEqual(krea2_generate.execute_graph_inprocess(graph, output_type="VIDEO")[0], "video")

    def test_fl2v_without_last_frame_prunes_last_node(self):
        # 只给首帧 → 尾帧 LoadImage 与连线一并裁掉（退化为 I2VA）
        body = {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("image/png", b"first")}]}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["9"])
        self.assertIn("first_frame", graph["4"]["inputs"])
        self.assertNotIn("last_frame", graph["4"]["inputs"])

    def test_fl2v_without_first_frame_prunes_first_node(self):
        # 只给尾帧 → 首帧 LoadImage 裁掉（退化为 L2VA，模板仍可执行）
        body = {"prompt": "x", "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["13"])
        self.assertNotIn("first_frame", graph["4"]["inputs"])
        self.assertIn("last_frame", graph["4"]["inputs"])

    def test_fl2v_needs_at_least_one_frame(self):
        params = h3_video_gen.resolve_video_params({"prompt": "x"}, self._fl2v_cfg())
        with self.assertRaises(ValueError):
            h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)

    def _nodes_of(self, graph, class_type):
        return sorted(nid for nid, n in graph.items() if n.get("class_type") == class_type)

    def test_r2v_template_executes_with_all_reference_kinds(self):
        # 参考图/参考视频/参考音频各自填入对应槽位；未挂的槽位连同加载链裁掉
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "a cat walks", "references": [
            {"kind": "data", "data": _data_uri("image/png", b"img1")},
            {"kind": "data", "data": _data_uri("image/png", b"img2")},
            {"kind": "data", "data": _data_uri("video/mp4", b"vid1"), "media": "video"},
            {"kind": "data", "data": _data_uri("audio/wav", b"aud1"), "media": "audio"},
        ]}
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["21", "22"])
        self.assertEqual(self._nodes_of(graph, "LoadVideo"), ["31"])
        self.assertEqual(self._nodes_of(graph, "GetVideoComponents"), ["41"])
        self.assertEqual(self._nodes_of(graph, "LoadAudio"), ["51"])
        ref_in = graph["5"]["inputs"]
        self.assertIn("ref_images.ref_image_1", ref_in)
        self.assertNotIn("ref_images.ref_image_2", ref_in)   # 只挂 2 张图 → 其余槽位裁掉
        self.assertNotIn("ref_videos.ref_video_1", ref_in)
        self.assertIn("ref_audios.ref_audio_0", ref_in)
        self.assertNotIn("{{", json.dumps(graph), "渲染后不应残留占位符")
        out = krea2_generate.execute_graph_inprocess(graph, output_type="VIDEO")
        self.assertEqual(out[0], "video")
        self.assertEqual(out[2], 24)
        self.assertEqual(out[3], "audio")

    def test_r2v_template_single_image_prunes_video_and_audio(self):
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("image/png", b"only")}]}
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["21"])
        for cls in ("LoadVideo", "GetVideoComponents", "LoadAudio"):
            self.assertEqual(self._nodes_of(graph, cls), [], f"{cls} 无对应参考时应整条裁掉")
        self.assertIn("ref_images.ref_image_0", graph["5"]["inputs"])
        self.assertNotIn("ref_images.ref_image_1", graph["5"]["inputs"])
        self.assertNotIn("ref_videos.ref_video_0", graph["5"]["inputs"])
        self.assertNotIn("ref_audios.ref_audio_0", graph["5"]["inputs"])
        self.assertEqual(krea2_generate.execute_graph_inprocess(graph, output_type="VIDEO")[0], "video")

    def test_r2v_template_requires_reference(self):
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        params = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        with self.assertRaises(ValueError):
            h3_video_gen.render_template(self._r2v_template(), params)


class VideoModelsSortTests(unittest.TestCase):
    """/neo_video_gen/models 下拉展示：H3 相关靠前（与生图 krea2-first 独立）。"""

    def test_scan_video_models_sorts_h3_first(self):
        out = video_gen.scan_video_models()
        self.assertEqual(out["diffusion_models"][0], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
        self.assertEqual(out["text_encoders"][0], "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
        self.assertEqual(out["vae"][:2], ["minimax_h3_audio_vae_fp32.safetensors",
                                          "minimax_h3_video_vae_fp16.safetensors"])
        self.assertIn("loras", out, "生视频模型接口应返回 loras 列表供 LoRA 下拉")

    def test_video_display_sort_prefers_h3_then_name(self):
        files = ["zeta.safetensors", "Minimax_H3/base.safetensors", "alpha.safetensors"]
        self.assertEqual(video_gen._video_display_sort(files),
                         ["Minimax_H3/base.safetensors", "alpha.safetensors", "zeta.safetensors"])


class H3ModelStepsOverrideTests(unittest.TestCase):
    """外部 MODEL / steps 覆盖：注入点定位、纯模型链剪枝、skip_model、steps 落 params。"""

    def setUp(self):
        self._saved = {k: getattr(h3_video_gen, k) for k in (
            "_resolve_skill_id", "load_skill_workflow", "get_skill_gen_config",
            "resolve_video_params", "render_template", "execute_graph_inprocess")}

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(h3_video_gen, k, v)

    def _vdn_graph(self):
        return {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "60": {"class_type": "ApplyVDNH3Advanced", "inputs": {"model": ["1", 0]}},
            "5": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["60", 0]}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["5", 0], "steps": "{{STEPS}}"}},
        }

    def test_model_injection_prunes_chain_and_skips_vdn_check(self):
        h3_video_gen._resolve_skill_id = lambda v: v
        h3_video_gen.load_skill_workflow = lambda sid: {"t": True}
        h3_video_gen.get_skill_gen_config = lambda sid: {}
        skip_flags = []
        h3_video_gen.resolve_video_params = (
            lambda body, cfg, skip_model=False: (skip_flags.append(skip_model), {"prompt": "p"})[1])
        rendered = {}

        def fake_render(tpl, params):
            rendered.update(params)
            return self._vdn_graph(), []

        h3_video_gen.render_template = fake_render
        captured = {}
        h3_video_gen.execute_graph_inprocess = (
            lambda graph, output_type="IMAGE", overrides=None:
            (captured.update(graph=graph, overrides=overrides), "video")[1])

        ext = object()
        (out,) = h3_video_gen.NeoH3VideoGenerate().generate("minimax_h3_vdn_t2v", prompt="p", model=ext, steps=6)
        self.assertEqual(out, "video")
        self.assertEqual(skip_flags, [True])                  # 外部模型 → skip_model=True
        self.assertEqual(rendered["steps"], 6)                # steps 覆盖落进 params（{{STEPS}}）
        self.assertNotIn("1", captured["graph"])              # UNETLoader（纯模型链）剪掉
        self.assertIn("60", captured["graph"])                # VDN 节点保留（被 override，无需插件）
        self.assertEqual(captured["overrides"], {"60": [ext]})

    def test_no_model_runs_vdn_check_and_keeps_chain(self):
        h3_video_gen._resolve_skill_id = lambda v: v
        h3_video_gen.load_skill_workflow = lambda sid: {"t": True}
        h3_video_gen.get_skill_gen_config = lambda sid: {}
        skip_flags = []
        h3_video_gen.resolve_video_params = (
            lambda body, cfg, skip_model=False: (skip_flags.append(skip_model), {"prompt": "p"})[1])
        h3_video_gen.render_template = lambda tpl, params: (self._vdn_graph(), [])
        # 未装 VDN 插件 → _require_vdn_plugin 报错（仅无外部模型时才走该检查）
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_gen.NeoH3VideoGenerate().generate("minimax_h3_vdn_t2v", prompt="p")
        self.assertIn("ComfyUI-VDN-H3", str(ctx.exception))
        self.assertEqual(skip_flags, [False])


class VdnSkillTests(unittest.TestCase):
    """VDN 加速 skill：未装 ComfyUI-VDN-H3 时的明确报错 + 4 个 VDN preset 的结构校验。"""

    def test_vdn_missing_plugin_raises_clear_error(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "60": {"class_type": "ApplyVDNH3Advanced",
                   "inputs": {"model": ["1", 0], "vdn_checkpoint": "stage-dmd-step-250"}},
        }
        self.assertNotIn("ApplyVDNH3Advanced", _nodes.NODE_CLASS_MAPPINGS)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_gen._require_vdn_plugin(graph)
        self.assertIn("ComfyUI-VDN-H3", str(ctx.exception))

    def test_vdn_registered_passes(self):
        class _FakeVdn:
            pass
        graph = {"60": {"class_type": "ApplyVDNH3Advanced", "inputs": {}}}
        _nodes.NODE_CLASS_MAPPINGS["ApplyVDNH3Advanced"] = _FakeVdn
        try:
            h3_video_gen._require_vdn_plugin(graph)   # 已注册 → 不报错
        finally:
            del _nodes.NODE_CLASS_MAPPINGS["ApplyVDNH3Advanced"]

    def test_non_vdn_graph_passes(self):
        graph = {"1": {"class_type": "UNETLoader", "inputs": {}},
                 "5": {"class_type": "MiniMaxH3SigmaShift", "inputs": {}}}
        h3_video_gen._require_vdn_plugin(graph)   # 无 VDN 节点 → 不报错

    def test_vdn_presets_wired_and_steps8(self):
        base = os.path.join(PLUGIN_DIR, "skills", "presets")
        for p in ("minimax_h3_vdn_t2v", "minimax_h3_vdn_i2v", "minimax_h3_vdn_fl2v", "minimax-h3-vdn-r2v"):
            wf = json.load(open(os.path.join(base, p, "workflow.json"), encoding="utf-8"))
            cfg = json.load(open(os.path.join(base, p, "config.json"), encoding="utf-8"))
            vdn = [nid for nid, n in wf.items() if str(n.get("class_type", "")).startswith("ApplyVDNH3")]
            self.assertEqual(len(vdn), 1, f"{p} 应恰有一个 VDN 节点")
            unet = [nid for nid, n in wf.items() if n.get("class_type") == "UNETLoader"]
            self.assertEqual(wf[vdn[0]]["inputs"]["model"], [unet[0], 0], f"{p} VDN 应接在 UNETLoader 之后")
            shifts = [n for n in wf.values() if n.get("class_type") == "MiniMaxH3SigmaShift"]
            self.assertTrue(any(n["inputs"]["model"] == [vdn[0], 0] for n in shifts), f"{p} SigmaShift 应接 VDN 输出")
            self.assertEqual(cfg.get("steps"), 8, f"{p} steps 应为 8")


if __name__ == "__main__":
    unittest.main()