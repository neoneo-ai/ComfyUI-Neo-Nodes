"""Neo Studio 桌面壳（pywebview + WebView2）：拉起 ComfyUI，窗口加载 /neo-studio。

与 neo-studio.ps1 同一套探活逻辑（GET /neo_studio/version 同时确认 ComfyUI 在跑与插件已加载），
差别是窗口由壳托管：几何存 configs/studio_window.json，localStorage 落在 tmp/studio_profile
（private_mode=False），_blank 链接交系统浏览器，blob 下载放行。
全程无控制台窗口：neo-studio-app.vbs 双击用 pythonw 启动，提示走系统消息框，排查看
tmp/studio_shell.log；ComfyUI 日志在 Studio「设置 → 日志」看（/neo_studio/log 读 app.logger 环形缓冲）。
ComfyUI 冷启动时窗口先显示启动页，后台探活就绪后跳到 Studio，双击后立刻能看到窗口。
窗口与任务栏图标用 web/neo-studio.ico（tools/make_studio_icon.py 生成）。

用法：python neo_studio_app.py [--port 8188] [--python <python.exe>] [--root <ComfyUI 根>]
                              [--no-quit-comfy] [--cdp <port>] [--debug]
关闭壳窗口默认顺带停掉由壳拉起的 ComfyUI（--no-quit-comfy 保留）；用户自己启动的 ComfyUI 不受影响。
"""

import argparse
import ctypes
import json
import logging
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

PLUGIN_DIR = Path(__file__).parent
SHELL_LOG = PLUGIN_DIR / "tmp" / "studio_shell.log"
SHELL_LOG.parent.mkdir(parents=True, exist_ok=True)

# pythonw 的 sys.stderr 是 None：pywebview 的 _setup_logger 挂的控制台 handler 会在写日志时抛异常，
# 打断窗口创建。先把它的日志接到壳日志文件，_setup_logger 看到已有 handler 就不会再挂控制台 handler。
pyw_log = logging.getLogger("pywebview")
pyw_log.addHandler(logging.FileHandler(str(SHELL_LOG), encoding="utf-8"))
pyw_log.setLevel(logging.INFO)

try:
    import webview
except ImportError:
    webview = None

DEFAULT_PORT = 8188
SINGLETON_PORT = 8189   # 壳单实例：绑定失败说明已有 Neo Studio 窗口
READY_TIMEOUT = 90      # ComfyUI 冷启动（扫描模型目录）留 90 秒
POLL_INTERVAL = 2.0
GEOMETRY_FILE = PLUGIN_DIR / "configs" / "studio_window.json"
PROFILE_DIR = PLUGIN_DIR / "tmp" / "studio_profile"
STUDIO_ICON = PLUGIN_DIR / "web" / "neo-studio.ico"   # tools/make_studio_icon.py 生成
APP_ID = "Neo.Studio"
NO_WINDOW = subprocess.CREATE_NO_WINDOW   # 壳无控制台时子进程会新建控制台窗口，必须压制


def alert(text: str) -> None:
    """pythonw 没有 stdout，提示走系统消息框。"""
    ctypes.windll.user32.MessageBoxW(0, text, "Neo Studio", 0x40)


def log_line(text: str) -> None:
    """壳自己的落盘日志：双击启动没有控制台，排查全靠它。"""
    SHELL_LOG.parent.mkdir(parents=True, exist_ok=True)
    prev = SHELL_LOG.read_text(encoding="utf-8") + "\n" if SHELL_LOG.exists() else ""
    SHELL_LOG.write_text(prev + f"[{time.strftime('%H:%M:%S')}] {text}", encoding="utf-8")


def resolve_root(root: str) -> Path:
    """插件在 custom_nodes/ComfyUI-Neo-Nodes 下，上两级就是 ComfyUI 根。"""
    return Path(root) if root else PLUGIN_DIR.parent.parent


def resolve_python(root: Path, python: str) -> Path:
    """整合包布局（python 与 ComfyUI 同级）优先，再回退 ComfyUI 内部。"""
    if python:
        return Path(python)
    for cand in (root.parent / "python" / "python.exe", root / "python" / "python.exe"):
        if cand.exists():
            return cand
    raise FileNotFoundError("未找到 python：请用 --python <python.exe 路径> 指定")


def probe(port: int, timeout: float = 3.0) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/neo_studio/version", timeout=timeout):
            return True
    except Exception:
        return False


