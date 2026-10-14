# Neo H3 Add Keyframe

**节点键**：`NeoH3AddKeyframe` · **显示名**：Neo H3 Add Keyframe (Hybrid)

## 用途
首帧锚点：把图像编码成 latent 写入 H3 conditioning 的第 0 帧 keyframe，与 `minimax_refs` 共存。
Neo H3 Video Director 已改用 Neo H3 Add Context，本节点保留给手动搭图与旧画布工作流。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 必需。H3 扩散模型。 |
| `conditioning` | CONDITIONING | 必需。已编码的参考 conditioning。 |
| `vae` | VAE | 必需。用于把锚点图编码成 latent。 |
| `image` | IMAGE | 必需。首帧锚点图：只取批次第 1 张，钉在时间轴第 0 帧。 |
| `frame_count` | INT | 必需。本段总帧数（24fps，124 帧 ≈ 5 秒），需与采样段长度一致。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 挂了连续性 wrapper 的 MODEL：keyframes 与 refs 并存时时间轴对齐。 |
| `conditioning` | CONDITIONING | 写入首帧 keyframe 后的 conditioning，接采样器 positive。 |

## 典型接法
`MiniMaxH3EncodeRefVideo → conditioning → 本节点 → KSampler`，`model` 输出必须一起接下去。

## 常见问题
- 首帧不生效：`frame_count` 与采样段长度不一致。
- 多帧锚点请用 Neo H3 Add Guides；跨段连续性请用 Neo H3 Add Context。

## 整条流程
`MiniMaxH3EncodeRefVideo` 出 conditioning → 本节点写入第 0 帧锚点 → `model` 与 `conditioning`
一起接采样器；`frame_count` 必须等于本段采样帧数。

## 相关节点
- **Neo H3 Add Guides**：多组关键帧用它。
- **Neo H3 Add Context**：跨段连续性，导演节点走的是它。

