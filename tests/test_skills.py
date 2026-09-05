# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Skills Unit Tests
# 测试 skill 元数据扫描与图片解析 helper（P1 MVP）

import base64
import io
import os
import sys
import types
import tempfile
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
                          "needs_image", "markers", "multi_turn"):
                self.assertIn(field, s)

    def test_multi_turn_flag(self):
        """multi_turn 标志：声明的技能为 True，未声明默认 False"""
        by_id = {s["id"]: s for s in prompts_mod._scan_skills()}
        for sid in ("co-op-game-intro-generator", "3d-animation-short-generator"):
            s = by_id.get(sid)
            self.assertIsNotNone(s, f"未扫描到技能: {sid}")
            self.assertTrue(s["multi_turn"], f"{sid} 应声明 multi_turn")
        ref = by_id.get("minimax_h3_ref")
        if ref is not None:
            self.assertFalse(ref["multi_turn"])


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSaveSkillMultiTurn(unittest.TestCase):
    """save_skill_main 的 multi_turn 设置：显式写入 / 缺省沿用 / False 移除"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = self.skill_mod.SKILL_CUSTOM_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = self._tmp.name

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        self._tmp.cleanup()

    def _read_meta(self, sid):
        main = os.path.join(self._tmp.name, sid, "skill.md")
        with open(main, encoding="utf-8") as f:
            meta, body = self.skill_mod.split_frontmatter(f.read())
        return meta, body

    def test_explicit_true_writes_field(self):
        self.assertTrue(self.skill_mod.save_skill_main("mt-a", "MT A", "body", None, "custom", True))
        meta, body = self._read_meta("mt-a")
        self.assertIs(meta.get("multi_turn"), True)
        self.assertEqual(body, "body")

    def test_omitted_preserves_existing(self):
        self.skill_mod.save_skill_main("mt-b", "MT B", "body", None, "custom", True)
        self.assertTrue(self.skill_mod.save_skill_main("mt-b", "MT B", "body2", None, "custom"))
        meta, body = self._read_meta("mt-b")
        self.assertIs(meta.get("multi_turn"), True)
        self.assertEqual(body, "body2")

    def test_explicit_false_removes_field(self):
        self.skill_mod.save_skill_main("mt-c", "MT C", "body", None, "custom", True)
        self.assertTrue(self.skill_mod.save_skill_main("mt-c", "MT C", "body", None, "custom", False))
        meta, _ = self._read_meta("mt-c")
        self.assertNotIn("multi_turn", meta)

    def test_new_skill_defaults_absent(self):
        self.assertTrue(self.skill_mod.save_skill_main("mt-d", "MT D", "body", None, "custom"))
        meta, _ = self._read_meta("mt-d")
        self.assertNotIn("multi_turn", meta)


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


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSkillAgent(unittest.TestCase):
    """测试 skill 代理：语言互斥主文件选择、引用列表、安全读取与工具调用循环。"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill = _il.import_module(f"{_PKG_NAME}.skill")
        cls.llm = _il.import_module(f"{_PKG_NAME}.llm")

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self.skdir = os.path.join(self.tmp, "myskill")
        os.makedirs(os.path.join(self.skdir, "references"))
        self._write("SKILL.md", "---\nname: myskill\n---\nEN MAIN BODY")
        self._write("SKILL.cn.md", "CN MAIN BODY")
        self._write(os.path.join("references", "ref.txt"), "REFERENCE CONTENT")

        self._orig_skill_dir = self.skill._skill_dir
        self.skill._skill_dir = lambda sid: self.skdir if sid == "myskill" else None

        # 记录并替换 llm 依赖（skill 在函数运行时惰性 from .llm import ...）
        self._llm_attrs = {}
        for a in ("get_current_mode", "_load_remote_config", "_detect_language",
                  "remote_chat_turn", "_run_llm_inference"):
            self._llm_attrs[a] = getattr(self.llm, a)
        self.llm._load_remote_config = lambda: {"skill_language": "auto"}
        self.llm._detect_language = (lambda t: ("Chinese" if any('\u4e00' <= c <= '\u9fff'
                                                                 for c in (t or "")) else "English"))

    def tearDown(self):
        import shutil
        self.skill._skill_dir = self._orig_skill_dir
        for a, v in self._llm_attrs.items():
            setattr(self.llm, a, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, rel, content):
        with open(os.path.join(self.skdir, rel), "w", encoding="utf-8") as f:
            f.write(content)

    def test_main_files_language_exclusive(self):
        self.assertEqual(self.skill._main_md_files_for_language(self.skdir, "en"), ["SKILL.md"])
        self.assertEqual(self.skill._main_md_files_for_language(self.skdir, "cn"), ["SKILL.cn.md"])

    def test_load_content_en_excludes_cn(self):
        c = self.skill.load_skill_content("myskill", language="en")
        self.assertIn("EN MAIN BODY", c)
        self.assertNotIn("CN MAIN BODY", c)

    def test_load_content_cn_excludes_en(self):
        c = self.skill.load_skill_content("myskill", language="cn")
        self.assertIn("CN MAIN BODY", c)
        self.assertNotIn("EN MAIN BODY", c)

    def test_list_references(self):
        self.assertEqual(self.skill.list_skill_references("myskill"), ["references/ref.txt"])

    def test_read_reference_ok_and_safe(self):
        self.assertEqual(self.skill.read_skill_file("myskill", "references/ref.txt"), "REFERENCE CONTENT")
        self.assertIsNone(self.skill.read_skill_file("myskill", "../x.txt"))
        self.assertIsNone(self.skill.read_skill_file("myskill", "/etc/passwd"))
        self.assertIsNone(self.skill.read_skill_file("myskill", "references/../SKILL.md"))

    def test_agent_reads_reference_then_finalizes(self):
        calls = []

        def fake_turn(messages, max_tokens=None, tools=None):
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function",
                     "function": {"name": "read_skill_file",
                                  "arguments": '{"path": "references/ref.txt"}'}}]}
            return {"role": "assistant", "content": "DONE"}

        self.llm.remote_chat_turn = fake_turn
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        out = self.skill._skill_agent_core("myskill", "hello")
        self.assertEqual(out, "DONE")
        self.assertEqual(len(calls), 2)
        tool_msgs = [m for m in calls[1] if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        self.assertEqual(tool_msgs[0]["content"], "REFERENCE CONTENT")
        self.assertTrue(any(m.get("role") == "system" and "Available reference files" in m["content"]
                            for m in calls[0]))

    def test_agent_local_mode_falls_back_to_single_shot(self):
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        self.llm._run_llm_inference = lambda *a, **k: "[single]"
        out = self.skill._skill_agent_core("myskill", "hello")
        self.assertEqual(out, "[single]")

    def test_stream_single_turn_yields_tokens_incrementally(self):
        # 本地模式 + 单轮：应逐 token 透传，且向 LLM 请求 stream=True
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False):
            captured["stream"] = stream
            return iter(["Hello ", "world", "!"])

        self.llm._run_llm_inference = fake_inference
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hello"))
        self.assertEqual(captured.get("stream"), True)
        self.assertEqual(chunks, ["Hello ", "world", "!"])

    def test_stream_single_turn_parses_dict_chunks(self):
        # 本地模型可能返回 dict chunk：只取 delta.content，跳过空/无 choices
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        self.llm._run_llm_inference = lambda *a, **k: iter([
            {"choices": [{"delta": {"content": "ab"}}]},
            {"choices": [{"delta": {}}]},
            {"choices": []},
        ])
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks, ["ab"])

    def test_stream_yields_error_on_failure(self):
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL

        def boom(*a, **k):
            raise RuntimeError("nope")

        self.llm._run_llm_inference = boom
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks, ["[ERROR] nope"])

    def test_resolve_skill_language(self):
        self.llm._load_remote_config = lambda: {"skill_language": "cn"}
        self.assertEqual(self.skill._resolve_skill_language("any english text"), "cn")
        self.llm._load_remote_config = lambda: {"skill_language": "auto"}
        self.assertEqual(self.skill._resolve_skill_language("你好，世界"), "cn")
        self.assertEqual(self.skill._resolve_skill_language("hello world"), "en")


if __name__ == '__main__':
    unittest.main()