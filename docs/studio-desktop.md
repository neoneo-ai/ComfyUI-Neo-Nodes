# 桌面端（Studio Desktop）

桌面端把 Studio 页面装进本地窗口：自己拉起 ComfyUI，并在 ComfyUI 端口 +3 起一个只读素材服务，ComfyUI 不在跑时页面
照样能浏览素材、编辑配方与技能。源码运行与打包 exe 走同一条 `app/studio_app.py`。

## 组成

| 文件 | 职责 |
|------|------|
| `app/studio_app.py` | 窗口、自检、拉起 / 停止 ComfyUI、无边框窗口、关窗收尾、启动设置 |
| `app/studio_server.py` | 桌面端 aiohttp 服务（ComfyUI 端口 +3，`DESKTOP_PORT_OFFSET`），按目录加载插件模块挂在各自 `RouteTableDef` 上的 handler |
| `app/studio_caps.py` | 能力表：哪些路由归桌面端服务，表外一律 `409 offline` |
| `data/` | 状态目录：`studio_window.json`（几何）、`studio_profile`（WebView2 profile / localStorage）、`launcher_config.json`（root / python / port / frameless / dev_mode / listen / remote）、`studio_desktop.log`、`comfy_run.log` |

源码运行的状态目录是仓库根的 `data/`；exe 优先 exe 旁的 `data/`，落在不可写目录时退回 `%APPDATA%\Neo Studio`。

## 离线门控

判定标准是「只做文件读写 / 本地检索 / 远程下载 / 打 8080 LLM 服务」；需要执行队列、显存、节点定义的归 ComfyUI。
功能开关表随 `/neo_studio/version` 下发，Studio 只门控运行类按钮（生成 / 跑段 / 拼接），配方编辑、技能编辑、
设置、LLM 配置都不需要 ComfyUI 运行时。路由清单见 [api-routes.md](api-routes.md)。

主画布（ComfyUI 页面）是 SPA，进程停了页面还活着、画布照常能拖能改，改完的东西落不进任何执行。
`studio/web/canvas-lock.js` 读前端自己的连接事件当判据：`status` 空 / `reconnecting` = 后端没了，
`reconnected` / `status` 带数据 = 回来了；锁之前先打一次 `/system_stats` 确认，WS 抖动不误锁。确认掉线就走
前端自带的画布锁（`LGraphCanvas.read_only`，与 `Comfy.Canvas.Lock` 同一份）：平移照常，节点拖动 / 缩放 /
widget 编辑 / 右键加节点全停，底部出「🔒 ComfyUI 未运行 · 画布只读」。离线期间每 3 秒复探一次，
恢复后解锁并还原用户自己的锁定状态。

离线页跑在桌面端的只读服务上，技能详情的「⤒ 主画布编辑」开的是当前源的根路径 —— 桌面端根路径没有画布页，
ComfyUI 没就绪时点它只会得到「页面不存在」。`openSkillWorkflowInMainUi()` 照顶栏那份运行状态拦一下：启动中
报「ComfyUI 启动中…就绪后再编辑主画布」，未运行报「该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」」。

## 导演页布局

导演页 = 左栏 **360px 配方列表**（只列多段导演配方）+ 右主栏上下两块：**上 = 导演编辑器**、
**下 = 整片生成面板**，中间一条**分隔条**。左栏在开素材库时整栏切成素材库（加宽到 380px）。

- 导演编辑器在 Studio 里是内嵌的（`setDirectorEditorHost` 注册宿主）：铺满右上栏，不建浮层窗口，
  标题栏拖动 / ⛶ 放大 / 右下角缩放都不出现。主画布（ComfyUI 页面）没注册宿主，编辑器仍是浮层弹窗。
- 没有编辑器时右上出占位提示；**点左栏配方卡 = 选中配方 + 内嵌打开该配方**（重复点同一张卡只切段、
  不重载，未保存的改动不丢；构建中的点击直接忽略，连点不会叠出两个编辑器），点只读时间轴的分段块进入
  并定位到该段，素材页的「🎬 新建导演配方」会切到导演页并内嵌打开。
