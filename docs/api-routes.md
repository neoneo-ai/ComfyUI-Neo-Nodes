# 后端 API 路由

路由通过 `PromptServer.instance.routes` 注册，总入口见 [../Developer.md](../Developer.md)。
下表只列路由与用途；请求体字段与返回结构以源码为准。

## gallery.py — `/neo_gallery/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/list` | 目录内容列表（预设 / 自定义 / 系统聚合） |
| GET | `/neo_gallery/css` | 内置素材 CSS 资源 |
| GET | `/neo_gallery/placeholder.png` | 占位图 |
| GET | `/neo_gallery/subdirs` | 子目录列表 |
| GET | `/neo_gallery/thumbnail` | 缩略图（带缓存生成） |
| GET | `/neo_gallery/video` | 视频流 |
| GET | `/neo_gallery/media_meta` | 媒体元数据 |
| GET | `/neo_gallery/image` | 媒体文件 |
| POST | `/neo_gallery/dir_cover_images` | 目录封面图 |
| POST | `/neo_gallery/save_settings` | 保存素材设置（自定义目录等） |
| GET | `/neo_gallery/get_settings` | 读取素材设置 |
| POST | `/neo_gallery/upload_txt` | 上传配套 `.txt` 描述 |
| POST | `/neo_gallery/copy_to_input` | 复制素材到 `input/` |
| POST | `/neo_gallery/delete` | 删除素材（presets 只读保护） |
| POST | `/neo_gallery/clear_thumbnails` | 清空缩略图缓存 |

- `dir_name=Grid|Character` 走主目录（本地生成结果 + 只读远端预设），首页不注入这两张卡。

## lora_tag.py — LoRA 打标

仅可写来源（Input / 用户自定义目录）的叶子图片目录可用；HEIC / HEIF 转换依赖可选的 `pillow-heif`。

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/tag_preflight` | 目录校验 + 图片数 + 建议触发词 |
| POST | `/neo_gallery/tag_dir` | 批量打标（SSE 进度，可选先标准化目录） |

## gallery_lora.py — Civitai LORA

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/lora_dirs` | `models/loras` 第一级子目录列表 |
| POST | `/neo_gallery/civitai_test` | Civitai 连通性 / API KEY 探测 |
| GET | `/neo_gallery/lora_cache_status` | LORA 缓存队列状态 |
| POST | `/neo_gallery/lora_retry_failed` | 重试失败项 |

## gallery_oss.py — 云端预设

