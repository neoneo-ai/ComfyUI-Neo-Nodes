# 模型库（Model Hub）

顶栏 🅝 → **📥 模型库**：在 Comfy-Org 专区搜索并下载模型，双源可选
（ModelScope / Hugging Face），下载直接落进 ComfyUI 的模型目录。

## 流程

1. 选源 → 拉取 Comfy-Org 仓库列表（按策展注册表分组显示，可搜索，⟳ 跳过缓存重拉）。
2. 选仓库 → 列出仓库内模型文件（自动过滤非模型文件），每条显示
   `文件名 [落盘类别] 大小`，磁盘已有同名文件的标 `✓ 已存在`。
3. 选文件 → 自动带出落盘类别与子目录，预览 `→ models/<类别>/<子目录>/<文件名>`。
4. ⬇ 下载 → 进度条 + 百分比 / 已下载 / 速度，可「取消」；完成后提示并刷新文件清单。

## 落盘类别

- 仓库内 `split_files/<类别>/...` 前缀直接映射 ComfyUI 模型类别
  （`transformer` / `unet` → `diffusion_models`，`clip` → `text_encoders` 等）。
- 无该前缀时按文件名关键词兜底（`vae` / `lora` / `esrgan` / `clip` / `t5` / `qwen` …），
  都不匹配则落 `diffusion_models`。
- `.gguf` 落 **LLM 类别**：`models/<LLM 子目录>/<仓库名>/`，与内置本地推理（llama-cpp）共用同一目录。

## 断点续传

下载写 `<文件名>.part`，同目录附 `<文件名>.part.meta.json` 记录源 / 仓库 / 路径 / 总大小 / 已下载字节：

- 「取消」保留断点，状态显示「已取消（断点保留）」；再次下载同一文件按 HTTP Range 续传。
- `.part` 与本次请求的源 / 仓库 / 文件不一致时报错并提示删除 `.part`，不会静默拼接坏文件。
- 下载完成后 `.part` 改名为正式文件并删除元数据。
- 单任务：同一时间只有一个下载在进行，重复发起返回「已有下载任务进行中」。

## 设置（⚙）

| 项 | 说明 |
|----|------|
| 默认下载源 | `modelscope` / `huggingface` |
| HF 端点 | 镜像站根地址（只接受 http/https 绝对地址，非法值回落官方端点） |
| HF Token | 受限仓库必需 |
| ModelScope Token | 组织列表与跨组织搜索必需 |
| LLM 子目录 | `models/` 下的目录名，GGUF 落此处（默认 `LLM`） |
| 下载总超时 / 读超时 | 秒，最小 10 |

设置存 `configs/model_hub.json`。子目录与文件名在落盘前一律清洗（去目录、去非法字符、拒绝 `..`），
落盘路径必须位于模型目录内。

**ModelScope 无 Token 时**：组织列表与跨组织搜索不可用，仓库列表由 Hugging Face 结果 +
注册表逐仓库探测存在性补齐（探测结果缓存 1 天），文件清单与下载仍可用。

## 策展注册表

`configs/model_registry.json` 维护分组与推荐组合（只存仓库名与说明，不存元数据），
用于仓库列表分组显示与无 Token 时的补齐。

## 与技能修复联动

技能修复弹窗中缺模型的条目可直接打开模型库并预填搜索词 / 类别
（`openModelHub({ query, category })`）。

---

后端 `model_hub.py`（路由见 [api-routes.md](api-routes.md)），前端 `web/model-hub.js` + `web/model-hub.css`。
