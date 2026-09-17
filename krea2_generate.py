"""Krea2 生图节点：按所选 skill 的 workflow.json 模板同步生成，输出 IMAGE 张量到下游。

设计（方案 A）：
- NeoKrea2Generate 在 forward 内复用 image_gen.render_template() 产出 API prompt graph，
  再由进程内 mini-executor (execute_graph_inprocess) 拓扑执行该 graph，返回末端 IMAGE 张量。
- 不嵌套官方 PromptExecutor（避免进度重置 / 模型清理 / client 状态变更），直接调用各节点 forward。
- 跳过 SaveImage/Preview 等落盘输出节点；遇到未知或异步节点明确报错，不静默降级。
"""

import base64
import inspect
import io

import torch
from aiohttp import web
from PIL import Image

import nodes as comfy_nodes
from server import PromptServer
from .image_gen import DEFAULT_SETTINGS, MAX_IMAGES, get_settings, render_template, resolve_dimensions, resolve_request
from .skill import get_skill_gen_config, load_skill_workflow, scan_skills
from .bundles import get_bundle

routes = PromptServer.instance.routes

# 落盘/预览输出节点：mini-executor 不执行（避免重复写盘与事件副作用）
_SKIP_OUTPUT_NODES = {"SaveImage", "PreviewImage", "SaveVideo"}


# ===========================================================================
# mini-executor：进程内同步执行 render_template 产出的 API prompt graph
# ===========================================================================

def _is_ref(value, graph):
    """判定 [node_id, index] 引用（node_id 必须是 graph 里的节点）。"""
    return isinstance(value, (list, tuple)) and len(value) == 2 \
        and isinstance(value[0], str) and value[0] in graph


def _topo_order(graph):
    """Kahn 拓扑排序，返回执行顺序；检测到环则报错。同层按 node_id 排序保证确定性。"""
    deps = {nid: set() for nid in graph}
    for nid, node in graph.items():
        for v in (node.get("inputs") or {}).values():
            if _is_ref(v, graph):
                deps[nid].add(v[0])
    order, done = [], set()
    while len(order) < len(graph):
        ready = [nid for nid in graph if nid not in done and deps[nid] <= done]
        if not ready:
            raise RuntimeError(
                f"[NeoNodes] Krea2 生图 workflow 存在循环依赖: {sorted(set(graph) - done)}")
        for nid in sorted(ready):
            order.append(nid)
            done.add(nid)
    return order


def _hidden_value(spec, node_id):
    if spec == "UNIQUE_ID":
        return node_id
    if spec == "PROMPT":
        return {}
    return None  # EXTRA_PNGINFO 等


def _normalize_outputs(result, return_types):
    """按 RETURN_TYPES 归一化 forward 返回值：单输出包成 [x]，多输出转 list。"""
    if len(return_types) == 1:
        if isinstance(result, tuple) and len(result) == 1:
            return [result[0]]
        return [result]
    if not isinstance(result, (tuple, list)):
        result = (result,)
    return list(result)


def _is_api_node(class_def):
    """V3 API 节点（io.ComfyNode）：带 define_schema，execute 为 classmethod。"""
    return hasattr(class_def, "define_schema")


def _api_outputs(result):
    """V3 节点 execute() 返回 NodeOutput（值在 .args）/tuple/单值 → 输出列表。"""
    if isinstance(result, (tuple, list)):
        return list(result)
    args = getattr(result, "args", None)
    if args is not None:
        return list(args)
    return [result]


def _nest_dotted_inputs(inputs: dict) -> dict:
    """把 autogrow 的点号输入（如 "ref_images.ref_image_0"）收成嵌套 dict 参数。

    ComfyUI 主循环用 _io.build_nested_inputs 做同一件事；mini-executor 不做校验、拿不到
    v3_data 里的 dynamic_paths，这里按第一个点号之后的层级直接展开即可。
    """
    if not any("." in k for k in inputs):
        return inputs
    nested = {}
    for key, value in inputs.items():
        parts = key.split(".")
        if len(parts) == 1:
            nested[key] = value
            continue
        cur = nested
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        cur[parts[-1]] = value
    return nested


