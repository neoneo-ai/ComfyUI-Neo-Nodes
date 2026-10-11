"""Neo Studio 桌面壳（pywebview + WebView2）：拉起 ComfyUI，窗口加载 /neo-studio。

与 neo-studio.ps1 同一套探活逻辑（GET /neo_studio/version 同时确认 ComfyUI 在跑与插件已加载），
差别是窗口由壳托管：几何存 configs/studio_window.json（屏幕外位置自动丢弃，回退默认），
localStorage 落在 tmp/studio_profile
（private_mode=False），_blank 链接在壳窗口内导航（主画布交接与返回 Studio 都不出窗口），blob 下载放行。
全程无控制台窗口：neo-studio-app.vbs 双击用 pythonw 启动，提示走系统消息框，排查看
tmp/studio_shell.log；ComfyUI 日志在 Studio「设置 → 日志」看（/neo_studio/log 读 app.logger 环形缓冲），
ComfyUI 起不来时看 tmp/comfy_run.log（壳拉起它的完整 stdout/stderr，端口冲突与导入报错都在里面）。
ComfyUI 冷启动时窗口直接进壳侧只读服务（neo_studio_server）的离线素材库，探活就绪后整页跳到
完整 Studio；ComfyUI 停止后窗口退回离线素材库，浏览不受影响，生成类请求由壳回 409 offline。
壳拉起 ComfyUI 的这段时间 starting 为真（comfy_state 与壳侧 /neo_studio/version 共用同一份标记，
js_api 注入之前页面就知道在启动中），界面只出「ComfyUI 启动中…」，收起未运行横幅、
启动按钮与「需要 ComfyUI」提示。
窗口与任务栏图标用 web/neo-studio.ico（tools/make_studio_icon.py 生成）。

用法：python neo_studio_app.py [--port 8188] [--python <python.exe>] [--root <ComfyUI 根>]
                              [--cdp <port>] [--debug]
 壳是启动器：关窗只关窗口。顶栏「● ComfyUI :8188」胶囊由壳的 js_api 报状态（端口 / PID / 谁启动 / 就绪）：
 运行中点一下退出（壳拉起的 terminate，并按端口找监听者 PID 一并终止，外部启动的同样杀得掉），窗口留着、状态变灰；
 已停止点一下重新拉起，显示「启动中…」，就绪后窗口整页跳回 ComfyUI 的完整 Studio。

"""

import argparse
import ctypes
from ctypes import wintypes
import json
import logging
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from neo_studio_server import ShellServer, build_app

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
COMFY_LOG = PLUGIN_DIR / "tmp" / "comfy_run.log"   # 壳拉起 ComfyUI 的完整 stdout/stderr
LOG_MAX = 200_000   # 壳日志上限：反复开关机只增不减，写入前裁到尾部
LOG_LOCK = threading.Lock()   # js_api 调用各在自己的线程里跑，读全文再写回必须串行
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
SHELL_PORT_OFFSET = 3   # 壳侧只读素材服务：避开 8188（ComfyUI）与 8189（单实例锁）
READY_TIMEOUT = 90      # ComfyUI 冷启动（扫描模型目录）留 90 秒

POLL_INTERVAL = 2.0
GEOMETRY_FILE = PLUGIN_DIR / "configs" / "studio_window.json"
PROFILE_DIR = PLUGIN_DIR / "tmp" / "studio_profile"
STUDIO_ICON = RES_DIR / "web" / "neo-studio.ico"   # tools/make_studio_icon.py 生成
APP_ID = "Neo.Studio"
NO_WINDOW = subprocess.CREATE_NO_WINDOW   # 壳无控制台时子进程会新建控制台窗口，必须压制
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED = 0x1000
# restype 默认是 c_int，64 位句柄会被截断，TerminateProcess 拿到无效句柄静默失败
k32 = ctypes.windll.kernel32
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.TerminateProcess.restype = wintypes.BOOL
k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def alert(text: str) -> None:
    """pythonw 没有 stdout，提示走系统消息框。"""
    ctypes.windll.user32.MessageBoxW(0, text, "Neo Studio", 0x40)


