# SPDX-License-Identifier: Apache-2.0
"""bundles 运行时包 + NeoPromptAgent BUNDLE 输出 + H3/Krea2 bundle 消费的离线单测。

不依赖 ComfyUI 运行中的服务器与真实模型：server/comfy/folder_paths/nodes 用桩模块替换；
H3/Krea2 generate 的 resolve/render/execute/load_skill_workflow 用捕获型假函数，
验证 prompt 回退、references 覆盖、skill 有效覆盖 / 无效回退这几条流向。"""

import importlib.util
import os
import sys
import tempfile
import types
import unittest

import torch

_TMP = tempfile.mkdtemp(prefix="neo_bundles_")
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
    "loras": [],
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

_PKG = "_neo_bundles_pkg"
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
krea2_generate = _load("krea2_generate", "krea2_generate.py")
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
prompts = _load("prompts", "prompts.py")


class BundleRegistryTests(unittest.TestCase):
    def setUp(self):
        bundles._registry.clear()

    def test_create_and_get_roundtrip(self):
        bid = bundles.create_bundle({"prompts": ["a", "b"], "references": [], "gen_type": "", "skill_id": "s"})
        self.assertTrue(bid.startswith("bnd_"))
        p = bundles.get_bundle(bid)
        self.assertEqual(p["prompts"], ["a", "b"])
        self.assertEqual(p["skill_id"], "s")

    def test_get_missing_returns_none(self):
        self.assertIsNone(bundles.get_bundle(""))
        self.assertIsNone(bundles.get_bundle("bnd_nonexistent"))

    def test_lru_eviction_caps_registry(self):
        ids = [bundles.create_bundle({"k": i}) for i in range(40)]
        self.assertLessEqual(len(bundles._registry), bundles._MAX_BUNDLES)
        self.assertIsNotNone(bundles.get_bundle(ids[-1]), "最新 bundle 应仍在")

    def test_ttl_expiry(self):
        bid = bundles.create_bundle({"k": 1})
        created, payload = bundles._registry[bid]
        bundles._registry[bid] = (created - bundles._TTL_SECONDS - 1, payload)
        self.assertIsNone(bundles.get_bundle(bid))


class AgentBundleOutputTests(unittest.TestCase):
    def test_agent_declares_prompt_and_bundle_outputs(self):
        self.assertEqual(prompts.NeoPromptAgent.RETURN_TYPES, ("STRING", "STRING"))
        self.assertEqual(prompts.NeoPromptAgent.RETURN_NAMES, ("PROMPT", "BUNDLE"))
        self.assertEqual(prompts.NeoPromptAgent.OUTPUT_IS_LIST, (True, False))

    def test_bundle_references_from_image_tensor(self):
        refs = prompts._bundle_references(torch.full((1, 4, 4, 3), 0.5))
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0]["kind"], "data")
        self.assertTrue(refs[0]["data"].startswith("data:image/png;base64,"))
        self.assertEqual(prompts._bundle_references(None), [])

    def test_bundle_references_multi_image(self):
        # 批量 [N,H,W,C] → N 个 reference（顺序对应 image_1..image_N）
        refs = prompts._bundle_references(torch.full((3, 4, 4, 3), 0.5))
        self.assertEqual(len(refs), 3)
        for r in refs:
            self.assertEqual(r["kind"], "data")
            self.assertTrue(r["data"].startswith("data:image/png;base64,"))

    def test_bundle_references_capped_at_max(self):
        # 超过上限只取前 MAX_BUNDLE_REFERENCES 张，避免无界 base64 内存增长
        refs = prompts._bundle_references(torch.full((12, 2, 2, 3), 0.5))
        self.assertEqual(len(refs), prompts.MAX_BUNDLE_REFERENCES)


