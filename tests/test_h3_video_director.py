# SPDX-License-Identifier: Apache-2.0
"""h3_video_director + video_director 配方 schema 的离线单测。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
recipes 的 gallery/bookmark/gallery_lora/util 依赖用假模块；director 编排逻辑通过 monkeypatch
execute_graph_inprocess / resolve_video_params 等验证帧拼接、边界丢帧、seed 派生与音频对齐。"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest

import torch

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

    def test_empty_prompt_rejected(self):
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "  ", "skill_id": "s"}]}, {})


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

    def _patch(self, n_segments, frame_counts, seed_base=100):
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess)
        bodies = []
        it = iter(_FakeVideo(n, self.FPS, self.SR) for n in frame_counts)

        def _fake_exec(graph, output_type="IMAGE"):
            return next(it)

        segments = [{"skill_id": f"s{i}", "prompt": f"p{i}",
                     "duration_sec": 5, "ref_input": None} for i in range(n_segments)]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": seed_base},
                                               "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d.execute_graph_inprocess = _fake_exec
        return orig, bodies

    def test_continuity_on_drops_boundary_frames(self):
        orig, bodies = self._patch(3, [124, 124, 124])
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True)
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
        orig, _ = self._patch(3, [124, 124, 124])
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True)
        finally:
            self._restore(orig)
        comp = video.get_components()
        # 帧数 370 → 音频应恰好 370 * SPF 采样（A/V 对齐）
        self.assertEqual(comp.images.shape[0], 370)
        self.assertEqual(comp.audio["waveform"].shape[-1], 370 * self.SPF)

    def test_concat_audio_none_when_no_audio(self):
        out = h3_video_director._concat_segment_audio([None, None], self.FPS, 1)
        self.assertIsNone(out)

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess) = orig


if __name__ == "__main__":
    unittest.main()