`index.json` 顶层可选的 `categories` 把远端目录归到 StoryBoard / CharacterSheet 主目录的只读预设区；
未归类的目录仍留在旧版 **Cloud Presets**（没有 `categories` 的旧索引行为不变）。
预设下载缓存在 `output/StoryBoard/presets/`、`output/CharacterSheet/presets/`。

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_gallery/sync_oss` | 同步 OSS 预设索引 |
| GET | `/neo_gallery/oss_status` | OSS 同步状态 |

## recipes.py — `/rs_recipes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_recipes/list` | 配方列表（custom / presets，按最近修改倒序） |
| POST | `/rs_recipes/load` | 读取单个配方 |
| POST | `/rs_recipes/save` | 保存配方（含 assets 收集） |
| POST | `/rs_recipes/append_results` | 追加示例结果（含工作流备份） |
| POST | `/rs_recipes/add_results` | 记录产物路径到 `results`（不复制文件） |
| POST | `/rs_recipes/delete_result` | 摘掉结果并删除 output 里的真实文件 |
| POST | `/rs_recipes/delete_sample` | 删除示例结果 |
| POST | `/rs_recipes/delete` | 删除配方（仅 custom） |
| POST | `/rs_recipes/copy` | 复制为新 custom 副本（自动改名） |
| GET | `/rs_recipes/export` | 导出配方 zip（包内附 Readme.txt） |
| POST | `/rs_recipes/import` | 导入配方 zip（重名自动改名） |
| GET | `/rs_recipes/asset` | 配方资源文件 |
| GET | `/rs_recipes/thumbnail` | 封面 / 网格缩略图（带缓存） |
| GET | `/rs_recipes/workflow` | 示例对应的工作流快照 |
| POST | `/rs_recipes/send_to_workflow` | 资源复制进 `input/` 供一键还原 |
| GET | `/rs_recipes/director_spec` | 导演配方 `{shared, segments}` 与身份参考图 |
| POST | `/rs_recipes/director_generate_segments` | 文字故事板 → 分段 JSON |
| POST | `/rs_recipes/director_optimize_prompts` | 单段提示词按 H3 格式重写 |
| POST | `/rs_recipes/grid_split` | 宫格分镜图拆分为各段首帧 |
| POST | `/rs_recipes/director_describe_panel` | 逐格描述生成单段成品提示词 |
| POST | `/rs_recipes/director_modify_segment` | 按修改指令重写段提示词（SSE） |

## h3_video_director.py / h3_segment.py / h3_assemble.py — `/neo_video_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_video_gen/director_progress` | director 运行进度（段 / 步） |
| POST | `/neo_video_gen/director/cancel` | 取消进行中的 director 任务 |
| POST | `/neo_video_gen/run_segment` | 单段生成 / 重生成入队 |
| GET | `/neo_video_gen/run_segment/{task_id}` | 单段任务快照 |
| POST | `/neo_video_gen/run_segment/{task_id}/cancel` | 取消单段任务 |
| POST | `/neo_video_gen/assemble_segments` | 把勾选的段拼回完整成片 |
| GET | `/neo_video_gen/assemble_segments/{task_id}` | 拼接任务快照 |
| POST | `/neo_video_gen/assemble_segments/{task_id}/cancel` | 取消拼接 |
| GET | `/neo_video_gen/settings` | 读取「生视频模型」设置 |
| POST | `/neo_video_gen/settings` | 保存「生视频模型」设置 |
| GET | `/neo_video_gen/models` | 扫描 H3 模型并给出自动挑选结果 |

- `run_segment` 只做校验 + 组装 prompt + 入队，真正生成跑在 ComfyUI 执行器里（`NeoH3SegmentRun` 节点）：
  显存、进度、取消由执行器负责，插件只轮询任务快照。产物写 `output/neo_director_regen/` 并记进配方 `results`。
- 锚点来源由 `film` 指定（空 = 最新成片），**分辨率沿用该成片**（同尺寸才能无缝拼回）。
  段序号越界 / 未知锚点 / 成片帧数与复算不一致 / 预设配方一律 400。
- `assemble_segments` 是单段生成的后续步骤：只把勾选的段换成单段产物，其余段沿用原成片对应帧与音频。
  它只做解码 → 拼接 → 再编码，不用模型、不占执行队列，在后台线程跑，取消为协作式。
  新成片写 `output/neo_director_merge/`，记进 `results` 时带逐段真实帧数 `layout`，
  后续单段重生成按它定位段边界。
- 采样期间的实时预览走插件自己的 taeh3 通道（WS 事件 `rs.h3.preview`），按 `node_id` 推回对应节点面板。

## studio.py — `/neo_studio/*`

Neo Studio 独立页面（`web/studio/index.html`）的后端。素材 / 生图 / 配方 / 单段直接复用已有路由，
这里只补页面短路径、整片生成与版本信息：

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo-studio` | Studio 独立页面 |
| POST | `/neo_studio/director/generate` | 整片生成入队（可只跑勾选的段） |
| GET | `/neo_studio/director/{task_id}` | 整片任务快照 |
| POST | `/neo_studio/director/{task_id}/cancel` | 取消整片任务 |
| GET | `/neo_studio/version` | 插件 / ComfyUI 版本与导演配方列表 |
| POST | `/neo_studio/clear_memory` | 卸载模型并清理显存缓存 |

- `only_segments` 为只读时间轴上勾选的段号文本（1 基、逗号分隔，空 = 整片）；勾选是运行期临时状态，不写进配方。
- 任务跟踪与 `run_segment` 同一套做法：入队 + 轮询快照 + WS 事件按变化推送。

## workflow.py — `/neo_nodes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_nodes/repair` | 工作流模型路径修复 |
| GET | `/neo_nodes/repair_mappings` | 读取已保存的修复映射 |
| DELETE | `/neo_nodes/repair_mappings` | 删除修复映射 |

修复细节见 [workflow-repair.md](workflow-repair.md)。

## image_gen.py — `/neo_image_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_image_gen/settings` | 读取内置生图默认参数 |
| POST | `/neo_image_gen/settings` | 保存默认参数 |
| GET | `/neo_image_gen/models` | 扫描模型目录并给出自动挑选结果 |
| POST | `/neo_image_gen/generate` | 生图入队（可带单次覆盖参数 / 扩图） |
| GET | `/neo_image_gen/status/{task_id}` | 任务快照（进度 / 图片 / 实时预览） |
| GET | `/neo_image_gen/tasks` | 最近任务列表（最多 32 条） |
| POST | `/neo_image_gen/cancel/{task_id}` | 出队并在运行中时中断 |
| GET | `/neo_image_gen/skill_dims` | 技能预设宽高与步数（填默认值用） |
| GET | `/neo_image_gen/skill_config` | 读取技能生图 / 生视频设置 |
| POST | `/neo_image_gen/skill_config` | 写技能设置（预设写本地覆盖文件） |
| GET | `/neo_image_gen/skill_workflow` | 技能 `workflow.json` 模板（只读） |
| POST | `/neo_image_gen/update_workflow_skill` | 把画布工作流回写为技能模板 |
| POST | `/neo_image_gen/save_combo_skill` | 主模型 + LoRA 组合存为新技能 |

- `generate` 的 body 可带单次覆盖 `model` / `text_encoder` / `vae` / `loras`（空 = 跟随全局设置）；
  扩图请求带 `outpaint` 字段，见 [image-gen.md](image-gen.md)。
- 任务状态不走 HTTP 轮询：按变化经 WS 事件 `rs.image_gen.status` 推送任务快照，
  `/status` 仅作订阅前首拉与断线重连补漏，取消时后端也主动推送 `cancelled` 快照。

## prompts.py — `/rs_prompts/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_prompts/save_prompt` | 保存提示词预设 |
| POST | `/rs_prompts/list_prompts` | 提示词列表（含配方条目） |
| POST | `/rs_prompts/load_prompt` | 读取提示词 |
| POST | `/rs_prompts/list_prompt_lines` | 提示词行级列表 |
| POST | `/rs_prompts/delete_prompt` | 删除提示词 |
| GET | `/rs_prompts/get_models` | 可用 LLM 模型列表（远程 + 本地） |
| GET | `/rs_prompts/native_models` | 原生文本生成模型列表（扫描 `models/text_encoders/` 下 `.safetensors`） |
| POST | `/rs_prompts/set_model` | 切换当前 LLM 模型 |
| GET/POST | `/rs_prompts/remote_llm_config` | 远程 LLM 配置读取 / 保存 |
| POST | `/rs_prompts/llm_connection_test` | 连接测试（远程用当前表单值发送「你好」；Native 实跑一次本地推理） |
| GET | `/rs_prompts/llm_mode` | 当前 LLM 模式 |
| POST | `/rs_prompts/extract_title` | AI 提取标题 |
| POST | `/rs_prompts/extract_classify` | AI 提取分类 |
| POST | `/rs_prompts/enhance_prompt` | 提示词增强 |
| POST | `/rs_prompts/translate_prompt` | 提示词翻译 |
| POST | `/rs_prompts/smart_prompt` | 快捷描述生成 |
| POST | `/rs_prompts/reverse_prompt` | 图片反推（SSE + 同名 .txt 缓存） |
| POST | `/rs_prompts/stream_{task_name}` | 按任务名注册的流式生成端点 |
| POST | `/rs_prompts/stream_generate_prompt` | 流式生成 |
| POST | `/rs_prompts/random_prompt` | 随机提示词 |
| POST | `/rs_prompts/random_prompts` | 运行时随机批量抽条（1–16） |
| POST | `/rs_prompts/fetch_remote_models` | 拉取远程服务端模型列表 |
| GET | `/rs_prompts/skills` | 技能列表（预设 / 任务 / 自定义分组） |
| POST | `/rs_prompts/load_skill` | 读取单个技能 |
| POST | `/rs_prompts/save_skill` | 新建 / 更新技能主文件（预设只读） |
| POST | `/rs_prompts/delete_skill` | 删除整个技能目录（仅 USR） |
| POST | `/rs_prompts/reset_skill_config` | 技能设置恢复默认（删本地覆盖文件） |

- `fetch_remote_models` 请求带 `provider`，`api_key` 留空时回退该 provider 已存密钥。
  本地 / 局域网端点先依次尝试 LM Studio、Ollama 原生端点，没有结果再按 OpenAI 兼容 `/v1/models` 尝试。
- `skills` 里的生图 / 生视频技能另带可选 `gen_config` 摘要（主模型、LoRA 名列表、长边尺寸、默认比例、步数），
  全空时不附该字段。
- `load_skill` 返回正文、附属 `.md` 清单、`max_tokens`、生图 / 生视频标记、视频模式、参考图要求、
  是否存在本地配置覆盖。
- `save_skill` 校验名称唯一性（与其它技能重名返回 409）；可选字段缺省沿用 frontmatter 既有值，显式假值移除该字段。

LLM 模式与配置见 [llm.md](llm.md)，技能设计见 [skills.md](skills.md)。

## model_hub.py — `/neo_model_hub/*`

模型库（Comfy-Org 专区 · ModelScope / Hugging Face 双源搜索与断点续传下载），细节见 [model-hub.md](model-hub.md)。

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_model_hub/settings` | 设置 + 策展注册表 + 落盘类别 + 可用源 |
| POST | `/neo_model_hub/settings` | 保存设置（源 / 端点 / Token / LLM 子目录 / 超时，写入前清洗） |
| POST | `/neo_model_hub/repos` | 仓库列表（双源并集 + 注册表补齐，带 `query` 时叠加跨组织搜索） |
| POST | `/neo_model_hub/files` | 仓库文件清单（过滤非模型文件，附类别 / 文件名 / 已存在标记） |
| POST | `/neo_model_hub/subfolders` | 类别落盘目录下已有子目录列表 + 默认子目录自动探查 |
| POST | `/neo_model_hub/download` | 启动下载（单任务，`.part` + HTTP Range 续传） |
| GET | `/neo_model_hub/progress` | 当前下载快照（进度 / 速度 / 状态） |
| POST | `/neo_model_hub/cancel` | 取消进行中的下载（保留断点） |

- 仓库列表与文件清单走服务端缓存（15 / 10 分钟），请求带 `refresh: true` 跳过缓存。
- ModelScope 组织列表与跨组织搜索走匿名 `dolphin/models` 接口；接口失败时按注册表逐仓库探测存在性（缓存 1 天）。
- 源侧失败返回带 `code` 的错误：`need_token`（401）、`busy`（409）、`not_on_source`（404，附 `other_source` 建议换源）。
