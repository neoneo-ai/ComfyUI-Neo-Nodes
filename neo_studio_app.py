"""Neo Studio 桌面壳（pywebview + WebView2）：拉起 ComfyUI，窗口加载 /neo-studio。

与 neo-studio.ps1 同一套探活逻辑（GET /neo_studio/version 同时确认 ComfyUI 在跑与插件已加载），
差别是窗口由壳托管：几何存 configs/studio_window.json（屏幕外位置自动丢弃，回退默认），
localStorage 落在 tmp/studio_profile
（private_mode=False），_blank 链接在壳窗口内导航（主画布交接与返回 Studio 都不出窗口），blob 下载放行。
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

def base_dirs():
    """打包后 __file__ 指向临时解包目录：持久化按插件目录算，随包资源走 _MEIPASS。"""
    if getattr(sys, "frozen", False):
        # 产物在 tools 下，向上找到插件目录；exe 直接放在插件目录时 parents 找不到，回退 exe_dir
        exe_dir = Path(sys.executable).parent
        plugin = next((p for p in exe_dir.parents if p.name == "ComfyUI-Neo-Nodes"), exe_dir)
        return plugin, Path(sys._MEIPASS)
    return Path(__file__).parent, Path(__file__).parent


PLUGIN_DIR, RES_DIR = base_dirs()
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
STUDIO_ICON = RES_DIR / "web" / "neo-studio.ico"   # tools/make_studio_icon.py 生成
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


def on_screen(x: int, y: int, w: int, h: int) -> bool:
    """位置必须与虚拟屏幕（所有显示器并集）相交。最小化时 Windows 报 -32000 系坐标，拔掉的外接屏同理，
    这种位置存下来下次启动窗口就在屏幕外看不见。"""
    u = ctypes.windll.user32
    vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)
    vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
    return x < vx + vw and x + w > vx and y < vy + vh and y + h > vy


def load_geometry() -> dict:
    try:
        data = json.loads(GEOMETRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    geo = {key: int(data[key]) for key in ("width", "height", "x", "y") if isinstance(data.get(key), int)}
    if not on_screen(geo.get("x", 0), geo.get("y", 0), geo.get("width", 1440), geo.get("height", 900)):
        geo.pop("x", None)
        geo.pop("y", None)
    return geo


def save_geometry(window) -> None:
    geo = {"width": window.width, "height": window.height, "x": window.x, "y": window.y}
    # 最小化关闭时位置是 -32000 系、尺寸是最小化态的假值（158x26），整份几何都不值得存
    if not on_screen(geo["x"], geo["y"], geo["width"], geo["height"]):
        return
    GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    GEOMETRY_FILE.write_text(json.dumps(geo), encoding="utf-8")


def start_comfy(python: Path, root: Path, port: int) -> subprocess.Popen:
    return subprocess.Popen([str(python), str(root / "main.py"), "--port", str(port)],
                            creationflags=NO_WINDOW)


BACK_JS = """
(() => {
    const inject = () => {
        if (location.pathname.startsWith('/neo-studio')) return;   // Studio 页顶栏已有回主画布的链接
        if (document.getElementById('neo-studio-back')) return;
        const b = document.createElement('button');
        b.id = 'neo-studio-back';
        b.textContent = '🎬 返回 Studio';
        b.title = '返回 Neo Studio 主页';
        b.style.cssText = 'position:fixed;top:56px;left:8px;z-index:100000;padding:5px 12px;'
            + 'border-radius:14px;border:1px solid #4a4a4f;background:#26262a;color:#d7dae0;'
            + 'font:12px system-ui;line-height:1;cursor:pointer';
        b.onmouseenter = () => { b.style.background = '#333338'; };
        b.onmouseleave = () => { b.style.background = '#26262a'; };
        b.onclick = () => window.pywebview.api.go_studio();
        document.body.appendChild(b);
    };
    // loaded 早于 pywebview api 注入完成：重试几轮再放弃，避免常驻轮询
    let tries = 0;
    const tick = () => {
        if (window.pywebview && window.pywebview.api) inject();
        else if (tries++ < 10) setTimeout(tick, 300);
    };
    tick();
})();
"""


class StudioBack:
    """壳注入页面的「返回 Studio」胶囊：主画布整页刷新后由 loaded 事件重新挂上。
    js_api 对象只挂 url 和 load_url 绑定方法；挂窗口对象会让 pywebview 的 create_proxy
    递归遍历 window.native.AccessibilityObject... 爆栈。"""

    def __init__(self, url: str):
        self.url = url
        self.loader = None
        self.rearm = None

    def go_studio(self) -> None:
        # load_url 会清空 events.loaded，跳完必须重新挂注入
        self.loader(self.url)
        self.rearm()


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
    back = StudioBack(url)
    kw = dict(width=geo.get("width", 1440), height=geo.get("height", 900),
             x=geo.get("x"), y=geo.get("y"), min_size=(900, 600), js_api=back)
    window = webview.create_window("新影工坊 · Neo Studio", url, **kw) if comfy is None \
        else webview.create_window("新影工坊 · Neo Studio", html=splash_html(), **kw)
    back.loader = window.load_url

    def arm_pill() -> None:
        # 主画布是整页刷新，返回入口只能由壳在每次页面加载后重新挂上
        window.events.loaded += lambda: window.evaluate_js(BACK_JS)

    back.rearm = arm_pill
    arm_pill()
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

    # 配方导出 / 模型库的 blob 下载要放行；「⤒ 主画布编辑」与顶栏「🎬 新影工坊」这类 _blank 链接
    # 留在壳窗口里：edgechromium 的 NewWindowRequested 走 load_url，交接与返回都不弹浏览器标签页
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
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
