# SPDX-License-Identifier: Apache-2.0
"""h3_video_director + video_director 配方 schema 的离线单测。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
recipes 的 gallery/bookmark/gallery_lora/util 依赖用假模块；director 编排逻辑通过 monkeypatch
execute_graph_inprocess / resolve_video_params 等验证帧拼接、边界丢帧、seed 派生与音频对齐。"""

import asyncio
import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest

import torch
from PIL import Image

_TMP = tempfile.mkdtemp(prefix="neo_h3director_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
    "text_encoders": ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
    "loras": [],
}

# ---- 桩模块（对齐 test_h3_video_gen.py）----
_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), client_id=None, send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188, tls_keyfile=None, tls_certfile=None)
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli
_comfy_pe = types.ModuleType("comfy.patcher_extension")
_comfy_pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="DIFFUSION_MODEL", APPLY_MODEL="APPLY_MODEL")
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

# node_helpers 桩：conditioning_set_values 只做「复制 metadata 并写入给定值」（与 core 同语义）
_node_helpers = types.ModuleType("node_helpers")


def _stub_conditioning_set_values(conditioning, values=None, append=False):
    out = []
    for t, d in conditioning:
        nd = dict(d)
        for k, v in (values or {}).items():
            nd[k] = ((nd.get(k) or []) + v) if append else v
        out.append([t, nd])
    return out


_node_helpers.conditioning_set_values = _stub_conditioning_set_values
sys.modules["node_helpers"] = _node_helpers

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_h3director_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


# ---- recipes 的依赖桩（gallery/bookmark/gallery_lora/util）----
_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}


def _fake_copy_media_to_input(source_path, filename):
    import shutil
    dest = os.path.join(_INPUT_DIR, filename)
    if not os.path.exists(dest):
        shutil.copy2(str(source_path), dest)
    return filename, False


_gallery._copy_media_to_input = _fake_copy_media_to_input
sys.modules[f"{_PKG}.gallery"] = _gallery
setattr(_pkg, "gallery", _gallery)

_bookmark = types.ModuleType(f"{_PKG}.bookmark")
_bookmark._download_bytes = lambda *a, **k: b""
_bookmark._media_ext_from_url_or_bytes = lambda *a, **k: ".png"
sys.modules[f"{_PKG}.bookmark"] = _bookmark
setattr(_pkg, "bookmark", _bookmark)

_gallery_lora = types.ModuleType(f"{_PKG}.gallery_lora")
_gallery_lora.LORA_CACHE_DIR = os.path.join(_TMP, "lora_cache")
_gallery_lora._load_lora_index = lambda *a, **k: {}
sys.modules[f"{_PKG}.gallery_lora"] = _gallery_lora
setattr(_pkg, "gallery_lora", _gallery_lora)

_util = types.ModuleType(f"{_PKG}.util")
_util._extract_media_metadata = lambda *a, **k: {}
_util._json_safe = lambda v: v
sys.modules[f"{_PKG}.util"] = _util
setattr(_pkg, "util", _util)

# ---- h3_preview 依赖桩：latent_preview / comfy.model_management / comfy.latent_formats / comfy.taesd.taesd ----
# taeh3 缺失时预览走 Latent2RGB 回退，故 get_full_path 返回 None（离线测试不碰真实权重）。
_folder_paths.get_full_path = lambda folder, name: None

_comfy_mm = types.ModuleType("comfy.model_management")
_comfy_mm.vae_device = lambda *a, **k: torch.device("cpu")
_comfy_mm.vae_dtype = lambda device, allowed=None: torch.float32
sys.modules["comfy.model_management"] = _comfy_mm

_comfy_lf = types.ModuleType("comfy.latent_formats")


class _StubMiniMaxH3Video:
    latent_rgb_factors = [[0.1, 0.2, 0.3]]
    latent_rgb_factors_bias = None
    latent_rgb_factors_reshape = None


_comfy_lf.MiniMaxH3Video = _StubMiniMaxH3Video
sys.modules["comfy.latent_formats"] = _comfy_lf

_comfy_taesd = types.ModuleType("comfy.taesd")
_comfy_taesd_taesd = types.ModuleType("comfy.taesd.taesd")


class _StubClamp(torch.nn.Module):
    def forward(self, x):
        return x


class _StubBlock(torch.nn.Module):
    """占位 Block：只留通道数，供 _build_decoder 的结构断言（真实 Block 由真机覆盖）。"""

    def __init__(self, n_in, n_out):
        super().__init__()
        self.n_in = n_in
        self.n_out = n_out


def _stub_conv(n_in, n_out, **kwargs):
    return torch.nn.Conv2d(n_in, n_out, 3, padding=1, bias=kwargs.get("bias", True))


_comfy_taesd_taesd.Clamp = _StubClamp
_comfy_taesd_taesd.Block = _StubBlock
_comfy_taesd_taesd.conv = _stub_conv
sys.modules["comfy.taesd"] = _comfy_taesd
sys.modules["comfy.taesd.taesd"] = _comfy_taesd_taesd


class _StubLatentPreviewer:
    def decode_latent_to_preview(self, x0):
        pass

    def decode_latent_to_preview_image(self, preview_format, x0):
        return ("JPEG", self.decode_latent_to_preview(x0), 512)


class _StubLatent2RGBPreviewer(_StubLatentPreviewer):
    def __init__(self, factors, bias=None, reshape=None):
        self.factors = factors


def _stub_preview_to_image(latent_image, do_scale=True):
    return Image.new("RGB", (int(latent_image.shape[1]), int(latent_image.shape[0])))


_latent_preview_stub = types.ModuleType("latent_preview")
_latent_preview_stub.LatentPreviewer = _StubLatentPreviewer
_latent_preview_stub.Latent2RGBPreviewer = _StubLatent2RGBPreviewer
_latent_preview_stub.preview_to_image = _stub_preview_to_image
_latent_preview_stub.get_previewer = lambda device, latent_format: None
sys.modules["latent_preview"] = _latent_preview_stub

# 预置在 sys.modules 的子模块不会自动挂到父模块，补上属性以支持 `comfy.x.y` 形式访问。
setattr(_comfy, "model_management", _comfy_mm)
setattr(_comfy, "utils", _comfy_utils)
setattr(_comfy, "latent_formats", _comfy_lf)
setattr(_comfy, "taesd", _comfy_taesd)
setattr(_comfy_taesd, "taesd", _comfy_taesd_taesd)

# ---- 加载插件模块 ----
_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
krea2_generate = _load("krea2_generate", "krea2_generate.py")
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
video_gen = _load("video_gen", "video_gen.py")
recipes = _load("recipes", "recipes.py")

# comfy_api.latest 桩：director 仅用 VideoFromComponents/VideoComponents 作容器，
# get_components() 原样返回传入的 components（.images/.audio），足以验证编排逻辑。
class _StubVideoComponents:
    def __init__(self, images=None, audio=None, frame_rate=None, metadata=None, alpha=None):
        self.images = images
        self.audio = audio
        self.frame_rate = frame_rate
        self.metadata = metadata
        self.alpha = alpha


class _StubVideoFromComponents:
    def __init__(self, components, **kwargs):
        self.__components = components

    def get_components(self):
        return self.__components


_comfy_api = types.ModuleType("comfy_api")
_comfy_api_latest = types.ModuleType("comfy_api.latest")
_comfy_api_latest.Types = types.SimpleNamespace(VideoComponents=_StubVideoComponents)
_comfy_api_latest.InputImpl = types.SimpleNamespace(VideoFromComponents=_StubVideoFromComponents)
sys.modules["comfy_api"] = _comfy_api
sys.modules["comfy_api.latest"] = _comfy_api_latest

h3_video_director = _load("h3_video_director", "h3_video_director.py")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

