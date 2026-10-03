# SPDX-License-Identifier: Apache-2.0
"""image_gen 的离线单测：比例/尺寸、输出路径消毒、请求解析、工作流模板渲染与技能路由。

不依赖 ComfyUI 运行中的服务器：server / folder_paths 用桩模块替换。
"""

import asyncio
import base64
import enum
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_image_gen_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors",
            "qwen_image/qwen_image_vae.safetensors"],
    "loras": ["style_a.safetensors", "sub/style_b.safetensors",
              "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors"],
}

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(
        get=lambda path: (lambda func: func),
        post=lambda path: (lambda func: func),
    ),
    prompt_queue=types.SimpleNamespace(),
    send_sync=lambda event, data, sid=None: None,
))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")


class _LatentPreviewMethod(enum.Enum):
    NoPreviews = "none"
    Auto = "auto"
    Latent2RGB = "latent2rgb"
    TAESD = "taesd"


_comfy_cli.LatentPreviewMethod = _LatentPreviewMethod
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188,
                                        tls_keyfile=None, tls_certfile=None,
                                        preview_method=_LatentPreviewMethod.NoPreviews)
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli

# krea2_edit（vendor）的 import 依赖：只补模块占位，不执行真实 ComfyUI 加载逻辑
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

# image_gen 顶部 import get_progress_state；桩掉 comfy_execution.progress，
# 单测里换 _progress_registry_holder["registry"] 模拟核心每次执行重建 registry
_comfy_exec = types.ModuleType("comfy_execution")
_comfy_exec_prog = types.ModuleType("comfy_execution.progress")
_progress_registry_holder = {"registry": types.SimpleNamespace(prompt_id="", nodes={}, handlers={})}
_comfy_exec_prog.get_progress_state = lambda: _progress_registry_holder["registry"]


class _ProgressHandlerStub:
    def __init__(self, name):
        self.name = name


def _add_progress_handler_stub(handler):
    _progress_registry_holder["registry"].handlers[handler.name] = handler


_comfy_exec_prog.ProgressHandler = _ProgressHandlerStub
_comfy_exec_prog.add_progress_handler = _add_progress_handler_stub
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

# skill.py 顶层 import nodes（运行期才读 NODE_CLASS_MAPPINGS）：桩掉避免拉起真实 ComfyUI
_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# image_gen 含相对导入（from .util import ...），需先建虚拟包再加载
_pkg = types.ModuleType("_neo_imgen_pkg")
_pkg.__path__ = [PLUGIN_DIR]
sys.modules["_neo_imgen_pkg"] = _pkg

_util_mod = types.ModuleType("_neo_imgen_pkg.util")
import logging as _logging
class _PF(_logging.Filter):
    def filter(self, record):
        return True
_util_mod.PrefixFilter = _PF
sys.modules["_neo_imgen_pkg.util"] = _util_mod
_pkg.util = _util_mod

_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.image_gen", os.path.join(PLUGIN_DIR, "image_gen.py"))
image_gen = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.image_gen"] = image_gen
_spec.loader.exec_module(image_gen)
_pkg.image_gen = image_gen

# image_gen 的路由处理器内惰性 `from . import skill`；把 skill.py 注册到虚拟包下，
# 让单测里相对导入可解析（与 test_skills 的桩策略一致）
_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.skill", os.path.join(PLUGIN_DIR, "skill.py"))
_skill_mod = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.skill"] = _skill_mod
_spec.loader.exec_module(_skill_mod)
_pkg.skill = _skill_mod


def base_settings():
    return dict(image_gen.DEFAULT_SETTINGS)


def write_png(path: str, width: int, height: int) -> bytes:
    from PIL import Image
    with Image.new("RGB", (width, height), (200, 30, 30)) as img:
        img.save(path, format="PNG")
    with open(path, "rb") as f:
        return f.read()


class RatioTests(unittest.TestCase):
    def test_parse_ratio(self):
        self.assertAlmostEqual(image_gen.parse_ratio("16:9"), 16 / 9)
        self.assertAlmostEqual(image_gen.parse_ratio("16x9"), 16 / 9)
        self.assertAlmostEqual(image_gen.parse_ratio("1.5"), 1.5)
        self.assertIsNone(image_gen.parse_ratio("bad"))
        self.assertIsNone(image_gen.parse_ratio("0"))

    def test_size_from_ratio(self):
        self.assertEqual(image_gen.size_from_ratio(2 / 3, 1536), (1024, 1536))
        self.assertEqual(image_gen.size_from_ratio(1.0, 1024), (1024, 1024))

    def test_explicit_dimensions_rounded(self):
        w, h = image_gen.resolve_dimensions(base_settings(), width=1000, height=1000)
        self.assertEqual((w, h), (1008, 1008))


class PrefixTests(unittest.TestCase):
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            image_gen.safe_prefix("NeoAgent/../../evil")

    def test_sanitized(self):
        self.assertEqual(image_gen.safe_prefix("a\\b<>c"), "a/bc")

    def test_slug(self):
        self.assertEqual(image_gen.slug_from_text("A red fox jumps over the fence"),
                         "a_red_fox_jumps_over_the")
        self.assertEqual(image_gen.slug_from_text("你好世界"), "")


