# SPDX-License-Identifier: Apache-2.0
"""壳侧服务（app/studio_server.py）离线单测：ComfyUI 不在跑时 Studio 的可用面与能力边界。

服务复用内核插件模块挂在各自 RouteTableDef 上的 handler，进程里没有 PromptServer，
所以这里直接起真服务打真接口：Studio 页面、静态文件、浏览、设置与配方写入都要出得来；
生成 / 队列 / 显存类接口必须回 409 offline，不能让前端以为生成成功了。
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_DIR = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLUGIN_DIR = APP_DIR.parent / "kernel-plugin"
COMFY_ROOT = APP_DIR.parent.parent / "ComfyUI"
sys.path.insert(0, str(APP_DIR))
sys.path.insert(0, str(PLUGIN_DIR / "tests"))

import studio_caps as caps
import studio_server as ns

TEST_PORT = 8291
STUDIO_URL = "/neo-studio"
SAMPLE = ("CharacterSheet", "2026-09-27_00001_.png")   # 整合包里的真实产物，只读
CONFIGS = PLUGIN_DIR / "configs"
# 写入用例落数据根的这些配置文件：用例前后快照还原，不留测试数据
WRITE_FILES = ("image_gen.json", "bookmarks.json", "remote_llm_config.json")


def _data_root() -> Path:
    """壳侧加载的插件模块实际用的用户数据根：写入用例的落点与断言都以它为准。"""
    return sys.modules[f"{ns.SHELL_PKG}.plugin_paths"].DATA_ROOT
# 必须 ComfyUI 在跑才有的接口：壳一律 409 offline，前端据此门控
COMFY_ONLY_ROUTES = (
    "/neo_image_gen/generate",
    "/neo_image_gen/tasks",
    "/neo_image_gen/enhance",
    "/neo_image_gen/skill_dims?skill_id=x",
    "/neo_video_gen/storyboard_generate",
    "/neo_video_gen/run_segment",
    "/neo_video_gen/assemble_segments",
    "/neo_voice/generate",
    "/neo_studio/director/generate",
    "/neo_studio/mem_stats",
    "/neo_studio/clear_memory",
    "/neo_nodes/repair",
    "/rs_prompts/enhance_prompt",
)



def _request(port, path, data=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _snapshot(paths):
    return {p: (p.read_bytes() if p.exists() else None) for p in paths}


def _restore(saved):
    for path, data in saved.items():
        if data is None:
            if path.exists():
                path.unlink()
        else:
            path.write_bytes(data)


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
        cls.app = ns.build_app(COMFY_ROOT, PLUGIN_DIR, {"starting": False})
        cls.tmpdir = Path(tempfile.mkdtemp(prefix="neo_studio_server_"))
        cls.app["userdata"] = cls.tmpdir / "neo_gallery_data.json"
        cls.app["comfy_log"] = cls.tmpdir / "comfy_run.log"
        cls.app["comfy_log"].write_text("shell log line 1\nshell log line 2\n", encoding="utf-8")
        cls.server = ns.ShellServer(lambda: cls.app, TEST_PORT)
        cls.port = cls.server.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls._restore_stubs()

    def get(self, path, data=None):
        return _request(self.port, path, data)

    def post_json(self, path, payload):
        return self.get(path, data=json.dumps(payload).encode())




class OfflineServiceTests(_ServerCase):
    def test_service_binds_and_serves_studio_page(self):
        status, body = self.get(STUDIO_URL)
        self.assertEqual(status, 200)
        self.assertIn(b"Neo Studio", body)

    def test_version_reports_offline_snapshot_and_caps(self):
        status, body = self.get("/neo_studio/version")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertTrue(data["offline"])
        self.assertNotEqual(data["comfyui_version"], "unknown")
        # 生成 / 显存类功能离线不可用；纯文件功能（宫格切分）可用
        self.assertFalse(data["caps"]["image_gen"])
        self.assertFalse(data["caps"]["director"])
        self.assertFalse(data["caps"]["memory"])
        self.assertTrue(data["caps"]["grid_split"])

    def test_version_reports_shell_starting_flag(self):
        # 冷启动那几秒 js_api 还没注入，页面靠这份快照知道「壳已拉起、端口未就绪」
        self.app["flags"]["starting"] = True
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertTrue(data["starting"], "壳拉起 ComfyUI 期间快照要报启动中")
        self.app["flags"]["starting"] = False
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertFalse(data["starting"], "没在拉起时不报启动中")

    def test_extension_static_files_served(self):
        for path in ("/extensions/comfyui-neo-studio/studio/studio-app.js",
                     "/extensions/comfyui-neo-studio/studio/style.css",
                     "/extensions/comfyui-neo-studio/gallery.js"):
            self.assertEqual(self.get(path)[0], 200, path)

    def test_extension_static_files_not_cacheable(self):
        """壳窗口开着时改了插件 JS：缓存里的旧模块和新模块拼进同一张模块图，
        一个 ES 模块链接错误就把整页打回只出顶栏（视图不挂、胶囊永远 hidden）。"""
        path = "/extensions/comfyui-neo-studio/gallery-utils.js"
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=30) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store", path)

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

    def test_offline_log_reads_comfy_run_log(self):
        status, body = self.get("/neo_studio/log")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertIn("shell log line 2", "".join(e["m"] for e in data["entries"]))

    def test_launcher_snapshot_and_apply(self):
        # 设置页读的是壳的启动快照；保存由壳校验并重启 ComfyUI
        self.app["launcher"].update(root="D:/ComfyUI", python="D:/python/python.exe", port=8188,
                                    plugin_dir="D:/ComfyUI/custom_nodes/comfyui-neo-studio",
                                    state_dir="D:/studio/data", portable=True, state="ok", error="")
        applied = []
        self.app["launcher_api"]["apply"] = (
            lambda root, python, port: applied.append((root, python, port)) or {"ok": True, "state": "ok"})
        status, body = self.get("/neo_studio/launcher")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["plugin_dir"], "D:/ComfyUI/custom_nodes/comfyui-neo-studio")
        self.assertEqual(data["state"], "ok")
        status, body = self.post_json("/neo_studio/launcher",
                                      {"root": "E:/ComfyUI", "python": "E:/py/python.exe", "port": 8190})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(applied, [("E:/ComfyUI", "E:/py/python.exe", 8190)])

    def test_launcher_retry_actions(self):
        calls = []
        self.app["launcher_api"]["install_plugin"] = lambda: calls.append("plugin") or {"ok": True}
        self.app["launcher_api"]["install_deps"] = lambda: calls.append("deps") or {"ok": True}
        for action in ("install_plugin", "install_deps"):
            status, body = self.post_json("/neo_studio/launcher", {"action": action})
            self.assertEqual(status, 200, action)
            self.assertTrue(json.loads(body)["ok"], action)
        self.assertEqual(calls, ["plugin", "deps"])

    def test_launcher_post_rejects_unknown_action(self):
        status, body = self.post_json("/neo_studio/launcher", {"action": "rm_root"})
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(body)["ok"])

    def test_comfy_only_routes_report_offline(self):
        for path in COMFY_ONLY_ROUTES:
            status, body = self.get(path, data=b"{}")
            self.assertEqual(status, 409, path)
            data = json.loads(body)
            self.assertFalse(data["success"])
            self.assertTrue(data["offline"])


    def test_mem_stats_reports_offline(self):
        status, _ = self.get("/neo_studio/mem_stats")
        self.assertEqual(status, 409)

    def test_llm_config_and_title_routes_served_offline(self):
        """LLM 配置只读配置文件、标题提取只打 8080：与 ComfyUI 运行时无关，壳必须服务"""
        status, body = self.get("/rs_prompts/llm_mode")
        self.assertEqual(status, 200)
        self.assertIn("mode", json.loads(body))
        status, body = self.get("/rs_prompts/remote_llm_config")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["provider_list"])
        self.assertEqual(self.get("/rs_prompts/get_models")[0], 200)
        self.assertEqual(self.get("/rs_prompts/native_models")[0], 200)
        status, body = self.post_json("/rs_prompts/extract_title",
                                      {"text": "一位年轻女性端坐于户外木质椅子上，身着碎花裙，背景是花园"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["title"])


class ShellWriteTests(_ServerCase):
    """离线可编辑面：设置 / 收藏 / 配方 / 技能都是真实落盘写入。"""

    def setUp(self):
        self.configs = _data_root() / "configs"
        self._saved = _snapshot(tuple(self.configs / n for n in WRITE_FILES))
        self._extra_dirs = []

    def tearDown(self):
        _restore(self._saved)
        for d in self._extra_dirs:
            shutil.rmtree(d, ignore_errors=True)

    def test_image_gen_settings_round_trip(self):
        status, body = self.post_json("/neo_image_gen/settings", {"output_prefix": "ShellWrite"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["output_prefix"], "ShellWrite")
        status, body = self.get("/neo_image_gen/settings")
        self.assertEqual(json.loads(body)["output_prefix"], "ShellWrite")

    def test_bookmark_local_add_and_list(self):
        status, body = self.post_json("/neo_bookmark/local/add",
                                      {"name": "ShellBookmark", "source": "local",
                                       "dir": "output", "subfolder": ""})
        self.assertEqual(status, 200, body)
        status, body = self.get("/neo_bookmark/local")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(any(i.get("name") == "ShellBookmark" for i in data["items"]))

    def test_recipe_save_and_list(self):
        name = "shell-test-recipe"
        status, body = self.post_json("/rs_recipes/save", {"name": name, "prompt": "shell offline"})
        self.assertEqual(status, 200, body)
        recipe_dir = _data_root() / "recipes" / "custom" / name
        self._extra_dirs.append(recipe_dir)
        self.assertTrue((recipe_dir / "recipe.json").is_file())
        status, body = self.post_json("/rs_recipes/list", {"source": "custom"})
        self.assertEqual(status, 200)
        self.assertTrue(any(r.get("name") == name for r in json.loads(body)))

    def test_skill_save_and_delete(self):
        skill_id = "shell_test_skill"
        status, body = self.post_json("/rs_prompts/save_skill",
                                      {"id": skill_id, "name": "Shell Test Skill",
                                       "content": "# shell\n离线写入", "source": "custom"})
        self.assertEqual(status, 200, body)
        skill_dir = _data_root() / "skills" / "custom" / skill_id
        self._extra_dirs.append(skill_dir)
        self.assertTrue((skill_dir / "skill.md").is_file())
        status, body = self.post_json("/rs_prompts/delete_skill",
                                      {"id": skill_id, "source": "custom"})
        self.assertEqual(status, 200, body)
        self.assertFalse(skill_dir.exists())

    def test_llm_config_round_trip_masks_key(self):
        """离线写 LLM 配置：密钥真实落盘，接口回读只给掩码"""
        shell_llm = sys.modules[f"{ns.SHELL_PKG}.llm"]
        status, body = self.post_json("/rs_prompts/remote_llm_config",
                                      {"provider": "openai", "api_key": "sk-shell-secret",
                                       "base_url": "https://api.openai.com/v1",
                                       "model": "gpt-4o-mini"})
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body)["success"])
        status, body = self.get("/rs_prompts/remote_llm_config")
        slot = json.loads(body)["providers"]["openai"]
        self.assertEqual(status, 200)
        self.assertEqual(slot["api_key"], shell_llm.API_KEY_MASK)
        self.assertEqual(slot["model"], "gpt-4o-mini")
        saved = json.loads((self.configs / "remote_llm_config.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["providers"]["openai"]["api_key"], "sk-shell-secret")



class ShellModuleTests(_RealFolderPaths):
    """壳侧模块族必须自带路由表、不碰 ComfyUI 运行时，且与能力清单一致。"""

    @classmethod
    def setUpClass(cls):
        cls._pin_real()

    @classmethod
    def tearDownClass(cls):
        cls._restore_stubs()

    def test_shell_modules_carry_own_route_tables(self):
        from aiohttp import web
        tables = ns.load_shell_modules(PLUGIN_DIR)
        self.assertEqual(len(tables), len(ns.SHELL_ROUTE_MODULES))
        for table in tables:
            self.assertIsInstance(table, web.RouteTableDef)
            self.assertTrue(len(table) > 0)

    def test_shell_modules_do_not_import_comfyui_runtime(self):
        """import 期不碰 ComfyUI 运行时：函数内的惰性导入有兜底，不算。"""
        forbidden = ("from server", "import server", "import nodes", "from nodes",
                     "from comfy", "import comfy", "import torch", "from torch",
                     "from comfy_api", "import pynvml")
        for name in ns.SHELL_MODULES:
            for line in (PLUGIN_DIR / f"{name}.py").read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if line[:1].isspace() or stripped.startswith("#"):
                    continue
                for word in forbidden:
                    self.assertNotIn(word, stripped, f"{name}.py: {stripped}")

    def test_capability_manifest_matches_module_routes(self):
        registered = {(r.method, r.path)
                      for table in ns.load_shell_modules(PLUGIN_DIR) for r in table}
        self.assertFalse(caps.SHELL_ROUTES - registered,
                         f"能力清单里的壳路由在模块里不存在: {sorted(caps.SHELL_ROUTES - registered)}")

    def test_shell_app_mounts_exactly_the_manifest(self):
        app = ns.build_app(COMFY_ROOT, PLUGIN_DIR)
        shell_pages = {("GET", "/neo-studio"), ("GET", "/neo_studio/version"),
                       ("GET", "/neo_studio/log"), ("GET", "/neo_studio/launcher"),
                       ("POST", "/neo_studio/launcher")}
        mounted = {(r.method, r.resource.canonical) for r in app.router.routes()
                   if r.method != "HEAD" and r.resource.canonical.startswith(("/neo", "/rs_"))}
        self.assertEqual(mounted - shell_pages, caps.SHELL_ROUTES)


if __name__ == "__main__":
    unittest.main()
