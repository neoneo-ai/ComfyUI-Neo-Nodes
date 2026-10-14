---
name: qwen_image_21_face_swap
cn_name: Qwen Image 2.1 换脸
tags:
- 生图
- Qwen
- 编辑
inputs:
- text
category: image_gen
gen_image: true
created_at: '2026-10-10T00:00:00+00:00'
---

Qwen Image 2.1 换脸（head swap）：以 <image1> 为目标图（保留其光线、环境与背景），把它的头完全换成 <image2> 的头，严格保留 <image2> 的发型、瞳色与鼻型，同时沿用 <image1> 的视线方向、头部朝向与微表情。

- 参考图顺序：<image1> = 目标身体（要换脸的那张），<image2> = 源脸。
- LoRA 在 config.json 固定为 Qwen21-换头bfs_head_v1.1_qwen_2.1（缺失时不带 LoRA 生成并提示）。
- 默认触发词：head_swap: start with <image1> as the base image, keeping its lighting, environment, and background. remove the head from <image1> completely and replace it with the head from <image2>, strictly preserving the hair, eye color, nose structure from <image2>. copy the direction of the eye, head rotation, micro expressions from <image1>, high quality, sharp details, 4k
