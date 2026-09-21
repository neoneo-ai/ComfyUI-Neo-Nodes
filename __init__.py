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

    # Import built-in image generation module (registers /neo_image_gen/* routes)
    from . import image_gen

    # Import video generation settings module (registers /neo_video_gen/* routes; 独立于生图设置文件)
    from . import video_gen

    # Import from prompts module
    from .prompts import (
        NODE_CLASS_MAPPINGS as PROMPT_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as PROMPT_DISPLAY_NAME_MAPPINGS,
    )

    # Krea2 以图生图核心节点（vendor 自 comfyui-krea2edit）。若用户已单独安装该插件，
    # 同名节点已在注册表中，跳过以避免重复注册告警。
    KREA2_EDIT_MAPPINGS = {}
    KREA2_EDIT_DISPLAY_MAPPINGS = {}
    try:
        import nodes as _nodes_registry
        if "Krea2EditModelPatch" in _nodes_registry.NODE_CLASS_MAPPINGS:
            print("[NeoNodes] krea2_edit: comfyui-krea2edit 已安装，跳过内置节点注册")
        else:
            from .krea2_edit import (
                NODE_CLASS_MAPPINGS as KREA2_EDIT_MAPPINGS,
                NODE_DISPLAY_NAME_MAPPINGS as KREA2_EDIT_DISPLAY_MAPPINGS,
            )
    except Exception as e:
        print(f"[NeoNodes] krea2_edit 节点注册失败（以图生图不可用）: {e}")

    # Krea2 生图节点（方案 A mini-executor）：按 skill workflow.json 同步生成 IMAGE 输出。
    # 依赖 image_gen/skill 已加载；导入失败时优雅降级，不阻断其它节点。
    KREA2_GENERATE_MAPPINGS = {}
    KREA2_GENERATE_DISPLAY_MAPPINGS = {}
    try:
        from .krea2_generate import (
            NODE_CLASS_MAPPINGS as KREA2_GENERATE_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as KREA2_GENERATE_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] krea2_generate 节点注册失败（生图不可用）: {e}")

    # Neo H3 Video Director：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO。
    # 复用单段 H3 解析/执行链；导入失败时优雅降级。
    H3_DIRECTOR_MAPPINGS = {}
    H3_DIRECTOR_DISPLAY_MAPPINGS = {}
    try:
        from .h3_video_director import (
            NODE_CLASS_MAPPINGS as H3_DIRECTOR_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as H3_DIRECTOR_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] h3_video_director 节点注册失败（多段视频导演不可用）: {e}")

    # 图片分镜（storyboard）：用生图技能逐段生成关键帧，注册 /neo_video_gen/storyboard_* 路由。
    # 独立于 director 节点运行时；依赖 image_gen/skill/krea2_generate/recipes 已加载。导入失败时优雅降级。
    try:
        from . import storyboard  # noqa: F401
    except Exception as e:
        print(f"[NeoNodes] storyboard 路由注册失败（图片分镜不可用）: {e}")

    # Neo Bundle Expand：把 NeoPromptAgent 的 BUNDLE 展开成 prompt + image，便于对接官方 MiniMax H3 视频节点。
    # 依赖 prompts/bundles 已加载；导入失败时优雅降级。
    BUNDLE_EXPAND_MAPPINGS = {}
    BUNDLE_EXPAND_DISPLAY_MAPPINGS = {}
    try:
        from .bundle_expand import (
            NODE_CLASS_MAPPINGS as BUNDLE_EXPAND_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as BUNDLE_EXPAND_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] bundle_expand 节点注册失败（BUNDLE 展开不可用）: {e}")

    # Neo H3 单段生成/重生成（h3_segment.py）：NeoH3SegmentRun 节点 + /neo_video_gen/run_segment* 路由。
    # 走执行队列，节点是为"单段调试"准备的；导入失败时优雅降级。
    H3_SEGMENT_MAPPINGS = {}
    H3_SEGMENT_DISPLAY_MAPPINGS = {}
    try:
        from .h3_segment import (
            NODE_CLASS_MAPPINGS as H3_SEGMENT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as H3_SEGMENT_DISPLAY_MAPPINGS,
        )
        # 段落拼接（h3_assemble.py）：只注册 /neo_video_gen/segment_clips + assemble_segments* 路由。
        from . import h3_assemble  # noqa: F401
    except Exception as e:
        print(f"[NeoNodes] h3_segment 节点注册失败（单段生成/重生成不可用）: {e}")

    # Merge all node mappings
    NODE_CLASS_MAPPINGS = {
        **PROMPT_CLASS_MAPPINGS,
        **KREA2_EDIT_MAPPINGS,
        **KREA2_GENERATE_MAPPINGS,
        **H3_DIRECTOR_MAPPINGS,
        **H3_SEGMENT_MAPPINGS,
        **BUNDLE_EXPAND_MAPPINGS,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        **PROMPT_DISPLAY_NAME_MAPPINGS,
        **KREA2_EDIT_DISPLAY_MAPPINGS,
        **KREA2_GENERATE_DISPLAY_MAPPINGS,
        **H3_DIRECTOR_DISPLAY_MAPPINGS,
        **H3_SEGMENT_DISPLAY_MAPPINGS,
        **BUNDLE_EXPAND_DISPLAY_MAPPINGS,
    }

# Web directory for frontend extensions
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]