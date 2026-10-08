# SPDX-License-Identifier: Apache-2.0
"""bookmark：C 站收藏列表的游标翻页。

C 站收藏列表只认 cursor 翻页（page / skip 会被忽略并重复返回第一页），所以目标页
必须沿缓存里的游标链走过去；旧缓存没有游标链时按未命中重走。
"""
from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import asyncio
import os
import sys
import json
import time
import types
import unittest

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# ---- 桩：bookmark 的顶层依赖（server 路由装饰器 / folder_paths）----
_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f))))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: []
_folder_paths.get_folder_paths = lambda folder: []
sys.modules["folder_paths"] = _folder_paths

_PKG = "_neo_bookmark_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name):
    import importlib.util as iu
    spec = iu.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, f"{name}.py"))
    mod = iu.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


bookmark = _load("bookmark")


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeRequest:
    def __init__(self, data):
        self._data = data

    async def json(self):
        return self._data


def _body(ids, next_cursor):
    return {"items": [{"id": i, "name": f"m{i}"} for i in ids],
            "metadata": {"nextCursor": next_cursor} if next_cursor else {}}


class CivitaiListCursorTests(unittest.TestCase):
    def setUp(self):
        self._orig = (bookmark._is_civitai_bookmark_enabled, bookmark._civitai_api_key,
                      bookmark._civitai_get, bookmark._civitai_local_covers,
                      bookmark._civitai_cover_from_model, bookmark._load_bookmark_list_cache,
                      bookmark._save_bookmark_list_cache, bookmark.aiohttp.ClientSession)
        self.cache = {"ts": time.time(), "pages": {}}
        self.calls = []
        self.responses = []
        bookmark._is_civitai_bookmark_enabled = lambda: True
        bookmark._civitai_api_key = lambda: "k"
        bookmark._civitai_local_covers = lambda mid, name: []
        bookmark._civitai_cover_from_model = lambda m: ""
        bookmark._load_bookmark_list_cache = lambda: self.cache
        bookmark._save_bookmark_list_cache = lambda data: self.cache.update(data)
        bookmark.aiohttp.ClientSession = lambda *a, **k: _FakeSession()

        async def fake_get(session, path, params, api_key):
            self.calls.append(dict(params))
            return 200, self.responses[len(self.calls) - 1]

        bookmark._civitai_get = fake_get

    def tearDown(self):
        (bookmark._is_civitai_bookmark_enabled, bookmark._civitai_api_key,
         bookmark._civitai_get, bookmark._civitai_local_covers,
         bookmark._civitai_cover_from_model, bookmark._load_bookmark_list_cache,
         bookmark._save_bookmark_list_cache, bookmark.aiohttp.ClientSession) = self._orig

    def _list(self, page, refresh=False):
        resp = asyncio.run(bookmark.neo_bookmark_civitai_list(
            _FakeRequest({"page": page, "refresh": refresh})))
        return json.loads(resp.body)

    def test_target_page_walks_cursor_chain(self):
        self.responses = [_body([1, 2], "C1"), _body([3, 4], "C2")]
        out = self._list(1)
        self.assertEqual([it["id"] for it in out["items"]], [3, 4])
        self.assertEqual(out["page"], 1)
        self.assertEqual(self.calls[0].get("cursor"), None, "首页不应带游标")
        self.assertEqual(self.calls[1]["cursor"], "C1", "第二页未沿游标链走")
        self.assertEqual(self.cache["pages"]["0"]["next_cursor"], "C1")
        self.assertEqual(self.cache["pages"]["1"]["next_cursor"], "C2")

    def test_cached_page_served_without_requests(self):
        self.cache["pages"]["0"] = {"items": [{"id": 9, "name": "cached"}],
                                    "has_more": True, "next_cursor": "C1"}
        out = self._list(0)
        self.assertEqual([it["id"] for it in out["items"]], [9])
        self.assertTrue(out["has_more"])
        self.assertEqual(self.calls, [], "命中缓存不应请求 C 站")

    def test_legacy_cache_without_cursor_is_refetched(self):
        # 旧缓存没有游标链，直接拿去翻页会重复返回第一页 → 必须重走
        self.cache["pages"]["0"] = {"items": [{"id": 9, "name": "legacy"}], "has_more": True}
        self.responses = [_body([1, 2], "C1"), _body([3, 4], "")]
        out = self._list(1)
        self.assertEqual([it["id"] for it in out["items"]], [3, 4])
        self.assertEqual(len(self.calls), 2)

    def test_bad_key_reports_401(self):
        async def fake_get(session, path, params, api_key):
            return 401, None

        bookmark._civitai_get = fake_get
        resp = asyncio.run(bookmark.neo_bookmark_civitai_list(_FakeRequest({"page": 0})))
        self.assertEqual(resp.status, 401)


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
