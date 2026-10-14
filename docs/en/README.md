# Documentation Index

> 🇨🇳 中文: [../README.md](../README.md)

This directory splits the plugin documentation by major module. The entry points remain the root
[README.md](../../README.md) (end users) and [Developer_EN.md](../../Developer_EN.md) (developers).

## Feature modules (end users)

| Document | Contents |
|------|------|
| [prompts.md](prompts.md) | Prompt nodes, UI buttons, image reverse-prompting, `@` / `/` menus |
| [skills.md](skills.md) | Skill management: skill files, manager window, workflow-area editing, canvas import and write-back |
| [llm.md](llm.md) | LLM modes, cloud providers, local GGUF installation, model directory conventions |
| [image-gen.md](image-gen.md) | Image generation: chat generation, the Image Gen & Edit node, sizes and outpainting |
| [h3-video-gen.md](h3-video-gen.md) | Video generation: director recipe execution, single-segment regeneration, grid split, templates |
| [recipes.md](recipes.md) | Recipes: saving, sending to the workflow, the director recipe editor |
| [gallery.md](gallery.md) | Asset library: browsing, lightbox, file management, Civitai LORA, bookmarks |
| [workflow-repair.md](workflow-repair.md) | Workflow model-path repair |
| [model-hub.md](model-hub.md) | Model hub: Comfy-Org curated section, dual-source search, resumable downloads |

## Developer documentation

| Document | Contents |
|------|------|
| [architecture.md](architecture.md) | Project structure, module responsibilities, node registration, data & configuration directories |
| [api-routes.md](api-routes.md) | Backend API route overview |
| [testing.md](testing.md) | pytest unit tests and JS regression tests |
| [release.md](release.md) | Registry publishing and offline tooling |