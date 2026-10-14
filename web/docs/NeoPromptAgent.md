# Neo Prompt Agent

**节点键**：`NeoPromptAgent` · **显示名**：Neo Prompt Agent

## 用途
不绑定 CLIP 的提示词生成器：把 LLM 生成 / 增强 / 随机抽取出的提示词直接输出给下游节点，
并把「提示词 + 参考图」打包成 BUNDLE 供视频与生图节点整包消费。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `text_input` | STRING | 可选。外部提示词接入：接上后忽略节点内文本框、自动增强与随机抽取。 |
| `image` | IMAGE | 可选。接图像时走图生文（反推提示词），需同时开启自动生成。 |

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `PROMPT` | STRING | 生成的提示词文本。 |
| `BUNDLE` | STRING | 运行时打包（提示词 + 参考图），接 Neo Bundle Expand、Neo H3 Video Director、Neo Image Gen & Edit。 |

## 典型接法
- `PROMPT → Neo Image Gen & Edit.prompt`。
- `BUNDLE → Neo Bundle Expand.bundle`，再喂给官方 MiniMax H3 参考生视频节点。
- 节点上的设置按钮可配置生成条数、随机池与技能。

## 常见问题
- 下游只想要图：BUNDLE 是纯连线槽，不能当文本用，展开请用 Neo Bundle Expand。
- 随机抽取没生效：接了 `text_input` 时随机与自动增强都会被跳过。

## 整条流程
底部快捷输入 / 技能 → LLM 生成或增强 → `PROMPT` 给生图节点，`BUNDLE` 把提示词与参考图整包交给
生图、导演或展开节点；生成条数、随机池与技能在节点上的设置按钮里配。

## 相关节点
- **Neo Image Gen & Edit**：`PROMPT → prompt`，`BUNDLE → bundle`。
- **Neo H3 Video Director**：接 `BUNDLE` 时走单段生成。
- **Neo Bundle Expand**：把 `BUNDLE` 摊成官方节点吃的 prompt + 逐张图。

