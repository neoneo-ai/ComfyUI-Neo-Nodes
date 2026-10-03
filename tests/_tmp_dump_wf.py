import json

p = r"f:/comfy/Comfyui-WF-2026.8.8/ComfyUI/user/default/workflows/Qwen Image2.1/▶▷Qwen-image21-功能流(高分局部编辑&扩图).json"
d = json.load(open(p, encoding="utf-8"))
nodes = d["nodes"] if isinstance(d, dict) and "nodes" in d else d
for n in nodes:
    t = n.get("type")
    w = n.get("widgets_values")
    ws = json.dumps(w, ensure_ascii=False)[:200] if w is not None else ""
    print(n.get("id"), t, "|", ws)
