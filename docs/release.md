# 发布与离线工具

总入口见 [../Developer.md](../Developer.md)。

## 发布

### 打包范围

`.comfyignore`（gitignore 语法）决定 Registry 包里有什么：comfy-cli 取 git 已跟踪文件减去这里的条目。
`tests/`、`tools/`、`.github/`、`.vscode/`、`test-results/`、`pytest.ini`、`package.json` 等开发文件被排除；
运行时 `.py`、`web/`（含 `web/docs/` 节点帮助）、`configs/`、`skills/`、`prompts/`、`example_workflows/`
与 README/LICENSE/pyproject/requirements 留在包里。未跟踪的本地文件（`node_modules/`、`tmp/`、
gallery 缓存、`configs/backyard_oss.json`）已被 `.gitignore` 排除，无需在此重复。
应用仓库的 `README_ZH.md`、`Developer.md` 与 `docs/` 在 `kernel-plugin/` 之外，不进 Registry 包。

Registry 安装只读 `pyproject.toml` 的 `dependencies`，`requirements.txt` 供 ComfyUI-Manager 与开发环境使用，
两边需保持一致；可选增强（`laya` / `pillow-heif` / `oss2`）写在 `[project.optional-dependencies]`。

Registry 与前端搜索的命中靠 `pyproject.toml` 的 `description` / `keywords`，以及节点自身的
`SEARCH_ALIASES`（约定见 [architecture.md](architecture.md) 的「节点元数据」，由 `tests/test_node_metadata.py` 校验）。

### Git Action 方式

- Registry 元数据在 `kernel-plugin/pyproject.toml` 的 `[tool.comfy]`（PublisherId `neoneo-ai`，DisplayName `Neo Studio`）。
- `.github/workflows/publish.yaml`：推送 `v*` tag、发布 Release 或手动触发时，在 `kernel-plugin/` 里跑
  `comfy node publish --token`（需要 `COMFY_REGISTRY_PUBLISH_TOKEN` secret）。发布必须在那一层跑：
  `pyproject.toml` 与 `.comfyignore` 都在 `kernel-plugin/`，仓库根的 `pyproject.toml` 是桌面壳自己的清单。

```bash
# 1. 改版本号（例如改成 1.0.1）：编辑 kernel-plugin/pyproject.toml 里的 version = "1.0.1"
git add kernel-plugin/pyproject.toml
git commit -m "Bump version to 1.0.1"

# 2. 打 tag（指向这个新 commit）
git tag v1.0.1

# 3. 推送代码 + tag，触发发布
git push origin main v1.0.1
```

### comfy cli 方式

```bash
cd kernel-plugin
comfy node publish    # 按提示输入 API TOKEN
```

## 桌面版与源码安装

```powershell
# 桌面壳打包：onefile 单文件 / onedir 目录版 / both；副本 = kernel-plugin 的 git 已跟踪文件
tools\build_studio_exe.ps1 [-Mode onefile|onedir|both] [-DryRun]
tools\build_studio_exe.ps1 -Mode both -Sign -CertThumbprint <指纹>   # signtool 签名 + verify
tools\build_studio_exe.ps1 -Notarize -AppleTeamId <TeamID>          # macOS notarytool（只能在 mac 上）
tools\build_studio_exe.ps1 -Publish                                  # comfy node publish

# 源码安装内核插件：只装代码与内置预设，写好 configs/data_root.json 数据根指针，不删目标目录里的东西
# 脚本是 UTF-8 无 BOM，用 pwsh（PowerShell 7）跑；Windows PowerShell 5.1 会把中文注释读成乱码
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/install_plugin.ps1 -ComfyUI D:\ComfyUI -DataRoot D:\Neo-Studio\data [-SkipDeps] [-DryRun]
```

**改完 `app/studio_app.py` 必须重新打包。** 源码运行桌面壳时每次启动把 `kernel-plugin/` 同步进
`custom_nodes`（只覆盖同名文件，不删目标目录里的东西）；exe 只在内置副本版本更新时才替换插件目录，
git 检出的那份不碰。

窗口与任务栏图标是拍板造型的 `web/neo-studio.ico`（`tools/make_studio_icon.py` 生成），启动器打包时带同款图标。

### Release 工作流

`.github/workflows/release-app.yml` 在打 `v*` tag 时（或手动触发）在 `windows-latest` 上跑同一条
`build_studio_exe.ps1`，把产物挂到该 tag 的 GitHub Release：

- `Neo-Studio-<版本>-windows-x64.exe` —— onefile 单文件，约 52 MB
- `Neo-Studio-<版本>-windows-x64-portable.zip` —— onedir 整包压缩（`Neo-Studio.exe` + `_internal/`，
  解压后整目录直接用，启动不解包、出窗口更快）

默认 `both`，两种形态一起挂上 Release；手动触发只想出一种时把 `mode` 填成 `onefile` 或 `onedir`。

产物是未签名版，首次运行会有 SmartScreen 提示；签名与公证仍走本地 `-Sign` / `-Notarize`（CI 里没有
机器证书，也不在 mac 上跑）。Registry 发布由 `publish.yaml` 负责，两条工作流互不依赖。

CI 打包固定 Python 3.12，与本地验证过的构建一致。

### CLR 托管兜底

壳的窗口是 pywebview 的 WinForms 后端，要 pythonnet 把 .NET 托管起来。部分机器上 .NET Framework（netfx）
托管起不来——AppDomain 里解析不到 `Python.Runtime.Loader.Initialize`，窗口开不出来。壳在 `webview.start()`
前自己 `import clr`，失败就把 `pythonnet` 的 runtime 覆盖成 coreclr 再加载一次：pywebview 自带的 coreclr
兜底在 pythonnet 3.x 上是失效的（netfx 的 runtime 对象已经占住 `pythonnet._RUNTIME`，改环境变量再 import
走的还是那个坏掉的 netfx）。coreclr 要的是桌面运行时（`System.Windows.Forms` 在
`Microsoft.WindowsDesktop.App` 里），随包带的配置是 `tools/coreclr.runtimeconfig.json` → `_internal/runtime/`。
切换会记一行 `clr switched to coreclr` 到 `data/studio_shell.log`。

## 离线工具

`tools/` 下的脚本用于构建 / 部署素材预设，不在 ComfyUI 运行时加载：

```bash
# 1. 预处理：扫描预设目录，生成缩略图与 index.json（需要 ffmpeg 生成视频缩略图）
python tools/gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]

# 增量模式：只新增/更新指定子目录（源目录中已删除的文件会同步清理），
# 自动从 OSS 拉取最新 index.json（configs/oss_presets.json -> index_url）作为合并基准，
# 其余目录保持不变；--no-fetch-index 改为与本地 index.json 合并，--fetch-index <url> 显式指定来源。
# --presets 可省略：默认使用当前工作目录（把新增/更新的目录放在该目录下即可）
cd <dir_with_new_dirs> && python tools/gallery_preprocess.py --output <output_dir> --dirs dir1 dir2

# 2. 部署：上传预处理产物到阿里云 OSS（需要 pip install oss2，
#    凭证从环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT 读取）
python tools/gallery_deploy_oss.py --source <output_dir> --bucket <bucket> --prefix <prefix>
```

部署后的 OSS 源通过 `configs/oss_presets.json` 配置，运行时由 `gallery_oss.py` 拉取到 `gallery/oss_cache/`。