- 导演编辑器里的 **素材库** 按钮把**左栏从配方列表切成素材库**（`.ns-director-lib`，整栏加宽到 380px）：Studio 没有
  ComfyUI 左侧栏，`media-transfer` 写 `sidebarTab.activeSidebarTabId` 由 shim 转交给左栏落地。素材库就是素材页那套
  Neo Gallery（同一个元素在素材页宿主与左栏宿主之间搬移，宽版样式），面包屑与目录导航照用，素材卡直接拖进右侧
  编辑器的首帧 / 参考位。左栏加宽由 grid 列宽驱动，右侧编辑器随之让位，**不遮挡编辑区**。再点同一按钮切回配方列表，
  素材库标题栏的 ✕ 也切回，切走导演页自动收起。
- 分隔条：拖动调生成面板高度（编辑器下限 240px、面板下限 170px），双击收起 / 展开生成面板，
  键盘 `↑`/`↓` 调高、`Enter` 收起。高度与收起状态存 `localStorage["neo_studio_director_split"]`。
  面板拖高拖矮，右侧结果区（实时预览 / 成片）跟着伸缩，不再在固定 640×360 的预览框下面留一片空白。
- 左栏分隔条：左栏与编辑器之间一条竖线，兼作拖动热区 —— 拖动调左栏宽度（配方列表下限 200px、素材库下限
  320px、右侧编辑器下限 420px），拖到比 160px 更窄整栏收起（宽度归零、内容不显示，右栏吃满整幅）；
  键盘 `←`/`→` 微调，收起态按 `→` 展开，双击收起 / 展开。配方列表与素材库各记各的宽度与收起状态，存
  `localStorage["neo_studio_director_side_col"]` —— 收起只写 `*_closed`，收起前的宽度留着，展开落回那一档。
  900px 以下上下堆叠时不出分隔条，收起状态在那里不生效（没有热区可拖）。两条分隔条一个样式：18px 宽热区里
  一条 1px 细线，悬停 / 键盘聚焦 / 拖动时加粗到 4px 并变蓝；正中三枚点的抓手（照 VSCode 的 sash）在悬停与
  左栏收起时常驻 —— 收起的栏就靠它拖回来。
- 编辑器底部 **🎬 保存并生成整片** 与生成面板的 **🎬 生成整片** 共用同一份参数组装：保存成功后
  直接按面板当前的分辨率 / 步数 / 勾选段提交整片生成。
- 窄窗口先收窄左栏（1180px 以下 340px），900px 以下上下堆叠。默认宽度按配方区标题行
  「配方 ↻ 📦 导入 🎬 新增导演配方」单行放得下为准（英文界面需 340px）。

## 绘画页布局

绘画页 = 左栏 **图片配方列表**（只列 `gen_type = "image"` 的配方）+ 右主栏 **文生图 / 图片编辑** 两块面板，
顶部一条模式切换条，一次只铺满右栏一块 —— 不像导演页那样编辑器与生成面板同屏抢高度。左栏素材库抽屉、
左栏分隔条、滚动条与窄窗口规则全部与导演页共用同一套样式。

- 绘画面板在 Studio 里是内嵌的（`setPaintHost` 注册宿主）：铺满右栏，不建浮层窗口，标题栏拖动与 ✕ 都不出现。
  主画布（ComfyUI 页面）没注册宿主，「🖼️ 生成素材」与「🖼️ 图片编辑」在那里仍是浮层弹窗。
- 素材页顶栏的「🖼️ 生成素材」与图片卡菜单的「🖼️ 图片编辑」在 Studio 里一律切到绘画页并铺进对应面板；
  点左栏图片配方卡 = 切到文生图并把该配方的提示词填进输出框，「🖼️ 新增图片配方」开一张空白文生图面板。
- 模式选择存 `localStorage["neo_studio_paint_mode"]`；左栏宽度是绘画页自己那份，存
  `localStorage["neo_studio_paint_side_col"]`，与导演页的宽度互不抹除，收起状态同样各记各的。
- 素材库抽屉按页归属（`libDrawers[view]`，导演页 / 绘画页各一份）：`media-transfer` 写入只落到当前页的抽屉，
  切走本页自动收起。离开素材页时把 `sidebarTab.activeSidebarTabId` 归位 —— 素材页挂载画廊会把它写成
  `neo.gallery`，不归位的话本页「素材库」按钮再写同一个 id 会被去重吃掉，抽屉打不开。
- 显存 / 内存读数条导演页与绘画页各一条，轮询只在生成页（导演 / 绘画）开着。

