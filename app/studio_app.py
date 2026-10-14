"""Neo Studio 桌面壳（pywebview + WebView2）：拉起 ComfyUI，窗口加载 /neo-studio。

与 neo-studio.ps1 同一套探活逻辑（GET /neo_studio/version 同时确认 ComfyUI 在跑与插件已加载），
差别是窗口由壳托管：几何存 data/studio_window.json（屏幕外位置自动丢弃，回退默认），
localStorage 落在 data/studio_profile
（private_mode=False），_blank 链接在壳窗口内导航（主画布交接与返回 Studio 都不出窗口），blob 下载放行。
全程无控制台窗口：neo-studio-app.vbs 双击用 pythonw 启动，提示走系统消息框，排查看
data/studio_shell.log；ComfyUI 日志在 Studio「设置 → 日志」看（/neo_studio/log 读 app.logger 环形缓冲），
ComfyUI 起不来时看 data/comfy_run.log（壳拉起它的完整 stdout/stderr，端口冲突与导入报错都在里面）。
窗口先出（引导页 / 启动页），自检、壳侧只读服务、拉起 ComfyUI 都在后台线程走完，就绪后整页跳过去：
ComfyUI 已在运行时进完整 Studio；冷启动进壳侧只读服务（neo_studio_server）的离线素材库；
ComfyUI 停止后窗口退回离线素材库，浏览不受影响，生成类请求由壳回 409 offline。
壳拉起 ComfyUI 的这段时间 starting 为真（comfy_state 与壳侧 /neo_studio/version 共用同一份标记，
js_api 注入之前页面就知道在启动中），界面只出「ComfyUI 启动中…」，收起未运行横幅、
启动按钮与「需要 ComfyUI」提示。
窗口与任务栏图标用 kernel-plugin/web/neo-studio.ico（tools/make_studio_icon.py 生成）。

用法：python app/studio_app.py [--port 8188] [--python <python.exe>] [--root <ComfyUI 根>]
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
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

from studio_server import ShellServer, build_app

IS_FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent
EXE_DIR = Path(sys.executable).resolve().parent if IS_FROZEN else APP_DIR
RES_DIR = Path(getattr(sys, "_MEIPASS", EXE_DIR))
# 内核插件装进 ComfyUI 后的目录名，与 kernel-plugin/pyproject.toml 的 package name 逐字对齐：
# 前端静态文件走 /extensions/<目录名>/，大小写敏感，两边拼出来的 URL 必须一致。
PLUGIN_NAME = "comfyui-neo-studio"
# 壳侧服务加载的插件源码：源码运行是仓库里的 kernel-plugin/，exe 里是随包的内置副本，
# 同时也是自动装进 custom_nodes 的源。
PLUGIN_SOURCE_DIR = RES_DIR / "bundled" / PLUGIN_NAME if IS_FROZEN else REPO_ROOT / "kernel-plugin"

APP_NAME = "Neo Studio"
_state_dir: Optional[Path] = None


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        mark = path / ".write-test"
        mark.write_text("", encoding="utf-8")
        mark.unlink()
        return True
    except OSError:
        return False


def pick_state_dir(exe_dir: Path, appdata: str = "") -> Path:
    """exe 旁的 data/ 优先；exe 丢在不可写目录时退到 %APPDATA%\\Neo Studio。"""
    cand = exe_dir / "data"
    if _writable(cand):
        return cand
    base = Path(appdata or str(exe_dir)) / APP_NAME
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return base


def state_dir() -> Path:
    """日志 / 窗口几何 / 浏览器 profile / 启动配置的落点，只算一次。

    源码运行 = 仓库的 data/；exe 运行 = pick_state_dir(EXE_DIR)。应用状态只属于壳，
    不落在内核插件目录里。
    """
    global _state_dir
    if _state_dir is not None:
        return _state_dir
    _state_dir = REPO_ROOT / "data" if not IS_FROZEN else pick_state_dir(EXE_DIR, os.environ.get("APPDATA", ""))
    return _state_dir


STATE = state_dir()
SHELL_LOG = STATE / "studio_shell.log"
COMFY_LOG = STATE / "comfy_run.log"
GEOMETRY_FILE = STATE / "studio_window.json"
PROFILE_DIR = STATE / "studio_profile"
CONFIG_FILE = STATE / "launcher_config.json"   # 记住的 root / python / port
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
    from webview import FileDialog
except ImportError:
    webview = None

DEFAULT_PORT = 8188
SINGLETON_MUTEX = "Local\\Neo.Studio.SingleInstance"   # 单实例锁走命名互斥体，不占端口
ERROR_ALREADY_EXISTS = 183
SHELL_PORT_OFFSET = 3   # 壳侧只读素材服务：避开 ComfyUI 的 8188
READY_TIMEOUT = 90      # ComfyUI 冷启动（扫描模型目录）留 90 秒

POLL_INTERVAL = 2.0
WEBVIEW_CACHE = PROFILE_DIR / "EBWebView" / "Default" / "Cache"   # WebView2 的 HTTP 缓存，跨会话留着
STUDIO_ICON = (RES_DIR / "web" / "neo-studio.ico") if IS_FROZEN else (PLUGIN_SOURCE_DIR / "web" / "neo-studio.ico")   # tools/make_studio_icon.py 生成
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
k32.CreateMutexW.restype = wintypes.HANDLE
k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
k32.GetLastError.restype = wintypes.DWORD


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


def resolve_root(root: str) -> Optional[Path]:
    """CLI > 启动配置 > 壳自身位置推导。

    每一层父目录先找同级的 ComfyUI/（Neo-Studio 与内核并排摆放的布局），再找该目录自身
    （壳跑在 ComfyUI/custom_nodes/<插件> 里、exe 在插件 tools 的包目录里都靠这条）。
    推导出的位置必须真有 main.py。两条都落空返回 None，让 main 出引导页。
    """
    if root:
        return Path(root)
    cfg = load_config()
    if cfg.get("root"):
        return Path(cfg["root"])
    for cand in EXE_DIR.parents:
        for guess in (cand / "ComfyUI", cand):
            if root_ok(guess):
                return guess
    return None


def find_python(root: Path, python: str) -> Optional[Path]:
    """整合包布局（python 与 ComfyUI 同级）优先，再回退 ComfyUI 内部；找不到回 None。

    找不到不是错误：引导页负责让用户选一个。"""
    if python:
        return Path(python)
    for cand in (root.parent / "python" / "python.exe", root / "python" / "python.exe"):
        if cand.exists():
            return cand
    return None


def resolve_python(root: Path, python: str) -> Path:
    py = find_python(root, python)
    if py is None:
        raise FileNotFoundError("未找到 python：在首次设置里选 python.exe，或用 --python <python.exe 路径> 指定")
    return py


# ---------------------------------------------------------------------------
# 启动配置与拉起前自检
# ---------------------------------------------------------------------------

CONFIG_VERSION = 1

# 自检状态：写进启动快照给「启动设置」页与离线横幅看
ST_OK = "ok"
ST_BAD_ROOT = "bad_root"
ST_NO_PYTHON = "missing_python"
ST_NO_DEPS = "deps_missing"
ST_INSTALL_FAIL = "install_failed"

# 插件 import 期硬依赖。ComfyUI 自带 pyyaml / Pillow / aiohttp，任何跑得起来的
# ComfyUI 环境都满足；openai / pypinyin / laya 是懒导入或自带降级，不检查也不拦。
DEPS_PROBE = ("import importlib.util, sys; sys.exit(0 if all("
              "importlib.util.find_spec(m) for m in ('yaml', 'PIL', 'aiohttp')) else 1)")


def plugin_dir_for(root: Path) -> Path:
    return root / "custom_nodes" / PLUGIN_NAME


def root_ok(root: Path) -> bool:
    return root.is_dir() and (root / "main.py").is_file()


def load_config() -> dict:
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(root: Path, python: str, port: int) -> bool:
    cfg = {"version": CONFIG_VERSION, "root": str(root), "python": str(python), "port": int(port)}
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CONFIG_FILE)
        return True
    except OSError:
        return False


def deps_ok(python: Path) -> bool:
    """目标 Python 是否具备插件 import 期硬依赖。"""
    if not Path(python).is_file():
        return False
    try:
        proc = subprocess.run([str(python), "-c", DEPS_PROBE],
                              creationflags=NO_WINDOW, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def install_deps(python: Path, plugin_dir: Path) -> dict:
    """装插件 requirements.txt 的依赖。联网安装，只由用户在「启动设置」点按钮触发。"""
    req = plugin_dir / "requirements.txt"
    if not req.is_file():
        return {"ok": False, "error": f"找不到依赖清单：{req}"}
    proc = subprocess.run([str(python), "-m", "pip", "install", "--no-warn-script-location",
                           "-r", str(req)],
                          creationflags=NO_WINDOW)
    if proc.returncode:
        return {"ok": False, "error": f"pip 退出码 {proc.returncode}，检查网络与代理后重试。"}
    return {"ok": True, "msg": "依赖安装完成。"}


def pyproject_version(plugin_dir: Path) -> str:
    """目录里 pyproject.toml 的版本号；读不到回空串（比任何 release 都旧）。"""
    try:
        text = (Path(plugin_dir) / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    return m.group(1) if m else ""


def _ver(text: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", text))


# 装进 custom_nodes 的只有代码与内置预设：用户数据归壳的数据根，插件按 NEO_STUDIO_DATA 与
# 插件目录里的指针去找。开发目录里的运行数据不能跟着进内核。
INSTALL_SKIP = ("build", "dist", "tests", "docs", "node_modules", "__pycache__", ".git", ".github",
                ".pytest_cache", "test-results", "tmp", "data", "gallery", "locals",
                "prompts/custom", "prompts/templates/custom", "prompts/_tags_index.json",
                "skills/custom", "recipes/custom", "recipes/.thumbs", "configs/skill_overrides")
INSTALL_SKIP_FILES = ("remote_llm_config.json", "model_config.json", "gallery_settings.json",
                      "image_gen.json", "video_gen.json", "bookmarks.json", "model_hub.json",
                      "backyard_oss.json", "studio_window.json", "gallery_dim_cache.json",
                      "laya_token.json", "neo_repair_mappings.json")


def install_ignore(source_dir: Path):
    """copytree 过滤器：按相对路径挡掉开发产物与用户数据，只放行代码与内置预设。"""
    src = str(source_dir)

    def ignore(directory: str, names: list) -> set:
        rel = os.path.relpath(directory, src).replace("\\", "/")
        prefix = "" if rel == "." else rel + "/"
        skipped = set()
        for name in names:
            path = prefix + name
            if any(path == p or path.startswith(p + "/") for p in INSTALL_SKIP):
                skipped.add(name)
            elif name in INSTALL_SKIP_FILES:
                skipped.add(name)
            elif name.endswith((".log", ".spec")):
                skipped.add(name)
        return skipped

    return ignore


def write_data_pointer(plugin_dir: Path) -> None:
    """把数据根写进插件目录：用户不经壳自己起 ComfyUI 时，插件靠它找到同一份用户数据。"""
    cfg = {"version": 1, "data_root": str(STATE.resolve())}
    target = plugin_dir / "configs" / "data_root.json"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        log_line(f"data pointer failed: {exc}")


def update_plugin(plugin_dir: Path, source_dir: Path) -> None:
    """内置副本覆盖更新：新副本先在状态目录拼好，再把旧副本换出去。

    只有换目录这一步碰到旧副本：ComfyUI 正在跑时目录被占用，move 直接失败，旧副本原样留着，
    下次启动再更新。新副本没搬进去就把旧副本搬回来，绝不让 custom_nodes 空在那个位置。
    用户数据不在插件目录里，覆盖它不影响数据。
    """
    staging = STATE / "plugin_update"
    backup = STATE / "plugin_old"
    try:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(source_dir, staging, ignore=install_ignore(source_dir))
        shutil.rmtree(backup, ignore_errors=True)
        shutil.move(str(plugin_dir), str(backup))
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        log_line(f"plugin update skipped: {exc}")
        return
    try:
        shutil.move(str(staging), str(plugin_dir))
    except OSError as exc:
        shutil.move(str(backup), str(plugin_dir))
        log_line(f"plugin update failed: {exc}")
        return
    shutil.rmtree(backup, ignore_errors=True)
    log_line("plugin update done")


def ensure_plugin(plugin_dir: Path, source_dir: Path = PLUGIN_SOURCE_DIR) -> tuple[bool, str]:
    """custom_nodes 里的插件副本：缺失就装内置副本，内置副本更新就跟着更新。

    更新只认 exe 里的 release：源码运行那份就是开发中的插件本身，git 检出归 ComfyUI-Manager 与用户
    自己维护，都不覆盖。用户数据目录整目录带进新副本，代码文件按新副本换。
    """
    if plugin_dir.is_dir():
        new, old = pyproject_version(source_dir), pyproject_version(plugin_dir)
        if IS_FROZEN and _ver(new) > _ver(old) and not (plugin_dir / ".git").exists():
            log_line(f"plugin update {old or '无版本号'} -> {new}")
            update_plugin(plugin_dir, source_dir)
        write_data_pointer(plugin_dir)
        return True, ""
    if not source_dir.is_dir():
        return False, "启动器没有内置插件副本，请手动安装 Neo Studio 后重试。"
    custom_nodes = plugin_dir.parent
    try:
        custom_nodes.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir, plugin_dir, ignore=install_ignore(source_dir))
    except OSError as exc:
        return False, f"写入 {custom_nodes} 失败：{exc}"
    write_data_pointer(plugin_dir)
    return True, ""


def startup_state(root: Path, python: Path, plugin_dir: Path) -> tuple[str, str]:
    """拉起 ComfyUI 前的自检；插件缺失直接自动安装，不需要用户动手。"""
    if not root_ok(root):
        return ST_BAD_ROOT, f"不是 ComfyUI 根目录（找不到 main.py）：{root}"
    if not Path(python).is_file():
        return ST_NO_PYTHON, f"Python 解释器不存在：{python}"
    ok, msg = ensure_plugin(plugin_dir)
    if not ok:
        return ST_INSTALL_FAIL, msg
    if not deps_ok(python):
        return ST_NO_DEPS, (f"目标 Python 缺少插件依赖，在「启动设置」点「安装依赖」，或手动执行：\n"
                            f'"{python}" -m pip install -r "{plugin_dir / "requirements.txt"}"')
    return ST_OK, ""


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
    try:
        geo = {"width": window.width, "height": window.height, "x": window.x, "y": window.y}
    except Exception:
        return   # 窗口已销毁读不到属性：几何之前存过，不能让它挡住关窗后面的收尾
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
    env = {**os.environ, "NEO_STUDIO_DATA": str(STATE)}
    return subprocess.Popen([str(python), str(root / "main.py"), "--port", str(port)],
                            cwd=str(root), creationflags=NO_WINDOW, env=env,
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


def reap(proc: subprocess.Popen, timeout: float) -> None:
    """回收子进程。TerminateProcess 之后进程只剩一个内核对象，不 reap 就一直能被 OpenProcess 打开，
    pid_alive 永远报「还活着」：关窗因此固定睡满等待上限（用户读成卡死），胶囊停止也因此在僵尸 PID 上
    强杀失败（「没有权限终止该进程」）。"""
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        pass


def port_owner(port: int) -> int:
    """按监听端口找进程 PID（netstat -ano）；没有监听者返回 0。"""
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
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


CLOSING_JS = """
(() => {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:100002;display:grid;place-items:center;'
        + 'background:rgba(20,20,24,.94);color:#d7dae0;font:15px system-ui;pointer-events:none';
    o.textContent = '正在停止 ComfyUI…';
    document.documentElement.appendChild(o);
})();
"""


class StudioShell:
    """壳的 js_api：顶栏「返回 Studio」胶囊、ComfyUI 运行状态与退出。
    js_api 对象只挂 url、load_url 绑定方法与壳自己的进程状态；挂窗口对象会让 pywebview 的
    create_proxy 递归遍历 window.native.AccessibilityObject... 爆栈。"""

    def __init__(self, url: str, comfy, port: int, root: Path, python_arg: str = "", offline_url: str = "",
                 shell_port: int = 0, flags: dict = None, launcher: dict = None):
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
        # 启动设置快照：壳侧服务与 js_api 共用同一份 dict，设置页与离线横幅都读它
        self.launcher = launcher if launcher is not None else {}
        self.starting = comfy is not None
        self.loader = None
        self.rearm = None
        # 壳侧服务由 main() 注入：引导页补完根目录才装配得起来，start_setup 需要再叫一次
        self.ensure_server = None
        self._closed = False
        # 关窗与后台启动序列撞在一起时的闸门：拉起 ComfyUI 前后各看一次，别让刚起的那路变孤儿
        self.closing = False

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
            reap(self.comfy, 2)   # 不 reap 的话下面按 PID 判活会一直「活着」，强杀必然失败
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

        只认自己那份 PID：terminate 之后回收子进程，回收超时（真没退出）才按 PID 兜底强杀。
        必须回收 —— 不回收的话进程只剩内核对象，pid_alive 会一直报「还活着」，关窗固定睡满
        等待上限、兜底强杀也必然失败；回收刚成功时进程对象也还会残留几毫秒，判活会读到假活。
        不做 comfy_stop 的按端口扫荡 —— 关窗路上重扫监听者会误杀抢端口的残留进程；
        用户自己启动的那路没有句柄（self.comfy 是 None），这里完全不碰。"""
        if self.comfy is None or self._closed:
            return
        self._closed = True
        self.starting = False
        pid = self.comfy.pid
        self.comfy.terminate()
        try:
            self.comfy.wait(timeout=3)
        except subprocess.TimeoutExpired:
            kill_pid(pid)
            log_line(f"comfy close kill pid={pid}")
        log_line(f"comfy closed with shell pid={pid}")

    def comfy_start(self) -> dict:
        """胶囊的启动路径：停止后重新拉起 ComfyUI，就绪后整页跳回完整 Studio。"""
        if self.comfy is not None:
            # 刚停止的进程可能还在收尾（TerminateProcess 异步），等它退出再拉起，避免端口冲突
            for _ in range(60):
                if self.comfy.poll() is not None:
                    break
                time.sleep(0.5)
        if port_busy(self.port):
            # 端口上已有一路 ComfyUI 在跑：附着上去，绝不在旁边拉第二路
            self.comfy = None
            self.pid = 0
            self.starting = False
            log_line(f"comfy attach port={self.port}")
            threading.Thread(target=self._jump_when_ready, daemon=True).start()
            return self.comfy_state()
        self.port = free_comfy_port(self.port, self.shell_port)
        self.comfy = start_comfy(resolve_python(self.root, self.python_arg), self.root, self.port)
        self.url = f"http://127.0.0.1:{self.port}/neo-studio"
        self.pid = self.comfy.pid
        self.starting = True
        log_line(f"comfy spawn pid={self.comfy.pid} port={self.port}")
        threading.Thread(target=self._jump_when_ready, daemon=True).start()
        return self.comfy_state()



    def launcher_state(self) -> dict:
        """「启动设置」页的快照：根目录 / 解释器 / 端口 / 插件位置 / 自检状态。"""
        return dict(self.launcher)

    def pick_root(self) -> str:
        """原生目录选择器，只回路径；校验交给「保存并重启」，选完还能改。"""
        return pick_folder(str(self.launcher.get("root", "")))

    def pick_python(self) -> str:
        """原生文件对话框选 python.exe：起始目录落在当前解释器所在的文件夹。"""
        cur = Path(str(self.launcher.get("python", "")))
        return pick_python_file(str(cur.parent) if cur.parent.is_dir() else "")

    def check_setup(self, root: str, python: str) -> dict:
        """引导页的实时校验：根目录要有 main.py，解释器要真是文件。"""
        root_s, py_s = str(root).strip(), str(python).strip()
        # 空串会变相对路径 "."：启动器在 ComfyUI 目录里跑时那就是个合法根目录，必须挡掉
        return {"root_ok": bool(root_s) and root_ok(Path(root_s)),
                "python_ok": bool(py_s) and Path(py_s).is_file(),
                "root": root_s, "python": py_s}

    def start_setup(self, root: str, python: str) -> dict:
        """引导页的「开始」：根目录补完了壳侧服务才装配得起来，起完再走保存并拉起。"""
        self.launcher.update(root=str(root).strip(), python=str(python).strip())
        if not self.ensure_server():
            return {"ok": False, "error": self.launcher.get("error")
                            or "壳侧服务起不来，原因见启动器日志"}
        return self.apply_launcher(root, python, self.port)

    def apply_launcher(self, root: str, python: str, port: int) -> dict:
        """保存启动设置并重启 ComfyUI：换根目录、换解释器、换端口都走这一条路。"""
        root_s, py_s = str(root).strip(), str(python).strip()
        root_p, py = Path(root_s), Path(py_s)
        if not root_s or not root_ok(root_p):
            return {"ok": False, "error": f"不是 ComfyUI 根目录（找不到 main.py）：{root_s}"}
        if not py_s or not py.is_file():
            return {"ok": False, "error": f"Python 解释器不存在：{py_s}"}
        try:
            port = int(port)
        except (TypeError, ValueError):
            return {"ok": False, "error": f"端口不是数字：{port}"}
        if not 1024 <= port <= 65535:
            return {"ok": False, "error": f"端口需在 1024-65535 之间：{port}"}
        if not save_config(root_p, py, port):
            return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
        self.root, self.python_arg, self.port = root_p, str(py), port
        self.launcher.update(root=str(root_p), python=str(py), port=port,
                             plugin_dir=str(plugin_dir_for(root_p)))
        log_line(f"launcher apply root={root_p} python={py} port={port}")
        self.comfy_stop()   # 带走旧进程，窗口退回离线页
        state, msg = startup_state(root_p, py, plugin_dir_for(root_p))
        self.launcher.update(state=state, error=msg)
        if state != ST_OK:
            return {"ok": False, "error": msg, "state": state}
        st = self.comfy_start()
        self.launcher.update(comfy=st)
        return {"ok": True, "state": state, "comfy": st}

    def install_plugin(self) -> dict:
        """自动安装失败后的重试：把内置副本装进 custom_nodes，成功就接着拉起。"""
        plugin_dir = plugin_dir_for(self.root)
        ok, msg = ensure_plugin(plugin_dir)
        if not ok:
            self.launcher.update(state=ST_INSTALL_FAIL, error=msg)
            log_line(f"install plugin failed: {msg}")
            return {"ok": False, "error": msg}
        self.launcher.update(plugin_dir=str(plugin_dir), state=ST_OK, error="")
        log_line(f"plugin installed {plugin_dir}")
        return self.comfy_start()

    def install_deps(self) -> dict:
        """联网装插件依赖：只在依赖安全网失败时出现，由用户显式点。"""
        res = install_deps(self.python_arg, plugin_dir_for(self.root))
        log_line(f"install deps {res}")
        if res["ok"]:
            self.launcher.update(state=ST_OK, error="")
        return res


