# SPDX-License-Identifier: Apache-2.0
# 仓库根兼容入口：`git clone` 直接把仓库克隆成 custom_nodes/comfyui-neo-studio 时，
# ComfyUI 只认仓库根的 __init__.py，插件本体在 studio/ 里，这里把它接上。
# 装进 custom_nodes 的正式副本（Registry 包 / tools/install_plugin.ps1 / 桌面端同步）根目录
# 就是 studio/__init__.py，不经过这个文件。
#
# 只在父目录是 custom_nodes 时注册：ComfyUI 只从 custom_nodes 加载插件。pytest 把仓库根
# 当包导入（conftest 走 Neo-Studio.conftest）时 __package__ 同样非空，插件入口一跑就注册
# 节点与路由，离线环境里 server / folder_paths 是桩，必炸。
from pathlib import Path

WEB_DIRECTORY = "./studio/web"

if Path(__file__).resolve().parent.parent.name == "custom_nodes":
    from .studio import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
