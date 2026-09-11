# LLM 配置与本地推理

两个提示词节点共用同一套 LLM 运行模式。

## LLM 模式

| 模式 | 说明 | 要求 |
|------|------|------|
| Remote (远程) | 通过 API 调用云端大模型 | 在节点 Settings 中配置 API Key、端点（与本地模式共用，采样温度统一用服务端默认） |
| Local (本地) | 使用 llama.cpp 在本地推理 | 放置 GGUF 模型到目录并在 Settings → Provider 选「Local GGUF」后选择模型 |

> **思考模型**：接入会输出推理过程的模型（如 `qwen3.6-35b-a3b`，OpenAI 兼容接口把推理放在 `reasoning_content`）时，生成期间会在提示词框上方实时显示「💭 思考中…」面板，正文出现或结束时自动清除，最终只保留正文结果（思考文本不写入提示词）。流式（远程/本地）会自动为推理预留 token 预算（下限见 `llm.py` 的 `STREAM_MIN_MAX_TOKENS`），避免推理耗尽预算导致没有正文。✨ 按钮旁的 ▾ 菜单提供「关闭思考」开关：勾选后经 `chat_template_kwargs={"enable_thinking": false}` 让服务端跳过推理直接输出（更快更稳，适合 Krea2 等只需最终提示词的场景）；不支持该字段的服务端会忽略此参数，无副作用。

## 国产云供应商（开箱可选）

Settings → Provider 下拉里已内置以下国产云端入口，选好后填 API Key（**云厂商必填**，留空会 401）即可用（模型名能自动列出就直接选，列不出可手输）：

