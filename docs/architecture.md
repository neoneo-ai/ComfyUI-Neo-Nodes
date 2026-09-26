# 架构与模块

项目结构、前后端模块职责、节点注册与数据目录。总入口见 [../Developer.md](../Developer.md)。

## 项目结构

```
ComfyUI-Neo-Nodes/
├── __init__.py             # 插件入口：导入后端模块注册 API 路由，合并节点映射，声明 WEB_DIRECTORY
├── prompts.py              # 提示词节点核心逻辑（NeoPromptEncoder / NeoPromptAgent）+ /rs_prompts/* API
├── llm.py                  # LLM 推理：远程 API（OpenAI 兼容 / 国产云供应商 / LM Studio / Ollama / OpenRouter）与本地 llama.cpp GGUF
├── gallery.py              # Neo Gallery 素材后端 + /neo_gallery/* 路由
├── gallery_lora.py         # Civitai LORA 示例后台抓取 + lora_cache 管理
├── gallery_oss.py          # 云端预设（OSS）素材同步
├── recipes.py              # 配方后端 + /rs_recipes/* 路由
├── workflow.py             # 工作流模型路径修复逻辑 + /neo_nodes/repair* 路由
├── image_gen.py            # 内置生图后端：Krea2 工作流构建 + 队列提交/状态事件推送 + /neo_image_gen/* 路由
├── krea2_edit.py           # Krea2 以图生图核心节点（vendor 自 comfyui-krea2edit）：ModelPatch + GroundedEncode
├── image_gen_edit.py       # 生图/编辑节点 NeoImageGenEdit（V3 + Autogrow 参考图）：mini-executor 进程内执行 skill workflow 模板，输出 IMAGE 张量
├── prompt_lines.py         # 提示词文本行解析（预设列表行 / 随机候选）
├── util.py                 # 媒体扩展名常量与共享工具（媒体探测、元数据、提示词文本收集）
├── requirements.txt        # Python 依赖（requests / Pillow / PyYAML）
├── pyproject.toml          # ComfyUI Registry 发布元数据（[tool.comfy]）
├── pytest.ini              # 测试配置（testpaths = tests）
├── configs/                # 运行时配置
│   ├── remote_llm_config.json  # 远程 LLM 配置（按 provider 分槽；.gitignore 不入库）
│   ├── oss_presets.json        # OSS 预设素材源配置
│   ├── image_gen.json          # 内置生图默认参数（保存设置后生成；.gitignore 不入库）
│   ├── gallery_settings.json   # 画廊自定义目录与 Civitai 设置（API KEY 脱敏显示；.gitignore 不入库）
│   └── bookmarks.json          # 本地收藏：仅存路径信息，不复制文件（.gitignore 不入库）
├── locals/                 # 本地化资源（zh_CN.json）
├── prompts/                # 提示词目录
│   ├── presets/            # 内置提示词预设（.txt，含 collections/、video/ 子集）
│   └── custom/             # 用户自定义提示词（.gitignore 不入库）
├── skills/                 # 技能（Markdown skill.md + YAML frontmatter）
│   ├── presets/            # 内置提示词技能（SYS，<id>/skill.md：图像/视频提示词增强、任务等）
│   ├── tasks/              # 内置任务技能（extract_title / reverse_prompt 等，<id>/skill.md）
│   └── custom/             # 用户自定义技能（USR，<id>/skill.md，.gitignore 不入库）
├── gallery/                # 素材媒体文件目录
│   ├── presets/            # 内置预设素材
│   ├── custom/             # 用户上传素材
│   ├── lora_cache/         # Civitai LORA 示例缓存（.gitignore 不入库）
│   ├── oss_cache/          # 云端预设缓存（.gitignore 不入库）
│   └── thumbnails/         # 缩略图缓存（.gitignore 不入库）
├── recipes/                # 配方目录（每配方一个文件夹 + recipe.json + assets/）
│   ├── custom/             # 用户配方（.gitignore 不入库）
│   └── presets/            # 内置预设配方
├── tools/                  # 离线工具脚本
│   ├── gallery_preprocess.py   # 预设预处理：生成缩略图 + index.json（--dirs 增量模式自动从 OSS 拉取最新 index 合并，--category 指定目录归入 grid/character/presets）
│   └── gallery_deploy_oss.py   # 部署预处理产物到 OSS
├── tests/                  # pytest 单元测试 + JS 测试运行器
│   ├── run-tests.ps1       # JS 测试运行器（带超时强制终止，pwsh tests/run-tests.ps1）
│   ├── test_llm.py         # LLM 配置/下载/缓存/语言检测/文本规范化
│   ├── test_skills.py      # 技能扫描、图片解码、多结果解析
│   ├── test_workflow_repair.py # 工作流修复匹配算法
│   └── js/                 # 前端回归测试（node:test + jsdom，golden 快照）
├── web/                    # 前端资源（WEB_DIRECTORY）
│   ├── gallery.js          # 素材侧边栏主逻辑（状态/持久化/API/视图切换/收藏视图数据）
│   ├── gallery-list.js     # 列表浏览层：工具条与面包屑、视图渲染管线、滚动分页与封面懒加载、滚动位置记忆、灯箱导航媒体聚合
│   ├── gallery-card.js     # 单卡片内容与交互：目录卡封面、缩略图卡、发送/收藏菜单、灯箱适配（提示词侧栏/反推/导入工作流）
│   ├── gallery-gen.js      # 一键生图（角色图/九宫格分镜图）：Qwen Image 2.1 请求体 + 前置小窗 + ⋯菜单生图入口
│   ├── gallery-setting.js  # 目录管理配置弹窗（自定义目录/OSS/Civitai 同步）
│   ├── gallery-utils.js    # 素材工具函数
│   ├── gallery.css
│   ├── lightbox.js         # 灯箱查看器
│   ├── lightbox.css
│   ├── node-behavior.js    # 节点拖拽/粘贴等交互行为
│   ├── combo-box.js        # 通用下拉组件
│   ├── recipes.js          # 配方逻辑（保存/复制/面板/一键发送）
│   ├── recipes.css
│   ├── director.js         # 多段视频导演编辑器（配方编辑窗口）：shared 分辨率 + 逐段 skill/提示词/首帧/时长 + 半自动故事生成/拆分；时间轴复用 director-timeline.js
│   ├── director-node.js    # NeoH3VideoDirector 节点内嵌只读时间轴 + 采样实时预览面板（rs.h3.preview 载荷，自动循环/暂停/逐帧/逐步）；recipe combo 走技能选择窗（无工具栏），预览卡显示焦点配方只读时间轴（节点内嵌同款组件）
│   ├── workflow.js         # 工作流修复（请求 + 确认弹窗 + 修复映射 + 顶栏按钮）
│   ├── prompts.js          # 提示词节点前端交互
│   ├── prompts.css
│   ├── prompt-manager.js   # 提示词管理器（预设列表 / 集合视图 / 保存与删除；聊天区由 llm-chat.js 提供）
│   ├── llm-chat.js         # LLM 聊天域：输入框与提示语轮播、输出区 Markdown 预览、工具条、技能下拉、附加图片 chips、✨/Enter 生成（SSE 流式）
│   ├── at-picker.js        # `@` 图片选择器：扫描工作流 Load Image 节点，弹层跟随光标，点击/回车插入 <Picture N> 标记
│   ├── slash-picker.js     # `/` 技能快捷菜单：输入 / 唤起并实时过滤 skill（name/id），↑/↓ + Enter/Tab 提交写入技能下拉
│   ├── prompt-service.js   # 提示词 API 服务封装
│   ├── llm-setting.js      # LLM 配置表单（provider/模型/API key/本地目录），挂入自动增强菜单
│   ├── image-gen.js        # 生图（Krea2）客户端：/neo_image_gen/* 包装、任务事件等待（rs.image_gen.status）、四视图模板、结果发送到 LoadImage、生图设置表单
│   ├── dom-utils.js        # 共享 DOM 工厂 mkEl()
│   ├── workflow-graph.js   # 技能工作流模板（API prompt）只读 SVG 流程图：拓扑分层布局 + 模板变量预替换 + LoRA 运行时注入镜像 + /object_info·/models 校验高亮
│   └── skill.js            # 技能模块：skill API + createSkillDetailPopup()（单技能详情弹窗）+ createSkillDropdown()（技能下拉组装：底部管理工具栏 / 行内操作 / zip·目录上传）
└── .github/workflows/
    └── publish.yaml        # 发布 ComfyUI Registry 的 GitHub Action
```

