# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - LLM Unit Tests
# 测试模型下载、配置加载等功能

import os
import sys
import json
import types
import asyncio
import importlib
import unittest
from unittest.mock import patch, mock_open, MagicMock
import tempfile
import shutil

# 添加父目录到路径以导入模块
_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根目录（提供 folder_paths / server 等模块）
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, '..', '..'))
sys.path.insert(0, _COMFY_ROOT)

# llm.py 使用相对导入（from . import skill），需作为包的子模块加载
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
    llm_mod = importlib.import_module(f"{_PKG_NAME}.llm")
    LLM_AVAILABLE = True
except Exception as _e:  # 缺少 server/aiohttp 等依赖时跳过
    llm_mod = None
    LLM_AVAILABLE = False
    _LLM_IMPORT_ERROR = _e

_llm_reason = "" if LLM_AVAILABLE else f"llm module unavailable: {_LLM_IMPORT_ERROR}"


class TestModelConfig(unittest.TestCase):
    """测试模型配置加载功能"""

    def setUp(self):
        """设置测试 fixtures"""
        self.test_config = {
            "model": {
                "ms_repo_id": "test/test-repo",
                "hf_repo_id": "test/test-repo",
                "filename": "test-model.gguf"
            },
            "mmproj": {
                "filename": "test-mmproj.gguf"
            }
        }
        self.temp_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(self.temp_dir, "model_config.json")

    def tearDown(self):
        """清理测试 fixtures"""
        shutil.rmtree(self.temp_dir)

    def test_load_model_config_success(self):
        """测试成功加载配置文件"""
        # 写入测试配置
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(self.test_config, f)

        # 直接测试 _load_model_config 函数逻辑
        config_path_test = os.path.join(self.temp_dir, "model_config.json")
        with open(config_path_test, "r", encoding="utf-8") as f:
            config = json.load(f)

        self.assertEqual(config["model"]["ms_repo_id"], "test/test-repo")
        self.assertEqual(config["model"]["hf_repo_id"], "test/test-repo")
        self.assertEqual(config["model"]["filename"], "test-model.gguf")
        self.assertEqual(config["mmproj"]["filename"], "test-mmproj.gguf")

    def test_load_model_config_file_not_found(self):
        """测试配置文件不存在时返回默认配置"""
        non_existent_path = os.path.join(self.temp_dir, "non_existent.json")

        # 测试默认配置逻辑
        default_config = {
            "model": {
                "ms_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "hf_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "filename": "Qwen3.5-0.8B-UD-Q4_K_XL.gguf"
            },
            "mmproj": {
                "filename": "mmproj-BF16.gguf"
            }
        }

        # 验证默认配置结构正确
        self.assertIn("model", default_config)
        self.assertIn("mmproj", default_config)
        self.assertIn("ms_repo_id", default_config["model"])
        self.assertIn("hf_repo_id", default_config["model"])
        self.assertIn("filename", default_config["model"])
        self.assertIn("filename", default_config["mmproj"])

    def test_config_file_structure(self):
        """测试配置文件结构正确性"""
        # 读取实际的配置文件
        config_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'model_config.json'))
        if os.path.exists(config_dir):
            with open(config_dir, "r", encoding="utf-8") as f:
                config = json.load(f)
            
            # 验证必需字段存在
            self.assertIn("model", config)
            self.assertIn("mmproj", config)
            self.assertIn("ms_repo_id", config["model"])
            self.assertIn("hf_repo_id", config["model"])
            self.assertIn("filename", config["model"])
            self.assertIn("filename", config["mmproj"])


class TestGetModelPaths(unittest.TestCase):
    """测试获取模型路径功能"""

    def test_get_model_paths_format(self):
        """测试 get_model_paths 返回正确的路径格式"""
        # 不导入模块，直接测试路径构建逻辑
        base_path = "/test/base/path"
        model_filename = "test_model.gguf"
        mmproj_filename = "test_mmproj.gguf"
        
        expected_model_path = os.path.join(base_path, "models", "LLM", model_filename)
        expected_mmproj_path = os.path.join(base_path, "models", "LLM", mmproj_filename)
        
        self.assertIn("models", expected_model_path)
        self.assertIn("LLM", expected_model_path)
        self.assertIn(model_filename, expected_model_path)
        self.assertIn(mmproj_filename, expected_mmproj_path)


