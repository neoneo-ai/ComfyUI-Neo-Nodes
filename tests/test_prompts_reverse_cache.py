# SPDX-License-Identifier: Apache-2.0
"""reverse_prompt 缓存按语言失效（离线单测）。

切换语言即强制重新反推：同名 .txt 存在且记录语言与请求一致才命中缓存，
否则（切语言 / 旧缓存无语言标记）跳过缓存重新生成。
"""

import asyncio
import json
import os
import sys
import types
import tempfile
import unittest
from pathlib import Path

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, "..", ".."))
sys.path.insert(0, _COMFY_ROOT)

_PKG_NAME = "_neo_prompts_cache_pkg"
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


_prev_server = sys.modules.get("server")
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

_prompts_import_error = ""
try:
    import importlib
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    _reverse_cache_hit = prompts_mod._reverse_cache_hit
    PROMPTS_AVAILABLE = True
except Exception as _e:
    prompts_mod = None
    _reverse_cache_hit = None
    PROMPTS_AVAILABLE = False
    _prompts_import_error = str(_e)
finally:
    if _prev_server is None:
        sys.modules.pop("server", None)
    else:
        sys.modules["server"] = _prev_server


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompts module unavailable: {_prompts_import_error}")
class ReverseCacheHitTests(unittest.TestCase):
    """_reverse_cache_hit：同名 .txt 存在且语言匹配才命中，切语言/无标记则需重新反推。"""

    def _mk(self, name, text=None, lang=None):
        d = tempfile.mkdtemp(prefix="neo_rp_cache_")
        img = Path(d) / f"{name}.png"
        img.write_bytes(b"\x89PNG fake")
        txt_path = img.with_suffix(".txt")
        lang_path = img.with_suffix(".rp-lang")
        if text is not None:
            txt_path.write_text(text, encoding="utf-8")
        if lang is not None:
            lang_path.write_text(lang, encoding="utf-8")
        return txt_path, lang_path

    def test_no_txt_needs_regenerate(self):
        txt_path, lang_path = self._mk("shot")
        self.assertIsNone(_reverse_cache_hit(txt_path, lang_path, "zh"))

    def test_same_language_hits_cache(self):
        txt_path, lang_path = self._mk("shot", text="一个红发女孩", lang="zh")
        self.assertEqual(_reverse_cache_hit(txt_path, lang_path, "zh"), "一个红发女孩")

    def test_switched_language_needs_regenerate(self):
        txt_path, lang_path = self._mk("shot", text="一个红发女孩", lang="zh")
        self.assertIsNone(_reverse_cache_hit(txt_path, lang_path, "en"))

    def test_legacy_cache_without_lang_marker_needs_regenerate(self):
        # 旧缓存只有 .txt、无 .rp-lang 标记：视为语言未知，强制重新反推
        txt_path, lang_path = self._mk("shot", text="a red-haired girl")
        self.assertIsNone(_reverse_cache_hit(txt_path, lang_path, "zh"))

    def test_zh_system_prompt_is_chinese(self):
        # 中文系统提示词必须明确中文输出，且不含英文质量词示例（否则 LLM 会被带成英文）
        sp = prompts_mod._reverse_system_prompt("zh")
        self.assertIn("使用中文生成", sp)
        self.assertNotIn("masterpiece", sp)

    def test_en_system_prompt_uses_skill_default(self):
        self.assertEqual(prompts_mod._reverse_system_prompt("en"), prompts_mod.LLM_TASKS["reverse_prompt"]["system"])


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompts module unavailable: {_prompts_import_error}")
class ReversePromptSSETests(unittest.TestCase):
    """rs_prompts_reverse_prompt：SSE 流式帧（缓存命中立即发正文 + meta + DONE）。"""

    def _req(self, payload):
        class _Req:
            async def json(self):
                return payload
        return _Req()

    @staticmethod
    async def _frames(gen):
        out = []
        async for raw in gen:
            text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            for line in text.split("\n"):
                if line.startswith("data: "):
                    out.append(line[6:])
        return out

    def test_cache_hit_streams_text_then_meta(self):
        import aiohttp.web as web_mod
        d = tempfile.mkdtemp(prefix="neo_rp_sse_")
        img = Path(d) / "shot.png"
        img.write_bytes(b"\x89PNG fake")
        img.with_suffix(".txt").write_text("一个红发女孩", encoding="utf-8")
        img.with_suffix(".rp-lang").write_text("zh", encoding="utf-8")

        # 注入假 gallery 模块（避免真实 import .gallery 的重依赖），供 endpoint 内 from .gallery import _find_source_media 使用
        gallery_name = f"{_PKG_NAME}.gallery"
        prev_gallery = sys.modules.get(gallery_name)
        fake_gallery = types.ModuleType(gallery_name)
        fake_gallery._find_source_media = lambda fn, sf: img
        sys.modules[gallery_name] = fake_gallery

        # 捕获 web.Response 的 body（async generator），直接消费以验证 SSE 帧
        captured = {}
        orig_response = web_mod.Response
        def spy_response(*a, **k):
            if k.get("body") is not None:
                captured["body"] = k["body"]
            return orig_response(*a, **k)
        web_mod.Response = spy_response
        try:
            asyncio.run(prompts_mod.rs_prompts_reverse_prompt(
                self._req({"filename": "shot.png", "subfolder": "Output", "language": "zh"})))
        finally:
            web_mod.Response = orig_response
            if prev_gallery is None:
                sys.modules.pop(gallery_name, None)
            else:
                sys.modules[gallery_name] = prev_gallery

        frames = asyncio.run(self._frames(captured["body"]))
        self.assertEqual(frames[-1], "[DONE]")
        texts = [json.loads(f) for f in frames if f != "[DONE]"]
        self.assertEqual(texts[0].get("text"), "一个红发女孩")
        self.assertEqual(texts[-1].get("meta", {}).get("txt_file"), "shot.txt")


if __name__ == "__main__":
    unittest.main()