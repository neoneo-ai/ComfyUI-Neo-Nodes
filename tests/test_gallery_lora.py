# SPDX-License-Identifier: Apache-2.0
"""gallery_lora：Civitai 同步的「待同步目录」卡片状态。

设置里的同步目录名对不上任何 Lora（目录名写错）时不能显示成一直在获取；
该目录下的 Lora 全部失败时要把真实错误透出给卡片。
"""
import os
import sys
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
    """待同步目录卡片：目录名对不上 / 有待同步 Lora / 全部失败 / 已缓存 / 主开关关。"""

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

    def test_dir_name_matching_no_lora_reports_empty(self):
        # 设置写 "Qwen"，loras 目录里只有 QwenImage2.1 → 不能说「正在获取」，要说清楚
        self._setup({"civitai_lora_enabled": True, "lora_sync_dirs": ["Qwen"], "civitai_api_key": "k"}, {})
        out = gallery_lora._lora_pending_subdirs()
        self.assertEqual(list(out), ["Qwen"])
        self.assertEqual(out["Qwen"]["civitai"]["status"], "empty")
        self.assertIn("Qwen", out["Qwen"]["civitai"]["error"])

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


if __name__ == "__main__":
    unittest.main()