## 后端模块

| 模块 | 职责 |
|------|------|
| `__init__.py` | 插件入口。导入 `gallery` / `recipes` / `workflow` / `image_gen` 模块以注册各自的 API 路由，从 `prompts.py` 合并 `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`（含 `krea2_edit` 的两个节点与 `image_gen_edit` 的 NeoImageGenEdit；若用户已安装外部 comfyui-krea2edit 则跳过以免重复注册），声明 `WEB_DIRECTORY = "./web"` |
| `prompts.py` | 两个提示词节点（`NeoPrompts` → Neo Prompt Encoder，`NeoPromptAgent` → Neo Prompt Agent）与 `/rs_prompts/*` 路由：预设提示词 CRUD、LLM 模型切换、图片解析（`resolve_image_bytes`）、标签索引 |
| `ref_grid.py` | 参考图宫格节点 `NeoRefGrid`：隐藏 `refs` widget（JSON 文件名数组，前端宫格槽位）+ 隐藏 `prompt_text` → `prompt` + 运行时 `BUNDLE`（提示词 + 参考图 data URI，复用 `bundles.create_bundle`）+ `image_1..image_12`。宫格按槽位还原（坏文件保位空缺），总数上限 `GRID_MAX`=12（槽位数 1~12 由前端运行时调整，不持久化） |
| `skill.py` | 技能系统：Markdown + YAML frontmatter 解析（PyYAML 事件流）、`skills/{presets,tasks,custom}/<id>/skill.md` 扫描与加载（`scan_skills` / `load_skill_content` / `load_task_template`）、多结果契约读取、语言互斥主文件选择（`SKILL.md`/`SKILL.cn.md`）与按需引用加载的工具调用代理循环（`run_skill_agent[_stream]` / `read_skill_file`，仅运行时惰性导入 llm 原语以避免与 llm.py 的顶层依赖形成循环）、工作流上下文格式化（`_format_workflow_context`，H3 节点块委托 minimax_h3）、`audit: h3` 技能的生成后审计接入（调用 minimax_h3 的 `_h3_audit_and_repair` / `_h3_audit_events`，流式路径以 status/replace 事件上报自检与修复阶段）、`/rs_prompts/skill*` 路由（列表/读取/保存/删除/上传） |
| `minimax_h3.py` | MiniMax H3 特定逻辑：生成模式判定（`_h3_mode`，T2VA/I2VA/FL2VA/L2VA/Reference）与各模式最终 grounding 约束（`_h3_grounding_check`）、skill 正文条件段落裁剪（`_filter_mode_sections`，`<!-- @if TOKENS -->` 的 token 为生成模式 + H3 节点已连参考媒体类型）、工作流上下文 H3 节点块格式化（`format_h3_context_lines`）、`audit: h3` 技能生成后的确定性格式审计与窄修复（`_h3_narrow_repair` / `_h3_audit_and_repair` / `_h3_audit_events`，规则实现在 h3_prompt_audit.py） |
| `h3_prompt_audit.py` | H3 提示词确定性格式审计（纯规则、零 token）：六段/三字段结构顺序、时间戳格式与时长上限、参考标签与工作流连线一致性、对白说话人 ID、内部表示术语泄漏；并提供窄修复消息构造（`narrow_repair_messages`）与修复验收（`repair_acceptable`），供 minimax_h3.py 在 `audit: h3` 技能生成后调用 |
| `video_gen.py` | 生视频（MiniMax H3）全局设置：独立于生图 image_gen.json，落盘 `configs/video_gen.json`；`/neo_video_gen/*` 路由（`/settings` 读写、`/models` 列可选模型与 LoRA 且 H3 相关靠前 `_video_display_sort`）；H3 模型/文本编码器/VAE 自动挑选（`suggest_video_model` 按 h3 名称线索、turbo 优先；`suggest_audio_vae` 需文件名同时含 h3 与 audio） |
| `h3_video_gen.py` | MiniMax H3 视频生成的共享 helper（供 NeoH3VideoDirector 复用，本模块不再注册节点）：`resolve_video_params` 把一次生成请求解析成模板参数——模型/编码器/视频 VAE 走 config→生视频设置→自动挑选；**音频 VAE 单独解析**（config `audio_vae` → 名称线索），模板里 `VAEDecodeAudio` 必须接独立音频 `VAELoader`，不能复用视频 VAE；参考媒体按 media 分图/视频/音频三组并各按上限裁剪。`_gen_video_skills`/`_resolve_skill_id` 列出/反查带 workflow.json 的视频 skill；`_require_vdn_plugin` 校验 VDN 加速插件（未装 ComfyUI-VDN-H3 时报错）。**LoRA 复用生图链路**：skill config.json 的 `loras` 经 `image_gen._resolve_loras` 校验后由 `render_template` 动态串入主链（模板无槽位时在 `UNETLoader → MiniMaxH3SigmaShift` 间插入 `LoraLoaderModelOnly`），视频无「依赖参考图」概念、配置的全部无条件加载 |
| `h3_preview.py` | H3 实时预览：`models/vae_approx/taeh3.safetensors` 是「96 宽 / 4 次上采样」的扁平 2D TAE，核心 `TAESD.Decoder` 建不出来（`MiniMaxH3Video` 也未声明 taesd 解码器），这里按 checkpoint 的扁平索引重建解码器（缺号按位置补 `Clamp`/`ReLU`/`Upsample`）。采样期间**每步沿潜空间时间轴均匀抽 `PREVIEW_FRAMES`(8) 帧**（首尾都取到，音频流按通道数排除）解成真彩图，缩到最长边 `PREVIEW_SIDE`(512) 编成 JPEG **data URL** 序列（前端直接塞 `<img>.src`），经自有 WS 事件 `rs.h3.preview` 推给发起本次执行的客户端（载荷带 `node_id`，前端路由到对应节点内的动画面板；核心一步只出一张静图的预览通道返回 `None` 关掉）。`preview_override` 只在 NeoH3VideoDirector 逐段执行期间替换 `latent_preview.get_previewer`（退出时含异常无条件还原；非 H3 latent format 一律交还原实现），缺 taeh3 或加载失败时回退 Latent2RGB，解码失败只跳过本步，都不影响出片 |
| `h3_video_director.py` | 多段导演节点 `NeoH3VideoDirector`（另注册 `NeoH3AddKeyframe` / `NeoH3AddContext` 供图内注入/手动搭图）：以 `video_director` 配方逐段复用 `_run_segment_graph`（`resolve_video_params` + `render_template` + `execute_graph_inprocess`）生成并拼接为单个含音频 `VIDEO`（BUNDLE 输入时改跑单段；`seed = base_seed + i`）。**跨段上下文窗口**：`continuity` 开时把上段交付帧尾部的 `context_frames` 帧（默认 22）当视频参考注入下一段，下一段重生成这 22 帧后**丢头部 22 帧**（接缝不再有重复帧、新段按上段真实像素开场），窗口帧数按 `17k+5` 就近对齐（124+22=146 → 141，交付 119），并按丢帧数裁音频保 A/V 对齐；`t2v` 段也链入窗口。**身份继承**：第一个带参考素材的段的参考图（≤4 张）领养到后续段（i2v/fl2v/t2v 模板无多路参考槽位，靠注入的图片参考块生效）。**分镜首帧优先**：i2v/fl2v 段自带首帧图时首帧锚点用它（文字编码器也拿到同一张图），上段尾部改走 `context_mode=reference`（目标之前的参考视频，不改时长、不丢帧、不做接缝淡化）。**Tier A 回退**（`context_frames=0`，仅对没自带首帧图的段）：上段尾帧作为下段 i2v/fl2v 首帧（data-URI）并丢该段第一帧。注入节点 `NeoH3AddContext` 串在 H3 conditioning 与采样器之间：窗口帧走虚拟 `LoadImage` + override 喂张量、身份图走 input 目录真实 `LoadImage`，`append` 进 `minimax_refs`（先身份图、后窗口），并返回挂了连续性 wrapper（`WrappersMP.APPLY_MODEL`，key `neo_h3_continuity.apply_model.v1`，同 key 先清再挂）的 `MODEL`——wrapper 在模型调用前把 keyframes 与 refs 合回一条 `cond_video_latents`（core 在两者并存时只留 refs），并修正时间轴（窗口行整体错开一个窗口）：把窗口行拷到目标视频开头的行上（锚点行不动——core 的 `PackedLayout` 已让 refs 先占位、keyframe 锚点从目标原点起算），且保持 `position_ids` 张量本体（Sol-Attn 的 span 注册认它）；`tools/check_h3_context_layout.py` 用真机 core 的 `PackedLayout` 复核这套对齐；`/neo_video_gen/director_progress` 暴露逐段进度供节点内时间轴显示 |
| `llm.py` | LLM 推理层：`RemoteLLMClient`（OpenAI 兼容 HTTP，支持 `tools=` 工具调用）、`LLMSingleton`（进程内 llama.cpp GGUF，含 mmproj 多模态绑定与自动卸载）、远程配置存取（`configs/remote_llm_config.json`，按 provider 分槽）、模型目录扫描（`scan_llm_directory`）、任务模板加载（`skills/` 目录，Markdown + frontmatter）与流式/非流式执行（思考模型把 `reasoning_content` 与正文 `content` 分块打标为 `{"text","kind":"thinking"|"content"}`，流式（远程/本地）按 `STREAM_MIN_MAX_TOKENS` 保底 token）、模式无关的单轮对话原语 `chat_turn`（按当前模式分发本地 llama.cpp / 远程 API，供 skill 代理循环按需调用）；本地 / 局域网端点有效超时抬高到至少 300s 以容纳冷加载（公网不变），模型列表拉取先试 LM Studio `/api/v1/models`、Ollama `/api/tags`+`/api/ps` 原生端点再退回 OpenAI 兼容端点；瞬态失败（408/409/429/5xx/网络中断）由插件层重试一次（SDK 自身重试已禁用），语义性 4xx 立即报错，本地模型不再自动加载（Unsloth 未加载时直接报可操作错误） |
| `gallery.py` | Neo Gallery 素材后端：预设/自定义/系统（input、output）目录聚合浏览、缩略图生成与缓存、媒体文件服务、上传/删除、目录设置（`gallery_settings.json`）。主目录 `Grid` / `Character`（`output/StoryBoard|CharacterSheet/`）经直达入口/深链进入（首页不注入），本地生成结果按日期落在 `<日期>/` 子目录，目录内 `presets/**` 为只读 OSS 预设缓存。导入时加载 `gallery_lora` / `gallery_oss` 以注册其路由 |
| `gallery_lora.py` | Civitai LORA 示例后台抓取队列：打开 Lora 目录时按文件 SHA256 查询并下载示例图 + 提示词 sidecar，缓存于 `gallery/lora_cache/` |
| `gallery_oss.py` | 云端预设（OSS）素材：按 `configs/oss_presets.json` 拉取索引与文件，预设缓存默认落 `gallery/oss_cache/`（`categories` 归到 grid/character 的目录落 `output/StoryBoard|CharacterSheet/presets/`），提供缩略图/媒体回退服务 |
| `recipes.py` | 配方后端：配方 CRUD、assets 资源服务、示例结果追加/删除、工作流快照备份与 `send_to_workflow` 复制 |
| `workflow.py` | 工作流模型路径修复：高置信度匹配算法（`repair_workflow`）、手动修复映射存储（`user/neo_repair_mappings.json`）、`/neo_nodes/repair*` 路由；skill config 失效模型路径建议 `suggest_skill_model_fixes`（复用同一 `match_model_file` 匹配，逐字段返回 status/suggestion/score/candidates）+ `/neo_nodes/skill_model_suggest` 路由 |
| `image_gen.py` | 内置生图后端：把 Krea2 文生图/参考图四视图请求构建为 API prompt，经内部 HTTP `/prompt` 压进执行队列（独立 `client_id`，不干扰前端进度），轮询 history 收集 SaveImage 输出并写同名 `.txt` sidecar；任务记录仅存内存（TTL 1h / 上限 32）。含模型扫描与自动挑选、按比例算尺寸、输出前缀消毒。参考图模式走 `krea2_edit` 路径：`LoadImage` → `ImageScale`（lanczos，长边限 1024px）→ `VAEEncode` 得源 latent 进 `Krea2EditModelPatch`（`fit_mode=fit`，像素空间 AR 适配 + VAE encode，`target_latent` 预编码避免采样中途挤占显存）；positive/negative 均用 `Krea2EditGroundedEncode` 接地到同一张参考图（negative 空指令），目标为 16:9 横版 `EmptySD3LatentImage`（同时接 `KSampler.latent_image` 与 patch 的 `target_latent`），denoise 恒 1.0；prompt = 固定结构指令前缀 + 用户描述；四视图 LoRA 由用户在 LoRA 列表里勾选「依赖参考图」（`ref_only`）标记，参考图模式直接沿用（缺失时按名称线索自动挑选/追加，仍无则报错不降级），文生图跳过 `ref_only` 的 LoRA |
| `krea2_edit.py` | Krea2 以图生图核心节点，vendor 自 comfyui-krea2edit（单文件插件）。`Krea2EditModelPatch`：包装 DIFFUSION_MODEL forward，把序列重建为 `[text \| source(frame=1) \| target(frame=0)]` 只取 target token；`fit_mode=fit` 在像素空间做 AR 适配 + VAE encode（支持 `target_latent` 预编码）。`Krea2EditGroundedEncode`：图像接地指令编码，Qwen3-VL user turn = `<vision: source>` + instruction（训练一致语义路径）。上游活跃开发，修复需整文件同步（对比 `custom_nodes/comfyui-krea2edit/__init__.py`）；用户已装外部插件时由 `__init__.py` 跳过注册 |
| `image_gen_edit.py` | 生图/编辑节点 `NeoImageGenEdit`（V3 节点 + `io.Autogrow` 参考图槽位 `refs.image_1..image_10`，min=0）：按所选 skill 的 `workflow.json` 模板同步生成并输出 IMAGE 张量。进程内 mini-executor（`execute_graph_inprocess`）拓扑执行 `image_gen.render_template` 产出的 API prompt graph——引用解析、hidden 参数注入、跳过 SaveImage/Preview 落盘节点、取末端未被消费的目标类型（默认 IMAGE，H3 视频传 VIDEO）输出；参考图经 `_image_to_data_uri` 转 base64 data URI 复用 `resolve_request` 的 data 分支落盘，保留张数按模板 `{{REF_IMAGE_n}}` 槽位自适应（`image_gen.template_max_refs`），四视图 LoRA 自动挑选只对 Krea2 编辑模板生效（`image_gen.template_uses_krea2_edit`）。不嵌套官方 PromptExecutor（避免进度重置 / 模型清理 / client 状态变更），未知或异步节点明确报错 |
| `prompt_lines.py` | 提示词文本行解析：将预设/合集 .txt 拆为（标题，内容）条目，供预设列表与随机候选使用 |
| `util.py` | 媒体扩展名常量（IMG/VIDEO/AUDIO）与共享工具：目录媒体探测、媒体元数据提取、配方提示词文本收集。独立于路由模块以避免导入循环 |

