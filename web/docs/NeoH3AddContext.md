# Neo H3 Add Context

**节点键**：`NeoH3AddContext` · **显示名**：Neo H3 Add Context (Cross-segment)

## 用途
跨段上下文注入：把上一段成片尾部若干帧作为本段的上下文，把身份参考图作为角色锚点，
一起写进 H3 conditioning，保证段与段之间人物与场景连续。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 必需。H3 扩散模型。 |
| `conditioning` | CONDITIONING | 必需。已编码的参考 conditioning。 |
| `vae` | VAE | 必需。 |
| `context_image` | IMAGE | 可选。上段尾部窗口帧（接 Neo H3 Video Director / Neo H3 Segment Run 的成片输出）；空 = 不注入上下文。 |
| `identity_image` | IMAGE | 可选。身份参考图，可批量逐张成块：保角色 / 物体外观跨段一致。 |
| `context_frames` | INT | 可选。取上段尾部多少帧做上下文（自动就近对齐 17k+5 网格）；`0` = 不注入。 |
| `context_mode` | Combo | 可选。`window` = 本段开头重生成这些帧（调用方丢头帧）；`reference` = 作为目标之前的参考视频，不搬时间轴不丢帧。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `model` | MODEL | 挂了连续性 wrapper 的 MODEL，必须一起接下去。 |
| `conditioning` | CONDITIONING | 注入上下文与身份后的 conditioning。 |

## 典型接法
导演节点自动注入本节点；手动搭图时：上一段 `video → context_image`，本段采样接 `model` + `conditioning`。

## 常见问题
- 段首画面被搬进本段：`context_mode` 用 `window` 时调用方需丢头帧。
- 人物外观漂移：补 `identity_image`。

## 整条流程
上一段 `video` → `context_image`（取尾部 `context_frames` 帧）+ 角色 `identity_image`
→ `model` 与 `conditioning` 进本段采样；导演节点开 `continuity` 时自动按这条链注入。

## 相关节点
- **Neo H3 Video Director**：整片连续性由它自动注入本节点。
- **Neo H3 Segment Run**：单段重生成时的续接。

