# Neo Studio 开发者文档

面向开发者：项目结构、前后端模块职责、API 路由、节点注册、数据目录、测试与发布。
终端用户使用文档见 [README.md](README.md)，详细文档按大模块拆分在 `docs/`（索引见 [docs/README.md](docs/README.md)）。

## 文档地图

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 项目结构、模块职责、节点注册、数据与配置目录 |
| [docs/api-routes.md](docs/api-routes.md) | 后端 API 路由一览 |
| [docs/testing.md](docs/testing.md) | pytest 单测与 JS 回归测试（golden 快照、run-tests.ps1） |
| [docs/release.md](docs/release.md) | Registry 发布与离线工具（预设预处理 / OSS 部署） |
| [docs/llm.md](docs/llm.md) | LLM 模式、本地 GGUF 安装、模型目录规范 |

功能模块文档（用户说明 + 实现细节）：
[prompts](docs/prompts.md) · [skills](docs/skills.md) · [image-gen](docs/image-gen.md) · [h3-video-gen](docs/h3-video-gen.md) ·
[recipes](docs/recipes.md) · [gallery](docs/gallery.md) · [workflow-repair](docs/workflow-repair.md)

## 速览

- **插件入口** `__init__.py`：导入后端模块注册 API 路由，按 `NEO_NODES` 清单合并节点映射并打印版本 banner，
  声明 `WEB_DIRECTORY = "./web"`。
- **节点注册**：`prompts.py` 底部 `NODE_CLASS_MAPPINGS`（NeoPromptEncoder / NeoPromptAgent），
  另含 `image_gen_edit.py` 的 NeoImageGenEdit（V3 节点 + Autogrow 参考图）。
- **API 路由**：gallery 系列与 `llm.py`（LLM 配置 / 标题提取）自带 `web.RouteTableDef`，由 `__init__.py` 统一挂进
  `PromptServer.instance.routes`（其余模块仍直接装饰注册），清单见 [docs/api-routes.md](docs/api-routes.md)。
  桌面壳在 ComfyUI 端口 +3 复用同一批 handler 跑离线 Studio（`neo_studio_server.py`）：归壳服务的路由由
  `neo_studio_caps.py` 一张表划定（文件读写 / 本地检索 / 远程下载 / 8080 LLM），表外一律 `409 offline`；
  功能开关表随 `/neo_studio/version` 下发，Studio 只门控运行类按钮（生成 / 跑段 / 拼接），
  配方编辑、技能编辑、设置、LLM 配置都不需要 ComfyUI 运行时。壳拉起 ComfyUI 期间的 `starting` 是
  `StudioShell` 与壳侧服务共用的一份 dict，`comfy_state` 与 `/neo_studio/version` 同时下发
  （pywebview 的 js_api 注入晚于页面加载，且 window.pywebview 先出现、方法由 finish.js 后填：壳侧 api
  一律等到要用的方法出现才接管，前端只靠版本快照就知道在启动中），这段时间只出
  「ComfyUI 启动中…」，收起未运行横幅与启动入口。关窗只带走壳自己拉起的那路：第一次 `closing`
  只存几何 + 放行关闭（返回 False），挂「正在停止 ComfyUI」与收尾（杀进程、收壳侧服务、`destroy`）
  全在后台线程走完 —— `closing` 同步跑在 UI 线程，收尾睡多久窗口就冻多久（壳侧服务正忙时
  `join` 吃满 5 秒），`evaluate_js` 更要等 UI 线程回消息循环才执行，在处理器里调直接死锁。
  几何必须在窗口销毁前读走（销毁后读属性会抛，收尾链断在半路、进程变孤儿）；`closed` 与进程退出前
  各兜一次（`destroy` 路径可能根本没有 `closing`），退出前 join 收尾线程，不等完就退进程等于留孤儿。
  判活按 PID 问 `OpenProcess`，不用 `Popen.poll()`（子进程句柄被回收后它会谎报「已退出」）；
  `terminate` 之后必须 `reap`（`Popen.wait`）回收子进程 —— 不回收的话进程只剩一个内核对象，
  `pid_alive` 永远报「还活着」：关窗固定睡满等待上限（就是那几秒卡顿），按 PID 的兜底强杀与顶栏停止
  的端口扫荡也必然失败（那行「没有权限终止该进程」）。回收超时才兜底强杀，不做顶栏停止那套按端口扫荡；
  用户自己启动的 ComfyUI 没有句柄，完全不碰。起壳时「有没有 ComfyUI」只看端口有没有人监听：
  `/neo_studio/version` 探不到（那路插件没加载、还在导入自定义节点）也只附着，不在旁边端口拉第二路，
  顶栏「启动」按钮同样只附着。单实例锁是命名互斥体 `Local\Neo.Studio.SingleInstance`（已存在的信号问
  `kernel32.GetLastError()`，`ctypes.get_last_error()` 在这条调用上拿不到 183），不占端口：占 8189 监听
  在 netstat 里像第二路 ComfyUI，会被读成「起了 8188 和 8189 两个端口，关窗只掉一个」。
  根目录推不出、或同级与内部都找不到 `python.exe` 时窗口开在引导页（`guide_html`，`load_html` + js_api）：
  那时 `build_app` 连 `folder_paths` 都 import 不了，壳侧服务本来就起不来，页面只能不依赖 HTTP 服务；
  校验与拉起全走 js_api（`check_setup` / `pick_root` / `pick_python` / `start_setup`），根目录补完了服务才起得来。
  壳侧 `/extensions/` 静态响应带 `no-store`（与 ComfyUI 的 `/extensions` 一致），并在开窗口前清掉
  `tmp/studio_profile/EBWebView/Default/Cache`：缓存里的旧插件 JS 会被直接端出来用（不发请求），
  和新模块拼进同一张 ES 模块图后，链接错误发生在 `studio-app.js` 执行之前、JS 捕获不到，
  整页只剩顶栏 —— 视图不挂、离线横幅不出、顶栏启停控件永远 `hidden`。
  壳日志 `tmp/studio_shell.log` 记启动 / 跳转 / 关窗，以及页面
  上报的前端未捕获错误（`[web]` 前缀，页面走 js_api 的 `log()`），只留尾部 200KB；壳拉起 ComfyUI 的完整
  输出在 `tmp/comfy_run.log`（Studio「设置 → 日志」读它）。

- **前端资源**：`web/` 下的模块由 ComfyUI 扩展机制加载（只认 `.js`），Studio 独立页面在 `web/studio/`，
  跨节点共享工具在 `web/js/core/`，节点帮助文档在 `web/docs/<节点键>.md`（ComfyUI 原生约定路径，属性面板「信息」页直接加载）。

## 常用命令

```bash
python -m pytest tests -v      # Python 单元测试（无需启动 ComfyUI）
npm test                       # JS 回归测试（golden 快照比对）
pwsh tests/run-tests.ps1       # JS 测试运行器（带超时强制终止，勿裸跑 node --test）
```

详见 [docs/testing.md](docs/testing.md)。