## 前端资源

`web/` 由 ComfyUI 自动加载（`WEB_DIRECTORY`）：

| 文件 | 职责 |
|------|------|
| `gallery.js` / `gallery-list.js` / `gallery-card.js` / `gallery-gen.js` / `gallery-setting.js` / `gallery-utils.js` / `gallery.css` | 素材侧边栏：目录卡片、懒加载列表、搜索、上传删除、设置弹窗；一键生图（角色图/九宫格分镜图）在 gallery-gen.js |
| `lightbox.js` / `lightbox.css` | 通用灯箱组件：异步 blob 加载、相邻预加载、缩放平移、尺寸显示、`panelProvider` 侧栏钩子；素材与配方通过各自适配接入 |
| `node-behavior.js` | 节点级交互行为（拖拽图片、粘贴、`@` 引用等） |
| `combo-box.js` | 通用下拉选择组件：点击展开/键入过滤覆盖、键盘导航；option 可带 `data-tags`（空格分隔，如中文拼音/首字母缩写）作为附加搜索文本参与过滤（无该属性的下拉不受影响）；`<optgroup>` 渲染为分类标题（无 `data-value`，自动被键盘导航与取值逻辑跳过），过滤时空组隐藏 |
| `recipes.js` / `recipes.css` | 配方侧边栏面板：保存弹窗、卡片（含复制）、详情浮层、一键发送；并导出导演编辑器依赖的 `saveRecipe` / `listVideoSkills` / `scanMediaNodes` / `widgetValueToRef`。收集/还原时经鸭子类型 `_neoRg` API 把 NeoRefGrid 宫格图作为主图片资产（还原先填宫格、其余进 LoadImage，子图无 Neo Prompt 时提示词兜底写宫格） |
| `ref-grid.js` / `ref-grid.css` | NeoRefGrid 节点内宫格 UI：画廊拖入（`application/x-neo-gallery`）/本地批量上传/OS 文件拖入，瓷砖重排、✕ 移除、Lightbox；槽位数 1~12 由工具条 −/+ 运行时调整（默认 9，图更多时自动扩，不持久化）；列数按节点宽度流式排布（CSS `auto-fill/minmax(84px,1fr)`），卡片宽高按图片真实比例自适应（缩略图加载后写 `aspect-ratio`，`object-fit: contain` 保证整图可见）；节点高度经 ResizeObserver 现测内容高 `setSize` 跟随（`getMinHeight` 防手动缩到裁切，同 bundle-expand 模式）；refs 隐藏 widget 为序列化事实源（每次渲染回写），旧工作流经实例 `onConfigure` 钩子回填；输出 autogrow（默认 prompt/BUNDLE/image_1，连线增长到 image_12）；工具条布局：−/+、清空、💾 保存配方在左，素材面板（pi-images 图标，同 Neo Gallery）/本地添加/☰ 加载配方在右；☰ 打开加载配方选择窗（`/rs_recipes/list` 只列普通含图配方，排除多段导演与无图；左列表缩略图 + 右预览封面/图片条/提示词摘要，悬停切换，点击经 `_neoRg.setAssets/setPrompt` 载入宫格并 toast）；挂 `_neoRg = { getAssets, setAssets, getPrompt, setPrompt }` 供 recipes.js 调用 |
| `media-transfer.js` | 素材 → input/ 目录共享搬运助手（自 director.js 拆出，ref-grid.js 共用）：`grabDataType`（拖放载荷提取）、`copyGalleryToInput`（`/neo_gallery/copy_to_input`）、`uploadLocalFiles`（`/upload/image` 批量）、`toggleGallerySidebar` |
| `director.js` | 多段视频导演编辑器（配方编辑窗口，从 recipes.js 拆出）：配方名钉在标题栏中间（默认纯文本直显、点击进入行内编辑）+ shared 分辨率（宽高比/百万像素或自定义 W/H）+ 生成模式（全局模式，mixed 逐段）+ 紧邻其后的**统一技能选择**（非混合模式各段共用、段内技能下拉隐藏；mixed 时隐藏、回到逐段选择）+ 逐段提示词/首帧/时长 + 半自动故事生成与拆分；标题栏右侧 🤖 按钮开 LLM 配置弹窗（llm-setting.js `openLLMSettingsModal`，全局单例、脏改动确认条）；LLM 依赖操作失败弹 action toast 带「打开 LLM 设置」入口（不自动弹弹窗挡界面）；时间轴复用 `director-timeline.js`，保存走 `recipes.js` 的 `saveRecipe` |
| `director-node.js` | NeoH3VideoDirector 节点内嵌只读时间轴（复用 `director-timeline.js`，点击分段块打开编辑器并定位到该段）+ **采样实时预览面板**：消费后端每步推来的 `rs.h3.preview` 多帧载荷（按 `node_id` 路由到对应节点），自动循环播放该步动画，支持暂停/继续、逐帧、逐采样步回看（回看旧步时新载荷不改画面）；采样期间面板占节点底部加高的 300px，换段或运行结束即清空复位。**recipe combo 选择窗**：走 `attachSkillPickerToComboWidget`（仅搜索、无管理工具栏），浮动预览卡经自定义 `previewRenderer` 显示焦点配方的只读时间轴——复用节点内嵌同款 `DirectorTimeline` 组件（秒级标尺 / 分段块 / 首帧缩略图，高度 112px，选择窗关闭时销毁实例）；spec 走 `/rs_recipes/director_spec` 并缓存，配方保存事件后清空；点预览卡经 `onPreviewClick` 直接打开该配方的导演编辑器 |
| `workflow.js` | 工作流修复：`/neo_nodes/repair` 请求、确认弹窗（手动选择 + 记住映射）、修复记录日志、顶栏「修复工作流」/「修复记录」按钮 |
| `prompts.js` / `prompts.css` | 提示词节点界面：状态栏、文本区、快捷输入栏、技能选择器、图片 chip；节点移除时统一注销 document/window/api 监听并销毁挂 body 的浮层菜单 |
| `prompt-manager.js` | 提示词管理器：预设列表、集合视图、保存与删除（保存弹窗用 `/rs_prompts/extract_title`、`extract_classify` 自动填标题与标签，LLM 分析失败时状态行提示并弹 action toast 指向 LLM 设置，标题/标签仍可手填）；聊天域 DOM 由 `llm-chat.js` 的 `createStatusBars()` / `createPromptOutputArea()` 提供并经 `createPromptManagerUI()` 组装 |
| `llm-chat.js` | LLM 聊天域：输入区 DOM（快捷输入框与提示语轮播、工具条、技能下拉、附加图片 chips、运行时随机菜单 DOM）+ 输出区 DOM（`createPromptOutputArea()`：textarea、Markdown 预览层与任务复选框回写、清空按钮、多轮技能提示、生图结果块控制器 + 节点最底部生图状态行 `rs-gen-status`（按 `state.phase` 切换形态：`enhance` 增强提示词流式阶段按已生成字符推进近似宽度并显示「已生成 N 字」、`sample` 采样阶段显示真实步数、`submit/queue` 排队用不定动画；运行中一行显示 状态/进度/取消，结束即隐藏，不随预览吸顶））+ `createGenerateHandler()` 生成流程（生图 skill 直连 `/neo_image_gen`（状态与进度在底部状态行更新；完成/取消/失败后状态行自动收起；缩略图走 `/neo_gallery/thumbnail` 缓存接口，点击经通用 `Lightbox` 打开原图；发送装配渲染在 Markdown 预览，生图前的 LLM 增强失败不阻断、改用原文并弹 action toast 指向 LLM 设置）/ skill 路由 / 选中模板 / LLM 智能判断，SSE 流式分支 rAF 合帧写回 textarea）+ `wireBackendStreamUpdate()` 后端执行期自动生成回写（按 `instance_uid` 过滤，写回 textarea/widget 后同帧刷新 Markdown 预览；载荷里出现生成器的 `[ERROR]` 失败文本时，除写回外另弹一次 action toast（按失败来源分流：`failAction(skillId, err)` — LLM 特征报文 → 打开 LLM 设置，否则选中 skill → 打开技能详情），同一失败只弹一次；返回注销函数） |
| `at-picker.js` | `@` 图片选择器（纯 ES 模块）：`createAtImagePicker({ quickInput, attachedImages, imageKey, addImageInput, inputViewUrl })` 返回打开函数，由 `llm-chat.js` 的 `createStatusBars()` 注入依赖并在输入 `@` 时调用。扫描工作流未禁用的 Load Image 节点并按目标节点 IMAGE 输入槽算出 pictureNo；弹层挂 body 并跟随光标定位（含画布缩放校正），支持键盘导航与外部点击关闭，关闭时移除 document 与输入框监听并复位打开句柄 |
| `slash-picker.js` | `/` 技能快捷菜单（纯 ES 模块）：`createSlashSkillPicker({ quickInput, skillSelector, listSkills })` 返回打开函数，由 `llm-chat.js` 的 `createStatusBars()` 注入依赖并在输入 `/` 时调用。弹层挂 body 并锚定到输入框下方定位；随后续输入按 name/id/tags（含中文拼音，忽略大小写）实时过滤，空 query 按分类排序；每行显示技能名 + 类别名称（复用 skill.js `CATEGORY_LABELS`，未知分类回落 image_enhance）；`↑`/`↓`/`Home`/`End` 移动高亮、`Enter`/`Tab` 提交当前项（写入 skillSelector 并派发 change、清除 `/query`）、`Esc` 关闭；只过滤不自动提交，关闭时移除 document 与输入框监听并复位打开句柄 |
| `dom-utils.js` | 共享 DOM 工厂：`mkEl(tag, className, styles)`，供 prompt-manager / llm-chat / skill / llm-setting / prompts 复用 |
| `toast.js` | 统一「需用户处理」通知：`actionToast({ severity, summary, detail, actionLabel, onAction })` 渲染右上角堆叠卡片（顶部菜单/任务队列下方，样式在 prompts.css），**不自动关闭**，点 action 执行回调后关闭、✕ 手动关闭。LLM 异常统一走这里：按失败来源分流——报文命中 LLM 特征（Remote LLM / provider / LLM model / API key / timeout / network / Error code / HTTP 4xx·5xx）一律给「打开 LLM 设置」（`openLLMSettingsModal`），**即使当时选了 skill**（端点/密钥/模型问题改 skill 没用）；其余选中 skill 的失败给「打开技能详情」。覆盖聊天/技能流、后端执行期自动生成、导演提示词生成、分镜故事、提示词增强与预设 AI 分析；缺模型/缺节点等非 LLM 错误同样用 action toast 给出处理入口（普通信息提示仍走 gallery-utils.showToast 内置 toast） |
| `prompt-service.js` | `/rs_prompts/*` API 的前端封装（增强/翻译/智能/随机 + 远程 LLM 配置）；`sseStream()` 是统一 SSE 客户端：两种失败帧都交给 `onError` 而不是当正文写进提示词——纯文本帧 `data: [ERROR] xxx`（路由早退 / 外层 except）与正文块 `data: {"text":"[ERROR] xxx"}`（生成器内部 except），HTTP 非 2xx 取 `error` 字段，各处据此弹 action toast |
| `llm-setting.js` | LLM 配置表单（纯 ES 模块）：`createModelConfigForm()` 返回 `{ el, load, save, isDirty }`，以 tab 形式挂入自动增强菜单（provider 切换 / API key / 本地·远程模型 / base URL / 本地目录 / 自动卸载）；`openLLMSettingsModal()` 为全局单例 LLM 配置弹窗（打开即后台回填、脏改动确认条），供 director 🤖 按钮与各失败路径的 action toast「打开 LLM 设置」入口复用；有预设 Base URL 的 provider 把 Base URL 收进「自定义端点」折叠区（`<details class="rs-remote-advanced">`，无预设端点的 OpenAI Compatible 常显、无收起入口；已存端点与预设不一致时自动展开），收起时回填与保存照常；API Key 行按 `requires_api_key` 提示必填 / 可选，留空保存且服务端未存过密钥时告警，已存密钥则提示「留空沿用」；温度已移除，请求不带 `temperature`；无防抖自动保存，表单底部 💾 保存按钮显式落盘（复用 `.rs-gen-save` 样式），保存按钮下方「🔌 测试连接」用当前表单值发「你好」验证连通（本地 provider 提示不适用；留空字段回退该 provider 已存配置，成功回显回复摘要、失败显示原因），local 模式保存时若选中模型与已存 current_model 不同则额外调 `/rs_prompts/set_model` 持久化并切换常驻模型；本地目录输入 change 是唯一保留的即时写（列表刷新依赖后端已存目录）；`isDirty` 为 load/save 后快照对比，load resolve 时模型列表已填充完毕；本地服务的模型下拉显示大小 / 视觉 / `loaded` 状态（未加载同样可选，服务端收到请求时按需加载；仅不可达时显示连接失败） |
| `image-gen.js` | 生图客户端（纯 ES 模块）：`requestGeneration` / `watchTask`（订阅 `rs.image_gen.status` 推送等待终态，订阅后兜底首拉一次状态、断线重连再拉一次补漏）/ `cancelTask` 包装 `/neo_image_gen/*`；`buildGenPrompt()` 参考图模式下套用 skill 正文模板并替换 `【人物形象描述】` 占位符；`collectLoadImageTargets()` 收集画布 LoadImage（跳过 mode 4，按 y→x 排序），单图 `sendImageToLoadImage()`：唯一目标直接写入、多目标弹菜单确认、无目标自动新建 LoadImage 并写入（经 LiteGraph.createNode + canvasPosToGraph 定位），多图 `assembleAllGenerated()` 按画布顺序依次写入（复用 `/neo_gallery/copy_to_input`）；`createImageGenSettingsForm()` 返回 `{ el, load, save, isDirty }`（全局「生图默认设置」tab，独立实现、不复用每技能控件区，只含 生图模型 / Text Encoder / VAE 三个可搜索下拉 + 输出前缀 + 💾 保存按钮），以 tab 形式挂入自动增强菜单（与 LLM Settings 切换）；模型/Encoder/VAE 下拉按 krea2 相关靠前排序，「自动」项标注后端建议名，空值 = 后端自动挑选、可显式指定覆盖。张数 / 长边尺寸 / 默认比例 / LoRA 行（每行「依赖参考图」复选框：勾选=仅参考图模式加载/作为四视图 LoRA，不勾=文生图无条件加载）只在每技能设置里配，由 `createModelConfigSection()` + `createGenSizeRows()` 组装；`createVideoModelConfigSection()` 为视频技能每技能设置区（生视频模型 / Text Encoder / VAE(视频) / VAE(音频) 四个可搜索下拉 + 步数（采样步数，默认 20）+ LoRA 行，空值回落全局「生视频模型」，列表来自 `/neo_video_gen/models`、建议名按 H3 名称线索客户端挑选，同全局生视频表单；LoRA 行每行 = 模型选择 + 强度，**无**生图区那样的「依赖参考图」复选框，配置的全部无条件加载）；Enhance Prompt 开关在技能正文（System Prompt Content）标题右侧（skill.js），增强指令即技能 skill.md 正文 |
| `skill.js` | 技能模块（纯 ES 模块）：skill API（list/load/save/delete/upload + 文件级操作）+ `createSkillDetailPopup()`（单技能详情弹窗：查看/编辑/删除/复制为自定义/新建，跨节点单例；关闭保护——正文（名称/内容/multi-turn）或生图·生视频设置区有未保存修改时，✕/点遮罩/Esc 先出确认条（💾 保存并关闭走对应保存路径、失败留在弹窗重试 / 放弃修改 / 继续编辑），无修改直接关；生图技能显示「🖼️ 生图设置」区、视频技能 `gen_video` 显示「🎬 生视频设置」区，各自读写该 skill `config.json` 覆盖：自定义随主 Save 落盘；预设设置也可编辑（存本地覆盖文件 `configs/skill_overrides/<id>.json`，不改预设文件，区头部「💾 Save」独立保存、「↺ 恢复默认」一键清除覆盖；两区头部均有「🔧 修复失效路径」+「📋 修复记录」按钮——前者调 `/neo_nodes/skill_model_suggest`（复用工作流修复同款匹配）列出 config 里所有失效模型字段/LoRA 与候选·置信度，勾选批量套用后回填对应设置区并重校验工作流图（清掉已修好的红框）、不自动保存需再点 Save；打开/重载技能时后台检测当前活动设置区缺失项，有缺失则「修复」按钮加红框+右上角红点告警（`.rs-alert`），应用修复后重新检测、无缺失即清除；「📋 修复记录」按技能 id 存本地（localStorage `neo.skillRepairLog`，每技能上限 50 条）列出历次修复的时间·类型与 from→to，可清空，不影响 config.json；下拉框对失效值如实显示原值并标红 `.rs-model-missing`，不再静默按唯一文件名回填）；生图/生视频技能另有「🔀 工作流（节点流程图）」区：经 `/neo_image_gen/skill_workflow` 拉 `workflow.json` 后先按已有参数预渲染模板变量（设置显式值优先、空值回落自动建议模型；运行时变量如提示词/种子/参考图保留蓝色占位），配置 LoRA 超出模板槽位时按后端 `_apply_loras` 镜像注入到图中（未配置不显示），再由 workflow-graph.js 渲染只读 SVG 并校验高亮（缺失模型按替换后的真实文件名判定），问题摘要行在计数之外列出未安装节点/缺失模型的名称芯片，每个芯片带 📋 复制按钮（点击把名称写入系统剪贴板并短暂显示 ✓/✗，同名去重，非安全上下文回落 execCommand），加载中先显示骨架占位并同步压缩正文区预留位置、加载完成后原地替换避免布局跳动；`workflow.json` 拉取与设置区加载并发，图采用分步渲染——先用同步预检（模板变量蓝框）画出流程图，`/object_info`·`/models/*` 校验完成后原地重画补红框与摘要（保留滚动位置），无 `workflow.json` 时隐藏；有工作流时 System Prompt Content 区高度减半给流程图让位、正文为空时进一步压缩（输入内容自动恢复））+ `createSkillDropdown()`（原生 select + 可搜索下拉组装：底部 + New Skill/⬆ ZIP/⬆ Folder 工具栏、行内 Edit/查看操作、共享 zip·目录上传隐藏 input）+ `openSkillPickerModal()` / `attachSkillPickerToComboWidget()`（居中技能选择窗替代原生 combo 下拉：搜索 + 列表 + 右侧浮动预览卡随焦点切换；`previewRenderer` / `onPreviewClick` 可换成自定义渲染与点击动作，导演配方选择窗借此显示概览行（段数 · 模式 · 技能 · 宽×高 · 总时长）+ 迷你时间轴） |
| `workflow-graph.js` | 工作流模板流程图（纯 ES 模块）：`layoutWorkflow()` 把 API prompt（inputs 里 `[source_id, slot]` 连线，无坐标）按最长路径拓扑分层从左到右布局（环安全、孤儿节点独立成层）；`applyWorkflowParams()` 按已知参数（设置值 / 自动建议模型 / LoRA 槽位 / 默认尺寸步数）预替换模板变量，运行时变量保留、不改原对象；`injectRuntimeLoras()` 镜像后端 `_apply_loras`——配置 LoRA 超出模板 `{{LORA_i_*}}` 槽位时在主链末端串联插入 `LoraLoaderModelOnly`（锚点 = 最后槽位 / 第一个 UNETLoader 且手写 LoRA 链推到链尾，id = max_id+1...，下游重接），未配置或槽位够用时原样返回，使流程图与运行时实际提交的图一致（注入节点 tooltip 标注「运行时动态注入」）；`validateWorkflow()` / `checkWorkflow()` 对照 `/object_info` 与按需拉取的 `/models/{folder}` 标记 节点未安装（红框）/ 模型缺失（红框：有效列表取「已知 `*_NAME` 类型名 → 按需拉 `/models/{folder}`」或 object_info 直接内联的解析后 combo 列表（本环境把 combo 展开成路径数组而非类型名），config 值与列表两边分隔符归一化后精确比对，文件挪走/失效即报缺失；未知类型或列表不可用则跳过防误报）/ `{{模板变量}}`（蓝框，运行时填入不算错误），任一请求失败即跳过对应检查；`renderWorkflowGraph()` 画 SVG（节点框 + 参数行 + 贝塞尔连线 + 徽标 + tooltip）与问题摘要行，参数直接画在节点上（按列宽截断：第一列加载器框更宽、可显示更多字符；连线输入只显示参数名、连线精确指向对应行并带落点标记，不同连线按调色板取不同颜色便于区分；超 6 行折叠「+N 项」、节点高度随行数自适应），hover tooltip 补全完整值（连线来源 / 替换后模型名 / 运行时变量原样），内容超出滚动区时可按住拖拽平移（同画布体验） |