## 启动序列

- 窗口先出：开窗只做解包与建窗口（启动页 / 引导页），自检、桌面端服务、拉起 ComfyUI 都在后台线程跑完。
- 桌面端拉起 ComfyUI 期间的 `starting` 是 `StudioDesktop` 与桌面端服务共用的一份 dict，`comfy_state` 与
  `/neo_studio/version` 同时下发。pywebview 的 js_api 注入晚于页面加载，且 `window.pywebview` 先出现、方法由
  `finish.js` 后填：桌面端 api 一律等到要用的方法出现才接管，前端只靠版本快照就知道在启动中。这段时间只出
  「ComfyUI 启动中…」，收起未运行横幅与启动入口。
- 启动桌面端时「有没有 ComfyUI」只看端口有没有人监听：`/neo_studio/version` 探不到（那路插件没加载、还在导入自定义
  节点）也只附着，不在旁边端口拉第二路，启动设置的「启动内核」按钮同样只附着。

## 引导页（首次设置）

根目录推不出、或同级与内部都找不到 `python.exe` 时，窗口开在引导页（`guide_html`，`load_html` + js_api）：那时
`build_app` 连 `folder_paths` 都 import 不了，桌面端服务本来就起不来，页面只能不依赖 HTTP 服务。校验与拉起全走
js_api（`check_setup` / `pick_root` / `pick_python` / `start_setup`），根目录补完了服务才起得来。

## 无边框窗口与拖动

- 无边框是启动设置里的一项，存 `launcher_config.json` 的 `frameless`（缺省开，勾掉回系统标题栏）：建窗时喂
  pywebview，运行中改样式位（只摘 `WS_CAPTION`，`WS_THICKFRAME` 恒置 —— pywebview 的 frameless 走
  `FormBorderStyle=None`，拖边缩放会一起被摘掉，窗口 Shown 之后由 `ensure_resizable_frame` 补回；原生窗口在
  `start()` 里才建出来，建窗时拿不到 hwnd）。
- `easy_drag` 必须关掉 —— pywebview 的简易拖动是全局 mousedown，无边框时点任何卡片都会拖着窗口跑。拖动由顶栏
  空白处按下调 `win_start_drag`，桌面端在窗口线程上自己循环跟光标（`SetWindowPos` + `GetAsyncKeyState(VK_LBUTTON)`），
  左键一松就停 —— 交回系统走 `WM_NCLBUTTONDOWN + HTCAPTION` 或 `WM_SYSCOMMAND·SC_MOUSEMOVE` 都起不来，WinForms
  的 Form 把非客户区按下吞掉了。
- 按下没走出系统拖动阈值（`SM_CXDRAG`）不算拖动：窗口一动不动，最大化 / 全屏也留到走出阈值那一刻才退 ——
  最大化下 `SetWindowPos` 会把窗口打回还原态，单击顶栏就跟着还原不是原生标题栏的语义。双击顶栏空白调
  `win_maximize` 来回切最大化 / 还原，全屏时先退回窗口态。
- 最小化 / 最大化 / 全屏 / 关闭走 `window_state` + `win_*` 一组 js_api 方法，控件出不出由 `frameless` 决定。
  最大化与全屏状态由桌面端自己记（pywebview 的 `Window.maximized` / `.fullscreen` 是建窗初值）：无边框下最大化铺
  工作区（系统 maximize 给整屏矩形，任务栏会被盖住）；全屏退出时 pywebview 把 `FormBorderStyle` 写回建窗时的值、
  标题栏跟着回来，样式按桌面端的状态重贴；全屏时关窗不存几何（存的是整屏矩形，下次开机窗口铺满屏幕）。

## 开发模式

- 开发模式是启动设置里的一项，存 `launcher_config.json` 的 `dev_mode`（缺省关）：勾上下次开机走
  `webview.start(debug=True)`，设置页的开关是 `set_dev_mode`。DevTools 不自动弹（`OPEN_DEVTOOLS_IN_DEBUG`
  关掉，pywebview 在 debug 时会 `OpenDevToolsWindow`），按 F12 或右键「检查」手动开。
- pywebview 在 CoreWebView2 建环境时把 `AreBrowserAcceleratorKeysEnabled`、`AreDefaultContextMenusEnabled`、
  `AreDevToolsEnabled` 全等于 debug：不带开发模式时，F5 / Ctrl+F5 / Ctrl+R 与 WebView2 右键菜单在窗口里都不出。
  这三项建环境时定值，运行中的窗口改不了，勾完要重启窗口。