def purge_web_cache() -> None:
    """开窗口前清掉 WebView2 的 HTTP 缓存。

    壳侧静态文件已经 no-store，但历史缓存里的旧插件 JS 会被直接端出来用（不发请求）：
    改了 web/*.js 之后，旧模块和新拉到的模块拼进同一张 ES 模块图，一个链接错误
    （旧 gallery-utils.js 没有新导出）就让 studio-app.js 整份不执行 —— 视图不挂、
    离线横幅不出、顶栏胶囊永远 hidden，窗口只剩顶栏，连重新拉起 ComfyUI 的按钮都没有。"""
    shutil.rmtree(WEBVIEW_CACHE, ignore_errors=True)


PY_FILE_TYPES = ("Python 解释器 (*.exe)",)
_studio_window = None   # main() 建好窗口后回填：对话框走窗口模态，选择框贴着窗口


def _on_sta(call):
    """对话框是 STA 的 COM 对象；js_api 的调用线程来自线程池，apartment 不由我们定。"""
    out: list = [None]

    def run():
        try:
            ctypes.windll.ole32.OleInitialize(None)
            out[0] = call()
        except Exception as exc:
            out[0] = exc

    t = threading.Thread(target=run)
    t.start()
    t.join()
    if isinstance(out[0], Exception):
        raise out[0]
    return out[0]


