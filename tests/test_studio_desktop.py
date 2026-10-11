"""Neo Studio 桌面壳（neo_studio_app.py）单测：路径解析、探活、几何持久化、单实例。"""

import json
import logging
import pathlib
import socket
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

_PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PLUGIN_DIR))

import neo_studio_app as app


class FrozenPathTests(unittest.TestCase):
    def test_source_layout(self):
        # 源码运行：持久化与随包资源都在插件目录里
        self.assertEqual(app.PLUGIN_DIR, _PLUGIN_DIR)
        self.assertEqual(app.RES_DIR, _PLUGIN_DIR)

    def test_frozen_layout(self):
        # 打包后 __file__ 指向临时解包目录：持久化按插件目录算，随包资源走 _MEIPASS
        with tempfile.TemporaryDirectory() as tmp:
            plugin = pathlib.Path(tmp) / "ComfyUI" / "custom_nodes" / "ComfyUI-Neo-Nodes"
            meipass = pathlib.Path(tmp) / "_MEIPASS"
            with patch.object(sys, "frozen", True, create=True), \
                 patch.object(sys, "_MEIPASS", str(meipass), create=True):
                # 产物在 tools 下：向上找到插件目录
                exe = plugin / "tools" / "neo-studio.exe"
                with patch.object(sys, "executable", str(exe)):
                    plugin_dir, res = app.base_dirs()
                self.assertEqual(plugin_dir, plugin)
                self.assertEqual(res, meipass)
                # exe 直接放在插件目录里：parents 里没有插件目录，回退 exe_dir
                exe = plugin / "neo-studio.exe"
                with patch.object(sys, "executable", str(exe)):
                    plugin_dir, res = app.base_dirs()
                self.assertEqual(plugin_dir, plugin)

    def test_studio_icon_is_a_bundled_resource(self):
        self.assertEqual(app.STUDIO_ICON, app.RES_DIR / "web" / "neo-studio.ico")


class ResolveTests(unittest.TestCase):
    def test_root_default_is_comfyui(self):
        self.assertEqual(app.resolve_root(""), _PLUGIN_DIR.parent.parent)

    def test_root_explicit(self):
        self.assertEqual(app.resolve_root("D:/ComfyUI"), pathlib.Path("D:/ComfyUI"))

    def test_python_prefers_sibling_dir(self):
        # 整合包布局：python 与 ComfyUI 同级，优先于 ComfyUI 内部
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "ComfyUI"
            root.mkdir()
            (pathlib.Path(tmp) / "python").mkdir()
            (root / "python").mkdir()
            sibling = root.parent / "python" / "python.exe"
            sibling.write_text("")
            (root / "python" / "python.exe").write_text("")
            self.assertEqual(app.resolve_python(root, ""), sibling)

    def test_python_fallback_inner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "ComfyUI"
            (root / "python").mkdir(parents=True)
            inner = root / "python" / "python.exe"
            inner.write_text("")
            self.assertEqual(app.resolve_python(root, ""), inner)

    def test_python_explicit_wins(self):
        self.assertEqual(app.resolve_python(pathlib.Path("D:/ComfyUI"), "D:/x/python.exe"),
                         pathlib.Path("D:/x/python.exe"))

    def test_python_missing_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                app.resolve_python(pathlib.Path(tmp) / "ComfyUI", "")


