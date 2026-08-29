# ComfyUI-Neo-Nodes

一个 ComfyUI 自定义节点插件：AI 驱动的提示词管理 + 画廊浏览系统。

| 模块 | 类型 | 说明 |
|------|------|------|
| 📝 Neo Prompt Encoder | 节点 | AI 提示词增强 + CLIP 编码 |
| ⚡ Neo Prompt Agent | 节点 | 纯文本输出的轻量提示词生成 |
| 🖼️ Neo Gallery | 侧边栏面板 | 图片/视频画廊浏览与管理 |
| 🍱 Neo Recipes | 侧边栏面板 | 视频配方（提示词 + 多资源）管理与一键发送 |

## 目录

- [安装](#安装)
- [依赖](#依赖)
- [节点](#节点)
  - [Neo Prompt Encoder](#-neo-prompt-encoder---ai-驱动的提示词编码器)
  - [Neo Prompt Agent](#-neo-prompt-agent---简洁版提示词代理)
  - [节点界面与按钮](#节点界面与按钮)
  - [模板与技能管理](#模板与技能管理)
  - [图片反推与图片输入](#图片反推与图片输入)
  - [节点对比](#节点对比)
- [Neo Gallery](#-neo-gallery---侧边栏画廊系统)
  - [浏览与导航](#浏览与导航)
  - [媒体与搜索](#媒体与搜索)
  - [灯箱查看器](#灯箱查看器)
  - [文件管理与目录](#文件管理与目录)
  - [画廊设置](#画廊设置)
- [视频配方](#-视频配方-video-recipes)
- [配置](#配置)
  - [LLM 模式](#llm-模式)
- [本地 LLM 推理安装（可选）](#本地-llm-推理安装可选)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 安装

1. 将此目录克隆或复制到 `ComfyUI/custom_nodes/` 目录
2. 重启 ComfyUI

## 依赖

- `requests`, `Pillow`, `PyYAML`（随 `requirements.txt` 自动安装）
- `llama_cpp_python`（**可选**，仅本地 LLM 推理需要，见下方安装说明；只用远程 API 可跳过）

---

## 本地 LLM 推理安装（可选）

本地 GGUF 模式依赖 `llama-cpp-python`。它默认从源码编译（需要 C 编译器 / CUDA 工具链），Windows 上很容易失败，**推荐直接安装预编译 wheel**。

### 方式一：预编译 wheel（推荐）

到 [JamePeng/llama-cpp-python releases](https://github.com/JamePeng/llama-cpp-python/releases) 下载与你的 **Python 版本 + 系统 + CUDA 版本** 匹配的 wheel 并安装（参考 `llama-cpp_vllm` 等同类插件的推荐做法）：

```bash
# 示例：Python 3.12 + Windows + CUDA 12.4（文件名以 releases 页实际资产为准）
python -m pip install llama_cpp_python-<版本>+cu124-cp312-cp312-win_amd64.whl
```

纯 CPU 也可用官方预编译索引：

```bash
python -m pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
```

### 方式二：源码编译

```bash
# CPU
python -m pip install llama-cpp-python

# NVIDIA GPU（需要先装好 CUDA Toolkit 与 C/C++ 编译器）
# Windows PowerShell:
$env:CMAKE_ARGS = "-DGGML_CUDA=ON"
python -m pip install llama-cpp-python --no-cache-dir
```

### Windows 运行时注意

启动报 `Could not find module '...\ggml.dll'` 时，是缺少 VC++ 运行库：安装 [Microsoft Visual C++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) 后重启 ComfyUI。

### 验证与模型

```bash
python -c "from llama_cpp import Llama; print('ok')"
```

通过后把 GGUF 模型放入模型目录（规范见下文[本地模型目录规范](#本地模型目录规范)），在 Settings → Provider 选「Local GGUF」选择模型即可。

---

## 节点

### 📝 Neo Prompt Encoder - AI 驱动的提示词编码器

完整的提示词管理 + CLIP 编码节点：

- **提示词保存/选择** - 保存和加载预设提示词，支持 presets 和自定义目录
- **LLM 提示词增强** - 使用远程 API 或本地 LLM 模型增强提示词质量
- **快捷生成 / 随机生成** - 输入简短描述快速生成，或一键随机生成创意提示词
- **图片转提示词** - 附加参考图（支持粘贴、拖拽、@ 引用工作流图片），AI 反推生成描述性提示词
- **分类/标题提取** - 保存预设时 AI 自动分类内容并提取标题
- **智能缓存** - CLIP 编码结果本地缓存（最多 50 条），加速重复使用
- **技能系统** - 通过技能选择器调用不同能力，按组分类：图像/反推、任务（含中英互译等指令）、风格模板、自定义

#### 输入/输出

| 输入 | 类型 | 说明 |
|------|------|------|
| clip | CLIP | 文本编码器（必需） |
| text_input | STRING (forceInput) | 外部文本输入 |
| image | IMAGE | 参考图（用于图片转提示词） |

| 输出 | 类型 | 说明 |
|------|------|------|
| POSITIVE | CONDITIONING | 正向编码条件 |
| PROMPT | STRING | 最终提示词文本 |

### ⚡ Neo Prompt Agent - 简洁版提示词代理

轻量级提示词生成节点，专为仅使用生成的提示词文本、不需要替换 CLIP 编码的场景设计：

- **无需 CLIP 输入** - 不绑定文本编码器
- **无状态栏/切换开关** - 界面更简洁
- **仅输出 STRING** - 直接输出提示词文本
- **内置模型设置** - 可在节点内切换 LLM 模型

#### 输入/输出

| 输入 | 类型 | 说明 |
|------|------|------|
| prompt | STRING (forceInput, hidden) | 提示词文本（隐藏） |
| instance_uid | STRING (hidden) | 实例 ID（隐藏） |

| 输出 | 类型 | 说明 |
|------|------|------|
| PROMPT | STRING | 提示词字符串 |

### 节点界面与按钮

两个节点共享同一套界面布局（Agent 不显示状态栏）：

```
┌──────────────────────────────────────┐
│ [LOCAL │ EXTERNAL]        ← 状态栏     │
├──────────────────────────────────────┤
│                             [🎲][☰][💾]│
│         提示词文本编辑区                │
│                                      │
├──────────────────────────────────────┤
│ 快捷输入框（Enter 生成 / Shift+Enter 换行）│
│ [＋][技能选择器][⚙️]      ☐自动生成 [✨] │
└──────────────────────────────────────┘
```

| 控件 | 位置 | 功能 |
|------|------|------|
| LOCAL / EXTERNAL | 顶部状态栏 | 切换本地提示词 / 外部 text_input 输入（连接后自动显示） |
| 🎲 | 文本区右上角 | 随机生成创意提示词 |
| ☰ | 文本区右上角 | 打开预设列表（支持搜索、删除） |
| 💾 | 文本区右上角 | 保存当前提示词为预设，AI 自动提取标题与分类标签 |
| ＋ | 底部输入栏 | 附加参考图片（反推/多模态技能），支持粘贴、拖拽与 @ 引用 |
| 技能选择器 | 底部输入栏 | 选择本次生成使用的技能：图像/反推、任务、风格模板、自定义 |
| ⚙️ | 底部输入栏 | 打开模型设置：切换 LLM 模型、配置远程 API |
| 自动生成 ☐ | 底部输入栏 | 勾选后运行工作流时自动执行生成并实时回填结果 |
| ✨ | 底部输入栏 | 根据快捷输入描述生成提示词 |

### 模板与技能管理

点击节点底部 ⚙️ 打开设置窗口，「📝 Prompt Templates」标签页提供完整的模板管理功能：

- **新建模板** - 点击 "+ New Template"，填写名称与 System Prompt 内容后保存
- **搜索过滤** - 按名称实时过滤模板列表
- **查看 / 编辑** - 点击列表条目或 👁 图标将模板加载到编辑器
- **复制为副本** - 内置模板不可删除，可一键复制为自定义副本后自由修改
- **删除** - 仅用户自定义（USR）模板可删除，内置（SYS）模板受保护
- **自动同步** - 保存、复制、删除后广播更新事件，所有节点上的技能选择器立即刷新

模板以 YAML 文件存储，包含 id、name、tags、content 等字段：

| 来源徽章 | 存储目录 | 说明 |
|----------|----------|------|
| SYS（内置） | `prompts/templates/presets/` | 随插件分发，只读；含通用增强、赛博朋克风格、中国古风、写实摄影、翻译 |
| USR（自定义） | `prompts/templates/custom/` | 用户创建，可编辑、删除 |

节点底部的技能选择器将模板与任务技能统一展示，按用途分组：🖼️ 图像/反推、⚙️ 任务、🎨 风格模板、📝 自定义。选项前缀 📷 表示该技能需要图片输入，📌 表示内置预设。

### 图片反推与图片输入

选用 📷 图像/反推类技能时，可通过以下方式提供参考图片：

| 方式 | 操作 | 说明 |
|------|------|------|
| ＋ 按钮 | 点击输入框旁的 ＋ | 打开文件选择器选取本地图片 |
| 剪贴板粘贴 | `Ctrl+V` 直接粘贴截图/图片 | 自动转 base64 并生成缩略 chip |
| 拖拽导入 | 将本地图片拖入快捷输入框 | 自动读取并生成缩略 chip |
| `@` 引用 | 在输入框中键入 `@` | 唤起选择器，列出当前工作流所有可用 Load Image 节点图片 |

与 Neo 画廊的联动：画廊中「复制到 Input」会把图片放入 ComfyUI 的 input 目录，之后即可在工作流 Load Image 节点中选用，并通过 `@` 选择器引用到反推输入；画廊灯箱的发送按钮也可直接把图片附带的信息回填到 Neo Prompt 节点。

#### `@` 图片引用

在快捷输入框的任意位置键入 `@` 唤起图片选择器，弹层自动定位到光标附近：

- **图片来源** - 自动扫描当前工作流中所有 Load Image 类节点（含 LoadImageOutput 等变体），跳过 BYPASS / 已禁用的节点
- **条目徽章**：
  - `#N` — 该图片已连线到本节点的 IMAGE 输入槽，`N` 为参数位编号；点击或回车后在 `@` 处插入 `<Picture N>` 标记
  - `✓` — 无连线但已附加为反推附件
  - 无徽章 — 未连线图片，点击仅作为反推附件附加，不占用 `<Picture N>` 编号
- **键盘操作** - `↑`/`↓` 移动高亮，`Home`/`End` 跳转首尾，`Enter` 插入选中项，`Esc` 关闭；删除 `@` 字符时弹层自动关闭
- **判重与编号** - 同一图片不会被重复附加；编号由工作流 Load Image 节点的参数顺序决定，与缩略 chip 上的编号徽章保持一致

**缩略 chip 与图片标记**

- 附加的图片以缩略 chip 形式显示在快捷输入框上方
- 悬停 chip 可放大预览原图
- 带 `N` 编号徽章的 chip 对应正文中的 `<Picture N>` 标记，用于描述多张图片之间的交互
- 无编号 chip 仅作为反推附件随请求发送
- 点击 chip 上的 ✕ 可移除对应图片

### 节点对比

| 特性 | Neo Prompt Encoder | Neo Prompt Agent |
|------|-------------------|---------------------|
| CLIP 输入 | ✅ 需要 | ❌ 不需要 |
| 状态栏 (status bar) | ✅ 显示 | ❌ 隐藏 |
| Toggle Switch | ✅ 支持 | ❌ 无 |
| 外部文本输入 | ✅ 支持 | ❌ 不支持 |
| 输出类型 | CONDITIONING + STRING | STRING |
| 适用场景 | 标准文生图工作流 | 仅需提示词文本的场景 |

---

## 🍱 视频配方 (Video Recipes)

提示词 + 多输入资源（一个或多个图片/视频）的组合配方，供视频多参考工作流复用。配方分为 **custom（用户保存）** 与 **presets（内置预设，只读）** 两个目录，每个配方是一个文件夹 + `assets/` 资源夹：

```
recipes/
├── custom/                      # 用户保存的配方（💾 保存写入这里，可删除）
│   └── <配方名>/
│       ├── recipe.json          # 元数据：name / prompt / created_at / assets
│       └── assets/              # 多输入资源（图片/视频，文生图配方可空）
└── presets/                     # 内置预设配方（只读，不可删除）
    └── <配方名>/
        ├── recipe.json
        └── assets/
```

### 保存为配方

在 **Neo Prompt Agent** 节点上点击 💾 保存按钮，弹窗顶部选择「🍱 配方」模式（默认「📝 提示词」为普通预设保存），命名确认后会收集当前工作流里的所有 `LoadImage` / `LoadVideo` 资源与节点上的提示词，保存为一个配方。配方模式下跳过 AI 标题/标签分析，弹窗内会实时显示收集到的资源数量。

资源顺序按 **@ chips 编码逻辑**记录：有参数位的资源（输出连到目标节点 `IMAGE` / `VIDEO` 输入槽）按参数序号排列在前，未连线资源按图序在后，图片组在前、视频组在后；禁用（BYPASS / NEVER）状态的节点不参与收集。

配方始终保存到 `recipes/custom/`；与内置预设同名的保存会被拒绝。侧边栏配方页按「我的配方 / 内置预设」分组展示，🗑 仅可删除自定义配方。旧版直接放在 `recipes/` 下的配方会在启动时自动迁移到 `custom/`。节点上的预设列表同样并入配方条目，与提示词统一按修改时间降序排序，以立方体图标区分，点击回填提示词并像侧边栏一样按参数位还原资源，自定义配方可在列表中直接删除。点击卡片缩略图或标题可打开详情浮层，查看完整标题、完整提示词与全部资源（视频可直接预览），浮层内也可直接发送到工作流。

### 一键发送到工作流

在右侧边栏 **配方** 标签页中点击配方的 ✈️，将：

- 依序把各资源复制进 Comfy `input/`（去重 + 重名后缀处理）
- 按**保存时的参数位**反解还原：连线节点按参数序号与配方资产逐一配对，资产精确落回原参数位置；未连线节点作为备用槽承接剩余资产
- 跳过禁用（BYPASS / NEVER）状态的节点，不改动其控件
- 把配方提示词写入可用的 Neo Prompt 节点

---
## 🖼️ Neo Gallery - 侧边栏画廊系统

ComfyUI 右侧边栏中的图片/视频浏览与管理面板：内置预设库 + 多个用户自定义目录。

### 浏览与导航

- **侧边栏集成** - 作为右侧边栏标签页打开，无需离开画布
- **卡片布局** - 目录以分类卡片呈现，封面网格直观预览各目录内容
- **面包屑导航** - 多级子目录层级清晰，随时返回上级
- **按时间排序** - 按文件修改时间排序，可切换新旧顺序并记住偏好
- **滚动位置记忆** - 自动保存每个目录的浏览位置，切回时原地恢复
- **懒加载** - 列表分页渲染、封面滚动进入视口才加载，大图库依然流畅

### 媒体与搜索

- **图片与视频** - 支持 jpg/png/webp/gif 等图片和 mp4/webm 等视频的混合浏览
- **缩略图缓存** - 首次访问自动生成缩略图，再次打开即秒出
- **关键词搜索** - 跨目录搜索文件名及同名 `.txt` 描述文件的内容

### 灯箱查看器

点击缩略图进入全屏查看，支持滚轮缩放与拖拽平移：

| 按钮 | 功能 |
|------|------|
| ✈️ Send | 将图片发送到工作流节点（弹出目标选择菜单，LoadImage 类节点优先排列） |
| 📥 Video | 将视频发送到 Load Video 类节点的视频下拉框 |
| ⧉ Copy | 复制图片配套的提示词文本 |
| 🔍 反推 | 调用 LLM 对当前图片反推提示词（处理中显示进度状态） |

### 文件管理与目录

- **删除** - 直接删除画廊中的媒体文件；presets 内置库只读保护，防止误删
- **自定义目录** - 在设置中添加本地或网络路径，支持逐条添加，也支持批量粘贴（每行一个路径）
- **多源汇总** - 所有目录统一入口浏览，互不干扰

### 画廊设置

在侧边栏顶部点击"设置"按钮可管理自定义目录；以下显示设置位于 ComfyUI 设置面板：

| 设置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| Neo Gallery Max Thumbnail Size | 滑块 (150-500) | 320 | 缩略图最大尺寸（像素） |
| Neo Gallery Display Image Labels | 开关 | true | 是否显示图片名称标签 |

---

## 配置

### LLM 模式

两个提示词节点共用同一套 LLM 运行模式：

| 模式 | 说明 | 要求 |
|------|------|------|
| Remote (远程) | 通过 API 调用云端大模型 | 在节点 Settings 中配置 API Key 和端点 |
| Local (本地) | 使用 llama.cpp 在本地推理 | 放置 GGUF 模型到目录并在 Settings → Provider 选「Local GGUF」后选择模型 |

### 本地模型目录规范

路径按 `供应商(可选)/模型名称/模型文件(.gguf)` 组织，例如：

```
models/LLM/
├── mradermacher/Qwen3-4B-AWQ-I4_K_M/GGUF-Q4_0-int4-v2-scratch.gguf   # 单文件直接放根目录即可
├── stablelm/stablelm2-1.6B.gguf                                      # 平铺布局同样支持
└── mradermacher/Huihui-gemma-4-E4B-it-abliterated-GGUF/
    ├── Huihui-gemma-4-E4B-it-abliterated-Q4_K_M.gguf                 # 主模型文件（任意量化）
    └── Huihui-gemma-...mmproj-f16.gguf                               # 投影文件（自动匹配，见下）
```

设置说明：

| 项目 | 说明 |
|------|------|
| 目录位置 | Settings → Provider 选 `Local GGUF` 后出现的 **Models Dir**；留空默认扫描 `models/LLM/`，也可填任意本地路径（如 LM Studio 的 `<用户>/.lmstudio/models`） |
| 模型列表 | 递归扫描该目录下所有 `.gguf`，下拉框只显示**模型名称**（文件名去掉 `.gguf`），不同供应商同名文件各自成项 |
| 多模态标识 | 某模型同目录中存在 `mmproj-*.gguf`（或 `<模型名>.mmproj-f16.gguf`）时，该模型名称前会出现 🖼️ 徽标，表示可用于图片反推；多个候选时不猜测、留空待匹配 |

---

## 项目结构

```
ComfyUI-Neo-Nodes/
├── gallery.py              # 画廊后端 API + 路由
├── recipes.py              # 视频配方后端 API（提示词 + 多资源组合）
├── prompts.py              # 提示词节点核心逻辑
├── llm.py                  # LLM 推理（远程/本地）
├── requirements.txt        # Python 依赖
├── gallery_settings.json   # 画廊自定义目录配置
├── recipes/                # 配方预设目录（每配方一个文件夹 + assets/）
├── prompts/                # 提示词预设和模板目录
│   ├── presets/            # 预设提示词
│   ├── custom/             # 用户自定义提示词
│   └── templates/          # 系统提示词模板
├── gallery/                # 画廊媒体文件目录
│   ├── presets/            # 内置预设图片
│   ├── custom/             # 用户自定义图片
│   └── thumbnails/         # 缩略图缓存
└── web/                    # 前端资源
    ├── gallery.js          # 画廊主逻辑
    ├── gallery-components.js  # 画廊 UI 组件
    ├── gallery-utils.js    # 画廊工具函数
    ├── gallery.css         # 画廊样式
    ├── recipes.js          # 视频配方逻辑（保存/面板/一键发送）
    ├── recipes.css         # 视频配方样式
    ├── prompts.js          # 提示词节点前端交互
    ├── prompts.css         # 提示词节点样式
    ├── prompt-manager.js   # 提示词管理器
    └── prompt-service.js   # 提示词 API 服务
```

### 引用参考
collections portrait 10000+精美提示词来源
https://civitai.com/models/2231696/sfw15000-and-qwen-and-z-image-or-15000-portrait-and-selfie-wildcards-for-qwen-and-z-image

---

## 许可证

SPDX-License-Identifier: Apache-2.0