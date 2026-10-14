"""新转换的技能（qwen_image_21_identity_swap）能被插件正常扫描 / 加载 / 渲染。"""
from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import os
import sys
import json
import types
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, "..", ".."))
sys.path.insert(0, _COMFY_ROOT)

_PKG_NAME = "_neo_nodes_test_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg


class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper

    def get(self, *a, **k):
        return self._deco

    post = get


class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()


server_mod = types.ModuleType("server")
server_mod.PromptServer = _FakePromptServer
folder_mod = types.ModuleType("folder_paths")
folder_mod.get_filename_list = lambda *a, **k: []
sys.modules["server"] = server_mod
sys.modules["folder_paths"] = folder_mod

from _neo_nodes_test_pkg import skill as skill_mod  # noqa: E402

SKILL_ID = "qwen_image_21_identity_swap"


class IdentitySwapSkillTests(unittest.TestCase):
    def setUp(self):
        self.entry = next(
            (s for s in skill_mod.scan_skills() if s["id"] == SKILL_ID), None)

    def test_scanned_as_gen_image_skill(self):
        self.assertIsNotNone(self.entry, f"{SKILL_ID} 未被 scan_skills 扫到")
        self.assertTrue(self.entry["gen_image"], "应识别为生图技能")
        self.assertEqual(self.entry["category"], "image_gen")
        self.assertIn("image", self.entry["inputs"], "换脸需要参考图输入")

    def test_scanned_exactly_once_as_preset(self):
        """已移到 presets：全局只应存在一份，不能与 custom 残留重复。"""
        hits = [s for s in skill_mod.scan_skills() if s["id"] == SKILL_ID]
        self.assertEqual(len(hits), 1, f"{SKILL_ID} 出现 {len(hits)} 次，疑似 custom/presets 重复")
        self.assertEqual(hits[0]["source"], "presets")

    def test_config_has_default_prompt(self):
        """config.json 的 default_prompt 经 _attach_gen_config 透出，供前端预填提示词。"""
        entry = dict(self.entry or {})
        skill_mod._attach_gen_config(entry, SKILL_ID)
        prompt = str((entry.get("gen_config") or {}).get("default_prompt") or "").strip()
        self.assertTrue(prompt, "config.json 应提供 default_prompt")
        self.assertIn("head", prompt.lower(), "默认提示词应是换脸指令")

    def test_workflow_loads_and_is_api_format(self):
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        self.assertIsInstance(wf, dict)
        self.assertTrue(wf, "工作流为空")
        for nid, node in wf.items():
            self.assertIn("class_type", node, f"节点 {nid} 缺 class_type")
            self.assertIn("inputs", node, f"节点 {nid} 缺 inputs")

    def test_runtime_placeholders_present(self):
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        blob = json.dumps(wf, ensure_ascii=False)
        for token in ("{{PROMPT}}", "{{NEGATIVE}}", "{{MODEL}}", "{{TEXT_ENCODER}}",
                      "{{VAE}}", "{{SEED}}", "{{PREFIX}}",
                      "{{REF_IMAGE_1}}", "{{REF_IMAGE_2}}"):
            self.assertIn(token, blob, f"模板缺少占位符 {token}")

    def test_prompt_injected_before_llm_rewrite(self):
        """{{PROMPT}} 落在 502(TextGenerateLTX2Prompt).prompt，改写后进 485.prompt。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        self.assertEqual(wf["502"]["inputs"]["prompt"], "{{PROMPT}}")
        self.assertEqual(wf["485"]["inputs"]["prompt"], ["502", 0],
                         "485.prompt 应仍来自 LLM 改写节点")

    def test_no_third_party_plugin_nodes(self):
        """全部节点都是 ComfyUI 核心；switch 透传节点已删、latent 直连采样器。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        self.assertNotIn("483", wf, "ComfySwitchNode 应已删除")
        self.assertNotIn("516", wf, "JjkText 应已移除")
        self.assertEqual(wf["482"]["inputs"]["latent_image"], ["485", 2],
                         "采样器 latent 应直连 TextEncodeQwenImage21 的 latent 输出")
        plugin_nodes = {"JjkText", "ComfySwitchNode"}
        for nid, node in wf.items():
            self.assertNotIn(node["class_type"], plugin_nodes,
                             f"节点 {nid} 仍依赖第三方插件：{node['class_type']}")

    def test_links_point_to_existing_nodes(self):
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        for nid, node in wf.items():
            for key, val in node["inputs"].items():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                    self.assertIn(val[0], wf, f"节点 {nid}.{key} 指向不存在的节点 {val[0]}")

    def test_llm_rewrite_clip_is_literal_not_placeholder(self):
        """第二个 CLIP（LLM 改写专用）保持字面文件名，避免被主编码器覆盖。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        self.assertNotIn("{{", wf["500"]["inputs"]["clip_name"])


restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)