# ===========================================================================
# P1：_normalize_director 校验
# ===========================================================================
class NormalizeDirectorTests(unittest.TestCase):
    def test_valid_segments_normalized(self):
        shared, segs = recipes._normalize_director(
            {"shared": {"width": "800", "height": 600, "seed": "7"},
             "segments": [
                 {"skill_id": "h3_t2v", "prompt": "a cat", "duration_sec": 5},
                 {"skill_id": "h3_i2v", "prompt": "runs", "first_frame": "f.png"},
             ]},
            {"f.png": "f_copied.png"})
        self.assertEqual(shared, {"width": 800, "height": 600, "seed": 7})
        self.assertEqual(segs[0]["skill_id"], "h3_t2v")
        self.assertIsNone(segs[0].get("first_frame"))
        # first_frame 回写为落盘最终名（原始名 → copied 名）
        self.assertEqual(segs[1]["first_frame"], "f_copied.png")

    def test_empty_segments_rejected(self):
        with self.assertRaises(ValueError):
            recipes._normalize_director({"segments": []}, {})

    def test_missing_skill_id_rejected(self):
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "x", "skill_id": ""}]}, {})

    def test_bad_first_frame_ref_rejected(self):
        # 段引用了未出现在 orig_to_copied 的资产 → 拒绝
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "nope.png"}]},
                {"other.png": "other.png"})

    def test_resave_keeps_stored_asset_ref(self):
        # 二次保存：段引用的是上次保存回写的落盘最终名（不在本次 orig_to_copied），
        # 该名字在 existing_assets 中 → 直接保留不报错
        shared, segs = recipes._normalize_director(
            {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "f_copied.png"}]},
            {}, {"f_copied.png"})
        self.assertEqual(segs[0]["first_frame"], "f_copied.png")
        # 不在 existing_assets 的名字仍拒绝
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "ghost.png"}]},
                {}, {"f_copied.png"})

    def test_empty_prompt_rejected(self):
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "  ", "skill_id": "s"}]}, {})

    def test_global_mode_preserved(self):
        shared, _ = recipes._normalize_director(
            {"shared": {"mode": "i2v"}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["mode"], "i2v")

    def test_invalid_global_mode_dropped(self):
        shared, _ = recipes._normalize_director(
            {"shared": {"mode": "xxx"}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertNotIn("mode", shared)

    def test_segment_mode_kept_when_valid_dropped_when_invalid(self):
        _, segs = recipes._normalize_director(
            {"shared": {"mode": "mixed"},
             "segments": [{"prompt": "x", "skill_id": "s", "mode": "t2v"},
                          {"prompt": "y", "skill_id": "s", "mode": "bogus"}]}, {})
        self.assertEqual(segs[0]["mode"], "t2v")
        self.assertNotIn("mode", segs[1])

    def test_segment_ref_media_capped(self):
        # 每段参考上限与参考节点槽位一致：图 9 / 视频 3 / 音频 3
        names = ([f"i{n}.png" for n in range(12)] + [f"v{n}.mp4" for n in range(5)]
                 + [f"a{n}.wav" for n in range(5)])
        _, segs = recipes._normalize_director(
            {"shared": {"mode": "i2v"},
             "segments": [{"prompt": "x", "skill_id": "s",
                           "refs": {"images": names[:12], "videos": names[12:17], "audios": names[17:]}}]},
            {n: n for n in names})
        self.assertEqual(len(segs[0]["refs"]["images"]), 9)
        self.assertEqual(len(segs[0]["refs"]["videos"]), 3)
        self.assertEqual(len(segs[0]["refs"]["audios"]), 3)



# ===========================================================================
# P1：_normalize_director_story（自动故事板内容随配方落盘）
# ===========================================================================
class NormalizeDirectorStoryTests(unittest.TestCase):
    def test_story_normalized_and_refs_rewritten(self):
        # 描述去空白保留；参考图原始名回写为落盘最终名；粒度转 int
        story = recipes._normalize_director_story(
            {"story": {"idea": " 主题 ", "story": " 正文 ",
                       "characters": [{"filename": "c.png", "desc": " 猫 "}],
                       "backgrounds": [{"filename": "b.png"}],
                       "segment_seconds": "10"}},
            {"c.png": "c_copied.png", "b.png": "b_copied.png"})
        self.assertEqual(story["idea"], "主题")
        self.assertEqual(story["story"], "正文")
        self.assertEqual(story["characters"], [{"filename": "c_copied.png", "desc": "猫"}])
        self.assertEqual(story["backgrounds"], [{"filename": "b_copied.png"}])
        self.assertEqual(story["segment_seconds"], 10)

    def test_missing_and_empty_story_returns_none(self):
        self.assertIsNone(recipes._normalize_director_story({}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": {}}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": {"idea": "  "}}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": "不是对象"}, {}))

    def test_unstored_ref_dropped_without_failing(self):
        # 参考图只喂故事生成：引用未落盘资产时丢该条，其余内容仍保存
        story = recipes._normalize_director_story(
            {"story": {"story": "正文", "characters": [{"filename": "ghost.png"}]}}, {})
        self.assertEqual(story["characters"], [])
        self.assertEqual(story["story"], "正文")

    def test_resave_keeps_stored_ref(self):
        # 二次保存：参考图是上次回写的最终名（不在本次 orig_to_copied）→ 直接保留
        story = recipes._normalize_director_story(
            {"story": {"idea": "x", "characters": [{"filename": "c_copied.png", "desc": "猫"}]}},
            {}, {"c_copied.png"})
        self.assertEqual(story["characters"], [{"filename": "c_copied.png", "desc": "猫"}])


# ===========================================================================
# P1：_normalize_director_setup（统一设置区状态随配方落盘）
# ===========================================================================
class NormalizeDirectorSetupTests(unittest.TestCase):
    def test_setup_normalized_and_refs_rewritten(self):
        # 参考原始名回写为落盘最终名；首/尾帧同样回写
        setup = recipes._normalize_director_setup(
            {"setup": {"refs": {"images": ["a.png", "ghost.png"], "videos": ["v.mp4"]},
                       "first_frame": "f.png", "last_frame": "l.png"}},
            {"a.png": "a_copied.png", "v.mp4": "v_copied.mp4",
             "f.png": "f_copied.png", "l.png": "l_copied.png"})
        self.assertEqual(setup["refs"]["images"], ["a_copied.png"])   # 未落盘资产被丢弃、不报错
        self.assertEqual(setup["refs"]["videos"], ["v_copied.mp4"])
        self.assertEqual(setup["first_frame"], "f_copied.png")
        self.assertEqual(setup["last_frame"], "l_copied.png")

    def test_missing_and_empty_setup_returns_none(self):
        self.assertIsNone(recipes._normalize_director_setup({}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": {}}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": {"refs": {}}}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": "不是对象"}, {}))

    def test_resave_keeps_stored_ref(self):
        # 二次保存：统一素材是上次回写的最终名（不在本次 orig_to_copied）→ 直接保留
        setup = recipes._normalize_director_setup(
            {"setup": {"refs": {"images": ["a_copied.png"]}, "first_frame": "f_copied.png"}},
            {}, {"a_copied.png", "f_copied.png"})
        self.assertEqual(setup["refs"]["images"], ["a_copied.png"])
        self.assertEqual(setup["first_frame"], "f_copied.png")

    def test_prompt_compare_kept(self):
        # 优化前后提示词对照原样落盘（仅回显用）；空项/非文本项被丢弃
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": ["a", "  b  ", "", None], "opt_prompts": [1]}}, {})
        self.assertEqual(setup["orig_prompts"], ["a", "b"])
        self.assertEqual(setup["opt_prompts"], ["1"])

    def test_prompt_compare_only_still_writes(self):
        # 仅对照内容也写入 setup；空列表不写该字段
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": ["a"], "opt_prompts": []}}, {})
        self.assertEqual(setup["orig_prompts"], ["a"])
        self.assertNotIn("opt_prompts", setup)

    def test_bad_prompt_compare_dropped(self):
        # 非列表的对照字段丢弃，不影响其他字段
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": "不是列表", "first_frame": "f.png"}},
            {"f.png": "f_copied.png"})
        self.assertNotIn("orig_prompts", setup)
        self.assertEqual(setup["first_frame"], "f_copied.png")


# ===========================================================================
# P1：list_director_recipes / load_director_spec（临时目录，不污染真实配方）
# ===========================================================================
class DirectorRecipeIOTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_dirrec_")
        self.custom = os.path.join(self._tmp, "custom")
        self.presets = os.path.join(self._tmp, "presets")
        os.makedirs(self.custom)
        os.makedirs(self.presets)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        self._orig_presets = recipes.PRESETS_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)

    def tearDown(self):
        recipes.CUSTOM_DIR = self._orig_custom
        recipes.PRESETS_DIR = self._orig_presets

    def _make_recipe(self, name, meta, assets=()):
        d = os.path.join(self.custom, name)
        assets_dir = os.path.join(d, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        for a in assets:
            with open(os.path.join(assets_dir, a), "wb") as f:
                f.write(b"fake-media-bytes")
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)

    def test_list_returns_only_directors(self):
        self._make_recipe("flat", {"prompt": "p"})
        self._make_recipe("dir1", {"type": "video_director", "shared": {}, "segments": [
            {"skill_id": "s", "prompt": "p"}]}, assets=["f.png"])
        self.assertEqual(recipes.list_director_recipes(), ["dir1"])

    def test_list_sorted_by_mtime_descending(self):
        # /rs_recipes/list 组内按最近修改时间倒序：最新改动的配方排在最前
        import time
        self._make_recipe("aaa", {"prompt": "p"})
        self._make_recipe("zzz", {"prompt": "q"})
        now = time.time()
        os.utime(os.path.join(self.custom, "aaa", "recipe.json"), (now - 3600, now - 3600))
        os.utime(os.path.join(self.custom, "zzz", "recipe.json"), (now, now))

        resp = _run_async(recipes.rs_recipes_list(None))
        self.assertEqual(resp.status, 200)
        names = [r["name"] for r in json.loads(resp.body)]
        # zzz（新）在 aaa（旧）之前；若按名字字母序则会反过来
        self.assertEqual(names[:2], ["zzz", "aaa"])

    def test_load_spec_resolves_first_frame(self):
        self._make_recipe("d", {"type": "video_director",
                                "shared": {"width": 8, "height": 8, "seed": 1},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "duration_sec": 5, "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("d")
        self.assertEqual(spec["shared"]["seed"], 1)
        self.assertEqual(len(spec["segments"]), 2)
        self.assertEqual(spec["segments"][0]["ref_input"], "f.png")
        self.assertIsNone(spec["segments"][1]["ref_input"])

    def test_load_spec_global_i2v_forces_all_modes(self):
        # 全局图生视频：所有段有效模式都是 i2v（后续段可无自带首帧，靠连续性链入）
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"mode": "i2v", "width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "i2v"])

    def test_load_spec_global_t2v_forces_all_modes(self):
        # 全局文生视频：即便段带首帧，有效模式仍统一为 t2v
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"mode": "t2v", "width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual(spec["segments"][0]["mode"], "t2v")

    def test_load_spec_mixed_respects_segment_mode(self):
        # 混合模式：逐段采用各自 seg.mode
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"mode": "mixed", "width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "mode": "i2v", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b", "mode": "t2v"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "t2v"])

    def test_load_spec_legacy_infers_mode_from_first_frame(self):
        # 旧配方无 shared.mode / seg.mode：按是否带首帧推断（有=i2v，无=t2v）
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "t2v"])

    def test_load_spec_resolves_segment_ref_media(self):
        # 每段挂的图/视频/音频参考解析成 input 相对名，供参考生视频技能使用
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "i2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "refs": {"images": ["a.png", "b.png"],
                                                       "videos": ["v.mp4"],
                                                       "audios": ["s.wav"]}}]},
                         assets=["a.png", "b.png", "v.mp4", "s.wav"])
        spec = recipes.load_director_spec("r")
        self.assertEqual(spec["segments"][0]["refs"],
                         {"images": ["a.png", "b.png"], "videos": ["v.mp4"], "audios": ["s.wav"]})

    def test_load_spec_skips_missing_ref_media(self):
        # 缺文件的参考只跳过该条，其余照常解析（不整段失败）
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "i2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "refs": {"videos": ["gone.mp4", "v.mp4"]}}]},
                         assets=["v.mp4"])
        spec = recipes.load_director_spec("r")
        self.assertEqual(spec["segments"][0]["refs"], {"videos": ["v.mp4"]})

    def test_load_spec_resolves_last_frame(self):
        # 首尾帧模式：首帧 → ref_input，尾帧 → last_input，模式沿用配方 shared.mode
        self._make_recipe("f", {"type": "video_director",
                                "shared": {"mode": "fl2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "first_frame": "a.png", "last_frame": "z.png"}]},
                         assets=["a.png", "z.png"])
        seg = recipes.load_director_spec("f")["segments"][0]
        self.assertEqual(seg["ref_input"], "a.png")
        self.assertEqual(seg["last_input"], "z.png")
        self.assertEqual(seg["mode"], "fl2v")

    def test_load_spec_infers_fl2v_from_last_frame(self):
        # 旧配方无 mode：只挂尾帧也识别为首尾帧模式
        self._make_recipe("f", {"type": "video_director", "shared": {"width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p", "last_frame": "z.png"}]},
                         assets=["z.png"])
        self.assertEqual(recipes.load_director_spec("f")["segments"][0]["mode"], "fl2v")

    def test_new_modes_kept_by_normalize(self):
        # 新段级模式（fl2v/r2v）与 last_frame 都要保留
        shared, segs = recipes._normalize_director(
            {"shared": {"mode": "fl2v"},
             "segments": [{"prompt": "x", "skill_id": "s", "mode": "r2v", "last_frame": "z.png"}]},
            {"z.png": "z.png"})
        self.assertEqual(shared["mode"], "fl2v")
        self.assertEqual(segs[0]["mode"], "r2v")
        self.assertEqual(segs[0]["last_frame"], "z.png")

    def test_load_spec_without_refs_has_empty_refs(self):
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "t2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p"}]})
        self.assertEqual(recipes.load_director_spec("r")["segments"][0]["refs"], {})

    def test_load_spec_rejects_flat_recipe(self):
        self._make_recipe("flat", {"prompt": "p"})
        with self.assertRaises(ValueError):
            recipes.load_director_spec("flat")

    def test_save_route_persists_director(self):
        payload = {"name": "saved-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8, "seed": 3},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}]}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200)
        with open(os.path.join(self.custom, "saved-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["type"], "video_director")
        self.assertEqual(saved["segments"][0]["skill_id"], "s")

    def test_save_route_rejects_bad_director(self):
        payload = {"name": "bad-dir", "type": "video_director",
                   "shared": {}, "segments": []}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 400)

    def test_resave_director_with_stored_first_frame(self):
        # 回归：首次保存后 first_frame 被回写为落盘最终名；二次保存时前端只重传
        # 当前连线的原始素材（甚至不再重传该图），引用已落盘名字不应报「未保存的资产」，
        # 且旧资产仍保留在 recipe.json 的 assets 清单里。
        self._make_recipe("resave-dir", {
            "type": "video_director",
            "shared": {"width": 8, "height": 8, "seed": 0},
            "assets": ["f.png"],
            "segments": [{"skill_id": "s", "prompt": "p", "first_frame": "f.png"}],
        }, assets=["f.png"])

        payload = {"name": "resave-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8},
                   "assets": [],   # 二次保存未重传素材
                   "segments": [{"skill_id": "s", "prompt": "p2", "first_frame": "f.png"}]}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"二次保存被误拒：{resp.body}")
        with open(os.path.join(self.custom, "resave-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["segments"][0]["first_frame"], "f.png")
        self.assertIn("f.png", saved["assets"], "未重传的既有资产应保留在清单")

    def test_story_saved_and_returned_on_reopen(self):
        # 自动故事板内容随配方落盘，重新打开（扫描 recipe.json）时带回给编辑器回显
        payload = {"name": "story-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8, "seed": 3},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}],
                   "story": {"idea": "主题", "story": "正文", "characters": [], "backgrounds": [],
                             "segment_seconds": 10}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "story-dir", "custom")
        self.assertEqual(scanned["story"]["story"], "正文")
        self.assertEqual(scanned["story"]["segment_seconds"], 10)

    def test_setup_saved_and_returned_on_reopen(self):
        # 统一设置区状态随配方落盘，重新打开（扫描 recipe.json）时带回给编辑器回显
        self._make_recipe("setup-dir", {"type": "video_director", "shared": {},
                                        "segments": [{"skill_id": "s", "prompt": "p"}],
                                        "assets": ["a.png", "f.png"]},
                          assets=["a.png", "f.png"])
        payload = {"name": "setup-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}],
                   "setup": {"refs": {"images": ["a.png"]}, "first_frame": "f.png"}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")

        with open(os.path.join(self.custom, "setup-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["setup"]["refs"]["images"], ["a.png"])
        self.assertEqual(saved["setup"]["first_frame"], "f.png")

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "setup-dir", "custom")
        self.assertEqual(scanned["setup"]["first_frame"], "f.png")
        self.assertEqual(scanned["setup"]["refs"]["images"], ["a.png"])

    def test_director_without_setup_has_no_setup_key(self):
        # 统一区为空时不写 setup 键，旧配方重存也不该凭空多出
        self._make_recipe("nosetup-dir", {"type": "video_director", "shared": {},
                                          "segments": [{"skill_id": "s", "prompt": "p"}]})
        payload = {"name": "nosetup-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p"}],
                   "setup": {"refs": {}}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")
        with open(os.path.join(self.custom, "nosetup-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertNotIn("setup", saved)

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "nosetup-dir", "custom")
        self.assertNotIn("setup", scanned)

    def test_director_without_story_has_no_story_key(self):
        # 旧配方（保存时没有故事板内容）不该凭空多出 story 键
        self._make_recipe("nostory-dir", {"type": "video_director", "shared": {},
                                          "segments": [{"skill_id": "s", "prompt": "p"}]})
        payload = {"name": "nostory-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p"}],
                   "story": {"idea": None, "story": None, "characters": [], "backgrounds": [],
                             "segment_seconds": None}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")
        with open(os.path.join(self.custom, "nostory-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertNotIn("story", saved)

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "nostory-dir", "custom")
        self.assertNotIn("story", scanned)

    def test_copy_route_creates_new_custom_recipe(self):
        # 复制配方：整目录复制到 custom，recipe.json 的 name 改写为新名，资源一并复制
        self._make_recipe("src", {"prompt": "p", "assets": ["f.png"]}, assets=["f.png"])

        class _Req:
            async def json(self):
                return {"name": "src"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["name"], "src-copy")
        with open(os.path.join(self.custom, "src-copy", "recipe.json"), encoding="utf-8") as f:
            copied = json.load(f)
        self.assertEqual(copied["name"], "src-copy")
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "src-copy", "assets", "f.png")))

    def test_copy_route_increments_on_conflict(self):
        # 目标名冲突时自动加 -2/-3：已存在 src-copy → 复制得到 src-2
        self._make_recipe("src", {"prompt": "p"})
        self._make_recipe("src-copy", {"prompt": "q"})

        class _Req:
            async def json(self):
                return {"name": "src"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body)["name"], "src-2")

    def test_copy_route_copies_preset_to_custom(self):
        # preset 只读不可删，但可复制成 custom（副本落在 custom/）
        d = os.path.join(self.presets, "pre")
        os.makedirs(os.path.join(d, "assets"), exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"prompt": "preset-p"}, f)

        class _Req:
            async def json(self):
                return {"name": "pre"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body)["name"], "pre-copy")
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "pre-copy", "recipe.json")))

    def test_copy_route_missing_source_404(self):
        class _Req:
            async def json(self):
                return {"name": "nope"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 404)