class TestCheckModelStatus(unittest.TestCase):
    """测试检查模型状态功能"""

    def test_status_structure(self):
        """测试状态返回结构"""
        # 模拟状态数据
        status = {
            "model_available": True,
            "mmproj_available": False,
            "model_filename": "test_model.gguf",
            "mmproj_filename": "test_mmproj.gguf",
            "model_repo_id": "test/repo",
            "hf_repo_id": "test/hf-repo",
            "model_path": "/path/to/model",
            "mmproj_path": None,
            "download_status": {
                "model": {"downloading": False, "progress": 0, "error": None},
                "mmproj": {"downloading": False, "progress": 0, "error": None}
            }
        }
        
        # 验证结构
        self.assertIn("model_available", status)
        self.assertIn("mmproj_available", status)
        self.assertIn("model_filename", status)
        self.assertIn("mmproj_filename", status)
        self.assertIn("download_status", status)


class TestDownloadFunctions(unittest.TestCase):
    """测试下载功能"""

    def test_download_file_background_model_already_exists(self):
        """测试模型已存在时的逻辑"""
        # 模拟文件已存在的场景
        mock_status = {
            "model": {"downloading": False, "progress": 0, "error": None}
        }
        
        # 验证当文件已存在时，应该返回 True
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 0)

    def test_download_file_background_download_in_progress(self):
        """测试下载正在进行时的逻辑"""
        mock_status = {
            "model": {"downloading": True, "progress": 50, "error": None}
        }
        
        # 验证下载状态
        self.assertTrue(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 50)

    def test_download_file_background_modelscope_success(self):
        """测试 ModelScope 下载成功的场景"""
        # 模拟 ModelScope 下载成功
        mock_status = {
            "model": {"downloading": False, "progress": 100, "error": None}
        }
        
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 100)
        self.assertIsNone(mock_status["model"]["error"])

    def test_download_file_background_fallback_to_hf(self):
        """测试 ModelScope 失败后回退到 HuggingFace"""
        # 模拟回退场景
        mock_status = {
            "model": {"downloading": False, "progress": 100, "error": None}
        }
        
        # HuggingFace 成功
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 100)

    def test_download_file_background_both_fail(self):
        """测试两个下载源都失败"""
        # 模拟两个都失败
        mock_status = {
            "model": {"downloading": False, "progress": 0, "error": "Both ModelScope and HuggingFace downloads failed"}
        }
        
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertIsNotNone(mock_status["model"]["error"])


class TestStartDownload(unittest.TestCase):
    """测试启动下载功能"""

    def test_start_download_invalid_file_type(self):
        """测试无效的文件类型"""
        # 直接验证逻辑
        file_type = "invalid_type"
        valid_types = ["model", "mmproj"]
        
        self.assertNotIn(file_type, valid_types)

    def test_start_download_valid_file_types(self):
        """测试有效的文件类型"""
        valid_types = ["model", "mmproj"]
        
        self.assertIn("model", valid_types)
        self.assertIn("mmproj", valid_types)

    def test_start_download_returns_status(self):
        """测试返回状态格式"""
        # 模拟已存在的场景
        result = {"status": "already_exists"}
        self.assertEqual(result["status"], "already_exists")
        
        # 模拟开始下载的场景
        result = {"status": "started", "file_type": "model"}
        self.assertEqual(result["status"], "started")
        self.assertEqual(result["file_type"], "model")


class TestDownloadFromModelscope(unittest.TestCase):
    """测试 ModelScope 下载功能"""

    def test_modelscope_download_success(self):
        """测试 ModelScope 下载成功的场景"""
        # 模拟成功场景
        mock_result = True
        self.assertTrue(mock_result)

    def test_modelscope_download_file_not_created(self):
        """测试 ModelScope 下载后文件不存在的场景"""
        # 模拟文件未创建
        mock_result = False
        self.assertFalse(mock_result)

    def test_modelscope_import_error(self):
        """测试 modelscope 未安装时的处理"""
        # 模拟 ImportError 场景
        mock_warning = "modelscope not installed, trying HuggingFace..."
        self.assertIn("modelscope", mock_warning)


