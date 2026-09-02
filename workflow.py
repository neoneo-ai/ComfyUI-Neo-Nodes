# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 工作流后端：工作流模型路径修复与修复 API
# 工作流相关的后端功能集中在此文件，便于后续扩展。
# 前端把工作流载入画布前先调用 POST /neo_nodes/repair 拿到修复建议（changes），
# 由用户二次确认后再载入返回的 repaired workflow；服务端不保存任何状态。

from aiohttp import web
from server import PromptServer

import copy
import os
import re
import difflib

# ---------------------------------------------------------------------------
# Workflow model-path repair
# 导出/换机后的工作流里，模型文件名（ckpt_name 等）经常指向本机不存在的文件。
# 这里在载入前做一次性修复：
#   - COMBO 输入：直接对照节点自身 INPUT_TYPES 里的选项列表模糊匹配
#     （列表就是 loader 自己的文件列表，命中即可加载，允许换扩展名）。
#   - 自由路径（STRING / 无法解析 class_type 的 API 输入）：回落到
#     folder_paths 文件列表，且只接受同扩展名的匹配（不做跨格式替换）。
# 只有得分足够高且明显领先第二名时才改写；否则保留原值并上报候选项。
# ---------------------------------------------------------------------------

REPAIR_ACCEPT_SCORE = 0.85
REPAIR_LEAD_MARGIN = 0.05
MAX_CANDIDATES = 5

# 常见输入名 -> 模型文件夹（核心 loader 的稳定命名）
_MODEL_FOLDER_BY_INPUT = {
    "ckpt_name": "checkpoints",
    "checkpoint_name": "checkpoints",
    "unet_name": "diffusion_models",
    "diffusion_model_name": "diffusion_models",
    "lora_name": "loras",
    "vae_name": "vae",
    "clip_name": "text_encoders",
    "clip_name1": "text_encoders",
    "clip_name2": "text_encoders",
    "clip_name3": "text_encoders",
    "clip_name4": "text_encoders",
    "clip_vision_name": "clip_vision",
    "control_net_name": "controlnet",
    "control_net_name1": "controlnet",
    "control_net_name2": "controlnet",
    "style_model_name": "style_models",
    "latent_upscale_model_name": "latent_upscale_models",
    "model_name": "upscale_models",
    "embedding": "embeddings",
    "hypernetwork": "hypernetworks",
}

# 输入名包含子串时的兜底猜测
_MODEL_FOLDER_HINTS = (
    ("lora", "loras"),
    ("vae", "vae"),
    ("ckpt", "checkpoints"),
    ("checkpoint", "checkpoints"),
    ("unet", "diffusion_models"),
    ("control", "controlnet"),
    ("clip_vision", "clip_vision"),
    ("clip", "text_encoders"),
    ("upscal", "upscale_models"),
    ("embedding", "embeddings"),
    ("hypernet", "hypernetworks"),
)

# 猜不中时依次扫一遍的核心模型文件夹
_MODEL_FOLDER_SWEEP = (
    "checkpoints", "diffusion_models", "loras", "vae", "text_encoders",
    "clip_vision", "controlnet", "style_models", "upscale_models",
    "latent_upscale_models", "embeddings", "hypernetworks", "model_patches",
)

# 非模型加载节点（采样器 / 文本编码 / VAE 编解码等）：不含模型文件引用，
# 修复检查整体跳过（如提示词文本含 "xxx.png" 之类字样不应被当成失效模型路径）
_NON_MODEL_NODE_TYPES = {
    "KSampler", "KSamplerAdvanced", "KSamplerLegacy", "KSamplerConditioning",
    "KSampler (Custom SIGMAS)", "KSamplerSelective", "KSampler (Continuous)",
    "BasicGuider", "BasicScheduler", "SamplerCustom",
    "CLIPTextEncode", "CLIPTextEncode(advanced)",
    "Conditioning", "ConditioningZeroOut", "ConditioningSetArea",
    "VAEDecode", "VAEEncode", "VAEDecodeTiled", "VAEEncodeTiled",
}

_WIDGET_TYPES = {"COMBO", "STRING", "MULTILINE"}
# 全部 widget 输入类型（与 widgets_values 下标对齐用，含数值型）
_WIDGET_INPUT_TYPES = _WIDGET_TYPES | {"INT", "FLOAT", "BOOLEAN"}


def normalize_model_ref(value: str) -> str:
    """Normalize a model filename for comparison: lowercase, keep the stem,
    unify separators to single underscores."""
    v = str(value).strip().replace("\\", "/").lower()
    base = v.rsplit("/", 1)[-1]
    root, _ext = os.path.splitext(base)
    if root:
        base = root
    for sep in (" ", "-", ".", "~"):
        base = base.replace(sep, "_")
    while "__" in base:
        base = base.replace("__", "_")
    return base.strip("_")


