# ComfyUI-Neo-Nodes 开发者文档

面向开发者：项目结构、前后端模块职责、API 路由、节点注册、数据目录、测试与发布。终端用户使用文档见 [README.md](README.md)。

## 目录

- [项目结构](#项目结构)
- [后端模块](#后端模块)
- [前端资源](#前端资源)
- [后端 API 路由](#后端-api-路由)
- [节点注册](#节点注册)
- [数据与配置目录](#数据与配置目录)
- [配方与素材实现细节](#配方与素材实现细节)
- [测试](#测试)
- [发布](#发布)
- [离线工具](#离线工具)

## 项目结构

```
ComfyUI-Neo-Nodes/
├── __init__.py             # 插件入口：导入后端模块注册 API 路由，合并节点映射，声明 WEB_DIRECTORY
├── prompts.py              # 提示词节点核心逻辑（NeoPromptEncoder / NeoPromptAgent）+ /rs_prompts/* API
├── llm.py                  # LLM 推理：远程 API（OpenAI 兼容 / LM Studio / Ollama / OpenRouter）与本地 llama.cpp GGUF
├── gallery.py              # Neo Gallery 素材后端 + /neo_gallery/* 路由
├── gallery_lora.py         # Civitai LORA 示例后台抓取 + lora_cache 管理
├── gallery_oss.py          # 云端预设（OSS）素材同步
├── recipes.py              # 配方后端 + /rs_recipes/* 路由
├── workflow.py             # 工作流模型路径修复逻辑 + /neo_nodes/repair* 路由
├── image_gen.py            # 内置生图后端：Krea2 工作流构建 + 队列提交/状态事件推送 + /neo_image_gen/* 路由
├── krea2_edit.py           # Krea2 以图生图核心节点（vendor 自 comfyui-krea2edit）：ModelPatch + GroundedEncode
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
│   ├── gallery_preprocess.py   # 预设预处理：生成缩略图 + index.json（--dirs 增量模式自动从 OSS 拉取最新 index 合并）
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
│   ├── gallery-setting.js  # 目录管理配置弹窗（自定义目录/OSS/Civitai 同步）
│   ├── gallery-utils.js    # 素材工具函数
│   ├── gallery.css
│   ├── lightbox.js         # 灯箱查看器
│   ├── lightbox.css
│   ├── node-behavior.js    # 节点拖拽/粘贴等交互行为
│   ├── combo-box.js        # 通用下拉组件
│   ├── recipes.js          # 配方逻辑（保存/面板/一键发送）
│   ├── recipes.css
│   ├── workflow.js         # 工作流修复（请求 + 确认弹窗 + 修复映射 + 顶栏按钮）
│   ├── prompts.js          # 提示词节点前端交互
│   ├── prompts.css
│   ├── prompt-manager.js   # 提示词管理器（预设列表 / 集合视图 / 保存与删除；聊天区由 llm-chat.js 提供）
│   ├── llm-chat.js         # LLM 聊天域：输入框与提示语轮播、输出区 Markdown 预览、工具条、技能下拉、附加图片 chips、✨/Enter 生成（SSE 流式）
│   ├── at-picker.js        # `@` 图片选择器：扫描工作流 Load Image 节点，弹层跟随光标，点击/回车插入 <Picture N> 标记
│   ├── prompt-service.js   # 提示词 API 服务封装
│   ├── llm-setting.js      # LLM 配置表单（provider/模型/API key/本地目录），挂入自动增强菜单
│   ├── image-gen.js        # 生图（Krea2）客户端：/neo_image_gen/* 包装、任务事件等待（rs.image_gen.status）、四视图模板、结果发送到 LoadImage、生图设置表单
│   ├── dom-utils.js        # 共享 DOM 工厂 mkEl()
│   └── skill.js            # 技能模块：skill API + createSkillDetailPopup()（单技能详情弹窗）+ createSkillDropdown()（技能下拉组装：底部管理工具栏 / 行内操作 / zip·目录上传）
└── .github/workflows/
    └── publish.yaml        # 发布 ComfyUI Registry 的 GitHub Action
```

## 后端模块

| 模块 | 职责 |
|------|------|
| `__init__.py` | 插件入口。导入 `gallery` / `recipes` / `workflow` / `image_gen` 模块以注册各自的 API 路由，从 `prompts.py` 合并 `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`（含 `krea2_edit` 的两个节点；若用户已安装外部 comfyui-krea2edit 则跳过以免重复注册），声明 `WEB_DIRECTORY = "./web"` |
| `prompts.py` | 两个提示词节点（`NeoPrompts` → Neo Prompt Encoder，`NeoPromptAgent` → Neo Prompt Agent）与 `/rs_prompts/*` 路由：预设提示词 CRUD、LLM 模型切换、图片解析（`resolve_image_bytes`）、标签索引 |
| `skill.py` | 技能系统：Markdown + YAML frontmatter 解析（PyYAML 事件流）、`skills/{presets,tasks,custom}/<id>/skill.md` 扫描与加载（`scan_skills` / `load_skill_content` / `load_task_template`）、多结果契约读取、语言互斥主文件选择（`SKILL.md`/`SKILL.cn.md`）与按需引用加载的工具调用代理循环（`run_skill_agent[_stream]` / `read_skill_file`，仅运行时惰性导入 llm 原语以避免与 llm.py 的顶层依赖形成循环）、`/rs_prompts/skill*` 路由（列表/读取/保存/删除/上传） |
| `llm.py` | LLM 推理层：`RemoteLLMClient`（OpenAI 兼容 HTTP，支持 `tools=` 工具调用）、`LLMSingleton`（进程内 llama.cpp GGUF，含 mmproj 多模态绑定与自动卸载）、远程配置存取（`configs/remote_llm_config.json`，按 provider 分槽）、模型目录扫描（`scan_llm_directory`）、任务模板加载（`skills/` 目录，Markdown + frontmatter）与流式/非流式执行、模式无关的单轮对话原语 `chat_turn`（按当前模式分发本地 llama.cpp / 远程 API，供 skill 代理循环按需调用） |
| `gallery.py` | Neo Gallery 素材后端：预设/自定义/系统（input、output）目录聚合浏览、缩略图生成与缓存、媒体文件服务、上传/删除、目录设置（`gallery_settings.json`）。导入时加载 `gallery_lora` / `gallery_oss` 以注册其路由 |
| `gallery_lora.py` | Civitai LORA 示例后台抓取队列：打开 Lora 目录时按文件 SHA256 查询并下载示例图 + 提示词 sidecar，缓存于 `gallery/lora_cache/` |
| `gallery_oss.py` | 云端预设（OSS）素材：按 `configs/oss_presets.json` 拉取索引与文件到 `gallery/oss_cache/`，提供缩略图/媒体回退服务 |
| `recipes.py` | 配方后端：配方 CRUD、assets 资源服务、示例结果追加/删除、工作流快照备份与 `send_to_workflow` 复制 |
| `workflow.py` | 工作流模型路径修复：高置信度匹配算法（`repair_workflow`）、手动修复映射存储（`user/neo_repair_mappings.json`）、`/neo_nodes/repair*` 路由 |
| `image_gen.py` | 内置生图后端：把 Krea2 文生图/参考图四视图请求构建为 API prompt，经内部 HTTP `/prompt` 压进执行队列（独立 `client_id`，不干扰前端进度），轮询 history 收集 SaveImage 输出并写同名 `.txt` sidecar；任务记录仅存内存（TTL 1h / 上限 32）。含模型扫描与自动挑选、按比例算尺寸、输出前缀消毒。参考图模式走 `krea2_edit` 路径：`LoadImage` → `ImageScale`（lanczos，长边限 1024px）→ `VAEEncode` 得源 latent 进 `Krea2EditModelPatch`（`fit_mode=fit`，像素空间 AR 适配 + VAE encode，`target_latent` 预编码避免采样中途挤占显存）；positive/negative 均用 `Krea2EditGroundedEncode` 接地到同一张参考图（negative 空指令），目标为 16:9 横版 `EmptySD3LatentImage`（同时接 `KSampler.latent_image` 与 patch 的 `target_latent`），denoise 恒 1.0；prompt = 固定结构指令前缀 + 用户描述；四视图 LoRA 由用户在 LoRA 列表里勾选「依赖参考图」（`ref_only`）标记，参考图模式直接沿用（缺失时按名称线索自动挑选/追加，仍无则报错不降级），文生图跳过 `ref_only` 的 LoRA |
| `krea2_edit.py` | Krea2 以图生图核心节点，vendor 自 comfyui-krea2edit（单文件插件）。`Krea2EditModelPatch`：包装 DIFFUSION_MODEL forward，把序列重建为 `[text \| source(frame=1) \| target(frame=0)]` 只取 target token；`fit_mode=fit` 在像素空间做 AR 适配 + VAE encode（支持 `target_latent` 预编码）。`Krea2EditGroundedEncode`：图像接地指令编码，Qwen3-VL user turn = `<vision: source>` + instruction（训练一致语义路径）。上游活跃开发，修复需整文件同步（对比 `custom_nodes/comfyui-krea2edit/__init__.py`）；用户已装外部插件时由 `__init__.py` 跳过注册 |
| `prompt_lines.py` | 提示词文本行解析：将预设/合集 .txt 拆为（标题，内容）条目，供预设列表与随机候选使用 |
| `util.py` | 媒体扩展名常量（IMG/VIDEO/AUDIO）与共享工具：目录媒体探测、媒体元数据提取、配方提示词文本收集。独立于路由模块以避免导入循环 |

## 前端资源

`web/` 由 ComfyUI 自动加载（`WEB_DIRECTORY`）：

| 文件 | 职责 |
|------|------|
| `gallery.js` / `gallery-list.js` / `gallery-card.js` / `gallery-setting.js` / `gallery-utils.js` / `gallery.css` | 素材侧边栏：目录卡片、懒加载列表、搜索、上传删除、设置弹窗 |
| `lightbox.js` / `lightbox.css` | 通用灯箱组件：异步 blob 加载、相邻预加载、缩放平移、尺寸显示、`panelProvider` 侧栏钩子；素材与配方通过各自适配接入 |
| `node-behavior.js` | 节点级交互行为（拖拽图片、粘贴、`@` 引用等） |
| `combo-box.js` | 通用下拉选择组件：点击展开/键入过滤覆盖、键盘导航；`<optgroup>` 渲染为分类标题（无 `data-value`，自动被键盘导航与取值逻辑跳过），过滤时空组隐藏 |
| `recipes.js` / `recipes.css` | 配方侧边栏面板：保存弹窗、卡片、详情浮层、一键发送 |
| `workflow.js` | 工作流修复：`/neo_nodes/repair` 请求、确认弹窗（手动选择 + 记住映射）、修复记录日志、顶栏「修复工作流」/「修复记录」按钮 |
| `prompts.js` / `prompts.css` | 提示词节点界面：状态栏、文本区、快捷输入栏、技能选择器、图片 chip；节点移除时统一注销 document/window/api 监听并销毁挂 body 的浮层菜单 |
| `prompt-manager.js` | 提示词管理器：预设列表、集合视图、保存与删除；聊天域 DOM 由 `llm-chat.js` 的 `createStatusBars()` / `createPromptOutputArea()` 提供并经 `createPromptManagerUI()` 组装 |
| `llm-chat.js` | LLM 聊天域：输入区 DOM（快捷输入框与提示语轮播、工具条、技能下拉、附加图片 chips、运行时随机菜单 DOM）+ 输出区 DOM（`createPromptOutputArea()`：textarea、Markdown 预览层与任务复选框回写、清空按钮、多轮技能提示、生图结果块控制器 + 节点最底部生图状态行 `rs-gen-status`（按 `state.phase` 切换形态：`enhance` 增强提示词流式阶段按已生成字符推进近似宽度并显示「已生成 N 字」、`sample` 采样阶段显示真实步数、`submit/queue` 排队用不定动画；运行中一行显示 状态/进度/取消，结束即隐藏，不随预览吸顶））+ `createGenerateHandler()` 生成流程（生图 skill 直连 `/neo_image_gen`（状态与进度在底部状态行更新；完成/取消/失败后状态行自动收起；缩略图走 `/neo_gallery/thumbnail` 缓存接口，点击经通用 `Lightbox` 打开原图；发送装配渲染在 Markdown 预览）/ skill 路由 / 选中模板 / LLM 智能判断，SSE 流式分支 rAF 合帧写回 textarea）+ `wireBackendStreamUpdate()` 后端执行期自动生成回写（按 `instance_uid` 过滤，写回 textarea/widget 后同帧刷新 Markdown 预览；返回注销函数） |
| `at-picker.js` | `@` 图片选择器（纯 ES 模块）：`createAtImagePicker({ quickInput, attachedImages, imageKey, addImageInput, inputViewUrl })` 返回打开函数，由 `llm-chat.js` 的 `createStatusBars()` 注入依赖并在输入 `@` 时调用。扫描工作流未禁用的 Load Image 节点并按目标节点 IMAGE 输入槽算出 pictureNo；弹层挂 body 并跟随光标定位（含画布缩放校正），支持键盘导航与外部点击关闭，关闭时移除 document 与输入框监听并复位打开句柄 |
| `dom-utils.js` | 共享 DOM 工厂：`mkEl(tag, className, styles)`，供 prompt-manager / llm-chat / skill / llm-setting / prompts 复用 |
| `prompt-service.js` | `/rs_prompts/*` API 的前端封装（增强/翻译/智能/随机 + 远程 LLM 配置） |
| `llm-setting.js` | LLM 配置表单（纯 ES 模块）：`createModelConfigForm()` 返回 `{ el, load, save }`，以 tab 形式挂入自动增强菜单（provider 切换 / 本地·远程模型 / API key / 本地目录 / 自动卸载） |
| `image-gen.js` | 生图客户端（纯 ES 模块）：`requestGeneration` / `watchTask`（订阅 `rs.image_gen.status` 推送等待终态，订阅后兜底首拉一次状态、断线重连再拉一次补漏）/ `cancelTask` 包装 `/neo_image_gen/*`；`buildGenPrompt()` 参考图模式下套用 skill 正文模板并替换 `【人物形象描述】` 占位符；`collectLoadImageTargets()` 收集画布 LoadImage（跳过 mode 4，按 y→x 排序），单图 `sendImageToLoadImage()`：唯一目标直接写入、多目标弹菜单确认、无目标自动新建 LoadImage 并写入（经 LiteGraph.createNode + canvasPosToGraph 定位），多图 `assembleAllGenerated()` 按画布顺序依次写入（复用 `/neo_gallery/copy_to_input`）；`createImageGenSettingsForm()` 返回 `{ el, load, save, isDirty }`（全局「生图默认设置」tab，独立实现、不复用每技能控件区，只含 生图模型 / Text Encoder / VAE 三个可搜索下拉 + 输出前缀 + 💾 保存按钮），以 tab 形式挂入自动增强菜单（与 LLM Settings 切换）；模型/Encoder/VAE 下拉按 krea2 相关靠前排序，「自动」项标注后端建议名，空值 = 后端自动挑选、可显式指定覆盖。张数 / 长边尺寸 / 默认比例 / LoRA 行（每行「依赖参考图」复选框：勾选=仅参考图模式加载/作为四视图 LoRA，不勾=文生图无条件加载）只在每技能设置里配，由 `createModelConfigSection()` + `createGenSizeRows()` 组装；Enhance Prompt 开关在技能正文（System Prompt Content）标题右侧（skill.js），增强指令即技能 skill.md 正文 |
| `skill.js` | 技能模块（纯 ES 模块）：skill API（list/load/save/delete/upload + 文件级操作）+ `createSkillDetailPopup()`（单技能详情弹窗：查看/编辑/删除/复制为自定义/新建，跨节点单例）+ `createSkillDropdown()`（原生 select + 可搜索下拉组装：底部 + New Skill/⬆ ZIP/⬆ Folder 工具栏、行内 Edit/查看操作、共享 zip·目录上传隐藏 input） |

## 后端 API 路由

路由通过 `PromptServer.instance.routes` 注册。

### gallery.py — `/neo_gallery/*`

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

### gallery_lora.py — Civitai LORA

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/lora_dirs` | `models/loras` 第一级子目录列表 |
| POST | `/neo_gallery/civitai_test` | Civitai 连通性 / API KEY 探测 |
| GET | `/neo_gallery/lora_cache_status` | LORA 缓存队列状态 |
| POST | `/neo_gallery/lora_retry_failed` | 重试失败项 |

### gallery_oss.py — 云端预设

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_gallery/sync_oss` | 同步 OSS 预设索引 |
| GET | `/neo_gallery/oss_status` | OSS 同步状态 |

### recipes.py — `/rs_recipes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_recipes/list` | 配方列表（custom / presets） |
| POST | `/rs_recipes/load` | 读取单个配方 |
| POST | `/rs_recipes/save` | 保存配方（含 assets 收集） |
| POST | `/rs_recipes/append_results` | 追加示例结果（含工作流备份） |
| POST | `/rs_recipes/delete_sample` | 删除示例结果 |
| POST | `/rs_recipes/delete` | 删除配方（仅 custom） |
| GET | `/rs_recipes/asset` | 配方资源文件 |
| GET | `/rs_recipes/workflow` | 示例对应的工作流快照 |
| POST | `/rs_recipes/send_to_workflow` | 资源复制进 `input/` 供一键还原 |

### workflow.py — `/neo_nodes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_nodes/repair` | 工作流模型路径修复（高置信度匹配 + 阈值档位 `threshold` + 动态 widget 引用 `widget_refs` + 手动决策（含 `skip`）+ 映射） |
| GET | `/neo_nodes/repair_mappings` | 读取已保存的修复映射 |
| DELETE | `/neo_nodes/repair_mappings` | 删除修复映射 |

### image_gen.py — `/neo_image_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_image_gen/settings` | 读取内置生图默认参数（`configs/image_gen.json`，缺失时回落内置值） |
| POST | `/neo_image_gen/settings` | 保存默认参数（仅接受 `DEFAULT_SETTINGS` 里的键） |
| GET | `/neo_image_gen/models` | 扫描 `diffusion_models` / `text_encoders` / `vae` / `loras`（各列表按 krea2 相关靠前排序供展示）并给出自动挑选结果（含 `suggested_lora` = 建议的四视图 LoRA） |
| POST | `/neo_image_gen/generate` | 解析请求 → 构建 Krea2 API 图 → 提交执行队列，返回任务快照（含 `task_id`）；参数错误 400 |
| GET | `/neo_image_gen/status/{task_id}` | 任务快照（兜底拉取）：`queued` / `running` / `succeeded` / `failed` / `cancelled` + 图片列表、采样进度 `progress`（仅运行中且全局 registry 命中本 prompt 时非空）、错误、告警 |
| GET | `/neo_image_gen/tasks` | 最近任务列表（按创建时间倒序，最多 32 条） |
| POST | `/neo_image_gen/cancel/{task_id}` | 出队并在运行中时中断该任务 |

任务状态不走 HTTP 轮询：`_watch` 协程按变化经 WebSocket 事件 `rs.image_gen.status` 推送任务快照（广播，前端 `watchTask` 按 `task_id` 过滤）；`/status` 仅作订阅前兜底首拉与断线重连补漏，取消时后端也主动推送 `cancelled` 快照。

### prompts.py — `/rs_prompts/*`

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
| POST | `/rs_prompts/fetch_remote_models` | 拉取远程服务端模型列表 |
| GET | `/rs_prompts/skills` | 技能列表（预设 + 任务 + 自定义分组） |
| POST | `/rs_prompts/load_skill` | 读取单个技能（正文、附属 .md 文件清单、max_tokens、gen_image 生图标记） |
| POST | `/rs_prompts/save_skill` | 新建/更新技能主文件 skill.md（预设只读）；可选 `multi_turn` / `category` / `gen_image` / `requires_ref` 字段，缺省沿用 frontmatter 既有值，显式假值移除该字段（「复制为自定义」靠这三个字段保留生图分类与设置区） |
| POST | `/rs_prompts/delete_skill` | 删除整个技能目录（仅 USR） |

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

前端扩展目录由 `WEB_DIRECTORY = "./web"` 声明。

## 数据与配置目录

| 目录/文件 | 说明 |
|------|------|
| `prompts/presets/` | 内置提示词预设（`.txt`，`collections/` 为合集、`video/` 为视频提示词子集） |
| `prompts/custom/` | 用户保存的提示词，`_tags_index.json` 为 AI 分类标签索引 |
| `skills/presets/<id>/skill.md` | 内置风格技能（SYS，Markdown + YAML frontmatter：name / tags / max_tokens）；生图技能额外声明 `category: image_gen` + `gen_image: true` + `requires_ref`（四视图必须带参考图，缺图在预览区底部报错不提交）；文生图宽高比由生图设置的「默认比例」决定，四视图模式由后端固定 16:9 横版并自动追加四视图 LoRA |
| `skills/tasks/<id>/skill.md` | 内置任务技能（extract_title / extract_classify / reverse_prompt / smart_prompt / template_prompt / translate_prompt） |
| `skills/custom/<id>/skill.md` | 用户自定义技能（USR，可编辑删除） |
| `gallery/presets/` | 内置预设素材（只读） |
| `gallery/custom/` | 用户上传素材 |
| `gallery/thumbnails/` | 缩略图缓存（可安全删除重建） |
| `gallery/lora_cache/` | Civitai LORA 示例缓存：一个 LORA 一个目录，`example_NN` 图 + 同名 `.txt` 提示词 |
| `gallery/oss_cache/` | 云端预设缓存（索引 + 文件） |
| `recipes/custom/` | 用户配方：`<配方名>/recipe.json` + `assets/` + `samples/` + `workflows/` |
| `recipes/presets/` | 内置预设配方（只读） |
| `configs/remote_llm_config.json` | 远程 LLM 配置：`active_provider` + 按 provider 分槽的 `providers`（openai / lmstudio / ollama / openrouter / local），API Key 仅存本机 |
| `configs/oss_presets.json` | OSS 预设素材源配置 |
| `configs/gallery_settings.json` | 素材自定义目录与 Civitai 设置（API KEY 脱敏显示；.gitignore 不入库） |
| `configs/bookmarks.json` | 本地收藏：仅记录路径信息，不复制文件（.gitignore 不入库） |
| `user/neo_repair_mappings.json` | 工作流修复的手动映射（ComfyUI 用户目录） |
| `locals/zh_CN.json` | 本地化资源 |

## 配方与素材实现细节

### 配方资源收集与编码
保存配方以**连通子图**为单位收集：只收集输出已连线的 `LoadImage` / `LoadVideo` / `LoadAudio` 节点，按参数序号排列（图片组在前、视频、音频组在后）；未连线节点、其他子图的节点以及禁用（BYPASS / NEVER）状态的节点不参与。资源类型按**加载节点类型**判定（LoadImage → 图片、LoadVideo → 视频、LoadAudio → 音频），记录在 `recipe.json` 的 `kinds` 映射中；同一 mp4 既可作视频也可作音频输入（LoadAudio 加载时按音频处理），不按后缀反推，手动放入 `assets/` 的文件才按后缀兜底识别。旧版直接放在 `recipes/` 根下的配方会在启动时自动迁移到 `recipes/custom/`。

### 配方一键发送与子图对齐
「✈️ 发送到工作流」以**连通子图**为单位还原，资产与提示词只写入同一个子图：
- 目标子图选择：资源数与连线加载节点数**按类型逐一相等**（需要提示词时含 Neo Prompt）的子图精确匹配自动选中；画布仅一张子图时直接使用；多子图并列或无匹配时弹下拉由用户指定，取消则不做任何改动。
- 自动对齐：资产数与启用连线加载节点数不一致时——资产偏多则按参数位自动启用 Bypass/Never 的连线节点补齐（不足部分提示「仅还原了部分」）；资产偏少且同类启用节点全部连到同一下游目标时，把多余启用节点设为 Bypass（保留参数位靠前的参与还原）。
- 按**保存时的参数位**反解：连线节点按参数序号与配方资产逐一配对。

### Civitai LORA 抓取与缓存
`gallery_lora.py` 负责后台抓取：打开「Lora」目录或其子目录时，按文件 SHA256 查询 Civitai（`model-versions/by-hash`），下载该版本全部示例图并写入提示词 sidecar；每次访问最多处理 20 个 LORA，已缓存（size/mtime 未变）的自动跳过，被删除/更换的缓存自动清理。缓存落在 `gallery/lora_cache/`：一个 LORA 一个目录，内含多张 `example_NN` 示例图 + 同名 `.txt` 提示词。

## 测试

pytest 配置见 `pytest.ini`（`testpaths = tests`，无需启动 ComfyUI 即可运行）：

```bash
python -m pytest tests -v
```

- `tests/test_llm.py` — 远程配置加载/迁移、模型下载（ModelScope / HuggingFace 回退）、翻译缓存、语言检测、文本规范化
- `tests/test_skills.py` — 技能扫描与分组、内置任务技能存在性、图片解码缩放、多结果解析（分隔符 / JSON 数组）、skill 代理（语言互斥主文件选择、引用列表、安全读取越界拒绝、工具调用循环按需读引用、本地模式回退）、`gen_image` / `requires_ref` 元数据透传与编辑保存保留
- `tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确/归一化匹配、量化变体替换、歧义拒绝、扩展名约束
- `tests/test_image_gen.py` — 内置生图参数解析：比例与尺寸取整、输出前缀消毒、模型自动挑选（Krea2 只精确匹配 Qwen3-VL-4B，8B/32B 不参与；VAE 优先 Qwen-Image）、下拉展示排序（krea2 靠前）与 LoRA「自动」建议名、LoRA 缺失告警、参考图（input / data URI）落地、四视图固定 16:9（参考图长边限 1024px、`Krea2EditModelPatch` fit 接线、denoise=1.0、四视图 LoRA 自动追加/去重/缺失报错）、生图张数（设置默认 / 单次覆盖 / 四视图强制 1）、工作流图结构与 sidecar 写入、vendor `krea2_edit` 纯函数单测（RoPE 偏移 / latent fit / 5D 展平）

### 前端回归测试（tests/js）

前端模块在 jsdom + ComfyUI `api`/`app` 替身下加载，用 golden 快照锁定 UI 结构、隐藏控件状态与请求轨迹；重构 `prompt-manager.js` / `node-behavior.js` 前先跑一遍，确认行为有意变化后再重写 golden。

```bash
npm test                 # 比对 tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1，写入新 golden
```

- `smoke.test.mjs` — 模块可导入、节点扩展注册项
- `prompt-manager-dom.test.mjs` — NeoPromptAgent / NeoPrompts 创建后的 UI 结构、body 弹层、隐藏控件状态
- `node-behavior-flows.test.mjs` — 随机取词、Enter 流式生成、skill 路由请求体、@ 标记缺图提示、运行时随机菜单

### JS 测试运行器（带超时强制终止）

**跑 JS 测试必须带 `--test-force-exit`。** 节点创建会启动未清理的 `setInterval`（如 `prompts.js` 的 enforcementInterval），若不带该参数，`node --test` 子进程因 pending timer 使 event loop 永不空闲而无法自然退出——表现为测试已全部通过却卡到超时。因此**不要裸跑 `node --test tests/js/*.test.mjs`**。两个入口都已内置该参数：`npm test`（package.json）与 `pwsh tests/run-tests.ps1`（后者额外提供超时强杀 node 进程树、文件名模糊匹配）。

```powershell
# 跑全部 JS 测试（默认超时 120s）
pwsh tests/run-tests.ps1

# 按文件名模糊匹配（支持多关键词逗号分隔）
pwsh tests/run-tests.ps1 skill-gen-layout
pwsh tests/run-tests.ps1 skill-gen-layout,css-integrity

# 自定义超时秒数
pwsh tests/run-tests.ps1 -Timeout 60
```

退出码：`0` = 全部通过，`1` = 有测试失败 / 无匹配文件，`2` = 超时强制终止。

## 发布

- Registry 元数据在 `pyproject.toml` 的 `[tool.comfy]`（PublisherId `neoneo-ai`，DisplayName `Neo Nodes`）
- `.github/workflows/publish.yaml`：推送 `v*` tag、发布 Release 或手动触发时，通过 `comfy-org/publish-node-action` 发布至 ComfyUI Registry（需要 `COMFY_REGISTRY_PUBLISH_TOKEN` secret）

## 离线工具

`tools/` 下的脚本用于构建/部署素材预设，不在 ComfyUI 运行时加载：

```bash
# 1. 预处理：扫描预设目录，生成缩略图与 index.json（需要 ffmpeg 生成视频缩略图）
python tools/gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]

# 增量模式：只新增/更新指定子目录（源目录中已删除的文件会同步清理），
# 自动从 OSS 拉取最新 index.json（configs/oss_presets.json -> index_url）作为合并基准，
# 其余目录保持不变；--no-fetch-index 改为与本地 index.json 合并，
# --fetch-index <url> 可显式指定其它来源。
# --presets 可省略：默认使用当前工作目录（把新增/更新的目录放在该目录下即可）
cd <dir_with_new_dirs> && python tools/gallery_preprocess.py --output <output_dir> --dirs dir1 dir2

# 2. 部署：上传预处理产物到阿里云 OSS（需要 pip install oss2，
#    凭证从环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT 读取）
python tools/gallery_deploy_oss.py --source <output_dir> --bucket <bucket> --prefix <prefix>
```

部署后的 OSS 源通过 `configs/oss_presets.json` 配置，运行时由 `gallery_oss.py` 拉取到 `gallery/oss_cache/`。