# ===========================================================================
# P2：director 编排（帧拼接 / 边界丢帧 / seed 派生 / 音频对齐）
# ===========================================================================
class _FakeComp:
    def __init__(self, images, audio):
        self.images = images
        self.audio = audio


class _FakeVideo:
    """get_components() 返回 n_frames 帧 + 每帧 samples_per_frame 采样的音频。"""

    def __init__(self, n_frames, frame_rate=24, sample_rate=48000):
        self._images = torch.rand(n_frames, 8, 8, 3)
        spf = sample_rate // frame_rate
        self._audio = {"waveform": torch.zeros(1, 1, n_frames * spf), "sample_rate": sample_rate}

    def get_components(self):
        return _FakeComp(self._images, self._audio)


class DirectorOrchestrationTests(unittest.TestCase):
    SR = 48000
    FPS = 24
    SPF = SR // FPS   # 2000 samples/frame

    def _patch(self, n_segments, frame_counts, seed_base=100, mode=None):
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(n, self.FPS, self.SR) for n in frame_counts)

        def _fake_exec(graph, output_type="IMAGE", **kw):
            return next(it)

        # i2v 段首段需自带首帧才能通过执行校验，给占位 ref_input；t2v / 无模式段不带参考。
        ref = "ff.png" if mode == "i2v" else None
        segments = [{"skill_id": f"s{i}", "prompt": f"p{i}",
                     "duration_sec": 5, "ref_input": ref, "mode": mode} for i in range(n_segments)]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": seed_base},
                                               "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, **kw):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = _fake_exec
        return orig, bodies

    def test_continuity_on_drops_boundary_frames(self):
        # context_frames=0：退回 Tier A（上段尾帧当首帧 + 丢边界帧）
        orig, bodies = self._patch(3, [124, 124, 124], mode="i2v")
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        # 124 + (124-1) + (124-1) = 370
        self.assertEqual(comp.images.shape[0], 124 + 123 + 123)
        self.assertEqual([b["seed"] for b in bodies], [100, 101, 102])

    def test_continuity_off_keeps_all_frames(self):
        orig, _ = self._patch(3, [124, 124, 124])
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 124 * 3)

    def test_seed_override_beats_shared(self):
        orig, bodies = self._patch(2, [100, 100], seed_base=100)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", seed=500, continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual([b["seed"] for b in bodies], [500, 501])

    def test_audio_trimmed_to_match_dropped_frames(self):
        orig, _ = self._patch(3, [124, 124, 124], mode="i2v")
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        # 帧数 370 → 音频应恰好 370 * SPF 采样（A/V 对齐）
        self.assertEqual(comp.images.shape[0], 370)
        self.assertEqual(comp.audio["waveform"].shape[-1], 370 * self.SPF)

    def test_concat_audio_none_when_no_audio(self):
        out = h3_video_director._concat_segment_audio([None, None], self.FPS, [0, 1])
        self.assertIsNone(out)

    def test_t2v_continuity_keeps_all_frames(self):
        # T2V 段在 Tier A（context_frames=0）下不带参考图、也不链入上段尾帧 → 全帧拼接
        orig, _ = self._patch(3, [124, 124, 124])   # mode=None → t2v
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 124 * 3)

    def test_ref_attached_only_to_i2v_segments(self):
        # 混合模式：i2v 段携带首帧参考，t2v 段绝不带
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(100, self.FPS, self.SR) for _ in range(2))
        segments = [
            {"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "ref_input": "ff.png", "mode": "i2v"},
            {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "ref_input": None, "mode": "t2v"},
        ]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 1},
                                               "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, **kw):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: next(it)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertIn("references", bodies[0])
        self.assertEqual(bodies[0]["references"][0]["value"], "ff.png")
        self.assertNotIn("references", bodies[1])

    def test_media_refs_attached_with_type_for_i2v_segment(self):
        # i2v 段：首帧 + 挂的图/视频/音频参考都进 body["references"]，视频/音频带 media 标记
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(100, self.FPS, self.SR) for _ in range(1))
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "i2v",
                          "ref_input": "ff.png",
                          "refs": {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["s.wav"]}}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: bodies.append(dict(body)) or {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: next(it)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        refs = bodies[0]["references"]
        self.assertEqual([r["value"] for r in refs], ["ff.png", "a.png", "v.mp4", "s.wav"])
        self.assertEqual([r.get("media") for r in refs], [None, None, "video", "audio"])

    def test_i2v_without_first_frame_raises(self):
        # 首段 i2v 无自带首帧、无上段可链入 → 明确报错而非静默按 t2v 生成
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5,
                          "ref_input": None, "mode": "i2v"}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: _FakeVideo(100, self.FPS, self.SR)
        try:
            with self.assertRaises(ValueError):
                h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)

    def test_reports_progress_per_segment_and_resets(self):
        h3d = h3_video_director
        orig, _ = self._patch(3, [100, 100, 100])
        seen = []
        real_exec = h3d.execute_graph_inprocess

        def _recording_exec(graph, output_type="IMAGE", **kw):
            seen.append(dict(h3d._DIRECTOR_PROGRESS))
            return real_exec(graph, output_type, **kw)

        h3d.execute_graph_inprocess = _recording_exec
        try:
            h3d.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        # 每段执行时：active、total_segments=3，segment_index 依次 0/1/2
        self.assertEqual([s["active"] for s in seen], [True, True, True])
        self.assertEqual([s["total_segments"] for s in seen], [3, 3, 3])
        self.assertEqual([s["segment_index"] for s in seen], [0, 1, 2])
        # 结束后复位为 inactive
        self.assertEqual(h3d.get_director_progress(), {"active": False, "segment_index": -1, "total_segments": 0})

    def _run_single(self, seg, continuity=False):
        """用单个自定义段跑一次 generate；返回 (bodies, 错误文本)。"""
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 1},
                                               "segments": [seg]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: bodies.append(dict(body)) or {"prompt": body.get("prompt", "")}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: _FakeVideo(100, self.FPS, self.SR)
        err = None
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=continuity)
        except ValueError as e:
            err = str(e)
        finally:
            self._restore(orig)
        return bodies, err

    def test_fl2v_segment_sends_first_and_last_frame(self):
        # 首尾帧段：首帧进 references（模板 {{REF_IMAGE}}），尾帧进 body["last_frame"]（{{REF_IMAGE_LAST}}）
        bodies, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "fl2v",
                                        "ref_input": "ff.png", "last_input": "lf.png"})
        self.assertIsNone(err)
        self.assertEqual(bodies[0]["references"], [{"kind": "input", "value": "ff.png"}])
        self.assertEqual(bodies[0]["last_frame"], {"kind": "input", "value": "lf.png"})

    def test_fl2v_segment_without_last_frame_raises(self):
        _, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "fl2v",
                                   "ref_input": "ff.png"})
        self.assertIn("尾帧", err or "")

    def test_r2v_segment_attaches_refs_without_first_frame(self):
        # 全参考段：只挂参考素材即可，不需要首帧
        bodies, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "r2v",
                                        "ref_input": None,
                                        "refs": {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["s.wav"]}})
        self.assertIsNone(err)
        self.assertEqual([(r["value"], r.get("media")) for r in bodies[0]["references"]],
                         [("a.png", None), ("v.mp4", "video"), ("s.wav", "audio")])
        self.assertNotIn("last_frame", bodies[0])

    def test_r2v_segment_without_refs_raises(self):
        _, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "r2v"})
        self.assertIn("参考", err or "")

    def _r2v_template(self):
        """H3 r2v 形状的最小模板图（含可注入模型的 KSampler）。"""
        return {
            "1": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["3", 0], "vae": ["1", 0], "prompt": "p", "length": 124}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 0],
                "latent_image": ["5", 1]}},
        }

    def _run_r2v_chain(self, continuity=True, context_frames=22, frame_counts=(124, 141, 141), mode="r2v"):
        """三段配方跑一次（模板用 r2v 形状）；返回 ([(graph, overrides), ...], [各段 body], [各段 _FakeVideo], 输出 VIDEO)。

        第 1 段自带 a.png/b.png（身份来源）、第 2 段带 c.png、第 3 段带 a.png（用于验证身份去重）。
        """
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        calls, bodies = [], []
        videos = [_FakeVideo(n, self.FPS, self.SR) for n in frame_counts]
        it = iter(videos)
        own = (["a.png", "b.png"], ["c.png"], ["a.png"])
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": f"s{i}", "prompt": f"p{i}", "duration_sec": 5, "mode": mode,
                          "ref_input": "ff.png" if (mode == "i2v" and i == 0) else None,
                          "refs": {"images": own[i]}} for i in range(len(frame_counts))]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: bodies.append(dict(body)) or {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: (self._r2v_template(), [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: calls.append(
            (graph, kw.get("overrides"))) or next(it)
        try:
            (out,) = h3_video_director.NeoH3VideoDirector().generate(
                "r", continuity=continuity, context_frames=context_frames)
        finally:
            self._restore(orig)
        return calls, bodies, videos, out

    def test_context_window_chains_via_injected_nodes(self):
        """跨段上下文窗口：第 2/3 段注入「身份图 + 上段尾部 22 帧」，采样器改由注入链供模型与 conditioning。"""
        calls, _, videos, _ = self._run_r2v_chain()
        self.assertNotIn("NeoH3AddContext", [n.get("class_type") for n in calls[0][0].values()])
        graph, overrides = calls[1]
        nodes = sorted((int(nid), n) for nid, n in graph.items()
                       if n.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(nodes), 3)                       # a.png + b.png + 上下文窗口
        names = [graph[n["inputs"]["identity_image"][0]]["inputs"]["image"] for _, n in nodes[:2]]
        self.assertEqual(names, ["a.png", "b.png"])
        tail_id = nodes[2][1]["inputs"]["context_image"][0]
        self.assertTrue(torch.equal(overrides[tail_id][0], videos[0]._images[-22:]))
        self.assertEqual(graph["6"]["inputs"]["model"], [str(nodes[2][0]), 0])
        self.assertEqual(graph["6"]["inputs"]["positive"], [str(nodes[2][0]), 1])
        self.assertEqual(graph["6"]["inputs"]["negative"], [str(nodes[2][0]), 1])
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 1])
        self.assertEqual(nodes[2][1]["inputs"]["context_frames"], 22)
        # 第 3 段已自带 a.png → 只继承 b.png
        third = sorted((int(nid), n) for nid, n in calls[2][0].items()
                       if n.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(third), 2)
        self.assertEqual(calls[2][0][third[0][1]["inputs"]["identity_image"][0]]["inputs"]["image"], "b.png")

    def test_context_window_trims_head_frames_and_audio(self):
        """链入段丢掉头部 22 帧（重生成窗口），音频按同样帧数裁掉保 A/V 对齐。"""
        _, _, _, out = self._run_r2v_chain()
        comp = out.get_components()
        # 首段 124；后两段各生成 141（124+22=146 就近对齐）丢头部 22 → 交付 119
        self.assertEqual(comp.images.shape[0], 124 + 119 * 2)
        self.assertEqual(comp.audio["waveform"].shape[-1], (124 + 119 * 2) * self.SPF)

    def test_context_window_trims_tail_of_previous_segment(self):
        """窗口取的是上段「交付帧」的尾部 window 帧（拼接序列里紧邻新段的那一段）。"""
        calls, _, videos, out = self._run_r2v_chain()
        tail_id = next(nid for nid, n in calls[2][0].items()
                       if n.get("class_type") == "LoadImage" and n["inputs"]["image"] == "__neo_context_tail__")
        window = calls[2][1][tail_id][0]
        self.assertTrue(torch.equal(window, videos[1]._images[-22:]))
        # 第 1 段交付 124 帧、第 2 段交付 119 帧 → 总帧数对得上
        self.assertEqual(out.get_components().images.shape[0], 124 + 119 * 2)

    def test_context_window_off_inherits_identity_only(self):
        """context_frames=0：不注入窗口（不丢帧），但身份参考图仍继承（连续性总开关仍然开着）。"""
        calls, _, _, out = self._run_r2v_chain(context_frames=0, frame_counts=(124, 124, 124))
        self.assertEqual(out.get_components().images.shape[0], 124 * 3)
        for graph in (calls[1][0], calls[2][0]):
            nodes = [n for n in graph.values() if n.get("class_type") == "NeoH3AddContext"]
            self.assertTrue(nodes)
            self.assertTrue(all("context_image" not in n["inputs"] for n in nodes))

    def test_continuity_off_skips_injection_entirely(self):
        """continuity 关：既不注入窗口也不继承身份，各段完全独立。"""
        calls, _, _, out = self._run_r2v_chain(continuity=False, frame_counts=(124, 124, 124))
        for graph, overrides in calls:
            self.assertNotIn("NeoH3AddContext", [n.get("class_type") for n in graph.values()])
            self.assertIsNone(overrides)
        self.assertEqual(out.get_components().images.shape[0], 124 * 3)

    def test_i2v_chained_segment_anchors_on_window_first_frame(self):
        """i2v 段有上下文窗口时首帧取窗口第 0 帧（与窗口行同内容），不再用上段尾帧。"""
        _, bodies, videos, _ = self._run_r2v_chain(mode="i2v")
        self.assertEqual(bodies[0]["references"][0]["value"], "ff.png")   # 首段自带首帧
        tail = videos[0]._images[-22:]
        self.assertEqual(bodies[1]["references"][0]["data"],
                         h3_video_director._image_to_data_uri(tail[:1]))
        self.assertEqual(bodies[1]["references"][1]["value"], "c.png")    # 该段自己的素材照旧排在后面

    def test_i2v_tier_a_still_chains_prev_tail_as_first_frame(self):
        """context_frames=0 时 i2v 段仍是 Tier A：上段尾帧当首帧链入（data URI）。"""
        _, bodies, videos, _ = self._run_r2v_chain(mode="i2v", context_frames=0, frame_counts=(124, 124, 124))
        self.assertEqual(bodies[1]["references"][0]["data"],
                         h3_video_director._image_to_data_uri(videos[0]._images[-1:]))

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._require_vdn_plugin) = orig


