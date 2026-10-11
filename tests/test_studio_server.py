# SPDX-License-Identifier: Apache-2.0
"""壳侧只读服务（neo_studio_server）离线单测：ComfyUI 不在跑时浏览可用、写入被拒。

服务复用 gallery 模块注册在各自 RouteTableDef 上的浏览 handler，进程里没有 PromptServer，
所以这里直接起真服务打真接口：Studio 页面、静态文件、目录列表、缩略图、收藏文件都要出得来，
删除 / 上传 / 生成类接口必须回 409 offline，不能让前端以为生成成功了。
"""

import json
import os
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PLUGIN_DIR = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, str(PLUGIN_DIR))

import neo_studio_server as ns

TEST_PORT = 8291
STUDIO_URL = "/neo-studio"
SAMPLE = ("CharacterSheet", "2026-09-27_00001_.png")   # 整合包里的真实产物，只读


def _request(port, path, data=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


from stub_env import NODE_STUB_PREFIXES, restore, snapshot

class _RealFolderPaths(unittest.TestCase):
    """gallery 模块在 import 期读 folder_paths.output_directory；同进程里节点类用例把
    server/comfy/folder_paths 换成了桩，这里进用例先摘掉桩、出来还原，不污染后续测试。"""

    @classmethod
    def _pin_real(cls):
        cls._saved = snapshot(NODE_STUB_PREFIXES)
        restore(NODE_STUB_PREFIXES, {})

    @classmethod
    def _restore_stubs(cls):
        restore(NODE_STUB_PREFIXES, cls._saved)



class _ServerCase(_RealFolderPaths):
    """共享一个服务实例：起进程贵，用例只读接口不互相干扰。"""

    @classmethod
    def setUpClass(cls):
        cls._pin_real()
        app = ns.build_app(PLUGIN_DIR.parent.parent, PLUGIN_DIR)
        cls.tmp_userdata = Path(cls._mk_tempdir()) / "neo_gallery_data.json"
        app["userdata"] = cls.tmp_userdata
        cls.server = ns.ShellServer(lambda: app, TEST_PORT)
        cls.port = cls.server.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls._restore_stubs()

    @staticmethod
    def _mk_tempdir():
        import tempfile
        return tempfile.mkdtemp(prefix="neo_studio_server_")

    def get(self, path, data=None):
        return _request(self.port, path, data)



class OfflineServiceTests(_ServerCase):
    def test_service_binds_and_serves_studio_page(self):
        status, body = self.get(STUDIO_URL)
        self.assertEqual(status, 200)
        self.assertIn(b"Neo Studio", body)

    def test_version_reports_offline_snapshot(self):
        status, body = self.get("/neo_studio/version")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertTrue(data["offline"])
        self.assertNotEqual(data["comfyui_version"], "unknown")

    def test_extension_static_files_served(self):
        for path in ("/extensions/ComfyUI-Neo-Nodes/studio/studio-app.js",
                     "/extensions/ComfyUI-Neo-Nodes/studio/style.css",
                     "/extensions/ComfyUI-Neo-Nodes/gallery.js"):
            self.assertEqual(self.get(path)[0], 200, path)

    def test_gallery_browsing_routes_served(self):
        status, body = self.get("/neo_gallery/list?fields=dirs,items,covers&dir_name=output&path=")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["directories"])
        self.assertEqual(self.get("/neo_gallery/get_settings")[0], 200)
        self.assertEqual(self.get("/neo_gallery/css")[0], 200)
        self.assertEqual(self.get("/neo_gallery/placeholder.png")[0], 200)

    def test_thumbnail_generated_without_comfyui(self):
        query = urllib.parse.urlencode({"filename": SAMPLE[1], "subfolder": SAMPLE[0]})
        status, body = self.get(f"/neo_gallery/thumbnail?{query}")
        self.assertEqual(status, 200)
        self.assertIn(body[:3], (b"\xff\xd8\xff", b"\x89PNG"))

    def test_userdata_round_trip(self):
        payload = json.dumps({"sectionStates": {"gallery_categories": {"collapsed": True}}}).encode()
        status, body = self.get(ns.USERDATA_PATH, data=payload)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["success"])
        status, body = self.get(ns.USERDATA_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["sectionStates"]["gallery_categories"]["collapsed"], True)

    def test_write_and_generation_routes_report_offline(self):
        for path in ("/neo_gallery/delete", "/neo_gallery/save_settings",
                     "/neo_gallery/copy_to_input", "/neo_studio/director/generate",
                     "/neo_image_gen/generate"):
            status, body = self.get(path, data=b"{}")
            self.assertEqual(status, 409, path)
            data = json.loads(body)
            self.assertFalse(data["success"])
            self.assertTrue(data["offline"])

    def test_mem_stats_reports_offline(self):
        status, _ = self.get("/neo_studio/mem_stats")
        self.assertEqual(status, 409)


class GalleryDecouplingTests(_RealFolderPaths):
    """gallery 模块族必须自带路由表：壳进程里没有 ComfyUI 运行时，注册不能靠 PromptServer。"""

    @classmethod
    def setUpClass(cls):
        cls._pin_real()

    @classmethod
    def tearDownClass(cls):
        cls._restore_stubs()

    def test_gallery_modules_carry_own_route_tables(self):

        from aiohttp import web
        tables = ns.load_gallery_modules(PLUGIN_DIR)
        self.assertEqual(len(tables), 4)
        for table in tables:
            self.assertIsInstance(table, web.RouteTableDef)
            self.assertTrue(len(table) > 0)

    def test_gallery_modules_do_not_import_server(self):
        for name in ("gallery.py", "bookmark.py", "gallery_lora.py", "gallery_oss.py"):
            source = (PLUGIN_DIR / name).read_text(encoding="utf-8")
            self.assertNotIn("PromptServer", source, name)

    def test_readonly_subset_exists_in_module_routes(self):
        registered = {(r.method, r.path) for table in ns.load_gallery_modules(PLUGIN_DIR) for r in table}
        self.assertTrue(ns.READONLY_ROUTES <= registered,
                        ns.READONLY_ROUTES - registered)


if __name__ == "__main__":
    unittest.main()