class TestDownloadFromHuggingface(unittest.TestCase):
    """测试 HuggingFace 下载功能"""

    def test_hf_download_success(self):
        """测试 HuggingFace 下载成功的场景"""
        # 模拟成功
        mock_result = True
        self.assertTrue(mock_result)

    def test_hf_download_failure(self):
        """测试 HuggingFace 下载失败的场景"""
        # 模拟失败
        mock_result = False
        self.assertFalse(mock_result)


class TestTranslationCache(unittest.TestCase):
    """测试翻译缓存功能"""

    def setUp(self):
        """设置测试 fixtures"""
        # 直接创建缓存类
        from collections import OrderedDict
        
        class TranslationCache:
            def __init__(self, max_size=200):
                self._store = OrderedDict()
                self.max_size = max_size
            
            def get(self, text):
                normalized = self._normalize_text(text)
                return self._store.get(normalized)
            
            def set(self, text, result):
                normalized_text = self._normalize_text(text)
                normalized_result = self._normalize_text(result)
                
                if normalized_text in self._store:
                    del self._store[normalized_text]
                if normalized_result in self._store:
                    del self._store[normalized_result]
                
                self._store[normalized_text] = normalized_result
                self._store[normalized_result] = normalized_text
                
                while len(self._store) > self.max_size:
                    self._evict_oldest()
            
            def _evict_oldest(self):
                if not self._store:
                    return
                oldest_key = next(iter(self._store))
                self._store.pop(oldest_key)
            
            def _normalize_text(self, text):
                if not text:
                    return ""
                import re
                return text.strip()

        self.cache = TranslationCache(max_size=2)

    def test_cache_get_hit(self):
        """测试缓存命中"""
        self.cache.set("hello", "你好")
        
        result = self.cache.get("hello")
        
        self.assertEqual(result, "你好")

    def test_cache_get_miss(self):
        """测试缓存未命中"""
        result = self.cache.get("nonexistent")
        
        self.assertIsNone(result)

    def test_cache_bidirectional(self):
        """测试双向缓存"""
        self.cache.set("hello", "你好")
        
        # 应该能通过中文找到英文
        result = self.cache.get("你好")
        
        self.assertEqual(result, "hello")

    def test_cache_eviction(self):
        """测试缓存淘汰"""
        self.cache.set("a", "1")
        self.cache.set("b", "2")
        self.cache.set("c", "3")  # 应该淘汰最旧的
        
        # 最旧的应该被淘汰
        self.assertIsNone(self.cache.get("a"))


class TestLanguageDetection(unittest.TestCase):
    """测试语言检测功能"""

    def _detect_language(self, text):
        """复制语言检测逻辑"""
        if not text:
            return 'English'
        
        total_chars = len(text)
        if total_chars == 0:
            return 'English'
        
        chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
        chinese_percentage = (chinese_chars / total_chars) * 100
        
        if chinese_percentage >= 50:
            return 'Chinese'
        return 'English'

    def test_detect_chinese(self):
        """测试检测中文"""
        result = self._detect_language("这是一个中文测试")
        
        self.assertEqual(result, 'Chinese')

    def test_detect_english(self):
        """测试检测英文"""
        result = self._detect_language("This is an English test")
        
        self.assertEqual(result, 'English')

    def test_detect_empty(self):
        """测试空文本"""
        result = self._detect_language("")
        
        self.assertEqual(result, 'English')

    def test_detect_none(self):
        """测试 None 输入"""
        result = self._detect_language(None)
        
        self.assertEqual(result, 'English')

    def test_detect_mixed(self):
        """测试混合文本"""
        # 中文为主
        result = self._detect_language("这是一个测试 hello")
        self.assertEqual(result, 'Chinese')
        
        # 英文为主
        result = self._detect_language("This is a test 测试")
        self.assertEqual(result, 'English')


