# Security Policy

> 🇨🇳 中文见下方

## Report a vulnerability

Use GitHub private vulnerability reporting — **Security → Report a vulnerability** on
[neoneo-ai/neo-studio](https://github.com/neoneo-ai/neo-studio). Non-sensitive problems can go to a normal
issue.

## Never paste a key into an issue

Provider keys live on the local machine only: `remote_llm_config.json`, `backyard_oss.json`, and the
`hf_token` / `ms_token` fields of `model_hub.json`. They are gitignored and excluded from the Registry package
by `studio/.comfyignore`. Redact every key when reporting a config bug — a key posted in a public issue is a
leaked key, and rotating it at the provider is on you.

## Network boundary

Neo Studio talks to Civitai, ModelScope, Hugging Face, OpenAI-compatible LLM providers and Aliyun OSS, and
every one of those requests starts from an explicit user action for the artifact the user asked for. There is
no telemetry, analytics, crash reporting, update check, remote feature flag, or licensing check, and no
opt-in, opt-out, anonymized, aggregated, or diagnostic exception to that rule. Local control planes are
loopback-only: the desktop asset service binds locally, the MCP server refuses a non-loopback ComfyUI URL at
startup, and generation endpoints are reached on `127.0.0.1`.

Remote ComfyUI mode (`remote` in `launcher_config.json`) points the window at another machine and carries no
authentication of its own. A ComfyUI reachable over a network is a firewall and trusted-network decision, not
a plugin feature.

## Scope

ComfyUI core vulnerabilities belong to
[ComfyUI's security policy](https://github.com/comfyanonymous/ComfyUI/security/policy). Model files downloaded
from ModelScope, Hugging Face, Civitai, or Aliyun OSS are third-party artifacts: Neo Studio lands them in the
model folder that matches the repo path and runs them through ComfyUI, and does not verify them.

---

# 安全策略

## 上报漏洞

用 GitHub 的私有漏洞上报：**Security → Report a vulnerability**
（[neoneo-ai/neo-studio](https://github.com/neoneo-ai/neo-studio)）。不敏感的问题走普通 Issue 即可。

## 不要把 Key 贴进 Issue

Provider 密钥只留本机：`remote_llm_config.json`、`backyard_oss.json`，以及 `model_hub.json` 里的
`hf_token` / `ms_token`。它们被 gitignore，并被 `studio/.comfyignore` 挡在 Registry 包外。上报配置类问题时
先把所有 Key 涂掉——贴进公开 Issue 的 Key 就是已泄露的 Key，去 Provider 那边轮换是你的事。

## 网络边界

Neo Studio 会连 Civitai、ModelScope、Hugging Face、OpenAI 兼容 LLM 与阿里云 OSS，每个请求都由用户在
本仓库里的显式操作发起，只服务用户要的那个产物。没有遥测、统计、崩溃上报、更新检查、远程开关、授权校验，
也没有 opt-in / opt-out / 匿名 / 聚合 / 诊断这类例外。本地控制面只走 loopback：桌面端资源服务本地绑定，
MCP 服务启动时拒绝非 loopback 的 ComfyUI 地址，生成接口走 `127.0.0.1`。

远程 ComfyUI 模式（`launcher_config.json` 里的 `remote`）把窗口指到另一台机器，本身没有任何鉴权——把
ComfyUI 暴露到网络上是防火墙与可信网络的决定，不是插件功能。

## 范围

ComfyUI 核心漏洞走
[ComfyUI 自己的安全策略](https://github.com/comfyanonymous/ComfyUI/security/policy)。从 ModelScope、
Hugging Face、Civitai、阿里云 OSS 下载的模型文件是第三方产物：Neo Studio 按仓库内路径落进对应模型目录、
交给 ComfyUI 运行，不做内容校验。