def _terminal_output(graph, results, out_type):
    """收集末端指定类型输出：产出该类型、且未被其它执行节点引用的 (node_id, index)。"""
    produced = []
    for nid, node in graph.items():
        if node.get("class_type") in _SKIP_OUTPUT_NODES:
            continue
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(node.get("class_type"))
        if class_def is None or nid not in results:
            continue
        for idx, t in enumerate(class_def.RETURN_TYPES):
            if t == out_type and idx < len(results[nid]):
                produced.append((nid, idx))
    consumed = set()
    for nid, node in graph.items():
        if node.get("class_type") in _SKIP_OUTPUT_NODES:
            continue  # 跳过节点对该输出的引用不算消费
        for v in (node.get("inputs") or {}).values():
            if _is_ref(v, graph):
                consumed.add((v[0], v[1]))
    terminal = [p for p in produced if p not in consumed]
    if not terminal:
        raise RuntimeError(f"[NeoNodes] workflow 未产出 {out_type} 输出")
    return terminal[-1]


# 最终消费扩散模型的节点类型（按优先级）：视频走 SigmaShift，生图/通用走 KSampler 系。
_MODEL_SINK_TYPES = ("MiniMaxH3SigmaShift", "KSampler", "KSamplerAdvanced")


def _model_injection_node(graph):
    """定位外部 MODEL 的注入点，返回 (x_id, pruned_ids)。

    x_id：喂给采样器/SigmaShift `model` 输入的节点（把它的输出替换成外部模型即可）。
    pruned_ids：从 x_id 沿 `model` 输入边向上追到的纯模型链节点（不含 x_id 本身）——
    即只出 MODEL 的 UNETLoader/LoRA/VDN 等。只追 `model` 边，避免误删共享 vae/latent 的节点。
    """
    sink = None
    for prefer in _MODEL_SINK_TYPES:
        for nid, node in graph.items():
            if node.get("class_type") == prefer:
                src = (node.get("inputs") or {}).get("model")
                if _is_ref(src, graph):
                    sink = nid
                    break
        if sink is not None:
            break
    if sink is None:
        return None, set()
    x_id = graph[sink]["inputs"]["model"][0]
    pruned = set()
    cur = x_id
    while True:
        msrc = (graph.get(cur) or {}).get("inputs", {}).get("model")
        if not _is_ref(msrc, graph):
            break
        parent = msrc[0]
        if parent in pruned:
            break
        pruned.add(parent)
        cur = parent
    return x_id, pruned


def execute_graph_inprocess(graph, output_type="IMAGE", overrides=None):
    """进程内同步执行 API prompt graph，返回末端指定类型（默认 IMAGE）的输出。

    graph 为 render_template() 的输出（占位符已替换、LoRA 已注入），结构同 ComfyUI API prompt。
    overrides：{node_id: [output_values]}，命中的节点直接采用给定输出并跳过执行（用于注入外部 MODEL）。
    """
    order = _topo_order(graph)
    results = {}
    for nid in order:
        if overrides is not None and nid in overrides:
            results[nid] = list(overrides[nid])
            continue
        node = graph[nid]
        class_type = node.get("class_type")
        if class_type in _SKIP_OUTPUT_NODES:
            continue
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
        if class_def is None:
            raise RuntimeError(f"[NeoNodes] Krea2 生图 workflow 含未知节点类型: {class_type}")
        inputs = {}
        for k, v in (node.get("inputs") or {}).items():
            inputs[k] = results[v[0]][v[1]] if _is_ref(v, graph) else v

        if _is_api_node(class_def):
            results[nid] = _api_outputs(class_def.execute(**_nest_dotted_inputs(inputs)))
            continue

        func_name = getattr(class_def, "FUNCTION", None)
        if not func_name or inspect.iscoroutinefunction(getattr(class_def, func_name, None)):
            raise RuntimeError(
                f"[NeoNodes] Krea2 生图 workflow 含不支持的异步/无函数节点: {class_type}")

        inst = class_def()
        func = getattr(inst, func_name)
        params = inspect.signature(func).parameters
        has_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        for hkey, spec in (class_def.INPUT_TYPES().get("hidden") or {}).items():
            if hkey not in inputs and (has_varkw or hkey in params):
                inputs[hkey] = _hidden_value(spec, nid)

        results[nid] = _normalize_outputs(func(**inputs), class_def.RETURN_TYPES)

    node_id, idx = _terminal_output(graph, results, output_type)
    return results[node_id][idx]


# ===========================================================================
# 节点：NeoKrea2Generate
# ===========================================================================

def _image_to_data_uri(image_tensor):
    """[B,H,W,C] float(0-1) 张量取第一张，编码为 base64 PNG data URI。"""
    arr = (image_tensor[0].detach().cpu() * 255).clamp(0, 255).to(torch.uint8).numpy()
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[:, :, 0]
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _gen_image_skills():
    """带 workflow.json 的生图 skill（scan_skills 保证 name 非空，缺省回退 id）。"""
    return [s for s in scan_skills() if s.get("gen_image") and load_skill_workflow(s["id"])]


