# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - LAYA Router Unit Tests

import os
import sys
import types
import unittest
from unittest.mock import patch, MagicMock

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, '..', '..'))
sys.path.insert(0, _COMFY_ROOT)

_PKG_NAME = "_neo_nodes_test_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg

import importlib
laya_router = importlib.import_module(f"{_PKG_NAME}.laya_router")


class TestLayaRouterAvailability(unittest.TestCase):
    """测试 LAYA 路由器的可用性和降级行为。"""

    def test_is_available_returns_bool(self):
        result = laya_router.is_available()
        self.assertIsInstance(result, bool)

    def test_classify_empty_text_returns_none(self):
        result = laya_router.classify("", {"q": {"type": "choice", "criteria": {"a": "x"}}})
        self.assertIsNone(result)

    def test_classify_whitespace_text_returns_none(self):
        result = laya_router.classify("   ", {"q": {"type": "choice", "criteria": {"a": "x"}}})
        self.assertIsNone(result)

    def test_classify_not_available_returns_none(self):
        """LAYA 未安装时 classify 应返回 None（不抛异常）。"""
        with patch.object(laya_router, '_router_instance') as inst:
            inst.available = False
            inst.classify = lambda text, questions: None
            result = laya_router.classify("test text", {"q": {"type": "choice", "criteria": {"a": "x"}}})
            self.assertIsNone(result)

    def test_classify_with_mocked_router(self):
        """模拟 LAYA 路由器返回分类结果。"""
        with patch.object(laya_router, '_router_instance') as inst:
            inst.available = True
            inst.classify = lambda text, questions: {
                "skill": {"value": "chinese_ancient_fantasy", "confidence": 0.91}
            }
            result = laya_router.classify("古风美女", {"skill": {"type": "choice", "criteria": {"a": "x"}}})
            self.assertIsNotNone(result)
            self.assertEqual(result["skill"]["value"], "chinese_ancient_fantasy")
            self.assertAlmostEqual(result["skill"]["confidence"], 0.91)

    def test_classify_parsing_choice_format(self):
        """验证解析 LAYA 实际返回的 choice 格式。"""
        router = laya_router._LayaRouter()
        router._router = MagicMock()
        router._router.predict.return_value = {
            "answers": {
                "title": {
                    "type": "choice",
                    "choice": "a cat in the rain",
                    "probabilities": {"a cat in the rain": 0.88, "night city": 0.12},
                    "confidence": 0.48,
                    "answer_confidence": 0.88,
                }
            }
        }
        result = router.classify("a cat in the rain, night city", {"title": {"type": "choice", "criteria": {}}})
        self.assertIsNotNone(result)
        self.assertEqual(result["title"]["value"], "a cat in the rain")
        self.assertAlmostEqual(result["title"]["confidence"], 0.88)


class TestLayaRouterConfig(unittest.TestCase):
    """测试配置文件加载。"""

    def test_load_config_default(self):
        cfg = laya_router._load_config()
        self.assertIsInstance(cfg, dict)
        self.assertIn("enabled", cfg)

    def test_load_config_disabled(self):
        with patch.object(laya_router, 'CONFIG_PATH', '/nonexistent/path.json'):
            cfg = laya_router._load_config()
            self.assertTrue(cfg.get("enabled", True))


class TestSplitTitleCandidates(unittest.TestCase):
    """测试 split_title_candidates 分段逻辑。"""

    def _split(self, text, **kw):
        from importlib import import_module
        pl = import_module(f"{_PKG_NAME}.prompt_lines")
        return pl.split_title_candidates(text, **kw)

    def test_chinese_prompt(self):
        segs = self._split("一位年轻的中国古代女子，身着华丽汉服，站在桃花树下，春风拂面")
        self.assertIn("身着华丽汉服", segs)
        self.assertIn("站在桃花树下", segs)
        # 第一段含数量词但不会被过滤（只过滤纯质量词）
        self.assertEqual(len(segs), 4)

    def test_english_prompt(self):
        segs = self._split("a beautiful cat sitting on a windowsill, soft morning light, shallow depth of field")
        self.assertEqual(len(segs), 3)
        self.assertEqual(segs[0], "a beautiful cat sitting on a windowsill")

    def test_quality_words_filtered(self):
        segs = self._split("masterpiece, best quality, 8k, a dragon flying over mountains, epic lighting")
        # masterpiece / best quality / 8k 被过滤
        self.assertEqual(segs[0], "a dragon flying over mountains")
        self.assertEqual(len(segs), 2)

    def test_short_segments_skipped(self):
        segs = self._split("a, b, a cat in a garden, sunny day")
        # "a" 和 "b" 长度 < 2 被跳过
        self.assertEqual(segs[0], "a cat in a garden")

    def test_max_segments_limit(self):
        segs = self._split("one, two, three, four, five, six, seven")
        self.assertEqual(len(segs), 5)

    def test_empty_text(self):
        segs = self._split("")
        self.assertEqual(segs, [])


if __name__ == "__main__":
    unittest.main()
