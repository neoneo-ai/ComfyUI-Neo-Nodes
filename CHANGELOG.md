# Changelog

Notable changes for ComfyUI-Neo-Nodes. Versions are tagged `vX.Y.Z` and published to the ComfyUI Registry.

## [Unreleased]

- Skills support video and audio reference slots.
- Qwen Image 2.1 pose editing with ControlNet.
- Skill manager: `workflow.json` is edited directly in the canvas; preset writeback through overrides with auto-copy; workflow skills are excluded from prompt enhancement; skill detail UI reworked.
- Canvas import maps control refs and pins reference loaders.
- Skill manager search box stays open under IME input and closes via ✕.
- README rewritten: hero demo, zero-config section, feature highlights; gallery screenshots compressed.

## [1.2.0] - 2026-10-08

- **Native LLM provider**: safetensors text-generation models (e.g. Qwen3.5 BF16) run inside the ComfyUI process with no extra dependency; models auto-unload to free VRAM on switch and unload.
- **Model Hub**: Comfy-Org hub with dual-source (ModelScope / Hugging Face) search, ModelScope subfolder support, Civitai downloads, bookmark pagination.
- **Gallery**: LoRA safetensors metadata badges with refresh, image lightbox, stable outpaint ratio presets.
- **Skill manager**: embedded litegraph workflow editor, writeback preview with local history, canvas↔skill config sync, flowchart layout for imported skill workflows.
- **Image Gen & Edit**: `max_refs` config with auto-grow reference slots; Qwen Image 2.1 identity-swap preset.
- **Registry and metadata**: `.comfyignore`, Registry metadata, node manifest and version banner at plugin load, node search aliases, tooltips, metadata contract test.
- Cancellable LoRA directory tagging with tag formatting; top-menu behavior and node placement refined; workflow repair skips unhashable widget heads.

## [1.1.0] - 2026-10-04

- Qwen Image 2.1 outpaint mode; masked local edit with crop and feathering; SAM3 mask feathering.
- Skill workflow import/export with update endpoint; skill manager UI refresh.
- Batch LoRA tagging in the gallery (missing LoRA directories are skipped); Backyard gallery preprocessing with OSS upload.
- Outpaint pipeline aligned with the reference workflow (1MP / 1.5MP scaling); removal prompt prefill contract in the image edit dialog.
- English README added; vendored Krea2 edit node registration and quadview LoRA handling removed.

## [1.0.1] - 2026-10-02

- Manual publish flow documented; version bumped for the first Registry release.

## [1.0.0] - 2026-10-02

- Initial release: Neo Prompt Encoder, Neo Prompt Agent, Neo Image Gen & Edit, H3 Video Director with director recipes, Neo Gallery with bookmarks, Neo Reference Grid, Neo Grid Split, Neo Bundle Expand, workflow repair, skill presets, and Neo Studio.