class BundleInputPlacementTests(unittest.TestCase):
    """bundle 输入须可见（非 hidden）且紧跟 image 之后。"""

    def test_h3_bundle_visible_after_image(self):
        opt = h3_video_gen.NeoH3VideoGenerate.INPUT_TYPES()["optional"]
        self.assertIn("bundle", opt)
        self.assertNotIn("hidden", opt["bundle"][1])
        keys = list(opt.keys())
        self.assertEqual(keys.index("bundle"), keys.index("image") + 1)

    def test_krea2_bundle_visible_after_image(self):
        opt = krea2_generate.NeoKrea2Generate.INPUT_TYPES()["optional"]
        self.assertIn("bundle", opt)
        self.assertNotIn("hidden", opt["bundle"][1])
        keys = list(opt.keys())
        self.assertEqual(keys.index("bundle"), keys.index("image") + 1)


class H3BundleConsumeTests(unittest.TestCase):
    def setUp(self):
        self._captured = {}
        self._restore = [
            (h3_video_gen, "resolve_video_params", h3_video_gen.resolve_video_params),
            (h3_video_gen, "render_template", h3_video_gen.render_template),
            (h3_video_gen, "execute_graph_inprocess", h3_video_gen.execute_graph_inprocess),
            (h3_video_gen, "load_skill_workflow", h3_video_gen.load_skill_workflow),
        ]
        h3_video_gen.resolve_video_params = lambda body, cfg: self._captured.setdefault("body", body) or {"model": "x"}
        # render_template 只在 generate 里显式调用一次（_resolve_skill_id/_gen_video_skills 不会碰它），
        # 用它捕获真实用到的模板，从而反查生效的 skill id
        h3_video_gen.render_template = lambda template, params: self._captured.setdefault("template", template) or ({"graph": True}, [])
        h3_video_gen.execute_graph_inprocess = lambda graph, output_type=None: ("VIDEO_MARKER",)
        h3_video_gen.load_skill_workflow = lambda sid: {"__skill_id": sid, "template": True}

    def tearDown(self):
        for mod, name, orig in self._restore:
            setattr(mod, name, orig)

    def _valid_video_skill(self):
        return h3_video_gen._gen_video_skills()[0]["id"]

    def test_bundle_prompt_used_when_node_prompt_empty(self):
        bid = bundles.create_bundle({"prompts": ["from bundle"], "references": [], "gen_type": "", "skill_id": ""})
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=self._valid_video_skill(), prompt="", image=None, bundle=bid)
        self.assertEqual(self._captured["body"]["prompt"], "from bundle")

    def test_node_prompt_wins_over_bundle(self):
        bid = bundles.create_bundle({"prompts": ["from bundle"], "references": [], "gen_type": "", "skill_id": ""})
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=self._valid_video_skill(), prompt="local", image=None, bundle=bid)
        self.assertEqual(self._captured["body"]["prompt"], "local")

    def test_bundle_references_override_image(self):
        refs = [{"kind": "data", "data": "data:image/png;base64,AAAA"}]
        bid = bundles.create_bundle({"prompts": ["p"], "references": refs, "gen_type": "", "skill_id": ""})
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=self._valid_video_skill(), prompt="p", image=torch.full((1, 2, 2, 3), 0.1), bundle=bid)
        self.assertEqual(self._captured["body"]["references"], refs)

    def test_no_bundle_uses_node_image(self):
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=self._valid_video_skill(), prompt="p", image=torch.full((1, 2, 2, 3), 0.1))
        self.assertEqual(len(self._captured["body"]["references"]), 1)
        self.assertTrue(self._captured["body"]["references"][0]["data"].startswith("data:image/png;base64,"))

    def test_bundle_valid_skill_overrides_local(self):
        local = self._valid_video_skill()
        other = next(s["id"] for s in h3_video_gen._gen_video_skills() if s["id"] != local)
        bid = bundles.create_bundle({"prompts": ["p"], "references": [], "gen_type": "", "skill_id": other})
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=local, prompt="p", image=None, bundle=bid)
        self.assertEqual(self._captured["template"]["__skill_id"], h3_video_gen._resolve_skill_id(other))

    def test_bundle_invalid_skill_falls_back_to_local(self):
        local = self._valid_video_skill()
        bid = bundles.create_bundle(
            {"prompts": ["p"], "references": [], "gen_type": "", "skill_id": "not_a_video_skill"})
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=local, prompt="p", image=None, bundle=bid)
        self.assertEqual(self._captured["template"]["__skill_id"], h3_video_gen._resolve_skill_id(local))

    def test_missing_bundle_falls_back_to_local(self):
        local = self._valid_video_skill()
        h3_video_gen.NeoH3VideoGenerate().generate(
            skill_id=local, prompt="p", image=None, bundle="bnd_gone")
        self.assertEqual(self._captured["template"]["__skill_id"], h3_video_gen._resolve_skill_id(local))


