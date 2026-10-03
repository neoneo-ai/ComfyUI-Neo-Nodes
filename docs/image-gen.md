# Krea2 生图

Krea2 生图有两个入口：提示词节点内置的**聊天生图**，以及独立的 **🎨 Neo Image Gen & Edit** 节点（文生图 + 参考图编辑，模型由所选 skill 决定，如 Krea2 / Qwen Image 2.1）。

## 聊天生图（节点内置）

选生图 skill 后 ✨ 直接生成：文生图 / 参考图四视图角色板，LoRA 可选（文件名含 quadview / 四视图 的仅在参考图模式加载），底部状态行实时显示进度/取消，结果 Markdown 预览并一键装配回 LoadImage。

> 生图需 GPU/显存，且所选 skill 必须声明 `gen_image: true` 并附 `workflow.json`。
> 生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，无需手配；未匹配到时再到节点生图设置里手动指定。

## 🎨 Neo Image Gen & Edit - 一体化生图/编辑节点（IMAGE 输出）

按所选生图 skill 的 `workflow.json` 模板**同步生成图像并直接输出 IMAGE 张量**，供下游节点（SaveImage / 其它图像节点）连线使用。不挂参考图 = 文生图；挂上参考图则按 skill 模板进入参考/编辑模式（如 Qwen Image 2.1 编辑，最多 10 张）。与「聊天生图」不同：它不经过聊天界面、不落盘到 output 目录，而是把生成的图像作为张量返回给工作流。

![🎨 Neo Image Gen & Edit 节点](assets/images/neo-krea2-generate-node.png)

**常用搭配 ⚡ Neo Prompt Agent**：由它生成 prompt 文本接入本节点。生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，一般无需手配；未匹配到时再到生图设置里手动指定。

- **进程内 mini-executor** - 在节点 execute 内拓扑执行所选 skill 的 workflow 模板（复用 `image_gen.render_template`），跳过 SaveImage/Preview 等落盘节点，取末端 IMAGE 输出
- **skill 下拉** - 按生图 skill 的**中文名**（frontmatter `cn_name`，缺省回退 `name`）列出，仅含带 `workflow.json` 的生图 skill（`gen_image: true`）；节点内部把所选名称解析回 skill id 再取模板，旧工作流里存的 id/名称也能兼容；skill 增删/改名后需刷新 `/object_info`。**点击下拉弹出居中可搜索选择窗**（按 category 分组、📷 标记需图技能，底部 + New Skill / ⬆ ZIP / ⬆ Folder / 📋 From Canvas 管理入口、行内 ✎ Edit / 👁 查看），替代原生 combo 列表
- **prompt 可连线** - STRING 输入既可手填，也可连 Neo Prompt 节点的 PROMPT 输出
- **参考图槽位（Autogrow，可选）** - `refs.image_1 ... image_10` 动态槽位，按需增删：不挂 = 文生图；挂上即参考/编辑模式，槽位顺序就是语义顺序。保留张数按 skill 模板的 `{{REF_IMAGE_n}}` 槽位自适应（Krea2 单路模板仍只取第一张并提示）
- **bundle 输入（可选）** - 连 ⚡ Neo Prompt Agent 的 BUNDLE 输出：prompt 留空时取 bundle 里的、bundle 里的参考图优先于节点挂的参考图；生图 skill 始终用节点本地选择（bundle 只带 prompt/参考图，不携带 skill）；bundle 缺失/过期则回退本地。**前端渲染为纯连线槽**（节点体内不显示文本框，只留左侧 slot）。连上 BUNDLE 后仅 `prompt` 控件被禁用（以 bundle 为准），`skill` 保持可选
- **需 GPU/显存** - execute 内加载 UNET+CLIP+VAE 并采样，执行期间阻塞主工作流

### 输入/输出

| 输入 | 类型 | 说明 |
|------|------|------|
| skill | COMBO | 生图 skill 中文名（仅含 workflow.json 的 gen_image skill；显示 cn_name，内部解析为 id） |
| prompt | STRING | 提示词（可手填或连 Neo Prompt 的 PROMPT） |
| refs.image_1 … image_10 | IMAGE (可选，Autogrow) | 参考图槽位（按需增删）：不挂 = 文生图；挂上 = 参考/编辑模式，槽位顺序即语义顺序。Krea2 单路模板只用第一张 |
| bundle | STRING (可选) | Neo Prompt Agent 的 BUNDLE id；前端为纯连线槽（无文本框）。连上后仅 `prompt` 控件禁用，参考图以 bundle 为准、prompt 留空时取 bundle；生图 skill 仍用节点本地选择 |
| seed | INT (可选) | 随机种子，默认 0（固定）；要随机把「生成后控制」设为 randomize |
| count | INT (可选) | 生成张数（1–8），默认 1 |
| width | INT (可选) | 输出宽度，默认 -1 = 用 skill/preset 比例算尺寸；>0 覆盖模板分辨率。前端选中/切换 skill 时自动填入该 skill 预设宽高（`/neo_image_gen/skill_dims`），手改后生效 |
| height | INT (可选) | 输出高度，默认 -1 = 用 skill/preset 比例算尺寸；>0 覆盖模板分辨率。前端选中/切换 skill 时自动填入该 skill 预设宽高（`/neo_image_gen/skill_dims`），手改后生效 |
| steps | INT (可选) | 采样步数，默认 -1 = 用 skill `config.json` 的 `steps`（缺省 20）；>0 覆盖。前端选中/切换 skill 时自动填入该 skill 预设值（`/neo_image_gen/skill_dims`），手改后生效。模板里对应 `{{STEPS}}` 占位符 |
| model | MODEL (可选) | 外部加速模型连线槽；提供时覆盖内部主模型链（UNETLoader/LoRA 等，只沿 `model` 边剪枝），注入到 `KSampler.model` 来源处 |

