# Krea2 生图

Krea2 生图有两个入口：提示词节点内置的**聊天生图**，以及独立的 **🎨 Krea2 Generate** 节点。

## 聊天生图（节点内置）

选生图 skill 后 ✨ 直接生成：文生图 / 参考图四视图角色板，LoRA 可选（依赖参考图模式），底部状态行实时显示进度/取消，结果 Markdown 预览并一键装配回 LoadImage。

> 生图需 GPU/显存，且所选 skill 必须声明 `gen_image: true` 并附 `workflow.json`。
> 生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，无需手配；未匹配到时再到节点生图设置里手动指定。

## 🎨 Krea2 Generate - 一体化生图节点（IMAGE 输出）

按所选生图 skill 的 `workflow.json` 模板**同步生成图像并直接输出 IMAGE 张量**，供下游节点（SaveImage / 其它图像节点）连线使用。与「聊天生图」不同：它不经过聊天界面、不落盘到 output 目录，而是把生成的图像作为张量返回给工作流。

**常用搭配 ⚡ Neo Prompt Agent**：由它生成 prompt 文本接入本节点。生图模型 / Text Encoder / VAE 默认「自动」按 skill 模板匹配，一般无需手配；未匹配到时再到生图设置里手动指定。

- **进程内 mini-executor** - 在节点 forward 内拓扑执行所选 skill 的 workflow 模板（复用 `image_gen.render_template`），跳过 SaveImage/Preview 等落盘节点，取末端 IMAGE 输出
- **skill_id 下拉** - 按生图 skill 的**名称**（frontmatter `name`，缺省回退 id）列出，仅含带 `workflow.json` 的生图 skill（`gen_image: true`）；节点内部把所选名称解析回 skill id 再取模板，旧工作流里存的 id 也能兼容；skill 增删/改名后需刷新 `/object_info`
- **prompt 可连线** - STRING 输入既可手填，也可连 Neo Prompt 节点的 PROMPT 输出
- **参考图可选** - IMAGE 输入供 `requires_ref`（四视图）skill 使用，文生图 skill 忽略
- **需 GPU/显存** - forward 内加载 UNET+CLIP+VAE 并采样，执行期间阻塞主工作流

### 输入/输出

| 输入 | 类型 | 说明 |
|------|------|------|
| skill_id | COMBO | 生图 skill 名称（仅含 workflow.json 的 gen_image skill；显示 name，内部解析为 id） |
| prompt | STRING | 提示词（可手填或连 Neo Prompt 的 PROMPT） |
| image | IMAGE (可选) | 参考图；四视图等 requires_ref skill 需要 |
| seed | INT (可选) | 随机种子，默认 0（固定）；要随机把「生成后控制」设为 randomize |
| count | INT (可选) | 生成张数（1–8） |

| 输出 | 类型 | 说明 |
|------|------|------|
| images | IMAGE | 生成的图像张量 `[B,H,W,C]` |
