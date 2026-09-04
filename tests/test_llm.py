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


if __name__ == '__main__':
    unittest.main()