class SuggestTests(unittest.TestCase):
    """自动挑选：Krea2 只精确匹配 Qwen3-VL-4B，8B/32B 不参与（挑了必报 conditioning 维度错误）"""

    def setUp(self):
        self._orig = image_gen._folder_files

    def tearDown(self):
        image_gen._folder_files = self._orig

    def _with_files(self, files):
        image_gen._folder_files = lambda folder: files

    def test_encoder_prefers_4b_over_8b(self):
        self._with_files(["qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(image_gen.suggest_model("text_encoders"),
                         "qwen3vl_4b_fp8_scaled.safetensors")

    def test_encoder_ignores_8b_and_32b(self):
        self._with_files(["qwen3vl_8b_nvfp4.safetensors",
                          "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"])
        self.assertEqual(image_gen.suggest_model("text_encoders"), "")

    def test_vae_prefers_qwen_image(self):
        self._with_files(["Krea2-HD-vae.safetensors", "qwen_image_vae.safetensors"])
        self.assertEqual(image_gen.suggest_model("vae"), "qwen_image_vae.safetensors")


class ScanModelsTests(unittest.TestCase):
    """下拉展示：krea2 相关靠前，且 LoRA「自动」给出后端建议的四视图 LoRA。"""

    def test_scan_models_sorts_krea2_first(self):
        out = image_gen.scan_models()
        self.assertEqual(out["loras"][0], "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertEqual(out["vae"][0], "krea2/diffusion_pytorch_model.safetensors")

    def test_scan_models_suggests_quadview_lora(self):
        out = image_gen.scan_models()
        self.assertEqual(out["suggested_lora"], "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")

    def test_display_sort_prefers_krea2_then_name(self):
        files = ["zeta.safetensors", "Krea2/base.safetensors", "alpha.safetensors"]
        self.assertEqual(image_gen._display_sort(files),
                         ["Krea2/base.safetensors", "alpha.safetensors", "zeta.safetensors"])


class ResolveTests(unittest.TestCase):
    def test_auto_model_selection(self):
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        self.assertEqual(params["model"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(params["text_encoder"], "qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors")
        self.assertEqual(params["vae"], "qwen_image/qwen_image_vae.safetensors")
        self.assertEqual(params["count"], 1)

    def test_empty_prompt_rejected(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request({"prompt": "   "}, base_settings())

    def test_ratio_and_seed_fixed(self):
        settings = base_settings()
        settings["base_resolution"] = 1536
        params = image_gen.resolve_request(
            {"prompt": "a cat", "ratio": "2:3", "seed": 7}, settings)
        self.assertEqual((params["width"], params["height"]), (1024, 1536))
        self.assertEqual(params["seed"], 7)

    def test_t2i_follows_settings_default_ratio(self):
        settings = base_settings()
        settings["default_ratio"] = "16:9"
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual((params["width"], params["height"]), (1280, 720))
        # skill 声明比例已废弃：请求里带上也不生效，比例只看生图设置
        # （四视图由后端固定 16:9，与该分支无关）
        params = image_gen.resolve_request(
            {"prompt": "a cat", "skill_ratio": "9:16"}, settings)
        self.assertEqual((params["width"], params["height"]), (1280, 720))

    def test_lora_warnings_for_missing(self):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "nope.safetensors", "strength": 1.0}]
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["loras"],
                         [{"name": "style_a.safetensors", "strength": 0.5, "ref_only": False}])
        self.assertTrue(params["warnings"])

    def test_ref_only_lora_skipped_in_text_to_image(self):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "sub/style_b.safetensors", "strength": 1.0, "ref_only": True}]
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        # 文生图：ref_only 的 LoRA 被跳过，仅保留无条件加载的 style_a
        self.assertEqual([l["name"] for l in params["loras"]], ["style_a.safetensors"])

    def test_ref_only_lora_kept_in_reference_mode(self):
        write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "sub/style_b.safetensors", "strength": 1.0, "ref_only": True}]
        params = image_gen.resolve_request(
            {"prompt": "a cat", "references": [{"kind": "input", "value": "ref.png"}]}, settings)
        # 参考图模式：带 ref_only 的 style_b 即视为四视图 LoRA，直接沿用、不再追加
        self.assertEqual([l["name"] for l in params["loras"]],
                         ["style_a.safetensors", "sub/style_b.safetensors"])

    def test_count_from_settings_and_body(self):
        settings = base_settings()
        settings["count"] = 3
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["count"], 3)
        params = image_gen.resolve_request({"prompt": "a cat", "count": 2}, settings)
        self.assertEqual(params["count"], 2)
        params = image_gen.resolve_request({"prompt": "a cat", "count": 99}, settings)
        self.assertEqual(params["count"], 8)

    def test_steps_priority(self):
        # 缺省 20（skill config.json 与请求都未给）
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        self.assertEqual(params["steps"], 20)
        # skill config.json 的默认值（经设置合并传入）
        settings = base_settings()
        settings["steps"] = 25
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["steps"], 25)
        # 本次请求（节点入参/接口 body）覆盖 skill 设置
        params = image_gen.resolve_request({"prompt": "a cat", "steps": 8}, settings)
        self.assertEqual(params["steps"], 8)

    def test_missing_model_folder_raises(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request({"prompt": "a cat"},
                                      {"model": "ghost.safetensors"})


class ReferenceTests(unittest.TestCase):
    def test_input_reference(self):
        write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
        params = image_gen.resolve_request(
            {"prompt": " redraw ", "references": [{"kind": "input", "value": "ref.png"}],
             "count": 3}, base_settings())
        self.assertEqual(params["ref_name"], "ref.png")
        # 尺寸跟随设置比例（默认 1:1）；采样参数写死在工作流模板里
        self.assertEqual((params["width"], params["height"]), (1280, 1280))
        self.assertEqual(params["prompt"], "redraw")
        # 参考图长边限到 1024：768×1024 → 768×1024
        self.assertEqual(params["ref_scale"], (768, 1024))
        # 四视图 LoRA 自动追加且位于用户 LoRA 之后
        self.assertEqual(params["loras"][-1]["name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")

    def test_quadview_lora_not_duplicated_when_user_configured(self):
        write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
        settings = base_settings()
        settings["loras"] = [{"name": "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors",
                              "strength": 0.9}]
        params = image_gen.resolve_request(
            {"prompt": "a cat", "references": [{"kind": "input", "value": "ref.png"}]},
            settings)
        self.assertEqual(len(params["loras"]), 1)
        self.assertAlmostEqual(params["loras"][0]["strength"], 0.9)

    def test_ref_only_lora_serves_as_quadview(self):
        write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
        settings = base_settings()
        # 带 ref_only 的 LoRA（文件名不含线索）即视为四视图 LoRA：沿用、不追加、不报错
        settings["loras"] = [{"name": "sub/style_b.safetensors", "strength": 0.8, "ref_only": True}]
        params = image_gen.resolve_request(
            {"prompt": "a cat", "references": [{"kind": "input", "value": "ref.png"}]}, settings)
        self.assertEqual([l["name"] for l in params["loras"]], ["sub/style_b.safetensors"])

    def test_missing_quadview_lora_raises(self):
        saved = _MODELS["loras"]
        try:
            _MODELS["loras"] = [f for f in saved if "quadview" not in f.lower()
                                and "四视图" not in f]
            write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
            with self.assertRaises(ValueError) as ctx:
                image_gen.resolve_request(
                    {"prompt": "a cat",
                     "references": [{"kind": "input", "value": "ref.png"}]},
                    base_settings())
            self.assertIn("四视图 LoRA", str(ctx.exception))
        finally:
            _MODELS["loras"] = saved

    def test_data_uri_reference_copied_to_input(self):
        raw = write_png(os.path.join(_TMP, "seed.png"), 32, 32)
        uri = "data:image/png;base64," + base64.b64encode(raw).decode()
        name = image_gen._reference_name({"kind": "data", "data": uri})
        digest = hashlib.sha1(raw).hexdigest()[:12]
        self.assertEqual(name, f"NeoAgent/ref_{digest}.png")
        self.assertTrue(os.path.isfile(os.path.join(_INPUT_DIR, name)))

    def test_unreadable_reference_raises(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request(
                {"prompt": "x", "references": [{"kind": "input", "value": "gone.png"}]},
                base_settings())


class RenderTemplateTests(unittest.TestCase):
    """workflow.json 模板渲染：占位符替换（类型化取值）+ LoRA 槽位填充 / 动态注入。"""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen", "workflow.json"),
                  encoding="utf-8") as f:
            cls.text_template = json.load(f)
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen_image", "workflow.json"),
                  encoding="utf-8") as f:
            cls.ref_template = json.load(f)

    def params(self, **overrides):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "sub/style_b.safetensors", "strength": 1.0}]
        return image_gen.resolve_request({"prompt": "a red fox", "seed": 3, **overrides},
                                         settings)

    def test_text_to_image_shape(self):
        graph, warns = image_gen.render_template(self.text_template, self.params(count=3))
        self.assertEqual(warns, [])
        latent = graph["9"]["inputs"]
        self.assertEqual(latent["batch_size"], 3)          # {{COUNT}} 取 int 类型值
        self.assertEqual((latent["width"], latent["height"]), (1280, 1280))
        self.assertEqual(graph["4"]["inputs"]["text"], "a red fox")
        self.assertEqual(graph["5"]["inputs"]["text"], "")
        self.assertEqual(graph["1"]["inputs"]["unet_name"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(graph["10"]["inputs"]["seed"], 3)
        self.assertTrue(str(graph["12"]["inputs"]["filename_prefix"]).startswith("NeoAgent/"))

    def test_lora_dynamic_insertion_after_unet(self):
        # 文生图模板没有 LoRA 槽位：两个用户 LoRA 在主链末端动态串联
        graph, _ = image_gen.render_template(self.text_template, self.params())
        self.assertEqual(graph["13"]["class_type"], "LoraLoaderModelOnly")
        self.assertEqual(graph["13"]["inputs"], {"model": ["1", 0], "lora_name": "style_a.safetensors",
                                                 "strength_model": 0.5})
        self.assertEqual(graph["14"]["inputs"]["model"], ["13", 0])
        self.assertEqual(graph["14"]["inputs"]["lora_name"], "sub/style_b.safetensors")
        self.assertEqual(graph["10"]["inputs"]["model"], ["14", 0])   # KSampler 吃链尾

    def test_reference_template_rendering(self):
        write_png(os.path.join(_INPUT_DIR, "ref3.png"), 768, 1024)
        params = self.params(references=[{"kind": "input", "value": "ref3.png"}])
        graph, _ = image_gen.render_template(self.ref_template, params)
        self.assertEqual(graph["6"]["inputs"]["image"], "ref3.png")
        scale = graph["7"]["inputs"]
        self.assertEqual((scale["width"], scale["height"]), (768, 1024))
        self.assertEqual(scale["crop"], "disabled")
        self.assertEqual(graph["4"]["inputs"]["prompt"], "a red fox")
        # 单槽位填第一个 LoRA；其余（含自动四视图）在槽位后动态串联到 model patch
        self.assertEqual(graph["20"]["inputs"]["lora_name"], "style_a.safetensors")
        self.assertAlmostEqual(graph["20"]["inputs"]["strength_model"], 0.5)
        self.assertEqual(graph["21"]["inputs"], {"model": ["20", 0], "lora_name": "sub/style_b.safetensors",
                                                 "strength_model": 1.0})
        self.assertEqual(graph["22"]["inputs"]["lora_name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertEqual(graph["14"]["inputs"]["model"], ["22", 0])   # model patch 吃链尾
        self.assertAlmostEqual(graph["10"]["inputs"]["denoise"], 1.0)  # 采样参数写死在模板

    def test_ref_template_requires_reference(self):
        with self.assertRaises(ValueError):
            image_gen.render_template(self.ref_template, self.params())

    def test_preset_template_steps_from_config(self):
        # 生图预设模板的 steps 是 {{STEPS}} 占位符：默认值取该技能 config.json（经设置合并），请求可覆盖
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen", "config.json"),
                  encoding="utf-8") as f:
            cfg = json.load(f)
        settings = dict(image_gen.DEFAULT_SETTINGS)
        for key, value in cfg.items():
            if key in image_gen._SKILL_SETTING_KEYS and value not in (None, "", []):
                settings[key] = value
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["steps"], 8)   # config.json 默认 steps=8
        graph, _ = image_gen.render_template(self.text_template, params)
        self.assertEqual(graph["10"]["inputs"]["steps"], 8)
        # 请求覆盖（节点 steps 入参 / 接口 body）
        params = image_gen.resolve_request({"prompt": "a cat", "steps": 30}, settings)
        graph, _ = image_gen.render_template(self.text_template, params)
        self.assertEqual(graph["10"]["inputs"]["steps"], 30)

    def test_lora_slot_fallback_and_missing_raises(self):
        template = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
            "2": {"class_type": "LoraLoaderModelOnly",
                  "inputs": {"model": ["1", 0], "lora_name": "{{LORA_1_NAME}}",
                             "strength_model": "{{LORA_1_STRENGTH}}"}},
        }
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        graph, _ = image_gen.render_template(template, params)
        # 空槽：loras 目录排序第一的文件兜底 + strength 0（可加载但无效）
        self.assertEqual(graph["2"]["inputs"]["lora_name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertEqual(graph["2"]["inputs"]["strength_model"], 0.0)

        orig = image_gen._folder_files
        try:
            image_gen._folder_files = lambda folder: [] if folder == "loras" else orig(folder)
            with self.assertRaises(ValueError):
                image_gen.render_template(template, params)
        finally:
            image_gen._folder_files = orig

    def test_reference_scale_follows_source_aspect(self):
        # 超宽参考图：长边限到 1024 → 1024×512
        write_png(os.path.join(_INPUT_DIR, "ref_wide.png"), 1600, 800)
        params = self.params(references=[{"kind": "input", "value": "ref_wide.png"}])
        self.assertEqual(params["ref_scale"], (1024, 512))


class TemplateRefSlotTests(unittest.TestCase):
    """模板探测：{{REF_IMAGE_n}} 槽位数（可保留的参考图张数）与 Krea2 编辑链识别（四视图 LoRA 开关）。"""

    def test_max_refs_counts_highest_slot(self):
        template = {
            "4": {"class_type": "TextEncodeQwenImage21",
                  "inputs": {"images.image_1": "{{REF_IMAGE_1}}", "images.image_4": "{{REF_IMAGE_4}}"}},
        }
        self.assertEqual(image_gen.template_max_refs(template), 4)

    def test_max_refs_defaults_to_one(self):
        # 单路单帧模板（Krea2/首帧技能）与纯文生图模板都按 1 张处理
        self.assertEqual(image_gen.template_max_refs(
            {"1": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE}}"}}}), 1)
        self.assertEqual(image_gen.template_max_refs({}), 1)

    def test_uses_krea2_edit(self):
        self.assertTrue(image_gen.template_uses_krea2_edit(
            {"2": {"class_type": "Krea2EditModelPatch", "inputs": {}}}))
        self.assertFalse(image_gen.template_uses_krea2_edit(
            {"2": {"class_type": "KSampler", "inputs": {}}}))
        self.assertFalse(image_gen.template_uses_krea2_edit({}))


class StartGenerationTemplateRouteTests(unittest.TestCase):
    """start_generation 按模板决定参考槽位数与四视图 LoRA 自动挑选（与 ImageGenEditNode 一致）。"""

    QWEN_TEMPLATE = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "{{TEXT_ENCODER}}"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "{{VAE}}"}},
        "4": {"class_type": "TextEncodeQwenImage21",
              "inputs": {"prompt": "{{PROMPT}}",
                         "images.image_1": ["10", 0], "images.image_2": ["12", 0]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": "{{WIDTH}}", "height": "{{HEIGHT}}"}},
        "6": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": "{{SEED}}", "steps": "{{STEPS}}",
                         "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0]}},
        "7": {"class_type": "VAEDecode",
              "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage",
              "inputs": {"images": ["7", 0], "filename_prefix": "{{PREFIX}}"}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_1}}"}},
        "12": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_2}}"}},
    }

    KREA2_TEMPLATE = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
        "2": {"class_type": "Krea2EditModelPatch",
              "inputs": {"model": ["1", 0], "image": "{{REF_IMAGE}}"}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
    }

    def _run(self, template, body, cfg=None):
        captured = {}
        orig = (image_gen.get_settings, image_gen.submit_graph, image_gen._watch,
                _skill_mod.load_skill_workflow, _skill_mod.get_skill_gen_config)

        async def no_watch(task_id):
            return None

        async def fake_submit(graph):
            captured["graph"] = graph
            return "prompt-1"

        try:
            image_gen.get_settings = lambda: dict(base_settings(), **{k: v for k, v in (cfg or {}).items()
                                                                      if k in image_gen._SKILL_SETTING_KEYS})
            image_gen.submit_graph = fake_submit
            image_gen._watch = no_watch
            _skill_mod.load_skill_workflow = lambda sid: template
            _skill_mod.get_skill_gen_config = lambda sid: (cfg or {})
            write_png(os.path.join(_INPUT_DIR, "portrait.png"), 768, 1024)
            snap = asyncio.run(image_gen.start_generation(body))
        finally:
            (image_gen.get_settings, image_gen.submit_graph, image_gen._watch,
             _skill_mod.load_skill_workflow, _skill_mod.get_skill_gen_config) = orig
        return snap, captured

    def test_multi_ref_template_skips_quadview_lora(self):
        # Qwen Image 2.1 多路槽位模板：参考槽正常填充，不自动挑 Krea2 四视图 LoRA
        snap, captured = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "角色设定图",
             "references": [{"kind": "input", "value": "portrait.png"}]})
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        self.assertEqual(graph["10"]["inputs"]["image"], "portrait.png")
        self.assertNotIn("12", graph)  # 第二槽无参考 → LoadImage 与连线一并裁掉
        self.assertNotIn("images.image_2", graph["4"]["inputs"])
        loras = [n for n in graph.values() if isinstance(n, dict)
                 and n.get("class_type") == "LoraLoaderModelOnly"]
        self.assertEqual(loras, [])

    def test_krea2_template_keeps_quadview_lora(self):
        # Krea2 单路编辑模板：保留四视图 LoRA 自动挑选（动态注入 LoraLoaderModelOnly）
        snap, captured = self._run(
            self.KREA2_TEMPLATE,
            {"skill_id": "image_gen_image", "prompt": "角色设定图",
             "references": [{"kind": "input", "value": "portrait.png"}]})
        graph = captured["graph"]
        loras = [n for n in graph.values() if isinstance(n, dict)
                 and n.get("class_type") == "LoraLoaderModelOnly"]
        self.assertEqual(len(loras), 1)
        self.assertEqual(loras[0]["inputs"]["lora_name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")

    def test_real_qwen_preset_renders_with_required_inputs(self):
        # 真实预设模板必须带 TextEncodeQwenImage21 的必填 resolution 输入，
        # 否则 ComfyUI prompt 校验整图拒绝（"Required input is missing: resolution"）
        preset_dir = os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21")
        with open(os.path.join(preset_dir, "workflow.json"), encoding="utf-8") as f:
            template = json.load(f)
        with open(os.path.join(preset_dir, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        orig_models = {k: list(v) for k, v in _MODELS.items()}
        _MODELS["diffusion_models"].append(cfg["model"])
        _MODELS["text_encoders"].append(cfg["text_encoder"])
        _MODELS["vae"].append(cfg["vae"])
        try:
            snap, captured = self._run(
                template,
                {"skill_id": "qwen_image_21", "prompt": "角色设定图",
                 "width": 1920, "height": 1080,
                 "references": [{"kind": "input", "value": "portrait.png"}]},
                cfg=cfg)
        finally:
            _MODELS.clear()
            _MODELS.update(orig_models)
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        self.assertEqual(graph["4"]["inputs"]["resolution"], 1024)
        # 显式 1920×1080 按全局规则对齐到 16 → 1920×1088
        self.assertEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (1920, 1088))
        loads = [v for v in graph.values() if v.get("class_type") == "LoadImage"]
        self.assertEqual(len(loads), 1)  # 其余 9 个空槽连同 LoadImage 裁掉

    def test_outpaint_rewires_qwen_template(self):
        snap, captured = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "extend the sky",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 128, "top": 64, "right": 128, "bottom": 64}})
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        pad_id = next(nid for nid, n in graph.items()
                      if isinstance(n, dict) and n.get("class_type") == "ImagePadForOutpaint")
        pad = graph[pad_id]["inputs"]
        self.assertEqual(pad["image"], ["10", 0])
        self.assertEqual((pad["left"], pad["top"], pad["right"], pad["bottom"]), (128, 64, 128, 64))
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [pad_id, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertNotIn("5", graph)   # EmptyLatentImage 移除

    def test_outpaint_total_pixels_inserts_scale(self):
        snap, captured = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "extend the sky",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 128, "top": 64, "right": 128, "bottom": 64, "total_pixels": 2.0}})
        graph = captured["graph"]
        scale_id = next(nid for nid, n in graph.items()
                        if isinstance(n, dict) and n.get("class_type") == "ImageScaleToTotalPixels")
        pad_id = next(nid for nid, n in graph.items()
                      if isinstance(n, dict) and n.get("class_type") == "ImagePadForOutpaint")
        self.assertEqual(graph[scale_id]["inputs"]["image"], [pad_id, 0])
        self.assertAlmostEqual(graph[scale_id]["inputs"]["megapixels"], 2.0)
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [scale_id, 0])

    def test_outpaint_unsupported_template_raises(self):
        with self.assertRaises(ValueError):
            self._run(
                self.KREA2_TEMPLATE,
                {"skill_id": "image_gen_image", "prompt": "extend",
                 "references": [{"kind": "input", "value": "portrait.png"}],
                 "outpaint": {"left": 64}})

    def test_outpaint_empty_prompt_uses_default_trigger(self):
        snap, _ = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 64}})
        self.assertEqual(snap["prompt"], image_gen.OUTPAINT_DEFAULT_PROMPT)

    def test_local_edit_prompt_appends_red_constraint(self):
        from PIL import Image
        buf = os.path.join(_INPUT_DIR, "_loc_mask_small.png")
        with Image.new("L", (16, 16), 255) as img:
            img.save(buf, format="PNG")
        with open(buf, "rb") as f:
            data_url = "data:image/png;base64," + base64.b64encode(f.read()).decode()
        snap, _ = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "fix the scratch",
             "local_edit": True,
             "references": [{"kind": "input", "value": "portrait.png"},
                            {"kind": "data", "data": data_url}]})
        self.assertTrue(snap["prompt"].endswith(image_gen.LOCAL_EDIT_PROMPT_SUFFIX))

    def test_local_edit_unsupported_template_raises(self):
        with self.assertRaises(ValueError):
            self._run(
                self.KREA2_TEMPLATE,
                {"skill_id": "image_gen_image", "prompt": "fix",
                 "local_edit": True,
                 "references": [{"kind": "input", "value": "portrait.png"}]})


