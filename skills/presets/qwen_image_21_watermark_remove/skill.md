---
name: qwen_image_21_watermark_remove
cn_name: Qwen Image 2.1 去水印
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

Qwen Image 2.1 去水印：以原图为参考，按提示词移除画面里的水印、logo 与文字叠加，其余内容保持不变。基础模型对 "Remove the watermarks" 类指令跟随良好；专用 LoRA（Qwen21-水印移除watermark_remover_v2_qwen）不在本地库时即以此方式运行，日后放入 models/loras 后可在本 config.json 的 loras 里补上。

- 默认触发词：Remove the watermarks。可追加细节（如 "remove the logo in the bottom-right corner"）。
- 画廊「图片编辑」弹窗选此技能即可，原图自动作为 <image1>。
