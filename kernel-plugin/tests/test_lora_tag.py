# SPDX-License-Identifier: Apache-2.0
"""lora_tag：画廊叶子图片目录 LoRA 打标（离线单测）。

覆盖目录解析（仅可写来源）、HEIC→PNG + 顺序编号标准化、标签清洗、
批量打标写 .txt / 单张失败不中断，以及两个路由的请求/响应契约。
"""
import asyncio
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_TMP = tempfile.mkdtemp(prefix="neo_lora_tag_")
_INPUT = Path(_TMP) / "input"
_OUTPUT = Path(_TMP) / "output"
_CUSTOM = Path(_TMP) / "stars"   # 自定义目录（卡片名 = 目录名）
for d in (_INPUT, _OUTPUT, _CUSTOM):
    d.mkdir(parents=True, exist_ok=True)

_prev_server = sys.modules.get("server")
_prev_folder_paths = sys.modules.get("folder_paths")

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f))))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.input_directory = str(_INPUT)
_folder_paths.output_directory = str(_OUTPUT)
_folder_paths.unique_path = lambda folder, name: os.path.join(folder, name + "_1")
sys.modules["folder_paths"] = _folder_paths

_PKG = "_neo_lora_tag_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _stub(name, **attrs):
    mod = types.ModuleType(f"{_PKG}.{name}")
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    return mod


def _resolve_system_dir(name):
    """与 gallery._resolve_system_dir 同契约：只处理 input/output。"""
    name = (name or "").strip()
    nl = name.lower()
    for label, p in (("input", _INPUT), ("output", _OUTPUT)):
        if nl == label:
            return p, ""
        if nl.startswith(label + "/"):
            return p, name[len(label):].strip("/")
    return None


_llm_stub = _stub("llm", run_llm_task=lambda *a, **k: {"status": "success", "prompt": "gxt，单人，白色T恤"})
_gallery_stub = _stub("gallery",
                      CIVITAI_DIR_KEY="civitai_bookmarks",
                      _resolve_system_dir=_resolve_system_dir,
                      _get_user_custom_dirs=lambda: [_CUSTOM])


def _load(name):
    import importlib.util as iu
    spec = iu.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, f"{name}.py"))
    mod = iu.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


lora_tag = _load("lora_tag")


def _load_tool(name):
    import importlib.util as iu
    spec = iu.spec_from_file_location(name, os.path.join(PLUGIN_DIR, "tools", f"{name}.py"))
    mod = iu.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


format_tags = _load_tool("format_tags")


def _mk_png(path: Path, color="red"):
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (24, 16), color).save(path, format="PNG")


class FakeRequest:
    def __init__(self, query=None, json_data=None):
        self.query = query or {}
        self._json = json_data

    async def json(self):
        return self._json


def _drain(resp):
    body = resp.body

    async def drain():
        if isinstance(body, (bytes, bytearray)):
            return bytes(body)
        return await body.as_bytes()

    return asyncio.run(drain()).decode("utf-8")



class ResolveDirTests(unittest.TestCase):
    """目录解析：仅 Input / 自定义目录可打标，拒绝只读来源与非法路径。"""

    def test_input_subdir_resolves(self):
        (_INPUT / "stars" / "关晓彤").mkdir(parents=True)
        self.assertEqual(lora_tag._resolve_tag_dir("Input/stars/关晓彤"), _INPUT / "stars" / "关晓彤")

    def test_custom_dir_resolves(self):
        (_CUSTOM / "刘亦菲").mkdir(parents=True)
        self.assertEqual(lora_tag._resolve_tag_dir("stars/刘亦菲"), _CUSTOM / "刘亦菲")

    def test_output_is_rejected(self):
        (_OUTPUT / "x").mkdir(parents=True)
        with self.assertRaises(ValueError):
            lora_tag._resolve_tag_dir("Output/x")

    def test_readonly_sources_rejected(self):
        for bad in ("presets/a", "lora/b", "civitai_bookmarks/c", "cloud presets/d"):
            with self.assertRaises(ValueError, msg=bad):
                lora_tag._resolve_tag_dir(bad)

    def test_traversal_and_missing_rejected(self):
        with self.assertRaises(ValueError):
            lora_tag._resolve_tag_dir("Input/../..")
        with self.assertRaises(ValueError):
            lora_tag._resolve_tag_dir("Input/no_such_dir")
        with self.assertRaises(ValueError):
            lora_tag._resolve_tag_dir("")