def pick_folder(start: str = "") -> str:
    """原生目录选择器：直接用 pywebview 自带的 FOLDER 对话框。

    Windows 后端是 WinForms 的 CreateVistaDialog + FOS_PICKFOLDERS，就是资源管理器那套现代对话框：
    地址栏能直接敲绝对路径，底部「文件夹」编辑框可见。自己 CoCreateInstance 建 FileOpenDialog 在这台
    机器上必崩 —— 经典 CLSID 没注册（REGDB_E_CLASSNOTREG），机器上注册的那个 4dde 变体只认 IUnknown，
    现代对话框只有 WinForms 自己的激活上下文拿得到。
    """
    res = _on_sta(lambda: _studio_window.create_file_dialog(FileDialog.FOLDER, directory=start))
    return res[0] if res else ""


def pick_python_file(start: str = "") -> str:
    """选 python.exe：pywebview 原生文件对话框。只在引导页用，那时窗口已在，宿主跑不掉。"""
    res = _on_sta(lambda: _studio_window.create_file_dialog(FileDialog.OPEN, directory=start,
                                                             file_types=PY_FILE_TYPES))
    return res[0] if res else ""


def splash_html() -> str:
    """冷启动时先出窗口显示的启动页：ComfyUI 就绪前不让用户对着空白干等。"""
    return ('<!doctype html><meta charset=utf-8>'
            '<style>html,body{height:100%;margin:0;background:#1e1e1e;color:#d7dae0;'
            'font-family:system-ui;display:grid;place-items:center}'
            'h1{font-size:20px;font-weight:600}p{font-size:13px;color:#8a8f98}</style>'
            '<div><h1>新影工坊 · Neo Studio</h1><p>正在启动 ComfyUI，请稍候…</p></div>')


