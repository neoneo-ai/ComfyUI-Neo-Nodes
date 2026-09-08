# SPDX-License-Identifier: Apache-2.0
"""image_gen 的离线单测：比例/尺寸、输出路径消毒、请求解析、工作流图形状。

不依赖 ComfyUI 运行中的服务器：server / folder_paths 用桩模块替换。
"""

import base64
import hashlib
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
        self.assertEqual(params["denoise"], 1.0)
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

    def test_count_forced_single_in_redraw(self):
        settings = base_settings()
        settings["count"] = 4
        raw = write_png(os.path.join(_INPUT_DIR, "ref_count.png"), 64, 64)
        uri = "data:image/png;base64," + base64.b64encode(raw).decode()
        params = image_gen.resolve_request(
            {"prompt": "a cat", "count": 4, "references": [{"kind": "data", "data": uri}]},
            settings)
        self.assertEqual(params["count"], 1)
        self.assertTrue(params["warnings"])

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
        self.assertEqual(params["count"], 1)          # 四视图强制单张
        self.assertAlmostEqual(params["denoise"], 1.0)
        self.assertEqual((params["width"], params["height"]), (1280, 720))  # 固定 16:9 横版
        self.assertTrue(params["prompt"].startswith(image_gen.FOUR_VIEW_PREFIX))
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


class GraphTests(unittest.TestCase):
    def params(self, **overrides):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "sub/style_b.safetensors", "strength": 1.0}]
        return image_gen.resolve_request({"prompt": "a red fox", "seed": 3, **overrides},
                                         settings)

    def test_text_to_image_shape(self):
        params = self.params(count=3)
        graph = image_gen.build_graph(params)
        self.assertIn("9", graph)
        self.assertNotIn("6", graph)
        self.assertNotIn("7", graph)
        self.assertNotIn("8", graph)
        self.assertEqual(graph["9"]["class_type"], "EmptyLatentImage")
        self.assertEqual(graph["9"]["inputs"]["batch_size"], 3)
        self.assertEqual(graph["12"]["class_type"], "SaveImage")
        self.assertEqual(graph["10"]["inputs"]["latent_image"], ("9", 0))

    def test_lora_chain(self):
        graph = image_gen.build_graph(self.params())
        self.assertEqual(graph["20"]["inputs"]["model"], ("1", 0))
        self.assertEqual(graph["21"]["inputs"]["model"], ("20", 0))
        self.assertEqual(graph["10"]["inputs"]["model"], ("21", 0))

    def test_reference_shape_uses_krea2_edit(self):
        write_png(os.path.join(_INPUT_DIR, "ref3.png"), 768, 1024)
        params = self.params(references=[{"kind": "input", "value": "ref3.png"}])
        graph = image_gen.build_graph(params)
        self.assertEqual(graph["6"]["class_type"], "LoadImage")
        scale = graph["7"]
        self.assertEqual(scale["class_type"], "ImageScale")
        self.assertEqual((scale["inputs"]["width"], scale["inputs"]["height"]), (768, 1024))
        self.assertEqual(scale["inputs"]["crop"], "disabled")
        encode = graph["8"]
        self.assertEqual(encode["class_type"], "VAEEncode")
        self.assertEqual(encode["inputs"]["pixels"], ("7", 0))
        # positive/negative 都是接地编码，接同一张参考图
        self.assertEqual(graph["4"]["class_type"], "Krea2EditGroundedEncode")
        self.assertEqual(graph["5"]["class_type"], "Krea2EditGroundedEncode")
        # 接地编码同源到已缩放参考图：positive native(0)、negative 限 768（对齐四视图工作流）
        self.assertEqual(graph["4"]["inputs"]["image"], ("7", 0))
        self.assertEqual(graph["5"]["inputs"]["image"], ("7", 0))
        self.assertEqual(graph["4"]["inputs"]["grounding_px"], 0)
        self.assertEqual(graph["5"]["inputs"]["grounding_px"], 768)
        self.assertEqual(graph["5"]["inputs"]["prompt"], "")
        # 目标 latent：横版空 latent，同时喂 KSampler 与 model patch 的 target_latent
        target = graph["9"]
        self.assertEqual(target["class_type"], "EmptySD3LatentImage")
        self.assertEqual((target["inputs"]["width"], target["inputs"]["height"]), (1280, 720))
        self.assertEqual(graph["10"]["inputs"]["latent_image"], ("9", 0))
        patch = graph["14"]
        self.assertEqual(patch["class_type"], "Krea2EditModelPatch")
        self.assertEqual(patch["inputs"]["fit_mode"], "fit")
        self.assertEqual(patch["inputs"]["source_latent"], ("8", 0))
        self.assertEqual(patch["inputs"]["source_image"], ("7", 0))
        self.assertEqual(patch["inputs"]["target_latent"], ("9", 0))
        self.assertEqual(patch["inputs"]["vae"], ("3", 0))
        # KSampler 吃 patch 后的 model，denoise 恒为 1.0
        self.assertEqual(graph["10"]["inputs"]["model"], ("14", 0))
        self.assertAlmostEqual(graph["10"]["inputs"]["denoise"], 1.0)

    def test_reference_lora_chain_appends_quadview(self):
        write_png(os.path.join(_INPUT_DIR, "ref3.png"), 768, 1024)
        params = self.params(references=[{"kind": "input", "value": "ref3.png"}])
        graph = image_gen.build_graph(params)
        # 用户两个 LoRA + 自动四视图 LoRA：20 -> 21 -> 22 -> patch
        self.assertEqual(graph["20"]["inputs"]["model"], ("1", 0))
        self.assertEqual(graph["21"]["inputs"]["model"], ("20", 0))
        self.assertEqual(graph["22"]["inputs"]["lora_name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertAlmostEqual(graph["22"]["inputs"]["strength_model"], 1.0)
        self.assertEqual(graph["14"]["inputs"]["model"], ("22", 0))

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


if __name__ == "__main__":
    unittest.main()
