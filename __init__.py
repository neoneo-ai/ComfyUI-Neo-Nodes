# ComfyUI-Neo-Nodes

# 当插件作为 ComfyUI 自定义节点包加载（__package__ 非空）时才注册节点与路由。
# pytest 收集 tests/ 时会把含连字符目录名的 __init__.py 当作顶层 __init__ 模块
# 导入（此时 __package__ 为空），跳过注册即可；ComfyUI 实际加载始终按包导入。
if __package__ not in (None, ""):
    # Import gallery module to register routes (must be imported for route registration)
    from . import gallery

    # Import bookmark module (local / Civitai bookmark routes; depends on gallery helpers)
    from . import bookmark

    # Import recipes module (depends on gallery helpers and bookmark download helpers)
    from . import recipes

    # Import workflow module (workflow repair API; registers /neo_nodes/repair route)
    from . import workflow

    # Import from prompts module
    from .prompts import (
        NODE_CLASS_MAPPINGS as PROMPT_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as PROMPT_DISPLAY_NAME_MAPPINGS,
    )

    # Merge all node mappings
    NODE_CLASS_MAPPINGS = {
        **PROMPT_CLASS_MAPPINGS,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        **PROMPT_DISPLAY_NAME_MAPPINGS,
    }

# Web directory for frontend extensions
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]