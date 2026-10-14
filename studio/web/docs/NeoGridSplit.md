# Neo Grid Split

**节点键**：`NeoGridSplit` · **显示名**：Neo Grid Split (宫格图拆分)

## 用途
宫格图拆分：把一张分镜宫格图拆成各格图像（行优先，自动清边框与字幕条），
并取回原图内嵌的提示词。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `filename` | Combo | 必需。`input/` 里的宫格图（选一张）；提示词从这张图的 PNG 元信息提取。 |
| `rows` | Combo | 可选。行数：`auto` = 自动检测（含细白条回退与大小一致性校验）；检测不准时手动指定。 |
| `cols` | Combo | 可选。列数，规则同行数。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `image` | IMAGE | 各格图像批次（行优先）。 |
| `prompt` | STRING | 原宫格图 PNG 元信息里的提示词（换行分隔），接 Neo Prompt Agent / Neo Image Gen & Edit。 |

## 典型接法
生图技能产出的分镜宫格 → 存进 `input/` → 本节点拆分 → 各格接 Neo H3 Add Guides 当关键帧。

## 常见问题
- 拆得不齐：手动指定 `rows` / `cols`。
- 下拉里没有图：先把宫格图放进 `input/` 或刷新文件列表。

## 整条流程
生图技能产出分镜宫格 → 存进 `input/` → 本节点拆格 → `image` 批次接 Neo H3 Add Guides
按帧号锚进 H3 conditioning，`prompt` 回灌 Neo Prompt Agent / Neo Image Gen & Edit 复现原图。

## 相关节点
- **Neo H3 Add Guides**：拆出的格当多帧关键帧。
- **Neo H3 Video Director**：导演配方可把宫格图自动拆分成分段首帧。

