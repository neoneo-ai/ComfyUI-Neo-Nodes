import json, py_compile
from pathlib import Path

base = Path(__file__).parent
reg = json.loads((base / "configs/model_registry.json").read_text(encoding="utf-8"))
hub = json.loads((base / "configs/model_hub.json").read_text(encoding="utf-8"))
print("groups:", len(reg["groups"]), "bundles:", len(reg["bundles"]))
print("hub:", hub)
py_compile.compile(str(base / "model_hub.py"), doraise=True)
print("compile ok")