class ProbeTests(unittest.TestCase):
    def test_probe_ready(self):
        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with patch.object(app.urllib.request, "urlopen", lambda url, timeout=3.0: _Resp()):
            self.assertTrue(app.probe(8188))

    def test_probe_down(self):
        def _boom(url, timeout=3.0):
            raise ConnectionRefusedError()

        with patch.object(app.urllib.request, "urlopen", _boom):
            self.assertFalse(app.probe(8188))

    def test_wait_ready_polls_until_ready(self):
        seq = [False, False, True]

        def _probe(port, timeout=3.0):
            return seq.pop(0) if seq else False

        with patch.object(app, "probe", _probe), patch.object(app, "POLL_INTERVAL", 0):
            self.assertTrue(app.wait_ready(8188, 5))

    def test_start_comfy_argv(self):
        with patch.object(app.subprocess, "Popen") as popen:
            app.start_comfy(pathlib.Path("D:/python/python.exe"), pathlib.Path("D:/ComfyUI"), 8188)
        self.assertEqual(popen.call_args[0][0],
                         [str(pathlib.Path("D:/python/python.exe")), str(pathlib.Path("D:/ComfyUI") / "main.py"),
                          "--port", "8188"])
        # 壳用 pythonw 启动时没有控制台，子进程必须压制新建的控制台窗口
        self.assertEqual(popen.call_args.kwargs["creationflags"], app.NO_WINDOW)
        # CREATE_NO_WINDOW 下不重定向就等于把启动报错丢进黑洞：必须落到 tmp/comfy_run.log
        self.assertIs(popen.call_args.kwargs["stderr"], app.subprocess.STDOUT)
        self.assertIn("comfy_run.log", popen.call_args.kwargs["stdout"].name)
        popen.call_args.kwargs["stdout"].close()


class FreeComfyPortTests(unittest.TestCase):
    def test_requested_port_when_free(self):
        with patch.object(app, "port_busy", lambda port: False):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8188)

    def test_skips_busy_ports_and_the_shell_service(self):
        # 8188 被残留进程占着、8189 是壳单实例锁、8191 是壳侧素材服务：只能用 8190
        busy = {8188, 8189, 8191}
        with patch.object(app, "port_busy", lambda port: port in busy):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8190)

    def test_falls_back_to_requested_when_nothing_free(self):
        with patch.object(app, "port_busy", lambda port: True):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8188)


class PortOwnerTests(unittest.TestCase):
    NETSTAT = ("  Proto  Local Address          Foreign Address        State           PID\n"
               "  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       12345\n"
               "  TCP    [::1]:8188             [::]:0                 LISTENING       12345\n"
               "  TCP    127.0.0.1:8189         127.0.0.1:52000        ESTABLISHED   999\n")

    def test_port_owner_from_netstat(self):
        with patch.object(app.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=self.NETSTAT)):
            self.assertEqual(app.port_owner(8188), 12345)

    def test_port_owner_missing_is_zero(self):
        with patch.object(app.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=self.NETSTAT)):
            self.assertEqual(app.port_owner(8187), 0)

    def test_kill_pid_uses_kernel32(self):
        # 必须用 PROCESS_TERMINATE(0x0001)：0x1000 拿到的句柄没有终止权，TerminateProcess 会失败
        calls = []
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: calls.append(("open", a)) or 7,
                                   TerminateProcess=lambda h, c: calls.append(("term", h)) or 1,
                                   CloseHandle=lambda h: calls.append(("close", h)))
        with patch.object(app, "k32", kernel32):
            self.assertTrue(app.kill_pid(4321))
        self.assertEqual(calls, [("open", (0x0001, False, 4321)), ("term", 7), ("close", 7)])

    def test_kill_pid_without_handle_reports_failure(self):
        # 没有权限时 OpenProcess 返回 0，必须报失败让壳日志说清原因
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: 0)
        with patch.object(app, "k32", kernel32):
            self.assertFalse(app.kill_pid(4321))

    def test_pid_alive_checks_openprocess(self):
        calls = []
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: calls.append(a) or 7,
                                   CloseHandle=lambda h: calls.append(("close", h)))
        with patch.object(app, "k32", kernel32):
            self.assertTrue(app.pid_alive(4321))
        self.assertEqual(calls, [(0x1000, False, 4321), ("close", 7)])
        dead = SimpleNamespace(OpenProcess=lambda *a: 0)
        with patch.object(app, "k32", dead):
            self.assertFalse(app.pid_alive(4321))


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._file = app.GEOMETRY_FILE
        app.GEOMETRY_FILE = pathlib.Path(self._tmp.name) / "configs" / "studio_window.json"

    def tearDown(self):
        app.GEOMETRY_FILE = self._file
        self._tmp.cleanup()

    def test_missing_file_defaults(self):
        self.assertEqual(app.load_geometry(), {})

    def test_round_trip(self):
        window = SimpleNamespace(width=1440, height=900, x=100, y=60)
        app.save_geometry(window)
        self.assertEqual(app.load_geometry(), {"width": 1440, "height": 900, "x": 100, "y": 60})

    def test_bad_json_is_ignored(self):
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text("not json", encoding="utf-8")
        self.assertEqual(app.load_geometry(), {})

    def test_partial_geometry_keeps_valid_keys(self):
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 1200, "x": "bad"}), encoding="utf-8")
        self.assertEqual(app.load_geometry(), {"width": 1200})

    def test_offscreen_position_is_dropped_on_load(self):
        # 最小化时保存的 -32000 系坐标：下次启动窗口在屏幕外看不见，位置丢弃回退默认
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 900, "height": 600, "x": -21332, "y": -21332}),
                                     encoding="utf-8")
        self.assertEqual(app.load_geometry(), {"width": 900, "height": 600})

    def test_minimized_geometry_is_not_saved(self):
        # 最小化关闭：位置 -32000 系、尺寸是最小化态假值，整份几何跳过，保留上次的好值
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 1440, "height": 900, "x": 100, "y": 60}),
                                     encoding="utf-8")
        window = SimpleNamespace(width=158, height=26, x=-21332, y=-21332)
        app.save_geometry(window)
        self.assertEqual(app.load_geometry(), {"width": 1440, "height": 900, "x": 100, "y": 60})


