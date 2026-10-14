---
name: qwen_image_21_outpaint
cn_name: Qwen Image 2.1 扩图
tags:
- 生图
- Qwen
- 扩图
inputs:
- text
category: image_gen
gen_image: true
created_at: '2026-10-03T00:00:00+00:00'
---

Qwen Image 2.1 扩图（outpainting）：以原图为参考，按指定四边留白像素在四周补灰边，由模型续写周边场景；可选把最终画布缩放到目标总像素（MP）。LoRA 在 config.json 固定为 Qwen2.1 扩图 LoRA（缺失时不带 LoRA 生成并提示）。

- 画廊「图片编辑」弹窗里打开「扩图」开关即可：在原图上拖框定四边留白量，选目标比例（自由 / 16:9 / 2.35:1 等）、设目标像素数后生成。
- 默认触发词：Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, keeping the existing picture unchanged. 可追加扩图细节（如 "extend the sky upward"）。
