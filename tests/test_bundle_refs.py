# SPDX-License-Identifier: Apache-2.0
"""store_bundle_refs/take_bundle_refs（@引用/本地上传参考图暂存）离线单测。

验证 NeoPromptAgent 出队时把前端采集的 @引用/本地上传图合并进 bundle.references 的链路：
data URI / input 文件名解析、取出即删、节点 id 类型归一化、与连线张量合并后的上限裁剪。
桩模块复用 test_bundles.py 的方式（server/comfy/folder_paths/nodes 用假模块替换）。"""

import base64
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest

import torch
from PIL import Image

_TMP = tempfile.mkdtemp(prefix="neo_bundle_refs_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors",
                         "minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors",
                      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors", "minimax_h3_video_vae_fp16.safetensors",
            "minimax_h3_audio_vae_fp32.safetensors"],
    "loras": [],
}

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
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 8192
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_bundle_refs_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


bundles = _load("bundles", "bundles.py")
_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
krea2_generate = _load("krea2_generate", "krea2_generate.py")
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
prompts = _load("prompts", "prompts.py")


def _png_bytes(w=8, h=6, color=(10, 20, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def _data_uri(png):
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


class BundleRefsStoreTests(unittest.TestCase):
    def setUp(self):
        prompts._PENDING_BUNDLE_REFS.clear()

    def test_data_uri_roundtrip_and_delete_on_take(self):
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(901, [{"kind": "data", "data": uri}])
        refs = prompts.take_bundle_refs(901)
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0]["kind"], "data")
        self.assertTrue(refs[0]["data"].startswith("data:image/png;base64,"))
        # 取出即删：第二次取为空（与最近一次生成的 prompt 绑定）
        self.assertEqual(prompts.take_bundle_refs(901), [])

    def test_input_filename_resolved_to_data_uri(self):
        name = "neo_ref_test.png"
        with open(os.path.join(_INPUT_DIR, name), "wb") as f:
            f.write(_png_bytes())
        prompts.store_bundle_refs(902, [{"kind": "input", "value": name}])
        refs = prompts.take_bundle_refs(902)
        self.assertEqual(len(refs), 1)
        self.assertTrue(refs[0]["data"].startswith("data:image/png;base64,"))

    def test_node_id_type_normalization(self):
        # 前端 node.id（int）与 hidden UNIQUE_ID 经 str() 归一化后一致
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(903, [{"kind": "data", "data": uri}])
        self.assertEqual(len(prompts.take_bundle_refs("903")), 1)

    def test_take_missing_returns_empty(self):
        self.assertEqual(prompts.take_bundle_refs(4242), [])
        self.assertEqual(prompts.take_bundle_refs(None), [])

    def test_store_empty_clears_pending(self):
        # replace 语义：空列表清空已有暂存（前端移除/清空图片后推送空 refs → 不再进入 bundle）
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(904, [{"kind": "data", "data": uri}])
        self.assertEqual(len(prompts.take_bundle_refs(904)), 1)
        prompts.store_bundle_refs(904, [{"kind": "data", "data": uri}])
        prompts.store_bundle_refs(904, [])
        self.assertEqual(prompts.take_bundle_refs(904), [])

    def test_store_empty_on_missing_is_noop(self):
        # 对无暂存的节点 store 空列表不报错
        prompts.store_bundle_refs(905, [])
        self.assertEqual(prompts.take_bundle_refs(905), [])

    def test_store_replace_overwrites_previous(self):
        # replace 语义：后推送的完整列表整体覆盖旧值，而非追加
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(906, [{"kind": "data", "data": uri}, {"kind": "data", "data": uri}])
        prompts.store_bundle_refs(906, [{"kind": "data", "data": uri}])
        self.assertEqual(len(prompts.take_bundle_refs(906)), 1)


class BundleRefsMergeTests(unittest.TestCase):
    """get_prompt 里 references = 连线张量 + 暂存 @/本地上传图，cap 到 MAX_BUNDLE_REFERENCES。"""

    def setUp(self):
        prompts._PENDING_BUNDLE_REFS.clear()

    def test_connected_plus_pending_merged_and_capped(self):
        # 8 张连线张量 + 3 张暂存 → 合并后裁剪到上限 9（连线优先）
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(910, [{"kind": "data", "data": uri} for _ in range(3)])
        image = torch.full((8, 2, 2, 3), 0.5)
        refs = (prompts._bundle_references(image) + prompts.take_bundle_refs(910))[:prompts.MAX_BUNDLE_REFERENCES]
        self.assertEqual(len(refs), prompts.MAX_BUNDLE_REFERENCES)

    def test_no_image_only_pending(self):
        # @引用/本地上传但无连线：image=None → references 全来自暂存（修复目标场景）
        uri = _data_uri(_png_bytes())
        prompts.store_bundle_refs(911, [{"kind": "data", "data": uri}])
        refs = (prompts._bundle_references(None) + prompts.take_bundle_refs(911))[:prompts.MAX_BUNDLE_REFERENCES]
        self.assertEqual(len(refs), 1)
        self.assertTrue(refs[0]["data"].startswith("data:image/png;base64,"))

    def test_unique_id_none_is_safe(self):
        # unique_id=None（某些执行路径）→ take_bundle_refs 返回空，不影响连线图
        image = torch.full((1, 2, 2, 3), 0.5)
        refs = (prompts._bundle_references(image) + prompts.take_bundle_refs(None))[:prompts.MAX_BUNDLE_REFERENCES]
        self.assertEqual(len(refs), 1)


if __name__ == "__main__":
    unittest.main()