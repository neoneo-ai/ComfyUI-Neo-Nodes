"""Neo Studio 桌面壳（neo_studio_app.py）单测：路径解析、探活、几何持久化、单实例。"""

import json
import logging
import pathlib
import sys
import tempfile
import unittest
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

    def test_pywebview_logger_writes_to_shell_log(self):
        # pythonw 的 sys.stderr 是 None，pywebview 的控制台 handler 会在写日志时抛异常打断窗口创建；
        # 导入壳时先把 pywebview 日志接到壳日志文件，_setup_logger 就不会再挂控制台 handler
        handlers = logging.getLogger("pywebview").handlers
        self.assertTrue(any(isinstance(h, logging.FileHandler) for h in handlers))


class SingletonTests(unittest.TestCase):
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
    return SimpleNamespace(events=SimpleNamespace(closing=_Event()))


def _fake_webview(create_window, start=None):
    return SimpleNamespace(create_window=create_window, settings={},
                           start=start or (lambda *a, **k: None))


class MainWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._log = app.SHELL_LOG
        app.SHELL_LOG = pathlib.Path(self._tmp.name) / "studio_shell.log"

    def tearDown(self):
        app.SHELL_LOG = self._log
        self._tmp.cleanup()

    def test_warm_start_loads_url_directly(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 已就绪：create_window 直接加载 url，不弹启动页；用户自己的 ComfyUI 不被壳接管
        self.assertEqual(cw.call_args[0][1], "http://127.0.0.1:8188/neo-studio")
        self.assertNotIn("html", cw.call_args.kwargs)
        self.assertEqual(len(window.events.closing.handlers), 1)  # 只有 save_geometry

    def test_cold_start_shows_splash_then_loads(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "resolve_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "start_comfy", lambda python, root, port: comfy), \
             patch.object(sys, "argv", ["neo_studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 冷启动：先出启动页（html），就绪后由后台线程 load_url，不直接加载 url
        self.assertEqual(cw.call_args.kwargs["html"], app.splash_html())
        self.assertNotIn("url", cw.call_args.kwargs)
        # 关闭壳窗口顺带停掉壳拉起的 ComfyUI（默认开）：closing 挂 save_geometry + terminate
        self.assertEqual(len(window.events.closing.handlers), 2)
        window.events.closing.handlers[1]()
        comfy.terminate.assert_called_once()

    def test_no_quit_comfy_keeps_shell_spawned_comfy(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: object()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "resolve_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "start_comfy", lambda python, root, port: comfy), \
             patch.object(sys, "argv", ["neo_studio_app.py", "--no-quit-comfy"]):
            self.assertEqual(app.main(), 0)
        # --no-quit-comfy：关闭壳窗口不停 ComfyUI，只挂 save_geometry
        self.assertEqual(len(window.events.closing.handlers), 1)
        comfy.terminate.assert_not_called()

    def test_start_passes_studio_icon(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = MagicMock()
        set_id = MagicMock()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: object()), \
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