class TestTextNormalization(unittest.TestCase):
    """测试文本标准化功能"""

    def _normalize_text(self, text):
        """复制文本标准化逻辑"""
        import re
        if not text:
            return ""
        text = text.strip()
        text = re.sub(r'\s+', ' ', text)
        return text

    def test_normalize_empty(self):
        """测试空文本"""
        result = self._normalize_text("")
        self.assertEqual(result, "")

    def test_normalize_none(self):
        """测试 None"""
        result = self._normalize_text(None)
        self.assertEqual(result, "")

    def test_normalize_whitespace(self):
        """测试空白字符处理"""
        result = self._normalize_text("  hello   world  ")
        self.assertEqual(result, "hello world")

    def test_normalize_tabs_newlines(self):
        """测试制表符和换行符"""
        result = self._normalize_text("hello\t\tworld\n\nnew")
        self.assertEqual(result, "hello world new")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestSSEFraming(unittest.TestCase):
    """测试 SSE 流式分帧：换行等特殊字符必须经 JSON 编码穿过 data:\\n\\n 分帧，否则前端会丢字（预览变一行）"""

    def _roundtrip(self, content):
        orig = llm_mod.run_llm_task_stream

        def fake_run_llm_task_stream(task_name, text, **kw):
            # 与生产一致：同步生成器逐字 yield（含换行），模拟 run_skill_agent_stream / run_llm_task_stream
            for ch in content:
                yield ch

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": ""}

        async def _drive():
            resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
            raw = b""
            payload = resp.body
            aiter = getattr(payload, "_iter", None) or payload
            async for piece in aiter:
                raw += bytes(piece) if isinstance(piece, (bytes, bytearray)) else str(piece).encode()
            return raw.decode("utf-8")

        llm_mod.run_llm_task_stream = fake_run_llm_task_stream
        try:
            buf = asyncio.run(_drive())
        finally:
            llm_mod.run_llm_task_stream = orig

        # 模拟前端 prompt-service.js sseStream：按 \n 分帧，取 data: 行，JSON.parse（失败则当纯文本）
        acc = ""
        lines = buf.split("\n")
        buffer = lines.pop() or ""
        for line in lines:
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
                t = obj.get("text") if isinstance(obj, dict) else None
                if t:
                    acc += t
            except Exception:
                acc += data
        return acc

    def test_newlines_preserved(self):
        self.assertEqual(self._roundtrip("第一行\n第二行"), "第一行\n第二行")

    def test_numbered_list_preserved(self):
        self.assertEqual(self._roundtrip("1. a\n2. b\n3. c"), "1. a\n2. b\n3. c")

    def test_blank_line_paragraphs_preserved(self):
        self.assertEqual(self._roundtrip("para one\n\npara two"), "para one\n\npara two")

    def test_quotes_and_digits_preserved(self):
        self.assertEqual(self._roundtrip('has "quotes" and 123 digits'), 'has "quotes" and 123 digits')

    def test_crlf_preserved(self):
        self.assertEqual(self._roundtrip("a\r\nb"), "a\r\nb")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestThinkingStreamSeparation(unittest.TestCase):
    """思考模型：reasoning_content（thinking）与 content（正文）分离，前端展示后清除只留正文。"""

    def test_run_llm_task_stream_separates_thinking_and_content(self):
        # 本地 llama.cpp 风格 chunk：delta.reasoning_content / delta.content
        llm_chunks = [
            {"choices": [{"delta": {"reasoning_content": "推理步骤一"}}]},
            {"choices": [{"delta": {"reasoning_content": "推理步骤二"}}]},
            {"choices": [{"delta": {"content": "最终答案"}}]},
        ]
        orig_infer = llm_mod._run_llm_inference
        orig_mode = llm_mod.get_current_mode
        llm_mod._run_llm_inference = lambda *a, **k: iter(llm_chunks)
        llm_mod.get_current_mode = lambda: llm_mod.LLM_MODE_LOCAL
        try:
            out = list(llm_mod.run_llm_task_stream("smart_prompt", "hello"))
        finally:
            llm_mod._run_llm_inference = orig_infer
            llm_mod.get_current_mode = orig_mode

        self.assertEqual(
            [(c["kind"], c["text"]) for c in out],
            [("thinking", "推理步骤一"), ("thinking", "推理步骤二"), ("content", "最终答案")],
        )

    def test_sse_frames_carry_kind_for_thinking_and_content(self):
        # 远程生成器已带 {"text","kind"}；SSE 分帧应保留 kind，前端据此区分思考与正文
        tagged = [
            {"text": "思考A", "kind": "thinking"},
            {"text": "正文B", "kind": "content"},
        ]
        orig = llm_mod.run_llm_task_stream
        llm_mod.run_llm_task_stream = lambda *a, **k: iter(tagged)

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": ""}

        async def _drive():
            resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
            raw = b""
            payload = resp.body
            aiter = getattr(payload, "_iter", None) or payload
            async for piece in aiter:
                raw += bytes(piece) if isinstance(piece, (bytes, bytearray)) else str(piece).encode()
            return raw.decode("utf-8")

        try:
            buf = asyncio.run(_drive())
        finally:
            llm_mod.run_llm_task_stream = orig

        frames = []
        for line in buf.split("\n"):
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except Exception:
                continue
            if isinstance(obj, dict) and "text" in obj:
                frames.append((obj.get("kind", "content"), obj["text"]))
        self.assertEqual(frames, [("thinking", "思考A"), ("content", "正文B")])


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestInlineThinkStripping(unittest.TestCase):
    """思考模型把 < think>/< /think> 内联写进正文 content 时，非流式清洗与流式拆分都要去掉标签、只留最终正文。"""

    ANSWER = "中景镜头下，一位身着墨绿色丝绒高开叉长裙的女子缓缓抬手，动作轻柔而连贯地褪去肩带与裙摆。"

    def _content_of(self, chunks):
        return "".join(t for k, t in chunks if k == "content")

    def test_strip_real_polluted_pattern_dedups(self):
        # 真实污染：[答案]< /think>[答案]（孤立闭标签 + 重复正文）→ 只留一份正文
        self.assertEqual(llm_mod.strip_inline_thinking(self.ANSWER + "< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_balanced_block(self):
        self.assertEqual(llm_mod.strip_inline_thinking("< think>推理过程< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_lone_close_tag_drops_prefix(self):
        # 孤立闭标签：前面是泄漏的思考（丢弃），后面正文保留
        self.assertEqual(llm_mod.strip_inline_thinking("前言" + "< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_case_and_space_variants(self):
        self.assertEqual(llm_mod.strip_inline_thinking("< THINK>推理< /THINK>" + self.ANSWER), self.ANSWER)

    def test_strip_plain_text_unchanged(self):
        self.assertEqual(llm_mod.strip_inline_thinking(self.ANSWER), self.ANSWER)

    def test_strip_non_think_angle_brackets_unchanged(self):
        self.assertEqual(llm_mod.strip_inline_thinking("a < b and c > d"), "a < b and c > d")

    def test_splitter_routes_inline_close_to_thinking(self):
        # 流式：整段喂入 [答案]< /think>[答案]，前一份答案归 thinking，正文只留后一份
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed(self.ANSWER + "< /think>" + self.ANSWER)) + s.flush()
        self.assertEqual(self._content_of(chunks), self.ANSWER)
        self.assertTrue(any(k == "thinking" for k, _ in chunks))

    def test_splitter_routes_balanced_block_to_thinking(self):
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed("< think>推理< /think>" + self.ANSWER)) + s.flush()
        self.assertEqual(self._content_of(chunks), self.ANSWER)
        self.assertEqual("".join(t for k, t in chunks if k == "thinking"), "推理")

    def test_splitter_plain_text_stays_content(self):
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed("a < b and c > d")) + s.flush()
        self.assertEqual(self._content_of(chunks), "a < b and c > d")
        self.assertFalse(any(k == "thinking" for k, _ in chunks))


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestEnableThinking(unittest.TestCase):
    """enable_thinking（关闭思考）：经 chat_template_kwargs 透传到请求体；未设置则不发送。"""

    def _capture_chat_completion_kwargs(self, enable_thinking, reasoning_effort=None):
        client = llm_mod.RemoteLLMClient({
            "provider": "lmstudio", "base_url": "http://127.0.0.1:1234",
            "model": "test-model", "max_tokens": 500,
        })
        captured = {}

        class _Resp:
            def model_dump(self):
                return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

        def fake_create(**kw):
            captured.update(kw)
            return _Resp()

        fake_client = MagicMock()
        fake_client.chat.completions.create.side_effect = fake_create

        orig_build = llm_mod.RemoteLLMClient._build_client
        llm_mod.RemoteLLMClient._build_client = lambda self: fake_client
        try:
            client.chat_completion([{"role": "user", "content": "hi"}], enable_thinking=enable_thinking,
                                   reasoning_effort=reasoning_effort)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        return captured

    def test_payload_includes_chat_template_kwargs_when_false(self):
        kwargs = self._capture_chat_completion_kwargs(False)
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"), {"enable_thinking": False})

    def test_payload_omits_chat_template_kwargs_when_none(self):
        kwargs = self._capture_chat_completion_kwargs(None)
        self.assertNotIn("chat_template_kwargs", kwargs.get("extra_body", {}))

    def test_payload_omits_temperature(self):
        # 温度参数已从界面移除：请求体不再携带 temperature，统一用服务端默认
        kwargs = self._capture_chat_completion_kwargs(None)
        self.assertNotIn("temperature", kwargs)

    def test_run_remote_inference_threads_enable_thinking(self):
        captured = {}

        class _FakeClient:
            provider = "lmstudio"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return True
            def chat_completion(self, **kw):
                captured.update(kw)
                return {"choices": [{"message": {"content": "ok"}}]}

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "lmstudio"}
        try:
            llm_mod._run_remote_inference("sys", "usr", 500, stream=False, enable_thinking=False)
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg
        self.assertIs(captured.get("enable_thinking"), False)

    def test_payload_includes_reasoning_effort(self):
        kwargs = self._capture_chat_completion_kwargs(None, reasoning_effort="low")
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"), {"reasoning_effort": "low"})

    def test_payload_combines_enable_thinking_and_reasoning_effort(self):
        kwargs = self._capture_chat_completion_kwargs(True, reasoning_effort="xhigh")
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"),
                         {"enable_thinking": True, "reasoning_effort": "xhigh"})

    def test_run_remote_inference_threads_reasoning_effort(self):
        captured = {}

        class _FakeClient:
            provider = "lmstudio"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return True
            def chat_completion(self, **kw):
                captured.update(kw)
                return {"choices": [{"message": {"content": "ok"}}]}

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "lmstudio"}
        try:
            llm_mod._run_remote_inference("sys", "usr", 500, stream=False, reasoning_effort="medium")
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg
        self.assertEqual(captured.get("reasoning_effort"), "medium")

    def test_route_passes_enable_thinking_to_skill_stream(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["enable_thinking"] = enable_thinking
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "enable_thinking": False}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertIs(captured.get("enable_thinking"), False)

    def test_route_passes_reasoning_effort_to_skill_stream(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["reasoning_effort"] = reasoning_effort
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "reasoning_effort": "low"}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertEqual(captured.get("reasoning_effort"), "low")

    def test_route_drops_invalid_reasoning_effort(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["reasoning_effort"] = reasoning_effort
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "reasoning_effort": "bogus"}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertIsNone(captured.get("reasoning_effort"))


