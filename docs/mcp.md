# MCP 服务（外部智能体接入）

`kernel-plugin/mcp_server.py` 是一个独立的 MCP 服务器（stdio 传输）。MCP 客户端（Claude Desktop / Cursor /
自建客户端）把它作为子进程启动，外部智能体由此调用 Neo Studio 的生图与导演能力。

它不随 ComfyUI 启动，也不参与节点注册：零相对导入、只用标准库，一切能力经本机 ComfyUI 的 HTTP 接口完成。
`stdout` 只跑 JSON-RPC，日志一律走 `stderr`。

## 启动

```powershell
python kernel-plugin\mcp_server.py --comfy-url http://127.0.0.1:8188
```

- ComfyUI 地址必须是本机回环（`127.0.0.1` / `localhost` / `::1`）的 http 地址，非回环直接拒绝启动。
- 默认 `http://127.0.0.1:8188`；桌面壳起的 ComfyUI 端口同理，改端口就传 `--comfy-url`。
- `--selftest` 打印启用的工具清单后退出，用来验证安装（不连 ComfyUI）。
- `tools\mcp_setup.ps1` 打印 Claude Desktop / Cursor 的配置片段。

| 参数 | 环境变量 | 说明 |
|------|----------|------|
| `--comfy-url` | `NEO_MCP_COMFY_URL` | ComfyUI 地址（仅回环） |
| `--tools` | `NEO_MCP_TOOLS` | 逗号分隔的工具白名单，留空启用全部 |
| `--image-base64` | `NEO_MCP_IMAGE_BASE64=1` | `get_image` 默认附带 base64 图片字节 |
| `--timeout` | `NEO_MCP_TIMEOUT` | 普通请求超时秒数（默认 30） |

## 工具

| 工具 | 说明 |
|------|------|
| `neo_status` | 版本 / 队列 / 导演配方数，先调它确认服务在线 |
| `list_skills` `list_models` | 生图技能 id、可选模型与建议值 |
| `generate_prompt` | 简短想法 → 成品提示词（走 LLM，需已配置模型） |
| `generate_image` | 提交生图，立即返回 `task_id` |
| `task_status` `list_tasks` `cancel_task` | 任务快照 / 列表 / 取消（四套任务表共用 `task_id`） |
| `get_image` | 产物取图：默认给文件名与 `/view` 地址，`base64=true` 才回字节 |
| `list_gallery` `list_recipes` `load_recipe` | 素材库目录、配方清单、单配方元数据 |
| `director_recipes` `director_spec` | 导演配方清单、`shared` + 分段清单 |
| `director_plan` | 故事板规划：`plan` 主题/脚本 → 分段；`optimize` 单段按 H3 格式重写；`modify` 按指令改单段 |
| `director_copy` `director_save` | 复制配方（解锁预设只读）、写分段到 custom 配方 |
| `director_run` `segment_run` `assemble_run` | 整片 / 单段 / 拼接，均立即返回 `task_id` |

## 用法约定

- **异步任务**：`generate_image` `director_run` `segment_run` `assemble_run` 只返回 `task_id`，
  用 `task_status` 轮询到 `succeeded` 再取产物；整片是多段长任务，不要同步等待。
- **段序号一律 1 起**（第 1 段 = 时间轴第一段）。`segment_run` 的 `segment`、`assemble_run` 与
  `director_run.only_segments` 的列表都是 1 基，内部换算成端点的 0 基。
- **写操作只有两个**：`rs_recipes/save` 与 `rs_recipes/copy`。不暴露删除端点；读文件只经 ComfyUI 的
  `/view`，MCP 层不碰本地路径。内置预设配方只读，先 `director_copy` 再 `director_save`。
- **LLM 依赖**：`generate_prompt` 与 `director_plan` 需要 Neo Studio 设置里已配置 LLM；未配置时返回
  指向设置的短错误，不返回假成功。

## 已知限制

- 单段提示词的逐段改写（`director_plan` 的 `optimize` / `modify`）一次一段，多段需逐次调用。
- 任务快照在结束后会被清理，`task_status` 此时报「任务不存在」；产物名请在此之前取。
- base64 图片单次最多 4 张、单张 1.5MB 以内，超出只给 `/view` 地址；文本返回上限 12000 字符，超出截断。
- 宫格拆分、配音、配音字幕等前端编排能力未开放为工具。
