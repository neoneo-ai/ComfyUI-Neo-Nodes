# 测试

总入口见 [../Developer.md](../Developer.md)。

pytest 配置见 `pytest.ini`（`testpaths = tests`，无需启动 ComfyUI 即可运行）：

```bash
python -m pytest tests -v
```

## Python 单测

- `tests/test_llm.py` — 远程配置加载 / 迁移、模型下载（ModelScope / HuggingFace 回退）、翻译缓存、
  语言检测、文本规范化。
- `tests/test_skills.py` — 技能扫描与分组、内置任务技能存在性、图片解码缩放、多结果解析、
  技能代理（语言互斥主文件选择、引用列表、越界读取拒绝、工具循环按需读引用、本地模式回退）、
  `gen_image` / `requires_ref` 元数据透传与编辑保存保留。
- `tests/test_skill_pose_edit.py` / `tests/test_skill_controlnet.py` — 姿势编辑与 ControlNet 预设技能：
  扫描与去重、`default_prompt` 透出、模板占位符、控制链（预处理 → 模型补丁 → 采样器）接线、
  控制图不占编码器参考槽（`control_ref`）。
- `tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确 / 归一化匹配、量化变体替换、歧义拒绝、
  扩展名约束。
- `tests/test_image_gen.py` — 内置生图参数解析：比例与尺寸取整、输出前缀消毒、模型自动挑选、
  下拉展示排序与自动挑选结果、LoRA 缺失告警、参考图落地、多路槽位空槽裁剪、生图张数覆盖、
  扩图 / 局部编辑仅 Qwen Image 2.1 模板、ControlNet 模板槽位展开与参考张数下限拦截、工作流图结构与 sidecar 写入。
- `tests/test_image_gen_edit.py` — mini-executor：拓扑排序与环检测、引用解析与输出归一化、
  末端 IMAGE 收集与 SaveImage 跳过、未知节点报错、张量 → base64 PNG 往返、请求组装
  （缺 `workflow.json` 报错 / 参考图按槽位排序 / bundle 参考图优先 / 按 `config.json` 的 `max_refs` 限张数）。
- `tests/test_studio_desktop.py` — 桌面壳（`neo_studio_app.py`）：ComfyUI 根与 python 路径解析（整合包同级 `python/` 优先）、
  `/neo_studio/version` 探活与轮询、窗口几何读写（缺文件 / 坏 JSON / 部分字段）、单实例端口占用判定、
  提示走系统消息框（pythonw 无控制台）、拉起 ComfyUI 时压制子控制台窗口、壳日志落盘
  `tmp/studio_shell.log` 与 pywebview 日志 handler（pythonw 的 `stderr` 是 None，控制台 handler 会打断窗口创建）、
  窗口图标路径传给 `webview.start(icon=...)` 与 AppUserModelID（缺 `.ico` 时传 None）、frozen 下 `base_dirs()`
  向上找到插件目录（产物在 `tools` 下）且随包资源走 `_MEIPASS`。
- 打包后的 exe（`tools\build_studio_exe.ps1` 产出 `tools/neo-studio.exe`）：起桩服务让壳认为已就绪，启动 exe 后
  `ExtractIconExW` 确认内嵌图标资源数为 1，`FindWindowW` 找到窗口，`WM_GETICON` 取到 24x24 图标（我们的 `.ico`；
  无 AppUserModelID 且不传 icon 的 pythonw 基线是 48x48 通用图标），`WM_CLOSE` 后退出码 0，
  `configs/studio_window.json` 与 `tmp/studio_profile` 落在插件目录而不是临时解包目录。
- `tests/test_studio.py` — 整片生成路由与任务 watcher、版本路由、日志路由（`/neo_studio/log` 读 `app.logger` 环形缓冲）。
- `tests/test_node_metadata.py` — 节点元数据契约：注册表键清单、`__init__.py` 的 `NEO_NODES` 清单与注册表一致、
  每个节点都有 `web/docs/<节点键>.md` 帮助文档（ComfyUI 原生「信息」页的取用路径）、`SEARCH_ALIASES`（小写、去重、含中文别名）、
  `DESCRIPTION`、`OUTPUT_TOOLTIPS` 与 `RETURN_TYPES` 数量对齐、可见 widget 的输入提示词、V3 节点 schema 元数据。

## 前端回归测试（tests/js）

前端模块在 jsdom + ComfyUI `api` / `app` 替身下加载，用 golden 快照锁定 UI 结构、隐藏控件状态与请求轨迹。
重构 `prompt-manager.js` / `node-behavior.js` 前先跑一遍，确认行为有意变化后再重写 golden。

```bash
npm test                 # 比对 tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1，写入新 golden
```

- `smoke.test.mjs` — 模块可导入、节点扩展注册项。
- `prompt-manager-dom.test.mjs` — 节点创建后的 UI 结构、body 弹层、隐藏控件状态。
- `cache-guard.test.mjs` — 共享 TTL 缓存守卫：命中、过期失效、显式清空。
- `node-behavior-flows.test.mjs` — 随机取词、Enter 流式生成、技能路由请求体、@ 图片选择器、运行时随机菜单。
- `llm-setting-advanced.test.mjs` — 有预设 Base URL 的供应商默认收起「自定义端点」，展开后改写仍能落盘；
  无预设的 OpenAI Compatible 常显，Local GGUF 整体隐藏。

## JS 测试运行器（带超时强制终止）

**跑 JS 测试必须带 `--test-force-exit`。** 节点创建会启动未清理的 `setInterval`，
不带该参数时 `node --test` 子进程因 pending timer 使 event loop 永不空闲而无法自然退出——
表现为测试已全部通过却卡到超时。因此**不要裸跑 `node --test tests/js/*.test.mjs`**。
两个入口都已内置该参数：`npm test`（package.json）与 `tests/run-tests.ps1`
（后者额外提供超时强杀 node 进程树、文件名模糊匹配）。

```powershell
# 跑全部 JS 测试（默认超时 120s）
pwsh tests/run-tests.ps1

# 按文件名模糊匹配（支持多关键词逗号分隔）
pwsh tests/run-tests.ps1 skill-gen-layout
pwsh tests/run-tests.ps1 skill-gen-layout,css-integrity

# 自定义超时秒数
pwsh tests/run-tests.ps1 -Timeout 60
```

退出码：`0` = 全部通过，`1` = 有测试失败 / 无匹配文件，`2` = 超时强制终止。

## 浏览器端到端测试（tests/e2e）

Playwright 驱动真实 ComfyUI 前端，验证窗口控制、内嵌 LiteGraph 画布等 jsdom 覆盖不了的行为。
**需要本机已启动 ComfyUI（默认 `http://127.0.0.1:8188`，可用环境变量 `COMFY_BASE_URL` 覆盖）**；
服务不可达时用例自动 skip 而不是失败。

```bash
npm run e2e                       # tests/e2e/*.e2e.mjs
node --test --test-force-exit --test-timeout=180000 tests/e2e/skill-manager.e2e.mjs
```

- `skill-manager.e2e.mjs` — 技能管理窗口：overlay 指针穿透、⛶ 放大还原、标题栏双击放大、Esc 关闭、
  标题栏拖动、右下角把手拉伸；工作流区默认展开直接挂内嵌编辑画布（canvas 铺满盒子、随窗口缩放与 ⛶ 放大跟随、
  折叠卸载画布、再展开重挂、预设技能保存按钮说明结构变更自动复制、125% 缩放下 widget 弹窗贴着鼠标落点、
  combo 下拉浮在技能弹窗之上）。
  截图落 `tmp/skill-wf-editor.png`、`tmp/skill-wf-prompt.png`。
- `node-docs.e2e.mjs` — 节点帮助：11 个节点文档在 `/extensions/ComfyUI-Neo-Nodes/docs/<节点键>.md` 可取、
  节点上不再有 `neo_help` 徽标 widget、属性面板「信息」页渲染出文档正文（会话未注册属性面板时 skip）。
- `studio-app.e2e.mjs` — 桌面壳窗口：壳自行拉起 ComfyUI，经 WebView2 远程调试端口连 CDP，断言窗口按
  `configs/studio_window.json` 的存档尺寸打开、四视图渲染、日志 tab 读到控制台内容、重开页面后 localStorage 保留。
  **会弹真实窗口，默认 skip；启用：`NEO_STUDIO_APP=1`（前置：整合包 python 已装 `pywebview`）。**
- `prompt-width.e2e.mjs` — prompt 节点面板宽度：创建、`setSize`、工作流 `configure` 还原宽度后，
  `prompt_ui` DOM widget 宽度都等于 `node.size[0]`（LiteGraph 的 size setter 不触发 `onResize`，
  插件在 `onConfigure` 补同步）。
