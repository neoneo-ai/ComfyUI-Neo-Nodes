# Krea2 生图

Krea2 生图有两个入口：提示词节点内置的**聊天生图**，以及独立的 **🎨 Neo Image Gen & Edit** 节点（文生图 + 参考图编辑，模型由所选 skill 决定，如 Krea2 / Qwen Image 2.1）。

## 聊天生图（节点内置）

选生图 skill 后 ✨ 直接生成：文生图 / 参考图四视图角色板，LoRA 可选（依赖参考图模式），底部状态行实时显示进度/取消，结果 Markdown 预览并一键装配回 LoadImage。

> 生图需 GPU/显存，且所选 skill 必须声明 `gen_image: true` 并附 `workflow.json`。
> 生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，无需手配；未匹配到时再到节点生图设置里手动指定。

## 🎨 Neo Image Gen & Edit - 一体化生图/编辑节点（IMAGE 输出）

按所选生图 skill 的 `workflow.json` 模板**同步生成图像并直接输出 IMAGE 张量**，供下游节点（SaveImage / 其它图像节点）连线使用。不挂参考图 = 文生图；挂上参考图则按 skill 模板进入参考/编辑模式（如 Qwen Image 2.1 编辑，最多 10 张）。与「聊天生图」不同：它不经过聊天界面、不落盘到 output 目录，而是把生成的图像作为张量返回给工作流。

![🎨 Neo Image Gen & Edit 节点](assets/images/neo-krea2-generate-node.png)

**常用搭配 ⚡ Neo Prompt Agent**：由它生成 prompt 文本接入本节点。生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，一般无需手配；未匹配到时再到生图设置里手动指定。

- **进程内 mini-executor** - 在节点 execute 内拓扑执行所选 skill 的 workflow 模板（复用 `image_gen.render_template`），跳过 SaveImage/Preview 等落盘节点，取末端 IMAGE 输出
- **skill_id 下拉** - 按生图 skill 的**名称**（frontmatter `name`，缺省回退 id）列出，仅含带 `workflow.json` 的生图 skill（`gen_image: true`）；节点内部把所选名称解析回 skill id 再取模板，旧工作流里存的 id 也能兼容；skill 增删/改名后需刷新 `/object_info`。**点击下拉弹出居中可搜索选择窗**（按 category 分组、📷 标记需图技能，底部 + New Skill / ⬆ ZIP / ⬆ Folder / 📋 From Canvas 管理入口、行内 ✎ Edit / 👁 查看），替代原生 combo 列表
- **prompt 可连线** - STRING 输入既可手填，也可连 Neo Prompt 节点的 PROMPT 输出
- **参考图槽位（Autogrow，可选）** - `refs.image_1 ... image_10` 动态槽位，按需增删：不挂 = 文生图；挂上即参考/编辑模式，槽位顺序就是语义顺序。保留张数按 skill 模板的 `{{REF_IMAGE_n}}` 槽位自适应（Krea2 单路模板仍只取第一张并提示）
- **bundle 输入（可选）** - 连 ⚡ Neo Prompt Agent 的 BUNDLE 输出：prompt 留空时取 bundle 里的、bundle 里的参考图优先于节点挂的参考图；生图 skill 始终用节点本地选择（bundle 只带 prompt/参考图，不携带 skill）；bundle 缺失/过期则回退本地。**前端渲染为纯连线槽**（节点体内不显示文本框，只留左侧 slot）。连上 BUNDLE 后仅 `prompt` 控件被禁用（以 bundle 为准），`skill_id` 保持可选
- **需 GPU/显存** - execute 内加载 UNET+CLIP+VAE 并采样，执行期间阻塞主工作流

### 输入/输出

| 输入 | 类型 | 说明 |
|------|------|------|
| skill_id | COMBO | 生图 skill 名称（仅含 workflow.json 的 gen_image skill；显示 name，内部解析为 id） |
| prompt | STRING | 提示词（可手填或连 Neo Prompt 的 PROMPT） |
| refs.image_1 … image_10 | IMAGE (可选，Autogrow) | 参考图槽位（按需增删）：不挂 = 文生图；挂上 = 参考/编辑模式，槽位顺序即语义顺序。Krea2 单路模板只用第一张 |
| bundle | STRING (可选) | Neo Prompt Agent 的 BUNDLE id；前端为纯连线槽（无文本框）。连上后仅 `prompt` 控件禁用，参考图以 bundle 为准、prompt 留空时取 bundle；生图 skill 仍用节点本地选择 |
| seed | INT (可选) | 随机种子，默认 0（固定）；要随机把「生成后控制」设为 randomize |
| count | INT (可选) | 生成张数（1–8），默认 1 |
| width | INT (可选) | 输出宽度，默认 -1 = 用 skill/preset 比例算尺寸；>0 覆盖模板分辨率。前端选中/切换 skill 时自动填入该 skill 预设宽高（`/neo_image_gen/skill_dims`），手改后生效 |
| height | INT (可选) | 输出高度，默认 -1 = 用 skill/preset 比例算尺寸；>0 覆盖模板分辨率。前端选中/切换 skill 时自动填入该 skill 预设宽高（`/neo_image_gen/skill_dims`），手改后生效 |
| model | MODEL (可选) | 外部加速模型连线槽；提供时覆盖内部主模型链（UNETLoader/LoRA 等，只沿 `model` 边剪枝），注入到 `KSampler.model` 来源处 |

| 输出 | 类型 | 说明 |
|------|------|------|
| images | IMAGE | 生成的图像张量 `[B,H,W,C]` |

### 行为

- **旧工作流 / 复制粘贴串位自动修复**：本节点 `seed` 之后会自动追加「生成后控制」（`control_after_generate`）下拉，占一个 `widgets_values` 位置。widget 集合变化（新增 width/height）后，载入旧工作流或复制粘贴可能按位置错一位、把数字写进该下拉或 `seed`。前端在 `onConfigure` 检测到「生成后控制」不是模式串时，自动复位为 `fixed`、`count` 归 1，并按所选 skill 预设强制重填 width/height；同时若 `seed` 落到非有限数或负数（如 `-1`/NaN），一并复位为默认 `0`（串位块无法可靠恢复原值）。旧格式（`widgets_values` 少于当前控件数）载入也会强制按预设重填宽高。
- **Skill 有效性状态条**：节点底部按所选 skill 后台校验其 `workflow.json`（对照 `/object_info` 与 `/models/*`，与技能详情页流程图同一套检查），缺模型/缺节点时显示「⚠️ N 个模型缺失 · M 个节点未安装 → 查看详情/修复」；点按钮直接打开该 skill 详情弹窗修复（保存后即时重检）。无缺失、无 `workflow.json` 或校验接口不可用时整条隐藏（不占高、不误报）；同一 skill 的检测结果会话内缓存 60s。