class DirectorModelStepsTests(unittest.TestCase):
    """外部 MODEL / steps 入参：逐段注入模型 + 覆盖步数；无 model 时校验 VDN 插件。"""

    SR = 48000
    FPS = 24

    def _run(self, model=None, steps=-1, sink_present=True, width=-1, height=-1):
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._model_injection_node, h3d._require_vdn_plugin)
        resolve_calls = []
        exec_calls = []
        render_params = []
        vdn_checks = 0
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "t2v"},
                         {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "t2v"}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, skip_model=False):
            resolve_calls.append(skip_model)
            return dict(body)

        h3d.resolve_video_params = _fake_resolve

        def _fake_render(tpl, params):
            render_params.append(dict(params))
            return {"inj": 1, "u": 1}, []

        h3d.render_template = _fake_render

        def _fake_exec(graph, output_type="IMAGE", overrides=None):
            exec_calls.append(overrides)
            return _FakeVideo(100, self.FPS, self.SR)

        h3d.execute_graph_inprocess = _fake_exec
        if sink_present:
            h3d._model_injection_node = lambda graph: ("inj", {"u"})
        else:
            h3d._model_injection_node = lambda graph: (None, set())

        def _fake_vdn(graph):
            nonlocal vdn_checks
            vdn_checks += 1

        h3d._require_vdn_plugin = _fake_vdn
        err = None
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", model=model, steps=steps, width=width,
                                                            height=height, context_frames=0)
        except Exception as e:
            err = str(e)
        finally:
            self._restore(orig)
        return resolve_calls, exec_calls, render_params, vdn_checks, err

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._model_injection_node,
         h3_video_director._require_vdn_plugin) = orig

    def test_model_injected_per_segment_and_skips_model_resolve(self):
        resolve_calls, exec_calls, _, vdn_checks, err = self._run(model="M")
        self.assertIsNone(err)
        self.assertEqual(resolve_calls, [True, True])   # 每段跳过主模型解析
        self.assertEqual(vdn_checks, 0)                 # 有 model 时不校验 VDN 插件
        self.assertEqual(exec_calls, [{"inj": ["M"]}, {"inj": ["M"]}])

    def test_steps_override_applied_per_segment(self):
        _, _, render_params, _, err = self._run(model=None, steps=8)
        self.assertIsNone(err)
        self.assertTrue(all(p.get("steps") == 8 for p in render_params))

    def test_no_model_validates_vdn_plugin_and_keeps_internal_resolve(self):
        resolve_calls, exec_calls, _, vdn_checks, err = self._run(model=None)
        self.assertIsNone(err)
        self.assertEqual(resolve_calls, [False, False])  # 无 model 走内部模型解析
        self.assertEqual(vdn_checks, 2)                  # 每段校验一次 VDN 插件
        self.assertEqual(exec_calls, [None, None])       # 无覆盖

    def test_model_without_injection_point_raises(self):
        _, _, _, _, err = self._run(model="M", sink_present=False)
        self.assertIn("注入点", err or "")
    def test_width_height_default_omitted_from_body(self):
        # 节点 width/height=-1（默认）时不写入 body，交由 resolve_video_params 按各段 skill config 回退
        _, _, render_params, _, err = self._run()
        self.assertIsNone(err)
        for p in render_params:
            self.assertNotIn("width", p)
            self.assertNotIn("height", p)

    def test_width_height_override_applied_per_segment(self):
        # 节点 width/height>0 时覆盖全部段（忽略配方 shared.width/height）
        _, _, render_params, _, err = self._run(width=512, height=288)
        self.assertIsNone(err)
        self.assertTrue(all(p.get("width") == 512 and p.get("height") == 288 for p in render_params))



