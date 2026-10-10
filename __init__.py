# ComfyUI-Neo-Nodes

# 当插件作为 ComfyUI 自定义节点包加载（__package__ 非空）时才注册节点与路由。
# pytest 收集 tests/ 时会把含连字符目录名的 __init__.py 当作顶层 __init__ 模块
# 导入（此时 __package__ 为空），跳过注册即可；ComfyUI 实际加载始终按包导入。
if __package__ not in (None, ""):
    from .util import plugin_version

    # 入口登记的节点清单：模块导入失败时节点会静默消失，加载结束时按清单核对并打印。
    NEO_NODES = {
        "NeoPromptEncoder": "prompts",
        "NeoPromptAgent": "prompts",
        "NeoImageGenEdit": "image_gen_edit",
        "NeoH3VideoDirector": "h3_video_director",
        "NeoH3AddKeyframe": "h3_video_director",
        "NeoH3AddGuides": "h3_video_director",
        "NeoH3AddContext": "h3_video_director",
        "NeoH3SegmentRun": "h3_segment",
        "NeoBundleExpand": "bundle_expand",
        "NeoRefGrid": "ref_grid",
        "NeoGridSplit": "grid_split_node",
    }

    # Import gallery module to register routes (must be imported for route registration)
    from . import gallery

    # Import LoRA tagging module (gallery leaf-dir batch captioning; depends on gallery + llm)
    from . import lora_tag

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

    # Import voice generation module (CosyVoice 零样本克隆，独立 /neo_voice/* 路由与任务表)
    from . import voice_gen

    # Import from prompts module
    from .prompts import (
        NODE_CLASS_MAPPINGS as PROMPT_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as PROMPT_DISPLAY_NAME_MAPPINGS,
    )

    # 生图/编辑节点（NeoImageGenEdit，方案 A mini-executor）：按 skill workflow.json 同步生成
    # IMAGE 输出。依赖 image_gen/skill 已加载；导入失败时优雅降级，不阻断其它节点。
    IMAGE_GEN_EDIT_MAPPINGS = {}
    IMAGE_GEN_EDIT_DISPLAY_MAPPINGS = {}
    try:
        from .image_gen_edit import (
            NODE_CLASS_MAPPINGS as IMAGE_GEN_EDIT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as IMAGE_GEN_EDIT_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] image_gen_edit 节点注册失败（生图/编辑不可用）: {e}")

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
        print(f"[NeoNodes] h3_video_director 节点注册失败（分镜视频导演不可用）: {e}")

    # 图片分镜（storyboard）：用生图技能逐段生成关键帧，注册 /neo_video_gen/storyboard_* 路由。
    # 独立于 director 节点运行时；依赖 image_gen/skill/image_gen_edit/recipes 已加载。导入失败时优雅降级。
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

    # Neo Reference Grid：参考图宫格节点，宫格槽位（1~12 运行时可调）→ prompt + BUNDLE + image_1..image_12。
    # 依赖 prompts/bundles 已加载；导入失败时优雅降级。
    REF_GRID_MAPPINGS = {}
    REF_GRID_DISPLAY_MAPPINGS = {}
    try:
        from .ref_grid import (
            NODE_CLASS_MAPPINGS as REF_GRID_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as REF_GRID_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] ref_grid 节点注册失败（9宫格参考图不可用）: {e}")

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

    # Neo Studio 独立应用：/neo_studio/* 路由（导演配方整片生成 + 版本信息）；
    # Studio 页面走 /extensions/ComfyUI-Neo-Nodes/studio/ 静态路由提供，前端复用 web/ 现有模块。
    # 依赖 image_gen/recipes 已加载；导入失败时优雅降级。
    try:
        from . import studio  # noqa: F401
    except Exception as e:
        print(f"[NeoNodes] studio 路由注册失败（Neo Studio 整片生成不可用）: {e}")

    # Neo Studio Backyard：/neo_backyard/* 路由（Gallery 预处理 + OSS 上传管理）；
    # 独立页面 /neo-studio-backyard，配置存 configs/backyard_oss.json。
    try:
        from . import backyard  # noqa: F401
    except Exception as e:
        print(f"[NeoNodes] backyard 路由注册失败（Backyard 管理不可用）: {e}")

    # 模型库（Comfy-Org 专区，HF / ModelScope 双源）：/neo_model_hub/* 路由（搜索 / 文件清单 / 断点续传下载）。
    # 纯路由模块，无节点；配置 configs/model_hub.json，策展注册表 configs/model_registry.json。
    try:
        from . import model_hub  # noqa: F401
    except Exception as e:
        print(f"[Neo Model Hub] 模型库路由注册失败（模型搜索下载不可用）: {e}")


    # Neo Grid Split：宫格图拆分节点，一张分镜宫格图 → 各格 IMAGE（行优先）+ 原图内嵌提示词。
    # 复用 grid_split.py 纯像素核心；导入失败时优雅降级。
    GRID_SPLIT_MAPPINGS = {}
    GRID_SPLIT_DISPLAY_MAPPINGS = {}
    try:
        from .grid_split_node import (
            NODE_CLASS_MAPPINGS as GRID_SPLIT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as GRID_SPLIT_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[NeoNodes] grid_split_node 节点注册失败（宫格图拆分不可用）: {e}")

    # Merge all node mappings
    NODE_CLASS_MAPPINGS = {
        **PROMPT_CLASS_MAPPINGS,
        **IMAGE_GEN_EDIT_MAPPINGS,
        **H3_DIRECTOR_MAPPINGS,
        **H3_SEGMENT_MAPPINGS,
        **BUNDLE_EXPAND_MAPPINGS,
        **REF_GRID_MAPPINGS,
        **GRID_SPLIT_MAPPINGS,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        **PROMPT_DISPLAY_NAME_MAPPINGS,
        **IMAGE_GEN_EDIT_DISPLAY_MAPPINGS,
        **H3_DIRECTOR_DISPLAY_MAPPINGS,
        **H3_SEGMENT_DISPLAY_MAPPINGS,
        **BUNDLE_EXPAND_DISPLAY_MAPPINGS,
        **REF_GRID_DISPLAY_MAPPINGS,
        **GRID_SPLIT_DISPLAY_MAPPINGS,
    }

    _missing = [f"{name}({NEO_NODES[name]})" for name in NEO_NODES if name not in NODE_CLASS_MAPPINGS]
    _no_display = sorted(set(NODE_CLASS_MAPPINGS) - set(NODE_DISPLAY_NAME_MAPPINGS))
    _status = f"[NeoNodes] v{plugin_version()} 已注册 {len(NODE_CLASS_MAPPINGS)}/{len(NEO_NODES)} 个节点"
    if _missing:
        _status += f"，缺失: {', '.join(_missing)}"
    if _no_display:
        _status += f"，缺显示名: {', '.join(_no_display)}"
    print(_status)

# Web directory for frontend extensions
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]