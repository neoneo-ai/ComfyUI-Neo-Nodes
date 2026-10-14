# Neo Studio — ComfyUI kernel plugin

> 🇨🇳 中文: [README_ZH.md](README_ZH.md)

The ComfyUI-side plugin of Neo Studio: every node for prompts, image generation, video, assets and recipes, the
frontend resources the `/neo-studio` page needs, and the Gallery / Recipes / Model Hub / workflow-repair API
routes. The desktop shell (the application repository `Neo-Studio`) is responsible for launching ComfyUI and the
data directories; this plugin runs inside the ComfyUI process and works when installed on its own.

Full documentation lives in the application repository: https://github.com/neoneo-ai/Neo-Studio

## Installation

- **ComfyUI Manager**: search `Neo Studio` for a one-click install.
- **comfy CLI**: `comfy node install comfyui-neo-studio`.
- **Manual**: put this directory at `ComfyUI/custom_nodes/comfyui-neo-studio` and restart ComfyUI.
  The directory name must match exactly — ComfyUI mounts frontend resources by directory name, and the URL prefix
  is `/extensions/comfyui-neo-studio/`.

When upgrading from the old `comfyui-neo-nodes`, delete `custom_nodes/ComfyUI-Neo-Nodes` before installing this
package: the package name changed, and having both directories registers the same nodes twice.

## Dependencies

`requirements.txt`: `openai`, `PyYAML`, `pypinyin`, `Pillow` (Pillow ships with ComfyUI core).
Optional enhancements; the matching feature degrades on its own when a package is missing: `laya` (smart skill
selection), `pillow-heif` (HEIC reading), `oss2` (Backyard OSS upload), `llama_cpp_python` (Local GGUF local
inference).

## Data directories

User data (gallery / recipes / prompts / skills / configs) does not travel with the plugin directory. Resolution
order:

1. the `NEO_STUDIO_DATA` environment variable (injected when the desktop shell launches ComfyUI);
2. the pointer `configs/data_root.json` inside the plugin directory (written by the shell, honored when you start
   ComfyUI yourself);
3. only when both are missing does it fall back to the plugin directory itself — the path taken by standalone
   installs and by tests that create a temporary directory.

On first use of a data root, the built-in presets from the plugin directory (`configs/`, `prompts/presets/`,
`skills/presets/`, `skills/tasks/`, `recipes/presets/`) are seeded into it; only missing files are added, and
anything the user changed is never overwritten.

## Node documentation

Per-node parameters and usage live in `web/docs/` of this directory, and the help button on a node in ComfyUI
opens them (the file name is the node key, matching the first column below):

| Node key | Document |
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

## License

Apache-2.0, see `LICENSE`.