GUIDE_JS = """
var S = __STATE__;
var el = function (id) { return document.getElementById(id); };
el('root').value = S.root || '';
el('py').value = S.python || '';
function api() { return window.pywebview && window.pywebview.api; }
function mark(id, ok, okText, badText) {
  var n = el(id);
  n.textContent = ok ? okText : badText;
  n.className = 'st ' + (ok ? 'ok' : 'bad');
}
async function refresh() {
  var r = await api().check_setup(el('root').value, el('py').value);
  mark('rst', r.root_ok, '✓ 找到 main.py：' + r.root, '需要选择：这个目录下没有 main.py');
  mark('pst', r.python_ok, '✓ ' + r.python, '需要选择：请指向 python.exe');
  el('go').disabled = !(r.root_ok && r.python_ok);
}
el('broot').onclick = async function () {
  var p = await api().pick_root();
  if (p) { el('root').value = p; await refresh(); }
};
el('bpy').onclick = async function () {
  var p = await api().pick_python();
  if (p) { el('py').value = p; await refresh(); }
};
el('root').onchange = refresh;
el('py').onchange = refresh;
el('go').onclick = async function () {
  el('go').disabled = true;
  el('msg').textContent = '正在拉起 ComfyUI，就绪后自动进入…';
  var r = await api().start_setup(el('root').value, el('py').value);
  if (!r.ok) { el('msg').textContent = r.error || '启动失败'; el('go').disabled = false; }
};
refresh();
"""


