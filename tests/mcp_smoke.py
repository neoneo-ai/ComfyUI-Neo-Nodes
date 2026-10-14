# MCP 冒烟：真起 kernel-plugin\mcp_server.py 子进程，经 stdio 跑一遍生图闭环（需要 ComfyUI 在跑）。
# 用法: python tests\mcp_smoke.py [--comfy-url http://127.0.0.1:8188] [--prompt 一只橘猫] [--skill <id>]
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "kernel-plugin", "mcp_server.py")


class Client:
    def __init__(self, comfy_url):
        self.p = subprocess.Popen([sys.executable, SERVER, "--comfy-url", comfy_url],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=sys.stderr, text=True, encoding="utf-8")
        self.id = 0

    def send(self, payload):
        self.p.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.p.stdin.flush()

    def request(self, method, params=None):
        self.id += 1
        self.send({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params or {}})
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("服务器提前退出")
        msg = json.loads(line)
        if "error" in msg:
            raise RuntimeError(f"{method} → {msg['error']}")
        return msg["result"]

    def call(self, name, args):
        res = self.request("tools/call", {"name": name, "arguments": args})
        text = res["content"][0]["text"]
        if res.get("isError"):
            raise RuntimeError(f"{name} → {text}")
        try:
            return json.loads(text)
        except ValueError:      # 截断后的长文本原样返回
            return text

    def close(self):
        self.p.stdin.close()
        self.p.terminate()
        self.p.wait(timeout=5)


def main():
    args = sys.argv[1:]
    url = args[args.index("--comfy-url") + 1] if "--comfy-url" in args else "http://127.0.0.1:8188"
    prompt = args[args.index("--prompt") + 1] if "--prompt" in args else "一只橘猫坐在窗台晒太阳，写实"
    want_skill = args[args.index("--skill") + 1] if "--skill" in args else ""

    with urllib.request.urlopen(url + "/system_stats", timeout=5) as r:
        stats = json.loads(r.read())
        print("ComfyUI:", (stats[0] if isinstance(stats, list) else stats).get("comfyui_version"))

    c = Client(url)
    init = c.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                    "clientInfo": {"name": "smoke", "version": "0"}})
    c.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    print("initialize:", init["serverInfo"], init["protocolVersion"])
    tools = c.request("tools/list")["tools"]
    print("tools/list:", len(tools), "个")

    print("neo_status:", json.dumps(c.call("neo_status", {}), ensure_ascii=False))
    skills_out = c.call("list_skills", {})
    skills = skills_out["skills"] if isinstance(skills_out, dict) else []
    print("list_skills:", [s["id"] for s in skills][:12])
    models = c.call("list_models", {})
    if isinstance(models, dict):
        print("suggested_model:", models.get("suggested_model"), "| vae:", models.get("suggested_vae"))
    else:
        print("list_models:", str(models)[:300])

    skill = want_skill or next((s["id"] for s in skills if s.get("has_workflow")), None)
    if not skill:
        raise RuntimeError("没有带工作流的技能可用")
    snap = c.call("generate_image", {"skill_id": skill, "prompt": prompt, "count": 1})
    print("generate_image:", snap)
    tid = snap["task_id"]

    deadline = time.time() + 420
    while time.time() < deadline:
        st = c.call("task_status", {"task_id": tid})
        if not isinstance(st, dict):
            raise RuntimeError("task_status 返回被截断：" + str(st)[:300])
        status = st.get("status")
        if status in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(3)
    print("task_status:", status, st.get("error") or "")
    images = st.get("images") or []
    if status != "succeeded" or not images:
        raise RuntimeError("生图未成功：" + str(st.get("error") or st))

    img = c.call("get_image", {"filename": images[0]["filename"],
                               "subfolder": images[0].get("subfolder") or "", "base64": True})
    print("get_image:", img["filename"], "bytes:", img.get("bytes"), "url:", img["url"])

    recipes = c.call("director_recipes", {})
    print("director_recipes:", recipes["recipes"][:8] if isinstance(recipes, dict) else str(recipes)[:200])

    if "--director" in args:
        name = (recipes.get("recipes") or [""])[0] if isinstance(recipes, dict) else ""
        spec = c.call("director_spec", {"name": name})
        if isinstance(spec, dict):
            print("director_spec:", name, "segments:", spec.get("segment_count"), "shared:", spec.get("shared"))
        try:
            plan = c.call("director_plan", {"idea": "一只机器猫在雨夜找家", "segment_seconds": 6})
            segs = plan.get("segments") if isinstance(plan, dict) else []
            print("director_plan:", len(segs or []), "段")
        except RuntimeError as e:
            print("director_plan 预期报错（LLM 未配置时）:", str(e)[:160])
        saved = c.call("director_save", {"name": "mcp-smoke-recipe",
                                         "shared": {"width": 768, "height": 432, "seed": -1},
                                         "segments": [{"prompt": "【画面】雨夜街道，霓虹倒影", "duration_sec": 6},
                                                      {"prompt": "【画面】便利店门口，机器猫收雨", "duration_sec": 6}]})
        print("director_save:", saved)
        print("director_copy:", c.call("director_copy", {"name": "mcp-smoke-recipe"}))

    print("OK")
    c.close()


if __name__ == "__main__":
    main()