def _file_ext(name: str):
    root, ext = os.path.splitext(str(name))
    if not ext or not root:
        return None
    return ext.lower()


def _score_pair(wanted: str, cand: str) -> float:
    """Similarity between two normalized model names, 0..1."""
    if wanted == cand:
        return 1.0
    best = 0.0
    tw, tc = set(re.findall(r"[a-z0-9]+", wanted)), set(re.findall(r"[a-z0-9]+", cand))
    if tw and tc:
        overlap = len(tw & tc) / min(len(tw), len(tc))
        # 长度差异大的（如 "flux1" vs "flux1_dev"）按长度比打折，避免短名虚高
        overlap *= min(len(wanted), len(cand)) / max(len(wanted), len(cand))
        best = max(best, overlap)
    shorter, longer = (wanted, cand) if len(wanted) <= len(cand) else (cand, wanted)
    if len(shorter) >= 6 and shorter in longer:
        ratio = len(shorter) / len(longer)
        if ratio >= 0.6:
            if longer.startswith(shorter):
                # 只差版本号/后缀（"juggernaut_xl" vs "juggernaut_xl_v10"）
                best = max(best, 0.88 + 0.07 * ratio)
            else:
                best = max(best, 0.5 + 0.5 * ratio)
    ratio = difflib.SequenceMatcher(None, wanted, cand).ratio()
    best = max(best, 0.5 + ratio * 0.4)
    return best


def match_model_ref(wanted: str, candidates: list, strict_ext: bool = True):
    """Fuzzy-match `wanted` against a list of file names (relative to one folder).

    Returns (matched_name_or_None, best_score, top_candidates). A match is only
    returned when it scores high enough AND clearly leads the runner-up; ties
    are left for the user to decide. `strict_ext` restricts matches to the
    same file extension as `wanted` (folder fallback only; combo matching
    passes False because the option list IS the loader's file list).
    """
    if not wanted or not candidates:
        return None, 0.0, []
    if wanted in candidates:
        return wanted, 1.0, []
    wanted_norm = normalize_model_ref(wanted)
    if not wanted_norm:
        return None, 0.0, []
    want_ext = _file_ext(wanted)
    scored = []
    for c in candidates:
        if not isinstance(c, str):
            continue
        s = _score_pair(wanted_norm, normalize_model_ref(c))
        if s > 0:
            scored.append((s, c))
    scored.sort(key=lambda p: (-p[0], p[1].count("/"), p[1].lower()))
    pool = scored
    if strict_ext and want_ext:
        pool = [p for p in scored if _file_ext(p[1]) == want_ext]
    if not pool:
        return None, scored[0][0] if scored else 0.0, [c for _, c in scored[:MAX_CANDIDATES]]
    best_score, best_name = pool[0]
    second_score = pool[1][0] if len(pool) > 1 else 0.0
    if best_score >= REPAIR_ACCEPT_SCORE and best_score - second_score >= REPAIR_LEAD_MARGIN:
        return best_name, best_score, [c for _, c in pool[:MAX_CANDIDATES]]
    return None, best_score, [c for _, c in pool[:MAX_CANDIDATES]]


def match_model_file(folder_name: str, wanted: str, strict_ext: bool = True):
    """Resolve `wanted` inside one ComfyUI model folder: exact first, then fuzzy.

    Returns (name_in_folder_or_None, score, candidates).
    """
    if not folder_name or not wanted or not isinstance(wanted, str):
        return None, 0.0, []
    try:
        import folder_paths
        if folder_paths.get_full_path(folder_name, wanted):
            return wanted, 1.0, []
        candidates = folder_paths.get_filename_list(folder_name) or []
    except Exception:
        return None, 0.0, []
    return match_model_ref(wanted, candidates, strict_ext=strict_ext)


def guess_model_folder(input_name: str):
    """Best-effort model folder for an input named `input_name`."""
    if not input_name:
        return None
    name = str(input_name).strip().lower()
    if name in _MODEL_FOLDER_BY_INPUT:
        return _MODEL_FOLDER_BY_INPUT[name]
    for hint, folder in _MODEL_FOLDER_HINTS:
        if hint in name:
            return folder
    return None


def model_folders_to_try(input_name: str) -> list:
    """Ordered model folders to search for a free-path value: guessed folder
    first, then the input name itself (plugins often name the folder after it),
    then the core model folders."""
    try:
        import folder_paths
        known = set(folder_paths.folder_names_and_paths)
    except Exception:
        return []
    tried = []

    def add(folder):
        if folder and folder not in tried and folder in known:
            tried.append(folder)

    add(guess_model_folder(input_name))
    if input_name:
        add(str(input_name).strip().lower())
    for folder in _MODEL_FOLDER_SWEEP:
        add(folder)
    return tried