- 刷新入口不依赖开发模式：Studio 页自己接管 F5 / Ctrl+F5 / Ctrl+R（`studio/web/studio/studio-app.js` 的
  `initReloadHotkey`），前端热同步（`tools/watch_web.py`）之后按一次就是新代码。

## 启动设置的 ⓘ 说明

- 「启动设置」每一行标签旁有一个 ⓘ，悬停（键盘 Tab 聚焦同样出）给出这一行的前提条件与生效方式：根目录 /
  解释器 / 端口 / 局域网监听 / 远程 ComfyUI 走「保存并重启 ComfyUI」，无边框窗口立刻生效并写进配置，
  开发模式要重启桌面端窗口。文案在 `studio/web/studio/studio-app.js` 的 `TIPS` 里。

## 界面语言

- 设置页有「界面语言」一栏（`中文` / `English` 单选）：选完立刻落盘并整页刷新，没有「保存」这一步。
- 语言存 `localStorage["neo_studio_lang"]`，默认跟随系统浏览器语言。桌面端窗口与浏览器标签页是不同 origin，
  两边各存各的语言选择。
- 翻译覆盖桌面端自有文案：顶栏与窗口控件、导演页生成面板、启动设置（含 ⓘ 提示）、顶栏状态位、离线横幅、
  显存条。素材 / 技能视图与 LLM / 生图 / 生视频表单是共享模块，保持中文原文。
- 词条在 `studio/web/js/core/i18n.js`：中文原文作 key，英文缺项回落中文，漏译只会退回中文，不会露出占位符。

## 局域网访问

- 「启动设置 → 局域网监听」是下拉框，选项由桌面端给的本机网卡列表拼出来（仅本机 / 全部网卡 `0.0.0.0` / 各块网卡
  IP），存 `launcher_config.json` 的 `listen`（默认「仅本机」= 不传 `--listen`，ComfyUI 只监听 127.0.0.1）。
  选完点「保存并重启 ComfyUI」生效，提示行实时给出局域网地址；手改配置写进非 IP 的值时桌面端报错，不会喂给 `--listen`。
- 只监听某块网卡时桌面端把 `127.0.0.1` 一起带上（`comfy_listen`）：窗口跳的是 `http://127.0.0.1:端口/neo-studio`，
  端口探测 `port_busy` 也认回环 —— 回环上没人听的话窗口打不开，在跑的那路还会被读成空位再拉一路。
- ComfyUI 没有鉴权：开了监听，`/api/*`、`/neo_studio/*`、`/view` 对局域网上的机器全部敞开，只在信任的网段开，
  用完清空这一项。MCP 服务不参与这条网络口（stdio + 回环，见 [mcp.md](mcp.md)）。

## 远程 ComfyUI

- 「启动设置 → 远程 ComfyUI」填 `http://主机[:端口]`（`https` 同样收；path / query / 锚点 / 凭据不收），存
  `launcher_config.json` 的 `remote`。非空时窗口直接开在 `http://<远端>/neo-studio`，探活与就绪跳转都打在远端上
  （`probe` 收的是目标 base，本机模式是 `http://127.0.0.1:端口`）；留空 = 连本机，也是默认。
- 远程模式下本机不拉进程：`port_busy`、`free_comfy_port`、`start_comfy`、`port_owner`、`kill_pid` 全不参与。
  「启动内核」变成重连远端，「停止内核」禁用 —— 远端进程由远端那台机器自己起停。
- 远端要自己装好 `comfyui-neo-studio` 插件，并在它自己的「启动设置 → 局域网监听」里放开监听；探活打不通时窗口停在
  离线页并提示「远程 ComfyUI 不可达：<地址>」。
- 远程模式读写的是远端的插件数据（配方 / 技能 / 设置都在远端那台机器上）；离线页仍是本机的桌面端服务，浏览本机素材目录。
- 本机启动项（根目录 / 解释器 / 端口 / 局域网监听）在远程模式里灰掉：那几项归远端配置，本机改了影响不到远端。
- 窗口地址换了就是另一个 origin，Studio 页存在 `localStorage` 里的设置不跟着过去。

