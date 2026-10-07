# Neo Prompt Encoder

**节点键**：`NeoPromptEncoder` · **显示名**：Neo Prompt Encoder

## 用途
带 CLIP 绑定的智能文本编码器：节点内文本框写提示词，LLM 负责增强 / 翻译 / 分类 / 标题提取，
编码结果进缓存，可让节点在每次执行时自动生成提示词。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `clip` | CLIP | 必需。把提示词编码成 conditioning 的 CLIP。 |
| `text_input` | STRING | 可选。外部提示词接入：接上后忽略节点内文本框、自动增强与随机抽取。 |
| `image` | IMAGE | 可选。接图像时走图生文（反推提示词），需同时开启自动生成。 |

节点内的文本框、`自动生成`、`随机抽取`、`技能` 等由插件前端渲染，不在原生 widget 列表里。

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `POSITIVE` | CONDITIONING | 编码后的正向 conditioning，接 KSampler 的 positive。 |
| `PROMPT` | STRING | 本次实际使用的提示词文本，可接预览 / 记录节点。 |

## 典型接法
- `CLIPLoader → clip`，`POSITIVE → KSampler.positive`，`PROMPT → 预览文本`。
- 想反推图片：`LoadImage → image`，并在节点上开启自动生成。

## 常见问题
- 提示词没变化：检查是否接了 `text_input`（接上后节点内文本框失效）。
- 反推没触发：`image` 已接但自动生成未开启。
- 增强不可用：LLM 未配置，去顶部菜单的 LLM 设置。

## 整条流程
`CLIPLoader → clip` → 节点内文本框 / 底部快捷输入写提示词 →（可选 LLM 增强 / 翻译 / 图生文反推）
→ `POSITIVE` 接采样器或模型 conditioning，`PROMPT` 接文本预览留档。

## 相关节点
- **Neo Prompt Agent**：不绑 CLIP 的同类生成器，只要文本与 BUNDLE 时用它。
- **Neo Image Gen & Edit**：技能模板自带模型链时不必手搭 CLIP 编码。