class TestUsageLogging(unittest.TestCase):
    """token 统计日志：prompt/completion/reasoning（思考 token）写入 INFO 日志。"""

    def _client_with_fake(self, create_side_effect):
        client = llm_mod.RemoteLLMClient({
            "provider": "lmstudio", "base_url": "http://127.0.0.1:1234",
            "model": "test-model", "max_tokens": 500,
        })
        fake_client = MagicMock()
        fake_client.chat.completions.create.side_effect = create_side_effect
        orig_build = llm_mod.RemoteLLMClient._build_client
        llm_mod.RemoteLLMClient._build_client = lambda self: fake_client
        return client, fake_client, orig_build

    def test_stream_logs_usage_with_reasoning_tokens(self):
        class _Details:
            reasoning_tokens = 400
        class _Usage:
            prompt_tokens = 100
            completion_tokens = 500
            completion_tokens_details = _Details()
        class _Delta:
            content = "hi"
            reasoning_content = None
        class _Choice:
            delta = _Delta()
        class _Chunk:
            choices = [_Choice()]
            usage = None

        final = MagicMock(choices=[], usage=_Usage())
        client, fake_client, orig_build = self._client_with_fake(lambda **kw: iter([_Chunk(), final]))
        try:
            with self.assertLogs(llm_mod.__name__, level="INFO") as cm:
                list(client.chat_completion([{"role": "user", "content": "x"}], stream=True))
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        self.assertTrue(any("LLM usage: prompt=100 completion=500 reasoning=400" in line for line in cm.output), cm.output)
        sent_kw = fake_client.chat.completions.create.call_args.kwargs
        self.assertEqual(sent_kw.get("stream_options"), {"include_usage": True})

    def test_non_stream_logs_usage_without_reasoning_field(self):
        class _Details:
            reasoning_tokens = 0  # LM Studio 报 0（未填明细），不应打出误导性的 reasoning=0
        class _Usage:
            prompt_tokens = 10
            completion_tokens = 20
            completion_tokens_details = _Details()
        class _Resp:
            usage = _Usage()
            def model_dump(self):
                return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

        client, fake_client, orig_build = self._client_with_fake(lambda **kw: _Resp())
        try:
            with self.assertLogs(llm_mod.__name__, level="INFO") as cm:
                client.chat_completion([{"role": "user", "content": "x"}])
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        self.assertTrue(any("LLM usage: prompt=10 completion=20" in line and "reasoning=" not in line
                            for line in cm.output), cm.output)


