---
name: qwen_image_21_local_edit
cn_name: Qwen Image 2.1 高分局部编辑
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

Qwen Image 2.1 高分局部编辑：涂抹要修改的区域，系统自动按涂抹范围裁剪（含 25% 边距）、放大到约 1MP 高分辨率重绘该区域，再羽化合并回原图——小区域细节比整图重绘更精细。

- 画廊「图片编辑」弹窗里打开「局部」开关即可：在原图上涂抹要改的区域（画笔/橡皮可调），提示词描述怎么改；涂抹范围自动识别，无需手输尺寸。
- 模型看到的是涂抹区标红的裁剪图，提示词会自动追加 "Only modify the red highlighted area; keep all other parts of the image exactly unchanged."
- 不加载额外 LoRA（基础模型 + 高分重绘）。
