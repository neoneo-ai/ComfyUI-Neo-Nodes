# SPDX-License-Identifier: Apache-2.0
"""recipes 首帧尺寸端点（/rs_recipes/image_sizes）的离线单测。

server/folder_paths/gallery/bookmark/gallery_lora/util 用桩模块替换，CUSTOM_DIR/PRESETS_DIR
指向临时目录，验证批量读图尺寸：input/ 优先、配方 assets 兜底、越界名与缺失跳过、
filenames 非数组报错。"""

import asyncio
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest

from PIL import Image

_TMP = tempfile.mkdtemp(prefix="neo_recipes_image_sizes_")
_INPUT_DIR = os.path.join(_TMP, "input")
os.makedirs(_INPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server


def _annotated_filepath(name, base_dir):
    """与核心一致：拼路径并拒绝越出 base_dir 的名字。"""
    base = os.path.abspath(base_dir)
    path = os.path.abspath(os.path.join(base, str(name).replace("/", os.sep)))
    if os.path.commonpath([base, path]) != base:
        raise ValueError("escapes base")
    return path


_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: os.path.join(_TMP, "output")
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")
_folder_paths.get_annotated_filepath = _annotated_filepath


class StubFolderPathsMixin:
    """folder_paths 桩只在用例期间挂到 sys.modules：其它测试文件也用同名桩并各自按自己的
    临时目录解析路径，长期占用会互相覆盖（导入期挂上会让对端的路径断言全错）。"""

    def install_folder_paths(self):
        self._prev = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = _folder_paths

    def restore_folder_paths(self):
        if self._prev is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._prev


PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_recipes_image_sizes_pkg"
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
        return self._payload


def _body(resp):
    return json.loads(resp.body)


def _write_png(path, size):
    Image.new("RGB", size, (10, 20, 30)).save(path)


class ImageSizesTests(StubFolderPathsMixin, unittest.TestCase):
    def setUp(self):
        self.install_folder_paths()
        self._tmp = tempfile.mkdtemp(prefix="neo_recipes_image_sizes_routes_")
        self.recipes_dir = os.path.join(self._tmp, "recipes")
        self.custom = os.path.join(self.recipes_dir, "custom")
        self.presets = os.path.join(self.recipes_dir, "presets")
        os.makedirs(self.custom)
        os.makedirs(self.presets)
        self._orig = (recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.RECIPES_DIR = pathlib.Path(self.recipes_dir)
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)

    def tearDown(self):
        self.restore_folder_paths()
        recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._orig

    def _call(self, payload):
        return _body(_run_async(recipes.rs_recipes_image_sizes(_FakeRequest(payload))))

    def _make_recipe(self, name):
        d = os.path.join(self.custom, name)
        os.makedirs(os.path.join(d, "assets"))
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": name}, f)
        return d

    def test_reads_input_images(self):
        _write_png(os.path.join(_INPUT_DIR, "a.png"), (160, 120))
        _write_png(os.path.join(_INPUT_DIR, "b.png"), (828, 827))
        out = self._call({"filenames": ["a.png", "b.png"]})
        self.assertTrue(out["success"])
        self.assertEqual(
            [(s["filename"], s["width"], s["height"]) for s in out["sizes"]],
            [("a.png", 160, 120), ("b.png", 828, 827)],
        )

    def test_recipe_asset_fallback(self):
        # input/ 里没有、配方 assets/ 里有的首帧 → 兜底读到
        d = self._make_recipe("rec-x")
        _write_png(os.path.join(d, "assets", "story.png"), (736, 736))
        out = self._call({"filenames": ["story.png"], "recipe": "rec-x"})
        self.assertEqual(out["sizes"], [{"filename": "story.png", "width": 736, "height": 736}])

    def test_input_takes_priority_over_asset(self):
        d = self._make_recipe("rec-y")
        _write_png(os.path.join(_INPUT_DIR, "dup.png"), (100, 50))
        _write_png(os.path.join(d, "assets", "dup.png"), (200, 40))
        out = self._call({"filenames": ["dup.png"], "recipe": "rec-y"})
        self.assertEqual(out["sizes"], [{"filename": "dup.png", "width": 100, "height": 50}])

    def test_skips_missing_and_traversal(self):
        _write_png(os.path.join(_INPUT_DIR, "ok.png"), (32, 64))
        out = self._call({"filenames": ["missing.png", "../evil.png", "", "ok.png"]})
        self.assertEqual(out["sizes"], [{"filename": "ok.png", "width": 32, "height": 64}])

    def test_non_list_filenames_rejected(self):
        resp = _run_async(recipes.rs_recipes_image_sizes(_FakeRequest({"filenames": "a.png"})))
        self.assertEqual(resp.status, 400)


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

recipes = _load("recipes", "recipes.py")


if __name__ == "__main__":
    unittest.main()