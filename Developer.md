# ComfyUI-Neo-Nodes 开发者文档

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
- **API 路由**：通过 `PromptServer.instance.routes` 注册，清单见 [docs/api-routes.md](docs/api-routes.md)。
- **前端资源**：`web/` 下的模块由 ComfyUI 扩展机制加载，Studio 独立页面在 `web/studio/`。

## 常用命令

```bash
python -m pytest tests -v      # Python 单元测试（无需启动 ComfyUI）
npm test                       # JS 回归测试（golden 快照比对）
pwsh tests/run-tests.ps1       # JS 测试运行器（带超时强制终止，勿裸跑 node --test）
```

详见 [docs/testing.md](docs/testing.md)。
