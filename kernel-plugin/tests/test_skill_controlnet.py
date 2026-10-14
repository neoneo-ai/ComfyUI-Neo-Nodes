"""ControlNet 技能（qwen_image_21_controlnet）能被插件正常扫描 / 加载 / 渲染。"""
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

SKILL_ID = "qwen_image_21_controlnet"


class ControlNetSkillTests(unittest.TestCase):
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
        self.assertIn("pose", prompt.lower(), "默认触发词应是姿势重建指令")
        self.assertIn("<image1>", prompt, "内容主体是第 1 张参考图")
        self.assertNotIn("<image2>", prompt, "姿势图只进模型补丁，编码器里没有它")

    def test_config_allows_content_reference(self):
        """控制图之外还要挂内容参考图：max_refs 必须容得下第 2 张。"""
        cfg = skill_mod.get_skill_gen_config(SKILL_ID)
        self.assertGreaterEqual(cfg.get("max_refs", 0), 2)

    def test_config_declares_min_refs(self):
        """姿势取第 2 张参考图：少于 2 张参考图时模板会渲染出缺输入的图，config 必须声明 min_refs。"""
        cfg = skill_mod.get_skill_gen_config(SKILL_ID)
        self.assertGreaterEqual(cfg.get("min_refs", 0), 2)

    def test_config_declares_control_ref(self):
        """第 2 张是控制图：config 必须声明 control_ref，解析期才会把它从编码器参考里摘出来。"""
        cfg = skill_mod.get_skill_gen_config(SKILL_ID)
        self.assertEqual(int(cfg.get("control_ref") or 0), 2)

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
                      "{{WIDTH}}", "{{HEIGHT}}", "{{REF_IMAGE_1}}", "{{CONTROL_IMAGE}}"):
            self.assertIn(token, blob, f"模板缺少占位符 {token}")

    def test_encoder_resolution_present(self):
        """TextEncodeQwenImage21 的 resolution 是必填输入，缺失整图会被 prompt 校验拒绝。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        enc = [n for n in wf.values() if n["class_type"] == "TextEncodeQwenImage21"]
        self.assertEqual(len(enc), 1)
        self.assertGreater(int(enc[0]["inputs"]["resolution"]), 0,
                           "参考图是内容参考，编码器要按 ~1MP 归一化")

    def test_encoder_refs_are_content_refs(self):
        """编码器只吃内容参考：姿势图不进 images.image_k，否则模型直接复刻它。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        enc = next(n for n in wf.values() if n["class_type"] == "TextEncodeQwenImage21")
        self.assertEqual(wf[enc["inputs"]["images.image_1"][0]]["inputs"]["image"],
                         "{{REF_IMAGE_1}}")
        self.assertNotIn("images.image_2", enc["inputs"],
                         "模板不能把姿势图写进编码器参考槽")

    def test_control_chain_wired_to_sampler(self):
        """LoadImage(姿势图) → AIO_Preprocessor → ZImageFunControlnet(模型补丁) → KSampler。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        cnet_id = next(k for k, n in wf.items() if n["class_type"] == "ZImageFunControlnet")
        cnet = wf[cnet_id]
        pre_id = cnet["inputs"]["image"][0]
        self.assertEqual(wf[pre_id]["class_type"], "AIO_Preprocessor")
        self.assertEqual(wf[pre_id]["inputs"]["preprocessor"], "OpenposePreprocessor")
        load_id = wf[pre_id]["inputs"]["image"][0]
        self.assertEqual(wf[load_id]["class_type"], "LoadImage")
        self.assertEqual(wf[load_id]["inputs"]["image"], "{{CONTROL_IMAGE}}")
        patch_id = cnet["inputs"]["model_patch"][0]
        self.assertEqual(wf[patch_id]["class_type"], "ModelPatchLoader")
        sampler = next(n for n in wf.values() if n["class_type"] == "KSampler")
        self.assertEqual(sampler["inputs"]["model"][0], cnet_id)

    def test_preprocessor_resolution_carries_canvas_token(self):
        """无参考图时画布占位符判未填：预处理节点必须带该占位符，整条控制链才会被裁干净。"""
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        pre = next(n for n in wf.values() if n["class_type"] == "AIO_Preprocessor")
        self.assertEqual(pre["inputs"]["resolution"], "{{CANVAS_HEIGHT}}")

    def test_links_point_to_existing_nodes(self):
        wf = skill_mod.load_skill_workflow(SKILL_ID)
        for nid, node in wf.items():
            for key, val in node["inputs"].items():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                    self.assertIn(val[0], wf, f"节点 {nid}.{key} 指向不存在的节点 {val[0]}")


restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)