class StandardizeTests(unittest.TestCase):
    """HEIC→PNG + 001<ext>... 顺序编号（同名 .txt 跟随移动）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="neo_lora_std_")
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_renames_and_moves_txt(self):
        _mk_png(self.dir / "b.jpg", "green")
        _mk_png(self.dir / "a.png")
        (self.dir / "a.txt").write_text("old caption", encoding="utf-8")
        (self.dir / "notes.md").write_text("not an image")

        out = lora_tag._standardize_dir(self.dir)
        self.assertEqual([p.name for p in sorted(self.dir.iterdir())],
                         ["001.png", "001.txt", "002.jpg", "notes.md"])
        self.assertEqual((self.dir / "001.txt").read_text(encoding="utf-8"), "old caption")
        self.assertEqual(len(out["renamed"]), 2)

    def test_heic_skipped_without_pillow_heif(self):
        if lora_tag._heif_available():
            self.skipTest("pillow-heif 已安装，走转换路径")
        _mk_png(self.dir / "a.png")
        (self.dir / "c.heic").write_bytes(b"fake heic")
        out = lora_tag._standardize_dir(self.dir)
        self.assertEqual(out["skipped"], ["c.heic"])
        self.assertTrue((self.dir / "c.heic").exists())

    def test_backup_copies_dir_and_replaces_old(self):
        _mk_png(self.dir / "a.png")
        (self.dir / "a.txt").write_text("cap", encoding="utf-8")
        old_bak = self.dir.with_name(self.dir.name + ".bak")
        old_bak.mkdir()
        (old_bak / "stale.png").write_bytes(b"stale")

        name = lora_tag._backup_dir(self.dir)
        bak = self.dir.with_name(name)
        self.assertEqual(name, self.dir.name + ".bak")
        self.assertEqual(sorted(p.name for p in bak.iterdir()), ["a.png", "a.txt"])
        self.assertFalse((bak / "stale.png").exists())


class CleanCaptionTests(unittest.TestCase):
    def test_strips_fences_and_quotes(self):
        self.assertEqual(lora_tag._clean_caption("```\ngxt，单人，白色T恤\n```"), "gxt, 单人, 白色T恤")
        self.assertEqual(lora_tag._clean_caption('"gxt，单人"'), "gxt, 单人")

    def test_joins_lines(self):
        self.assertEqual(lora_tag._clean_caption("第一行\n第二行"), "第一行, 第二行")

    def test_trigger_word_first_with_space(self):
        # LLM 漏写触发词时补在最前；已有触发词不重复
        self.assertEqual(lora_tag._clean_caption("单人，白色T恤", "gxt"), "gxt, 单人, 白色T恤")
        self.assertEqual(lora_tag._clean_caption("gxt，单人", "gxt"), "gxt, 单人")


class FormatTagsTests(unittest.TestCase):
    def test_glued_trigger_split_out(self):
        trig, out = format_tags.format_caption("baitaohua单人，深蓝西装，红色领带")
        self.assertEqual(trig, "baitaohua")
        self.assertEqual(out, "baitaohua, 单人, 深蓝西装, 红色领带")

    def test_mixed_separators(self):
        _, out = format_tags.format_caption("gxt单人,服装：白衬衫；黑发。", "gxt")
        self.assertEqual(out, "gxt, 单人, 服装：白衬衫, 黑发。")

    def test_no_ascii_trigger_keeps_content(self):
        trig, out = format_tags.format_caption("单人，白色T恤")
        self.assertEqual(trig, "")
        self.assertEqual(out, "单人, 白色T恤")


class TagBatchTests(unittest.TestCase):
    """批量打标：写同名 .txt；单张失败不中断整批。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="neo_lora_batch_")
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_writes_txt_and_reports_partial_failure(self):
        _mk_png(self.dir / "001.png")
        _mk_png(self.dir / "002.jpg")

        calls = []

        def counting_run(task, text, images=None, **kw):
            calls.append(text)
            if len(calls) == 2:
                return {"error": "LLM inference failed: boom"}
            return {"status": "success", "prompt": "gxt，单人，白色T恤"}

        lora_tag.run_llm_task = counting_run
        frames = list(lora_tag._tag_batch(self.dir, "gxt"))

        self.assertEqual(len(calls), 2)
        self.assertIn("触发词: gxt", calls[0])
        self.assertEqual((self.dir / "001.txt").read_text(encoding="utf-8"), "gxt, 单人, 白色T恤")
        self.assertFalse((self.dir / "002.txt").exists())
        progress = [f["progress"] for f in frames if "progress" in f]
        self.assertEqual([p["status"] for p in progress], ["ok", "error"])
        meta = frames[-1]["meta"]
        self.assertEqual(meta["status"], "partial")
        self.assertEqual(meta["done"], 1)
        self.assertEqual(meta["total"], 2)
        self.assertEqual(meta["failed"][0]["file"], "002.jpg")

    def test_cancel_stops_before_next_image(self):
        _mk_png(self.dir / "001.png")
        _mk_png(self.dir / "002.jpg")
        calls = []
        lora_tag.run_llm_task = lambda *a, **k: calls.append(a) or {"status": "success", "prompt": "gxt，单人"}

        cancel = threading.Event()
        cancel.set()
        frames = list(lora_tag._tag_batch(self.dir, "gxt", cancel))
        self.assertEqual(calls, [], "已取消时不应再调用 LLM")
        self.assertEqual(frames[-1]["meta"]["status"], "cancelled")
        self.assertEqual(frames[-1]["meta"]["done"], 0)
        self.assertFalse((self.dir / "001.txt").exists())