def guide_html(state: dict) -> str:
    """首次设置页：补齐 ComfyUI 根目录与 Python 解释器，自动找到的直接预填，缺哪个补哪个。

    页面走 load_html + js_api，不碰壳侧服务 —— 根目录无效时 build_app 连 folder_paths 都 import 不了，
    服务本来就起不来。校验与拉起都在壳里，页面只收路径和显示原因。"""
    return ('<!doctype html><meta charset=utf-8><title>新影工坊 · Neo Studio 首次设置</title>'
            '<style>'
            'html,body{height:100%;margin:0;background:#1e1e1e;color:#d7dae0;font:14px/1.7 system-ui}'
            '.wrap{max-width:820px;margin:0 auto;padding:40px 32px}'
            'h1{font-size:20px;font-weight:600;margin:0}'
            '.sub{font-size:13px;color:#8a8f98;margin:6px 0 26px}'
            '.row{margin-bottom:20px}'
            '.row b{display:block;margin-bottom:6px}'
            '.line{display:flex;gap:8px}'
            'input{flex:1;min-width:0;background:#262626;color:#d7dae0;border:1px solid #3d3d3d;'
            'border-radius:6px;padding:8px 10px;font:13px system-ui}'
            'button{background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:8px 16px;'
            'font:13px system-ui;cursor:pointer}'
            'button:disabled{opacity:.45;cursor:default}'
            '.st{font-size:12px;margin-top:5px}'
            '.ok{color:#7ec699}.bad{color:#e0a94a}'
            '.go{margin-top:6px;text-align:right}'
            '#msg{font-size:13px;color:#8a8f98;margin-top:14px;white-space:pre-wrap}'
            '</style>'
            '<div class=wrap>'
            '<h1>新影工坊 · Neo Studio 首次设置</h1>'
            '<div class=sub>补齐下面两项，启动器会写入配置并拉起 ComfyUI。已自动找到的直接沿用。</div>'
            '<div class=row><b>① ComfyUI 根目录</b><div class=line>'
            '<input id=root spellcheck=false><button id=broot>选择…</button></div>'
            '<div id=rst class=st></div></div>'
            '<div class=row><b>② Python 解释器</b><div class=line>'
            '<input id=py spellcheck=false><button id=bpy>选择…</button></div>'
            '<div id=pst class=st></div></div>'
            '<div class=go><button id=go>开始</button></div>'
            '<div id=msg></div>'
            '</div>'
            '<script>' + GUIDE_JS.replace("__STATE__", json.dumps(state, ensure_ascii=False)) + '</script>')


