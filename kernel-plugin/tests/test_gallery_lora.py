# SPDX-License-Identifier: Apache-2.0
"""gallery_lora：Civitai 同步的「待同步目录」卡片状态。

设置里的同步目录名对不上任何 Lora（目录名写错）时不能显示成一直在获取；
该目录下的 Lora 全部失败时要把真实错误透出给卡片。
"""
from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import os
import sys
import json
import asyncio
import struct
import tempfile
import types
import unittest
from pathlib import Path

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# ---- 桩：gallery_lora 的顶层依赖（server 路由装饰器 / folder_paths）----
_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f))))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: []
_folder_paths.get_folder_paths = lambda folder: []
sys.modules["folder_paths"] = _folder_paths

_PKG = "_neo_gallery_lora_pkg"
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


gallery_lora = _load("gallery_lora")


class PendingSubdirTests(unittest.TestCase):
    """待同步目录卡片：目录不存在（忽略）/ 有待同步 Lora / 全部失败 / 已缓存 / 主开关关。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="neo_lora_pending_")
        self.cache = Path(self.tmp.name)
        self._orig = (gallery_lora.LORA_CACHE_DIR, gallery_lora._load_settings,
                      gallery_lora._collect_selected_loras, gallery_lora._load_lora_index)
        gallery_lora.LORA_CACHE_DIR = self.cache

    def tearDown(self):
        (gallery_lora.LORA_CACHE_DIR, gallery_lora._load_settings,
         gallery_lora._collect_selected_loras, gallery_lora._load_lora_index) = self._orig
        self.tmp.cleanup()

    def _setup(self, settings, loras_by_dir, index=None):
        gallery_lora._load_settings = lambda: settings
        gallery_lora._collect_selected_loras = lambda dirs: [rel for d in dirs for rel in loras_by_dir.get(d, [])]
        gallery_lora._load_lora_index = lambda: dict(index or {})

    def test_master_switch_off_returns_empty(self):
        self._setup({"civitai_lora_enabled": False, "lora_sync_dirs": ["Qwen"], "civitai_api_key": "k"}, {})
        self.assertEqual(gallery_lora._lora_pending_subdirs(), {})

    def test_dir_matching_no_lora_is_ignored(self):
        # 设置写 "Qwen"，loras 目录里只有 QwenImage2.1（被改名/写错）→ 忽略，不生成状态卡
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["Qwen"], "civitai_api_key": "k"}, {})
        self.assertEqual(gallery_lora._lora_pending_subdirs(), {})

    def test_pending_dir_keeps_loading_state(self):
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["QwenImage2.1"], "civitai_api_key": "k"},
                    {"QwenImage2.1": ["QwenImage2.1/a.safetensors"]})
        out = gallery_lora._lora_pending_subdirs()["QwenImage2.1"]
        self.assertTrue(out["pending"])
        self.assertEqual(out["civitai"], {"needs_api_key": False})

    def test_missing_api_key_beats_other_states(self):
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["QwenImage2.1"]},
                    {"QwenImage2.1": ["QwenImage2.1/a.safetensors"]})
        self.assertTrue(gallery_lora._lora_pending_subdirs()["QwenImage2.1"]["civitai"]["needs_api_key"])

    def test_failed_lora_surfaces_real_error(self):
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["QwenImage2.1"], "civitai_api_key": "k"},
                    {"QwenImage2.1": ["QwenImage2.1/a.safetensors", "QwenImage2.1/b.safetensors"]},
                    {"QwenImage2.1/b.safetensors": {"status": "failed", "error": "Civitai HTTP 0"}})
        out = gallery_lora._lora_pending_subdirs()["QwenImage2.1"]["civitai"]
        self.assertEqual(out["status"], "failed")
        self.assertEqual(out["error"], "Civitai HTTP 0")

    def test_cached_dir_is_skipped(self):
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["krea2"], "civitai_api_key": "k"},
                    {"krea2": ["krea2/a.safetensors"]})
        (self.cache / "krea2").mkdir()
        (self.cache / "krea2" / "example_00.png").write_bytes(b"x")
        self.assertEqual(gallery_lora._lora_pending_subdirs(), {})


def _make_safetensors(path, metadata, tensors):
    """Write a minimal valid safetensors file (header + zero blob) for tests."""
    header = dict(tensors)
    if metadata:
        header["__metadata__"] = metadata
    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    max_end = max((t["data_offsets"][1] for t in tensors.values()), default=0)
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(header_bytes)))
        f.write(header_bytes)
        f.write(b"\x00" * max_end)


class HeaderMetaTests(unittest.TestCase):
    """safetensors header 轻量读取：基座 / 触发词 / 精度，以及写 _meta.json 与回填字段。"""

    def setUp(self):
        self._comfy_saved = {k: sys.modules.get(k) for k in ("comfy", "comfy.utils")}
        comfy = types.ModuleType("comfy")
        comfy_utils = types.ModuleType("comfy.utils")

        def safetensors_header(path, max_size=100 * 1024 * 1024):
            with open(path, "rb") as f:
                n = struct.unpack("<Q", f.read(8))[0]
                if n > max_size:
                    return None
                return f.read(n)

        comfy_utils.safetensors_header = safetensors_header
        comfy.utils = comfy_utils
        sys.modules["comfy"] = comfy
        sys.modules["comfy.utils"] = comfy_utils
        self.tmp = tempfile.TemporaryDirectory(prefix="neo_lora_meta_")
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        for k, v in self._comfy_saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        self.tmp.cleanup()

    def test_reads_base_model_triggers_dtype(self):
        p = self.dir / "a.safetensors"
        _make_safetensors(p, {
            "ss_base_model_version": "sdxl_base_v1-0",
            "ss_tag_frequency": json.dumps({"ds": {"abc": 5, "xyz": 2}}),
        }, {"lora_unet_0.rank": {"dtype": "F16", "shape": [4, 8], "data_offsets": [0, 64]}})
        meta = gallery_lora._read_lora_header_meta(p)
        self.assertEqual(meta["base_model"], "sdxl_base_v1-0")
        self.assertEqual(meta["trigger_words"], ["abc", "xyz"])
        self.assertEqual(meta["dtype"], "F16")

    def test_trained_words_string_fallback(self):
        p = self.dir / "b.safetensors"
        _make_safetensors(p, {"trained_words": "a, b, c"},
                          {"w": {"dtype": "BF16", "shape": [2], "data_offsets": [0, 4]}})
        meta = gallery_lora._read_lora_header_meta(p)
        self.assertEqual(meta["trigger_words"], ["a", "b", "c"])
        self.assertEqual(meta["dtype"], "BF16")

    def test_no_metadata_only_dtype(self):
        p = self.dir / "c.safetensors"
        _make_safetensors(p, None, {"w": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}})
        self.assertEqual(gallery_lora._read_lora_header_meta(p), {"dtype": "F32"})

    def test_write_lora_meta_writes_file_and_compact_fields(self):
        cache = self.dir / "cache"
        cache.mkdir()
        meta_doc = {"base_model": "flux", "trigger_words": ["x", "y"], "dtype": "F16", "source": "header"}
        compact = gallery_lora._write_lora_meta(cache, meta_doc)
        written = json.loads((cache / "_meta.json").read_text(encoding="utf-8"))
        self.assertEqual(written["base_model"], "flux")
        self.assertEqual(written["source"], "header")
        self.assertEqual(compact, {"base_model": "flux", "trigger_words": ["x", "y"], "dtype": "F16"})

    def test_attach_lora_meta_surfaces_badges(self):
        orig = gallery_lora._load_lora_index
        gallery_lora._load_lora_index = lambda: {
            "SDXL/mylora.safetensors": {
                "cache_dir": "SDXL/mylora", "base_model": "SDXL 1.0",
                "trigger_words": ["abc"], "dtype": "F16",
            }
        }
        try:
            resp = {"items": [{"filename": "example_00.jpg"}]}
            gallery_lora._attach_lora_meta(resp, "SDXL/mylora")
            item = resp["items"][0]
            self.assertEqual(item["lora_path"], "SDXL/mylora.safetensors")
            self.assertEqual(item["base_model"], "SDXL 1.0")
            self.assertEqual(item["trigger_words"], ["abc"])
            self.assertEqual(item["dtype"], "F16")
        finally:
            gallery_lora._load_lora_index = orig


class CivitaiProbeTests(unittest.TestCase):
    """连通性测试：走 GET /me 校验 KEY，返回给设置页的 reachable / key_ok / message。

    桩的 api_get 签名与 civitai.api_get 一致，调用方式写错（关键字名对不上）会直接炸。
    """

    def setUp(self):
        self._orig = (gallery_lora.civitai.api_key, gallery_lora.civitai.api_get,
                      gallery_lora.aiohttp.ClientSession)
        self.calls = []

        class _Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        gallery_lora.aiohttp.ClientSession = lambda *a, **k: _Session()

    def tearDown(self):
        (gallery_lora.civitai.api_key, gallery_lora.civitai.api_get,
         gallery_lora.aiohttp.ClientSession) = self._orig

    def _probe(self, key, status, body):
        async def fake_api_get(session, path, params=None, key=None, timeout=25):
            self.calls.append({"path": path, "key": key})
            return status, body

        gallery_lora.civitai.api_key = lambda: key
        gallery_lora.civitai.api_get = fake_api_get
        resp = asyncio.run(gallery_lora.civitai_test(object()))
        return resp.status, json.loads(resp.body)

    def test_valid_key_reports_username(self):
        code, out = self._probe("k", 200, {"username": "dreamboy"})
        self.assertEqual(code, 200)
        self.assertTrue(out["reachable"])
        self.assertTrue(out["key_ok"])
        self.assertIn("dreamboy", out["message"])
        self.assertEqual(self.calls, [{"path": "/me", "key": "k"}])

    def test_missing_key_skips_request(self):
        code, out = self._probe("", 200, {})
        self.assertFalse(out["success"])
        self.assertFalse(out["key_ok"])
        self.assertEqual(self.calls, [], "没有 KEY 不应请求 C 站")

    def test_unreachable_reports_not_reachable(self):
        code, out = self._probe("k", 0, None)
        self.assertFalse(out["reachable"])
        self.assertFalse(out["key_ok"])

    def test_bad_key_marks_key_ok_false(self):
        code, out = self._probe("k", 401, None)
        self.assertTrue(out["reachable"])
        self.assertFalse(out["key_ok"])
        self.assertEqual(out["http_status"], 401)


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
