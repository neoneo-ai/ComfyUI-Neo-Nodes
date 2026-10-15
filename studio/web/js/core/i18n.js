/**
 * i18n.js —— 界面语言：中文原文作 key 的英文字典，字典缺项回落中文。
 *
 * 中文是源码里的原文，不是 key 的别名：漏译只会退回中文，不会像 id-key 方案那样
 * 在界面上露出 "menu.settings" 这种占位符。
 * 语言存在 localStorage（neo_studio_lang），没存过时按浏览器语言判定。
 * 切换语言走整页刷新——模块级常量与已渲染的 DOM 都要重建，热替换只会留下半中半英的界面。
 */

const LANG_KEY = "neo_studio_lang";

export const LANGS = [
    { value: "zh", label: "中文" },
    { value: "en", label: "English" },
];

const EN = {
    // 顶栏 🅝 菜单
    "🎬 新影工坊": "🎬 Neo Studio",
    "🖼️ 生成素材": "🖼️ Generate Assets",
    "🎥 新建导演配方": "🎥 New Director Recipe",
    "🧩 创建节点": "🧩 Add Node",
    "🔧 修复工作流": "🔧 Repair Workflow",
    "💾 回写入技能": "💾 Write Back to Skill",
    "📜 修复记录": "📜 Repair Log",
    "📜 变更记录": "📜 Change Log",
    "⚙️ 设置": "⚙️ Settings",
    "📥 模型库": "📥 Model Hub",
    "🗂 技能管理": "🗂 Skill Manager",
    "ℹ️ 关于插件": "ℹ️ About Plugin",
    // 创建节点子菜单（英文里括号注释是多余的）
    "⚡ Neo Prompt Agent（提示词智能体）": "⚡ Neo Prompt Agent",
    "📝 Neo Prompt Encoder（提示词编码器）": "📝 Neo Prompt Encoder",
    "🎨 Neo Image Gen & Edit（图像生成与编辑）": "🎨 Neo Image Gen & Edit",
    "🎞️ Neo H3 Video Director（视频导演）": "🎞️ Neo H3 Video Director",
    "📦 Neo Bundle Expand（Bundle 展开）": "📦 Neo Bundle Expand",
    "🔲 Neo Reference Grid（参考图宫格）": "🔲 Neo Reference Grid",
    "🧩 Neo Grid Split（宫格图拆分）": "🧩 Neo Grid Split",
    // 创建节点提示
    "无法创建节点": "Cannot create node",
    "LiteGraph 未就绪": "LiteGraph is not ready",
    "画布为空": "Canvas is empty",
    "请先打开一个工作流": "Open a workflow first",
    // 技能回写菜单提示
    "当前画布没有待回写的技能：技能管理「⤒ 导入到画布」后此入口可用":
        "No skill is pending write-back on this canvas. Use “⤒ Import to Canvas” in Skill Manager to enable this entry.",
    "技能 \"{id}\" 是预设：模型值写本地覆盖，结构变更自动复制为自定义技能":
        "Skill \"{id}\" is a preset: model values go to a local override; structural changes are copied into a custom skill.",
    "把当前画布落盘技能 \"{id}\"（先列出变更、确认后写入）":
        "Write this canvas back to skill \"{id}\" (changes are listed first, then confirmed).",
    // 关于弹窗
    "版本信息加载中…": "Loading version info…",
    "源码：": "Source: ",
    "安装方式：\n· ComfyUI Manager 搜索 \"Neo Studio\" 一键安装\n· 或 git clone 到 ComfyUI/custom_nodes/ 后重启":
        "Install:\n· Search \"Neo Studio\" in ComfyUI Manager for one-click install\n· Or git clone into ComfyUI/custom_nodes/ and restart",
    "关闭": "Close",
    "插件 v{plugin} · ComfyUI v{comfy}": "Plugin v{plugin} · ComfyUI v{comfy}",
    "版本信息不可用": "Version info unavailable",
    // 统一设置弹窗
    "🖼️ 生图默认设置": "🖼️ Image Gen Defaults",
    "🎬 生视频模型": "🎬 Video Models",
    "🌐 界面语言": "🌐 Language",
    "💾 保存并关闭": "💾 Save & Close",
    "放弃修改": "Discard changes",
    "继续编辑": "Keep editing",
    "⚠ 有未保存的修改": "⚠ Unsaved changes",
    "关闭（Esc）": "Close (Esc)",
    // 界面语言表单
    "保存后整页刷新，界面文案按新语言重建。": "Saving reloads the page and rebuilds the interface in the new language.",
    "选择后立即落盘并整页刷新，界面文案按新语言重建。": "Picking a language saves it and reloads the page, rebuilding the interface in the new language.",
    // ===== 桌面端 Studio（web/studio）：顶栏与窗口控件 =====
    "新影工坊 · Neo Studio": "Neo Studio",
    "返回首页": "Back to home",
    "素材": "Assets",
    "导演": "Director",
    "技能": "Skills",
    "设置": "Settings",
    "最小化": "Minimize",
    "最大化": "Maximize",
    "全屏": "Fullscreen",
    "还原": "Restore",
    "退出全屏": "Exit fullscreen",
    // 桌面端：导演页整片生成
    "排队中…（{recipe}）": "Queued… ({recipe})",
    "生成中… {value}/{max}": "Generating… {value}/{max}",
    "生成中…": "Generating…",
    "已完成：{filename}": "Done: {filename}",
    "🎬 {filename}（在浏览器中打开）": "🎬 {filename} (open in browser)",
    "失败：{error}": "Failed: {error}",
    "未知错误": "Unknown error",
    "已取消": "Cancelled",
    "默认": "Default",
    "Neo Gallery 未加载": "Neo Gallery is not loaded",
    "Neo Gallery 加载失败": "Neo Gallery failed to load",
    "留空 = 用配方里的种子": "Empty = use the recipe's seed",
    "留空 = 用技能默认步数": "Empty = use the skill's default steps",
    "（手输 W/H）": "(manual W/H)",
    "宽": "W",
    "高": "H",
    "🎬 生成整片": "🎬 Generate Film",
    "⏹ 取消": "⏹ Cancel",
    "仅运行勾选的 {n} 段：[{list}]": "Running only the {n} checked segments: [{list}]",
    "未勾选 = 生成整片": "Nothing checked = generate the whole film",
    "在时间轴段块左上角勾选，可只跑其中几段": "Check the top-left corner of a timeline block to run only some of its segments.",
    "请先选择配方": "Select a recipe first",
    "未找到分段配方：{name}": "Segment recipe not found: {name}",
    "打开配方编辑器失败：{msg}": "Failed to open the recipe editor: {msg}",
    "请先在下方选择一个配方": "Select a recipe below first",
    "提交中…": "Submitting…",
    "提交失败：{msg}": "Submit failed: {msg}",
    "取消失败：{msg}": "Cancel failed: {msg}",
    "⋯ 高级": "⋯ Advanced",
    "种子 / 连续性 / 上下文帧（高级）": "Seed / continuity / context frames (advanced)",
    "宽高比": "Aspect ratio",
    "百万像素": "Megapixels",
    "分辨率": "Resolution",
    "步数": "Steps",
    "种子": "Seed",
    "连续性": "Continuity",
    "上下文帧": "Context frames",
    "生成后在此显示实时预览": "The live preview appears here after generation",
    // 桌面端：设置页 tab 与区块标题
    "LLM 设置": "LLM Settings",
    "生图设置": "Image Gen Settings",
    "生视频设置": "Video Gen Settings",
    "日志": "Log",
    "启动设置": "Launcher Settings",
    "关于": "About",
    "界面语言": "Language",
    // 桌面端：启动设置
    "ComfyUI 根目录": "ComfyUI root folder",
    "python.exe 路径": "python.exe path",
    "浏览…": "Browse…",
    "保存并重启 ComfyUI": "Save & restart ComfyUI",
    "安装依赖": "Install dependencies",
    "重试安装插件": "Retry plugin install",
    "▶ 启动内核": "▶ Start kernel",
    "■ 停止内核": "■ Stop kernel",
    "🚀 启动中…": "🚀 Starting…",
    "🚀 重连远端": "🚀 Reconnect remote",
    "端口": "Port",
    "局域网监听": "LAN listening",
    "远程 ComfyUI": "Remote ComfyUI",
    "无边框窗口": "Frameless window",
    "开发模式": "Dev mode",
    "就绪": "Ready",
    "根目录无效": "Invalid root folder",
    "找不到 Python": "Python not found",
    "缺少插件依赖": "Plugin dependencies missing",
    "插件安装失败": "Plugin install failed",
    "仅本机（默认）": "Localhost only (default)",
    "全部网卡（0.0.0.0）": "All network interfaces (0.0.0.0)",
    "本机网卡 {ip}": "Local interface {ip}",
    "已保存：{key}": "Saved: {key}",
    "远程 ComfyUI：{remote}/neo-studio · 远端要已开监听并装好 Neo Studio 插件，起停与端口都在远端那台机器上设":
        "Remote ComfyUI: {remote}/neo-studio — the remote machine must already be listening and have the Neo Studio plugin installed; start, stop, and port are set over there.",
    "仅本机访问：http://127.0.0.1:{port}/neo-studio": "Localhost only: http://127.0.0.1:{port}/neo-studio",
    "局域网可访问（ComfyUI 没有鉴权，只在你信任的网段开）：":
        "Reachable on the LAN (ComfyUI has no auth — open it only on networks you trust): ",
    "http://<本机 IP>:{port}/neo-studio": "http://<local IP>:{port}/neo-studio",
    "插件 {plugin} · 状态 {state} · {mode}": "Plugin {plugin} · State {state} · {mode}",
    "便携模式": "portable mode",
    "插件内运行": "in-plugin mode",
    "操作失败": "Operation failed",
    "已保存，ComfyUI 重启中…": "Saved. ComfyUI is restarting…",
    "启动设置保存失败：{msg}": "Failed to save launcher settings: {msg}",
    // 启动设置的 ⓘ 提示
    "ComfyUI 安装目录，要有 main.py。\n改完点「保存并重启 ComfyUI」：桌面端停掉旧进程，按新配置重新拉起。":
        "The ComfyUI install folder; it must contain main.py.\nAfter editing, click “Save & restart ComfyUI”: the desktop app stops the old process and relaunches it with the new settings.",
    "跑 ComfyUI 的 python.exe，要已装好 ComfyUI 的依赖（缺依赖时下方出「安装依赖」按钮）。\n改完点「保存并重启 ComfyUI」。":
        "The python.exe that runs ComfyUI; it must already have ComfyUI's dependencies installed (when they are missing, an “Install dependencies” button appears below).\nAfter editing, click “Save & restart ComfyUI”.",
    "本机 ComfyUI 的端口，窗口与探活都打在 127.0.0.1:该端口。\n端口被占用时桌面端自动换到下一个空闲端口。改完点「保存并重启 ComfyUI」。":
        "The local ComfyUI port. The window and the health probe both target 127.0.0.1:that port.\nWhen the port is taken, the desktop app moves to the next free one. After editing, click “Save & restart ComfyUI”.",
    "ComfyUI 的 --listen，默认「仅本机」= 只监听 127.0.0.1，局域网访问不到。\n填网卡地址时会自动带上 127.0.0.1，否则窗口自己打不开。\nComfyUI 没有鉴权：防火墙放行该端口，只在你信任的网段开。改完点「保存并重启 ComfyUI」。":
        "ComfyUI's --listen. The default “Localhost only” listens on 127.0.0.1 alone, so the LAN cannot reach it.\nA network interface address is saved together with 127.0.0.1, otherwise the window cannot open its own page.\nComfyUI has no auth: open this port in the firewall and use it only on networks you trust. After editing, click “Save & restart ComfyUI”.",
    "连远端那台 ComfyUI：http(s)://主机[:端口]，留空 = 连本机。\n前提：远端已装 comfyui-neo-studio 插件，并在远端自己的「启动设置 → 局域网监听」放开监听。\n远程模式本机不启动也不停止 ComfyUI：「启动内核」= 重连远端，「停止内核」禁用，根目录 / 解释器 / 端口 / 局域网监听归远端管。\n改完点「保存并重启 ComfyUI」，窗口直接开在远端页面。":
        "Connect to a remote ComfyUI: http(s)://host[:port]; leave it empty to connect locally.\nRequirements: the remote machine has the comfyui-neo-studio plugin installed and has opened listening in its own “Launcher Settings → LAN listening”.\nIn remote mode this machine neither starts nor stops ComfyUI: “Start kernel” reconnects to the remote, “Stop kernel” is disabled, and the root folder / interpreter / port / LAN listening belong to the remote machine.\nAfter editing, click “Save & restart ComfyUI” — the window opens on the remote page.",
    "桌面端窗口自绘标题栏（最小化 / 最大化 / 全屏 / 关闭），勾掉回系统标题栏。\n立刻生效并写进启动配置，下次开机沿用。":
        "The desktop window draws its own title bar (minimize / maximize / fullscreen / close); uncheck to go back to the system title bar.\nApplies at once and is written to the launcher config, so the next launch keeps it.",
    "打开刷新键 / 右键菜单 / 开发者工具，排查窗口白屏与前端问题用。\npywebview 在建窗口时定值：勾完要重启桌面端窗口才生效。":
        "Enables the reload key, the context menu, and devtools — for debugging a blank window and frontend issues.\npywebview fixes this when the window is created: restart the desktop window after checking it.",
    // 桌面端：顶栏状态位、离线横幅、生成按钮门控、显存条
    "启动中": "Starting",
    "启动中…": "Starting…",
    "运行中": "Running",
    "已停止": "Stopped",
    " · 远程 {remote}": " · remote {remote}",
    " · 端口 {port} · {by}": " · port {port} · {by}",
    "桌面端启动": "started by the desktop app",
    "外部启动": "started externally",
    "远程 ComfyUI 运行中 · {remote} · 起停由远端机器管":
        "Remote ComfyUI running · {remote} · start and stop are managed by the remote machine",
    "远程 ComfyUI 不可达 · {remote}": "Remote ComfyUI unreachable · {remote}",
    "ComfyUI 运行中 · 端口 {port} · {by} · PID {pid}": "ComfyUI running · port {port} · {by} · PID {pid}",
    "ComfyUI 已停止 · 在「设置 → 启动设置」点「启动内核」":
        "ComfyUI stopped · click “Start kernel” in Settings → Launcher Settings",
    "请在 Neo Studio 窗口里启动 ComfyUI": "Start ComfyUI from the Neo Studio window",
    "重连远端 ComfyUI…": "Reconnecting to the remote ComfyUI…",
    "ComfyUI 启动中…就绪后自动回到完整 Studio":
        "ComfyUI is starting… the full Studio page returns once it is ready",
    "该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」":
        "This feature needs ComfyUI · click “Start kernel” in Settings → Launcher Settings",
    "生成素材": "Generate Assets",
    "生成这一段": "Generate this segment",
    "拼回成片": "Merge into film",
    "生成图片分镜": "Generate storyboard images",
    "{label} 需要 ComfyUI 执行队列 · 点一下启动": "{label} needs the ComfyUI queue · click to start it",
    "ComfyUI 启动中": "ComfyUI starting",
    "需要 ComfyUI": "ComfyUI required",
    "🚀 启动 ComfyUI": "🚀 Start ComfyUI",
    "远程 ComfyUI 不可达 · {remote} —— 这里浏览的是本机素材目录，生成与队列要连上远端":
        "Remote ComfyUI unreachable · {remote} — this is the local asset folder; generation and the queue need the remote machine",
    "ComfyUI 未运行 · 素材 / 技能 / 配方 / 设置 / 模型库可离线编辑，生成与队列需要 ComfyUI":
        "ComfyUI is not running · assets / skills / recipes / settings / model hub work offline; generation and the queue need ComfyUI",
    "离线模式": "offline mode",
    "显存": "VRAM",
    "内存": "RAM",
    "GPU 显存占用（含全部进程）": "GPU VRAM in use (all processes)",
    "系统内存占用": "System RAM in use",
    "卸载空闲模型并释放显存缓存 · 生成后显存迟迟不降时用":
        "Unloads idle models and frees the VRAM cache · use it when VRAM stays high after a generation",
    "🧹 清理": "🧹 Clear",
    "清理中…": "Clearing…",
    "释放 {n} ✓": "Freed {n} ✓",
    "清理失败": "Clear failed",
};

function detectLang() {
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}

let lang = (() => {
    try {
        return localStorage.getItem(LANG_KEY) || detectLang();
    } catch {
        return detectLang();
    }
})();

export function getLang() {
    return lang;
}

export function setLang(value) {
    lang = value;
    try {
        localStorage.setItem(LANG_KEY, value);
    } catch {
        // 隐私模式下 localStorage 会抛，本次会话内生效即可
    }
}

/** 中文原文 → 当前语言文案；英文字典缺项回落中文。 */
export function t(zh) {
    return lang === "en" ? (EN[zh] ?? zh) : zh;
}

/** 带插值：tf('技能 "{id}" 是预设…', { id })。 */
export function tf(zh, vars) {
    let s = t(zh);
    for (const [key, value] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, String(value));
    return s;
}

/** 落盘语言并整页刷新：菜单、弹窗、节点面板的文案都按新语言重建。 */
export function applyLang(value) {
    setLang(value);
    location.reload();
}
