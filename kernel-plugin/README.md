# Neo Studio — ComfyUI 内核插件

Neo Studio 的 ComfyUI 侧插件：提示词、生图、视频、素材与配方相关的全部节点，`/neo-studio` 页面所需的前端资源，
以及 Gallery / Recipes / Model Hub / 工作流修复等 API 路由。桌面壳（应用仓库 `Neo-Studio`）负责拉起 ComfyUI
与数据目录，本插件在 ComfyUI 进程内运行，单独安装也能用。

完整说明见应用仓库：https://github.com/neoneo-ai/Neo-Studio

## 安装

- **ComfyUI Manager**：搜索 `Neo Studio` 一键安装。
- **comfy CLI**：`comfy node install comfyui-neo-studio`。
- **手动**：把本目录放到 `ComfyUI/custom_nodes/comfyui-neo-studio`，重启 ComfyUI。
  目录名必须与之一致——ComfyUI 按目录名挂前端资源，URL 前缀是 `/extensions/comfyui-neo-studio/`。

从旧版 `comfyui-neo-nodes` 升级时，先删掉 `custom_nodes/ComfyUI-Neo-Nodes` 再装本包：包名换了，
两个目录同时存在会把同一批节点注册两遍。

## 依赖

`requirements.txt`：`openai`、`PyYAML`、`pypinyin`、`Pillow`（Pillow 由 ComfyUI 核心自带）。
可选增强，缺包时对应功能自行降级：`laya`（智能 skill 选择）、`pillow-heif`（HEIC 读取）、
`oss2`（Backyard OSS 上传）、`llama_cpp_python`（Local GGUF 本地推理）。

## 数据目录

用户数据（gallery / recipes / prompts / skills / configs）不随插件目录走，解析顺序：

1. 环境变量 `NEO_STUDIO_DATA`（桌面壳拉起 ComfyUI 时注入）；
2. 插件目录里的指针 `configs/data_root.json`（壳写入，用户自己启动 ComfyUI 时也认得）；
3. 两者都落空才回退插件目录本身——单独安装、测试里临时造目录走这条。

数据根第一次使用时，插件目录里的内置预设（`configs/`、`prompts/presets/`、`skills/presets/`、
`skills/tasks/`、`recipes/presets/`）会补进去，只补缺失文件，用户改过的不覆盖。

## 节点文档

逐节点的参数与用法在本目录的 `web/docs/` 里，ComfyUI 里点节点的帮助按钮也是打开它们
（文件名即节点键，与下表第一列一致）：

| 节点键 | 文档 |
| --- | --- |
| `NeoPromptEncoder` | `web/docs/NeoPromptEncoder.md` |
| `NeoPromptAgent` | `web/docs/NeoPromptAgent.md` |
| `NeoImageGenEdit` | `web/docs/NeoImageGenEdit.md` |
| `NeoRefGrid` | `web/docs/NeoRefGrid.md` |
| `NeoGridSplit` | `web/docs/NeoGridSplit.md` |
| `NeoBundleExpand` | `web/docs/NeoBundleExpand.md` |
| `NeoH3VideoDirector` | `web/docs/NeoH3VideoDirector.md` |
| `NeoH3AddKeyframe` | `web/docs/NeoH3AddKeyframe.md` |
| `NeoH3AddContext` | `web/docs/NeoH3AddContext.md` |
| `NeoH3AddGuides` | `web/docs/NeoH3AddGuides.md` |
| `NeoH3SegmentRun` | `web/docs/NeoH3SegmentRun.md` |

## 许可证

Apache-2.0，见 `LICENSE`。