class RouteTests(unittest.TestCase):
    """/neo_gallery/tag_preflight 与 /neo_gallery/tag_dir 的请求/响应契约。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="neo_lora_route_")
        self.dir = _INPUT / "stars" / "关晓彤"
        self.dir.mkdir(parents=True, exist_ok=True)
        for f in ("001.png", "002.jpg"):
            _mk_png(self.dir / f)

    def tearDown(self):
        for f in self.dir.iterdir():
            f.unlink()
        self.tmp.cleanup()

    def test_preflight_returns_count_and_suggestion(self):
        resp = asyncio.run(lora_tag.neo_gallery_tag_preflight(
            FakeRequest(query={"dir": "Input/stars/关晓彤"})))
        self.assertEqual(resp.status, 200)
        data = json.loads(resp.text)
        self.assertEqual(data["image_count"], 2)
        self.assertEqual(data["suggested_trigger"], "guanxiaotong")

    def test_suggest_trigger_short_name_falls_back_to_random(self):
        t = lora_tag._suggest_trigger("c")
        self.assertEqual(len(t), 4)
        self.assertTrue(t.isalpha() and t.isascii())

    def test_preflight_bad_dir_400(self):
        resp = asyncio.run(lora_tag.neo_gallery_tag_preflight(
            FakeRequest(query={"dir": "Output/x"})))
        self.assertEqual(resp.status, 400)

    def test_tag_dir_streams_progress_and_meta(self):
        lora_tag.run_llm_task = lambda *a, **k: {"status": "success", "prompt": "gxt，单人，白色T恤"}
        resp = asyncio.run(lora_tag.neo_gallery_tag_dir(FakeRequest(json_data={
            "dir": "Input/stars/关晓彤", "trigger_word": "gxt", "standardize": False})))
        self.assertEqual(resp.status, 200)
        text = _drain(resp)
        self.assertIn('"status": "ok"', text)
        self.assertIn('"done": 2', text)
        self.assertTrue(text.rstrip().endswith("data: [DONE]"))
        self.assertEqual((self.dir / "001.txt").read_text(encoding="utf-8"), "gxt, 单人, 白色T恤")

    def test_tag_dir_standardize_backs_up_first(self):
        lora_tag.run_llm_task = lambda *a, **k: {"status": "success", "prompt": "gxt，单人"}
        resp = asyncio.run(lora_tag.neo_gallery_tag_dir(FakeRequest(json_data={
            "dir": "Input/stars/关晓彤", "trigger_word": "gxt", "standardize": True})))
        self.assertEqual(resp.status, 200)
        text = _drain(resp)
        self.assertIn('"backup": "关晓彤.bak"', text)
        bak = self.dir.with_name(self.dir.name + ".bak")
        self.assertEqual(sorted(p.name for p in bak.iterdir()), ["001.png", "002.jpg"])

    def test_tag_dir_empty_trigger_error(self):
        resp = asyncio.run(lora_tag.neo_gallery_tag_dir(FakeRequest(json_data={
            "dir": "Input/stars/关晓彤", "trigger_word": "  ", "standardize": False})))
        text = _drain(resp)
        self.assertIn("[ERROR]", text)


if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths


if __name__ == "__main__":
    unittest.main()

