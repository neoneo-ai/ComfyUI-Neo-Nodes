# SPDX-License-Identifier: Apache-2.0
"""recipes 导演「故事生成 / 分镜拆分」后端逻辑的离线单测。

不依赖 ComfyUI 运行中的服务器与真实 LLM：server/folder_paths 用桩模块替换，
recipes 的 gallery/bookmark/gallery_lora/util 依赖用假模块；`_director_llm` 通过
桩 `_PKG.llm.run_llm_task` 注入可控返回，验证端点组装、JSON 解析容错与多模态回退。"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_recipes_dirllm_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")
_folder_paths.get_annotated_filepath = lambda name, base_dir: os.path.join(base_dir, str(name).replace("/", os.sep))
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_recipes_dirllm_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}
_gallery._copy_media_to_input = lambda src, fname: (fname, False)
sys.modules[f"{_PKG}.gallery"] = _gallery
setattr(_pkg, "gallery", _gallery)

_bookmark = types.ModuleType(f"{_PKG}.bookmark")
_bookmark._download_bytes = lambda *a, **k: b""
_bookmark._media_ext_from_url_or_bytes = lambda *a, **k: ".png"
sys.modules[f"{_PKG}.bookmark"] = _bookmark
setattr(_pkg, "bookmark", _bookmark)

_gallery_lora = types.ModuleType(f"{_PKG}.gallery_lora")
_gallery_lora.LORA_CACHE_DIR = os.path.join(_TMP, "lora_cache")
_gallery_lora._load_lora_index = lambda *a, **k: {}
sys.modules[f"{_PKG}.gallery_lora"] = _gallery_lora
setattr(_pkg, "gallery_lora", _gallery_lora)

_util = types.ModuleType(f"{_PKG}.util")
_util._extract_media_metadata = lambda *a, **k: {}
_util._json_safe = lambda v: v
sys.modules[f"{_PKG}.util"] = _util
setattr(_pkg, "util", _util)

# llm 桩：run_llm_task 由测试用例按需替换（记录调用参数，便于验证多模态回退）
_llm_calls = []


def _default_run_llm_task(task_name, text, images=None, **kw):
    _llm_calls.append({"task": task_name, "text": text, "images": images})
    if task_name == "director_story":
        return {"status": "success", "story": "生成的故事正文"}
    if task_name == "director_optimize":
        return {"status": "success", "prompts": json.dumps(["优化段1", "优化段2"])}
    return {"status": "success", "segments": json.dumps([{"prompt": "p1", "duration_sec": 5}, {"prompt": "p2", "duration_sec": 5}])}


_llm = types.ModuleType(f"{_PKG}.llm")
_llm.run_llm_task = _default_run_llm_task
sys.modules[f"{_PKG}.llm"] = _llm
setattr(_pkg, "llm", _llm)

recipes = _load("recipes", "recipes.py")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


# ===========================================================================
# 纯函数：_parse_segments / _read_input_image_bytes
# ===========================================================================
class ParseSegmentsTests(unittest.TestCase):
    def test_plain_json_array(self):
        raw = '[{"prompt": "a", "duration_sec": 5}, {"prompt": "b", "duration_sec": 10}]'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "a", "duration_sec": 5}, {"prompt": "b", "duration_sec": 10}])

    def test_markdown_wrapped(self):
        raw = '```json\n[{"prompt": "x", "duration_sec": 8}]\n```'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "x", "duration_sec": 8}])

    def test_surrounding_prose(self):
        raw = '好的，以下是分镜：\n[{"prompt": "y", "duration_sec": 15}]\n希望有帮助。'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "y", "duration_sec": 15}])

    def test_invalid_returns_empty(self):
        self.assertEqual(recipes._parse_segments("not json"), [])
        self.assertEqual(recipes._parse_segments('{"a": 1}'), [])
        self.assertEqual(recipes._parse_segments(""), [])

    def test_skips_missing_prompt_and_bad_duration(self):
        raw = '[{"prompt": "", "duration_sec": 5}, {"prompt": "ok", "duration_sec": "bad"}, {"no_prompt": 1}]'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "ok", "duration_sec": 0}])


class RefHelpersTests(unittest.TestCase):
    def test_read_input_image_bytes_missing_returns_none(self):
        self.assertIsNone(recipes._read_input_image_bytes(""))
        self.assertIsNone(recipes._read_input_image_bytes("../evil.png"))
        self.assertIsNone(recipes._read_input_image_bytes("no_such_file.png"))

    def test_read_input_image_bytes_reads_file(self):
        p = os.path.join(_INPUT_DIR, "img.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG-bytes")
        self.assertEqual(recipes._read_input_image_bytes("img.png"), b"\x89PNG-bytes")


# ===========================================================================
# 端点：故事生成 / 分镜拆分 + 多模态回退
# ===========================================================================
class GenerateStoryEndpointTests(unittest.TestCase):
    def test_success(self):
        req = _FakeRequest({"idea": "一只机器猫找家"})
        resp = _run_async(recipes.rs_recipes_director_generate_story(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["story"], "生成的故事正文")
        call = _llm_calls[-1]
        self.assertIn("一只机器猫找家", call["text"])
        self.assertIsNone(call["images"], "故事生成不带参考图")

    def test_refs_ignored(self):
        # 旧请求体可能仍带 characters/backgrounds：后端忽略，不再喂给 LLM（一致性由 r2i 图片分镜负责）
        req = _FakeRequest({"idea": "一只机器猫找家",
                            "characters": [{"filename": "cat.png", "desc": "橘色机器猫"}]})
        resp = _run_async(recipes.rs_recipes_director_generate_story(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        call = _llm_calls[-1]
        self.assertNotIn("橘色机器猫", call["text"])
        self.assertIsNone(call["images"])

    def test_empty_idea_rejected(self):
        req = _FakeRequest({"idea": "   "})
        resp = _run_async(recipes.rs_recipes_director_generate_story(req))
        self.assertEqual(resp.status, 400)

    def test_bad_json_rejected(self):
        req = _FakeRequest(ValueError("bad json"))
        resp = _run_async(recipes.rs_recipes_director_generate_story(req))
        self.assertEqual(resp.status, 400)


class SplitSegmentsEndpointTests(unittest.TestCase):
    def test_success_parses_segments(self):
        req = _FakeRequest({"story": "场景一…", "segment_seconds": 10})
        resp = _run_async(recipes.rs_recipes_director_split_segments(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(len(data["segments"]), 2)
        self.assertIn("约 10 秒", _llm_calls[-1]["text"])

    def test_empty_story_rejected(self):
        req = _FakeRequest({"story": ""})
        resp = _run_async(recipes.rs_recipes_director_split_segments(req))
        self.assertEqual(resp.status, 400)

    def test_unparseable_result_rejected(self):
        original = _llm.run_llm_task

        def _bad(task_name, text, images=None, **kw):
            return {"status": "success", "segments": "这不是 JSON"}

        _llm.run_llm_task = _bad
        try:
            req = _FakeRequest({"story": "故事"})
            resp = _run_async(recipes.rs_recipes_director_split_segments(req))
            self.assertEqual(resp.status, 422)
        finally:
            _llm.run_llm_task = original

    def test_refs_ignored_no_images(self):
        """拆分不再带参考图：旧请求体里的 backgrounds 被忽略（无图片字节、文本无 <imageN>）。"""
        original = _llm.run_llm_task
        calls = []

        def _rec(task_name, text, images=None, **kw):
            calls.append((text, images))
            return {"status": "success", "segments": '[{"prompt": "ok", "duration_sec": 5}]'}

        _llm.run_llm_task = _rec
        try:
            p = os.path.join(_INPUT_DIR, "ref.png")
            with open(p, "wb") as f:
                f.write(b"imgbytes")
            req = _FakeRequest({"story": "故事", "backgrounds": [{"filename": "ref.png"}]})
            resp = _run_async(recipes.rs_recipes_director_split_segments(req))
            data = json.loads(resp.body)
            self.assertTrue(data["success"])
            self.assertEqual(len(calls), 1)
            text, images = calls[0]
            self.assertIsNone(images, "拆分不再发送参考图字节")
            self.assertNotIn("<image", text)
        finally:
            _llm.run_llm_task = original


class ParsePromptListTests(unittest.TestCase):
    def test_plain_json_array(self):
        self.assertEqual(recipes._parse_prompt_list('["a", "b"]'), ["a", "b"])

    def test_markdown_wrapped_and_prose(self):
        raw = '好的：\n```json\n["p1", "p2"]\n```\n以上。'
        self.assertEqual(recipes._parse_prompt_list(raw), ["p1", "p2"])

    def test_invalid_returns_empty(self):
        self.assertEqual(recipes._parse_prompt_list("not json"), [])
        self.assertEqual(recipes._parse_prompt_list('{"a": 1}'), [])
        self.assertEqual(recipes._parse_prompt_list(""), [])


class OptimizePromptsEndpointTests(unittest.TestCase):
    def test_success_returns_prompts(self):
        req = _FakeRequest({
            "segments": [
                {"prompt": "段一", "duration_sec": 5, "refs": {"images": ["a.png", "b.png"], "videos": ["v.mp4"]}},
                {"prompt": "段二", "duration_sec": 8},
            ],
            "mode": "r2v",
        })
        resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["prompts"], ["优化段1", "优化段2"])
        text = _llm_calls[-1]["text"]
        self.assertIn("生成模式：r2v", text)
        self.assertIn("<Picture 1>…<Picture 2>", text)
        self.assertIn("<Video 1>", text)
        self.assertIn("第 1 段（约 5 秒）", text)

    def test_empty_segments_rejected(self):
        resp = _run_async(recipes.rs_recipes_director_optimize_prompts(_FakeRequest({"segments": []})))
        self.assertEqual(resp.status, 400)

    def test_missing_prompt_rejected(self):
        req = _FakeRequest({"segments": [{"prompt": "ok"}, {"prompt": ""}]})
        resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
        self.assertEqual(resp.status, 400)

    def test_count_mismatch_rejected(self):
        original = _llm.run_llm_task

        def _bad(task_name, text, images=None, **kw):
            return {"status": "success", "prompts": '["只有一段"]'}

        _llm.run_llm_task = _bad
        try:
            req = _FakeRequest({"segments": [{"prompt": "a"}, {"prompt": "b"}]})
            resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
            self.assertEqual(resp.status, 422)
        finally:
            _llm.run_llm_task = original

    def test_multimodal_sends_image_bytes(self):
        """逐段参考图存在于 input/ 时，LLM 调用应带上图片字节（多模态）。"""
        original = _llm.run_llm_task
        calls = []

        def _one(task_name, text, images=None, **kw):
            calls.append(images)
            return {"status": "success", "prompts": '["优化后的段一"]'}

        _llm.run_llm_task = _one
        try:
            p = os.path.join(_INPUT_DIR, "opt_ref.png")
            with open(p, "wb") as f:
                f.write(b"opt-bytes")
            req = _FakeRequest({"segments": [{"prompt": "段一", "duration_sec": 5, "refs": {"images": ["opt_ref.png"]}}]})
            resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
            data = json.loads(resp.body)
            self.assertTrue(data["success"])
            self.assertEqual(len(data["prompts"]), 1)
            self.assertTrue(calls[0])   # 逐段参考图存在 → LLM 调用带图片字节
        finally:
            _llm.run_llm_task = original


if __name__ == "__main__":
    unittest.main()