## 节点注册

节点类在 `prompts.py` 底部映射，`__init__.py` 合并导出：

```python
# prompts.py
NODE_CLASS_MAPPINGS = {
    "NeoPromptEncoder": NeoPrompts,      # CLIP节点：提示词管理 + LLM 增强 + CLIP 编码
    "NeoPromptAgent": NeoPromptAgent,    # 提示词节点：提示词文本输出+ LLM 增强
}
```

- `NeoPrompts`（显示名 Neo Prompt Encoder）：输出 `CONDITIONING` + `STRING`，内置编码缓存（LRU，上限 50）
- `NeoPromptAgent`（显示名 Neo Prompt Agent）：无 CLIP 输入，仅输出 `STRING`
- `NeoRefGrid`（显示名 Neo Reference Grid (参考图宫格)，`ref_grid.py` 映射、同式合并导出）：输出 `STRING`×2（prompt / BUNDLE）+ `IMAGE`×12

前端扩展目录由 `WEB_DIRECTORY = "./web"` 声明。

## 数据与配置目录

| 目录/文件 | 说明 |
|------|------|
| `prompts/presets/` | 内置提示词预设（`.txt`，`collections/` 为合集、`video/` 为视频提示词子集） |
| `prompts/custom/` | 用户保存的提示词，`_tags_index.json` 为 AI 分类标签索引 |
| `skills/presets/<id>/skill.md` | 内置风格技能（SYS，Markdown + YAML frontmatter：name / tags / max_tokens）；生图技能额外声明 `category: image_gen` + `gen_image: true` + `requires_ref`（四视图必须带参考图，缺图在预览区底部报错不提交）；文生图宽高比由生图设置的「默认比例」决定，四视图模式由后端固定 16:9 横版并自动追加四视图 LoRA；生视频技能声明 `category: video_gen` + `gen_video: true` + `mode: t2v|i2v|fl2v|r2v`（技能下拉里独立成「🎬 生视频 (H3)」组；导演编辑器的分段技能下拉按 `skill.mode` 过滤，复制为自定义时随 frontmatter 一起保留） |
| `skills/tasks/<id>/skill.md` | 内置任务技能（extract_title / extract_classify / reverse_prompt / smart_prompt / template_prompt / translate_prompt） |
| `skills/custom/<id>/skill.md` | 用户自定义技能（USR，可编辑删除） |
| `gallery/presets/` | 内置预设素材（只读） |
| `gallery/custom/` | 用户上传素材 |
| `gallery/thumbnails/` | 缩略图缓存（可安全删除重建） |
| `gallery/lora_cache/` | Civitai LORA 示例缓存：一个 LORA 一个目录，`example_NN` 图 + 同名 `.txt` 提示词 |
| `gallery/oss_cache/` | 云端预设缓存（索引 + 文件） |
| `recipes/custom/` | 用户配方：`<配方名>/recipe.json` + `assets/` + `samples/` + `workflows/` |
| `recipes/presets/` | 内置预设配方（只读） |
| `configs/llm_providers.json` | Provider 定义（唯一真源）：`id` / `name` / `type`（local/remote）/ `default_base_url` / `append_v1` / `show_api_key` / `requires_api_key`（云厂商必填）/ `model_mode`（hybrid/dropdown）；本地、国产云（deepseek / dashscope / dashscope-plan / moonshot / zhipu / siliconflow）与自建服务（openai / lmstudio / ollama / openrouter / unsloth / vllm）同一份清单，前端下拉由此动态生成；丢失时回退 `llm.py` 的 `_BUILTIN_PROVIDER_DEFS`（内容须与之一致，有单测锁定） |
| `configs/remote_llm_config.json` | 远程 LLM 配置：`active_provider` + 按 provider 分槽的 `providers`（槽位由 provider 定义自动补齐，新增供应商无需手改），API Key 仅存本机 |
| `configs/oss_presets.json` | OSS 预设素材源配置 |
| `configs/gallery_settings.json` | 素材自定义目录与 Civitai 设置（API KEY 脱敏显示；.gitignore 不入库） |
| `configs/bookmarks.json` | 本地收藏：仅记录路径信息，不复制文件（.gitignore 不入库） |
| `user/neo_repair_mappings.json` | 工作流修复的手动映射（ComfyUI 用户目录） |
| `locals/zh_CN.json` | 本地化资源 |