def log_line(text: str) -> None:
    """壳自己的落盘日志：双击启动没有控制台，排查全靠它。只留尾部，别让它无限长。
    pywebview 把每个 js_api 调用丢进自己的线程，日志又是读全文再写回：不加锁并发写会丢行。"""
    line = f"[{time.strftime('%H:%M:%S')}] {text}"
    with LOG_LOCK:
        SHELL_LOG.parent.mkdir(parents=True, exist_ok=True)
        prev = SHELL_LOG.read_text(encoding="utf-8") + "\n" if SHELL_LOG.exists() else ""
        if len(prev) > LOG_MAX:
            prev = prev[-LOG_MAX:]
            prev = prev[prev.index("\n") + 1:] if "\n" in prev else prev   # 从整行开头截，别留半行
        SHELL_LOG.write_text(prev + line, encoding="utf-8")


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
    """启动输出落 tmp/comfy_run.log：CREATE_NO_WINDOW 下不重定向，端口冲突与导入报错就全进黑洞。"""
    COMFY_LOG.parent.mkdir(parents=True, exist_ok=True)
    log = open(COMFY_LOG, "wb", buffering=0)
    log.write(f"=== {time.strftime('%H:%M:%S')} port={port} {python}\n".encode("utf-8"))
    return subprocess.Popen([str(python), str(root / "main.py"), "--port", str(port)],
                            cwd=str(root), creationflags=NO_WINDOW,
                            stdout=log, stderr=subprocess.STDOUT)


def port_busy(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_comfy_port(preferred: int, shell_port: int) -> int:
    """端口被残留进程占着时往上找空位：硬撞 8188 会让拉起的 ComfyUI 立刻退出且毫无提示。"""
    if not port_busy(preferred):
        return preferred
    for port in range(preferred + 1, preferred + 40):
        if port != shell_port and not port_busy(port):
            return port
    return preferred


def port_owner(port: int) -> int:
    """按监听端口找进程 PID（netstat -ano）；没有监听者返回 0。"""
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                         creationflags=NO_WINDOW)
    for line in out.stdout.splitlines():
        f = line.split()
        if len(f) >= 5 and f[3] == "LISTENING" and f[1].split(":")[-1] == str(port):
            return int(f[4])
    return 0


def kill_pid(pid: int) -> bool:
    """按 PID 终止进程：用户自己启动的 ComfyUI 没有壳的 Popen 句柄。"""
    h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not h:
        return False
    ok = k32.TerminateProcess(h, 0)
    k32.CloseHandle(h)
    return bool(ok)


def pid_alive(pid: int) -> bool:
    """进程是否还活着（OpenProcess 拿到句柄即活着）：比每次重跑 netstat 便宜。"""
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED, False, pid)
    if h:
        k32.CloseHandle(h)
    return bool(h)


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


