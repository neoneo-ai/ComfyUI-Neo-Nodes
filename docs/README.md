# 文档索引

本目录按大模块拆分插件文档。总入口仍是根目录的 [README.md](../README.md)（终端用户）与 [Developer.md](../Developer.md)（开发者）。

## 功能模块（终端用户）

| 文档 | 内容 |
|------|------|
| [prompts.md](prompts.md) | 提示词节点：Neo Prompt Encoder / Agent、节点界面与按钮、模板与技能管理、图片反推与 `@` 引用、`/` 技能菜单 |
| [llm.md](llm.md) | LLM 模式（远程/本地）、思考模型、本地 GGUF 安装（wheel / 源码编译 / Windows 排障）、模型目录规范 |
| [image-gen.md](image-gen.md) | Krea2 生图：聊天生图与 Krea2 Generate 节点（IMAGE 输出） |
| [recipes.md](recipes.md) | 配方：保存、一键发送到工作流、示例结果 + 实现细节（资源收集 / 子图对齐） |
| [gallery.md](gallery.md) | Neo Gallery：浏览、灯箱、文件管理、Civitai LORA 缓存、收藏（书签）+ 实现细节 |
| [workflow-repair.md](workflow-repair.md) | 工作流模型路径修复 |

## 开发者文档

| 文档 | 内容 |
|------|------|
| [architecture.md](architecture.md) | 项目结构、后端/前端模块职责、节点注册、数据与配置目录 |
| [api-routes.md](api-routes.md) | 后端 API 路由（`/neo_gallery/*` / `/rs_recipes/*` / `/neo_nodes/*` / `/neo_image_gen/*` / `/rs_prompts/*`） |
| [testing.md](testing.md) | pytest 单元测试 + JS 回归测试（golden 快照、run-tests.ps1） |
| [release.md](release.md) | Registry 发布与离线工具（预设预处理 / OSS 部署） |
