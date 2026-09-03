# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes — 工作流后端：工作流模型路径修复与修复 API
# 工作流相关的后端功能集中在此文件，便于后续扩展。
# 前端在修复检查时调用 POST /neo_nodes/repair 拿到修复建议（changes），
# 由用户二次确认后载入返回的 repaired workflow；自动匹配失败的项可在弹窗中手动
# 选择替换文件，确认时服务端把选择保存为修复映射（用户目录 neo_repair_mappings.json），
# 之后的相同失效路径按映射自动替换。

from aiohttp import web
from server import PromptServer

import copy
import json
import os
import re
import difflib

# ---------------------------------------------------------------------------
# Workflow model-path repair
# 导出/换机后的工作流里，模型文件名（ckpt_name 等）经常指向本机不存在的文件。
# 这里在载入前做一次性修复：
#   - COMBO 输入：直接对照节点自身 INPUT_TYPES 里的选项列表模糊匹配
#     （列表就是 loader 自己的文件列表，命中即可加载，允许换扩展名与量化变体）。
#   - 自由路径（STRING / 无法解析 class_type 的 API 输入）：回落到
#     folder_paths 文件列表，且只接受同扩展名的匹配（不做跨格式替换）。
# 只有得分足够高且明显领先第二名时才改写；否则保留原值并上报候选项。
# ---------------------------------------------------------------------------

REPAIR_ACCEPT_SCORE = 0.85
REPAIR_LEAD_MARGIN = 0.05
MAX_CANDIDATES = 5

# 匹配置信档位（前端确认弹窗三档可选）：strict 提高接受分（宁缺毋滥），loose 降低
# 换更大覆盖率——低于标准档的改动由前端默认不勾选，用户确认后才应用。
REPAIR_THRESHOLD_SCORES = {"strict": 0.92, "standard": REPAIR_ACCEPT_SCORE, "loose": 0.72}

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