def _resolve_skill_id(value):
    """skill_id 下拉显示 skill name；反查真实 id，找不到则按 id 直接用（兼容旧工作流存的 id）。"""
    by_name = {s["name"]: s["id"] for s in _gen_image_skills()}
    return by_name.get(value, value)


class NeoKrea2Generate:
    """按所选 skill 的 workflow.json 模板同步生成图像，输出 IMAGE 张量到下游节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = [s["name"] for s in _gen_image_skills()]
        return {
            "required": {
                "skill_id": (names, {"default": names[0] if names else ""}),
            },
            "optional": {
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "image": ("IMAGE",),  # 参考图；requires_ref skill 需要，文生图忽略
                "bundle": ("STRING", {"forceInput": True}),  # NeoPromptAgent BUNDLE 输出（纯连线槽）；提供时覆盖 prompt/image/skill
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**63 - 1}),  # 默认固定，随机走「生成后控制」
                "count": ("INT", {"default": 1, "min": 1, "max": MAX_IMAGES}),
                "width": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),   # -1 = 用 skill/preset 比例算尺寸
                "height": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION}),  # -1 = 用 skill/preset 比例算尺寸
                "model": ("MODEL",),  # 外部加速模型；提供时覆盖内部主模型链（UNETLoader/LoRA 等）
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "Krea2 生图节点：按所选 skill 的 workflow.json 模板同步生成，输出 IMAGE 张量到下游。"

    def generate(self, skill_id, prompt="", image=None, seed=-1, count=1, width=-1, height=-1, bundle="", model=None):
        payload = get_bundle(bundle) if bundle else None

        # skill 以节点本地选择为准：bundle 只带资源（prompt/参考图），不携带生图 skill
        real_id = _resolve_skill_id(skill_id)
        template = load_skill_workflow(real_id)
        if template is None:
            raise RuntimeError(
                f"[NeoNodes] Krea2 生图 skill '{skill_id}' 缺少 workflow.json，无法生成")
        settings = dict(get_settings())
        for key, value in get_skill_gen_config(real_id).items():
            if key in DEFAULT_SETTINGS and value not in (None, "", []):
                settings[key] = value

        # prompt：节点输入优先（多 prompt 逐项循环时每次拿到各自的），空则回退 bundle 里的第一条
        if not str(prompt or "").strip() and payload:
            prompts = payload.get("prompts") or []
            prompt = prompts[0] if prompts else ""

        body = {"prompt": prompt, "count": int(count)}
        if seed is not None and int(seed) >= 0:
            body["seed"] = int(seed)
        in_w = int(width) if int(width) > 0 else 0
        in_h = int(height) if int(height) > 0 else 0
        if in_w > 0:
            body["width"] = in_w
        if in_h > 0:
            body["height"] = in_h
        # references：bundle 里的（连接图/附加图）优先，否则用节点 image 输入
        refs = (payload or {}).get("references")
        if refs:
            body["references"] = refs
        elif image is not None:
            body["references"] = [{"kind": "data", "data": _image_to_data_uri(image)}]
        params = resolve_request(body, settings)
        graph, _render_warnings = render_template(template, params)
        overrides = None
        if model is not None:
            x_id, pruned = _model_injection_node(graph)
            if x_id is None:
                raise RuntimeError("[NeoNodes] 无法在生图 workflow 中定位模型注入点（缺少 KSampler 的 model 输入）")
            for pid in pruned:
                del graph[pid]
            overrides = {x_id: [model]}
        return (execute_graph_inprocess(graph, output_type="IMAGE", overrides=overrides),)


@routes.get("/neo_image_gen/skill_dims")
async def skill_dims_route(request):
    """返回 gen_image skill 的预设尺寸（base_resolution + default_ratio），与 generate() 在 width/height=-1 时一致，供节点 widget 填充默认值。"""
    name = (request.rel_url.query.get("skill_id") or "").strip()
    if not name:
        return web.json_response({"success": False, "error": "缺少 skill_id"}, status=400)
    try:
        settings = dict(get_settings())
        for key, value in get_skill_gen_config(_resolve_skill_id(name)).items():
            if key in DEFAULT_SETTINGS and value not in (None, "", []):
                settings[key] = value
        width, height = resolve_dimensions(settings)
        return web.json_response({"success": True, "width": width, "height": height})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {"NeoKrea2Generate": NeoKrea2Generate}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoKrea2Generate": "Neo Krea2 Generate"}