class OutpaintParseTests(unittest.TestCase):
    """扩图参数解析：四边留白钳制、目标像素（MP）范围、非法值报错。"""

    def test_missing_returns_none(self):
        self.assertIsNone(image_gen._parse_outpaint(None))
        self.assertIsNone(image_gen._parse_outpaint("bad"))

    def test_all_zero_returns_none(self):
        self.assertIsNone(image_gen._parse_outpaint({"left": 0, "top": 0, "right": 0, "bottom": 0}))

    def test_clamped_and_typed(self):
        out = image_gen._parse_outpaint({"left": -5, "top": "64", "right": 99999, "bottom": 128,
                                        "total_pixels": 2.5})
        self.assertEqual(out["left"], 0)
        self.assertEqual(out["top"], 64)
        self.assertEqual(out["right"], 8192)
        self.assertEqual(out["bottom"], 128)
        self.assertAlmostEqual(out["total_pixels"], 2.5)

    def test_total_pixels_clamped(self):
        out = image_gen._parse_outpaint({"left": 16, "total_pixels": 99})
        self.assertAlmostEqual(out["total_pixels"], 16.0)
        out = image_gen._parse_outpaint({"left": 16, "total_pixels": -3})
        self.assertAlmostEqual(out["total_pixels"], 0.0)

    def test_bad_value_raises(self):
        with self.assertRaises(ValueError):
            image_gen._parse_outpaint({"left": "abc"})

    def test_canvas_aligned_to_16(self):
        # 原图 1000×750：画布 1032×782 → right/bottom 补到 16 的倍数（1040×784）
        write_png(os.path.join(_INPUT_DIR, "outp_align.png"), 1000, 750)
        params = image_gen.resolve_request(
            {"prompt": "a cat", "references": [{"kind": "input", "value": "outp_align.png"}],
             "outpaint": {"left": 16, "top": 16, "right": 16, "bottom": 16}}, base_settings())
        self.assertEqual(params["outpaint"]["right"], 24)
        self.assertEqual(params["outpaint"]["bottom"], 18)

    def test_template_supports_outpaint(self):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            qwen = json.load(f)
        self.assertTrue(image_gen.template_supports_outpaint(qwen))
        self.assertFalse(image_gen.template_supports_outpaint({
            "1": {"class_type": "UNETLoader", "inputs": {}}}))


