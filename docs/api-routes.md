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
| POST | `/rs_recipes/add_results` | 记录执行产物**路径**到 `results`（只记路径不复制文件，按 filename+subfolder 去重；预设 403） |
| POST | `/rs_recipes/delete_result` | 从 `results` 摘掉一条并**删除 output 目录里的真实文件**（连同同名 `.txt` 旁车；非法路径 400，预设 403） |
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

## h3_video_director.py / h3_segment.py / h3_assemble.py / video_gen.py — `/neo_video_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_video_gen/director_progress` | 当前 director 运行进度（`active` / `segment_index` / `total_segments` / `step` / `total_steps`），节点内时间轴与预览面板按它显示每段状态 |
| POST | `/neo_video_gen/run_segment` | **单段生成/重生成入队**（`{recipe, segment, anchors, seed, film?, continuity?, context_frames?, steps?, preview?, node_id?}`）：校验 + 把「跑这一段」组装成单节点 prompt（`NeoH3SegmentRun`）提交到 ComfyUI 执行队列，返回任务快照。`film` 指定用哪个成片结果取锚点（文件名或 `subfolder/文件名`；空＝最新成片），不在配方 `results` 里则报错；**分辨率沿用该成片**（同尺寸才能无缝拼回，与配方共享分辨率不同时在提示里说明）；段序号越界 / 未知锚点 / 成片帧数与复算不一致 / 预设配方 一律 400 |
| GET | `/neo_video_gen/run_segment/{task_id}` | 单段任务快照：`status`（queued/running/succeeded/failed/cancelled）+ `progress {value,max}` + `filename` + `film`（实际用作锚点来源的成片）+ `seed` + `warnings` + `error` |
| POST | `/neo_video_gen/run_segment/{task_id}/cancel` | 取消单段任务：未执行则出队、执行中则中断（同生图任务做法）；任务已结束 409 |
| POST | `/neo_video_gen/assemble_segments` | **拼回成片**（`{recipe, use:[段序号], film?, blend?, continuity?, context_frames?}`）：把勾选的段换成对应的单段产物、**其余段沿用原成片**（解码→拼接→再编码），产出新的完整成片；返回任务快照。片段缺 / 段序号越界 / 没勾任何段 / 预设配方 一律 400 |
| GET | `/neo_video_gen/assemble_segments/{task_id}` | 拼接任务快照：`status`（queued/running/succeeded/failed/cancelled）+ `progress {value,max}` + `stage`（中文阶段）+ `filename` + `frames` + `clips` + `warnings` + `error` |
| POST | `/neo_video_gen/assemble_segments/{task_id}/cancel` | 取消拼接（协作式：当前片段处理完后生效）；任务已结束 409 |
| GET | `/neo_video_gen/settings` | 读取「生视频模型」独立设置（`configs/video_gen.json`） |
| POST | `/neo_video_gen/settings` | 保存「生视频模型」设置 |
| GET | `/neo_video_gen/models` | 扫描 H3 相关模型列表（diffusion_models / text_encoders / vae）并给出自动挑选结果 |

`run_segment` 只做「校验 + 组装 prompt + 入队」，真正的生成跑在 ComfyUI 执行器里（`h3_segment.py` 的 `NeoH3SegmentRun` 节点）：
显存（模型装载/卸载、OOM 腾挪）、进度条、`interrupt` 取消全部由执行器负责，插件只轮询任务快照。采样期间的实时预览仍走
插件自己的 taeh3 通道（`rs.h3.preview`）：带 `node_id` 时把预览推回该编号的节点面板（编辑器里点 ♻ 即导演节点），
不带则回落到该节点自己的 `unique_id`。产物写 `output/neo_director_regen/<配方>_s<N>_<时间戳>.mp4` 并记进配方 `results`（带 `segment`/`seed`）。

`assemble_segments`（`h3_assemble.py`）是「单段生成」的**后续步骤**（不是独立入口）：只把勾选的那几段换成单段产物，
其余段直接沿用原成片对应帧与音频。它只做「解码 → 拼接 → 再编码」，不用模型、不占执行队列，所以在后台线程里跑：
进度按「已拼帧数 / 总帧数」上报（`stage` 是中文阶段，如「沿用原成片第 1..1 段（124 帧）」），取消是协作式的（当前来源处理完生效）。
新成片写 `output/neo_director_merge/<配方>_merged_<时间戳>.mp4`，并记进配方 `results` 时带 **`layout`**（逐段的真实保留帧数）——
后续「单段重生成」按这个 `layout` 定位该成片的段边界（没有 `layout` 的成片按配方复算并要求总帧数吻合）。

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