class AlertTests(unittest.TestCase):
    def test_alert_uses_message_box(self):
        calls = []
        user32 = SimpleNamespace(MessageBoxW=lambda *a: calls.append(a))
        with patch.object(app.ctypes, "windll", SimpleNamespace(user32=user32)):
            app.alert("未找到 python")
        self.assertEqual(calls[0][1], "未找到 python")
        self.assertEqual(calls[0][2], "Neo Studio")

    def test_missing_pywebview_alerts_and_exits(self):
        with patch.object(app, "webview", None), patch.object(app, "alert") as alert, \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 1)
            self.assertIn("pywebview", alert.call_args[0][0])


class ShellLogTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._log = app.SHELL_LOG
        app.SHELL_LOG = pathlib.Path(self._tmp.name) / "studio_shell.log"

    def tearDown(self):
        app.SHELL_LOG = self._log
        self._tmp.cleanup()

    def test_log_line_appends(self):
        app.log_line("start port=8188")
        app.log_line("webview start")
        text = app.SHELL_LOG.read_text(encoding="utf-8")
        self.assertIn("start port=8188", text)
        self.assertIn("webview start", text)
        self.assertEqual(text.count("\n"), 1)

    def test_log_line_keeps_only_the_tail(self):
        # 日志只增不减：反复开关机会把文件拖大，超上限时从整行开头截尾
        with patch.object(app, "LOG_MAX", 200):
            for i in range(20):
                app.log_line(f"line-{i:02d} " + "x" * 20)
        text = app.SHELL_LOG.read_text(encoding="utf-8")
        self.assertLess(len(text), 300, "超上限要裁到尾部，不能无限增长")
        self.assertIn("line-19", text)
        self.assertNotIn("line-00", text)

    def test_log_line_survives_concurrent_writers(self):
        # pywebview 把每个 js_api 调用丢进自己的线程：并发写（前端错误 + 跳转）不能丢行
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(app.log_line, [f"line-{i:02d}" for i in range(40)]))
        text = app.SHELL_LOG.read_text(encoding="utf-8")
        missing = [f"line-{i:02d}" for i in range(40) if f"line-{i:02d}" not in text]
        self.assertEqual(missing, [], "并发写日志丢了行")

    def test_pywebview_logger_writes_to_shell_log(self):
        # pythonw 的 sys.stderr 是 None，pywebview 的控制台 handler 会在写日志时抛异常打断窗口创建；
        # 导入壳时先把 pywebview 日志接到壳日志文件，_setup_logger 就不会再挂控制台 handler
        handlers = logging.getLogger("pywebview").handlers
        self.assertTrue(any(isinstance(h, logging.FileHandler) for h in handlers))