class OutpaintRenderTests(unittest.TestCase):
    """扩图图变换：pad/scale 插入、latent 改接编码器空 latent 输出、EmptyLatentImage 移除。"""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            cls.template = json.load(f)

    def params(self, **overrides):
        write_png(os.path.join(_INPUT_DIR, "outp_ref.png"), 768, 1024)
        return image_gen.resolve_request(
            {"prompt": "a red fox", "seed": 3,
             "references": [{"kind": "input", "value": "outp_ref.png"}], **overrides},
            base_settings())

    def _find(self, graph, class_type):
        ids = [nid for nid, n in graph.items()
               if isinstance(n, dict) and n.get("class_type") == class_type]
        assert len(ids) == 1, f"{class_type} 应恰好 1 个，实际 {ids}"
        return ids[0]

    def test_pad_inserted_and_latent_rewired(self):
        params = self.params(outpaint={"left": 128, "top": 64, "right": 128, "bottom": 64})
        graph, _ = image_gen.render_template(self.template, params)
        pad_id = self._find(graph, "ImagePadForOutpaint")
        pad = graph[pad_id]["inputs"]
        self.assertEqual(pad["image"], ["10", 0])
        self.assertEqual((pad["left"], pad["top"], pad["right"], pad["bottom"]), (128, 64, 128, 64))
        self.assertEqual(pad["feathering"], 40)
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [pad_id, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertNotIn("5", graph)   # EmptyLatentImage 不再被引用，移除

    def test_scale_inserted_when_total_pixels(self):
        params = self.params(outpaint={"left": 128, "top": 64, "right": 128, "bottom": 64,
                                       "total_pixels": 2.0})
        graph, _ = image_gen.render_template(self.template, params)
        scale_id = self._find(graph, "ImageScaleToTotalPixels")
        pad_id = self._find(graph, "ImagePadForOutpaint")
        self.assertEqual(graph[scale_id]["inputs"]["image"], [pad_id, 0])
        self.assertAlmostEqual(graph[scale_id]["inputs"]["megapixels"], 2.0)
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [scale_id, 0])

    def test_outpaint_requires_reference(self):
        params = image_gen.resolve_request({"prompt": "a red fox", "seed": 3,
                                            "outpaint": {"left": 64}}, base_settings())
        with self.assertRaises(ValueError):
            image_gen.render_template(self.template, params)

    def test_no_outpaint_keeps_template_unchanged(self):
        params = self.params()
        graph, _ = image_gen.render_template(self.template, params)
        self.assertNotIn("ImagePadForOutpaint",
                         {n.get("class_type") for n in graph.values() if isinstance(n, dict)})
        self.assertEqual(graph["4"]["inputs"]["resolution"], 1024)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 0])


