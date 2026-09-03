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
├── prompt_lines.py         # 提示词文本行解析（预设列表行 / 随机候选）
├── util.py                 # 媒体扩展名常量与共享工具（媒体探测、元数据、提示词文本收集）
├── requirements.txt        # Python 依赖（requests / Pillow / PyYAML）
├── pyproject.toml          # ComfyUI Registry 发布元数据（[tool.comfy]）
├── pytest.ini              # 测试配置（testpaths = tests）
├── configs/                # 运行时配置
│   ├── remote_llm_config.json  # 远程 LLM 配置（按 provider 分槽；.gitignore 不入库）
│   ├── oss_presets.json        # OSS 预设素材源配置
│   ├── gallery_settings.json   # 画廊自定义目录与 Civitai 设置（API KEY 脱敏显示；.gitignore 不入库）
│   └── bookmarks.json          # 本地收藏：仅存路径信息，不复制文件（.gitignore 不入库）
├── locals/                 # 本地化资源（zh_CN.json）
├── prompts/                # 提示词与模板目录
│   ├── presets/            # 内置提示词预设（.txt，含 collections/、video/ 子集）
│   ├── custom/             # 用户自定义提示词（.gitignore 不入库）
│   └── templates/          # 模板/技能 YAML
│       ├── presets/        # 内置风格模板（SYS）
│       ├── tasks/          # 内置任务技能（extract_title / reverse_prompt 等）
│       └── custom/         # 用户自定义模板（USR，.gitignore 不入库）
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
├── tests/                  # pytest 单元测试
│   ├── test_llm.py         # LLM 配置/下载/缓存/语言检测/文本规范化
│   ├── test_skills.py      # 技能扫描、图片解码、多结果解析
│   └── test_workflow_repair.py # 工作流修复匹配算法
├── web/                    # 前端资源（WEB_DIRECTORY）
│   ├── gallery.js          # 素材侧边栏主逻辑
│   ├── gallery-components.js  # 素材 UI 组件
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
│   ├── prompt-manager.js   # 提示词管理器（预设/模板/设置窗口）
│   └── prompt-service.js   # 提示词 API 服务封装
└── .github/workflows/
    └── publish.yaml        # 发布 ComfyUI Registry 的 GitHub Action
```

## 后端模块

| 模块 | 职责 |
|------|------|
| `__init__.py` | 插件入口。导入 `gallery` / `recipes` / `workflow` 模块以注册各自的 API 路由，从 `prompts.py` 合并 `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`，声明 `WEB_DIRECTORY = "./web"` |
| `prompts.py` | 两个提示词节点（`NeoPrompts` → Neo Prompt Encoder，`NeoPromptAgent` → Neo Prompt Agent）与 `/rs_prompts/*` 全部路由：预设提示词 CRUD、LLM 模型切换、模板/技能扫描（`_scan_skills`）、图片解析（`resolve_image_bytes`）、标签索引 |
| `llm.py` | LLM 推理层：`RemoteLLMClient`（OpenAI 兼容 HTTP）、`LLMSingleton`（进程内 llama.cpp GGUF，含 mmproj 多模态绑定与自动卸载）、远程配置存取（`configs/remote_llm_config.json`，按 provider 分槽）、模型目录扫描（`scan_llm_directory`）、任务模板加载（`prompts/templates/` YAML）与流式/非流式执行 |
| `gallery.py` | Neo Gallery 素材后端：预设/自定义/系统（input、output）目录聚合浏览、缩略图生成与缓存、媒体文件服务、上传/删除、目录设置（`gallery_settings.json`）。导入时加载 `gallery_lora` / `gallery_oss` 以注册其路由 |
| `gallery_lora.py` | Civitai LORA 示例后台抓取队列：打开 Lora 目录时按文件 SHA256 查询并下载示例图 + 提示词 sidecar，缓存于 `gallery/lora_cache/` |
| `gallery_oss.py` | 云端预设（OSS）素材：按 `configs/oss_presets.json` 拉取索引与文件到 `gallery/oss_cache/`，提供缩略图/媒体回退服务 |
| `recipes.py` | 配方后端：配方 CRUD、assets 资源服务、示例结果追加/删除、工作流快照备份与 `send_to_workflow` 复制 |
| `workflow.py` | 工作流模型路径修复：高置信度匹配算法（`repair_workflow`）、手动修复映射存储（`user/neo_repair_mappings.json`）、`/neo_nodes/repair*` 路由 |
| `prompt_lines.py` | 提示词文本行解析：将预设/合集 .txt 拆为（标题，内容）条目，供预设列表与随机候选使用 |
| `util.py` | 媒体扩展名常量（IMG/VIDEO/AUDIO）与共享工具：目录媒体探测、媒体元数据提取、配方提示词文本收集。独立于路由模块以避免导入循环 |

## 前端资源

`web/` 由 ComfyUI 自动加载（`WEB_DIRECTORY`）：

| 文件 | 职责 |
|------|------|
| `gallery.js` / `gallery-components.js` / `gallery-utils.js` / `gallery.css` | 素材侧边栏：目录卡片、懒加载列表、搜索、上传删除、设置弹窗 |
| `lightbox.js` / `lightbox.css` | 灯箱全屏查看：缩放平移、发送节点、复制提示词、反推 |
| `node-behavior.js` | 节点级交互行为（拖拽图片、粘贴、`@` 引用等） |
| `combo-box.js` | 通用下拉选择组件 |
| `recipes.js` / `recipes.css` | 配方侧边栏面板：保存弹窗、卡片、详情浮层、一键发送 |
| `workflow.js` | 工作流修复：`/neo_nodes/repair` 请求、确认弹窗（手动选择 + 记住映射）、修复记录日志、顶栏「修复工作流」/「修复记录」按钮 |
| `prompts.js` / `prompts.css` | 提示词节点界面：状态栏、文本区、快捷输入栏、技能选择器、图片 chip |
| `prompt-manager.js` | 提示词管理器：预设列表、模板管理、模型设置（远程 API / 本地模型）窗口 |
| `prompt-service.js` | `/rs_prompts/*` API 的前端封装 |

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
| GET | `/rs_prompts/list_templates` | 模板列表 |
| GET | `/rs_prompts/skills` | 技能列表（模板 + 任务分组） |
| POST | `/rs_prompts/load_template` | 读取模板 |
| POST | `/rs_prompts/save_template` | 新建/更新模板 |
| POST | `/rs_prompts/delete_template` | 删除模板（仅 USR） |

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
| `prompts/templates/presets/` | 内置风格模板（SYS，YAML：id / name / tags / content） |
| `prompts/templates/tasks/` | 内置任务技能 YAML（extract_title / extract_classify / reverse_prompt / smart_prompt / template_prompt / translate_prompt） |
| `prompts/templates/custom/` | 用户自定义模板（USR，可编辑删除） |
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
- `tests/test_skills.py` — 技能扫描与分组、内置任务技能存在性、图片解码缩放、多结果解析（分隔符 / JSON 数组）
- `tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确/归一化匹配、量化变体替换、歧义拒绝、扩展名约束

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