# SPDX-License-Identifier: Apache-2.0
"""离线单测的 comfy_api 引导：把 ComfyUI 根目录加进 sys.path，并补齐 comfy_api.latest 的导入期依赖。

V3 节点（image_gen_edit.py 的 NeoImageGenEdit）导入时会执行 `from comfy_api.latest import io`，
因此在把 comfy / comfy_execution 桩掉的测试环境里，也要先给 comfy_api 备好它需要的子模块占位。
"""

import os
import sys
import types


def _drop_stub(root: str) -> None:
    """删掉别的测试模块留下的假 comfy_api（无 __file__ 的替身），让真实包可导入。"""
    mod = sys.modules.get(root)
    if mod is None or getattr(mod, "__file__", None) is not None:
        return
    for key in [k for k in sys.modules if k == root or k.startswith(root + ".")]:
        del sys.modules[key]


def bootstrap(plugin_dir: str) -> None:
    """让 comfy_api 可在离线测试里导入（须在 _load 插件模块前调用）。"""
    root = os.path.dirname(os.path.dirname(plugin_dir))  # plugin → custom_nodes → ComfyUI
    if root not in sys.path:
        sys.path.insert(0, root)
    _drop_stub("comfy_api")
    if "comfy_execution.utils" not in sys.modules:
        mod = types.ModuleType("comfy_execution.utils")
        mod.get_executing_context = lambda: None
        sys.modules["comfy_execution.utils"] = mod
    if "comfy_execution.graph_utils" not in sys.modules:
        mod = types.ModuleType("comfy_execution.graph_utils")
        mod.ExecutionBlocker = type("ExecutionBlocker", (), {})
        sys.modules["comfy_execution.graph_utils"] = mod
    progress = sys.modules.get("comfy_execution.progress")
    if progress is not None and not hasattr(progress, "PreviewImageTuple"):
        progress.PreviewImageTuple = tuple