class LocalEditTests(unittest.TestCase):
    """高分局部编辑：遮罩自动定位区域、红色高亮/羽化遮罩落盘、图变换。"""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            cls.template = json.load(f)

    def _make(self, mask_rect=None):
        from PIL import Image, ImageDraw
        orig_path = os.path.join(_INPUT_DIR, "loc_ref.png")
        with Image.new("RGB", (200, 300), (10, 120, 200)) as img:
            img.save(orig_path, format="PNG")
        mask = Image.new("L", (200, 300), 0)
        if mask_rect:
            ImageDraw.Draw(mask).rectangle(mask_rect, fill=255)
        mask_path = os.path.join(_INPUT_DIR, "_loc_mask_tmp.png")
        mask.save(mask_path, format="PNG")
        with open(mask_path, "rb") as f:
            return "data:image/png;base64," + base64.b64encode(f.read()).decode()

    def test_prepare_box_padding_alignment_and_files(self):
        data_url = self._make((50, 80, 120, 200))
        local = image_gen._prepare_local_edit("loc_ref.png", {"kind": "data", "data": data_url})
        # 包围盒(50,80,120,200) + padding：框包住涂抹区、对齐 8、不越界
        self.assertLessEqual(local["x"], 50)
        self.assertLessEqual(local["y"], 80)
        self.assertGreaterEqual(local["x"] + local["w"], 120)
        self.assertGreaterEqual(local["y"] + local["h"], 200)
        for key in ("x", "y", "w", "h"):
            self.assertEqual(local[key] % 8, 0)
        # 编辑区放大到约 1MP（原涂抹区仅 ~70×120）
        self.assertGreater(local["w2"] * local["h2"], 4e5)
        self.assertLess(local["w2"] * local["h2"], 2.5e6)
        from PIL import Image
        hl = Image.open(os.path.join(_INPUT_DIR, local["hl_name"]))
        fm = Image.open(os.path.join(_INPUT_DIR, local["mask_name"]))
        cx, cy = 85 - local["x"], 140 - local["y"]
        self.assertEqual(hl.getpixel((cx, cy)), (255, 0, 0))   # 涂抹区标红
        self.assertEqual(fm.size, (local["w"], local["h"]))
        self.assertEqual(fm.getpixel((cx, cy)), 255)           # 羽化遮罩内部保持实色

    def test_prepare_empty_mask_raises(self):
        data_url = self._make(None)
        with self.assertRaises(ValueError):
            image_gen._prepare_local_edit("loc_ref.png", {"kind": "data", "data": data_url})

    def test_resolve_extracts_mask_from_refs(self):
        data_url = self._make((50, 80, 120, 200))
        params = image_gen.resolve_request(
            {"prompt": "fix the scratch", "seed": 3, "local_edit": True,
             "references": [{"kind": "input", "value": "loc_ref.png"},
                            {"kind": "data", "data": data_url}]},
            base_settings())
        self.assertIsNotNone(params["local_edit"])
        self.assertEqual(params["ref_images"], ["loc_ref.png"])   # 遮罩不进模型参考槽

    def test_local_edit_requires_mask(self):
        write_png(os.path.join(_INPUT_DIR, "loc_ref.png"), 200, 300)
        with self.assertRaises(ValueError):
            image_gen.resolve_request(
                {"prompt": "fix", "seed": 3, "local_edit": True,
                 "references": [{"kind": "input", "value": "loc_ref.png"}]},
                base_settings())

    def test_graph_transform(self):
        data_url = self._make((50, 80, 120, 200))
        params = image_gen.resolve_request(
            {"prompt": "fix the scratch", "seed": 3, "local_edit": True,
             "references": [{"kind": "input", "value": "loc_ref.png"},
                            {"kind": "data", "data": data_url}]},
            base_settings())
        local = params["local_edit"]
        graph, _ = image_gen.render_template(self.template, params)

        def find(ct):
            ids = [nid for nid, n in graph.items()
                   if isinstance(n, dict) and n.get("class_type") == ct]
            assert len(ids) == 1, f"{ct} 应恰好 1 个，实际 {ids}"
            return ids[0]

        hl_id = next(nid for nid, n in graph.items()
                    if isinstance(n, dict) and n.get("class_type") == "LoadImage"
                    and (n.get("inputs") or {}).get("image") == local["hl_name"])
        mask_id = find("LoadImageMask")
        scales = [nid for nid, n in graph.items()
                  if isinstance(n, dict) and n.get("class_type") == "ImageScale"]
        up_id = next(nid for nid in scales if graph[nid]["inputs"]["width"] == local["w2"])
        down_id = next(nid for nid in scales if graph[nid]["inputs"]["width"] == local["w"])
        comp_id = find("ImageCompositeMasked")
        self.assertEqual(graph[up_id]["inputs"]["image"], [hl_id, 0])
        self.assertEqual((graph[up_id]["inputs"]["width"], graph[up_id]["inputs"]["height"]),
                         (local["w2"], local["h2"]))
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [up_id, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertEqual(graph[down_id]["inputs"]["image"], ["7", 0])
        comp = graph[comp_id]["inputs"]
        self.assertEqual(comp["destination"], ["10", 0])
        self.assertEqual(comp["source"], [down_id, 0])
        self.assertEqual((comp["x"], comp["y"]), (local["x"], local["y"]))
        self.assertEqual(comp["mask"], [mask_id, 0])
        self.assertEqual(graph[find("SaveImage")]["inputs"]["images"], [comp_id, 0])
        self.assertNotIn("5", graph)   # EmptyLatentImage 不再被引用，移除


class Krea2EditHelperTests(unittest.TestCase):
    """vendor 的 krea2_edit.py 纯函数单测（CPU 可跑，不加载模型）。"""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        root = os.path.dirname(os.path.dirname(PLUGIN_DIR))  # ComfyUI 根目录
        if root not in sys.path:
            sys.path.insert(0, root)
        spec = importlib.util.spec_from_file_location(
            "krea2_edit_vendored", os.path.join(PLUGIN_DIR, "krea2_edit.py"))
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)

    def test_imgids_offset_centers_reference(self):
        ids = self.mod._imgids_offset(1, 1, 4, 6, 8, 10, "cpu")
        self.assertEqual(tuple(ids.shape), (1, 24, 3))
        self.assertTrue((ids[..., 0] == 1).all())          # frame=1
        self.assertAlmostEqual(float(ids[0, 0, 1]), 2.0)   # off_h = (8-4)/2
        self.assertAlmostEqual(float(ids[0, 0, 2]), 2.0)   # off_w = (10-6)/2
        self.assertAlmostEqual(float(ids[0, 5, 2]), 7.0)   # 第 5 列: 2 + 5

    def test_imgids_offset_no_negative_when_ref_larger(self):
        ids = self.mod._imgids_offset(1, 1, 8, 8, 4, 4, "cpu")
        self.assertTrue((ids[..., 1] >= 0).all())
        self.assertTrue((ids[..., 2] >= 0).all())

    def test_fit_src_passthrough_on_match(self):
        import torch
        src = torch.zeros(1, 4, 8, 8)
        self.assertIs(self.mod._fit_src(src, 8, 8), src)

    def test_fit_src_crops_to_target_ar_then_resizes(self):
        import torch
        src = torch.zeros(1, 4, 6, 4)   # portrait latent -> landscape target
        out = self.mod._fit_src(src, 4, 8)
        self.assertEqual(tuple(out.shape), (1, 4, 4, 8))

    def test_to_4d_flattens_temporal(self):
        import torch
        v = torch.zeros(2, 3, 2, 5, 6)
        out = self.mod._to_4d(v)
        self.assertEqual(tuple(out.shape), (4, 3, 5, 6))