def _resolvable_anywhere(value: str) -> bool:
    """True if `value` already resolves in any registered model folder."""
    try:
        import folder_paths
    except Exception:
        return False
    for folder in list(folder_paths.folder_names_and_paths.keys()):
        try:
            if folder_paths.get_full_path(folder, value):
                return True
        except Exception:
            continue
    return False


def _resolve_in_folders(input_name: str, value: str, strict_ext: bool = True):
    """Search folders in priority order. Returns
    (name_or_None, score, candidates, folder_or_None)."""
    best = (None, 0.0, [], None)
    for folder in model_folders_to_try(input_name):
        name, score, cands = match_model_file(folder, value, strict_ext=strict_ext)
        if name is not None:
            return name, score, cands, folder
        if score > best[1]:
            best = (None, score, cands, folder)
    return best


def node_input_types(node_class) -> dict:
    """Normalize classic INPUT_TYPES() and v1 GET_NODE_INFO dicts to the classic
    {required/optional: {name: (type_or_options, opts)}} shape."""
    if node_class is None:
        return {}
    data = None
    getter = getattr(node_class, "GET_NODE_INFO_V1", None)
    if callable(getter):
        try:
            data = getter()
        except Exception:
            return {}
    if data is None:
        try:
            data = node_class.INPUT_TYPES()
        except Exception:
            return {}
    if not isinstance(data, dict):
        return {}
    if isinstance(data.get("input"), dict):
        # v1 shape: {"input": {required/optional: ...}, "node_data": ...}
        return data["input"]
    return data


def widget_specs(node_class):
    """Ordered (input_name, widget_type, combo_options) for widget inputs only.

    combo_options is a list (possibly empty) for COMBO inputs, None otherwise.
    Link inputs (MODEL/IMAGE/...) and hidden inputs are excluded, so the order
    matches the node's widgets_values in UI-format workflows.
    """
    types = node_input_types(node_class)
    specs = []
    for section in ("required", "optional"):
        entries = types.get(section)
        if not isinstance(entries, dict):
            continue
        for name, spec in entries.items():
            if not isinstance(spec, (list, tuple)) or not spec:
                continue
            head = spec[0]
            if isinstance(head, list):
                # classic combo form: (["a.safetensors", ...], {...})
                specs.append((name, "COMBO", head))
                continue
            if not isinstance(head, str) or head not in _WIDGET_INPUT_TYPES:
                continue
            if head == "COMBO":
                opts = spec[1] if len(spec) > 1 else None
                if isinstance(opts, dict):
                    options = opts.get("options")
                    options = options if isinstance(options, list) else None
                elif isinstance(opts, list):
                    options = opts  # ("COMBO", [...]) form
                else:
                    options = None
                specs.append((name, "COMBO", options))
            else:
                specs.append((name, head, None))
    return specs


def _change(node_type, node_id, input_name, old, new, score, candidates, reason, folder=None):
    entry = {
        "node": node_id,
        "type": node_type,
        "input": input_name,
        "old": old,
        "new": new,
        "reason": reason,
    }
    if score:
        entry["score"] = round(float(score), 3)
    if candidates:
        entry["candidates"] = list(candidates)[:MAX_CANDIDATES]
    if folder:
        entry["folder"] = folder
    return entry


def _repair_one_ref(input_name: str, value, combo_options):
    """Repair a single model reference. combo_options: list (empty list = the
    loader's list is known and empty) for combo inputs, None for free paths.
    Returns (new_value, (score, candidates, reason, folder)); reason None = no change."""
    if not isinstance(value, str) or not value.strip():
        return value, (0.0, [], None, None)
    if combo_options is not None:
        if value in combo_options:
            return value, (1.0, [], None, None)
        if _file_ext(value) is None and not any(
                _file_ext(o) for o in combo_options if isinstance(o, str)):
            return value, (0.0, [], None, None)  # 非文件 combo（采样器/调度器等）：不是模型引用
        matched, score, cands = match_model_ref(value, combo_options, strict_ext=False)
        if matched:
            return matched, (score, cands, "matched", None)
        return value, (score, cands, "missing", None)
    if _file_ext(value) is None:
        return value, (0.0, [], None, None)  # free text without a file extension: not a model ref
    if _resolvable_anywhere(value):
        return value, (1.0, [], None, None)
    matched, score, cands, folder = _resolve_in_folders(input_name, value, strict_ext=True)
    if matched is not None and matched != value:
        return matched, (score, cands, "matched", folder)
    return value, (score, cands, "missing", folder)