| 输出 | 类型 | 说明 |
|------|------|------|
| images | IMAGE | 生成的图像张量 `[B,H,W,C]` |

### 行为

- **旧工作流 / 复制粘贴串位自动修复**：本节点 `seed` 之后会自动追加「生成后控制」（`control_after_generate`）下拉，占一个 `widgets_values` 位置。widget 集合变化（新增 width/height）后，载入旧工作流或复制粘贴可能按位置错一位、把数字写进该下拉或 `seed`。前端在 `onConfigure` 检测到「生成后控制」不是模式串时，自动复位为 `fixed`、`count` 归 1，并按所选 skill 预设强制重填 width/height；同时若 `seed` 落到非有限数或负数（如 `-1`/NaN），一并复位为默认 `0`（串位块无法可靠恢复原值）。旧格式（`widgets_values` 少于当前控件数）载入也会强制按预设重填宽高。
- **Skill 有效性状态条**：节点底部按所选 skill 后台校验其 `workflow.json`（对照 `/object_info` 与 `/models/*`，与技能详情页流程图同一套检查），缺模型/缺节点时显示「⚠️ N 个模型缺失 · M 个节点未安装 → 查看详情/修复」；点按钮直接打开该 skill 详情弹窗修复（保存后即时重检）。无缺失、无 `workflow.json` 或校验接口不可用时整条隐藏（不占高、不误报）；同一 skill 的检测结果会话内缓存 60s。

## 尺寸（Qwen Image 2.1）

Qwen2.1 的 latent 一格 = 32px（VAE 16x 下采样 + 2x2 patchify）：

- **目标尺寸强制 32 对齐**：走 Qwen2.1 模板的请求，显式宽高先对齐到 32，比例 / 设置默认值那条路再兜一次。画廊图片编辑窗的目标分辨率默认取原图尺寸并对齐到 32；原图超过「模型工作分辨率」时按它等比封顶（只封顶不放大，小图保持原尺寸），输入框 32 步进、失焦即对齐。
- **模型工作分辨率** = 设置项 `target_megapixels`（默认 1.5，可在「⚙️ 设置 → 🖼️ 生图默认设置 → 目标像素数 (MP)」里改，skill 的 `config.json` 也可覆盖）：扩图补边画布归一化到它，编辑的目标超过它时封顶。
- **常规编辑**（带参考图、非扩图 / 非局部编辑）：链路写在模板 `workflow.json` 里——`LoadImage → ImageScale({{CANVAS_WIDTH}}, {{CANVAS_HEIGHT}}) → TextEncodeQwenImage21(resolution=0) → KSampler`，空 latent 仍是 `EmptyLatentImage({{WIDTH}}, {{HEIGHT}})`。参考图与 latent 同尺寸、同在 32 网格上，画面位置才不偏（参考工作流「图像编辑」组用 `ImageScaleToTotalPixels(steps=32)` + `ResolutionSelector(multiple=32)` 表达同一件事）。画廊对比窗左侧也换成这张缩放图（后端随任务返回 `canvas`），两侧同尺寸才能真正逐像素对比。
- **画布尺寸 `{{CANVAS_WIDTH}}/{{CANVAS_HEIGHT}}`**：比例与原图一致时就是目标分辨率；差超过半格（换画幅重画，例如角色设定图拿竖图参考出横版）时只把原图对齐到 32，不拉变形参考图。无参考图（文生图）时该节点连同 `LoadImage` 一起被裁掉，latent 走模板里的 `EmptyLatentImage`。

## 扩图（Qwen Image 2.1）

画廊「图片编辑」弹窗的扩图开关（见 `gallery.md`）向 `/neo_image_gen/generate` 发 `outpaint: {left, top, right, bottom, total_pixels}`；扩图请求只能发给带扩图链的技能（模板含 `ImagePadForOutpaint`），否则报「该技能不支持扩图」。链路写在 `qwen_image_21_outpaint/workflow.json` 里，与参考工作流 `▶▷Qwen-image21-功能流` 的「图像扩展」分支一致：

`LoadImage → ImageScaleToTotalPixels({{OUTPAINT_REF_MP}}, 32) → ImagePadForOutpaint({{PAD_*}}, feathering=0) → ImageScaleToTotalPixels({{TARGET_MP}}, 32) → TextEncodeQwenImage21(resolution=0) → KSampler(latent = 编码器空 latent)`

- `{{OUTPAINT_REF_MP}}` 固定 1.0；`{{TARGET_MP}}` = 请求的 `total_pixels`（0/缺失用设置项 `target_megapixels`，默认 1.5）；`{{PAD_*}}` 是四边留白
- 四边留白以「原图按 1MP 归一化后」那一层的像素计（前端按同一比例换算，拖出来的比例不变）；两次缩放都带 `resolution_steps=32`：编码器按 `round(尺寸/32)*32` 重建参考图并据此建空 latent，尺寸不整就会缩放参考图、出图尺寸与内容一起错位
- 没开扩图 / 没参考图时这些占位符判「未填」，整条扩图链被裁掉
- 提示词为空时填默认触发词（`OUTPAINT_DEFAULT_PROMPT`）

预设技能 `qwen_image_21_outpaint` 在 `config.json` 固定扩图 LoRA（文件缺失时跳过并警告，不阻断生成）。
