# Neo Reference Grid

**节点键**：`NeoRefGrid` · **显示名**：Neo Reference Grid (参考图宫格)

## 用途
参考图宫格：在插件自绘的宫格里摆放 1~12 张参考图（槽位运行时可调），
输出提示词、BUNDLE 与逐张参考图。

## 输入
宫格槽位与提示词由插件前端渲染（从 Gallery 侧栏拖入、粘贴或上传），没有原生 widget。

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | STRING | 宫格里填写的提示词。 |
| `BUNDLE` | STRING | 提示词 + 参考图的运行时打包，接 Neo Image Gen & Edit / Neo H3 Video Director / Neo Bundle Expand。 |
| `image_1` … `image_12` | IMAGE | 各宫格槽位的参考图，空槽输出对应槽位为空。 |

## 典型接法
- 从 Gallery 侧栏把图拖进宫格 → 写提示词 → `BUNDLE → Neo Image Gen & Edit.bundle`。
- 需要逐张图时接 `image_N`。

## 常见问题
- 槽位不够 / 多余：宫格数量可在节点上调整，输出槽跟随。
- 下游只吃 BUNDLE：用 Neo Bundle Expand 展开成 prompt + 图。

## 整条流程
Gallery 侧栏拖图 / 粘贴 / 上传进宫格 → 写提示词 → `BUNDLE` 整包给生图与导演节点，
或按槽位接 `image_N` 直连官方节点。宫格内容参与配方保存与还原。

## 相关节点
- **Neo Gallery**：宫格的图片来源。
- **Neo Bundle Expand**：下游只吃逐张图时用它展开 BUNDLE。
- **Neo Recipes**：宫格随基础配方一起保存、一键发送到工作流。

