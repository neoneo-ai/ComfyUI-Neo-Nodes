# SPDX-License-Identifier: Apache-2.0
"""测试桩环境归还：import 期被替换的 sys.modules 在文件末尾还原，避免污染同进程后续测试。"""
import sys


def snapshot(prefixes):
    tops = tuple(f"{p}." for p in prefixes)
    return {k: v for k, v in sys.modules.items() if k in prefixes or k.startswith(tops)}


def restore(prefixes, saved):
    tops = tuple(f"{p}." for p in prefixes)
    for k in list(sys.modules):
        if k in prefixes or k.startswith(tops):
            if k in saved:
                sys.modules[k] = saved[k]
            else:
                del sys.modules[k]


# 节点类测试的桩模块族（server/comfy/folder_paths/nodes 及其子模块）
NODE_STUB_PREFIXES = ("server", "folder_paths", "nodes", "comfy", "comfy_api",
                      "comfy_execution", "comfy_extras", "latent_preview", "node_helpers")
# 画廊/配方类测试的桩模块族
GALLERY_STUB_PREFIXES = ("server", "folder_paths")