# 非模型加载节点（采样器 / 文本编码 / VAE 编解码 / 图片加载等）：不含模型文件引用，
# 修复检查整体跳过（如提示词文本含 "xxx.png" 之类字样、或 LoadImage 的输入图路径，
# 都不应被当成失效模型路径去替换）
_NON_MODEL_NODE_TYPES = {
    "KSampler", "KSamplerAdvanced", "KSamplerLegacy", "KSamplerConditioning",
    "KSampler (Custom SIGMAS)", "KSamplerSelective", "KSampler (Continuous)",
    "BasicGuider", "BasicScheduler", "SamplerCustom",
    "CLIPTextEncode", "CLIPTextEncode(advanced)",
    "Conditioning", "ConditioningZeroOut", "ConditioningSetArea",
    "VAEDecode", "VAEEncode", "VAEDecodeTiled", "VAEEncodeTiled",
    "LoadImage", "LoadImageMask", "LoadImageOutput",
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


def _norm_path_key(value: str) -> str:
    """Path normalization key for "already present" checks only: unify separators,
    strip a leading ./, case-fold. Deliberately NOT applied to scoring."""
    v = str(value).strip().replace("\\", "/")
    while v.startswith("./"):
        v = v[2:]
    return v.lower()


def _path_lookup_variants(value: str) -> list:
    """Lookup variants for folder_paths resolution: original plus separator/./-fixed."""
    v = str(value)
    variants = [v]
    alt = v.replace("\\", "/").lstrip("./")
    if alt != v and alt:
        variants.append(alt)
    return variants


def _variant_in(value, options) -> bool:
    """True if one of `options` is the same file as `value` up to separator,
    ./ prefix and case differences (avoids false "missing" reports)."""
    if not isinstance(options, list):
        return False
    key = _norm_path_key(value)
    if not key:
        return False
    return any(isinstance(o, str) and _norm_path_key(o) == key for o in options)


# 受支持的模型文件后缀：ComfyUI folder_paths.supported_pt_extensions，外加常见量化/
# 视觉推理格式 .gguf（ComfyUI-GGUF）与 .onnx（人脸分析/检测/换脸等）。命中才视为模型引用；
# 提示词文本、输入图路径、媒体及 .json/.txt 元信息等不参与修复。
_MODEL_FILE_EXTS = {".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft", ".gguf", ".onnx"}


def _is_model_file_ext(ext):
    return ext in _MODEL_FILE_EXTS if ext else False


# 量化标记 token：模型名仅在这些标记上不同时视为同一模型的另一量化（只是精度差异），
# 允许高置信度互换；GGUF 的 Q4_K_M 之类含 k/m 等通用 token 的多级标记不在此列，
# 仍走通用模糊匹配。
_QUANT_TOKENS = {
    "fp32", "fp16", "bf16", "fp8", "int8", "int4",
    "e4m3fn", "e5m2", "scaled", "nf4", "nvfp4",
    "q2", "q3", "q4", "q5", "q6", "q8",
}


def _score_pair(wanted: str, cand: str) -> float:
    """Similarity between two normalized model names, 0..1."""
    if wanted == cand:
        return 1.0
    best = 0.0
    tw, tc = set(re.findall(r"[a-z0-9]+", wanted)), set(re.findall(r"[a-z0-9]+", cand))
    stripped_w = {t for t in tw if t not in _QUANT_TOKENS}
    stripped_c = {t for t in tc if t not in _QUANT_TOKENS}
    if stripped_w and stripped_c and stripped_w == stripped_c:
        return 0.9  # 仅量化标记不同：同一模型的另一量化（bf16 ↔ fp8_scaled）
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


def match_model_ref(wanted: str, candidates: list, strict_ext: bool = True, min_score: float = REPAIR_ACCEPT_SCORE):
    """Fuzzy-match `wanted` against a list of file names (relative to one folder).

    Returns (matched_name_or_None, best_score, top_candidates). A match is only
    returned when it scores high enough AND clearly leads the runner-up; ties
    are left for the user to decide. `strict_ext` restricts matches to the
    same file extension as `wanted` (folder fallback only; combo matching
    passes False because the option list IS the loader's file list).
    `min_score` overrides the acceptance threshold (threshold presets).
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
    if best_score >= min_score and best_score - second_score >= REPAIR_LEAD_MARGIN:
        return best_name, best_score, [c for _, c in pool[:MAX_CANDIDATES]]
    return None, best_score, [c for _, c in pool[:MAX_CANDIDATES]]


def match_model_file(folder_name: str, wanted: str, strict_ext: bool = True, min_score: float = REPAIR_ACCEPT_SCORE):
    """Resolve `wanted` inside one ComfyUI model folder: exact first, then fuzzy.

    Returns (name_in_folder_or_None, score, candidates).
    """
    if not folder_name or not wanted or not isinstance(wanted, str):
        return None, 0.0, []
    try:
        import folder_paths
        resolved = False
        for v in _path_lookup_variants(wanted):
            try:
                if folder_paths.get_full_path(folder_name, v):
                    resolved = True
                    break
            except Exception:
                continue
        if resolved:
            return wanted, 1.0, []
        candidates = folder_paths.get_filename_list(folder_name) or []
    except Exception:
        return None, 0.0, []
    return match_model_ref(wanted, candidates, strict_ext=strict_ext, min_score=min_score)


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
    variants = _path_lookup_variants(value)
    for folder in list(folder_paths.folder_names_and_paths.keys()):
        for v in variants:
            try:
                if folder_paths.get_full_path(folder, v):
                    return True
            except Exception:
                continue
    return False


def _resolve_in_folders(input_name: str, value: str, strict_ext: bool = True, min_score: float = REPAIR_ACCEPT_SCORE):
    """Search folders in priority order. Returns
    (name_or_None, score, candidates, folder_or_None)."""
    best = (None, 0.0, [], None)
    for folder in model_folders_to_try(input_name):
        name, score, cands = match_model_file(folder, value, strict_ext=strict_ext, min_score=min_score)
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
        # 宽松档接受的低分改动：前端默认不勾选，用户确认后才应用
        if new and reason in ("matched", "chosen", "mapped") and float(score) < REPAIR_ACCEPT_SCORE:
            entry["low_confidence"] = True
    if candidates:
        entry["candidates"] = list(candidates)[:MAX_CANDIDATES]
    if folder:
        entry["folder"] = folder
    return entry


def _repair_one_ref(input_name: str, value, combo_options, ctx=None, node_id=None):
    """Repair a single model reference. combo_options: list (empty list = the
    loader's list is known and empty) for combo inputs, None for free paths.
    ctx carries the user's manual decisions {(str(node_id), input, old): {...}}
    (a decision with skip=True keeps the current value), the stored repair
    mappings ({} when disabled) and the acceptance threshold min_score.
    Returns (new_value, (score, candidates, reason, folder)); reason None = no change."""
    if not isinstance(value, str) or not value.strip():
        return value, (0.0, [], None, None)
    ctx = ctx or {}
    min_score = ctx.get("min_score") or REPAIR_ACCEPT_SCORE
    decision = ctx.get("decisions", {}).get((str(node_id), input_name, value))
    if decision and decision.get("skip"):
        return value, (0.0, [], None, None)
    if combo_options is not None:
        if value in combo_options:
            return value, (1.0, [], None, None)
        if _variant_in(value, combo_options):
            return value, (1.0, [], None, None)  # 同一文件的分隔符/./前缀变体：已存在
        if not any(_file_ext(o) for o in combo_options if isinstance(o, str)):
            return value, (0.0, [], None, None)  # 非文件 combo（采样器/调度器等）：不是模型引用
        vext = _file_ext(value)
        if vext is not None and not _is_model_file_ext(vext):
            return value, (0.0, [], None, None)  # 有扩展名但非模型后缀（如输入图 .png）：不是模型引用
        folder = guess_model_folder(input_name)
        if decision and decision["value"] in combo_options:
            return decision["value"], (0.0, [], "chosen", folder or decision["folder"])
        mapped = _mapped_replacement(ctx.get("mappings"), folder, value)
        if mapped and mapped in combo_options:
            return mapped, (0.0, [], "mapped", folder)
        matched, score, cands = match_model_ref(value, combo_options, strict_ext=False, min_score=min_score)
        if matched:
            return matched, (score, cands, "matched", None)
        return value, (score, cands, "missing", None)
    if not _is_model_file_ext(_file_ext(value)):
        return value, (0.0, [], None, None)  # 无受支持模型后缀：不是模型引用（提示词/图片路径等）
    if _resolvable_anywhere(value):
        return value, (1.0, [], None, None)
    if decision and _resolvable_anywhere(decision["value"]):
        return decision["value"], (0.0, [], "chosen",
                                   guess_model_folder(input_name) or decision["folder"])
    matched, score, cands, folder = _resolve_in_folders(input_name, value, strict_ext=True, min_score=min_score)
    if matched is not None and matched != value:
        return matched, (score, cands, "matched", folder)
    mfolder = folder or guess_model_folder(input_name)
    mapped = _mapped_replacement(ctx.get("mappings"), mfolder, value)
    if mapped:
        return mapped, (0.0, [], "mapped", mfolder)
    return value, (score, cands, "missing", folder)


def _repair_value(input_name: str, value, combo_options, ctx=None, node_id=None):
    """Repair a str or list[str] value. Returns (new_value, changes) where each
    change is (old, new_or_None, score, candidates, reason)."""
    if isinstance(value, list):
        out = list(value)
        changes = []
        for i, v in enumerate(out):
            if not isinstance(v, str):
                continue
            nv, (score, cands, reason, folder) = _repair_one_ref(input_name, v, combo_options, ctx, node_id)
            if reason in ("matched", "chosen", "mapped") and nv != v:
                out[i] = nv
                changes.append((v, nv, score, cands, reason, folder))
            elif reason == "missing":
                changes.append((v, None, score, cands, "missing", folder))
        if out == value:
            return value, changes
        return out, changes
    nv, (score, cands, reason, folder) = _repair_one_ref(input_name, value, combo_options, ctx, node_id)
    if reason in ("matched", "chosen", "mapped") and nv != value:
        return nv, [(value, nv, score, cands, reason, folder)]
    if reason == "missing":
        return value, [(value, None, score, cands, "missing", folder)]
    return value, []


def _repair_ui_format(workflow: dict, mappings, ctx=None) -> tuple:
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
            new_value, node_changes = _repair_value(name, widgets[i], combo, ctx, node.get("id"))
            if new_value is not widgets[i]:
                widgets[i] = new_value
            for old, new, score, cands, reason, folder in node_changes:
                changes.append(_change(node.get("type"), node.get("id"), name,
                                       old, new, score, cands, reason, folder=folder))
    return wf, changes


def _repair_api_format(workflow: dict, mappings, ctx=None) -> tuple:
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
            elif isinstance(value, str) and not _is_model_file_ext(_file_ext(value)):
                continue  # 非模型后缀的自由文本：不视为模型引用
            else:
                combo = None
            new_value, node_changes = _repair_value(name, value, combo, ctx, node_id)
            if new_value is not value:
                inputs[name] = new_value
            for old, new, score, cands, reason, folder in node_changes:
                changes.append(_change(class_type, node_id, name,
                                       old, new, score, cands, reason, folder=folder))
    return wf, changes


def _repair_widget_refs(workflow, refs, ctx, skip_keys=()) -> list:
    """Repair live-widget references sent by the frontend (UI format only).

    refs: [{node, input, index, value, options?}] — name/index/value come from
    the actual on-canvas widgets, options is the widget's own options.values
    (the loader's real file list). This covers dynamic widgets that INPUT_TYPES
    cannot express. A ref is processed only when widgets_values[index] still
    equals ref.value (the specs pass may have fixed it already) and its
    (node, input, old) key was not reported by the specs pass.
    """
    changes = []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list) or not isinstance(refs, list):
        return changes
    by_id = {}
    for n in nodes:
        if isinstance(n, dict) and n.get("id") is not None:
            by_id[str(n.get("id"))] = n
    seen = set()
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        node = by_id.get(str(ref.get("node")))
        if not node or node.get("mode") in (2, 4):  # 跳过 Mute / Bypass
            continue
        widgets = node.get("widgets_values")
        if not isinstance(widgets, list):
            continue
        try:
            idx = int(ref.get("index"))
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(widgets):
            continue
        old = ref.get("value")
        if not isinstance(old, str) or not old.strip() or widgets[idx] != old:
            continue  # 位置对不上或已被 specs 流程修复
        input_name = ref.get("input")
        if not isinstance(input_name, str) or not input_name:
            continue
        key = (str(node.get("id")), input_name, old)
        if key in seen or key in skip_keys:
            continue
        seen.add(key)
        options = ref.get("options")
        combo = options if isinstance(options, list) and all(isinstance(o, str) for o in options) else None
        new_value, node_changes = _repair_value(input_name, old, combo, ctx, node.get("id"))
        if new_value is not old:
            widgets[idx] = new_value
        for vold, vnew, score, cands, reason, folder in node_changes:
            changes.append(_change(node.get("type"), node.get("id"), input_name,
                                   vold, vnew, score, cands, reason, folder=folder))
    return changes


def repair_workflow(workflow, node_class_mappings=None, decisions=None, use_mappings=True,
                    widget_refs=None, min_score=None) -> tuple:
    """Repair broken model references in a UI- or API-format workflow.

    Only touches references it can confidently match; resolvable values are
    never modified. Returns (repaired_workflow, changes) where each change is
    a JSON-safe dict ({node, type, input, old, new, reason, ...}); new is None
    for unfixable references (candidates reported for the user to pick).
    decisions: 修复弹窗中的手动选择 [{node, input, old, value, folder, skip?}]，
    命中时按 reason="chosen" 改写；skip=True 的改动保持原值；use_mappings=False
    跳过已保存的手动修复映射（命中的记为 reason="mapped"）。
    widget_refs: 前端传来的实时 widget 引用 [{node, input, index, value, options?}]，
    覆盖 INPUT_TYPES 表达不了的动态 widget（自定义 loader 运行时添加的模型项等）；
    options 是前端 widget.options.values（loader 真实文件列表）。仅 UI 格式生效。
    min_score: 接受分覆盖（阈值档位），None 用 REPAIR_ACCEPT_SCORE。
    """
    if not isinstance(workflow, dict):
        return workflow, []
    ctx = {
        "decisions": _normalize_decisions(decisions),
        "mappings": load_repair_mappings() if use_mappings else {},
        "min_score": float(min_score) if isinstance(min_score, (int, float)) and 0 < float(min_score) <= 1 else REPAIR_ACCEPT_SCORE,
        "widget_refs": widget_refs if isinstance(widget_refs, list) else None,
    }
    nodes = workflow.get("nodes")
    if isinstance(nodes, list):
        wf, changes = _repair_ui_format(workflow, node_class_mappings, ctx)
        if ctx["widget_refs"]:
            # specs 流程已处理的 (node, input, old) 不再由 refs 重复处理
            done = {(str(c.get("node")), c.get("input"), c.get("old")) for c in changes}
            changes.extend(_repair_widget_refs(wf, ctx["widget_refs"], ctx, skip_keys=done))
        return wf, changes
    if isinstance(nodes, dict):
        return _repair_api_format(workflow, node_class_mappings, ctx)
    for v in workflow.values():
        if isinstance(v, dict) and "class_type" in v:
            return _repair_api_format(workflow, node_class_mappings, ctx)
    return workflow, []


# ---------------------------------------------------------------------------
# 手动修复映射：用户在修复弹窗中手动选择替换文件并勾选「记住」后持久化到这里，
# 键为 (模型文件夹, 归一化失效路径)，大小写/扩展名/分隔符差异视为相同路径；
# 替换目标文件被删除时映射自动失效。
# ---------------------------------------------------------------------------

def _mapping_key(folder: str, value: str) -> str:
    return f"{folder}|{normalize_model_ref(value)}"


def _mappings_file() -> str:
    try:
        import folder_paths
        return os.path.join(folder_paths.get_user_directory(), "neo_repair_mappings.json")
    except Exception:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "neo_repair_mappings.json")


def load_repair_mappings() -> dict:
    try:
        with open(_mappings_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_repair_mappings(mappings: dict) -> None:
    try:
        path = _mappings_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(mappings, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"[Neo-Nodes] 修复映射保存失败: {e}")


def add_repair_mappings(entries) -> list:
    """Persist {folder, wanted, replacement} entries. Returns the stored keys."""
    mappings = load_repair_mappings()
    keys = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        folder, wanted, replacement = entry.get("folder"), entry.get("wanted"), entry.get("replacement")
        if not folder or not wanted or not replacement:
            continue
        key = _mapping_key(folder, wanted)
        mappings[key] = {"folder": folder, "wanted": wanted, "replacement": replacement}
        keys.append(key)
    if keys:
        save_repair_mappings(mappings)
    return keys


def delete_repair_mapping(key: str) -> bool:
    mappings = load_repair_mappings()
    if key not in mappings:
        return False
    del mappings[key]
    save_repair_mappings(mappings)
    return True


def clear_repair_mappings() -> None:
    save_repair_mappings({})


def _resolvable_in_folder(folder: str, name: str) -> bool:
    try:
        import folder_paths
        return bool(folder_paths.get_full_path(folder, name))
    except Exception:
        return False


def _mapped_replacement(mappings, folder, value):
    """Stored mapping replacement for `value` under `folder`, or None when the
    mapping is absent or its replacement file no longer resolves."""
    if not mappings or not folder:
        return None
    entry = mappings.get(_mapping_key(folder, value))
    if not isinstance(entry, dict):
        return None
    replacement = entry.get("replacement")
    if not replacement or not _resolvable_in_folder(folder, replacement):
        return None
    return replacement


def _normalize_decisions(decisions) -> dict:
    """[{node, input, old, value, folder?, skip?}] -> {(str(node), input, old): {...}}."""
    out = {}
    for d in decisions if isinstance(decisions, list) else []:
        if not isinstance(d, dict):
            continue
        node, input_name, old, value = d.get("node"), d.get("input"), d.get("old"), d.get("value")
        if not isinstance(input_name, str) or not isinstance(old, str) or not isinstance(value, str):
            continue
        if not value.strip():
            continue
        entry = {
            "value": value,
            "folder": d.get("folder") if isinstance(d.get("folder"), str) else None,
        }
        if d.get("skip"):
            entry["skip"] = True  # 低置信改动用户未勾选：保持原值
        out[(str(node), input_name, old)] = entry
    return out


@PromptServer.instance.routes.post("/neo_nodes/repair")
async def rs_repair_workflow(request):
    """Repair broken model references in a workflow (UI or API format).

    Body: {"workflow": {...}, "decisions": [...], "remember": bool}
    decisions 是修复弹窗中的手动选择 [{node, input, old, value, folder}]；
    remember=true 时把这些选择保存为修复映射，之后相同失效路径自动替换。
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
    decisions = data.get("decisions") if isinstance(data, dict) else None
    threshold = data.get("threshold") if isinstance(data, dict) else None
    min_score = REPAIR_THRESHOLD_SCORES.get(str(threshold).lower()) if isinstance(threshold, str) else None
    widget_refs = data.get("widget_refs") if isinstance(data, dict) else None
    import nodes
    repaired, changes = repair_workflow(workflow, nodes.NODE_CLASS_MAPPINGS, decisions=decisions,
                                        widget_refs=widget_refs, min_score=min_score)
    if decisions and data.get("remember"):
        add_repair_mappings([
            {"folder": c.get("folder"), "wanted": c.get("old"), "replacement": c.get("new")}
            for c in changes if c.get("reason") == "chosen"
        ])
    return web.json_response({
        "success": True,
        "workflow": repaired,
        "changes": changes,
        "applied": sum(1 for c in changes if c.get("new")),
        "missing": sum(1 for c in changes if c.get("reason") == "missing"),
    })


@PromptServer.instance.routes.get("/neo_nodes/repair_mappings")
async def rs_get_repair_mappings(request):
    mappings = load_repair_mappings()
    items = [dict(entry, key=key) for key, entry in sorted(mappings.items()) if isinstance(entry, dict)]
    return web.json_response({"success": True, "mappings": items})


@PromptServer.instance.routes.delete("/neo_nodes/repair_mappings")
async def rs_delete_repair_mappings(request):
    key = request.query.get("key")
    if not key:
        return web.json_response({"success": False, "error": "Missing key"}, status=400)
    if key == "all":
        clear_repair_mappings()
    elif not delete_repair_mapping(key):
        return web.json_response({"success": False, "error": "Unknown mapping"}, status=404)
    return web.json_response({"success": True})