class DirectorBundleTests(unittest.TestCase):
    """BUNDLE 单段：NeoPromptAgent 的 BUNDLE（data URI 参考）作为单个片段生成，忽略 recipe。"""

    SR = 48000
    FPS = 24

    def _run(self, payload, seed=-1, width=-1, height=-1, model=None, steps=-1,
             valid_skills=("minimax_h3_t2v",)):
        h3d = h3_video_director
        orig = (h3d.get_bundle, h3d._gen_video_skills, h3d.load_director_spec,
                h3d._resolve_skill_id, h3d.load_skill_workflow, h3d.get_skill_gen_config,
                h3d.resolve_video_params, h3d.render_template, h3d.execute_graph_inprocess,
                h3d._model_injection_node, h3d._require_vdn_plugin)
        bodies = []
        recipe_calls = []

        h3d.get_bundle = lambda b: payload
        h3d._gen_video_skills = lambda: [{"id": s} for s in valid_skills]
        h3d.load_director_spec = lambda name: recipe_calls.append(name) or {"shared": {}, "segments": []}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, skip_model=False):
            bodies.append(dict(body))
            return dict(body)

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._model_injection_node = lambda graph: (None, set())
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", overrides=None: _FakeVideo(100, self.FPS, self.SR)

        err = None
        out = None
        try:
            (out,) = h3_video_director.NeoH3VideoDirector().generate(
                "ignored_recipe", seed=seed, width=width, height=height, model=model, steps=steps, bundle="B1")
        except Exception as e:
            err = str(e)
        finally:
            self._restore(orig)
        return out, bodies, recipe_calls, err

    def _restore(self, orig):
        (h3_video_director.get_bundle, h3_video_director._gen_video_skills,
         h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._model_injection_node,
         h3_video_director._require_vdn_plugin) = orig

    def test_bundle_single_segment_runs_and_ignores_recipe(self):
        payload = {"skill_id": "minimax_h3_t2v", "prompts": ["a cat walks"],
                   "references": [{"kind": "data", "data": "data:image/png;base64,AAA"}]}
        out, bodies, recipe_calls, err = self._run(payload)
        self.assertIsNone(err)
        self.assertEqual(recipe_calls, [])            # bundle 优先：recipe 不加载
        self.assertEqual(len(bodies), 1)              # 单段
        self.assertEqual(bodies[0]["prompt"], "a cat walks")
        # data URI 参考原样透传（不做文件名解析）
        self.assertEqual(bodies[0]["references"][0], {"kind": "data", "data": "data:image/png;base64,AAA"})
        self.assertIsNotNone(out.get_components())

    def test_bundle_seed_width_height_applied(self):
        payload = {"skill_id": "minimax_h3_t2v", "prompts": ["p"]}
        _, bodies, _, err = self._run(payload, seed=500, width=512, height=288)
        self.assertIsNone(err)
        self.assertEqual(bodies[0].get("seed"), 500)
        self.assertEqual((bodies[0].get("width"), bodies[0].get("height")), (512, 288))

    def test_bundle_default_seed_omitted(self):
        # seed/width/height=-1（默认）时不写入 body，交由 resolve_video_params 随机 / skill config 回退
        payload = {"skill_id": "minimax_h3_t2v", "prompts": ["p"]}
        _, bodies, _, err = self._run(payload)
        self.assertIsNone(err)
        self.assertNotIn("seed", bodies[0])
        self.assertNotIn("width", bodies[0])
        self.assertNotIn("height", bodies[0])

    def test_bundle_invalid_skill_raises(self):
        payload = {"skill_id": "not_a_video_skill", "prompts": ["p"]}
        _, bodies, _, err = self._run(payload)
        self.assertIn("skill 无效", err or "")
        self.assertEqual(bodies, [])                  # 未进入执行链

    def test_bundle_missing_prompt_raises(self):
        payload = {"skill_id": "minimax_h3_t2v"}      # 无 prompts
        _, bodies, _, err = self._run(payload)
        self.assertIn("提示词", err or "")
        self.assertEqual(bodies, [])

    def test_bundle_input_exposed_as_forceinput(self):
        # NeoPromptAgent BUNDLE 连线槽在 H3 视频节点上可见（forceInput，非 hidden）
        opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
        self.assertIn("bundle", opt)
        self.assertTrue(opt["bundle"][1].get("forceInput"))
        self.assertNotIn("hidden", opt["bundle"][1])


class DirectorSpecRouteTests(unittest.TestCase):
    """/rs_recipes/director_spec 请求解析与错误分支（load_director_spec 打桩）。"""

    def _req(self, name):
        return types.SimpleNamespace(rel_url=types.SimpleNamespace(query={"name": name}))

    def test_missing_name_returns_400(self):
        resp = _run_async(recipes.rs_recipes_director_spec(self._req("   ")))
        self.assertEqual(resp.status, 400)

    def test_returns_shared_and_segments(self):
        orig = recipes.load_director_spec
        recipes.load_director_spec = lambda name: {
            "shared": {"width": 8},
            "segments": [{"skill_id": "s", "prompt": "a", "duration_sec": 5, "ref_input": None}],
        }
        try:
            resp = _run_async(recipes.rs_recipes_director_spec(self._req("myrecipe")))
        finally:
            recipes.load_director_spec = orig
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertTrue(body["success"])
        self.assertEqual(body["name"], "myrecipe")
        self.assertEqual(len(body["segments"]), 1)
        self.assertIn("shared", body)

    def test_load_error_returns_500(self):
        orig = recipes.load_director_spec

        def _raise(name):
            raise ValueError("配方不存在")

        recipes.load_director_spec = _raise
        try:
            resp = _run_async(recipes.rs_recipes_director_spec(self._req("nope")))
        finally:
            recipes.load_director_spec = orig
        self.assertEqual(resp.status, 500)


class DirectorDefaultDimsTests(unittest.TestCase):
    """recipes._director_default_dims：取首段 skill config 的 width/height/steps，供节点 widget 动态填充。"""

    def _patch(self, cfg_by_id):
        skill_mod = sys.modules[f"{_PKG}.skill"]
        h3v_mod = sys.modules[f"{_PKG}.h3_video_gen"]
        orig = (skill_mod.get_skill_gen_config, h3v_mod._resolve_skill_id)
        skill_mod.get_skill_gen_config = lambda sid: cfg_by_id.get(sid, {})
        h3v_mod._resolve_skill_id = lambda v: v
        return (skill_mod, h3v_mod, orig)

    def _restore(self, ctx):
        skill_mod, h3v_mod, (orig_cfg, orig_res) = ctx
        skill_mod.get_skill_gen_config = orig_cfg
        h3v_mod._resolve_skill_id = orig_res

    def test_first_segment_skill_config_used(self):
        ctx = self._patch({"s1": {"width": 960, "height": 544, "steps": 8}})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}, {"skill_id": "s2"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 960, "height": 544, "steps": 8})

    def test_skips_segments_without_skill_id(self):
        ctx = self._patch({"s2": {"width": 512, "height": 288, "steps": 4}})
        try:
            d = recipes._director_default_dims([{"skill_id": ""}, {"skill_id": "s2"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 512, "height": 288, "steps": 4})

    def test_falls_back_to_h3_defaults_when_no_config(self):
        ctx = self._patch({})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 1344, "height": 768, "steps": 20})

    def test_empty_segments_returns_h3_defaults(self):
        d = recipes._director_default_dims([])
        self.assertEqual(d, {"width": 1344, "height": 768, "steps": 20})


class DirectorProgressRouteTests(unittest.TestCase):
    """/neo_video_gen/director_progress 返回当前 director 运行进度快照。"""

    def test_returns_current_state(self):
        h3d = h3_video_director
        orig = dict(h3d._DIRECTOR_PROGRESS)
        try:
            h3d._DIRECTOR_PROGRESS.update(active=True, segment_index=1, total_segments=4)
            resp = _run_async(h3d.neo_video_gen_director_progress(None))
        finally:
            h3d._DIRECTOR_PROGRESS.clear()
            h3d._DIRECTOR_PROGRESS.update(orig)
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertEqual(body, {"active": True, "segment_index": 1, "total_segments": 4})


