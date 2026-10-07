# Neo Image Gen & Edit

**节点键**：`NeoImageGenEdit` · **显示名**：Neo Image Gen & Edit

## 用途
按所选 skill 的 `workflow.json` 模板同步生图：不挂参考图 = 文生图；挂上参考图 = 按技能进入
参考 / 编辑模式（如 Qwen Image 2.1 编辑：第 1 张是编辑目标，其余是参考对象）。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `skill` | Combo | 生图 / 编辑技能：决定内部模板与默认模型链。 |
| `prompt` | STRING | 提示词；为空且接了 `bundle` 时用 bundle 里的第一条。 |
| `reference_image…` | IMAGE | 参考图（可增删槽位）。不挂 = 文生图。 |
| `bundle` | STRING | 可选。Neo Prompt Agent / Neo Reference Grid 的 BUNDLE：提供时其参考图覆盖节点上挂的 refs。 |
| `seed` / `count` | INT | 种子与张数。 |
| `width` / `height` | INT | `-1` = 用 skill / preset 的比例算尺寸。 |
| `steps` | INT | `-1` = 用 skill `config.json` 的 steps（缺省 20）。 |
| `model` | MODEL | 可选。外部加速模型：提供时覆盖内部主模型链。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `images` | IMAGE | 生成结果批次 `[count,H,W,C]`，接 SaveImage / PreviewImage 或下游编辑节点。 |

## 典型接法
- 选 skill → 写提示词 → `images → SaveImage`。
- 节点底部 Skill 状态条提示缺模型 / 缺节点，可点开详情修复。
- 宽高默认跟随技能预设；切换技能会强制按预设重填。

## 常见问题
- 出图尺寸不对：把 `width`/`height` 设成 `-1` 交给预设，或手动填成目标值。
- 编辑没生效：编辑类技能要求第 1 张参考图是编辑目标。

## 整条流程
选 skill → 提示词（手填 / `PROMPT` / `bundle`）→ 参考图（节点槽位，或被 `bundle` 覆盖）
→ 排队执行 → `images` 接 SaveImage、PreviewImage，或进 Gallery 侧栏入库复用。

## 相关节点
- **Neo Prompt Agent / Neo Reference Grid**：提供 prompt 与 BUNDLE。
- **Neo Gallery**：出图后浏览、拖回宫格当下一轮的参考图。