def _repair_value(input_name: str, value, combo_options):
    """Repair a str or list[str] value. Returns (new_value, changes) where each
    change is (old, new_or_None, score, candidates, reason)."""
    if isinstance(value, list):
        out = list(value)
        changes = []
        for i, v in enumerate(out):
            if not isinstance(v, str):
                continue
            nv, (score, cands, reason, folder) = _repair_one_ref(input_name, v, combo_options)
            if reason == "matched" and nv != v:
                out[i] = nv
                changes.append((v, nv, score, cands, "matched", folder))
            elif reason == "missing":
                changes.append((v, None, score, cands, "missing", folder))
        if out == value:
            return value, changes
        return out, changes
    nv, (score, cands, reason, folder) = _repair_one_ref(input_name, value, combo_options)
    if reason == "matched" and nv != value:
        return nv, [(value, nv, score, cands, "matched", folder)]
    if reason == "missing":
        return value, [(value, None, score, cands, "missing", folder)]
    return value, []


def _repair_ui_format(workflow: dict, mappings) -> tuple:
    wf = copy.deepcopy(workflow)
    changes = []
    for node in wf.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("mode") in (2, 4):  # 跳过 Mute(NEVER=2) / Bypass(4) 节点
            continue
        if node.get("type") in _NON_MODEL_NODE_TYPES:
            continue
        widgets = node.get("widgets_values")
        if not isinstance(widgets, list):
            continue
        specs = widget_specs(mappings.get(node.get("type"))) if mappings else None
        if not specs:
            continue
        for i, (name, wtype, options) in enumerate(specs):
            if i >= len(widgets):
                break
            if wtype not in _WIDGET_TYPES:
                continue
            if not isinstance(widgets[i], (str, list)):
                continue
            combo = options if wtype == "COMBO" else None
            new_value, node_changes = _repair_value(name, widgets[i], combo)
            if new_value is not widgets[i]:
                widgets[i] = new_value
            for old, new, score, cands, reason, folder in node_changes:
                changes.append(_change(node.get("type"), node.get("id"), name,
                                       old, new, score, cands, reason, folder=folder))
    return wf, changes


def _repair_api_format(workflow: dict, mappings) -> tuple:
    wf = copy.deepcopy(workflow)
    changes = []
    nodes = wf.get("nodes")
    if isinstance(nodes, dict):
        nodes_dict = nodes
    else:
        nodes_dict = {k: v for k, v in wf.items()
                      if isinstance(v, dict) and "class_type" in v}
    for node_id, node in nodes_dict.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if class_type in _NON_MODEL_NODE_TYPES:
            continue
        cls = mappings.get(class_type) if mappings and class_type else None
        specs = {name: (wtype, options) for name, wtype, options in widget_specs(cls)} if cls else {}
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for name, value in inputs.items():
            if not isinstance(value, (str, list)):
                continue
            spec = specs.get(name)
            if spec is not None:
                wtype, options = spec
                if wtype not in _WIDGET_TYPES:
                    continue
                combo = options if wtype == "COMBO" else None
            elif isinstance(value, str) and _file_ext(value) is None:
                continue  # free text on an unresolvable node: only model filenames
            else:
                combo = None
            new_value, node_changes = _repair_value(name, value, combo)
            if new_value is not value:
                inputs[name] = new_value
            for old, new, score, cands, reason, folder in node_changes:
                changes.append(_change(class_type, node_id, name,
                                       old, new, score, cands, reason, folder=folder))
    return wf, changes


def repair_workflow(workflow, node_class_mappings=None) -> tuple:
    """Repair broken model references in a UI- or API-format workflow.

    Only touches references it can confidently match; resolvable values are
    never modified. Returns (repaired_workflow, changes) where each change is
    a JSON-safe dict ({node, type, input, old, new, reason, ...}); new is None
    for unfixable references (candidates reported for the user to pick).
    """
    if not isinstance(workflow, dict):
        return workflow, []
    nodes = workflow.get("nodes")
    if isinstance(nodes, list):
        return _repair_ui_format(workflow, node_class_mappings)
    if isinstance(nodes, dict):
        return _repair_api_format(workflow, node_class_mappings)
    for v in workflow.values():
        if isinstance(v, dict) and "class_type" in v:
            return _repair_api_format(workflow, node_class_mappings)
    return workflow, []


@PromptServer.instance.routes.post("/neo_nodes/repair")
async def rs_repair_workflow(request):
    """Repair broken model references in a workflow (UI or API format).

    Body: {"workflow": {...}}
    Response: {"success": true, "workflow": <repaired>, "changes": [...],
               "applied": <int>, "missing": <int>}
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON body"}, status=400)
    workflow = data.get("workflow") if isinstance(data, dict) else None
    if not isinstance(workflow, dict):
        return web.json_response({"success": False, "error": "Missing workflow object"}, status=400)
    import nodes
    repaired, changes = repair_workflow(workflow, nodes.NODE_CLASS_MAPPINGS)
    return web.json_response({
        "success": True,
        "workflow": repaired,
        "changes": changes,
        "applied": sum(1 for c in changes if c.get("new")),
        "missing": sum(1 for c in changes if c.get("reason") == "missing"),
    })
