# 后端 API 路由

路由通过 `PromptServer.instance.routes` 注册。总入口见 [../Developer.md](../Developer.md)。

## gallery.py — `/neo_gallery/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/list` | 目录内容列表（预设/自定义/系统目录聚合） |
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

## gallery_lora.py — Civitai LORA

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/lora_dirs` | `models/loras` 第一级子目录列表 |
| POST | `/neo_gallery/civitai_test` | Civitai 连通性 / API KEY 探测 |
| GET | `/neo_gallery/lora_cache_status` | LORA 缓存队列状态 |
| POST | `/neo_gallery/lora_retry_failed` | 重试失败项 |

## gallery_oss.py — 云端预设

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_gallery/sync_oss` | 同步 OSS 预设索引 |
| GET | `/neo_gallery/oss_status` | OSS 同步状态 |

## recipes.py — `/rs_recipes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_recipes/list` | 配方列表（custom / presets，组内按最近修改时间倒序） |
| POST | `/rs_recipes/load` | 读取单个配方 |
| POST | `/rs_recipes/save` | 保存配方（含 assets 收集） |
| POST | `/rs_recipes/append_results` | 追加示例结果（含工作流备份） |
| POST | `/rs_recipes/delete_sample` | 删除示例结果 |
| POST | `/rs_recipes/delete` | 删除配方（仅 custom） |
| POST | `/rs_recipes/copy` | 复制配方为新的 custom 副本（自动生成不冲突名 `<原名>-copy/-2/…`，含资源/示例/director 分段；preset 亦可复制成 custom） |
| GET | `/rs_recipes/asset` | 配方资源文件 |
| GET | `/rs_recipes/workflow` | 示例对应的工作流快照 |
| POST | `/rs_recipes/send_to_workflow` | 资源复制进 `input/` 供一键还原 |
| GET | `/rs_recipes/director_spec` | 读取 `video_director` 配方的 `{shared, segments}`（每段首帧/尾帧与参考图·视频·音频均已解析为 input 名，并给出有效生成模式 `mode`） |
| POST | `/rs_recipes/director_generate_story` | 导演编辑器：主题 + 可选角色/背景参考 → LLM 生成完整故事脚本 |
| POST | `/rs_recipes/director_split_segments` | 导演编辑器：已确认故事按目标秒数拆分场景并（结合角色/背景）重生成每段提示词，返回 `segments[]` |
| POST | `/rs_recipes/director_optimize_prompts` | 导演编辑器「统一设置」：各段优化前原文 + 模式 + 统一参考清单 → LLM 按 H3 官方格式逐段重写（附参考图走多模态），返回数量与分段数一致的 `prompts[]` |

## workflow.py — `/neo_nodes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_nodes/repair` | 工作流模型路径修复（高置信度匹配 + 阈值档位 `threshold` + 动态 widget 引用 `widget_refs` + 手动决策（含 `skip`）+ 映射） |
| GET | `/neo_nodes/repair_mappings` | 读取已保存的修复映射 |
| DELETE | `/neo_nodes/repair_mappings` | 删除修复映射 |

## image_gen.py — `/neo_image_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_image_gen/settings` | 读取内置生图默认参数（`configs/image_gen.json`，缺失时回落内置值） |
| POST | `/neo_image_gen/settings` | 保存默认参数（仅接受 `DEFAULT_SETTINGS` 里的键） |
| GET | `/neo_image_gen/models` | 扫描 `diffusion_models` / `text_encoders` / `vae` / `loras`（各列表按 krea2 相关靠前排序供展示）并给出自动挑选结果（含 `suggested_lora` = 建议的四视图 LoRA） |
| POST | `/neo_image_gen/generate` | 解析请求 → 构建 Krea2 API 图 → 提交执行队列，返回任务快照（含 `task_id`）；参数错误 400 |
| GET | `/neo_image_gen/status/{task_id}` | 任务快照（兜底拉取）：`queued` / `running` / `succeeded` / `failed` / `cancelled` + 图片列表、采样进度 `progress`（仅运行中且全局 registry 命中本 prompt 时非空）、错误、告警 |
| GET | `/neo_image_gen/tasks` | 最近任务列表（按创建时间倒序，最多 32 条） |
| POST | `/neo_image_gen/cancel/{task_id}` | 出队并在运行中时中断该任务 |
| GET | `/neo_image_gen/skill_dims` | 返回 gen_image skill 的预设宽高（`base_resolution` + `default_ratio`，与节点 `width`/`height=-1` 时一致），供 NeoKrea2Generate widget 填充默认值（定义于 krea2_generate.py） |
| GET | `/neo_image_gen/skill_config?skill_id=` | 读取技能生图/生视频设置：预设 = 自身 `config.json` ⊕ 本地覆盖文件（`configs/skill_overrides/<id>.json`），其余直接读 `config.json` |
| GET | `/neo_image_gen/skill_workflow?skill_id=` | 返回技能 `workflow.json`（API prompt 模板，只读），供详情弹窗渲染节点流程图；缺失/非法 404 |
| POST | `/neo_image_gen/skill_config` | 写技能生图/生视频设置（`{skill_id, config}`）：自定义写自身 `config.json`，预设写本地覆盖文件（不改预设文件）；保存时 `width`/`height`/`length`/`steps` 保留既有有效值（非模型设置区管理，视频技能「步数」由此落盘） |