class SidecarTests(unittest.TestCase):
    def test_sidecar_written_once(self):
        params = image_gen.resolve_request({"prompt": "a cat", "seed": 5}, base_settings())
        image_path = os.path.join(_OUTPUT_DIR, "NeoAgent", "pic_00001_.png")
        os.makedirs(os.path.dirname(image_path), exist_ok=True)
        with open(image_path, "wb") as f:
            f.write(b"img")
        image_gen.write_sidecar(image_path, params)
        txt = os.path.splitext(image_path)[0] + ".txt"
        with open(txt, encoding="utf-8") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], "a cat")
        self.assertIn("seed=5", lines[1])
        # 已存在时不覆盖（画廊里用户可能改过）
        with open(txt, "w", encoding="utf-8") as f:
            f.write("kept\n")
        image_gen.write_sidecar(image_path, params)
        with open(txt, encoding="utf-8") as f:
            self.assertEqual(f.read(), "kept\n")


class SkillWorkflowRouteTests(unittest.TestCase):
    """画布导出 / 技能生图设置 / 文件复制路由（假 request + 真实 skill 模块）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = _skill_mod.SKILL_CUSTOM_DIR
        _skill_mod.SKILL_CUSTOM_DIR = self._tmp.name
        # 预设本地覆盖文件隔离到临时目录，避免污染真实 configs/skill_overrides/
        self._orig_ovr = _skill_mod.SKILL_OVERRIDES_DIR
        _skill_mod.SKILL_OVERRIDES_DIR = os.path.join(self._tmp.name, "skill_overrides")
        # 临时预设（含已知 config.json）替代真实 presets 目录，断言不依赖本机预设内容
        self._orig_presets = _skill_mod.SKILL_PRESETS_DIR
        pdir = os.path.join(self._tmp.name, "presets", "image_gen")
        os.makedirs(pdir)
        with open(os.path.join(pdir, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: image_gen\n---\nbody")
        with open(os.path.join(pdir, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"default_ratio": "16:9"}, f)
        with open(os.path.join(pdir, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump({"1": {"class_type": "UNETLoader", "inputs": {}}}, f)
        _skill_mod.SKILL_PRESETS_DIR = os.path.join(self._tmp.name, "presets")

    def tearDown(self):
        _skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        _skill_mod.SKILL_OVERRIDES_DIR = self._orig_ovr
        _skill_mod.SKILL_PRESETS_DIR = self._orig_presets
        self._tmp.cleanup()

    @staticmethod
    def _req(payload=None, query=None):
        async def _json():
            return payload
        return types.SimpleNamespace(json=_json, query=query or {})

    @staticmethod
    def _call(handler, request):
        resp = asyncio.run(handler(request))
        body = json.loads(resp.body)
        return resp.status, body

    def _make_custom_skill(self, sid):
        d = os.path.join(self._tmp.name, sid)
        os.makedirs(d)
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: %s\n---\nbody" % sid)
        return d

    def test_save_workflow_skill_route(self):
        workflow = {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "krea2/krea2_turbo_fp16.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "hello world"}},
            "3": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 1280, "height": 720, "batch_size": 2}},
            "4": {"class_type": "SaveImage",
                  "inputs": {"images": ["3", 0], "filename_prefix": "MyWf"}},
        }
        status, body = self._call(
            image_gen.save_workflow_skill_route,
            self._req({"name": "my wf", "description": "d", "tags": ["t"], "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["gen_image"], True)
        self.assertEqual(meta["category"], "image_gen")
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["2"]["inputs"]["text"], "{{PROMPT}}")
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["3"]["inputs"]["width"], "{{WIDTH}}")
        self.assertEqual(tpl["4"]["inputs"]["filename_prefix"], "{{PREFIX}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(cfg["default_ratio"], "16:9")
        self.assertEqual(cfg["output_prefix"], "MyWf")

        # 同名重复导出自动加后缀
        status, body2 = self._call(
            image_gen.save_workflow_skill_route,
            self._req({"name": "my wf", "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertEqual(body2["id"], body["id"] + "-2")

    def test_get_skill_workflow_route(self):
        # 预设带 workflow.json → 200 + 原样返回模板
        status, body = self._call(
            image_gen.get_skill_workflow_route,
            self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body["skill_id"], "image_gen")
        self.assertEqual(body["workflow"], {"1": {"class_type": "UNETLoader", "inputs": {}}})

        # 缺 skill_id → 400
        status, _ = self._call(image_gen.get_skill_workflow_route, self._req(query={}))
        self.assertEqual(status, 400)

        # 自定义技能无 workflow.json → 404
        self._make_custom_skill("no_wf")
        status, _ = self._call(
            image_gen.get_skill_workflow_route,
            self._req(query={"skill_id": "no_wf"}))
        self.assertEqual(status, 404)

        # workflow.json 损坏 → 404（不抛异常）
        d = self._make_custom_skill("bad_wf")
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            f.write("{not json")
        status, _ = self._call(
            image_gen.get_skill_workflow_route,
            self._req(query={"skill_id": "bad_wf"}))
        self.assertEqual(status, 404)

    def _h3_video_workflow(self, i2v=False):
        wf = {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "MiniMaxH3/minimax_h3.safetensors"}},
            "2": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen3vl_minimax_h3.safetensors", "type": "minimax"}},
            "3": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
            "4": {"class_type": "MiniMaxH3ImageToVideo",
                  "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": "a cat",
                             "width": 1344, "height": 768, "length": 124}},
            "5": {"class_type": "MiniMaxH3SigmaShift",
                  "inputs": {"model": ["1", 0], "shift_video": 12.0, "shift_audio": 3.0}},
            "6": {"class_type": "KSampler",
                  "inputs": {"model": ["5", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                             "sampler_name": "euler", "scheduler": "simple",
                             "positive": ["4", 0], "negative": ["4", 0],
                             "latent_image": ["4", 1], "denoise": 1.0}},
            "7": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["6", 0]}},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
            "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 1], "vae": ["11", 0]}},
            "10": {"class_type": "CreateVideo", "inputs": {"images": ["8", 0], "fps": 24, "audio": ["9", 0]}},
            "11": {"class_type": "VAELoader",
                   "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        }
        if i2v:
            wf["4"]["inputs"]["first_frame"] = ["12", 0]
            wf["12"] = {"class_type": "LoadImage", "inputs": {"image": "first.png"}}
            # 主链 LoRA：UNETLoader → LoraLoaderModelOnly → MiniMaxH3SigmaShift
            wf["5"]["inputs"]["model"] = ["13", 0]
            wf["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "h3_style.safetensors", "strength_model": 0.8}}
        return wf

    def test_save_workflow_skill_video_t2v(self):
        status, body = self._call(
            image_gen.save_workflow_skill_route,
            self._req({"name": "h3 t2v", "workflow": self._h3_video_workflow(i2v=False)}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["gen_video"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["gen_video"], True)
        self.assertEqual(meta["category"], "video_gen")
        self.assertNotIn("requires_ref", meta)
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["2"]["inputs"]["clip_name"], "{{TEXT_ENCODER}}")
        self.assertEqual(tpl["3"]["inputs"]["vae_name"], "{{VAE}}")          # 视频 VAE（喂 VAEDecode）
        self.assertEqual(tpl["11"]["inputs"]["vae_name"], "{{AUDIO_VAE}}")   # 音频 VAE（喂 VAEDecodeAudio）
        self.assertEqual(tpl["4"]["inputs"]["prompt"], "{{PROMPT}}")
        self.assertEqual(tpl["4"]["inputs"]["width"], "{{WIDTH}}")
        self.assertEqual(tpl["4"]["inputs"]["height"], "{{HEIGHT}}")
        self.assertEqual(tpl["4"]["inputs"]["length"], "{{LENGTH}}")
        self.assertEqual(tpl["6"]["inputs"]["seed"], "{{SEED}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "MiniMaxH3/minimax_h3.safetensors")
        self.assertEqual(cfg["text_encoder"], "qwen3vl_minimax_h3.safetensors")
        self.assertEqual(cfg["vae"], "minimax_h3_video_vae_fp16.safetensors")
        self.assertEqual(cfg["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (1344, 768, 124))

    def test_save_workflow_skill_video_i2v_with_lora(self):
        status, body = self._call(
            image_gen.save_workflow_skill_route,
            self._req({"name": "h3 i2v", "workflow": self._h3_video_workflow(i2v=True)}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["gen_video"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["requires_ref"], True)
        self.assertIn("image", meta.get("inputs") or [])
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["12"]["inputs"]["image"], "{{REF_IMAGE}}")
        self.assertEqual(tpl["4"]["inputs"]["first_frame"], ["12", 0])       # 首帧连线保留
        self.assertEqual(tpl["13"]["inputs"]["lora_name"], "{{LORA_1_NAME}}")
        self.assertEqual(tpl["13"]["inputs"]["strength_model"], "{{LORA_1_STRENGTH}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["loras"], [{"name": "h3_style.safetensors", "strength": 0.8}])

    def test_save_workflow_skill_invalid(self):
        status, _ = self._call(image_gen.save_workflow_skill_route,
                               self._req({"name": "x", "workflow": {}}))
        self.assertEqual(status, 400)

    def test_get_skill_config(self):
        # 预设 image_gen 的 config.json（default_ratio: 16:9）
        status, body = self._call(image_gen.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body, {"default_ratio": "16:9"})
        status, _ = self._call(image_gen.get_skill_config_route, self._req(query={}))
        self.assertEqual(status, 400)

    def test_post_skill_config(self):
        d = self._make_custom_skill("mygen")
        status, body = self._call(
            image_gen.post_skill_config_route,
            self._req({"skill_id": "mygen",
                       "config": {"count": 4, "default_ratio": "2:3",
                                  "loras": [{"name": "style_a.safetensors", "strength": 0.7}]}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["count"], 4)
        self.assertEqual(cfg["default_ratio"], "2:3")
        self.assertEqual(cfg["loras"], [{"name": "style_a.safetensors", "strength": 0.7,
                                         "ref_only": False}])

        # 预设设置可编辑：写本地覆盖文件（configs/skill_overrides/<id>.json），不改预设文件
        status, body = self._call(image_gen.post_skill_config_route,
                                  self._req({"skill_id": "image_gen", "config": {"count": 2}}))
        self.assertEqual(status, 200)
        ov_path = os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json")
        self.assertTrue(os.path.isfile(ov_path), "预设保存应写本地覆盖文件")
        with open(ov_path, encoding="utf-8") as f:
            ov = json.load(f)
        self.assertEqual(ov["count"], 2)
        # GET 返回合并后的有效 config（预设 default_ratio + 覆盖 count）
        status, body = self._call(image_gen.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["default_ratio"], "16:9")

    def test_reset_skill_config(self):
        # 先写一条本地覆盖，再恢复默认（删覆盖文件）；幂等、未知 skill 404
        status, _ = self._call(image_gen.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"count": 3}}))
        self.assertEqual(status, 200)
        ov_path = os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json")
        self.assertTrue(os.path.isfile(ov_path))

        status, body = self._call(_skill_mod.rs_prompts_reset_skill_config,
                                  self._req({"id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertFalse(os.path.isfile(ov_path), "恢复默认应删除本地覆盖文件")
        # 恢复后 GET 回落预设默认
        status, body = self._call(image_gen.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertNotIn("count", body)

        status, _ = self._call(_skill_mod.rs_prompts_reset_skill_config,
                               self._req({"id": "image_gen"}))
        self.assertEqual(status, 200, "无覆盖时恢复默认应幂等成功")
        # 未知 skill → 404（纯文本响应，不走 _call 的 JSON 解析）
        resp = asyncio.run(_skill_mod.rs_prompts_reset_skill_config(self._req({"id": "no_such_skill"})))
        self.assertEqual(resp.status, 404)

    def test_copy_skill_files_preset_with_override(self):
        # 复制带本地覆盖的预设 → 副本写入合并后的有效 config
        status, _ = self._call(image_gen.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"count": 5}}))
        self.assertEqual(status, 200)
        d = self._make_custom_skill("copy_ovr")
        status, body = self._call(
            image_gen.copy_skill_files_route,
            self._req({"from_id": "image_gen", "to_id": "copy_ovr"}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["count"], 5)
        self.assertEqual(cfg["default_ratio"], "16:9")

    def test_post_skill_config_persists_video_audio_vae(self):
        # 视频技能 per-skill 覆盖：model/text_encoder/vae/audio_vae 落盘，且保留既有 width/height/length（尺寸/时长默认）
        d = self._make_custom_skill("vidgen")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"width": 1344, "height": 768, "length": 247}, f)
        status, body = self._call(
            image_gen.post_skill_config_route,
            self._req({"skill_id": "vidgen",
                       "config": {"model": "h3/h3.safetensors",
                                  "text_encoder": "h3/te.safetensors",
                                  "vae": "h3/video_vae.safetensors",
                                  "audio_vae": "h3/audio_vae.safetensors"}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "h3/h3.safetensors")
        self.assertEqual(cfg["text_encoder"], "h3/te.safetensors")
        self.assertEqual(cfg["vae"], "h3/video_vae.safetensors")
        self.assertEqual(cfg["audio_vae"], "h3/audio_vae.safetensors")
        # 尺寸/时长默认值不被模型设置覆盖清掉
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (1344, 768, 247))

    def test_post_skill_config_persists_video_steps(self):
        # 视频技能 per-skill「步数」：保存白名单此前丢弃 steps，输入框改完保存无效
        d = self._make_custom_skill("vidsteps")
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: vidsteps\ncategory: video_gen\ngen_video: true\n---\nbody\n")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"width": 960, "height": 544, "length": 124, "steps": 20}, f)
        status, _ = self._call(
            image_gen.post_skill_config_route,
            self._req({"skill_id": "vidsteps",
                       "config": {"model": "h3/h3.safetensors", "steps": 8}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["steps"], 8)
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (960, 544, 124))
        # GET 回显已存步数（详情弹窗 load 据此回填「步数」输入框）
        status, body = self._call(image_gen.get_skill_config_route,
                                  self._req(query={"skill_id": "vidsteps"}))
        self.assertEqual(body["steps"], 8)
        # 技能列表摘要（浮动预览卡数据源）同样带上步数
        scanned = {s["id"]: s for s in _skill_mod.scan_skills()}
        self.assertEqual(scanned["vidsteps"]["gen_config"]["steps"], 8)
        # 不传 steps（如生图设置区保存）时保留既有值
        status, _ = self._call(image_gen.post_skill_config_route,
                               self._req({"skill_id": "vidsteps", "config": {"count": 2}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["steps"], 8, "未传 steps 时保留既有步数")
        # 预设技能同样落盘（写本地覆盖文件，不改预设 config.json）
        status, _ = self._call(image_gen.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"steps": 12}}))
        self.assertEqual(status, 200)
        with open(os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json"), encoding="utf-8") as f:
            ov = json.load(f)
        self.assertEqual(ov["steps"], 12)

    def test_copy_skill_files(self):
        d = self._make_custom_skill("copy_dst")
        status, body = self._call(
            image_gen.copy_skill_files_route,
            self._req({"from_id": "image_gen", "to_id": "copy_dst"}))
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(os.path.join(d, "workflow.json")))
        self.assertTrue(os.path.isfile(os.path.join(d, "config.json")))

        status, _ = self._call(
            image_gen.copy_skill_files_route,
            self._req({"from_id": "no_such_skill", "to_id": "copy_dst"}))
        self.assertEqual(status, 400)


class ProgressTests(unittest.TestCase):
    """采样进度读取：仅当全局 registry 属于本 prompt 且存在步数节点时返回 value/max。"""

    def _with_registry(self, reg):
        orig = image_gen.get_progress_state
        image_gen.get_progress_state = lambda: reg
        self.addCleanup(setattr, image_gen, "get_progress_state", orig)

    def test_matching_prompt_returns_sampling_node(self):
        reg = types.SimpleNamespace(prompt_id="p1", nodes={
            "3": {"state": "running", "value": 3.0, "max": 8.0},   # KSampler
            "7": {"state": "finished", "value": 1.0, "max": 1.0},  # 无步数节点
        })
        self._with_registry(reg)
        self.assertEqual(image_gen._progress_for("p1"), {"value": 3, "max": 8})

    def test_other_prompt_returns_none(self):
        reg = types.SimpleNamespace(prompt_id="other", nodes={
            "3": {"state": "running", "value": 2.0, "max": 8.0},
        })
        self._with_registry(reg)
        self.assertIsNone(image_gen._progress_for("p1"))

    def test_no_step_node_returns_none(self):
        reg = types.SimpleNamespace(prompt_id="p1", nodes={
            "7": {"state": "running", "value": 0.0, "max": 1.0},
        })
        self._with_registry(reg)
        self.assertIsNone(image_gen._progress_for("p1"))

    def test_snapshot_carries_progress_and_finish_clears(self):
        task = {
            "task_id": "t", "prompt_id": "p1", "status": "running",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": {"value": 2, "max": 8}, "error": "", "warnings": [],
        }
        self.assertEqual(image_gen._snapshot(task)["progress"], {"value": 2, "max": 8})
        image_gen._finish(task, "succeeded", [], "")
        self.assertIsNone(task["progress"])


class WatchPushTests(unittest.TestCase):
    """_watch 按变化推送 rs.image_gen.status：状态/进度变化才推，重复快照不推，终态必推。"""

    def setUp(self):
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        self._orig_prog = image_gen._progress_for
        self._orig_send = image_gen.PromptServer.instance.send_sync
        image_gen.POLL_INTERVAL = 0.001
        self.pushes = []
        image_gen.PromptServer.instance.send_sync = \
            lambda event, data, sid=None: self.pushes.append((event, data))
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(setattr, image_gen, "_progress_for", self._orig_prog)
        self.addCleanup(setattr, image_gen.PromptServer.instance, "send_sync", self._orig_send)

    def _task(self):
        return {
            "task_id": "tw", "prompt_id": "p1", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "error": "", "warnings": [],
        }

    def test_pushes_on_change_only(self):
        states = iter([("running", None)] * 3
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        progs = iter([{"value": 1, "max": 8}, {"value": 1, "max": 8}, {"value": 2, "max": 8}])
        image_gen._lookup = lambda pid: next(states)
        image_gen._progress_for = lambda pid: next(progs)
        task = self._task()
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertEqual([p[0] for p in self.pushes],
                         ["rs.image_gen.status"] * 3)
        self.assertEqual([p[1]["status"] for p in self.pushes],
                         ["running", "running", "succeeded"])
        self.assertEqual([p[1]["progress"] for p in self.pushes],
                         [{"value": 1, "max": 8}, {"value": 2, "max": 8}, None])


class PreviewCaptureTests(unittest.TestCase):
    """采样预览图捕获：进度 handler 按 prompt 存最新一张，_watch 随快照推送，终态清空。"""

    def setUp(self):
        self._prev = dict(image_gen._PREVIEWS)
        image_gen._PREVIEWS.clear()
        self.addCleanup(self._restore_prev)

    def _restore_prev(self):
        image_gen._PREVIEWS.clear()
        image_gen._PREVIEWS.update(self._prev)

    @staticmethod
    def _image():
        from PIL import Image
        return ("JPEG", Image.new("RGB", (64, 64), (200, 30, 30)), 512)

    def test_preview_data_url(self):
        url = image_gen._preview_data_url(self._image())
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        raw = base64.b64decode(url.split(",", 1)[1])
        self.assertEqual(raw[:3], b"\xff\xd8\xff", "应为 JPEG")

    def test_capture_stores_latest_for_active_task(self):
        task = {
            "task_id": "tc", "prompt_id": "p9", "status": "running",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        image_gen._PREVIEW_CAPTURE.update_handler("n", 1, 8, {}, "p9", self._image())
        self.assertTrue(image_gen._PREVIEWS["p9"].startswith("data:image/jpeg;base64,"))
        # 无图 / 未知 prompt：不写入
        image_gen._PREVIEW_CAPTURE.update_handler("n", 2, 8, {}, "p9", None)
        image_gen._PREVIEW_CAPTURE.update_handler("n", 2, 8, {}, "p10", self._image())
        self.assertEqual(list(image_gen._PREVIEWS), ["p9"])

    def test_watch_pushes_preview_and_clears_on_finish(self):
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        self._orig_prog = image_gen._progress_for
        self._orig_send = image_gen.PromptServer.instance.send_sync
        image_gen.POLL_INTERVAL = 0.001
        pushes = []
        image_gen.PromptServer.instance.send_sync = \
            lambda event, data, sid=None: pushes.append(data)
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(setattr, image_gen, "_progress_for", self._orig_prog)
        self.addCleanup(setattr, image_gen.PromptServer.instance, "send_sync", self._orig_send)

        states = iter([("running", None)] * 2
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        progs = iter([{"value": 1, "max": 8}, {"value": 2, "max": 8}])
        image_gen._lookup = lambda pid: next(states)
        image_gen._progress_for = lambda pid: next(progs)
        task = {
            "task_id": "tp", "prompt_id": "p1", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)
        url = image_gen._preview_data_url(self._image())
        image_gen._PREVIEWS["p1"] = url

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertEqual([p["status"] for p in pushes], ["running", "running", "succeeded"])
        self.assertEqual([p["preview"] for p in pushes], [url, url, None],
                         "运行中随快照推预览图，终态清空")
        self.assertNotIn("p1", image_gen._PREVIEWS)

    def test_watch_re_registers_handler_after_registry_reset(self):
        """核心每次执行重建空 registry；_watch 须把捕获 handler 补注册回去。"""
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        image_gen.POLL_INTERVAL = 0.001
        # 模拟核心 reset_progress_state：新 registry，handlers 只剩 webui
        fresh = types.SimpleNamespace(prompt_id="p2", nodes={}, handlers={"webui": object()})
        orig_registry = _progress_registry_holder["registry"]
        _progress_registry_holder["registry"] = fresh
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(_progress_registry_holder.__setitem__, "registry", orig_registry)

        states = iter([("running", None)]
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        image_gen._lookup = lambda pid: next(states)
        task = {
            "task_id": "tr", "prompt_id": "p2", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertIn("neo_image_gen_preview", fresh.handlers,
                      "registry 被核心重建后，_watch 须补注册捕获 handler")


class SubmitGraphPreviewTests(unittest.TestCase):
    """submit_graph：未显式配置预览方法时按 prompt 附 extra_data.preview_method=latent2rgb。"""

    def _run(self, preview_method):
        import contextlib
        captured = {}

        class _Resp:
            status = 200

            async def json(self):
                return {"prompt_id": "pid1"}

        class _Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def post(self, url, json=None, timeout=None):
                @contextlib.asynccontextmanager
                async def _post():
                    captured["payload"] = json
                    yield _Resp()
                return _post()

        orig_session = image_gen.aiohttp.ClientSession
        image_gen.aiohttp.ClientSession = lambda *a, **k: _Session()
        self.addCleanup(setattr, image_gen.aiohttp, "ClientSession", orig_session)
        orig_pm = image_gen.cli_args.preview_method
        image_gen.cli_args.preview_method = preview_method
        self.addCleanup(setattr, image_gen.cli_args, "preview_method", orig_pm)

        pid = asyncio.run(image_gen.submit_graph({"1": {"class_type": "X"}}))
        self.assertEqual(pid, "pid1")
        return captured["payload"]

    def test_default_none_sends_latent2rgb(self):
        payload = self._run(image_gen.LatentPreviewMethod.NoPreviews)
        self.assertEqual(payload.get("extra_data"), {"preview_method": "latent2rgb"},
                         "CLI 默认不生成预览图，需按 prompt 附 latent2rgb")

    def test_explicit_method_not_overridden(self):
        payload = self._run(image_gen.LatentPreviewMethod.TAESD)
        self.assertNotIn("extra_data", payload, "用户显式配置过预览方法时沿用其设置")


if __name__ == "__main__":
    unittest.main()
