# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - skill config 失效模型路径建议单元测试
# 覆盖：可解析字段判 ok / 失效字段给出候选与置信度 / 歧义不给 suggestion / LoRA 失效上报 / 空值跳过
import os
import sys
import types
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)


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


class _FakeFolderPaths:
    """folder_paths 最小替身：相对名按文件表精确判定，绝对名按 basename 判定。"""

    def __init__(self, files):
        self._files = {k: list(v) for k, v in files.items()}
        self.folder_names_and_paths = {
            folder: ([os.path.join("models", folder)], set()) for folder in files
        }

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


class _SuggestTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_fp = sys.modules.pop("folder_paths", None)
        self._fp = _FakeFolderPaths({
            "diffusion_models": ["krea2_base.safetensors", "MiniMaxH3/Speed/h3_pruned.safetensors"],
            "text_encoders": ["qwen3vl_4b_fp16.safetensors"],
            "vae": ["h3_video_vae.safetensors"],
            "loras": ["krea2_quadview.safetensors"],
        })
        sys.modules["folder_paths"] = self._fp

    def tearDown(self):
        sys.modules.pop("folder_paths", None)
        if self._saved_fp is not None:
            sys.modules["folder_paths"] = self._saved_fp


class TestSuggestSkillModelFixes(_SuggestTestBase):
    def test_ok_field_reported_ok_no_suggestion(self):
        out = workflow.suggest_skill_model_fixes({"model": "krea2_base.safetensors"})
        self.assertEqual(out["model"]["status"], "ok")
        self.assertIsNone(out["model"]["suggestion"])

    def test_missing_field_unique_match_gives_suggestion(self):
        # 旧路径指向不存在的子目录文件；唯一同名候选在另一子目录 → 给出 suggestion
        out = workflow.suggest_skill_model_fixes({"model": "MiniMaxH3/Old/h3_pruned.safetensors"})
        self.assertEqual(out["model"]["status"], "missing")
        self.assertEqual(out["model"]["suggestion"], "MiniMaxH3/Speed/h3_pruned.safetensors")
        self.assertGreaterEqual(out["model"]["score"], 0.85)

    def test_missing_field_low_confidence_gives_none_suggestion(self):
        out = workflow.suggest_skill_model_fixes({"model": "totally_different_model.safetensors"})
        self.assertEqual(out["model"]["status"], "missing")
        self.assertIsNone(out["model"]["suggestion"])

    def test_empty_field_skipped(self):
        out = workflow.suggest_skill_model_fixes({"model": "", "vae": None})
        self.assertNotIn("model", out)
        self.assertNotIn("vae", out)

    def test_lora_missing_reported_with_suggestion(self):
        out = workflow.suggest_skill_model_fixes(
            {"loras": [{"name": "krea2_quadview_old.safetensors", "strength": 1.0}]})
        self.assertEqual(len(out["loras"]), 1)
        self.assertEqual(out["loras"][0]["status"], "missing")
        self.assertEqual(out["loras"][0]["suggestion"], "krea2_quadview.safetensors")

    def test_lora_ok_not_flagged(self):
        out = workflow.suggest_skill_model_fixes({"loras": [{"name": "krea2_quadview.safetensors"}]})
        self.assertEqual(out["loras"][0]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