class SingletonTests(unittest.TestCase):
    def setUp(self):
        # 真实壳窗口正占着 8189 时这两条会假失败：单实例锁换成临时空闲端口
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        patcher = patch.object(app, "SINGLETON_PORT", port)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_second_instance_exits(self):
        first = app.singleton()
        self.assertIsNotNone(first)
        self.assertIsNone(app.singleton())
        first.close()

    def test_port_released_after_close(self):
        first = app.singleton()
        first.close()
        second = app.singleton()
        self.assertIsNotNone(second)
        second.close()


class _Event:
    """pywebview 的 events.closing 支持 `+= callable`；mock 里用同样的 += 语义。"""
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self


def _fake_window():
    # 带几何值：关窗处理器里的 save_geometry 要读 width/height/x/y；loaded 处理器要记当前页面
    return SimpleNamespace(events=SimpleNamespace(closing=_Event(), loaded=_Event()),
                           evaluate_js=MagicMock(), load_url=MagicMock(),
                           get_current_url=lambda: "http://127.0.0.1:8188/neo-studio",
                           width=1200, height=800, x=100, y=100)


def _fake_webview(create_window, start=None):
    return SimpleNamespace(create_window=create_window, settings={},
                           start=start or (lambda *a, **k: None))


def _fake_shell_server(port=8191):
    """壳侧只读服务的替身：main() 里只关心绑定端口与收尾，不起真服务。"""
    return lambda factory, port_arg: SimpleNamespace(start=lambda: port, stop=lambda: None)



