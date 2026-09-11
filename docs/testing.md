# 测试

总入口见 [../Developer.md](../Developer.md)。

pytest 配置见 `pytest.ini`（`testpaths = tests`，无需启动 ComfyUI 即可运行）：

```bash
python -m pytest tests -v
```

- `tests/test_llm.py` — 远程配置加载/迁移、模型下载（ModelScope / HuggingFace 回退）、翻译缓存、语言检测、文本规范化
- `tests/test_skills.py` — 技能扫描与分组、内置任务技能存在性、图片解码缩放、多结果解析（分隔符 / JSON 数组）、skill 代理（语言互斥主文件选择、引用列表、安全读取越界拒绝、工具调用循环按需读引用、本地模式回退）、`gen_image` / `requires_ref` 元数据透传与编辑保存保留
- `tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确/归一化匹配、量化变体替换、歧义拒绝、扩展名约束
- `tests/test_image_gen.py` — 内置生图参数解析：比例与尺寸取整、输出前缀消毒、模型自动挑选（Krea2 只精确匹配 Qwen3-VL-4B，8B/32B 不参与；VAE 优先 Qwen-Image）、下拉展示排序（krea2 靠前）与 LoRA「自动」建议名、LoRA 缺失告警、参考图（input / data URI）落地、四视图固定 16:9（参考图长边限 1024px、`Krea2EditModelPatch` fit 接线、denoise=1.0、四视图 LoRA 自动追加/去重/缺失报错）、生图张数（设置默认 / 单次覆盖 / 四视图强制 1）、工作流图结构与 sidecar 写入、vendor `krea2_edit` 纯函数单测（RoPE 偏移 / latent fit / 5D 展平）
- `tests/test_krea2_generate.py` — mini-executor 单测：拓扑排序与环检测、引用解析与输出归一化（单/多输出）、末端 IMAGE 收集与 SaveImage 跳过、未知节点报错、张量→base64 PNG 编码往返、`NeoKrea2Generate` 请求组装（缺 workflow.json 报错 / happy path 返回 IMAGE）

## 前端回归测试（tests/js）

前端模块在 jsdom + ComfyUI `api`/`app` 替身下加载，用 golden 快照锁定 UI 结构、隐藏控件状态与请求轨迹；重构 `prompt-manager.js` / `node-behavior.js` 前先跑一遍，确认行为有意变化后再重写 golden。

```bash
npm test                 # 比对 tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1，写入新 golden
```

- `smoke.test.mjs` — 模块可导入、节点扩展注册项
- `prompt-manager-dom.test.mjs` — NeoPromptAgent / NeoPrompts 创建后的 UI 结构、body 弹层、隐藏控件状态
- `node-behavior-flows.test.mjs` — 随机取词、Enter 流式生成、skill 路由请求体、@ 标记缺图提示、运行时随机菜单

## JS 测试运行器（带超时强制终止）

**跑 JS 测试必须带 `--test-force-exit`。** 节点创建会启动未清理的 `setInterval`（如 `prompts.js` 的 enforcementInterval），若不带该参数，`node --test` 子进程因 pending timer 使 event loop 永不空闲而无法自然退出——表现为测试已全部通过却卡到超时。因此**不要裸跑 `node --test tests/js/*.test.mjs`**。两个入口都已内置该参数：`npm test`（package.json）与 `pwsh tests/run-tests.ps1`（后者额外提供超时强杀 node 进程树、文件名模糊匹配）。

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
