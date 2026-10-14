# Neo Bundle Expand

**节点键**：`NeoBundleExpand` · **显示名**：Neo Bundle Expand

## 用途
把 Neo Prompt Agent 输出的运行时 BUNDLE 展开成官方 MiniMax H3 参考生视频节点可直接消费的
提示词与逐张参考图。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `bundle` | STRING | 必需。Neo Prompt Agent / Neo Reference Grid 的 BUNDLE 输出（纯连线槽）。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | STRING | bundle 里的提示词文本。 |
| `image_1` … `image_9` | IMAGE | bundle 里的参考图，按顺序编号；输出槽随连接数量自动增删。 |

节点内只读展示展开结果（提示词 + 参考图缩略图网格，编号与输出槽对应）。

## 典型接法
`NeoPromptAgent.BUNDLE → 本节点.bundle`，`prompt` 与 `image_N` 分别接官方 H3 参考生视频节点。

## 常见问题
- 看不到全部参考图：输出槽按需增长，连到需要的槽位即可。
- 只想在 Neo 体系内用：Neo Image Gen & Edit 可直接吃 BUNDLE，不必展开。

## 整条流程
`NeoPromptAgent.BUNDLE` 或 `NeoRefGrid.BUNDLE` → 本节点展开 → `prompt` 与 `image_N`
按官方 MiniMax H3 Reference to Video 的槽位逐根接上。

## 相关节点
- **Neo Prompt Agent / Neo Reference Grid**：BUNDLE 的来源。
- **Neo H3 Video Director**：Neo 体系内做视频不必先展开，直接吃 BUNDLE。

