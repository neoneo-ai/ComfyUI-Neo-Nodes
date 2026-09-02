# ComfyUI-Neo-Nodes

# Import gallery module to register routes (must be imported for route registration)
from . import gallery

# Import recipes module (depends on gallery helpers; registers recipe routes)
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