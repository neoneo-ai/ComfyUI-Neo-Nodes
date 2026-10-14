# Neo H3 Add Guides

**节点键**：`NeoH3AddGuides` · **显示名**：Neo H3 Add Guides (Multiframe)

## 用途
多帧关键帧锚点：把多组「图像 + 帧号」批量写入 H3 conditioning 的 `minimax_keyframes`，
等价于串联多个官方 MiniMaxH3AddGuide。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 必需。H3 扩散模型。 |
| `conditioning` | CONDITIONING | 必需。已编码的参考 conditioning。 |
| `vae` | VAE | 必需。编码关键帧图。 |
| `guide_N_image` | IMAGE | 可选（N = 0..7）。第 N 组关键帧图。 |
| `guide_N_frame` | INT | 可选。第 N 组关键帧落在的帧号。 |
| `latent` | LATENT | 可选。接目标 AV latent：关键帧先缩放到该画布再编码；不接 = 按原图分辨率编码。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 挂了连续性 wrapper 的 MODEL，锚点与参考同时生效、时间轴对齐。 |
| `conditioning` | CONDITIONING | 写入多组关键帧后的 conditioning。 |

## 典型接法
分镜宫格拆分出的多张关键帧 → 逐组接 `guide_N_image` + 帧号 → 采样。

## 常见问题
- 报 patchify 尺寸错误：分镜图分辨率与配方画布不一致，接上 `latent`。
- 帧号超出段长：锚点不会落在预期位置，按 24fps 换算帧号。

## 整条流程
Neo Grid Split 拆出的分镜格 → 逐组接 `guide_N_image` + `guide_N_frame`（按 24fps 换算帧号）
→ 接上目标 `latent` 对齐画布 → `model` 与 `conditioning` 进采样器。

## 相关节点
- **Neo Grid Split**：关键帧图的来源。
- **MiniMaxH3AddGuide**：官方单帧版本，本节点等价于串多根。

