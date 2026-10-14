---
name: qwen_image_21_controlnet
cn_name: Qwen Image 2.1 ControlNet
tags:
- 生图
- Qwen
- ControlNet
inputs:
- text
category: image_gen
gen_image: true
created_at: '2026-10-08T00:00:00+00:00'
---

Qwen Image 2.1 ControlNet（Fun ControlNet 模型补丁）：`<image1>` 出内容与长相，第 2 张参考图只进模型补丁出骨架，姿势与构图被控制图锁住。

- 参考图顺序：`<image1>` = 内容主体（要保留长相 / 服装 / 背景的那张），第 2 张 = 姿势来源（人物照片，或直接给骨架图），`<image3>` 起 = 附加内容参考（服装、风格、道具），最多 4 张。
- 姿势图不进编码器：config.json 的 `control_ref: 2` 在解析期把它从编码器参考里摘出来，只喂控制链。它一旦同时占编码器槽，模型会把这张照片当内容参考直接复刻（出图 = 参考图）。
- 控制链：`LoadImage(姿势图) → AIO_Preprocessor(OpenposePreprocessor) → ZImageFunControlnet → KSampler.model`，模型补丁由 `ModelPatchLoader` 提供。
- 默认触发词只提「按 ControlNet 姿势参考」：提示词里的 `<image1>` 指内容主体，姿势图不在编码器里、不要用 `<image2>` 指它。
- 至少 2 张参考图（config.json 的 `min_refs`）：姿势槽空时控制链会渲染成缺输入的图，后端在解析期直接报「该技能需要至少 2 张参考图」。
- 想让姿势锁在 `<image1>` 自己身上（原地改姿势）：把 `<image1>` 复制一份放第 2 张，提示词写要改的动作。
- 控制强度固定 `strength=0.8`、`start_percent=0`、`end_percent=1`（模板 `ZImageFunControlnet`）：结构贴不紧就调高 strength，画面被骨架绑死就调低。
- 预处理分辨率对齐画布（模板 `AIO_Preprocessor.resolution = {{CANVAS_HEIGHT}}`），Openpose 骨架图由控制补丁缩放到目标尺寸。
- 依赖模型补丁 `qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors`（放 `models/model_patches`）与 Openpose 预处理模型（`comfyui_controlnet_aux` 自带）。
- 默认触发词在 config.json 的 default_prompt，选到本技能时自动预填。