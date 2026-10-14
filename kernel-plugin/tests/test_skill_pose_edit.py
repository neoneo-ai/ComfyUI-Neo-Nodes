"""姿势编辑技能（qwen_image_21_pose_edit）能被插件正常扫描 / 加载 / 渲染。"""
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

SKILL_ID = "qwen_image_21_pose_edit"


class PoseEditSkillTests(unittest.TestCase):
    def setUp(self):
        self.entry = next(
            (s for s in skill_mod.scan_skills() if s["id"] == SKILL_ID), None)

    def test_scanned_as_gen_image_skill(self):
        self.assertIsNotNone(self.entry, f"{SKILL_ID} 未被 scan_skills 扫到")
        self.assertTrue(self.entry["gen_image"], "应识别为生图技能")
        self.assertEqual(self.entry["category"], "image_gen")

    def test_scanned_exactly_once_as_preset(self):
        """预设只应存在一份，不能与 custom 残留重复。"""
        hits = [s for s in skill_mod.scan_skills() if s["id"] == SKILL_ID]
        self.assertEqual(len(hits), 1, f"{SKILL_ID} 出现 {len(hits)} 次，疑似 custom/presets 重复")
        self.assertEqual(hits[0]["source"], "presets")

    def test_config_has_pose_default_prompt(self):
        """config.json 的 default_prompt 经 _attach_gen_config 透出，供前端预填触发词。"""
        entry = dict(self.entry or {})
        skill_mod._attach_gen_config(entry, SKILL_ID)
        prompt = str((entry.get("gen_config") or {}).get("default_prompt") or "").strip()
        self.assertTrue(prompt, "config.json 应提供 default_prompt")
        self.assertIn("pose", prompt.lower(), "默认触发词应是姿势指令")

    def test_config_allows_second_reference(self):
        """姿势迁移要挂第 2 张参考图：max_refs 必须容得下。"""
        cfg = skill_mod.get_skill_gen_config(SKILL_ID)
        self.assertGreaterEqual(cfg.get("max_refs", 0), 2)

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
                      "{{VAE}}", "{{SEED}}", "{{STEPS}}", "{{PREFIX}}",
                      "{{WIDTH}}", "{{HEIGHT}}", "{{REF_IMAGE_1}}", "{{REF_IMAGE_2}}"):
            self.assertIn(token, blob, f"模板缺少占位符 {token}")

    def test_encoder_resolution_present(self):
        """TextEncodeQwenImage21 的 resolution 是必填输入，缺失整图会被 prompt 校验拒绝。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        enc = [n for n in wf.values() if n["class_type"] == "TextEncodeQwenImage21"]
        self.assertEqual(len(enc), 1)
        self.assertIn("resolution", enc[0]["inputs"])

    def test_edit_target_scaled_to_canvas(self):
        """<image1> = 编辑目标，必须经 ImageScale 对齐画布（与 latent 同尺寸、同在 32 网格）。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        enc = next(n for n in wf.values() if n["class_type"] == "TextEncodeQwenImage21")
        scale_id = enc["inputs"]["images.image_1"][0]
        self.assertEqual(wf[scale_id]["class_type"], "ImageScale")
        load_id = wf[scale_id]["inputs"]["image"][0]
        self.assertEqual(wf[load_id]["class_type"], "LoadImage")
        self.assertEqual(wf[load_id]["inputs"]["image"], "{{REF_IMAGE_1}}")

    def test_links_point_to_existing_nodes(self):
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        for nid, node in wf.items():
            for key, val in node["inputs"].items():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                    self.assertIn(val[0], wf, f"节点 {nid}.{key} 指向不存在的节点 {val[0]}")


restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
