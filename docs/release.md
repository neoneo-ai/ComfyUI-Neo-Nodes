# 发布与离线工具

总入口见 [../Developer.md](../Developer.md)。

## 发布

- Registry 元数据在 `pyproject.toml` 的 `[tool.comfy]`（PublisherId `neoneo-ai`，DisplayName `Neo Nodes`）
- `.github/workflows/publish.yaml`：推送 `v*` tag、发布 Release 或手动触发时，通过 `comfy-org/publish-node-action` 发布至 ComfyUI Registry（需要 `COMFY_REGISTRY_PUBLISH_TOKEN` secret）

## 离线工具

`tools/` 下的脚本用于构建/部署素材预设，不在 ComfyUI 运行时加载：

```bash
# 1. 预处理：扫描预设目录，生成缩略图与 index.json（需要 ffmpeg 生成视频缩略图）
python tools/gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]

# 增量模式：只新增/更新指定子目录（源目录中已删除的文件会同步清理），
# 自动从 OSS 拉取最新 index.json（configs/oss_presets.json -> index_url）作为合并基准，
# 其余目录保持不变；--no-fetch-index 改为与本地 index.json 合并，
# --fetch-index <url> 可显式指定其它来源。
# --presets 可省略：默认使用当前工作目录（把新增/更新的目录放在该目录下即可）
cd <dir_with_new_dirs> && python tools/gallery_preprocess.py --output <output_dir> --dirs dir1 dir2

# 2. 部署：上传预处理产物到阿里云 OSS（需要 pip install oss2，
#    凭证从环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT 读取）
python tools/gallery_deploy_oss.py --source <output_dir> --bucket <bucket> --prefix <prefix>
```

部署后的 OSS 源通过 `configs/oss_presets.json` 配置，运行时由 `gallery_oss.py` 拉取到 `gallery/oss_cache/`。