def wait_ready(port: int, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if probe(port):
            return True
        time.sleep(POLL_INTERVAL)
    return probe(port)


def load_geometry() -> dict:
    try:
        data = json.loads(GEOMETRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {key: int(data[key]) for key in ("width", "height", "x", "y") if isinstance(data.get(key), int)}


def save_geometry(window) -> None:
    GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    GEOMETRY_FILE.write_text(json.dumps({"width": window.width, "height": window.height,
                                         "x": window.x, "y": window.y}), encoding="utf-8")


def start_comfy(python: Path, root: Path, port: int) -> subprocess.Popen:
    return subprocess.Popen([str(python), str(root / "main.py"), "--port", str(port)],
                            creationflags=NO_WINDOW)


def splash_html() -> str:
    """冷启动时先出窗口显示的启动页：ComfyUI 就绪前不让用户对着空白干等。"""
    return ('<!doctype html><meta charset=utf-8>'
            '<style>html,body{height:100%;margin:0;background:#1e1e1e;color:#d7dae0;'
            'font-family:system-ui;display:grid;place-items:center}'
            'h1{font-size:20px;font-weight:600}p{font-size:13px;color:#8a8f98}</style>'
            '<div><h1>新影工坊 · Neo Studio</h1><p>正在启动 ComfyUI，请稍候…</p></div>')


def singleton() -> socket.socket:
    """已有壳窗口则返回 None：第二个实例直接退出，避免多窗口抢显存。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", SINGLETON_PORT))
        sock.listen(1)
        return sock
    except OSError:
        sock.close()
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Neo Studio 桌面壳")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--python", default="")
    ap.add_argument("--root", default="")
    ap.add_argument("--quit-comfy", action=argparse.BooleanOptionalAction, default=True,
                    help="壳退出时顺带停掉由壳拉起的 ComfyUI（默认开；--no-quit-comfy 保留）")
    ap.add_argument("--cdp", type=int, default=0, help="WebView2 远程调试端口（E2E 用）")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    if webview is None:
        alert("缺少 pywebview：用整合包 python 执行 pip install pywebview")
        return 1

    log_line(f"start port={args.port}")
    lock = singleton()
    if lock is None:
        log_line("singleton busy")
        alert("Neo Studio 窗口已在运行")
        return 0

    root = resolve_root(args.root)
    url = f"http://127.0.0.1:{args.port}/neo-studio"
    comfy = None
    if not probe(args.port):
        python = resolve_python(root, args.python)
        comfy = start_comfy(python, root, args.port)
        log_line(f"comfy spawn pid={comfy.pid}")

    geo = load_geometry()
    # 冷启动先出启动页（html），就绪后由后台线程跳到 Studio；已就绪则直接加载
    kw = dict(width=geo.get("width", 1440), height=geo.get("height", 900),
             x=geo.get("x"), y=geo.get("y"), min_size=(900, 600))
    window = webview.create_window("新影工坊 · Neo Studio", url, **kw) if comfy is None \
        else webview.create_window("新影工坊 · Neo Studio", html=splash_html(), **kw)
    window.events.closing += lambda: save_geometry(window)
    if comfy is not None and args.quit_comfy:
        window.events.closing += lambda: comfy.terminate()

    def spawn_ready():
        if wait_ready(args.port, READY_TIMEOUT):
            window.load_url(url)
        else:
            log_line("comfy not ready")
            alert(f"ComfyUI {READY_TIMEOUT} 秒内未就绪，日志见 Studio「设置 → 日志」")
            comfy.terminate()
            window.destroy()

    # 任务栏图标：pythonw 没有 AppUserModelID，任务栏按钮会与其他 pythonw 窗口合并成通用 Python 图标；
    # 显式设 ID 后 start(icon=...) 才落到壳自己的图标（edgechromium 后端读 _state['icon']）
    icon = str(STUDIO_ICON) if STUDIO_ICON.exists() else None
    if icon:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)

    # 配方导出 / 模型库的 blob 下载要放行；「在主画布编辑」这类 _blank 链接交系统浏览器
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    if args.cdp:
        webview.settings["REMOTE_DEBUGGING_PORT"] = args.cdp
    log_line(f"webview start geo={geo}")
    on_start = (lambda: threading.Thread(target=spawn_ready, daemon=True).start()) if comfy is not None else None
    webview.start(on_start, private_mode=False, storage_path=str(PROFILE_DIR), gui="edgechromium",
                  debug=args.debug, icon=icon)
    log_line("webview end")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log_line("EXC " + repr(e))
        alert(str(e))
        sys.exit(1)