| 下拉项 | 默认 Base URL | 申请入口 | 示例模型名 |
|--------|---------------|----------|------------|
| `DeepSeek 深度求索` | `https://api.deepseek.com/v1` | [platform.deepseek.com](https://platform.deepseek.com) | `deepseek-flash` |
| `阿里云百炼 (通义千问)` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [百炼控制台](https://bailian.console.aliyun.com) | `qwen-plus` |
| `阿里云百炼 Token Plan` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 百炼控制台 → Token Plan | `qwen3.8-max` |
| `月之暗面 Kimi` | `https://api.moonshot.cn/v1` | [platform.moonshot.cn](https://platform.moonshot.cn) | `kimi-k3` |
| `智谱 GLM` | `https://open.bigmodel.cn/api/paas/v4` | [open.bigmodel.cn](https://open.bigmodel.cn) | `glm-5.3` |
| `硅基流动 SiliconFlow` | `https://api.siliconflow.cn/v1` | [cloud.siliconflow.cn](https://cloud.siliconflow.cn) | `deepseek-ai/DeepSeek-V3` |

- 模型名以各家控制台当前列表为准（上表只是示例）：下拉会自动请求模型列表端点（鉴权厂商在 API Key 输入框留空时复用已存密钥；填入/修改密钥后自动重拉），拉不到时回退为手动输入，不会卡在「未加载」。
- 智谱端点是 `/api/paas/v4`，所以 `llm_providers.json` 里该家 `append_v1: false`；其余以 `/v1` 结尾，保持 `true` 即可（已接入 `/v1` 时不会重复追加）。
- 百炼可改用业务空间专属域名（`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）：展开「自定义端点」把 Base URL 改过去即可；其 API Key 与地域绑定，跨地域会返回 401。
- 有预设 Base URL 的供应商（云端厂商、LM Studio / Ollama / vLLM 等）默认把 **Base URL** 收进「自定义端点」折叠区，避免干扰；改端点时点标题展开即可，空着就用预设值。无预设端点的 OpenAI Compatible 需要手填端点，因此该行保持常显。
- 采样温度已从界面移除：请求体不再发送 `temperature`，统一使用服务端/模型默认值。
- 已保存的端点与预设不一致时（例如改成了百炼业务空间专属域名），折叠区会**自动展开**，不会把自定义端点藏起来。
- API Key：标记 `requires_api_key` 的云厂商为**必填**（输入框提示「必填」，留空保存会告警 401）；已经存过密钥时后端只回掩码串，输入框以星号显示（未改动/清空都沿用旧值，不会把掩码当新密钥落盘）。LM Studio / Ollama / vLLM / Unsloth 与 OpenAI Compatible 可留空。
- 阿里云三套通道互相隔离，API Key 与 Base URL 必须配套，混用会走按量计费通道产生意外扣费或返回 401/403：按量付费（`sk-` + `dashscope.aliyuncs.com/compatible-mode/v1`）、Token Plan（`sk-sp-` + `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，目前仅华北 2（北京）地域）、Coding Plan（`sk-sp-` + `coding.dashscope.aliyuncs.com/v1`）。
- 下拉里**没有** Coding Plan：其条款仅允许在编程工具内交互使用，禁止以 API 形式用于自动化脚本 / 应用后端 / 非交互式批量调用，违规可能导致订阅暂停或 Key 被封。按订阅额度用请选「阿里云百炼 Token Plan」，按调用付费请选「阿里云百炼 (通义千问)」。
- 供应商清单定义在 `configs/llm_providers.json`，增删改（含接入自建服务）直接编辑该文件，重启 ComfyUI 后下拉即生效。

## 本地 LLM 推理安装（可选）

本地 GGUF 模式依赖 `llama-cpp-python`。它默认从源码编译（需要 C 编译器 / CUDA 工具链），Windows 上很容易失败，**推荐直接安装预编译 wheel**。

### 方式一：预编译 wheel（推荐）

到 [JamePeng/llama-cpp-python releases](https://github.com/JamePeng/llama-cpp-python/releases) 下载与你的 **Python 版本 + 系统 + CUDA 版本** 匹配的 wheel 并安装（参考 `llama-cpp_vllm` 等同类插件的推荐做法）：

```bash
# 示例：Python 3.12 + Windows + CUDA 12.4（文件名以 releases 页实际资产为准）
python -m pip install llama_cpp_python-<版本>+cu124-cp312-cp312-win_amd64.whl
```

纯 CPU 也可用官方预编译索引：

```bash
python -m pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
```

### 验证与模型

```bash
python -c "from llama_cpp import Llama; print('ok')"
```

通过后把 GGUF 模型放入模型目录（规范见下文[本地模型目录规范](#本地模型目录规范)），在 Settings → Provider 选「Local GGUF」，选择模型后点 💾 保存；目录里只有一个模型时无需手动切换，运行时会自动使用该模型。

### 方式二：源码编译

```bash
# CPU
python -m pip install llama-cpp-python

# NVIDIA GPU（需要先装好 CUDA Toolkit 与 C/C++ 编译器）
# Windows PowerShell:
$env:CMAKE_ARGS = "-DGGML_CUDA=ON"
python -m pip install llama-cpp-python --no-cache-dir
```

### Windows 运行时注意

启动报 `Could not find module '...\\ggml.dll'` 时，是缺少 VC++ 运行库：安装 [Microsoft Visual C++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) 后重启 ComfyUI。

## 本地模型目录规范

路径按 `供应商(可选)/模型名称/模型文件(.gguf)` 组织，例如：

```
models/LLM/
├── mradermacher/Qwen3-4B-AWQ-I4_K_M/GGUF-Q4_0-int4-v2-scratch.gguf   # 单文件直接放根目录即可
├── stablelm/stablelm2-1.6B.gguf                                      # 平铺布局同样支持
└── mradermacher/Huihui-gemma-4-E4B-it-abliterated-GGUF/
    ├── Huihui-gemma-4-E4B-it-abliterated-Q4_K_M.gguf                 # 主模型文件（任意量化）
    └── Huihui-gemma-...mmproj-f16.gguf                               # 投影文件（自动匹配，见下）
```

| 项目 | 说明 |
|------|------|
| 目录位置 | Settings → Provider 选 `Local GGUF` 后出现的 **Models Dir**；留空默认扫描 `models/LLM/`，也可填任意本地路径（如 LM Studio 的 `<用户>/.lmstudio/models`） |
| 模型列表 | 递归扫描该目录下所有 `.gguf`，下拉框只显示**模型名称**（文件名去掉 `.gguf`），不同供应商同名文件各自成项 |
| 多模态标识 | 某模型同目录中存在 `mmproj-*.gguf`（或 `<模型名>.mmproj-f16.gguf`）时，该模型名称前会出现 🖼️ 徽标，表示可用于图片反推；多个候选时不猜测、留空待匹配 |
