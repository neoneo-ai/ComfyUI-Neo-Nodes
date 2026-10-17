# SPDX-License-Identifier: Apache-2.0
"""Backyard 的 OSS 配置读写（backyard.py）离线单测。

GET 只回掩码（LTAI********9999），前端把它填回输入框；用户在掩码上改一个字符点保存，
服务端按「含 * 就丢」判会静默丢掉这一项，界面还报「已保存」—— 密钥永远写不进文件。
"""
import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

_NODE_DIR = str(Path(__file__).resolve().parent.parent)

# backyard 用相对导入（.plugin_paths / .util），目录名带连字符不能 import，测试里造一个包壳
_PKG = "neo_backyard_test_pkg"
if _PKG not in sys.modules:
    _pkg = types.ModuleType(_PKG)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG] = _pkg


def _load(name):
    mod_name = f"{_PKG}.{name}"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, Path(_NODE_DIR) / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    setattr(sys.modules[_PKG], name, mod)
    spec.loader.exec_module(mod)
    return mod


_load("util")
backyard = _load("backyard")


class _Req:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def _post(body):
    asyncio.run(backyard.save_config_route(_Req(body)))


def _get_config():
    return json.loads(asyncio.run(backyard.get_config_route(None)).text)["config"]


def _saved():
    return json.loads(backyard.CONFIG_PATH.read_text(encoding="utf-8"))


class ConfigSave(unittest.TestCase):
    def setUp(self):
        backyard.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if backyard.CONFIG_PATH.exists():
            backyard.CONFIG_PATH.unlink()

    def test_fresh_save_writes_every_field(self):
        _post({"access_key_id": "LTAI5tExampleKey9999", "access_key_secret": "topSecret9876543210",
               "endpoint": "https://oss-cn-hangzhou.aliyuncs.com", "bucket": "my-bucket",
               "prefix": "gallery/presets/", "source_dir": "gallery/presets/",
               "output_dir": "gallery/presets_dist/"})
        cfg = _saved()
        self.assertEqual(cfg["access_key_id"], "LTAI5tExampleKey9999")
        self.assertEqual(cfg["access_key_secret"], "topSecret9876543210")
        self.assertEqual(cfg["endpoint"], "https://oss-cn-hangzhou.aliyuncs.com")
        self.assertEqual(cfg["output_dir"], "gallery/presets_dist/")

    def test_get_masks_keys_and_never_returns_the_secret(self):
        _post({"access_key_id": "LTAI5tExampleKey9999", "access_key_secret": "topSecret9876543210"})
        cfg = _get_config()
        self.assertEqual(cfg["access_key_id"], "LTAI************9999")
        self.assertNotIn("topSecret9876543210", json.dumps(cfg))

    def test_untouched_masked_key_keeps_stored_value(self):
        _post({"access_key_id": "LTAI5tExampleKey9999"})
        _post({**_get_config(), "bucket": "new-bucket"})
        cfg = _saved()
        self.assertEqual(cfg["access_key_id"], "LTAI5tExampleKey9999")
        self.assertEqual(cfg["bucket"], "new-bucket")

    def test_edited_masked_key_is_saved(self):
        _post({"access_key_id": "LTAI5tExampleKey9999"})
        masked = _get_config()
        masked["access_key_id"] = masked["access_key_id"][:-4] + "8888"
        _post(masked)
        self.assertEqual(_saved()["access_key_id"], "LTAI************8888")

    def test_empty_field_keeps_stored_value(self):
        _post({"access_key_secret": "topSecret9876543210"})
        _post({"access_key_secret": "", "prefix": "gallery/other/"})
        cfg = _saved()
        self.assertEqual(cfg["access_key_secret"], "topSecret9876543210")
        self.assertEqual(cfg["prefix"], "gallery/other/")


if __name__ == "__main__":
    unittest.main()
