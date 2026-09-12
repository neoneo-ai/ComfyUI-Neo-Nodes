---
name: H3 图生视频
tags:
- MiniMax
- H3
- video
- 图生
inputs:
- image
- text
category: video_gen
gen_video: true
requires_ref: true
created_at: '2026-09-12T00:00:00+00:00'
---

MiniMax H3 图生视频（i2v）：输入首帧 IMAGE + 提示词，按本技能 workflow.json 模板同步生成视频帧栈 [B,T,H,W,C]。首帧经 LoadImage 接入 MiniMaxH3ImageToVideo.first_frame。模型/文本编码器/VAE 与默认尺寸、时长见 config.json，可被节点入参覆盖。