class H3PreviewTests(unittest.TestCase):
    """h3_preview：taeh3 解码器重建、潜空间抽帧、每步多帧载荷推送与接管/还原、节点开关语义。"""

    def setUp(self):
        self.h3p = sys.modules[f"{_PKG}.h3_preview"]
        self.lp = sys.modules["latent_preview"]
        self.original = self.lp.get_previewer
        self.sent = []   # 后端每步推的预览载荷都会记到这里
        self.server = self.h3p.PromptServer.instance
        self.orig_send = self.server.send_sync
        self.server.send_sync = lambda event, data, sid=None: self.sent.append((event, data, sid))

    def tearDown(self):
        self.lp.get_previewer = self.original
        self.server.send_sync = self.orig_send

    def _vae(self):
        return self.h3p.H3TinyVAE({"1.weight": torch.zeros(8, 24, 3, 3), "1.bias": torch.zeros(8),
                                   "4.weight": torch.zeros(3, 8, 3, 3), "4.bias": torch.zeros(3)})

    def test_build_decoder_maps_flat_indices(self):
        # 缺号：0→Clamp、2→ReLU；conv.* → Block；裸 weight → conv（按有无 bias 定）
        sd = {
            "1.weight": torch.zeros(8, 4, 3, 3), "1.bias": torch.zeros(8),
            "3.conv.0.weight": torch.zeros(8, 8, 3, 3), "3.conv.0.bias": torch.zeros(8),
            "3.conv.2.weight": torch.zeros(8, 8, 3, 3), "3.conv.2.bias": torch.zeros(8),
            "3.conv.4.weight": torch.zeros(8, 8, 3, 3), "3.conv.4.bias": torch.zeros(8),
            "4.weight": torch.zeros(8, 8, 3, 3),
            "5.weight": torch.zeros(3, 8, 3, 3), "5.bias": torch.zeros(3),
        }
        model = self.h3p._build_decoder(sd)
        self.assertEqual([type(m).__name__ for m in model],
                         ["_StubClamp", "Conv2d", "ReLU", "_StubBlock", "Conv2d", "Conv2d"])
        self.assertEqual((model[3].n_in, model[3].n_out), (8, 8))
        self.assertIsNone(model[4].bias)          # 索引 4 无 bias → conv(bias=False)
        self.assertIsNotNone(model[5].bias)

    def test_build_decoder_fills_other_gaps_with_upsample(self):
        sd = {"1.weight": torch.zeros(4, 4, 3, 3), "1.bias": torch.zeros(4),
              "4.weight": torch.zeros(4, 4, 3, 3)}
        model = self.h3p._build_decoder(sd)
        self.assertEqual([type(m).__name__ for m in model],
                         ["_StubClamp", "Conv2d", "ReLU", "Upsample", "Conv2d"])

    def test_build_decoder_rejects_non_flat_state_dict(self):
        with self.assertRaises(ValueError):
            self.h3p._build_decoder({"decoder.1.weight": torch.zeros(4, 4, 3, 3)})

    def test_tiny_vae_reads_channels_and_decodes_frame(self):
        vae = self._vae()
        self.assertEqual(vae.latent_channels, 24)
        img = vae.decode_frame(torch.randn(1, 24, 4, 6))
        self.assertEqual((img.mode, img.size), ("RGB", (12, 8)))   # 缺号里的 Upsample 使边长翻倍

    def test_frame_indices_spread_across_time_axis(self):
        self.assertEqual(self.h3p._frame_indices(5, 8), [0, 1, 2, 3, 4])           # 帧数不足 → 全取
        self.assertEqual(self.h3p._frame_indices(8, 8), list(range(8)))
        self.assertEqual(self.h3p._frame_indices(120, 8), [0, 17, 34, 51, 68, 85, 102, 119])   # 首尾都取到
        self.assertEqual(self.h3p._frame_indices(120, 1), [0])

    def test_frame_indices_are_unique_for_odd_lengths(self):
        self.assertEqual(len(set(self.h3p._frame_indices(37, 8))), 8)

    def test_video_frames_picks_evenly_spaced_frames(self):
        frames = self.h3p._video_frames(torch.randn(1, 24, 6, 5, 7), 24, 3)
        self.assertEqual([tuple(f.shape) for f in frames], [(1, 24, 5, 7)] * 3)

    def test_video_frames_single_frame_input(self):
        frames = self.h3p._video_frames(torch.randn(1, 24, 5, 7), 24, 8)
        self.assertEqual([tuple(f.shape) for f in frames], [(1, 24, 5, 7)])

    def test_video_frames_returns_none_without_matching_stream(self):
        self.assertIsNone(self.h3p._video_frames(torch.randn(1, 32, 2, 5, 7), 24, 8))   # 音频流
        self.assertIsNone(self.h3p._video_frames(torch.randn(1, 24), 24, 8))

    def test_preview_payload_encodes_jpeg_frames(self):
        payload = self.h3p._preview_payload([Image.new("RGB", (600, 1200), (20, 40, 60)) for _ in range(2)])
        self.assertEqual(payload["fps"], self.h3p.PREVIEW_FPS)
        self.assertEqual((payload["w"], payload["h"]), (256, 512))   # 等比缩到最长边 PREVIEW_SIDE
        self.assertEqual(len(payload["frames"]), 2)
        for frame in payload["frames"]:
            self.assertTrue(frame.startswith(self.h3p.JPEG_DATA_URL))   # 前端直接塞 <img>.src，必须是 data URL
            raw = base64.b64decode(frame[len(self.h3p.JPEG_DATA_URL):])
            self.assertEqual(raw[:3], b"\xff\xd8\xff")   # JPEG 魔数
            with Image.open(io.BytesIO(raw)) as im:
                self.assertEqual(im.size, (256, 512))
                for got, want in zip(im.convert("RGB").getpixel((128, 256)), (20, 40, 60)):
                    self.assertLessEqual(abs(got - want), 3)   # 画面内容存活，没被压成黑

    def test_preview_off_suppresses_and_restores(self):
        with self.h3p.preview_override(False, None):
            self.assertIsNot(self.lp.get_previewer, self.original)
            self.assertIsNone(self.lp.get_previewer(None, _StubMiniMaxH3Video()))
        self.assertIs(self.lp.get_previewer, self.original)

    def test_preview_on_uses_taeh3_and_restores(self):
        with self.h3p.preview_override(True, self._vae(), "9"):
            prev = self.lp.get_previewer(None, _StubMiniMaxH3Video())
        self.assertIs(self.lp.get_previewer, self.original)
        self.assertIsInstance(prev, self.h3p.H3Previewer)
        self.assertEqual(prev.node_id, "9")
        prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 3, 4, 6))
        self.assertEqual(self.sent[0][1]["node_id"], "9")

    def test_preview_on_without_taeh3_falls_back_to_latent2rgb(self):
        with self.h3p.preview_override(True, None):
            prev = self.lp.get_previewer(None, _StubMiniMaxH3Video())
        self.assertIsInstance(prev, _StubLatent2RGBPreviewer)

    def test_preview_leaves_other_latent_formats_to_the_original(self):
        sentinel = object()
        self.lp.get_previewer = lambda device, latent_format: sentinel
        with self.h3p.preview_override(False, None):
            self.assertIs(self.lp.get_previewer(None, object()), sentinel)

    def test_preview_restores_on_exception(self):
        with self.assertRaises(RuntimeError):
            with self.h3p.preview_override(True, None):
                raise RuntimeError("boom")
        self.assertIs(self.lp.get_previewer, self.original)

    def test_previewer_pushes_frames_and_suppresses_core_image(self):
        """核心一步只出一张静图的通道返回 None（进度条照常推进），多帧载荷改走自有事件。"""
        prev = self.h3p.H3Previewer(self._vae(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 8, 4, 6)))
        self.assertEqual(len(self.sent), 1)
        event, data, sid = self.sent[0]
        self.assertEqual(event, self.h3p.PREVIEW_EVENT)
        self.assertEqual(data["node_id"], "7")
        self.assertEqual(len(data["frames"]), self.h3p.PREVIEW_FRAMES)   # 每步抽 PREVIEW_FRAMES 帧
        self.assertEqual((data["w"], data["h"]), (12, 8))
        self.assertIsNone(sid)   # 推给发起本次执行的客户端（client_id 为 None 即广播）

    def test_previewer_without_node_id_skips_send(self):
        prev = self.h3p.H3Previewer(self._vae())
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 4, 4, 6)))
        self.assertEqual(self.sent, [])

    def test_previewer_skips_non_video_shapes(self):
        prev = self.h3p.H3Previewer(self._vae(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 32, 2, 5, 7)))
        self.assertEqual(self.sent, [])

    def test_previewer_keeps_sampling_alive_when_decode_fails(self):
        class _Bad:
            latent_channels = 24

            def decode_frame(self, frame):
                raise RuntimeError("boom")

        prev = self.h3p.H3Previewer(_Bad(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 2, 4, 6)))
        self.assertEqual(self.sent, [])

    def test_load_returns_none_without_taeh3_file(self):
        self.assertIsNone(self.h3p.load_h3_tiny_vae())

    def test_input_types_exposes_preview_toggle(self):
        types = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()
        self.assertIs(types["optional"]["preview"][1]["default"], True)
        self.assertEqual(types["hidden"]["unique_id"], "UNIQUE_ID")   # 预览载荷靠它路由回节点

    def test_generate_loads_decoder_only_when_preview_is_on(self):
        h3d = h3_video_director
        names = ("load_director_spec", "_resolve_skill_id", "load_skill_workflow", "get_skill_gen_config",
                 "resolve_video_params", "render_template", "execute_graph_inprocess",
                 "_require_vdn_plugin", "load_h3_tiny_vae", "preview_override")
        orig = tuple(getattr(h3d, n) for n in names)
        seen, loads = [], []

        @contextlib.contextmanager
        def _rec(enabled, vae, node_id=None):
            seen.append((enabled, vae, node_id))
            yield

        try:
            h3d.load_director_spec = lambda n: {"shared": {}, "segments": [
                {"skill_id": "s", "prompt": "p", "duration_sec": 5}]}
            h3d._resolve_skill_id = lambda v: v
            h3d.load_skill_workflow = lambda i: {"1": {}}
            h3d.get_skill_gen_config = lambda i: {}
            h3d.resolve_video_params = lambda body, cfg, skip_model=False: dict(body)
            h3d.render_template = lambda tpl, params: ({"1": {}}, [])
            h3d.execute_graph_inprocess = lambda graph, output_type="VIDEO", overrides=None: _FakeVideo(4)
            h3d._require_vdn_plugin = lambda graph: None
            h3d.load_h3_tiny_vae = lambda: (loads.append(1), "VAE")[1]
            h3d.preview_override = _rec
            node = h3d.NeoH3VideoDirector()
            node.generate("r", unique_id="12")                  # 默认开：段执行期间用 taeh3
            node.generate("r", preview=False, unique_id="12")   # 关：不加载解码器，段内完全不出预览
        finally:
            for n, v in zip(names, orig):
                setattr(h3d, n, v)
        self.assertEqual(seen, [(True, "VAE", "12"), (False, None, "12")])
        self.assertEqual(len(loads), 1)


class _FakeModelPatcher:
    """ModelPatcher 桩：只实现 clone + 命名空间 wrapper 增删。"""

    def __init__(self, wrappers=None):
        self.clones = 0
        self.wrappers = wrappers or {}

    def clone(self):
        self.clones += 1
        copied = {k: {k1: list(v1) for k1, v1 in v.items()} for k, v in self.wrappers.items()}
        return _FakeModelPatcher(copied)

    def remove_wrappers_with_key(self, wrapper_type, key):
        self.wrappers.get(wrapper_type, {}).pop(key, None)

    def add_wrapper_with_key(self, wrapper_type, key, wrapper):
        self.wrappers.setdefault(wrapper_type, {}).setdefault(key, []).append(wrapper)


class _KwargsExecutor:
    """APPLY_MODEL executor 桩：记录本次调用拿到的 kwargs，并把 payload 交回调用方。"""

    def __init__(self):
        self.kwargs = None

    def __call__(self, *args, **kwargs):
        self.kwargs = kwargs
        return kwargs.get("minimax_payload")


class _StubVae:
    def __init__(self):
        self.seen = None

    def encode(self, image):
        self.seen = image
        return torch.zeros(1, 16, 2, 2, 2)


