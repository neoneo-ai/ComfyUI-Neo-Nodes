# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Skills Unit Tests
# 测试 skill 元数据扫描与图片解析 helper（P1 MVP）

import base64
import io
import os
import sys
import types
import importlib
import unittest

# 添加父目录到路径以导入模块
_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根目录（提供 server / folder_paths / torch 等模块）
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, '..', '..'))
sys.path.insert(0, _COMFY_ROOT)

# prompts.py 使用相对导入（from .llm import / from .gallery import），
# 需要作为包的子模块加载
_PKG_NAME = "_neo_nodes_test_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg

# stub server 模块（脱离 ComfyUI 服务器运行时，PromptServer.instance 不存在）
class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper
    def get(self, *a, **k):
        return self._deco()
    def post(self, *a, **k):
        return self._deco()

class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()

_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

try:
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    PROMPTS_AVAILABLE = True
except Exception as _e:  # 缺少 server/torch 等依赖时跳过
    prompts_mod = None
    PROMPTS_AVAILABLE = False
    _IMPORT_ERROR = _e

_reason = "" if PROMPTS_AVAILABLE else f"prompts module unavailable: {_IMPORT_ERROR}"


def _png_data_uri(size=(2048, 1024)):
    """生成测试用 PNG data URI"""
    from PIL import Image
    img = Image.new("RGB", size, (200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestScanSkills(unittest.TestCase):
    """测试 _scan_skills 统一元数据"""

    def test_reverse_prompt_is_vision_skill(self):
        skills = prompts_mod._scan_skills()
        by_id = {s["id"]: s for s in skills}
        self.assertIn("reverse_prompt", by_id)
        rp = by_id["reverse_prompt"]
        self.assertTrue(rp["needs_image"], "reverse_prompt 必须标记为需要图片")
        self.assertIn("image", rp["inputs"])
        self.assertIn("@图", rp["markers"])
        self.assertEqual(rp["category"], "vision")

    def test_builtin_task_skills_exist(self):
        ids = {s["id"] for s in prompts_mod._scan_skills()}
        self.assertTrue({"smart_prompt", "translate_prompt"} <= ids)

    def test_internal_tasks_hidden(self):
        """内部任务不作为可选 skill 暴露"""
        ids = {s["id"] for s in prompts_mod._scan_skills()}
        self.assertFalse({"template_prompt", "extract_title", "extract_classify"} & ids)

    def test_template_skills_are_text_only(self):
        """未声明 image 输入的模板默认为纯文本 skill"""
        styles = {s["id"]: s for s in prompts_mod._scan_skills()
                  if s["source"] in ("presets", "custom") and s["id"] != "minimax_h3_ref"}
        self.assertTrue(len(styles) > 0, "至少应扫描到一个模板 skill")
        for sid, s in styles.items():
            self.assertFalse(s["needs_image"], f"普通模板不应需要图片: {sid}")

    def test_minimax_ref_skill(self):
        """内置全能参考模板：图像输入 + 触发标记"""
        by_id = {s["id"]: s for s in prompts_mod._scan_skills()}
        s = by_id.get("minimax_h3_ref")
        self.assertIsNotNone(s, "minimax_h3_ref 模板未被扫描到")
        self.assertTrue(s["needs_image"])
        self.assertEqual(s["category"], "vision")
        self.assertIn("@全参考", s["markers"])

    def test_skill_fields_complete(self):
        for s in prompts_mod._scan_skills():
            for field in ("id", "name", "category", "source", "inputs",
                          "needs_image", "markers"):
                self.assertIn(field, s)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestResolveImageBytes(unittest.TestCase):
    """测试前端图片源解析（base64 -> PNG bytes + 缩放）"""

    def test_decode_and_scale(self):
        uri = _png_data_uri((2048, 1024))
        out = prompts_mod.resolve_image_bytes({"kind": "data", "data": uri})
        self.assertIsNotNone(out)
        from PIL import Image
        img = Image.open(io.BytesIO(out))
        self.assertLessEqual(max(img.size), 1024)

    def test_small_image_kept(self):
        uri = _png_data_uri((100, 80))
        out = prompts_mod.resolve_image_bytes({"kind": "data", "data": uri})
        self.assertIsNotNone(out)
        from PIL import Image
        img = Image.open(io.BytesIO(out))
        self.assertEqual(img.size, (100, 80))

    def test_invalid_sources(self):
        self.assertIsNone(prompts_mod.resolve_image_bytes(None))
        self.assertIsNone(prompts_mod.resolve_image_bytes("not-a-dict"))
        # kind 不是 data / input
        self.assertIsNone(prompts_mod.resolve_image_bytes(
            {"kind": "file", "path": "/tmp/x.png"}))
        # 缺少逗号分隔的 data URI
        self.assertIsNone(prompts_mod.resolve_image_bytes(
            {"kind": "data", "data": "garbage"}))

    def test_input_kind_from_load_image(self):
        """节点 image 输入的文件名源（LoadImage 场景）"""
        import tempfile
        import shutil
        import folder_paths
        from PIL import Image

        tmp = tempfile.mkdtemp()
        try:
            Image.new("RGB", (2048, 1024), (10, 200, 30)).save(os.path.join(tmp, "test_img.png"))
            orig = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            try:
                out = prompts_mod.resolve_image_bytes({"kind": "input", "value": "test_img.png"})
                self.assertIsNotNone(out)
                from PIL import Image as PILImage
                img = PILImage.open(io.BytesIO(out))
                self.assertLessEqual(max(img.size), 1024)

                # 带标注形式
                out2 = prompts_mod.resolve_image_bytes({"kind": "input", "value": "test_img.png[input]"})
                self.assertIsNotNone(out2)

                # 越界路径必须被拒绝
                self.assertIsNone(prompts_mod.resolve_image_bytes({"kind": "input", "value": "../escape.png"}))
                # 不存在的文件
                self.assertIsNone(prompts_mod.resolve_image_bytes({"kind": "input", "value": "missing.png"}))
            finally:
                folder_paths.get_input_directory = orig
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestImageTensorToPng(unittest.TestCase):
    """测试节点 IMAGE 输入转 PNG bytes"""

    def test_tensor_to_png(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch not installed")
        from PIL import Image
        t = torch.rand(1, 32, 48, 3)
        out = prompts_mod.image_tensor_to_png(t)
        self.assertIsNotNone(out)
        img = Image.open(io.BytesIO(out))
        self.assertEqual(img.size, (48, 32))

    def test_invalid_tensor(self):
        self.assertIsNone(prompts_mod.image_tensor_to_png(None))


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestResolveMultiResult(unittest.TestCase):
    """测试 multi_result 输出契约解析（llm.resolve_multi_result）"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.llm = _il.import_module(f"{_PKG_NAME}.llm")

    def test_no_rule_returns_empty(self):
        # 未声明契约 → 空列表，调用方回退整段文本
        self.assertEqual(self.llm.resolve_multi_result("a\n---\nb", None), [])
        self.assertEqual(self.llm.resolve_multi_result("hello", {}), [])

    def test_empty_text(self):
        rule = {"format": "separator"}
        self.assertEqual(self.llm.resolve_multi_result("", rule), [])
        self.assertEqual(self.llm.resolve_multi_result("   \n  ", rule), [])

    def test_separator_split(self):
        rule = {"format": "separator", "separator": "\n---\n"}
        text = "prompt one\n---\nprompt two\n---\nprompt three"
        self.assertEqual(
            self.llm.resolve_multi_result(text, rule),
            ["prompt one", "prompt two", "prompt three"])

    def test_separator_default(self):
        rule = {"format": "separator"}
        self.assertEqual(
            self.llm.resolve_multi_result("a\n---\nb", rule), ["a", "b"])

    def test_json_array(self):
        rule = {"format": "json_array"}
        self.assertEqual(
            self.llm.resolve_multi_result('["p1", " p2 ", "p3"]', rule),
            ["p1", "p2", "p3"])

    def test_json_array_dict_wrapper(self):
        rule = {"format": "json_array"}
        self.assertEqual(
            self.llm.resolve_multi_result('{"prompts": ["x", "y"]}', rule),
            ["x", "y"])

    def test_json_invalid_falls_back_to_separator(self):
        rule = {"format": "json_array", "separator": "\n---\n"}
        text = "not json\n---\nstill not json"
        self.assertEqual(
            self.llm.resolve_multi_result(text, rule),
            ["not json", "still not json"])


if __name__ == '__main__':
    unittest.main()