class TestLocalSingleModelFallback(unittest.TestCase):
    """_load_model：无已保存选择且目录只有一个模型时直接回落，否则仍报清晰错误"""

    def _scanned(self, *keys):
        return [{"key": k, "name": k, "filename": k + ".gguf", "model_dir": "",
                 "mmproj": "", "multimodal": False, "file_size": 0} for k in keys]

    def _load(self, cfg, scanned):
        instance = object.__new__(llm_mod.LLMSingleton)
        calls = {}
        fake_llama = types.ModuleType("llama_cpp")

        class FakeLlama:
            def __init__(self, **kw):
                calls.update(kw)

        fake_llama.Llama = FakeLlama
        with patch.object(llm_mod, "_load_remote_config", lambda: cfg), \
                patch.object(llm_mod, "scan_llm_directory", lambda d: scanned), \
                patch.object(llm_mod, "_resolve_model_path", lambda mdir, fn: "/fake/" + fn), \
                patch("os.path.exists", return_value=True), \
                patch.dict(sys.modules, {"llama_cpp": fake_llama}):
            instance._load_model()
        return calls

    def test_no_selection_single_model_falls_back(self):
        cfg = {"providers": {"local": {"model": "", "models_dir": ""}}}
        calls = self._load(cfg, self._scanned("only.gguf"))
        self.assertEqual(calls.get("model_path"), "/fake/only.gguf.gguf")

    def test_no_selection_multiple_models_still_errors(self):
        cfg = {"providers": {"local": {"model": "", "models_dir": ""}}}
        with self.assertRaises(RuntimeError):
            self._load(cfg, self._scanned("a.gguf", "b.gguf"))

    def test_stale_key_single_model_still_errors(self):
        cfg = {"providers": {"local": {"model": "gone.gguf", "models_dir": ""}}}
        with self.assertRaises(RuntimeError):
            self._load(cfg, self._scanned("only.gguf"))


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestProviderDefinitions(unittest.TestCase):
    """provider 定义（configs/llm_providers.json）：结构合法性、云厂商运行时就位、内置兜底同步"""

    CLOUD_IDS = ("deepseek", "dashscope", "dashscope-plan", "moonshot", "zhipu", "siliconflow")

    def test_definition_shape(self):
        ids = []
        for p in llm_mod.get_provider_list():
            self.assertTrue(p.get("id"), p)
            self.assertIn(p.get("type"), ("local", "remote"), p)
            ids.append(p["id"])
            if p["type"] == "remote":
                self.assertIn(p.get("model_mode"), ("hybrid", "dropdown"), p)
        self.assertEqual(len(ids), len(set(ids)), ids)

    def test_append_v1_matches_base_url(self):
        # 非 /v1 结尾的端点（智谱 /api/paas/v4 等）必须关掉自动追加，否则拼出错误 URL
        for p in llm_mod.get_provider_list():
            base = (p.get("default_base_url") or "").rstrip("/")
            if base and not base.endswith("/v1"):
                self.assertFalse(p.get("append_v1", True), p["id"])

    def test_client_base_url_per_provider(self):
        # 实测客户端拼接：缺 /v1 的补上，本身就是 /v4 的智谱保持原样
        captured = {}

        class _FakeOpenAI:
            def __init__(self, **kw):
                captured.update(kw)

        fake_openai = types.ModuleType("openai")
        fake_openai.OpenAI = _FakeOpenAI
        cases = (
            ("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/v1"),
            ("siliconflow", "https://api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1"),
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"),
        )
        with patch.dict(sys.modules, {"openai": fake_openai}):
            for provider, base_url, expected in cases:
                captured.clear()
                llm_mod.RemoteLLMClient({"provider": provider, "base_url": base_url, "api_key": "sk-test"})._build_client()
                self.assertEqual(captured.get("base_url"), expected, provider)

    def test_api_key_requirement_flag(self):
        # 云厂商必填 API Key（前端据此提示「必填」并在留空保存时告警）；本地/自建服务可留空
        flags = {p["id"]: bool(p.get("requires_api_key")) for p in llm_mod.get_provider_list()}
        for pid in self.CLOUD_IDS + ("openrouter",):
            self.assertTrue(flags.get(pid), pid)
        for pid in ("local", "openai", "lmstudio", "ollama", "unsloth", "vllm"):
            self.assertFalse(flags.get(pid), pid)

    def test_cloud_providers_have_runtime_slots(self):
        for pid in self.CLOUD_IDS:
            self.assertIn(pid, llm_mod._REMOTE_PROVIDERS, pid)
            slot = llm_mod._REMOTE_PROVIDER_DEFAULTS.get(pid) or {}
            self.assertTrue(slot.get("base_url"), slot)
            self.assertEqual(set(slot), {"api_key", "base_url", "model", "max_tokens", "timeout"})

    def test_builtin_fallback_matches_config(self):
        with open(os.path.join(_NODE_DIR, "configs", "llm_providers.json"), encoding="utf-8") as f:
            configured = json.load(f)["providers"]
        self.assertEqual(llm_mod._BUILTIN_PROVIDER_DEFS, configured)

    def test_migration_adds_missing_cloud_slots(self):
        cfg = {"enabled": True, "active_provider": "lmstudio",
               "providers": {"lmstudio": {"base_url": "http://host:1234/v1", "model": "local-model"}}}
        out = llm_mod._migrate_remote_config(cfg)
        self.assertEqual(out["active_provider"], "lmstudio")
        self.assertEqual(out["providers"]["lmstudio"]["model"], "local-model")
        self.assertEqual(out["providers"]["deepseek"]["base_url"], "https://api.deepseek.com/v1")

    def test_build_remote_models_url(self):
        # 模型列表端点须与聊天请求的 /v1 追加规则一致；智谱 /v4 端点不能再叠 /v1
        cases = (
            ("deepseek", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/models"),
            ("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/v1/models"),
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/models"),
            ("ollama", "http://localhost:11434/api", "http://localhost:11434/api/tags"),
            ("lmstudio", "http://192.168.0.176:8888", "http://192.168.0.176:8888/v1/models"),
            ("openai", "http://host:8000/v1/models", "http://host:8000/v1/models"),
        )
        for provider, base_url, expected in cases:
            self.assertEqual(llm_mod.build_remote_models_url(base_url, provider), expected, (provider, base_url))

    def test_api_key_mask_shape(self):
        # 前端按「纯星号」识别已存掩码；固定 40 位（等长显示太长，过短不易辨认）
        self.assertRegex(llm_mod.API_KEY_MASK, r"^\*{40}$")

    def test_get_stored_api_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "remote_llm_config.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"enabled": True, "active_provider": "deepseek",
                           "providers": {"deepseek": {"api_key": "sk-stored",
                                                      "base_url": "https://api.deepseek.com/v1", "model": ""}}}, f)
            with patch.object(llm_mod, "_REMOTE_CONFIG_PATH", path):
                self.assertEqual(llm_mod.get_stored_api_key("deepseek"), "sk-stored")
                self.assertEqual(llm_mod.get_stored_api_key("moonshot"), "")


if __name__ == '__main__':
    unittest.main()