class _StubH3Vae:
    """H3 视频 VAE 桩：latent 时间步按模型的 17k+5 网格（22 帧 → 7 步，单图 → 1 步）。"""

    def __init__(self):
        self.seen = []

    def encode(self, frames):
        self.seen.append(frames)
        n = int(frames.shape[0])
        latent_t = 1 if n < 5 else 2 + 5 * ((n - 5) // 17)
        return torch.zeros(1, 24, latent_t, frames.shape[1] // 16, frames.shape[2] // 16)


class _StubNode:
    """mini-executor 用的极简节点桩：INPUT_TYPES 无必填项，run 从类属性取预设值。"""

    RETURN_TYPES = ()
    FUNCTION = "run"
    value = None

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def run(self, **kwargs):
        return (self.value,)


class _StubVaeLoader(_StubNode):
    RETURN_TYPES = ("VAE",)


class _StubUnetLoader(_StubNode):
    RETURN_TYPES = ("MODEL",)


class _StubImageLoader(_StubNode):
    RETURN_TYPES = ("IMAGE",)


class _StubR2V(_StubNode):
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    ref_latent = None

    def run(self, **kwargs):
        return ([["tok", {"minimax_refs": [{"latent": self.ref_latent}]}]], {"samples": torch.zeros(1)})


class _StubSampler(_StubNode):
    RETURN_TYPES = ("LATENT",)
    seen = None

    def run(self, model=None, positive=None, negative=None, latent_image=None, **kwargs):
        _StubSampler.seen = {"model": model, "positive": positive, "negative": negative}
        return ({"samples": torch.zeros(1)},)


class _StubCreateVideo(_StubNode):
    RETURN_TYPES = ("VIDEO",)

    def run(self, **kwargs):
        return ("VIDEO-OUT",)


class HybridKeyframeTests(unittest.TestCase):
    """P2 Hybrid：r2v 段注入首帧 keyframe 锚点 + cond 合并 wrapper 的单元测试。"""

    def setUp(self):
        # 各测试模块都会重写 comfy.patcher_extension 桩（后导入者生效），这里确保 APPLY_MODEL 可用
        wrappers = sys.modules["comfy.patcher_extension"].WrappersMP
        if not hasattr(wrappers, "APPLY_MODEL"):
            wrappers.APPLY_MODEL = "APPLY_MODEL"

    def _r2v_graph(self):
        return {
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "x.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["2", 0], "vae": ["3", 0], "prompt": "test",
                "width": 1344, "height": 768, "length": 124,
            }},
            "7": {"class_type": "KSampler", "inputs": {
                "model": ["6", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "simple",
                "positive": ["5", 0], "negative": ["5", 0], "latent_image": ["5", 1],
                "denoise": 1.0,
            }},
        }

    def test_align_frame_count(self):
        self.assertEqual(h3_video_director._align_frame_count(5), 5)
        self.assertEqual(h3_video_director._align_frame_count(124), 124)
        self.assertEqual(h3_video_director._align_frame_count(6), 22)
        self.assertEqual(h3_video_director._align_frame_count(3), 5)
        self.assertEqual(h3_video_director._align_frame_count(125), 141)

    def test_inject_continuity_nodes_chains_identity_then_context(self):
        """r2v 模板图注入后：身份参考图各一个节点、上下文窗口用虚拟 LoadImage，采样器改指注入链末端。"""
        tail = torch.zeros(22, 768, 1344, 3)
        modified, overrides = h3_video_director._inject_continuity_nodes(
            self._r2v_graph(), tail, 22, ["a.png", "b.png"])
        nodes = sorted((int(nid), node) for nid, node in modified.items()
                       if node.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(nodes), 3)                                     # 2 张身份图 + 1 个上下文窗口
        self.assertEqual(nodes[0][1]["inputs"]["model"], ["6", 0])           # 第一棒接采样器原 model 源
        self.assertEqual(nodes[0][1]["inputs"]["conditioning"], ["5", 0])
        self.assertEqual(nodes[0][1]["inputs"]["vae"], ["3", 0])
        self.assertEqual(nodes[0][1]["inputs"]["width"], 1344)
        self.assertEqual(nodes[0][1]["inputs"]["height"], 768)
        self.assertEqual([modified[n["inputs"]["identity_image"][0]]["inputs"]["image"] for _, n in nodes[:2]],
                         ["a.png", "b.png"])
        self.assertNotIn("context_image", nodes[0][1]["inputs"])
        self.assertEqual(nodes[1][1]["inputs"]["model"], [str(nodes[0][0]), 0])   # 链式接棒
        self.assertEqual(nodes[1][1]["inputs"]["conditioning"], [str(nodes[0][0]), 1])
        tail_id = nodes[2][1]["inputs"]["context_image"][0]
        self.assertEqual(modified[tail_id]["inputs"]["image"], "__neo_context_tail__")
        self.assertEqual(nodes[2][1]["inputs"]["context_frames"], 22)
        self.assertIs(overrides[tail_id][0], tail)
        last = str(nodes[2][0])
        self.assertEqual(modified["7"]["inputs"]["model"], [last, 0])
        self.assertEqual(modified["7"]["inputs"]["positive"], [last, 1])
        self.assertEqual(modified["7"]["inputs"]["negative"], [last, 1])
        self.assertEqual(modified["7"]["inputs"]["latent_image"], ["5", 1])
        # 注入节点占独立 id 段，模板原有节点一个不少
        injected = {str(nid) for nid, _ in nodes} | {n["inputs"]["identity_image"][0] for _, n in nodes[:2]} | {tail_id}
        self.assertEqual(injected, {"9000", "9001", "9002", "9003", "9004", "9005"})
        self.assertEqual(set(modified) - injected, {"3", "5", "7"})

    def test_inject_continuity_nodes_skips_without_window_and_identity(self):
        """没有上下文窗口也没有身份图时不注入（返回 None，调用方保持原 overrides）。"""
        graph = self._r2v_graph()
        modified, overrides = h3_video_director._inject_continuity_nodes(graph, None, 0)
        self.assertIsNone(overrides)
        self.assertEqual(set(modified), {"3", "5", "7"})

    def test_inject_continuity_nodes_needs_h3_sampler(self):
        """模板里没有消费 H3 conditioning 的采样器 → 明确报错，而不是静默丢掉连续性。"""
        graph = {
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "x"}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["4", 0], "negative": ["4", 0], "latent_image": ["4", 1]}},
        }
        img = torch.zeros(22, 768, 1344, 3)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._inject_continuity_nodes(graph, img, 22)
        self.assertIn("跨段连续性", str(ctx.exception))

    def test_inject_continuity_nodes_without_model_source_raises(self):
        """采样器没有 model 引用时挂不上连续性 wrapper → 报错。"""
        graph = self._r2v_graph()
        del graph["7"]["inputs"]["model"]
        img = torch.zeros(22, 768, 1344, 3)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._inject_continuity_nodes(graph, img, 22)
        self.assertIn("model 来源", str(ctx.exception))

    def test_inject_continuity_nodes_avoids_template_id_collision(self):
        """模板已占用 9000 时注入节点顺延取号，不覆盖模板节点。"""
        graph = self._r2v_graph()
        graph["9000"] = {"class_type": "LoadImage", "inputs": {"image": "keep.png"}}
        modified, overrides = h3_video_director._inject_continuity_nodes(
            graph, torch.zeros(22, 768, 1344, 3), 22)
        ids = sorted(int(nid) for nid in modified if int(nid) >= 9000)
        self.assertEqual(ids, [9000, 9001, 9002])
        self.assertEqual(modified["9000"]["inputs"]["image"], "keep.png")
        self.assertEqual(modified["9002"]["inputs"]["context_image"], ["9001", 0])
        self.assertIn("9001", overrides)

    def test_merge_cond_latents_puts_keyframes_first(self):
        """锚点在前、参考在后（与 PackedLayout 的 cond/ref row 顺序一致）。"""
        kf = {"latent": torch.ones(1, 16, 2, 2, 2), "audio_latent": torch.ones(1, 2, 7)}
        ref = {"latent": torch.zeros(1, 16, 2, 2, 2), "audio_latent": torch.zeros(1, 2, 7)}
        payload = {"keyframes": [kf], "refs": [ref]}
        h3_video_director._merge_cond_latents(payload)
        self.assertEqual(len(payload["cond_video_latents"]), 2)
        self.assertIs(payload["cond_video_latents"][0], kf["latent"])
        self.assertIs(payload["cond_video_latents"][1], ref["latent"])
        self.assertIs(payload["cond_audio_latents"][0], kf["audio_latent"])
        self.assertIs(payload["cond_audio_latents"][1], ref["audio_latent"])

    def test_continuity_wrapper_fixes_payload_for_model_call(self):
        """core 会把 keyframe 的 cond 换成 refs，wrapper 需在模型调用前合回一条列表。"""
        kf = {"resolved_frame_index": 0, "latent": torch.ones(1, 16, 2, 2, 2)}
        ref = {"latent": torch.zeros(1, 16, 2, 2, 2)}
        payload = {"keyframes": [kf], "refs": [ref], "cond_video_latents": [ref["latent"]]}
        exec_ = _KwargsExecutor()
        out = h3_video_director._continuity_wrapper(exec_, torch.zeros(1), minimax_payload=payload)
        merged = exec_.kwargs["minimax_payload"]
        self.assertEqual(len(merged["cond_video_latents"]), 2)
        self.assertIs(merged["cond_video_latents"][0], kf["latent"])
        self.assertIs(merged["cond_video_latents"][1], ref["latent"])
        self.assertIs(out, merged)
        self.assertIsNot(merged, payload)                       # 不改调用方的 payload
        self.assertEqual(payload["cond_video_latents"], [ref["latent"]])

    def test_continuity_wrapper_passes_through_without_refs(self):
        """只有 keyframes（或 payload 不是 dict）时原样透传。"""
        payload = {"keyframes": [{"latent": torch.ones(1)}], "cond_video_latents": []}
        exec_ = _KwargsExecutor()
        out = h3_video_director._continuity_wrapper(exec_, torch.zeros(1), minimax_payload=payload)
        self.assertIs(out, payload)
        self.assertIsNone(h3_video_director._continuity_wrapper(
            _KwargsExecutor(), torch.zeros(1), minimax_payload=None))

    def test_install_continuity_clones_and_replaces_wrapper(self):
        """安装到 clone 上、同一 key 只留一份（在已安装的 patcher 上重复安装不会叠加）。"""
        key = h3_video_director._CONTINUITY_WRAPPER_KEY
        model = _FakeModelPatcher()
        patched = h3_video_director._install_continuity(model)
        self.assertEqual(model.clones, 1)
        self.assertEqual(patched.wrappers["APPLY_MODEL"][key], [h3_video_director._continuity_wrapper])
        self.assertEqual(model.wrappers, {})                    # 原 model 不被改动
        again = h3_video_director._install_continuity(patched)
        self.assertEqual(len(again.wrappers["APPLY_MODEL"][key]), 1)

    def test_add_keyframe_returns_patched_model_and_keyframe_cond(self):
        """节点：写 keyframe 元数据 + 返回挂了合并 wrapper 的 MODEL，参考元数据原样保留。"""
        vae = _StubVae()
        refs = [{"latent": torch.zeros(1, 16, 2, 2, 2)}]
        cond = [["tokens", {"minimax_refs": refs}]]
        model = _FakeModelPatcher()
        patched, out = h3_video_director.NeoH3AddKeyframe().add_keyframe(
            model, cond, vae, torch.zeros(2, 64, 64, 3), 124)
        self.assertEqual(vae.seen.shape[0], 1)                  # 只用第一张图
        self.assertEqual(model.clones, 1)                       # 在原 model 上 clone 一份再挂 wrapper
        self.assertEqual(patched.wrappers["APPLY_MODEL"].keys(), {h3_video_director._CONTINUITY_WRAPPER_KEY})
        meta = out[0][1]
        self.assertIs(meta["minimax_refs"], refs)
        self.assertEqual(meta["minimax_frame_count"], 124)
        self.assertEqual([(k["resolved_frame_index"], tuple(k["latent"].shape))
                          for k in meta["minimax_keyframes"]], [(0, (1, 16, 2, 2, 2))])


    def test_inject_continuity_nodes_on_real_presets(self):
        """真实数据：四种预设模板（i2v/t2v/r2v + VDN 变体）都能定位注入点，模板节点一个不少。"""
        tail = torch.zeros(22, 768, 1344, 3)
        for preset in ("minimax-h3-r2v", "minimax-h3-vdn-r2v", "minimax_h3_i2v", "minimax_h3_t2v"):
            with open(os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json"),
                      encoding="utf-8") as f:
                graph = json.load(f)
            template_ids = set(graph)
            cond_id = next(nid for nid, n in graph.items()
                           if n.get("class_type") in ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"))
            sampler_id = next(nid for nid, n in graph.items() if n.get("class_type") == "KSampler")
            model_src = list(graph[sampler_id]["inputs"]["model"])
            cond_vae = list(graph[cond_id]["inputs"]["vae"])
            modified, overrides = h3_video_director._inject_continuity_nodes(graph, tail, 22, ["a.png"])
            nodes = sorted((int(nid), n) for nid, n in modified.items()
                           if n.get("class_type") == "NeoH3AddContext")
            self.assertEqual(len(nodes), 2, preset)
            self.assertEqual(nodes[0][1]["inputs"]["model"], model_src, preset)
            self.assertEqual(nodes[0][1]["inputs"]["conditioning"], [cond_id, 0], preset)
            self.assertEqual(nodes[0][1]["inputs"]["vae"], cond_vae, preset)
            last = str(nodes[1][0])
            self.assertEqual(modified[sampler_id]["inputs"]["model"], [last, 0], preset)
            self.assertEqual(modified[sampler_id]["inputs"]["positive"], [last, 1], preset)
            if graph[sampler_id]["inputs"]["negative"][0] == cond_id:
                self.assertEqual(modified[sampler_id]["inputs"]["negative"], [last, 1], preset)
            injected = {str(nid) for nid, _ in nodes} | set(overrides)
            for _, node in nodes:
                for name in ("identity_image", "context_image"):
                    if name in node["inputs"]:
                        injected.add(node["inputs"][name][0])
            self.assertEqual(set(modified) - injected, template_ids, preset)

    def test_continuity_injection_executes_end_to_end(self):
        """整链路：注入后的图经 mini-executor 执行，采样器拿到挂过连续性 wrapper 的模型 + 带上下文窗口的 conditioning。"""
        key = h3_video_director._CONTINUITY_WRAPPER_KEY
        vae, model = _StubH3Vae(), _FakeModelPatcher()
        _StubVaeLoader.value = vae
        _StubUnetLoader.value = model
        _StubImageLoader.value = torch.zeros(1, 768, 1344, 3)
        _StubR2V.ref_latent = torch.zeros(1, 16, 2, 2, 2)
        _StubSampler.seen = None
        registry = {
            "VAELoader": _StubVaeLoader, "UNETLoader": _StubUnetLoader, "LoadImage": _StubImageLoader,
            "MiniMaxH3ReferenceToVideo": _StubR2V, "KSampler": _StubSampler,
            "CreateVideo": _StubCreateVideo, "NeoH3AddContext": h3_video_director.NeoH3AddContext,
        }
        krea2_generate.comfy_nodes.NODE_CLASS_MAPPINGS.update(registry)
        graph = {
            "1": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "vae": ["1", 0], "prompt": "p", "width": 1344, "height": 768}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 0],
                "latent_image": ["5", 1]}},
            "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 24}},
        }
        tail = torch.zeros(22, 768, 1344, 3)
        try:
            graph, overrides = h3_video_director._inject_continuity_nodes(graph, tail, 22, ["a.png"])
            out = krea2_generate.execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)
        finally:
            for name in registry:
                krea2_generate.comfy_nodes.NODE_CLASS_MAPPINGS.pop(name, None)
        self.assertEqual(out, "VIDEO-OUT")
        seen = _StubSampler.seen
        self.assertEqual(model.clones, 1)                        # 注入链上每个节点都在上一棒上 clone 一份
        self.assertIsNot(seen["model"], model)
        self.assertEqual(seen["model"].wrappers["APPLY_MODEL"].keys(), {key})
        identity, context = vae.seen                              # 先身份图、后上下文窗口
        self.assertEqual(tuple(identity.shape), (1, 768, 1344, 3))
        self.assertEqual(tuple(context.shape), (22, 768, 1344, 3))
        for key_ in ("positive", "negative"):                    # positive/negative 都拿到注入了上下文窗口的 conditioning
            refs = seen[key_][0][1]["minimax_refs"]
            self.assertEqual([r.get("kind") for r in refs], [None, "image", "video"])
            window = refs[2]
            self.assertEqual(window["latent_t"], 7)              # 22 帧 → 7 个 latent 步
            self.assertEqual(window[h3_video_director._CONTEXT_FRAMES_MARK], 22)
            self.assertEqual(window["ref_audio_t"], 0)
            self.assertEqual(tuple(window["latent"].shape), (1, 24, 7, 48, 84))
            self.assertEqual(seen[key_][0][1]["minimax_refs"][1]["latent_h"], 48)