任务状态不走 HTTP 轮询：`_watch` 协程按变化经 WebSocket 事件 `rs.image_gen.status` 推送任务快照（广播，前端 `watchTask` 按 `task_id` 过滤）；`/status` 仅作订阅前兜底首拉与断线重连补漏，取消时后端也主动推送 `cancelled` 快照。

## prompts.py — `/rs_prompts/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_prompts/save_prompt` | 保存提示词预设 |
| POST | `/rs_prompts/list_prompts` | 提示词列表（含配方条目） |
| POST | `/rs_prompts/load_prompt` | 读取提示词 |
| POST | `/rs_prompts/list_prompt_lines` | 提示词行级列表 |
| POST | `/rs_prompts/delete_prompt` | 删除提示词 |
| GET | `/rs_prompts/get_models` | 可用 LLM 模型列表（远程 + 本地） |
| POST | `/rs_prompts/set_model` | 切换当前 LLM 模型 |
| GET/POST | `/rs_prompts/remote_llm_config` | 远程 LLM 配置读取 / 保存 |
| POST | `/rs_prompts/llm_connection_test` | 连接测试：用当前表单值发送「你好」，成功返回回复摘要 |
| GET | `/rs_prompts/llm_mode` | 当前 LLM 模式 |
| POST | `/rs_prompts/extract_title` | AI 提取标题 |
| POST | `/rs_prompts/extract_classify` | AI 提取分类 |
| POST | `/rs_prompts/enhance_prompt` | 提示词增强 |
| POST | `/rs_prompts/translate_prompt` | 提示词翻译 |
| POST | `/rs_prompts/smart_prompt` | 快捷描述生成 |
| POST | `/rs_prompts/reverse_prompt` | 图片反推提示词（多模态） |
| POST | `/rs_prompts/stream_{task_name}` | 按任务名动态注册的流式生成端点 |
| POST | `/rs_prompts/stream_generate_prompt` | 流式生成 |
| POST | `/rs_prompts/random_prompt` | 随机提示词 |
| POST | `/rs_prompts/fetch_remote_models` | 拉取远程服务端模型列表（请求带 `provider`；`api_key` 留空时回退该 provider 已存密钥，端点按 provider 的 `append_v1` 规则拼接） |
| GET | `/rs_prompts/skills` | 技能列表（预设 + 任务 + 自定义分组）；生图/生视频技能另带可选 `gen_config` 摘要对象（有效 config.json 的非空子集：`model` 主模型、`loras` LoRA 名列表、`base_resolution` 长边尺寸、`default_ratio` 默认比例、`steps` 采样步数），全空时不附该字段 |
| POST | `/rs_prompts/load_skill` | 读取单个技能（正文、附属 .md 文件清单、max_tokens、gen_image 生图标记、gen_video 生视频标记、mode 视频模式、requires_ref 参考图要求、config_overridden 预设是否存在本地配置覆盖） |
| POST | `/rs_prompts/save_skill` | 新建/更新技能主文件 skill.md（预设只读）；可选 `multi_turn` / `category` / `gen_image` / `gen_video` / `mode` / `requires_ref` 字段，缺省沿用 frontmatter 既有值，显式假值移除该字段（「复制为自定义」靠这些字段保留生图/生视频分类、视频模式与设置区）；**名称唯一性校验**：name 与其它 skill 重复时返回 409 |
| POST | `/rs_prompts/delete_skill` | 删除整个技能目录（仅 USR） |
| POST | `/rs_prompts/reset_skill_config` | 预设技能生图/生视频设置恢复默认：删除本地覆盖文件 `configs/skill_overrides/<id>.json`（幂等，无覆盖也成功） |

