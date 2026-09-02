# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - Workflow model-path repair unit tests
# 覆盖：归一化 / 打分匹配 / 扩展名规则 / 歧义 / UI 与 API 两种格式 / 文件夹兜底 /
# 手动选择（decisions）与手动修复映射的保存、应用与删除

import os
import shutil
import sys
import tempfile
import unittest

# 添加插件目录到路径以导入 workflow（模型路径修复逻辑）
_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)

# stub aiohttp / server 模块（脱离 ComfyUI 服务器运行时，PromptServer.instance 不存在）
import types  # noqa: E402
_fake_aiohttp = types.ModuleType("aiohttp")
_fake_aiohttp.web = types.ModuleType("aiohttp.web")
sys.modules["aiohttp"] = _fake_aiohttp
sys.modules["aiohttp.web"] = _fake_aiohttp.web


class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper
    def get(self, *a, **k):
        return self._deco()
    def post(self, *a, **k):
        return self._deco()
    def delete(self, *a, **k):
        return self._deco()


class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()


_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

import workflow  # noqa: E402

CKPT_FILES = [
    "realistic_vision_v60.safetensors",
    "dreamshaper_8.safetensors",
]
LORA_FILES = ["my_lora_v2.safetensors"]
VAE_FILES = ["sdxl_vae.safetensors"]
CLIP_FILES = [
    "qwen3vl_4b_fp16.safetensors",
    "qwen3vl_4b_fp8_scaled.safetensors",
]


class _FakeFolderPaths:
    """folder_paths 的最小替身：相对名按文件表判定，绝对名按 basename 判定。"""

    def __init__(self, files):
        self._files = {k: list(v) for k, v in files.items()}
        self.folder_names_and_paths = {
            folder: ([os.path.join("models", folder)], set()) for folder in files
        }
        # 修复映射存储位置（每个测试实例独立，tearDown 清理）
        self._user_dir = tempfile.mkdtemp(prefix="neo_user_")

    def get_full_path(self, folder, path):
        if not folder or not path or folder not in self._files:
            return None
        path = str(path).replace("\\", "/")
        name = path.rsplit("/", 1)[-1]
        if name in self._files[folder]:
            return path if os.path.isabs(path) else os.path.join("models", folder, name)
        return None

    def get_filename_list(self, folder):
        return list(self._files.get(folder, []))

    def get_user_directory(self):
        return self._user_dir


class _FakeCheckpointLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name": (list(CKPT_FILES),),
                "vae_name": (list(VAE_FILES), {"default": VAE_FILES[0]}),
                "clip_skip": ("INT", {"default": 1, "min": 0, "max": 12}),
            },
        }


class _FakeLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": ("COMBO", list(LORA_FILES)),
            },
        }


class _FakeClipLoader:
    """Qwen3-VL 场景：本地只有 fp16 / fp8_scaled 两个量化变体，bf16 缺失且两个候选打平。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"clip_name": (list(CLIP_FILES),)}}


class _FakeTextEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"multiline": True, "default": ""})}}


class _FakeKSampler:
    """KSampler 形状：采样器/调度器 combo（非文件列表）+ 数值型 widget。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0}),
                "steps": ("INT", {"default": 20}),
                "cfg": ("FLOAT", {"default": 7.0}),
                "sampler_name": (["euler", "euler_ancestral", "dpmpp_2m"],),
                "scheduler": (["normal", "karras"],),
                "denoise": ("FLOAT", {"default": 1.0}),
            },
        }


