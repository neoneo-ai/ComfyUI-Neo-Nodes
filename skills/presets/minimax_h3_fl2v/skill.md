---
name: 首尾帧生视频
tags:
- MiniMax
- H3
- video
- 首尾帧
inputs:
- image
- text
description: 'H3 首尾帧生视频：首帧 + 尾帧锁定片段收尾'
category: video_gen
gen_video: true
mode: fl2v
requires_ref: true
created_at: '2026-09-12T00:00:00+00:00'
---

# H3 首尾帧生视频（First-Last to Video）

用 `MiniMaxH3ImageToVideo` 的 `first_frame` + `last_frame` 同时锁住片段的首尾画面，中间由模型补全运动与光影过渡。

## 可挂的帧

| 槽位 | 占位符 | 加载链 | 说明 |
| --- | --- | --- | --- |
| 首帧 | `{{REF_IMAGE}}` | `LoadImage → first_frame` | 片段起点；缺省时模板里的 LoadImage 会被裁掉 |
| 尾帧 | `{{REF_IMAGE_LAST}}` | `LoadImage → last_frame` | 片段收尾；缺省时同样被裁掉 |

只给首帧 = 图生视频（I2VA）；只给尾帧 = 锁尾（L2VA）；两边都给 = 首尾帧（FL2VA）。
首帧还参与导演的连续性链（开 `continuity` 时用上一段尾帧作为本段首帧）。

## 提示词写法

按官方 FL2VA 约定：优先描述**首尾之间要发生的过程**（运动路径、镜头调度、光影演变），
不要把首尾帧里已有的静态细节再复述一遍，也不要引入与两端冲突的新内容。
