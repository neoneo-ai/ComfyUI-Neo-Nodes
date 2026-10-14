# Neo Studio

> 🇨🇳 中文: [README_ZH.md](README_ZH.md)

**From one sentence to prompt, image, and film**: AI prompt enhancement, image generation and reference editing,
and MiniMax H3 multi-segment video direction — all in one plugin. The LLM can run inside the ComfyUI process
with zero extra dependencies.

![One-click recipe send to workflow](docs/assets/images/hero-recipes-send.gif)

**Install**: search `Neo Studio` in ComfyUI Manager (published to the ComfyUI Registry), see [Installation](#installation).

## Why Neo Studio

| Capability | Usual approach | Neo Studio |
|------------|----------------|-----------|
| Local LLM | Needs `llama-cpp-python` (often fails to build on Windows) | **Native**: safetensors text-generation models run inside the ComfyUI process, no extra dependency |
| Cloud LLM | Fill endpoint and model name by hand | Built-in DeepSeek, Alibaba Cloud Bailian, Kimi, Zhipu GLM, SiliconFlow — add an API key and go; 🔌 Test Connection verifies live |
| Model downloads | Download manually, then drag files into folders | ModelScope + Hugging Face dual-source search, files land in the right model folder by repo path, resumable downloads |
| Chinese input | English / filename matching only | Chinese skill names searchable by full pinyin and initials; pinyin LoRA trigger-word suggestions |
| Image / video generation | Wire up dozens of nodes | Pick a skill and generate (skills ship a `workflow.json` template); H3 multi-segment director with drag-and-reorder timeline |
| After moving machines | Red nodes everywhere, fix paths one by one | 🅝 menu → "Repair Workflow" matches broken paths against real files on disk in one click |
| Asset reuse | Pick images one by one with LoadImage | Gallery lightbox + ✈️ one-click write into a target node; recipes send to canvas in one click |

## Works without an LLM

Available right after install and restart, with no model or API key configured:

- **🖼️ Neo Gallery** — asset browsing, lightbox, file management, ✈️ one-click send to node; Civitai LoRA matching and bookmarks; batch LoRA tagging
- **🧊 Neo Recipes** — save prompt + media as a recipe, one-click send to workflow (with director recipe editor)
- **🔧 Workflow Repair** — one-click fix for broken model paths
- **📥 Model Hub** — ModelScope / Hugging Face dual-source search with resumable downloads (ModelScope listing and search work anonymously)
- **🔲 Neo Reference Grid / 🧩 Neo Grid Split** — reference-image grid management, automatic storyboard grid splitting
- **🧊 Neo Studio** — standalone page (`neo-studio.bat` or `http://127.0.0.1:8188/neo-studio`; `neo-studio-app.bat` opens it in its own window): Assets, Director, Skills, Settings

LLM enhancement (✨ generate / image captioning / translate & classify) is the optional second step;
the three modes are documented in [docs/en/llm.md](docs/en/llm.md).

## Features

| Module | Type | Description |
|--------|------|-------------|
| Neo Prompt Encoder | Node | Prompt management + AI enhancement (presets / search / LLM enhance). Outputs CONDITIONING + text for standard txt2img samplers. |
| Neo Prompt Agent | Node | Prompt management + AI generation without CLIP. Outputs PROMPT text + BUNDLE runtime package (connects directly to Krea2 / H3 video). |
| Neo Image Gen & Edit | Node | Synchronous image generation / reference editing based on selected skill template. Outputs IMAGE tensor directly to downstream nodes. |
| H3 Video Director | Node | MiniMax H3 multi-segment video generation with native audio. Per-segment skill/prompt/duration/first-last-frame/reference control. Timeline editor for drag-reorder and batch prompt optimization. |
| Neo Bundle Expand | Node | Expands BUNDLE into `prompt` + `image_1..9` for official MiniMax H3 Reference-to-Video nodes. |
| Neo Reference Grid | Node | Prompt + up to 12 reference images in a single grid node. Auto-growing output slots. |
| Neo Grid Split | Node | Splits a storyboard grid image into individual cells (IMAGE batch) + embedded prompt text. |
| Neo Gallery | Sidebar | Image/video/audio asset browser: presets, custom directories, Civitai LoRA matching, lightbox preview, one-click send-to-node, LoRA batch tagging. |
| Bookmarks | Asset panel | Local bookmarks (path-based) + Civitai bookmarks (download-on-open). |
| Neo Recipes | Sidebar | Recipe (prompt + media assets) management with one-click send to workflow. |
| Workflow Repair | Menu item | One-click fix for broken model paths after moving machines or changing directories. |
| Model Hub | Menu item | Search Comfy-Org repos on ModelScope / Hugging Face and download models into the right model folders, with resumable downloads. |
| Skill Management | Menu item | Skill detail page (settings + prompt + workflow area): import to canvas, write back to skill, inline workflow editing — each save shows a change preview first and records a local history. Presets are read-only; copy to customize. |

Node appearance:

![Neo image generation and editing nodes on the canvas](docs/assets/images/image-gen-edit.png)
![Neo image processing nodes on the canvas](docs/assets/images/image-process.png)
![Neo video generation nodes on the canvas](docs/assets/images/vide-gen.png)

## Demo

Interaction recordings (click a thumbnail to open the matching doc):

- [![Drag-and-reorder multi-segment director timeline](docs/assets/images/hero-director-timeline.gif)](docs/en/h3-video-gen.md)
  — 🎞️ H3 Video Director · timeline reorder
- [![One-click recipe send to workflow](docs/assets/images/neo-recipes-send.gif)](docs/en/recipes.md) — 🧊 Neo Recipes · one-click send

## Installation

- **ComfyUI Manager (recommended)**: Search `Neo Studio` in the Manager and install.
- **comfy CLI**: `comfy node install comfyui-neo-studio`
- **Source install**: `tools/install_plugin.ps1` copies code and built-in presets into
  `ComfyUI/custom_nodes/comfyui-neo-studio`, and writes the data-root pointer
  `configs/data_root.json` (user data stays in `Neo-Studio/data`; uninstall = delete the plugin dir):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/install_plugin.ps1 -ComfyUI D:\ComfyUI -DataRoot D:\Neo-Studio\data
```

  The desktop shell syncs those files on its own: running `neo-studio-app.vbs` from source copies
  `kernel-plugin/` into `custom_nodes/comfyui-neo-studio` at every launch — no manual copy step.

- **Manual**: Clone into `ComfyUI/custom_nodes/`:

```bash
git clone https://github.com/neoneo-ai/Neo-Studio.git ComfyUI/custom_nodes/comfyui-neo-studio
```

- **Desktop app**: `tools/build_studio_exe.ps1` produces `tools/neo-studio.exe` (onefile) or the
  `-Mode onedir` folder build. Release switches `-Sign` (signtool), `-Notarize` (macOS notarytool)
  and `-Publish` (comfy node publish) do nothing unless passed.

> **Upgrading from the old package**: the Registry package moved from `comfyui-neo-nodes` to
> `comfyui-neo-studio`. Delete `ComfyUI/custom_nodes/ComfyUI-Neo-Nodes` before installing the new one —
> keeping both directories registers the same nodes twice. User data does not live in the plugin
> directory, so removing the old folder touches no data.

Then restart ComfyUI.

## Dependencies

- `openai`, `PyYAML`, `pypinyin`, `Pillow` (auto-installed via `requirements.txt`; Pillow ships with ComfyUI core)
- Optional extras (features degrade gracefully when a package is missing): `laya` (smart skill picking),
  `pillow-heif` (HEIC reading), `oss2` (Backyard OSS upload)
- `llama_cpp_python` (**optional**, only for local LLM inference)

## Quick Start

1. **Install** the plugin and restart ComfyUI.
2. **Use the zero-config features first** (no LLM, no model setup needed):
   - **Send asset to node**: Gallery sidebar → browse/search an image → click thumbnail for lightbox → click ✈️ Send → choose target node (LoadImage-type nodes first) → the image is written into that node.
   - **Model Hub downloads**: 🅝 menu → "Model Hub" → pick source (ModelScope / Hugging Face) → search → pick a file → category and subfolder are filled in automatically → ⬇ download, resumable.
   - **Repair workflow paths**: after moving machines, 🅝 menu → "Repair Workflow" → confirm candidate paths (editable, threshold adjustable) → apply in place.
3. **Configure LLM** (pick one; needed for ✨ enhancement, image captioning, translate/classify):
   - *Native*: Place a safetensors text-generation model (e.g. `qwen3.5_4b_bf16.safetensors`) in `models/text_encoders/`, select "Native (ComfyUI safetensors)" in Settings → Provider, pick the model and click 💾 Save. Inference runs inside the ComfyUI process, so no extra dependency is needed. Details: [docs/en/llm.md](docs/en/llm.md).
   - *Remote*: Settings → select Provider (DeepSeek, Qwen, Kimi, GLM, SiliconFlow, OpenAI-compatible, LM Studio, Ollama, OpenRouter, etc.) → enter API Key + endpoint. "🔌 Test Connection" sends "hello" with the values currently in the form (no need to save first). Endpoints and sign-up links: [docs/en/llm.md](docs/en/llm.md).
   - *Local*: Place a GGUF model in `models/LLM/`, select "Local GGUF" in Settings, pick the model and click 💾 Save (skip the selection when the folder holds a single model — it is used automatically). Install and folder rules: [docs/en/llm.md](docs/en/llm.md).
4. **First prompt**: Add a **Neo Prompt Agent** node → type a short description → click ✨ → get AI-generated prompt text (no CLIP needed).
5. **First image**: Add a **Neo Image Gen & Edit** node → select an image-gen skill → connect prompt (from Agent or manual) and optional reference images → queue → IMAGE output.

   > Image generation needs a GPU / VRAM, and the selected skill must declare `gen_image: true` and ship a `workflow.json`.
   > Generation model / Text Encoder / VAE default to "Auto", matched against the skill template; set them manually only when nothing matches.

6. **First multi-segment video**: Add a **H3 Video Director** node → pick a `video_director` recipe
   → drag to reorder segments / regenerate a single segment → segments are generated and stitched into one `VIDEO` with audio.

## Key Concepts

- **Skill**: A bundled template containing model config (model/VAE/CLIP), workflow, and default parameters. Preset skills are read-only; copy to customize.
- **Bundle**: Runtime payload — prompt text + optional reference images.
- **Recipe**: Saved prompt + media assets for reuse. *Director recipes* support multi-segment video generation with a timeline editor.

## Neo Studio (Standalone App)

Canvas-independent page with four tabs: **Assets** (the full Gallery), **Director** (director recipes + editor +
full-film generation with progress, cancel and live preview), **Skills**, **Settings** (image / video / LLM /
ComfyUI log). Canvas-only actions show a hint instead of failing.

### Entry points

| Entry | What it does |
|-------|--------------|
| `neo-studio.bat` | Opens `http://127.0.0.1:8188/neo-studio` in the browser, and starts ComfyUI for you |
| `neo-studio-app.vbs` | The same page in its own WebView2 window — no console, no browser tab; window geometry and Studio state survive restarts (needs `pywebview`; the WebView2 Runtime ships with Windows) |
| `neo-studio-app.bat` | Console/debug entry for the same window (`--debug` opens DevTools) |
| `tools/neo-studio.exe` | Packaged launcher with the clapperboard icon — see [Build the launcher](#build-the-launcher) |

ComfyUI's log is under Settings → Log; the shell's own trace (startup, page jumps, window drags) goes to
`tmp/studio_shell.log`.

### The shell is a launcher, not just a viewer

- **Offline service** — `neo_studio_server.py` on ComfyUI port + 3 (`8191` by default) keeps browsing, skill /
  recipe editing, settings (LLM included), Model Hub, bookmarks and LoRA tagging working while ComfyUI is down.
  Anything that needs the ComfyUI runtime answers `409 offline`, the UI says "needs ComfyUI", and the generate
  buttons become start buttons.
- **The header only reports state** — "● Running" / "● Stopped" / "● Starting", with the port, the PID and who
  launched it in the tooltip. The actions live at the top of Settings → 启动设置: one state line plus
  "▶ Start kernel" and "■ Stop kernel", the one that cannot run right now disabled.
- **The window opens first** — the dependency self-check, the service setup and the ComfyUI spawn run on a
  background thread behind a splash page; the page jumps to the full Studio once the port answers, and stopping
  ComfyUI pulls it back to the offline library.
- **Closing the window** stops the ComfyUI the shell started (one you started yourself is left alone).

### Window & icon

- Window and taskbar icon: the clapperboard `web/neo-studio.ico` (`tools/make_studio_icon.py`).
- The `无边框窗口` switch (on by default) drops the system title bar: the header carries minimize / maximize /
  fullscreen / close, and pressing its empty area drags the window; geometry is saved on close, and maximize
  fills the work area without covering the task bar. The version string lives in Settings → 关于.
- "⤒ 主画布编辑" and "🎬 新影工坊" jump between the canvas and Studio inside this window (no browser tab);
  the shell re-injects a "🎬 返回 Studio" pill on every non-Studio page.

### Build the launcher

`tools\build_studio_exe.ps1` packages the shell as `tools/neo-studio.exe` (single file; `-Mode onedir` emits
the folder build, `-Mode both` emits both; build-time dependency `pyinstaller`, the artifact never ships in
the Registry). **Rebuild the exe after changing `neo_studio_app.py`.**

The exe doubles as a portable launcher:

- It derives the ComfyUI root and interpreter from its own location, opens a first-setup page when it cannot,
  and installs or updates the plugin from its bundled copy — user data dirs are carried over, a git checkout
  is never touched.
- Running from source syncs `kernel-plugin/` into `custom_nodes` on every launch (same-name files only,
  nothing in the target is deleted).
- The shell-only `启动设置` tab starts and stops the kernel at its top, then edits the root, the interpreter
  and the port, and reports the self-check state.

## Documentation

Full index: [docs/en/README.md](docs/en/README.md).

| Doc | Content |
|-----|---------|
| [docs/en/prompts.md](docs/en/prompts.md) | Prompt nodes, UI buttons, image captioning, `@` references |
| [docs/en/skills.md](docs/en/skills.md) | Skill management: manager window, workflow editing, canvas import & writeback |
| [docs/en/llm.md](docs/en/llm.md) | LLM modes (native / remote / local), thinking models, GGUF setup |
| [docs/en/image-gen.md](docs/en/image-gen.md) | Image generation & editing nodes |
| [docs/en/h3-video-gen.md](docs/en/h3-video-gen.md) | Video generation: director recipe execution, single-segment regeneration, grid split |
| [docs/en/recipes.md](docs/en/recipes.md) | Recipe management, one-click send, director recipes |
| [docs/en/gallery.md](docs/en/gallery.md) | Gallery browser, lightbox, file management, bookmarks |
| [docs/en/workflow-repair.md](docs/en/workflow-repair.md) | Workflow model path repair |
| [docs/en/model-hub.md](docs/en/model-hub.md) | Model Hub: dual-source repo search, category placement, resumable downloads |

## Changelog

Version history: [CHANGELOG.md](CHANGELOG.md).

## License

SPDX-License-Identifier: Apache-2.0

## Credits

10000+ portrait prompt collection source:
[civitai.com/models/2231696](https://civitai.com/models/2231696)

## Developer Docs

Project structure, backend modules, API routes, node registration, tests, and the Studio shell internals
(offline service, capability table, drag loop, launcher config): [Developer_EN.md](Developer_EN.md).