class _FakeLayout:
    """PackedLayout 桩：只保留我们用到的契约（segments / signature / position_ids），构建顺序与 core 一致。"""

    def __init__(self, text_len=3, latent_t=7, frame_rows=2, refs=(), keyframes=0):
        self.signature = (text_len, latent_t, frame_rows, 2, 1)
        segments, times = [], []
        row = 0

        def add(kind, n, first_t):
            nonlocal row
            segments.append((row, row + n, kind))
            times.extend((first_t + i, 0.0, 0.0) for i in range(n))
            row += n

        add("text", text_len, 0.0)
        cursor = float(text_len)          # 与 core 一致：cond / ref 行的 t 都从 text_len 起算
        for _ in range(keyframes):
            add("cond", frame_rows, cursor)
        for ref in refs:
            if int(ref.get("ref_audio_t") or 0) > 0:
                add("ref_audio", int(ref["ref_audio_t"]) * 2, cursor)
            n = frame_rows if ref["kind"] == "image" else int(ref["latent_t"]) * frame_rows
            add("ref_img", n, cursor)
            cursor += 1.0 if ref["kind"] == "image" else max(int(ref["latent_t"]) * 1.5, 1.0)
        add("audio", 2, cursor)
        add("video", latent_t * frame_rows, cursor)
        self.segments = segments
        self.position_ids = torch.tensor(times, dtype=torch.float64)


class ContextWindowTests(unittest.TestCase):
    """跨段上下文窗口：窗口帧数/步数、参考块构造、时间轴对齐。"""

    def setUp(self):
        # 各测试模块都会重写 comfy.patcher_extension 桩（后导入者生效），这里确保 APPLY_MODEL 可用
        wrappers = sys.modules["comfy.patcher_extension"].WrappersMP
        if not hasattr(wrappers, "APPLY_MODEL"):
            wrappers.APPLY_MODEL = "APPLY_MODEL"

    def test_align_context_frames_snaps_to_grid(self):
        h3d = h3_video_director
        self.assertEqual([h3d._align_context_frames(n) for n in (5, 22, 39, 20, 10, 0)],
                         [5, 22, 39, 22, 5, 5])

    def test_context_latent_t_matches_h3_grid(self):
        h3d = h3_video_director
        self.assertEqual([h3d._context_latent_t(n) for n in (5, 22, 39)], [2, 7, 12])

    def test_align_frame_count_nearest_keeps_window_sized_total(self):
        h3d = h3_video_director
        # 124 帧段 + 22 帧窗口 = 146 → 就近取 141（交付 119），不是向上取 158
        self.assertEqual(h3d._align_frame_count_nearest(146, minimum=27), 141)
        # 124 帧段 + 5 帧窗口 = 129 → 124（交付 119）
        self.assertEqual(h3d._align_frame_count_nearest(129, minimum=10), 124)
        # 低于下限时落到不低于下限的最近网格点（22 帧窗口的下限 27 → 39）
        self.assertEqual(h3d._align_frame_count_nearest(10, minimum=27), 39)
        # 不带窗口时与原有向上对齐一致
        self.assertEqual(h3d._align_frame_count_nearest(124), 124)

    def _node(self, context_frames=22, identity=None):
        """跑一次 NeoH3AddContext（已有 1 条参考），返回 (patched_model, cond, vae, 原 model)。"""
        vae = _StubH3Vae()
        model = _FakeModelPatcher()
        refs = [{"kind": "image", "latent": torch.zeros(1, 16, 2, 2, 2)}]
        cond = [["tokens", {"minimax_refs": refs}]]
        patched, out = h3_video_director.NeoH3AddContext().add_context(
            model, cond, vae, 1344, 768, context_image=torch.zeros(context_frames, 768, 1344, 3),
            identity_image=identity, context_frames=context_frames)
        return patched, out, vae, model

    def test_context_node_appends_video_ref_to_existing_refs(self):
        patched, out, vae, model = self._node()
        self.assertEqual([tuple(f.shape) for f in vae.seen], [(22, 768, 1344, 3)])
        refs = out[0][1]["minimax_refs"]
        self.assertEqual(len(refs), 2)                                   # 原有参考保留 + 追加窗口
        window = refs[1]
        self.assertEqual((window["kind"], window["latent_t"], window["ref_audio_t"]), ("video", 7, 0))
        self.assertEqual((window["latent_h"], window["latent_w"]), (48, 84))
        self.assertEqual(window[h3_video_director._CONTEXT_FRAMES_MARK], 22)
        self.assertIsNone(window["audio_latent"])
        self.assertEqual(patched.wrappers["APPLY_MODEL"].keys(),
                         {h3_video_director._CONTINUITY_WRAPPER_KEY})
        self.assertEqual(model.clones, 1)

    def test_context_node_encodes_identity_batch_per_image(self):
        _, out, vae, _ = self._node(identity=torch.zeros(2, 768, 1344, 3))
        refs = out[0][1]["minimax_refs"]
        self.assertEqual([r.get("kind") for r in refs], ["image", "image", "image", "video"])
        self.assertEqual([tuple(r["latent"].shape) for r in refs[1:3]], [(1, 24, 1, 48, 84)] * 2)
        self.assertEqual([tuple(f.shape) for f in vae.seen[:2]], [(1, 768, 1344, 3)] * 2)

    def test_context_node_without_images_passes_through(self):
        model = _FakeModelPatcher()
        cond = [["tokens", {"minimax_refs": []}]]
        patched, out = h3_video_director.NeoH3AddContext().add_context(
            model, cond, _StubH3Vae(), 1344, 768, context_frames=0)
        self.assertIs(patched, model)
        self.assertIs(out, cond)
        self.assertEqual(model.clones, 0)

    def test_ref_row_ranges_follow_layout_order(self):
        """video_audio 参考先占 ref_audio 行、再占 ref_img 行（消费顺序与 PackedLayout 构建顺序一致）。"""
        refs = [{"kind": "video", "latent_t": 3, "ref_audio_t": 2}, {"kind": "image"}]
        layout = _FakeLayout(refs=refs)
        rows = h3_video_director._ref_row_ranges(layout, refs)
        self.assertEqual(rows[0]["audio"], layout.segments[1][:2])
        self.assertEqual(rows[0]["video"], layout.segments[2][:2])
        self.assertEqual(rows[1]["video"], layout.segments[3][:2])
        self.assertIsNone(rows[1]["audio"])

    def test_align_payload_timeline_moves_context_rows_onto_target(self):
        """上下文窗口行整体搬到目标视频开头的行上（ref 行默认从 text_len 起算，与目标时间轴错开一个窗口）。"""
        refs = [{"kind": "image", "latent_t": 1, "latent": torch.zeros(1)},
                {"kind": "video", "latent_t": 7, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 22}]
        layout = _FakeLayout(refs=refs)
        payload = {"layout": layout, "refs": refs}
        video_start, video_stop = layout.segments[-1][:2]
        target = layout.position_ids[video_start:video_stop].clone()
        window_start, window_stop = layout.segments[2][:2]
        h3_video_director._align_payload_timeline(payload)
        self.assertTrue(torch.equal(layout.position_ids[window_start:window_stop], target[:14]))
        self.assertTrue(torch.equal(layout.position_ids[video_start:video_stop], target))   # 目标行一个没动
        self.assertTrue(getattr(layout, h3_video_director._CONTEXT_ALIGNED_ATTR))

    def test_align_payload_timeline_shifts_keyframe_anchors_by_refs_advance(self):
        """锚点行跟着目标一起平移（refs 的推进量），锚点才落在目标时间轴上。"""
        refs = [{"kind": "image", "latent_t": 1, "latent": torch.zeros(1)}]
        layout = _FakeLayout(refs=refs, keyframes=1)
        payload = {"layout": layout, "refs": refs}
        cond_start = layout.segments[1][0]
        video_start = layout.segments[-1][0]
        before = float(layout.position_ids[cond_start, 0])
        target_t = float(layout.position_ids[video_start, 0])
        h3_video_director._align_payload_timeline(payload)
        self.assertAlmostEqual(float(layout.position_ids[cond_start, 0]), target_t)
        self.assertAlmostEqual(target_t - before, 1.0)               # = 参考图的推进量

    def test_align_payload_timeline_is_idempotent_and_skips_without_layout(self):
        refs = [{"kind": "video", "latent_t": 7, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 22}]
        layout = _FakeLayout(refs=refs)
        payload = {"layout": layout, "refs": refs}
        h3_video_director._align_payload_timeline(payload)
        snapshot = layout.position_ids.clone()
        h3_video_director._align_payload_timeline(payload)
        self.assertTrue(torch.equal(layout.position_ids, snapshot))
        h3_video_director._align_payload_timeline({})                # 没有 layout 时什么都不做

    def test_align_payload_timeline_rejects_window_larger_than_target(self):
        refs = [{"kind": "video", "latent_t": 12, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 39}]
        layout = _FakeLayout(latent_t=7, refs=refs)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._align_payload_timeline({"layout": layout, "refs": refs})
        self.assertIn("超过目标视频", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
