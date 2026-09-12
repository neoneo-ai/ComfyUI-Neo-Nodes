# SPDX-License-Identifier: Apache-2.0
"""h3_video_gen 的离线单测：mini-executor 的 V3 API 节点分支、{{LENGTH}} 占位符、
视频参数解析、gen_video 技能过滤。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
API 节点分支用带 define_schema + classmethod execute（返回 NodeOutput(.args)）的假节点验证。"""

import base64
import importlib.util
import io
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


class GenVideoSkillsTests(unittest.TestCase):
    def test_new_presets_are_video_skills(self):
        ids = {s["id"] for s in h3_video_gen._gen_video_skills()}
        self.assertIn("minimax_h3_t2v", ids)
        self.assertIn("minimax_h3_i2v", ids)

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


if __name__ == "__main__":
    unittest.main()