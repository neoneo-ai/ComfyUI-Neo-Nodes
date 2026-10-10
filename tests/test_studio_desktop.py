"""Neo Studio 桌面壳（neo_studio_app.py）单测：路径解析、探活、几何持久化、单实例。"""

import json
import logging
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

_PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PLUGIN_DIR))

import neo_studio_app as app


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


if __name__ == "__main__":
    unittest.main()
