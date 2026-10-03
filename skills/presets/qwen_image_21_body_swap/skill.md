---
name: qwen_image_21_body_swap
cn_name: Qwen Image 2.1 换身
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

Qwen Image 2.1 换身（body swap）：以 <image1> 为目标图（保留其光线、环境与背景），把它的身体换成 <image2> 的身体，严格保留 <image2> 的服装、体型与比例，同时严格复刻 <image1> 的姿势、手臂/腿部位置、手势、头部朝向、视线方向与微表情。

- 参考图顺序：<image1> = 目标头脸（要换身的那张），<image2> = 源身体。
- LoRA 在 config.json 固定为 Qwen21-换身bfs_body_swap_v1.0_qwen_2.1（缺失时不带 LoRA 生成并提示）。
- 默认触发词：body_swap: start with <image1> as the base image, keeping its lighting, environment, and background. replace the body from <image1> with the body from <image2>, strictly preserving the clothing, body shape and proportions from <image2>. strictly replicate the exact pose, arm positions, leg positions, hand gestures, head rotation, eye direction and micro expressions from <image1>
