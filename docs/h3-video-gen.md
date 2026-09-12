# H3 Video Generate（MiniMax H3 视频生成）

`NeoH3VideoGenerate` 节点：按所选**视频 skill** 的 `workflow.json` 模板同步生成 MiniMax H3 视频，直接输出含原生音频的 `VIDEO`（可接 SaveVideo）到下游节点。复用 Krea2 Generate 的进程内 mini-executor（已支持 V3 API 节点），无需聊天界面、不嵌套官方 PromptExecutor。

## 用法
1. 添加 🎬 H3 Video Generate 节点。
2. `skill_id` 选一个带 `gen_video: true` + `workflow.json` 的视频 skill（内置：`H3 文生视频`(t2v)、`H3 图生视频`(i2v)）。
3. 接 prompt（可来自 ⚡ Neo Prompt Agent 或手填）；i2v 再连首帧 IMAGE。
4. 可选覆盖 `seed`（默认 0，固定；要随机把「生成后控制」设为 randomize）/ `duration`(秒) / `width` / `height`（-1 = 用 skill config.json 默认；`duration` 按 24fps 向上对齐到模型 17k+5 帧网格后作为 H3 `length`）。
5. 执行后输出 `VIDEO`（含音频），接 SaveVideo 等节点导出。

## NeoH3VideoDirector（多段导演）

`NeoH3VideoDirector` 节点：以 **video_director 配方**为参数，把多段 H3 视频按序逐段生成并拼接成单个含音频 `VIDEO`。每段复用上面单段节点的解析/执行链（`resolve_video_params` + `render_template` + `execute_graph_inprocess`），只是参数来自配方而非节点入参。

- **输入**：`recipe`（video_director 配方名，下拉自动列出）+ 可选覆盖 `seed` / `width` / `height`（-1 = 用配方 `shared`）/ `continuity`（默认开）。
- **逐段执行**：第 i 段用其 `skill_id` 解析模板与 config，提示词/时长/首帧取该段字段；`seed = base_seed + i`（base 优先节点覆盖、否则配方 `shared.seed`），保证可复现且各段不同。
- **连续性（Tier A）**：`continuity` 开时，上一段的**尾帧**作为下一段的 I2V 首帧（data-URI 走单段同款参考路径），并**丢下一段第一帧**避免边界重复；关则各段独立、不丢帧。
- **音频对齐**：各段 `AudioInput`（`{waveform:[B,C,T], sample_rate}`）按序拼接，每个接缝丢弃被丢帧对应的采样数（`round(sample_rate/fps)`），使总音频长度恰好等于拼接后帧数对应的时长（A/V 对齐）。
- **输出**：`InputImpl.VideoFromComponents(VideoComponents(images, audio, frame_rate=24))`，单个 `VIDEO` 接 SaveVideo。
- **v1 参考范围**：每段仅取一个首帧图（`first_frame` 或 `refs.images[0]`）；多参考/视频/音频参考待模板占位符支持后再扩展。

## 模板与配置
- 每个视频 skill 目录含：`skill.md`（frontmatter 带 `gen_video: true`）、`workflow.json`（H3 采样链模板）、`config.json`（尺寸/时长默认值）。
- 模型解析优先级：**skill `config.json` 的 `model` / `text_encoder` / `vae` → 「出图设置」页面的『生视频模型』区（全局 `video_model` / `video_text_encoder` / `video_vae`）→ 仍缺则报错**。音频 VAE 单独解析：skill `config.json` 的 `audio_vae` → 「生视频模型」设置的 `video_audio_vae`（VAE(音频) 下拉）→ 按文件名线索（同时含 `h3` 与 `audio`）自动挑选，找不到才报错。内置 preset 不写死模型名：请在「自动增强 → 出图设置」的生视频模型区选本地实际安装的 H3 模型；音频 VAE 一般无需手填（自动挑 `minimax_h3_audio_vae_fp32.safetensors` 之类）。`config.json` 的 `width` / `height` / `length`(帧) 为默认值（`duration`=-1 时按此帧数），可被节点入参覆盖。
- **每技能覆盖（同生图）**：在技能详情弹窗里，视频技能（`gen_video: true`）显示「🎬 生视频设置」区，可对该 skill 单独设 生视频模型 / Text Encoder / VAE(视频) / VAE(音频)，写入其 `config.json`（键 `model`/`text_encoder`/`vae`/`audio_vae`），优先于全局「生视频模型」设置；留空则回落全局。预设技能只读，需「⧉ Copy as custom」复制后可编辑（复制保留 `gen_video` 与 `category: video_gen`）。
- **LoRA（同生图，无「依赖参考图」）**：在「🎬 生视频设置」区可对该 skill 添加多个 LoRA（模型 + 强度），写入其 `config.json` 的 `loras`；生成时经 `image_gen._resolve_loras` 校验后由 `render_template` 动态串入主链——模板无 LoRA 槽位时在 `UNETLoader → MiniMaxH3SigmaShift` 之间插入 `LoraLoaderModelOnly`。视频无参考图依赖概念，故不设生图区那样的「依赖参考图」复选框，配置的 LoRA 全部无条件加载；LoRA 下拉由 `/neo_video_gen/models` 的 `loras` 提供。
- 模板链：`UNETLoader + CLIPLoader(type=minimax) + VAELoader(视频) + VAELoader(音频) → MiniMaxH3ImageToVideo → [cond, AV latent] → MiniMaxH3SigmaShift + KSampler(cfg=1.0) → LTXVSeparateAVLatent → {VAEDecode(视频 VAE)→帧, VAEDecodeAudio(音频 VAE)→音频} → CreateVideo(fps=24) → VIDEO`。**H3 音频是独立 VAE（MiniMaxH3AudioVAE），`VAEDecodeAudio` 必须接单独的音频 `VAELoader`，不能复用视频 VAE**（否则视频 VAE 按 5D 解码 4D 音频 latent 会报 `IndexError`）。i2v 额外 `LoadImage({{REF_IMAGE}}) → first_frame`。
- 占位符：`{{PROMPT}} {{MODEL}} {{TEXT_ENCODER}} {{VAE}} {{AUDIO_VAE}} {{WIDTH}} {{HEIGHT}} {{LENGTH}} {{SEED}}`（i2v 另含 `{{REF_IMAGE}}`）。
- **从画布导出（📋 From Canvas）**：技能下拉底部「📋 From Canvas」把当前画布 API prompt 导出为技能。检测到 H3 视频工作流（含 `MiniMaxH3*ToVideo` 入口，或 `CreateVideo`+`VAEDecodeAudio`）时自动存为 `gen_video: true` / `category: video_gen` 的视频 skill，并按上表占位符模板化（模型/编码器/视频 VAE/音频 VAE/prompt/尺寸/时长/seed/主链 LoRA；I2V 的 `LoadImage` → `{{REF_IMAGE}}`、首帧连线保留），否则仍存为出图 skill。只弹一个标题对话框输入名称（不再问描述/标签），成功/失败用 toast 提示。

## 说明
- 末端 `CreateVideo` 把视频帧 + 音频打包成原生 `VIDEO`（fps=24），不直接落盘；接 SaveVideo 即可导出带声音的视频。
- 采样参数（steps/cfg/sampler/scheduler）写在各 skill 的 `workflow.json` 中，按需调整。
- 「出图设置 → 生视频模型」区的模型下拉由 `/neo_video_gen/models` 提供：H3 相关（文件名含 `h3`）排前面、其余按名称排序（与生图的 krea2-first 独立），方便快速定位 H3 模型。