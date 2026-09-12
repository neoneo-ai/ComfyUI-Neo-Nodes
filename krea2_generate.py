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
from PIL import Image

import nodes as comfy_nodes
from .image_gen import DEFAULT_SETTINGS, MAX_IMAGES, get_settings, render_template, resolve_request
from .skill import get_skill_gen_config, load_skill_workflow, scan_skills

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


def execute_graph_inprocess(graph, output_type="IMAGE"):
    """进程内同步执行 API prompt graph，返回末端指定类型（默认 IMAGE）的输出。

    graph 为 render_template() 的输出（占位符已替换、LoRA 已注入），结构同 ComfyUI API prompt。
    """
    order = _topo_order(graph)
    results = {}
    for nid in order:
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
            results[nid] = _api_outputs(class_def.execute(**inputs))
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
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**63 - 1}),  # -1 = 随机
                "count": ("INT", {"default": 1, "min": 1, "max": MAX_IMAGES}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "generate"
    CATEGORY = "Neo-Nodes"
    DESCRIPTION = "Krea2 生图节点：按所选 skill 的 workflow.json 模板同步生成，输出 IMAGE 张量到下游。"

    def generate(self, skill_id, prompt="", image=None, seed=-1, count=1):
        real_id = _resolve_skill_id(skill_id)
        template = load_skill_workflow(real_id)
        if template is None:
            raise RuntimeError(
                f"[NeoNodes] Krea2 生图 skill '{skill_id}' 缺少 workflow.json，无法生成")
        settings = dict(get_settings())
        for key, value in get_skill_gen_config(real_id).items():
            if key in DEFAULT_SETTINGS and value not in (None, "", []):
                settings[key] = value
        body = {"prompt": prompt, "count": int(count)}
        if seed is not None and int(seed) >= 0:
            body["seed"] = int(seed)
        if image is not None:
            body["references"] = [{"kind": "data", "data": _image_to_data_uri(image)}]
        params = resolve_request(body, settings)
        graph, _render_warnings = render_template(template, params)
        return (execute_graph_inprocess(graph),)


NODE_CLASS_MAPPINGS = {"NeoKrea2Generate": NeoKrea2Generate}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoKrea2Generate": "Neo Krea2 Generate"}
