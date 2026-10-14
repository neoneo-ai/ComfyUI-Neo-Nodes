---
name: qwen_image_21_pose_edit
cn_name: Qwen Image 2.1 姿势编辑
tags:
- 生图
- Qwen
- 编辑
inputs:
- text
category: image_gen
gen_image: true
created_at: '2026-10-08T00:00:00+00:00'
---

Qwen Image 2.1 姿势编辑：挂 1 张参考图时按提示词改姿势；挂第 2 张参考图时把它的姿势搬到第 1 张的人物上。两种用法都保留 <image1> 的长相、发型、服装、光线与背景，只动姿势。

- 参考图顺序：<image1> = 要改姿势的原图（编辑目标，按画布尺寸缩放），<image2> = 姿势参考（可选，人物图或骨架图均可）。
- 只改姿势（1 张）：提示词写清新姿势，如 "Change the pose of the person in <image1> to sitting on a chair, hands folded on her lap, head turned to the left"。
- 姿势迁移（2 张）：提示词写成 "Adopt the pose of the person in <image2>, keep the face, hair, clothing and background of <image1>"。
- 默认触发词在 config.json 的 default_prompt，选到本技能时自动预填，把方括号里的姿势描述替换掉即可。
- 不加载额外 LoRA（基础模型 + 参考图编辑通道）。姿势迁移 LoRA 日后放入 models/loras 后，可在本技能 config.json 的 loras 里补上。
