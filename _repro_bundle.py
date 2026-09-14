import base64
import importlib.util
import io as _io
import os
import sys
import types

import numpy as np
import torch

_PLUGIN = r"f:/comfy/Comfyui-WF-2026.8.8/ComfyUI/custom_nodes/ComfyUI-Neo-Nodes"

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188, tls_keyfile=None, tls_certfile=None)
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli
_comfy_pe = types.ModuleType("comfy.patcher_extension")
_comfy_pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="DIFFUSION_MODEL")
_comfy_pe.add_wrapper_with_key = lambda *a, **k: None
sys.modules["comfy.patcher_extension"] = _comfy_pe
_comfy_utils = types.ModuleType("comfy.utils")
_comfy_utils.common_upscale = lambda *a, **k: None
sys.modules["comfy.utils"] = _comfy_utils
_comfy_common_dit = types.ModuleType("comfy.ldm.common_dit")
_comfy_common_dit.pad_to_patch_size = lambda *a, **k: None
sys.modules["comfy.ldm.common_dit"] = _comfy_common_dit
_comfy_flux_layers = types.ModuleType("comfy.ldm.flux.layers")
_comfy_flux_layers.timestep_embedding = lambda *a, **k: None
for _name in ("comfy.ldm", "comfy.ldm.flux"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["comfy.ldm.flux.layers"] = _comfy_flux_layers

_comfy_exec = types.ModuleType("comfy_execution")
_comfy_exec_prog = types.ModuleType("comfy_execution.progress")
_comfy_exec_prog.get_progress_state = lambda: types.SimpleNamespace(prompt_id="", nodes={})
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: []
_folder_paths.get_input_directory = lambda: os.path.join(_PLUGIN, "_tmp_in")
_folder_paths.get_output_directory = lambda: os.path.join(_PLUGIN, "_tmp_out")
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 8192
sys.modules["nodes"] = _nodes

sys.path.insert(0, _PLUGIN)
_PKG = "_neo_repro_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [_PLUGIN]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(_PLUGIN, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


bundles = _load("bundles", "bundles.py")
_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
prompts = _load("prompts", "prompts.py")
bundle_expand = _load("bundle_expand", "bundle_expand.py")

# build a 2-image batch [2,H,W,C] and encode references exactly like the agent does
img = torch.rand(2, 8, 6, 3)
pngs = []
for i in range(2):
    p = _io.BytesIO()
    Image = __import__("PIL.Image", fromlist=["Image"])
    Image.fromarray((img[i].cpu().numpy() * 255).astype("uint8")).save(p, format="PNG")
    pngs.append(base64.b64encode(p.getvalue()).decode())
refs = prompts._bundle_references(img)
print("REFS_FROM_AGENT=", len(refs))

bundle_id = bundles.create_bundle({"prompts": ["你好世界，一只猫"], "references": refs, "gen_type": "", "skill_id": ""})
out = bundle_expand.NeoBundleExpand().expand(bundle=bundle_id)
prompt = out["result"][0]
print("BACKEND_PROMPT_REPR=", repr(prompt))
print("UI_PROMPT_REPR=", repr(out["ui"]["prompt"]))
for i in range(1, 10):
    t = out["result"][i]
    print(f"image_{i} shape=", tuple(t.shape), "nonempty=", t.shape[0] > 0)
print("UI_IMAGES_COUNT=", len(out["ui"]["images"]))

import sys, base64, io
sys.path.insert(0, r"f:/comfy/Comfyui-WF-2026.8.8/ComfyUI/custom_nodes/ComfyUI-Neo-Nodes")
from PIL import Image
import torch
from bundles import create_bundle
from bundle_expand import NeoBundleExpand

img = torch.rand(2, 8, 6, 3)
pngs = []
for i in range(2):
    p = io.BytesIO()
    Image.fromarray((img[i].cpu().numpy() * 255).astype("uint8")).save(p, format="PNG")
    pngs.append(base64.b64encode(p.getvalue()).decode())
refs = [{"kind": "data", "data": "data:image/png;base64," + d} for d in pngs]

bundle_id = create_bundle({"prompts": ["你好世界，一只猫"], "references": refs, "gen_type": "", "skill_id": ""})
out = NeoBundleExpand.expand(bundle_id)
prompt = out[0]
print("PROMPT_REPR=", repr(prompt))
n_img = sum(1 for k in out if k.startswith("image_"))
print("N_IMAGE_SLOTS=", n_img)
for i in range(1, 10):
    t = out.get(f"image_{i}")
    print(f"image_{i} shape=", tuple(t.shape), "nonempty=", t.shape[0] > 0)
print("UI_IMAGES=", len(out["ui"]["images"]), "UI_PROMPT=", repr(out["ui"]["prompt"]))