def singleton():
    """已有壳窗口返回 None：第二个实例直接退出，避免多窗口抢显存。

    用命名互斥体，不占端口 —— 在 127.0.0.1:8189 挂一个监听，netstat 里看着就像第二路 ComfyUI，
    用户会读成「起了 8188 和 8189 两个端口，关窗只掉 8189」。句柄必须活到进程结束，锁才成立。
    已存在的信号只能问 kernel32.GetLastError()：ctypes.get_last_error() 在这条调用上拿不到 183。"""
    h = k32.CreateMutexW(None, False, SINGLETON_MUTEX)
    if k32.GetLastError() == ERROR_ALREADY_EXISTS:
        k32.CloseHandle(h)
        return None
    return h or None


def main() -> int:
    ap = argparse.ArgumentParser(description="Neo Studio 桌面壳")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--python", default="")
    ap.add_argument("--root", default="")
    ap.add_argument("--cdp", type=int, default=0, help="WebView2 远程调试端口（E2E 用）")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    if webview is None:
        alert("缺少 pywebview：用整合包 python 执行 pip install pywebview")
        return 1

    cfg = load_config()
    port = args.port or int(cfg.get("port") or DEFAULT_PORT)
    log_line(f"start port={port} state={STATE}")
    lock = singleton()
    if lock is None:
        log_line("singleton busy")
        alert("Neo Studio 窗口已在运行")
        return 0

    root = resolve_root(args.root)
    python = find_python(root, args.python or cfg.get("python", "")) if root is not None else None
    # 根目录无效或解释器找不到：窗口先开在引导页补齐，选完再起服务、拉起 ComfyUI
    need_guide = root is None or not root_ok(root) or python is None
    plugin_dir = plugin_dir_for(root) if root is not None else PLUGIN_SOURCE_DIR
    # flags 由壳侧服务与 js_api 共用：拉起 ComfyUI 的那一刻起，页面的版本快照就是「启动中」
    # 插件缺失且自动安装失败：壳侧服务退回内置副本，素材库照旧离线可浏览
    serve_dir = plugin_dir if plugin_dir.is_dir() else PLUGIN_SOURCE_DIR
    flags = {"starting": False}
    launcher = {"root": str(root or ""), "python": str(python or ""), "port": port,
                "plugin_dir": str(plugin_dir), "state_dir": str(STATE),
                "portable": IS_FROZEN, "state": ST_OK, "error": ""}
    launcher_api: dict = {}   # 壳侧路由延迟取壳的方法：服务先起，壳的方法随后补上
    if need_guide:
        state, msg = ((ST_BAD_ROOT, "还没确定 ComfyUI 根目录")
                      if root is None or not root_ok(root)
                      else (ST_NO_PYTHON, "还没确定 Python 解释器"))
        launcher.update(state=state, error=msg)
        log_line(f"startup state={state} {msg}")
    # build_app 要把根目录加进 sys.path 才能 import folder_paths：根目录无效时装配必崩。
    # 引导页补完根目录后由 ensure_server 重取，服务才装配得起来。
    boot = {"root": root, "serve_dir": serve_dir}
    server = ShellServer(lambda: build_app(boot["root"], boot["serve_dir"], flags, launcher,
                                           launcher_api, COMFY_LOG, data_root=STATE),
                         port + SHELL_PORT_OFFSET)
    offline_url = ""

    def start_server() -> bool:
        """起壳侧只读服务；起不来（端口被占 / 装配报错）只回 False，原因只能靠这行日志。"""
        nonlocal offline_url
        if server.bound:
            return True
        if not server.start():
            log_line(f"shell service failed: {server.error!r}")
            return False
        log_line(f"shell service port={server.bound}")
        offline_url = f"http://127.0.0.1:{server.bound}/neo-studio"
        return True

    def ensure_server() -> bool:
        """引导页的「开始」：根目录补完了才谈得上起服务，起完把离线页地址交回已开好的窗口。"""
        boot["root"] = Path(launcher["root"])
        plugin_dir = plugin_dir_for(boot["root"])
        # 与正常启动同一套自检：插件没装进用户选的根目录就先装内置副本 —— 壳侧服务要
        # 从那儿 exec_module 挂 gallery 等模块，目录不存在时装配直接抛 FileNotFoundError
        state, msg = startup_state(boot["root"], Path(launcher["python"]), plugin_dir)
        launcher.update(state=state, error=msg)
        if state == ST_BAD_ROOT:
            return False
        boot["serve_dir"] = plugin_dir if plugin_dir.is_dir() else PLUGIN_SOURCE_DIR
        if not start_server():
            return False
        shell.shell_port = server.bound
        shell.offline_url = offline_url
        return True

    shell = StudioShell(f"http://127.0.0.1:{port}/neo-studio", None, port, root or Path(""),
                        str(python or ""), "", port + SHELL_PORT_OFFSET, flags, launcher)
    shell.ensure_server = ensure_server
    launcher_api.update(apply=shell.apply_launcher, install_plugin=shell.install_plugin,
                        install_deps=shell.install_deps, pick_root=shell.pick_root,
                        state=shell.launcher_state)
    geo = load_geometry()
    kw = dict(width=geo.get("width", 1440), height=geo.get("height", 900),
             x=geo.get("x"), y=geo.get("y"), min_size=(900, 600), js_api=shell)
    # 窗口先出：起解释器查依赖、装配壳侧服务、拉起 ComfyUI 全在后台线程走完。
    # 引导页等用户补齐根目录与解释器，其余停在启动页，就绪后由后台线程整页跳过去。
    if need_guide:
        window = webview.create_window("新影工坊 · Neo Studio", html=guide_html(launcher), **kw)
    else:
        window = webview.create_window("新影工坊 · Neo Studio", html=splash_html(), **kw)
    shell.loader = window.load_url
    global _studio_window
    _studio_window = window


    def arm_pill() -> None:
        def on_loaded() -> None:
            # 每次整页加载记一行：窗口停在离线页还是完整 Studio，事后看日志就知道
            log_line(f"page loaded {window.get_current_url()}")
            # 主画布是整页刷新，返回入口只能由壳在每次页面加载后重新挂上
            window.evaluate_js(BACK_JS)
        window.events.loaded += on_loaded

    shell.rearm = arm_pill
    arm_pill()
    # 关窗：存几何 → 挂「正在停止 ComfyUI」→ 带走壳自己拉起的 ComfyUI → 收壳侧服务 → 销毁窗口。
    # 几何必须在 UI 线程上先读（窗口销毁后读属性会抛，收尾链断在半路、进程变孤儿）。
    # 收尾不在 UI 线程做：FormClosing 里睡多久窗口就冻多久（壳侧服务正忙时 join 能吃满 5 秒），
    # 用户读成卡死。evaluate_js 也是等 UI 线程回消息循环才执行的，在 closing 里调直接死锁 ——
    # 所以第一次 closing 只放行关闭，提示与收尾在后台线程走完，最后 destroy 触发第二次 closing 放行。
    closing = {"vetoed": False, "thread": None}

    def close_out() -> None:
        try:
            if shell.comfy is not None:
                window.evaluate_js(CLOSING_JS)   # 窗口停在提示上，直到收尾走完
            shell.comfy_close()
            server.stop()
        finally:
            window.destroy()   # 收尾出异常也不能把窗口留成关不掉

    def on_closing() -> None:
        if closing["vetoed"]:
            return   # 后台收尾走完后的第二次 FormClosing：放行
        closing["vetoed"] = True
        shell.closing = True
        save_geometry(window)
        closing["thread"] = threading.Thread(target=close_out, daemon=True)
        closing["thread"].start()
        return False

    window.events.closing += on_closing
    window.events.closed += lambda: shell.comfy_close()


    def spawn_ready():
        if wait_ready(shell.port, READY_TIMEOUT):
            shell.starting = False   # 跳页前收掉「启动中」，新页面直接是完整 Studio
            log_line(f"comfy ready jump {shell.url}")
            shell._goto(shell.url)
        else:
            shell.starting = False
            log_line("comfy not ready")
            alert(f"ComfyUI {READY_TIMEOUT} 秒内未就绪，启动输出见 {COMFY_LOG}")
            shell.comfy_close()
            window.destroy()

    def boot_sequence() -> None:
        """窗口先出之后在后台走完的启动序列：自检 → 壳侧服务 → 拉起 ComfyUI → 把窗口指过去。"""
        state, msg = startup_state(root, python, plugin_dir)
        launcher.update(state=state, error=msg)
        log_line(f"startup state={state} {msg}")
        start_server()
        shell.shell_port = server.bound
        shell.offline_url = offline_url
        # 存在性只问端口：端口上有人监听就是有一路 ComfyUI 在跑。不能拿 /neo_studio/version 这种
        # Neo 专属路由当存在性判据 —— 那路插件没加载或还在导入自定义节点时探测会失败，壳就在旁边
        # 8189 拉第二路，关窗只带走自己那路，用户看到「两个端口，杀掉一个还剩一个」
        if state == ST_OK and not port_busy(port) and not shell.closing:
            shell.port = free_comfy_port(port, shell.shell_port)
            shell.comfy = start_comfy(python, root, shell.port)
            shell.pid = shell.comfy.pid
            shell.url = f"http://127.0.0.1:{shell.port}/neo-studio"
            shell.starting = True
            log_line(f"comfy spawn pid={shell.pid} port={shell.port}")
            if shell.closing:
                # 关窗正好压在拉起这一刻：收尾线程已经收过一轮，刚起的那路立刻收掉，不留孤儿
                shell.comfy_close()
                return
        # 已就绪直接进 ComfyUI 的完整 Studio；冷启动进壳的离线素材页，就绪后整页跳过去
        ready = shell.comfy is None and probe(shell.port)
        shell._goto(shell.url if ready else offline_url)
        if shell.comfy is not None:
            spawn_ready()
        elif not ready:
            # 附着的那路还在导入自定义节点：就绪后跳过去，别停在离线页干等
            shell._jump_when_ready()

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
    log_line(f"webview start geo={geo} page={'guide' if need_guide else 'splash'}")
    purge_web_cache()   # 历史缓存里的旧插件 JS 会把模块图撕开，开窗口前清掉
    on_start = None if need_guide else (lambda: threading.Thread(target=boot_sequence,
                                                                 daemon=True).start())
    webview.start(on_start, private_mode=False, storage_path=str(PROFILE_DIR), gui="edgechromium",
                  debug=args.debug, icon=icon)
    log_line("webview end")
    if closing["thread"] is not None:
        closing["thread"].join(10)   # 收尾线程还在跑就退进程 = 留孤儿
    shell.comfy_close()   # 窗口循环结束就是要退进程：壳拉起的 ComfyUI 必须跟着走，别留孤儿
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log_line("EXC " + repr(e))
        alert(str(e))
        sys.exit(1)