class StudioShellTests(unittest.TestCase):
    def test_go_studio_loads_studio_url(self):
        loader = MagicMock()
        rearm = MagicMock()
        logs = []
        shell = app.StudioShell("http://127.0.0.1:8188/neo-studio", None, 8188, pathlib.Path("root"))
        shell.loader = loader
        shell.rearm = rearm
        with patch.object(app, "log_line", lambda text: logs.append(text)):
            shell.go_studio()
        loader.assert_called_once_with("http://127.0.0.1:8188/neo-studio")
        rearm.assert_called_once_with()
        self.assertEqual(logs, ["goto http://127.0.0.1:8188/neo-studio"], "每次整页跳转记一行")

    def test_web_log_is_flattened_for_grep(self):
        # 页面把未捕获错误折成一行报给壳：栈是多行的，落盘要一行一条才好 grep
        shell = app.StudioShell("u", None, 8188, pathlib.Path("root"))
        logs = []
        with patch.object(app, "log_line", lambda text: logs.append(text)):
            shell.log("STARTUP FAILED TypeError: x\n    at route (studio-app.js:1)\n    at y")
        self.assertEqual(logs, ["[web] STARTUP FAILED TypeError: x at route (studio-app.js:1) at y"])

    def test_back_js_skips_studio_page(self):
        # Studio 页顶栏已有回主画布的链接，胶囊只给主画布和启动页用
        self.assertIn("neo-studio-back", app.BACK_JS)
        self.assertIn("go_studio", app.BACK_JS)
        self.assertIn("/neo-studio", app.BACK_JS)

    def test_starting_flag_is_shared_with_shell_service(self):
        # 启动中标记由壳侧服务与 js_api 共用同一份 dict：js_api 注入之前页面也能拿到
        flags = {"starting": False}
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"), "", "", 0, flags)
        self.assertTrue(flags["starting"], "壳拉起 ComfyUI 即置启动中")
        shell.starting = False
        self.assertFalse(flags["starting"], "就绪后收掉启动中，壳侧服务同步")

    def test_state_of_shell_spawned_comfy(self):
        # 壳拉起的那路以端口探活为准：TerminateProcess 是异步的，进程还在收尾时端口已关
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertTrue(shell.comfy_state()["starting"], "壳拉起且端口未就绪要报启动中")
        with patch.object(app, "probe", lambda port, timeout=3.0: True):
            self.assertEqual(shell.comfy_state(),
                             {"port": 8188, "pid": 1234, "mine": True, "running": True,
                              "ready": True, "starting": False})
        with patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertFalse(shell.comfy_state()["running"])
            self.assertFalse(shell.comfy_state()["starting"], "就绪过一次后不再报启动中")

    def test_state_of_external_comfy_by_port(self):
        # 外部启动的 ComfyUI 没有 Popen 句柄：按端口找 PID，缓存后只用 OpenProcess 复查
        runs = []
        shell = app.StudioShell("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: runs.append(port) or 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: True):
            state = {"port": 8188, "pid": 4321, "mine": False, "running": True, "ready": True,
                     "starting": False}
            self.assertEqual(shell.comfy_state(), state)
            self.assertEqual(shell.comfy_state(), state)
        self.assertEqual(runs, [8188], "缓存的 PID 还活着时不该重跑 netstat")

    def test_state_when_nothing_listens(self):
        shell = app.StudioShell("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertFalse(shell.comfy_state()["running"])

    def test_stop_terminates_shell_comfy(self):
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0):
            shell.comfy_stop()
        comfy.terminate.assert_called_once()

    def test_stop_kills_port_owner_that_is_not_the_popen(self):
        # 监听者未必是壳的 Popen：terminate 后按端口反复杀到没人监听
        kills, owners = [], iter([4321, 0])
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: next(owners)), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True):
            shell.comfy_stop()
        comfy.terminate.assert_called_once()
        self.assertEqual(kills, [4321])

    def test_stop_reports_kill_without_permission(self):
        # OpenProcess 拿不到句柄（权限不足）：报失败并停下，不无限循环杀同一个 PID
        kills, owners, logs = [], iter([4321, 4321, 4321]), []
        shell = app.StudioShell("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "port_owner", lambda port: next(owners)), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or False), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            shell.comfy_stop()
        self.assertEqual(kills, [4321], "杀不动就不该反复重试")
        self.assertIn("权限", logs[0])

    def test_stop_skips_owner_that_is_already_exiting(self):
        # terminate 后 netstat 可能还列着正在收尾的进程：它已死，不该报「没有权限」
        kills, logs = [], []
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            shell.comfy_stop()
        self.assertEqual(kills, [], "收尾中的进程不该再去杀")
        self.assertNotIn("权限", "".join(logs))

    def test_close_kills_only_the_shell_spawned_process(self):
        # 关窗只认自己那份 Popen 句柄：不扫端口，扫监听者会在关窗路上误杀抢端口的残留进程
        touched, flags = [], {"starting": True}
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=lambda timeout=None: 0)
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"), "", "", 0, flags)
        with patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(app, "log_line", lambda text: None):
            shell.comfy_close()
        comfy.terminate.assert_called_once()
        self.assertEqual(touched, [], "关窗不该按端口扫进程")
        self.assertFalse(flags["starting"], "关窗收掉启动中")

    def test_close_falls_back_to_its_own_pid_when_the_child_wont_exit(self):
        # TerminateProcess 是异步的：等不到退出就按自己的 PID 兜底，范围不外扩
        kills = []
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(),
                                wait=MagicMock(side_effect=subprocess.TimeoutExpired("c", 5)))
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: None):
            shell.comfy_close()
        self.assertEqual(kills, [1234])

    def test_close_leaves_external_comfy_alone(self):
        # 用户自己启动的 ComfyUI 没有壳的句柄：关窗完全不动，避免误杀
        touched = []
        shell = app.StudioShell("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(app, "log_line", lambda text: None):
            shell.comfy_close()
        self.assertEqual(touched, [])

    def test_start_respawns_after_stop(self):
        comfy = SimpleNamespace(pid=1234, poll=lambda: 1, terminate=MagicMock())
        shell = app.StudioShell("u", comfy, 8188, pathlib.Path("root"))
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)
        with patch.object(app, "start_comfy", lambda python, root, port: spawned), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "free_comfy_port", lambda port, shell_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None):
            state = shell.comfy_start()
        self.assertIs(shell.comfy, spawned)
        self.assertEqual((state["pid"], state["running"], state["ready"]), (9999, False, False))

    def test_stop_pulls_window_back_to_offline_gallery(self):
        loader = MagicMock()
        shell = app.StudioShell("http://127.0.0.1:8188/neo-studio", None, 8188,
                                pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        shell.loader = loader
        shell.rearm = MagicMock()
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "log_line", lambda text: None):
            state = shell.comfy_stop()
        # ComfyUI 停了，页面是它的：窗口退回壳的只读素材页，不留死页面
        self.assertFalse(state["ready"])
        loader.assert_called_once_with("http://127.0.0.1:8191/neo-studio")
        shell.rearm.assert_called_once_with()

    def test_start_jumps_to_full_studio_when_ready(self):
        comfy = SimpleNamespace(pid=1, poll=lambda: 0, terminate=MagicMock())
        shell = app.StudioShell("http://127.0.0.1:8188/neo-studio", comfy, 8188,
                                pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        shell.loader = MagicMock()
        shell.rearm = MagicMock()
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)
        no_thread = lambda target, daemon=True: SimpleNamespace(start=lambda: None)
        with patch.object(app, "start_comfy", lambda python, root, port: spawned), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "free_comfy_port", lambda port, shell_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app.threading, "Thread", no_thread):
            shell.comfy_start()
        with patch.object(app, "wait_ready", lambda port, seconds: True), \
             patch.object(app, "log_line", lambda text: None):
            shell._jump_when_ready()
        loader = shell.loader
        loader.assert_called_once_with("http://127.0.0.1:8188/neo-studio")


    def test_pill_is_reinjected_after_every_page_load(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        logs = []
        # loaded 处理器在 main() 之后手动触发，log_line 的桩要一直挂着
        patcher = patch.object(app, "log_line", lambda text: logs.append(text))
        patcher.start()
        self.addCleanup(patcher.stop)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 开窗那行带上起始页面：窗口停在离线页还是完整 Studio 一看就知道
        self.assertTrue(any(line.startswith("webview start geo=")
                            and "url=http://127.0.0.1:8188/neo-studio" in line for line in logs), logs)
        # 主画布整页刷新后由 loaded 事件重新注入，返回入口不会随刷新消失

        self.assertEqual(len(window.events.loaded.handlers), 1)
        window.events.loaded.handlers[0]()
        window.evaluate_js.assert_called_once_with(app.BACK_JS)
        # 每次整页加载记一行当前页面
        self.assertEqual(logs[-1], f"page loaded {window.get_current_url()}")
        # js_api 只挂 load_url 绑定方法，不挂窗口对象（挂窗口会让 create_proxy 爆栈）
        api = cw.call_args.kwargs["js_api"]
        self.assertIs(api.loader, window.load_url)
        # load_url 会清空 events.loaded，返回后 rearm 重新挂上，胶囊不会永久消失
        api.rearm()
        self.assertEqual(len(window.events.loaded.handlers), 2)
        window.events.loaded.handlers[1]()
        self.assertEqual(window.evaluate_js.call_count, 2)
        self.assertEqual(sum(1 for line in logs if line.startswith("page loaded ")), 2)


class MainWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._log = app.SHELL_LOG
        self._geo = app.GEOMETRY_FILE
        # 关窗会落几何与启动日志：测试里全指到临时目录，别写进真实的 configs / tmp
        app.SHELL_LOG = pathlib.Path(self._tmp.name) / "studio_shell.log"
        app.GEOMETRY_FILE = pathlib.Path(self._tmp.name) / "studio_window.json"

    def tearDown(self):
        app.SHELL_LOG = self._log
        app.GEOMETRY_FILE = self._geo
        self._tmp.cleanup()

    def test_warm_start_loads_url_directly(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        touched = []
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
            self.assertEqual(len(window.events.closing.handlers), 1)
            # 热启动：ComfyUI 是用户自己开的，壳没有句柄 → 关窗一个进程都不碰
            window.events.closing.handlers[0]()
        self.assertEqual(touched, [], "非壳拉起的 ComfyUI 关窗不许动")
        self.assertTrue(app.GEOMETRY_FILE.exists(), "关窗要存几何")
        # 已就绪：create_window 直接加载 url，不弹启动页；用户自己的 ComfyUI 不被壳接管
        self.assertEqual(cw.call_args[0][1], "http://127.0.0.1:8188/neo-studio")
        self.assertNotIn("html", cw.call_args.kwargs)
        self.assertIsNone(cw.call_args.kwargs["js_api"].comfy)
        self.assertFalse(cw.call_args.kwargs["js_api"].flags["starting"], "已就绪不报启动中")

    def test_links_stay_in_shell_window(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        fake = _fake_webview(cw)
        with patch.object(app, "webview", fake), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 「⤒ 主画布编辑」与顶栏「🎬 新影工坊」的 _blank 链接留在壳窗口内导航；blob 下载仍放行

        self.assertFalse(fake.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"])
        self.assertTrue(fake.settings["ALLOW_DOWNLOADS"])

    def test_cold_start_loads_offline_gallery(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=lambda timeout=None: 0)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "resolve_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "start_comfy", lambda python, root, port: comfy), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 冷启动：窗口直接进壳侧只读服务的离线素材页，就绪后由后台线程整页跳到完整 Studio
        self.assertEqual(cw.call_args[0][1], "http://127.0.0.1:8191/neo-studio")
        self.assertNotIn("html", cw.call_args.kwargs)
        self.assertEqual(cw.call_args.kwargs["js_api"].offline_url, "http://127.0.0.1:8191/neo-studio")
        # 壳侧只读服务与 js_api 共用启动中标记：窗口第一次 /neo_studio/version 就是「启动中」
        self.assertTrue(cw.call_args.kwargs["js_api"].flags["starting"])
        self.assertIs(cw.call_args.kwargs["js_api"].comfy, comfy)
        # 关窗带走壳自己拉起的这路：拉起阶段不碰它，关窗才 terminate
        self.assertEqual(len(window.events.closing.handlers), 1)
        comfy.terminate.assert_not_called()
        window.events.closing.handlers[0]()
        comfy.terminate.assert_called_once()
        self.assertFalse(cw.call_args.kwargs["js_api"].flags["starting"], "关窗收掉启动中")

    def test_cold_start_without_shell_service_falls_back_to_splash(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", lambda factory, port: SimpleNamespace(start=lambda: 0, stop=lambda: None, error=None)), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "resolve_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "start_comfy", lambda python, root, port: comfy), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 壳侧服务起不来（端口全被占）才退回启动页
        self.assertEqual(cw.call_args.kwargs["html"], app.splash_html())


    def test_start_passes_studio_icon(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = MagicMock()
        set_id = MagicMock()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app.ctypes.windll.shell32, "SetCurrentProcessExplicitAppUserModelID", set_id), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 图标走 pywebview 的 start(icon=...)：create_window 没有 icon 参数，
        # edgechromium 后端（winforms）读 _state['icon'] 设 Form.Icon

        self.assertEqual(start.call_args.kwargs["icon"], str(app.STUDIO_ICON))
        # 不设 AppUserModelID 时任务栏按钮会与其他 pythonw 窗口合并成通用 Python 图标
        set_id.assert_called_once_with(app.APP_ID)

    def test_missing_icon_passes_none(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = MagicMock()
        set_id = MagicMock()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "ShellServer", _fake_shell_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "STUDIO_ICON", pathlib.Path("D:/nope/neo-studio.ico")), \
             patch.object(app.ctypes.windll.shell32, "SetCurrentProcessExplicitAppUserModelID", set_id), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):

            self.assertEqual(app.main(), 0)
        # 缺 .ico 时传 None，让 pywebview 回退到 pythonw 自己的图标，也不设 AppUserModelID
        self.assertIsNone(start.call_args.kwargs["icon"])
        set_id.assert_not_called()

if __name__ == "__main__":
    unittest.main()
