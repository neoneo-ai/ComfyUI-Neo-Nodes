#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""h3_assemble（P2 段落拼接）离线单测。

复用 test_h3_segment / test_h3_video_director 的桩环境；core 的 `InputImpl`（读片 / 写成片）在离线环境
用替身（只替换 h3_assemble.InputImpl），拼帧、接缝融合、layout 记账、任务与路由都是真路径。
"""

import json
import pathlib
import unittest
from unittest.mock import patch

import torch

from test_h3_segment import (   # noqa: E402  —— 复用桩环境与工具
    _body,
    _FakeRequest,
    _pin_folder_paths,
    _RecipeCase,
    _run_async,
    _write_test_mp4,
)
from test_h3_video_director import _load, recipes

h3_assemble = _load("h3_assemble", "h3_assemble.py")

H3_FPS = 24


class _FakeComponents:
    def __init__(self, images, audio):
        self.images = images
        self.audio = audio


class _FakeInputImpl:
    """core InputImpl 替身：VideoFromFile 按注册表给帧（支持 start_time/duration 前缀裁剪）。"""

    sources = {}
    saved = []

    @classmethod
    def reset(cls):
        cls.sources = {}
        cls.saved = []

    @classmethod
    def register(cls, path, frames, audio=None):
        cls.sources[str(path)] = (frames, audio)

    @classmethod
    def VideoFromFile(cls, path, start_time=0, duration=0):
        frames, audio = cls.sources[str(path)]

        class _File:
            def get_components(self):
                count = int(round(duration * H3_FPS)) if duration else int(frames.shape[0])
                return _FakeComponents(frames[:count], audio)

        return _File()

    @classmethod
    def VideoFromComponents(cls, components):
        class _Out:
            def save_to(self, path, format=None, codec=None):
                # 写一个真 mp4（帧数一致）并登记成可读源：拼接产物本身也会被后续调用当输入读回
                _write_test_mp4(path, frames=int(components.images.shape[0]), size=8)
                cls.sources[str(path)] = (components.images, components.audio)
                cls.saved.append((str(path), components))

        return _Out()


def _audio(sample_rate=32000, samples=48000):
    return {"waveform": torch.zeros(1, 2, samples), "sample_rate": sample_rate}


def _frames(count, value, size=8):
    return torch.full((count, size, size, 3), float(value))


class AssembleTests(_RecipeCase):
    """前缀 + 片段拼接（3 段 × 5s = 124 帧/段；窗口模式下复算保留 [124, 119, 119]）。"""

    def setUp(self):
        super().setUp()
        _FakeInputImpl.reset()
        h3_assemble._TASKS.clear()

    def _setup(self, work, film=True, clips=(1, 2), clip_frames=141):
        """建配方 + 真成片（362 帧）+ 注册假读片源。"""
        results = []
        if film:
            _write_test_mp4(work / "output" / "film.mp4", frames=362, size=16)
            _FakeInputImpl.register(work / "output" / "film.mp4", _frames(362, 0.1), _audio())
            results.append({"filename": "film.mp4", "kind": "video", "type": "output"})
        for index in clips:
            name = f"clip{index}.mp4"
            _write_test_mp4(work / "output" / name, frames=clip_frames, size=16)
            _FakeInputImpl.register(work / "output" / name, _frames(clip_frames, 0.1 * (index + 1)), _audio())
            results.append({"filename": name, "kind": "video", "type": "output", "segment": index, "seed": 1})
        self.write_recipe(results=results)

    def test_prefix_and_clips_are_concatenated_with_layout(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", 1, blend=2)
            self.assertEqual(result["frames"], 124 + 141 + 141)
            self.assertEqual(result["layout"], [124, 141, 141])
            self.assertEqual((result["film"], result["prefix_frames"]), ("film.mp4", 124))
            self.assertTrue((work / "output" / "neo_director_merge" / result["filename"]).is_file())
            saved = recipes.list_recipe_results("T")[0]        # 新成片：无 segment，带 layout
            self.assertEqual(saved["filename"], result["filename"])
            self.assertIsNone(saved.get("segment"))
            self.assertEqual(saved["layout"], [124, 141, 141])
            images = _FakeInputImpl.saved[-1][1].images
            self.assertAlmostEqual(float(images[0].mean()), 0.1, places=5)
            self.assertAlmostEqual(float(images[200].mean()), 0.2, places=5)
            self.assertAlmostEqual(float(images[300].mean()), 0.3, places=5)
            # 接缝两帧是「前段尾帧 × 本段头帧」的 0→1 融合（blend=2 → 权重 1/3、2/3）
            self.assertAlmostEqual(float(images[122].mean()), 0.1 * 2 / 3 + 0.2 / 3, places=5)
            self.assertAlmostEqual(float(images[123].mean()), 0.1 / 3 + 0.2 * 2 / 3, places=5)
            self.assertAlmostEqual(float(images[263].mean()), 0.2 * 2 / 3 + 0.3 / 3, places=5)
            self.assertAlmostEqual(float(images[264].mean()), 0.2 / 3 + 0.3 * 2 / 3, places=5)

    def test_from_zero_needs_no_film(self):
        with _pin_folder_paths() as work:
            self._setup(work, film=False, clips=(0, 1, 2))
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", 0)
            self.assertEqual((result["frames"], result["prefix_frames"], result["film"]), (423, 0, None))
            self.assertEqual(result["layout"], [141, 141, 141])

    def test_missing_clips_and_bad_start_are_reported(self):
        with _pin_folder_paths() as work:
            self._setup(work, clips=(1,))
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", 1)
                self.assertIn("第 3 段", str(ctx.exception))
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", 5)
                self.assertIn("起始段越界", str(ctx.exception))
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", 0)
                self.assertIn("第 1 段", str(ctx.exception))

    def test_resolution_mismatch_is_rejected(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            _FakeInputImpl.sources[str(work / "output" / "clip2.mp4")] = (_frames(141, 0.3, size=12), _audio())
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", 1)
        self.assertIn("分辨率", str(ctx.exception))

    def test_missing_audio_warns_and_outputs_silent_film(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            _FakeInputImpl.sources[str(work / "output" / "clip1.mp4")] = (_frames(141, 0.2), None)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", 1)
            self.assertIn("没有音频轨", " ".join(result["warnings"]))
            self.assertIsNone(_FakeInputImpl.saved[-1][1].audio)

    def test_progress_stages_and_cancel(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            stages = []
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble.assemble_film("T", 1, progress=lambda stage, value, total: stages.append((stage, value, total)))
                with self.assertRaises(h3_assemble._Cancelled):
                    h3_assemble.assemble_film("T", 1, should_cancel=lambda: True)
        self.assertTrue(stages[0][0].startswith("读取成片前缀"))
        self.assertEqual(stages[-1][0], "编码成片")
        self.assertEqual(stages[-1][1], stages[-1][2])


class AssembleTaskTests(_RecipeCase):
    class _InlineThread:
        """让路由起的后台线程在测试里同步跑完。"""

        def __init__(self, target=None, args=(), name=None, daemon=None):
            self._target, self._args = target, args

        def start(self):
            self._target(*self._args)

    def setUp(self):
        super().setUp()
        _FakeInputImpl.reset()
        h3_assemble._TASKS.clear()

    def _setup(self, work):
        _write_test_mp4(work / "output" / "film.mp4", frames=362, size=16)
        _FakeInputImpl.register(work / "output" / "film.mp4", _frames(362, 0.1), _audio())
        for index, value in ((1, 0.2), (2, 0.3)):
            name = f"clip{index}.mp4"
            _write_test_mp4(work / "output" / name, frames=141, size=16)
            _FakeInputImpl.register(work / "output" / name, _frames(141, value), _audio())
        self.write_recipe(results=[
            {"filename": "film.mp4", "kind": "video", "type": "output"},
            {"filename": "clip1.mp4", "kind": "video", "type": "output", "segment": 1},
            {"filename": "clip2.mp4", "kind": "video", "type": "output", "segment": 2},
        ])

    def _task(self, task_id="t1", **overrides):
        task = {"task_id": task_id, "status": "queued", "recipe": "T", "from": 1, "film": "", "blend": 0,
                "continuity": True, "context_frames": 22, "filename": None, "frames": 0, "progress": None,
                "stage": "", "clips": [], "warnings": [], "error": "", "cancel": False,
                "created": 0.0, "updated": 0.0}
        task.update(overrides)
        h3_assemble._TASKS[task_id] = task
        return task

    def test_run_task_records_success_failure_and_cancel(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            self._task()
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble._run_task("t1")
            task = h3_assemble._TASKS["t1"]
            self.assertEqual((task["status"], task["frames"]), ("succeeded", 406))
            self.assertTrue(task["filename"].endswith(".mp4"))
            self.assertEqual([c["segment"] for c in task["clips"]], [1, 2])

            self._task("t2", **{"from": 9})
            h3_assemble._run_task("t2")
            self.assertEqual(h3_assemble._TASKS["t2"]["status"], "failed")
            self.assertIn("起始段越界", h3_assemble._TASKS["t2"]["error"])

            self._task("t3", cancel=True)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble._run_task("t3")
            self.assertEqual(h3_assemble._TASKS["t3"]["status"], "cancelled")


    def test_assemble_route_starts_task_and_validates(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl), \
                    patch.object(h3_assemble.threading, "Thread", self._InlineThread):
                resp = _run_async(h3_assemble.assemble_segments_route(
                    _FakeRequest({"recipe": "T", "from": 1, "blend": 0})))
                data = _body(resp)
            self.assertEqual(resp.status, 200)
            self.assertTrue(data["success"])
            self.assertEqual((data["status"], data["frames"]), ("succeeded", 406))
            self.assertEqual(set(data), {"success", "task_id", "status", "recipe", "from", "film", "blend",
                                         "filename", "frames", "progress", "stage", "clips", "warnings",
                                         "error", "created", "updated"})
            for body, expect in (({"recipe": "T", "from": 5}, "起始段越界"),
                                 ({"recipe": "Nope", "from": 0}, "配方不存在"),
                                 ({"recipe": "T", "from": 0}, "第 1 段")):
                resp = _run_async(h3_assemble.assemble_segments_route(_FakeRequest(body)))
                self.assertEqual(resp.status, 400)
                self.assertIn(expect, _body(resp)["error"])
        self.write_recipe(name="P", preset=True)
        resp = _run_async(h3_assemble.assemble_segments_route(_FakeRequest({"recipe": "P", "from": 0})))
        self.assertEqual(resp.status, 400)
        self.assertIn("只读", _body(resp)["error"])

    def test_status_and_cancel_routes(self):
        self._task("t1", status="running")
        resp = _run_async(h3_assemble.assemble_status_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["stage"]), (200, ""))
        resp = _run_async(h3_assemble.assemble_status_route(_FakeRequest(match={"task_id": "nope"})))
        self.assertEqual(resp.status, 404)
        resp = _run_async(h3_assemble.assemble_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertTrue(_body(resp)["success"])
        self.assertTrue(h3_assemble._TASKS["t1"]["cancel"])
        h3_assemble._TASKS["t1"]["status"] = "succeeded"
        resp = _run_async(h3_assemble.assemble_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["error"]), (409, "任务已结束，无法取消"))

    def test_segment_clips_route_reports_both_sides(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            resp = _run_async(h3_assemble.segment_clips_route(_FakeRequest(query={"recipe": "T"})))
            data = _body(resp)
            self.assertEqual(data["segments"], 3)
            self.assertEqual([c["segment"] for c in data["clips"]], [1, 2])
            self.assertEqual(data["clips"][0]["frames"], 141)
            self.assertEqual(data["film"]["filename"], "film.mp4")
            self.assertEqual([s["kept"] for s in data["film"]["segments"]], [124, 119, 119])
            resp = _run_async(h3_assemble.segment_clips_route(_FakeRequest(query={})))
            self.assertEqual(resp.status, 400)
            self.assertIn("缺少配方名", _body(resp)["error"])


if __name__ == "__main__":
    unittest.main()