## 关窗与进程回收

只带走桌面端自己拉起的那路；用户自己启动的 ComfyUI 没有句柄，完全不碰。

- 拉起的那路一出生就挂进 Job Object（`KILL_ON_JOB_CLOSE`）：桌面端进程一死，OS 关句柄连带杀掉作业里的进程
  （含 ComfyUI 自己起的子进程）。收尾链只在桌面端自己走到退出代码时才跑，Ctrl+C、任务管理器结束进程、注销、
  崩溃都把它掐在收尾之前 —— 没有这层内核约束，ComfyUI 就留在端口上成了孤儿，下一轮桌面端探到端口有人监听只能
  附着（`self.comfy` 是 `None`），之后每次关窗都不杀它。
- 第一次 `closing` 只存几何 + 放行关闭（返回 `False`），收尾（杀进程 → 挂「正在停止 ComfyUI」→ 收桌面端服务 →
  `destroy`）全在后台线程走完 —— 杀进程排在挂提示前面，`evaluate_js` 卡住也拖不住带走内核；`closing` 同步跑在
  UI 线程，收尾睡多久窗口就冻多久（桌面端服务正忙时 `join` 吃满 5 秒），`evaluate_js` 更要等 UI 线程回消息循环
  才执行，在处理器里调直接死锁。
- 几何必须在窗口销毁前读走（销毁后读属性会抛，收尾链断在半路、进程变孤儿）；`closed` 与进程退出前各兜一次
  （`destroy` 路径可能根本没有 `closing`），退出前 join 收尾线程，不等完就退进程等于留孤儿。
- 判活按 PID 问 `OpenProcess`，不用 `Popen.poll()`（子进程句柄被回收后它会谎报「已退出」）。
- `terminate` 之后必须 `reap`（`Popen.wait`）回收子进程 —— 不回收的话进程只剩一个内核对象，`pid_alive` 永远报
  「还活着」：关窗固定睡满等待上限（就是那几秒卡顿），按 PID 的兜底强杀与「启动设置」停止内核的端口扫荡也必然失败
  （那行「没有权限终止该进程」）。回收超时才兜底强杀，不做那套按端口扫荡。

## 单实例锁

命名互斥体 `Local\Neo.Studio.SingleInstance`，不占端口：占 8189 监听在 netstat 里像第二路 ComfyUI，会被读成「起了
8188 和 8189 两个端口，关窗只掉一个」。「已存在」的信号问 `kernel32.GetLastError()`，`ctypes.get_last_error()`
在这条调用上拿不到 183。

## 插件同步

源码运行时每次启动把 `studio/` 同步进 `custom_nodes` 那份（`sync_plugin`：只覆盖同名代码，大小与 mtime 对得上的
跳过，ComfyUI 正占用那一个跳过、下次启动再补，目标目录里的东西一样不删）。桌面端服务与 ComfyUI 页面都从
`custom_nodes` 取前端文件，同步完窗口一开就是新 UI；exe 只按内置副本版本换目录，git 检出的那份不碰。
**改完 `app/studio_app.py` 必须重新打包**，见 [release.md](release.md)。

## 静态资源与缓存

桌面端 `/extensions/` 静态响应带 `no-store`（与 ComfyUI 的 `/extensions` 一致），并在开窗口前清掉
`data/studio_profile/EBWebView/Default/Cache`：缓存里的旧插件 JS 会被直接端出来用（不发请求），和新模块拼进同一张
ES 模块图后，链接错误发生在 `studio-app.js` 执行之前、JS 捕获不到，整页只剩顶栏 —— 视图不挂、离线横幅不出、
顶栏状态位永远 `hidden`。

## 日志

- `data/studio_desktop.log`：启动 / 跳转 / 关窗 / 拖动步数（`drag N steps`，0 = 按下没走出拖动阈值或左键已经不
  在），以及页面上报的
  前端未捕获错误（`[web]` 前缀，页面走 js_api 的 `log()`），只留尾部 200KB。
- `data/comfy_run.log`：桌面端拉起 ComfyUI 的完整 stdout / stderr（端口冲突与导入报错都在里面，Studio「设置 → 日志」读它）。

## 相关测试

`app/tests/test_studio_desktop.py`、`app/tests/test_studio_server.py` 与 `studio-app.e2e.mjs`，
见 [testing.md](testing.md)。