class _FakeSamplerChoice:
    """带非文件 combo（采样方案名）的非模型节点。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"sampler": ("COMBO", ["a_scheme", "b_scheme"])}}


class _FakeStringModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model_path": ("STRING", {"default": ""})}}


class _FakeV1Node:
    """新 io.Schema 节点在 server 侧的 v1 归一化形状。"""

    @classmethod
    def GET_NODE_INFO_V1(cls):
        return {"input": {
            "required": {
                "ckpt_name": ("COMBO", {"options": list(CKPT_FILES), "default": CKPT_FILES[0]}),
                "steps": ("INT", {"default": 20}),
            },
        }}


MAPPINGS = {
    "FakeCheckpointLoader": _FakeCheckpointLoader,
    "FakeClipLoader": _FakeClipLoader,
    "FakeLoraLoader": _FakeLoraLoader,
    "FakeTextEncode": _FakeTextEncode,
    "FakeStringModel": _FakeStringModel,
    "FakeV1Node": _FakeV1Node,
    "KSampler": _FakeKSampler,
    "CLIPTextEncode": _FakeTextEncode,
    "FakeSamplerChoice": _FakeSamplerChoice,
}


class _RepairTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_fp = sys.modules.pop("folder_paths", None)
        self._fp = _FakeFolderPaths({
            "checkpoints": CKPT_FILES,
            "loras": LORA_FILES,
            "vae": VAE_FILES,
            "text_encoders": CLIP_FILES,
        })
        sys.modules["folder_paths"] = self._fp

    def tearDown(self):
        sys.modules.pop("folder_paths", None)
        if self._saved_fp is not None:
            sys.modules["folder_paths"] = self._saved_fp
        # 修复映射写入 fake 用户目录，测试后清理
        shutil.rmtree(self._fp.get_user_directory(), ignore_errors=True)


class TestNormalize(_RepairTestBase):
    def test_separator_and_case(self):
        self.assertEqual(workflow.normalize_model_ref("My Model_V2.ckpt"), "my_model_v2")
        self.assertEqual(workflow.normalize_model_ref("  spaced - name  "), "spaced_name")
        self.assertEqual(workflow.normalize_model_ref("a\\b\\foo~bar"), "foo_bar")
        self.assertEqual(workflow.normalize_model_ref("v1.0.model.safetensors"), "v1_0_model")


class TestMatchModelRef(_RepairTestBase):
    def test_exact(self):
        matched, score, cands = workflow.match_model_ref(
            "foo.safetensors", ["bar.safetensors", "foo.safetensors"])
        self.assertEqual(matched, "foo.safetensors")
        self.assertEqual(score, 1.0)

    def test_normalized_equal_allows_extension_swap_when_loose(self):
        matched, score, _ = workflow.match_model_ref(
            "Realistic Vision v60.ckpt", list(CKPT_FILES), strict_ext=False)
        self.assertEqual(matched, "realistic_vision_v60.safetensors")
        self.assertGreaterEqual(score, 0.95)

    def test_strict_ext_blocks_cross_format_swap(self):
        matched, score, cands = workflow.match_model_ref(
            "foo.ckpt", ["foo.safetensors"], strict_ext=True)
        self.assertIsNone(matched)
        self.assertIn("foo.safetensors", cands)

    def test_prefix_version_suffix(self):
        matched, score, _ = workflow.match_model_ref(
            "juggernaut xl", ["juggernaut_xl_v10.safetensors", "realistic_vision_v60.safetensors"],
            strict_ext=False)
        self.assertEqual(matched, "juggernaut_xl_v10.safetensors")
        self.assertGreaterEqual(score, 0.85)

    def test_ambiguous_tie_is_not_accepted(self):
        matched, score, cands = workflow.match_model_ref(
            "alpha", ["alpha_v1.safetensors", "alpha_v1.ckpt"], strict_ext=False)
        self.assertIsNone(matched)
        self.assertIn("alpha_v1.safetensors", cands)
        self.assertIn("alpha_v1.ckpt", cands)

    def test_no_match(self):
        matched, score, _ = workflow.match_model_ref(
            "zzz_qqq_999", ["abc_def.safetensors"], strict_ext=False)
        self.assertIsNone(matched)
        self.assertLess(score, workflow.REPAIR_ACCEPT_SCORE)

    def test_short_name_does_not_overreach(self):
        # "flux1" 与 "flux1_dev" 只差一个 token，但长度差大，不应自动改写
        matched, _, _ = workflow.match_model_ref("flux1", ["flux1_dev.safetensors"], strict_ext=False)
        self.assertIsNone(matched)

    def test_quant_variant_swap(self):
        # 只差量化标记（bf16 ↔ fp8_scaled）：同一模型，高置信度互换
        matched, score, _ = workflow.match_model_ref(
            "qwen3vl_4b_bf16.safetensors", ["qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(matched, "qwen3vl_4b_fp8_scaled.safetensors")
        self.assertGreaterEqual(score, workflow.REPAIR_ACCEPT_SCORE)

    def test_quant_variant_tie_not_accepted(self):
        # 本地存在多个量化变体时无法唯一确定换成哪个，上报候选留给用户选择
        matched, _, cands = workflow.match_model_ref(
            "qwen3vl_4b_bf16.safetensors",
            ["qwen3vl_4b_fp16.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertIsNone(matched)
        self.assertIn("qwen3vl_4b_fp16.safetensors", cands)
        self.assertIn("qwen3vl_4b_fp8_scaled.safetensors", cands)

    def test_quant_tokens_do_not_unify_different_models(self):
        matched, _, _ = workflow.match_model_ref(
            "juggernaut_bf16.safetensors", ["dreamshaper_fp8.safetensors"])
        self.assertIsNone(matched)


class TestMatchModelFile(_RepairTestBase):
    def test_exact_fast_path(self):
        matched, score, cands = workflow.match_model_file("checkpoints", "dreamshaper_8.safetensors")
        self.assertEqual(matched, "dreamshaper_8.safetensors")
        self.assertEqual(score, 1.0)
        self.assertEqual(cands, [])

    def test_fuzzy_same_folder(self):
        matched, score, _ = workflow.match_model_file("loras", "my lora v2.safetensors")
        self.assertEqual(matched, "my_lora_v2.safetensors")
        self.assertGreaterEqual(score, 0.95)

    def test_strict_ext_in_folder(self):
        matched, _, cands = workflow.match_model_file("loras", "my_lora_v2.ckpt", strict_ext=True)
        self.assertIsNone(matched)
        self.assertIn("my_lora_v2.safetensors", cands)


class TestWidgetSpecs(_RepairTestBase):
    def test_classic_and_combo_forms(self):
        specs = workflow.widget_specs(_FakeCheckpointLoader)
        self.assertEqual(specs[0], ("ckpt_name", "COMBO", CKPT_FILES))
        self.assertEqual(specs[1][0], "vae_name")
        self.assertEqual(specs[2], ("clip_skip", "INT", None))

    def test_combo_type_string_form(self):
        specs = workflow.widget_specs(_FakeLoraLoader)
        self.assertEqual(specs, [("lora_name", "COMBO", LORA_FILES)])

    def test_v1_schema_shape(self):
        specs = workflow.widget_specs(_FakeV1Node)
        self.assertEqual(specs[0][0], "ckpt_name")
        self.assertEqual(specs[0][1], "COMBO")
        self.assertEqual(specs[0][2], CKPT_FILES)
        self.assertEqual(specs[1], ("steps", "INT", None))

    def test_unknown_class(self):
        self.assertEqual(workflow.widget_specs(None), [])


class TestUiFormat(_RepairTestBase):
    def _ui_wf(self):
        return {
            "id": "test",
            "nodes": [
                {"id": "1", "type": "FakeCheckpointLoader", "widgets_values": [
                    "Realistic Vision v60.ckpt",  # 换名 + 换扩展名 → 修
                    "sdxl_vae.safetensors",       # 有效 → 不动
                    2,                            # INT → 跳过
                ]},
                {"id": "2", "type": "FakeCheckpointLoader", "widgets_values": [
                    "totally_missing_xyz.ckpt",   # 修不了 → 上报
                    "sdxl_vae.safetensors",
                    2,
                ]},
                {"id": "3", "type": "UnknownNodeType", "widgets_values": ["whatever.ckpt"]},
                {"id": "4", "type": "FakeTextEncode", "widgets_values": ["a photo of a cat"]},
                {"id": "5", "type": "FakeStringModel", "widgets_values": ["dreamshaper_8.safetensors"]},
            ],
        }

    def test_repair(self):
        wf = self._ui_wf()
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)

        self.assertEqual(repaired["nodes"][0]["widgets_values"][0],
                         "realistic_vision_v60.safetensors")
        self.assertEqual(repaired["nodes"][0]["widgets_values"][1], "sdxl_vae.safetensors")
        self.assertEqual(repaired["nodes"][2]["widgets_values"], ["whatever.ckpt"])
        self.assertEqual(repaired["nodes"][3]["widgets_values"], ["a photo of a cat"])
        self.assertEqual(repaired["nodes"][4]["widgets_values"], ["dreamshaper_8.safetensors"])
        # 原对象未被修改
        self.assertEqual(wf["nodes"][0]["widgets_values"][0], "Realistic Vision v60.ckpt")

        matched = [c for c in changes if c["reason"] == "matched"]
        missing = [c for c in changes if c["reason"] == "missing"]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["node"], "1")
        self.assertEqual(matched[0]["input"], "ckpt_name")
        self.assertEqual(matched[0]["new"], "realistic_vision_v60.safetensors")
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["node"], "2")
        self.assertIsNone(missing[0]["new"])

    def test_no_mappings_no_changes(self):
        wf = self._ui_wf()
        repaired, changes = workflow.repair_workflow(wf, None)
        self.assertEqual(changes, [])
        self.assertEqual(repaired, wf)

    def test_combo_type_string_form_repaired(self):
        wf = {"nodes": [{"id": "9", "type": "FakeLoraLoader",
                         "widgets_values": ["my lora v2.ckpt"]}]}
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["my_lora_v2.safetensors"])
        self.assertEqual(changes[0]["reason"], "matched")
        self.assertEqual(changes[0]["new"], "my_lora_v2.safetensors")

    def test_muted_and_bypassed_nodes_skipped(self):
        wf = {
            "id": "test",
            "nodes": [
                # Mute/NEVER：可匹配的值也不修、不报
                {"id": "10", "mode": 2, "type": "FakeCheckpointLoader",
                 "widgets_values": ["Realistic Vision v60.ckpt", "sdxl_vae.safetensors", 2]},
                # Bypass：缺失值也不报
                {"id": "11", "mode": 4, "type": "FakeCheckpointLoader",
                 "widgets_values": ["totally_missing_xyz.ckpt", "sdxl_vae.safetensors", 2]},
                {"id": "12", "type": "FakeCheckpointLoader",
                 "widgets_values": ["Realistic Vision v60.ckpt", "sdxl_vae.safetensors", 2]},
            ],
        }
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["node"], "12")
        # Mute/Bypass 节点保持原值，仅活动节点被修复
        self.assertEqual(repaired["nodes"][0]["widgets_values"][0], "Realistic Vision v60.ckpt")
        self.assertEqual(repaired["nodes"][1]["widgets_values"][0], "totally_missing_xyz.ckpt")
        self.assertEqual(repaired["nodes"][2]["widgets_values"][0], "realistic_vision_v60.safetensors")

    def test_sampler_and_encode_nodes_ignored(self):
        wf = {
            "id": "test",
            "nodes": [
                # KSampler：采样器名不在 combo 列表里，但不是模型引用 → 不报
                {"id": "20", "type": "KSampler",
                 "widgets_values": [0, 20, 7.0, "heun", "normal", 1.0]},
                # CLIPTextEncode：提示词文本含文件扩展名样式 → 不报
                {"id": "21", "type": "CLIPTextEncode",
                 "widgets_values": ["a cat sitting on mat.png"]},
            ],
        }
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(changes, [])
        self.assertEqual(repaired["nodes"][0]["widgets_values"][3], "heun")
        self.assertEqual(repaired["nodes"][1]["widgets_values"][0], "a cat sitting on mat.png")

    def test_non_file_combo_not_repaired(self):
        wf = {"nodes": [{"id": "22", "type": "FakeSamplerChoice",
                         "widgets_values": ["c_scheme"]}]}
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(changes, [])
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["c_scheme"])


class TestApiFormat(_RepairTestBase):
    def _prompt(self):
        return {
            "1": {"class_type": "FakeCheckpointLoader", "inputs": {
                "ckpt_name": "Realistic Vision v60.ckpt",
                "vae_name": "sdxl_vae.safetensors",
                "clip_skip": 2,
            }},
            "2": {"class_type": "FakeTextEncode", "inputs": {"text": "a photo of a cat"}},
            "3": {"class_type": "UnknownNode", "inputs": {
                "note": "free text",
                "file": "my_lora_v2.ckpt",
            }},
            "4": {"class_type": "FakeLoraLoader", "inputs": {
                "lora_name": ["my lora v2.ckpt"],
            }},
        }

    def test_repair(self):
        prompt = self._prompt()
        repaired, changes = workflow.repair_workflow(prompt, MAPPINGS)

        self.assertEqual(repaired["1"]["inputs"]["ckpt_name"],
                         "realistic_vision_v60.safetensors")
        self.assertEqual(repaired["1"]["inputs"]["vae_name"], "sdxl_vae.safetensors")
        self.assertEqual(repaired["1"]["inputs"]["clip_skip"], 2)
        self.assertEqual(repaired["2"]["inputs"]["text"], "a photo of a cat")
        self.assertEqual(repaired["3"]["inputs"]["note"], "free text")
        self.assertEqual(repaired["4"]["inputs"]["lora_name"], ["my_lora_v2.safetensors"])
        # 原对象未被修改
        self.assertEqual(prompt["1"]["inputs"]["ckpt_name"], "Realistic Vision v60.ckpt")
        self.assertEqual(prompt["4"]["inputs"]["lora_name"], ["my lora v2.ckpt"])

        by_input = {(c["node"], c["input"]): c for c in changes}
        self.assertEqual(by_input[("1", "ckpt_name")]["reason"], "matched")
        # 自由路径严格同扩展名：.ckpt 无对应文件 → 上报候选而非替换
        self.assertEqual(by_input[("3", "file")]["reason"], "missing")
        self.assertIn("my_lora_v2.safetensors", by_input[("3", "file")]["candidates"])
        self.assertEqual(by_input[("3", "file")]["folder"], "loras")
        self.assertEqual(by_input[("4", "lora_name")]["reason"], "matched")
        self.assertNotIn(("3", "note"), by_input)

    def test_resolvable_string_untouched(self):
        prompt = {"1": {"class_type": "FakeStringModel",
                        "inputs": {"model_path": "dreamshaper_8.safetensors"}}}
        repaired, changes = workflow.repair_workflow(prompt, MAPPINGS)
        self.assertEqual(repaired["1"]["inputs"]["model_path"], "dreamshaper_8.safetensors")
        self.assertEqual(changes, [])


class TestManualDecisions(_RepairTestBase):
    """修复弹窗手动选择：按 (node, input, old) 命中并以 reason="chosen" 改写。"""

    def _ui_wf(self):
        return {"nodes": [{"id": "5", "type": "FakeClipLoader",
                           "widgets_values": ["qwen3vl_4b_bf16.safetensors"]}]}

    def _decision(self, **over):
        d = {"node": "5", "input": "clip_name", "old": "qwen3vl_4b_bf16.safetensors",
             "value": "qwen3vl_4b_fp8_scaled.safetensors", "folder": "text_encoders"}
        d.update(over)
        return d

    def test_decision_applies_to_combo(self):
        wf = self._ui_wf()
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS, decisions=[self._decision()])
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(wf["nodes"][0]["widgets_values"], ["qwen3vl_4b_bf16.safetensors"])  # 原对象不动
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["reason"], "chosen")
        self.assertEqual(changes[0]["new"], "qwen3vl_4b_fp8_scaled.safetensors")
        self.assertEqual(changes[0]["folder"], "text_encoders")
        self.assertNotIn("score", changes[0])

    def test_decision_applies_to_list_widget(self):
        wf = {"nodes": [{"id": "7", "type": "FakeLoraLoader", "widgets_values": [["gone.ckpt"]]}]}
        decisions = [{"node": "7", "input": "lora_name", "old": "gone.ckpt",
                      "value": "my_lora_v2.safetensors"}]
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS, decisions=decisions)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], [["my_lora_v2.safetensors"]])
        self.assertEqual(changes[0]["reason"], "chosen")

    def test_decision_applies_to_free_path(self):
        wf = {"nodes": [{"id": "8", "type": "FakeStringModel", "widgets_values": ["totally gone.ckpt"]}]}
        decisions = [{"node": "8", "input": "model_path", "old": "totally gone.ckpt",
                      "value": "my_lora_v2.safetensors", "folder": "loras"}]
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS, decisions=decisions)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["my_lora_v2.safetensors"])
        self.assertEqual(changes[0]["reason"], "chosen")
        self.assertEqual(changes[0]["folder"], "loras")

    def test_decision_value_not_in_combo_is_ignored(self):
        repaired, changes = workflow.repair_workflow(
            self._ui_wf(), MAPPINGS, decisions=[self._decision(value="no_such_file.safetensors")])
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["qwen3vl_4b_bf16.safetensors"])
        self.assertEqual(changes[0]["reason"], "missing")

    def test_stale_decision_key_is_ignored(self):
        repaired, changes = workflow.repair_workflow(
            self._ui_wf(), MAPPINGS, decisions=[self._decision(old="other.ckpt")])
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["qwen3vl_4b_bf16.safetensors"])
        self.assertEqual(changes[0]["reason"], "missing")

    def test_decision_applies_to_api_format(self):
        prompt = {"5": {"class_type": "FakeClipLoader",
                        "inputs": {"clip_name": "qwen3vl_4b_bf16.safetensors"}}}
        repaired, changes = workflow.repair_workflow(prompt, MAPPINGS, decisions=[self._decision()])
        self.assertEqual(repaired["5"]["inputs"]["clip_name"], "qwen3vl_4b_fp8_scaled.safetensors")
        self.assertEqual(changes[0]["reason"], "chosen")


class TestRepairMappings(_RepairTestBase):
    """手动修复映射：保存后相同失效路径（归一化键）自动替换，可删除。"""

    MAPPING = {"folder": "text_encoders", "wanted": "qwen3vl_4b_bf16.safetensors",
               "replacement": "qwen3vl_4b_fp8_scaled.safetensors"}

    def _ui_wf(self, value="qwen3vl_4b_bf16.safetensors"):
        return {"nodes": [{"id": "5", "type": "FakeClipLoader", "widgets_values": [value]}]}

    def test_saved_mapping_applies_automatically(self):
        workflow.add_repair_mappings([self.MAPPING])
        repaired, changes = workflow.repair_workflow(self._ui_wf(), MAPPINGS)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(changes[0]["reason"], "mapped")
        self.assertEqual(changes[0]["folder"], "text_encoders")

    def test_mapping_key_ignores_case_and_extension(self):
        workflow.add_repair_mappings([dict(self.MAPPING, wanted="Qwen3VL-4B.BF16.safetensors")])
        repaired, changes = workflow.repair_workflow(self._ui_wf("qwen3vl_4b_bf16.ckpt"), MAPPINGS)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(changes[0]["reason"], "mapped")

    def test_use_mappings_false_skips(self):
        workflow.add_repair_mappings([self.MAPPING])
        _, changes = workflow.repair_workflow(self._ui_wf(), MAPPINGS, use_mappings=False)
        self.assertEqual(changes[0]["reason"], "missing")

    def test_mapping_target_deleted_is_ignored(self):
        workflow.add_repair_mappings([dict(self.MAPPING, replacement="gone.safetensors")])
        _, changes = workflow.repair_workflow(self._ui_wf(), MAPPINGS)
        self.assertEqual(changes[0]["reason"], "missing")

    def test_decision_wins_over_mapping(self):
        workflow.add_repair_mappings([self.MAPPING])
        _, changes = workflow.repair_workflow(
            self._ui_wf(), MAPPINGS, decisions=[{
                "node": "5", "input": "clip_name", "old": "qwen3vl_4b_bf16.safetensors",
                "value": "qwen3vl_4b_fp8_scaled.safetensors", "folder": "text_encoders",
            }])
        self.assertEqual(changes[0]["reason"], "chosen")

    def test_free_path_mapping(self):
        workflow.add_repair_mappings([{"folder": "loras", "wanted": "my missing lora.ckpt",
                                       "replacement": "my_lora_v2.safetensors"}])
        wf = {"nodes": [{"id": "8", "type": "FakeStringModel",
                         "widgets_values": ["my missing lora.ckpt"]}]}
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(repaired["nodes"][0]["widgets_values"], ["my_lora_v2.safetensors"])
        self.assertEqual(changes[0]["reason"], "mapped")

    def test_invalid_entries_are_skipped(self):
        keys = workflow.add_repair_mappings([
            {"folder": "", "wanted": "x", "replacement": "y"},
            {"folder": "loras", "wanted": "x", "replacement": ""},
            "not-a-dict",
        ])
        self.assertEqual(keys, [])
        self.assertEqual(workflow.load_repair_mappings(), {})

    def test_delete_and_clear(self):
        keys = workflow.add_repair_mappings([self.MAPPING])
        self.assertEqual(keys, ["text_encoders|qwen3vl_4b_bf16"])
        self.assertTrue(workflow.delete_repair_mapping(keys[0]))
        self.assertEqual(workflow.load_repair_mappings(), {})
        self.assertFalse(workflow.delete_repair_mapping(keys[0]))
        workflow.add_repair_mappings([self.MAPPING])
        workflow.clear_repair_mappings()
        self.assertEqual(workflow.load_repair_mappings(), {})


class TestEntryPoint(_RepairTestBase):
    def test_non_dict_passthrough(self):
        self.assertEqual(workflow.repair_workflow(None), (None, []))
        self.assertEqual(workflow.repair_workflow(["x"]), (["x"], []))

    def test_unknown_shape_passthrough(self):
        self.assertEqual(workflow.repair_workflow({"foo": "bar"}), ({"foo": "bar"}, []))

    def test_wrapped_api_shape(self):
        wf = {"nodes": {"1": {"class_type": "FakeLoraLoader",
                              "inputs": {"lora_name": "my lora v2.ckpt"}}}}
        repaired, changes = workflow.repair_workflow(wf, MAPPINGS)
        self.assertEqual(repaired["nodes"]["1"]["inputs"]["lora_name"], "my_lora_v2.safetensors")
        self.assertEqual(changes[0]["reason"], "matched")


if __name__ == "__main__":
    unittest.main()



