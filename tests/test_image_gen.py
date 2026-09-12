# SPDX-License-Identifier: Apache-2.0
"""image_gen 的离线单测：比例/尺寸、输出路径消毒、请求解析、工作流模板渲染与技能路由。

不依赖 ComfyUI 运行中的服务器：server / folder_paths 用桩模块替换。
"""

import asyncio
import base64
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
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188,
                                        tls_keyfile=None, tls_certfile=None)
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
# 单测里直接改 image_gen.get_progress_state 控制返回值
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

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

import image_gen  # noqa: E402

# image_gen 的路由处理器内惰性 `from . import skill`；把 skill.py 注册到虚拟包下，
# 让单测里相对导入可解析（与 test_skills 的桩策略一致）
_pkg = types.ModuleType("_neo_imgen_pkg")
_pkg.__path__ = [PLUGIN_DIR]
sys.modules["_neo_imgen_pkg"] = _pkg
_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.skill", os.path.join(PLUGIN_DIR, "skill.py"))
_skill_mod = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.skill"] = _skill_mod
_spec.loader.exec_module(_skill_mod)
_pkg.skill = _skill_mod
image_gen.__package__ = "_neo_imgen_pkg"
# __spec__.parent 与 __package__ 保持一致，避免相对导入触发 DeprecationWarning
image_gen.__spec__ = types.SimpleNamespace(name="_neo_imgen_pkg.image_gen",
                                           parent="_neo_imgen_pkg")


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
        # 参考图模式：勾了「依赖参考图」的 style_b 即视为四视图 LoRA，直接沿用、不再追加
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
        # 勾了「依赖参考图」的 LoRA（文件名不含线索）即视为四视图 LoRA：沿用、不追加、不报错
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
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen_text", "workflow.json"),
                  encoding="utf-8") as f:
            cls.text_template = json.load(f)
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen", "workflow.json"),
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

    def tearDown(self):
        _skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
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

        # 预设只读 → 403
        status, _ = self._call(image_gen.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"count": 2}}))
        self.assertEqual(status, 403)

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


if __name__ == "__main__":
    unittest.main()
