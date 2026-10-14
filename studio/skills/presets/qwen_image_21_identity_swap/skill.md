---
name: qwen_image_21_identity_swap
cn_name: Qwen Image 2.1 换脸（LLM 改写·无 LoRA）
tags:
- 生图
- Qwen
- 编辑
inputs:
- text
- image
category: image_gen
gen_image: true
created_at: '2026-10-10T00:00:00+00:00'
---

Qwen Image 2.1 换脸（head swap / identity transfer），**不依赖换头 LoRA**：用户描述先经 ComfyUI
核心的 `TextGenerateLTX2Prompt` 节点扩写成规范的换脸提示词，再进 Qwen Image 2.1 参考图编辑通道出图。

- **参考图顺序**：`<image1>` = 目标身体（被换脸的那张，保留其光线/环境/背景），
  `<image2>` = 源脸（提供发型、瞳色、鼻型）。
- 出图尺寸由 `ResolutionSelector` 决定（16:9、2MP），不随节点画布尺寸变化；
  需要改比例请改该节点的 `aspect_ratio`。
- **全部节点都是 ComfyUI 核心**（`nodes.py` / `comfy_extras`），不依赖任何第三方插件包。
- 默认提示词（config.json 的 `default_prompt`）：Replace the head of the woman in Image 1 with
  the head of the person in Image 2.

## 第二个文本编码器

`TextGenerateLTX2Prompt`（LLM 改写）**单独挂了一个 CLIP**，与生图主编码器不是同一个文件，
config.json 无对应槽位，需自行放到 `models/text_encoders/`：

- `qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors` —— 仅供 LLM 改写节点使用

改写走插件的 LLM 设置（顶栏 🅝 → ⚙️ 设置）。若不需要这一步，可删掉 `502`
（TextGenerateLTX2Prompt）、`500`（它专属的 CLIPLoader）与 `505`（BatchImagesNode），
再把 `502.prompt` 的 `{{PROMPT}}` 直接填到 `485`（TextEncodeQwenImage21）的 `prompt` 输入。