class StudioShell:
    """壳的 js_api：顶栏「返回 Studio」胶囊、ComfyUI 运行状态与退出。
    js_api 对象只挂 url、load_url 绑定方法与壳自己的进程状态；挂窗口对象会让 pywebview 的
    create_proxy 递归遍历 window.native.AccessibilityObject... 爆栈。"""

    def __init__(self, url: str, comfy, port: int, root: Path, python_arg: str = "", offline_url: str = "",
                 shell_port: int = 0, flags: dict = None):
        self.url = url
        self.offline_url = offline_url
        self.shell_port = shell_port
        self.comfy = comfy
        self.port = port
        self.root = root
        self.python_arg = python_arg
        self.pid = comfy.pid if comfy is not None else 0
        # 启动中标记与壳侧只读服务共用同一份：js_api 注入之前页面就能从版本快照拿到「启动中」
        self.flags = flags if flags is not None else {"starting": False}
        self.starting = comfy is not None
        self.loader = None
        self.rearm = None

    @property
    def starting(self) -> bool:
        return self.flags["starting"]

    @starting.setter
    def starting(self, value: bool) -> None:
        self.flags["starting"] = bool(value)

    def go_studio(self) -> None:
        self._goto(self.url)

    def _goto(self, target: str) -> None:
        if not target or self.loader is None:
            return
        log_line(f"goto {target}")
        self.loader(target)
        self.rearm()

    def log(self, message: str) -> None:
        """页面把前端未捕获错误与启动失败写进壳日志：白屏只有 DevTools 能看太晚，
        折成一行便于 grep（tmp/studio_shell.log）。"""
        log_line("[web] " + " ".join(message.split()))

    def _jump_when_ready(self) -> None:
        """离线页里点「重新拉起」：就绪后整页跳到 ComfyUI 的完整 Studio。"""
        if wait_ready(self.port, READY_TIMEOUT):
            self.starting = False
            self._goto(self.url)
        else:
            self.starting = False   # 没起来：离线横幅回到「未运行 + 启动」，别卡在启动中
            log_line("comfy restart not ready")


    def comfy_state(self) -> dict:
        """顶栏胶囊要的运行状态：外部启动的 ComfyUI 没有 Popen 句柄，按端口找 PID 并缓存。
        壳拉起的那路以端口探活为准 —— TerminateProcess 是异步的，进程还在收尾时端口已关，
        报「进程活着」会让胶囊显示运行中而服务其实已经没了。
        starting：壳拉起的进程还活着、端口还没就绪 —— 这段时间前端只出「启动中」，收起其余离线提示。"""
        ready = probe(self.port, 1.0)
        if self.comfy is not None:
            if ready:
                self.starting = False
            return {"port": self.port, "pid": self.comfy.pid, "mine": True,
                    "running": ready, "ready": ready,
                    "starting": self.starting and self.comfy.poll() is None}
        if not self.pid or not pid_alive(self.pid):
            self.pid = port_owner(self.port)
        return {"port": self.port, "pid": self.pid, "mine": False,
                "running": bool(self.pid), "ready": ready, "starting": False}

    def comfy_stop(self) -> dict:
        if self.comfy is not None:
            self.comfy.terminate()
            self.starting = False
        # 监听端口的未必是壳的 Popen（子进程、端口被占时的残留）：按端口反复杀到没人监听
        for _ in range(10):
            pid = port_owner(self.port)
            if not pid:
                break
            if not pid_alive(pid):
                break   # 正在收尾，端口马上空
            if not kill_pid(pid):
                log_line(f"comfy kill {pid} 失败：没有权限终止该进程")
                break
            time.sleep(0.5)
        self.pid = 0
        st = self.comfy_state()
        log_line(f"comfy stop {st}")
        if not st["ready"]:
            self._goto(self.offline_url)   # 窗口退回壳的只读素材库，不对着死页面干等
        return st

    def comfy_close(self) -> None:
        """关窗时带走壳自己拉起的 ComfyUI。

        只认自己那份 Popen 句柄：terminate 后等它退出，等不到就按自己的 PID 兜底终止。
        不做 comfy_stop 的按端口扫荡 —— 关窗路上重扫监听者会误杀抢端口的残留进程；
        用户自己启动的那路没有句柄（self.comfy 是 None），这里完全不碰。"""
        if self.comfy is None:
            return
        self.starting = False
        self.comfy.terminate()
        try:
            self.comfy.wait(timeout=5)
        except subprocess.TimeoutExpired:
            kill_pid(self.comfy.pid)
            log_line(f"comfy close kill pid={self.comfy.pid}")
        log_line("comfy closed with shell")

    def comfy_start(self) -> dict:
        """胶囊的启动路径：停止后重新拉起 ComfyUI，就绪后整页跳回完整 Studio。"""
        if self.comfy is not None:
            # 刚停止的进程可能还在收尾（TerminateProcess 异步），等它退出再拉起，避免端口冲突
            for _ in range(60):
                if self.comfy.poll() is not None:
                    break
                time.sleep(0.5)
        self.port = free_comfy_port(self.port, self.shell_port)
        self.comfy = start_comfy(resolve_python(self.root, self.python_arg), self.root, self.port)
        self.url = f"http://127.0.0.1:{self.port}/neo-studio"
        self.pid = self.comfy.pid
        self.starting = True
        log_line(f"comfy spawn pid={self.comfy.pid} port={self.port}")
        threading.Thread(target=self._jump_when_ready, daemon=True).start()
        return self.comfy_state()



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
    # 壳侧只读素材服务先起来：ComfyUI 没在跑时窗口里也是可浏览的 Neo Gallery
    # flags 由壳侧服务与 js_api 共用：拉起 ComfyUI 的那一刻起，页面的版本快照就是「启动中」
    flags = {"starting": False}
    server = ShellServer(lambda: build_app(root, PLUGIN_DIR, flags), args.port + SHELL_PORT_OFFSET)
    shell_port = server.start()
    offline_url = f"http://127.0.0.1:{shell_port}/neo-studio" if shell_port else ""
    # 起不来（端口被占 / 装配报错）只回 0，原因只能靠这行日志
    log_line(f"shell service port={shell_port}" if shell_port else f"shell service failed: {server.error!r}")

    comfy = None
    comfy_port = args.port
    if not probe(args.port):
        comfy_port = free_comfy_port(args.port, shell_port)
        python = resolve_python(root, args.python)
        comfy = start_comfy(python, root, comfy_port)
        log_line(f"comfy spawn pid={comfy.pid} port={comfy_port}")
    url = f"http://127.0.0.1:{comfy_port}/neo-studio"

    geo = load_geometry()
    # 已就绪直接进 ComfyUI 的完整 Studio；冷启动进壳的离线素材页，就绪后由后台线程跳过去
    shell = StudioShell(url, comfy, comfy_port, root, args.python, offline_url, shell_port, flags)
    kw = dict(width=geo.get("width", 1440), height=geo.get("height", 900),
             x=geo.get("x"), y=geo.get("y"), min_size=(900, 600), js_api=shell)
    start_url = url if comfy is None else offline_url
    window = webview.create_window("新影工坊 · Neo Studio", start_url, **kw) if start_url \
        else webview.create_window("新影工坊 · Neo Studio", html=splash_html(), **kw)
    shell.loader = window.load_url


    def arm_pill() -> None:
        def on_loaded() -> None:
            # 每次整页加载记一行：窗口停在离线页还是完整 Studio，事后看日志就知道
            log_line(f"page loaded {window.get_current_url()}")
            # 主画布是整页刷新，返回入口只能由壳在每次页面加载后重新挂上
            window.evaluate_js(BACK_JS)
        window.events.loaded += on_loaded

    shell.rearm = arm_pill
    arm_pill()
    # 关窗：存几何、收壳侧服务；壳自己拉起的 ComfyUI 跟着窗口一起走，用户自己起的那路不动
    def on_closing() -> None:
        save_geometry(window)
        server.stop()
        shell.comfy_close()

    window.events.closing += on_closing


    def spawn_ready():
        if wait_ready(comfy_port, READY_TIMEOUT):
            shell.starting = False   # 跳页前收掉「启动中」，新页面直接是完整 Studio
            log_line(f"comfy ready jump {url}")
            window.load_url(url)
        else:
            shell.starting = False
            log_line("comfy not ready")
            alert(f"ComfyUI {READY_TIMEOUT} 秒内未就绪，启动输出见 {COMFY_LOG}")
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
    log_line(f"webview start geo={geo} url={start_url or 'splash'}")
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