class Krea2BundleConsumeTests(unittest.TestCase):
    def setUp(self):
        self._captured = {}
        self._restore = [
            (krea2_generate, "resolve_request", krea2_generate.resolve_request),
            (krea2_generate, "render_template", krea2_generate.render_template),
            (krea2_generate, "execute_graph_inprocess", krea2_generate.execute_graph_inprocess),
            (krea2_generate, "load_skill_workflow", krea2_generate.load_skill_workflow),
        ]
        krea2_generate.resolve_request = lambda body, settings: self._captured.setdefault("body", body) or {"model": "x"}
        # render_template 只在 generate 里显式调用一次，用它捕获真实用到的模板以反查生效的 skill id
        krea2_generate.render_template = lambda template, params: self._captured.setdefault("template", template) or ({"graph": True}, [])
        krea2_generate.execute_graph_inprocess = lambda graph: ("IMAGE_MARKER",)
        krea2_generate.load_skill_workflow = lambda sid: {"__skill_id": sid, "template": True}

    def tearDown(self):
        for mod, name, orig in self._restore:
            setattr(mod, name, orig)

    def _valid_image_skill(self):
        return krea2_generate._gen_image_skills()[0]["id"]

    def test_bundle_prompt_used_when_node_prompt_empty(self):
        bid = bundles.create_bundle({"prompts": ["from bundle"], "references": [], "gen_type": "", "skill_id": ""})
        krea2_generate.NeoKrea2Generate().generate(
            skill_id=self._valid_image_skill(), prompt="", image=None, bundle=bid)
        self.assertEqual(self._captured["body"]["prompt"], "from bundle")

    def test_bundle_references_override_image(self):
        refs = [{"kind": "data", "data": "data:image/png;base64,AAAA"}]
        bid = bundles.create_bundle({"prompts": ["p"], "references": refs, "gen_type": "", "skill_id": ""})
        krea2_generate.NeoKrea2Generate().generate(
            skill_id=self._valid_image_skill(), prompt="p", image=torch.full((1, 2, 2, 3), 0.1), bundle=bid)
        self.assertEqual(self._captured["body"]["references"], refs)

    def test_bundle_valid_skill_overrides_local(self):
        local = self._valid_image_skill()
        other = next(s["id"] for s in krea2_generate._gen_image_skills() if s["id"] != local)
        bid = bundles.create_bundle({"prompts": ["p"], "references": [], "gen_type": "", "skill_id": other})
        krea2_generate.NeoKrea2Generate().generate(
            skill_id=local, prompt="p", image=None, bundle=bid)
        self.assertEqual(self._captured["template"]["__skill_id"], krea2_generate._resolve_skill_id(other))

    def test_bundle_invalid_skill_falls_back_to_local(self):
        local = self._valid_image_skill()
        bid = bundles.create_bundle(
            {"prompts": ["p"], "references": [], "gen_type": "", "skill_id": "not_an_image_skill"})
        krea2_generate.NeoKrea2Generate().generate(
            skill_id=local, prompt="p", image=None, bundle=bid)
        self.assertEqual(self._captured["template"]["__skill_id"], krea2_generate._resolve_skill_id(local))


if __name__ == "__main__":
    unittest.main()

