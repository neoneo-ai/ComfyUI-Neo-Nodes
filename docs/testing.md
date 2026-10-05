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
- `tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确 / 归一化匹配、量化变体替换、歧义拒绝、
  扩展名约束。
- `tests/test_image_gen.py` — 内置生图参数解析：比例与尺寸取整、输出前缀消毒、模型自动挑选、
  下拉展示排序与自动挑选结果、LoRA 缺失告警、参考图落地、多路槽位空槽裁剪、生图张数覆盖、
  扩图 / 局部编辑仅 Qwen Image 2.1 模板、工作流图结构与 sidecar 写入。
- `tests/test_image_gen_edit.py` — mini-executor：拓扑排序与环检测、引用解析与输出归一化、
  末端 IMAGE 收集与 SaveImage 跳过、未知节点报错、张量 → base64 PNG 往返、请求组装
  （缺 `workflow.json` 报错 / 参考图按槽位排序 / bundle 参考图优先 / 按模板自适应 `max_refs`）。

## 前端回归测试（tests/js）

前端模块在 jsdom + ComfyUI `api` / `app` 替身下加载，用 golden 快照锁定 UI 结构、隐藏控件状态与请求轨迹。
重构 `prompt-manager.js` / `node-behavior.js` 前先跑一遍，确认行为有意变化后再重写 golden。

```bash
npm test                 # 比对 tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1，写入新 golden
```

- `smoke.test.mjs` — 模块可导入、节点扩展注册项。
- `prompt-manager-dom.test.mjs` — 节点创建后的 UI 结构、body 弹层、隐藏控件状态。
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
  标题栏拖动、右下角把手拉伸；工作流区只读流程图 ⇄ 内嵌编辑画布（canvas 铺满盒子、随窗口缩放跟随、
  切回只读卸载画布、预设技能隐藏保存按钮、125% 缩放下 widget 弹窗贴着鼠标落点）。
  截图落 `tmp/skill-wf-editor.png`、`tmp/skill-wf-prompt.png`。
