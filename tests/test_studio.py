#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""studio（Neo Studio 整片生成）离线单测。

复用 test_h3_video_director 的桩环境（server / comfy / folder_paths + 真实 recipes 模块），
在其中加载 studio。覆盖：_run_prompt 两节点图组装与校验、generate/status/cancel 三个路由、
任务 watcher 的进度/完成/配方记账，以及 version 路由。
"""

import asyncio
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from test_h3_video_director import (   # noqa: E402  —— 复用同一套桩与工具
    _OUTPUT_DIR,
    _folder_paths,
    _load,
    _server,
    recipes,
)

studio = _load("studio", "studio.py")
# 全套件运行时，其它测试模块会替换 sys.modules["server"] 为各自的桩；
# 把 studio 固定到本套件的 server 桩（带 send_sync / prompt_queue）。
studio.PromptServer = _server.PromptServer


class _RecipeCase(unittest.TestCase):
    """把 recipes 的自定义/预设目录指到临时目录，并写一份最小 video_director 配方。"""

    SEGMENTS = ({"skill_id": "sk-a", "prompt": "第一段", "duration_sec": 5},
                {"skill_id": "sk-a", "prompt": "第二段", "duration_sec": 5})

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        self._dirs = (recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.CUSTOM_DIR = root / "custom"
        recipes.PRESETS_DIR = root / "presets"
        recipes.CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        recipes.PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        studio._TASKS.clear()
        studio._WATCHERS.clear()

    def tearDown(self):
        recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._dirs
        self._tmp.cleanup()

    def write_recipe(self, name="T", preset=False):
        base = recipes.PRESETS_DIR if preset else recipes.CUSTOM_DIR
        recipe_dir = base / name
        recipe_dir.mkdir(parents=True, exist_ok=True)
        meta = {"type": "video_director", "shared": {"mode": "t2v", "seed": 7},
                "segments": list(self.SEGMENTS)}
        (recipe_dir / "recipe.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return recipe_dir

    def _req(self, payload):
        class _Req:
            async def json(self):
                return payload
        return _Req()

    def _drive(self, payload, lookup=None, progress=None, rounds=300):
        """同一事件循环里提交生成请求并轮询到任务结束（桩执行无真实 I/O）。"""
        async def _fake_submit(graph):
            return "prompt-1"

        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio, "submit_graph", _fake_submit), \
                 patch.object(studio, "_lookup", lookup or (lambda pid: ("queued", None))), \
                 patch.object(studio, "_progress_for", progress or (lambda pid: None)), \
                 patch.object(studio, "POLL_INTERVAL", 0.01):
                resp = loop.run_until_complete(studio.director_generate_route(self._req(payload)))
                self.assertEqual(resp.status, 200, f"生成请求失败：{resp.body}")
                data = json.loads(resp.body)
                task_id = data["task_id"]
                for _ in range(rounds):
                    loop.run_until_complete(asyncio.sleep(0.01))
                    if studio._TASKS[task_id]["status"] not in ("queued", "running"):
                        break
            return data, studio._TASKS[task_id]
        finally:
            loop.close()


class RunPromptTests(_RecipeCase):
    def test_graph_two_nodes(self):
        self.write_recipe("R")
        payload = studio._run_prompt({"recipe": "R", "seed": 3, "width": 640, "height": 384})
        g = payload["graph"]
        self.assertEqual(set(g), {"1", "2"})
        self.assertEqual(g["1"]["class_type"], "NeoH3VideoDirector")
        self.assertEqual(g["1"]["inputs"]["recipe"], "R")
        self.assertEqual(g["1"]["inputs"]["seed"], 3)
        self.assertEqual(g["1"]["inputs"]["width"], 640)
        self.assertFalse(g["1"]["inputs"]["preview"])   # Studio 无节点面板，预览关掉
        self.assertEqual(g["2"]["class_type"], "SaveVideo")
        self.assertEqual(g["2"]["inputs"]["video"], ["1", 0])
        self.assertTrue(g["2"]["inputs"]["filename_prefix"].startswith("NeoDirector/"))

    def test_missing_recipe(self):
        with self.assertRaises(ValueError):
            studio._run_prompt({})

    def test_preset_rejected(self):
        self.write_recipe("P", preset=True)
        with self.assertRaises(ValueError):
            studio._run_prompt({"recipe": "P"})

    def test_no_segments_rejected(self):
        d = self.write_recipe("E")
        (d / "recipe.json").write_text(
            json.dumps({"type": "video_director", "segments": []}), encoding="utf-8")
        with self.assertRaises(ValueError):
            studio._run_prompt({"recipe": "E"})


class GenerateRouteTests(_RecipeCase):
    def test_generate_submits_and_tracks(self):
        self.write_recipe("R")
        data, task = self._drive({"recipe": "R", "seed": 3})
        self.assertTrue(data["success"])
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["prompt_id"], "prompt-1")
        self.assertEqual(task["recipe"], "R")

    def test_validation_error_400(self):
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_generate_route(self._req({})))
        finally:
            loop.close()
        self.assertEqual(r.status, 400)
        self.assertFalse(json.loads(r.body)["success"])

    def test_status_route(self):
        self.write_recipe("R")
        data, _ = self._drive({"recipe": "R"})
        req = types.SimpleNamespace(match_info={"task_id": data["task_id"]})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_status_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(r.body)["status"], "queued")

    def test_status_route_unknown_task_404(self):
        req = types.SimpleNamespace(match_info={"task_id": "nope"})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_status_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 404)

    def test_cancel_route(self):
        self.write_recipe("R")
        data, _ = self._drive({"recipe": "R"})
        queue = types.SimpleNamespace(
            delete_queue_item=lambda pred: True, interrupt_if_running=lambda pid: False)
        req = types.SimpleNamespace(match_info={"task_id": data["task_id"]})
        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio.PromptServer.instance, "prompt_queue", queue):
                r = loop.run_until_complete(studio.director_cancel_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        body = json.loads(r.body)
        self.assertTrue(body["success"])
        self.assertTrue(body["dequeued"])

    def test_cancel_route_unknown_task_404(self):
        req = types.SimpleNamespace(match_info={"task_id": "nope"})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_cancel_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 404)


class WatcherTests(_RecipeCase):
    def test_success_records_result(self):
        self.write_recipe("R")
        # 结果记账要求文件真实存在于 output 目录（桩环境里放一个空文件）
        film_dir = os.path.join(_OUTPUT_DIR, "NeoDirector")
        os.makedirs(film_dir, exist_ok=True)
        film_path = os.path.join(film_dir, "R_1.mp4")
        with open(film_path, "wb"):
            pass
        try:
            # 全套件运行时 sys.modules["folder_paths"] 会被其它测试模块替换；
            # _result_path 在函数内 import，这里固定回本套件的桩（output 目录 = _OUTPUT_DIR）
            saved_fp = sys.modules.get("folder_paths")
            sys.modules["folder_paths"] = _folder_paths
            try:
                item = {"status": {"completed": True, "messages": []},
                        "outputs": {"2": [{"filename": "R_1.mp4", "subfolder": "NeoDirector", "type": "output"}]}}
                data, task = self._drive({"recipe": "R"}, lookup=lambda pid: ("done", item))
                self.assertEqual(task["status"], "succeeded")
                self.assertEqual(task["filename"], "R_1.mp4")
                self.assertEqual(task["subfolder"], "NeoDirector")
                meta = json.loads((recipes.CUSTOM_DIR / "R" / "recipe.json").read_text(encoding="utf-8"))
                self.assertTrue(any(r.get("filename") == "R_1.mp4" and r.get("subfolder") == "NeoDirector"
                                     for r in meta.get("results", [])))
            finally:
                if saved_fp is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = saved_fp
        finally:
            os.remove(film_path)

    def test_failed_task_keeps_error(self):
        self.write_recipe("R")
        item = {"status": {"completed": False,
                           "messages": [["execution_error", {"exception_message": "boom"}]]},
                "outputs": {}}
        data, task = self._drive({"recipe": "R"}, lookup=lambda pid: ("done", item))
        self.assertEqual(task["status"], "failed")
        self.assertIn("boom", task["error"])

    def test_progress_captured_while_running(self):
        self.write_recipe("R")
        calls = {"n": 0}

        def _lookup(pid):
            calls["n"] += 1
            return ("running", None) if calls["n"] < 3 else (
                "done", {"status": {"completed": True, "messages": []},
                         "outputs": {"2": [{"filename": "x.mp4", "subfolder": "", "type": "output"}]}})

        seen = {}
        orig = studio._notify

        def _spy(task):
            if task.get("progress") is not None:
                seen["progress"] = task["progress"]
            return orig(task)

        with patch.object(studio, "_notify", _spy):
            data, task = self._drive({"recipe": "R"}, lookup=_lookup, progress=lambda pid: {"value": 3, "max": 10})
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(seen.get("progress"), {"value": 3, "max": 10})


class VideoFromHistoryTests(unittest.TestCase):
    def test_finds_video_entry(self):
        item = {"outputs": {"2": [{"filename": "a/b.mp4", "subfolder": "a", "type": "output"}]}}
        self.assertEqual(studio._video_from_history(item), ("a/b.mp4", "a"))

    def test_no_video(self):
        self.assertEqual(studio._video_from_history({"outputs": {"2": [{"filename": "x.png"}]}}), (None, ""))


class VersionRouteTests(unittest.TestCase):
    def test_version(self):
        req = types.SimpleNamespace()
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.studio_version_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        data = json.loads(r.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["plugin"], "ComfyUI-Neo-Nodes")
        self.assertIn("plugin_version", data)
        self.assertIn("comfyui_version", data)


if __name__ == "__main__":
    unittest.main()

