# SPDX-License-Identifier: Apache-2.0
"""节点元数据契约离线单测：每个注册节点必须自带搜索别名、描述与输出提示词。

前端搜索只认 SEARCH_ALIASES（server.py 透传为 search_aliases），节点悬停与输出连线只认
DESCRIPTION / OUTPUT_TOOLTIPS 与 widget 的 tooltip；V3 节点（io.ComfyNode）走 io.Schema 的
search_aliases / description / Output(tooltip=)。本测试不依赖运行中的 ComfyUI：复用
test_h3_video_director 的桩环境加载全部节点模块，逐个校验元数据的形状、数量对齐与中文别名。
"""

import ast
import sys
import unittest
from pathlib import Path

from test_h3_video_director import (   # noqa: E402  —— 复用同一套桩与 _load
    _PKG,
    _load,
    h3_video_director,
    image_gen_edit,
)


def _load_once(name, fname):
    """已在桩环境加载过的模块直接复用，避免同一进程里重复执行模块顶层代码。"""
    return sys.modules.get(f"{_PKG}.{name}") or _load(name, fname)


prompts = _load_once("prompts", "prompts.py")
bundle_expand = _load_once("bundle_expand", "bundle_expand.py")
ref_grid = _load_once("ref_grid", "ref_grid.py")
grid_split_node = _load_once("grid_split_node", "grid_split_node.py")
h3_segment = _load_once("h3_segment", "h3_segment.py")

NODE_MODULES = (prompts, image_gen_edit, h3_video_director, h3_segment,
                bundle_expand, ref_grid, grid_split_node)

EXPECTED_NODES = {
    "NeoPromptEncoder", "NeoPromptAgent", "NeoImageGenEdit",
    "NeoH3VideoDirector", "NeoH3AddKeyframe", "NeoH3AddGuides", "NeoH3AddContext",
    "NeoH3SegmentRun", "NeoBundleExpand", "NeoRefGrid", "NeoGridSplit",
}


def _has_cjk(text):
    return any(ord(ch) > 127 for ch in text)


INIT_PY = Path(__file__).resolve().parent.parent / "__init__.py"
HELP_DOCS_DIR = INIT_PY.parent / "web" / "docs"


def _manifest_from_init():
    """静态读取 __init__.py 的 NEO_NODES 清单：导入插件包会触发全部路由注册。"""
    for node in ast.walk(ast.parse(INIT_PY.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "NEO_NODES" for t in node.targets):
            return {k.value: v.value for k, v in zip(node.value.keys, node.value.values)}
    raise AssertionError("__init__.py 缺少 NEO_NODES 节点清单")


def _visible_widgets(spec):
    """INPUT_TYPES 里非 hidden 的 widget（hidden widget 由插件自己的前端渲染，tooltip 无意义）。"""
    for group in ("required", "optional"):
        for name, decl in (spec.get(group) or {}).items():
            opts = decl[1] if len(decl) > 1 and isinstance(decl[1], dict) else {}
            if not opts.get("hidden"):
                yield name, opts


class NodeMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.nodes = {}
        for mod in NODE_MODULES:
            for key, node_cls in mod.NODE_CLASS_MAPPINGS.items():
                cls.nodes[key] = node_cls
        # io.ComfyNode 也自带生成的 INPUT_TYPES / OUTPUT_TOOLTIPS，按 define_schema 区分 V3 节点
        cls.legacy = {k: c for k, c in cls.nodes.items() if not hasattr(c, "define_schema")}

    def test_registry_keys(self):
        """注册表键固定为这 11 个节点：新增/改名节点必须同步元数据与显示名。"""
        self.assertEqual(set(self.nodes), EXPECTED_NODES)

    def test_entry_manifest_matches_registry(self):
        """__init__.py 的清单必须与注册表一致，且每个节点登记在真正注册它的模块。"""
        manifest = _manifest_from_init()
        self.assertEqual(set(manifest), EXPECTED_NODES)
        module_keys = {mod.__name__.split(".")[-1]: set(mod.NODE_CLASS_MAPPINGS) for mod in NODE_MODULES}
        for key, mod_name in manifest.items():
            self.assertIn(key, module_keys.get(mod_name, set()), f"{key} 登记在 {mod_name}")

    def test_help_docs_cover_nodes(self):
        """每个登记节点都要有一份帮助文档：web/docs/<节点键>.md 是 ComfyUI 前端「信息」页的取用路径。"""
        missing = [key for key in EXPECTED_NODES if not (HELP_DOCS_DIR / f"{key}.md").is_file()]
        self.assertEqual(missing, [], f"缺少帮助文档: {missing}")

    def test_legacy_description_and_aliases(self):
        for key, cls in self.legacy.items():
            with self.subTest(key):
                self.assertTrue(isinstance(cls.DESCRIPTION, str) and cls.DESCRIPTION.strip())
                aliases = cls.SEARCH_ALIASES
                self.assertTrue(isinstance(aliases, list) and aliases)
                self.assertLessEqual(len(aliases), 30)
                self.assertEqual(len(aliases), len(set(aliases)))
                for alias in aliases:
                    self.assertTrue(alias.strip())
                    self.assertEqual(alias, alias.lower())
                self.assertTrue(any(_has_cjk(a) for a in aliases), f"{key} 缺少中文别名")

    def test_legacy_output_tooltips_aligned(self):
        """OUTPUT_TOOLTIPS 必须与 RETURN_TYPES 一一对应（server.py 按下标发给前端）。"""
        for key, cls in self.legacy.items():
            with self.subTest(key):
                tips = cls.OUTPUT_TOOLTIPS
                self.assertEqual(len(tips), len(cls.RETURN_TYPES))
                self.assertEqual(len(tips), len(cls.RETURN_NAMES))
                for tip in tips:
                    self.assertTrue(isinstance(tip, str) and tip.strip())

    def test_legacy_input_tooltips(self):
        """有可见 widget 的节点必须至少给出一个输入提示词；提示词不得为空串。"""
        for key, cls in self.legacy.items():
            with self.subTest(key):
                widgets = list(_visible_widgets(cls.INPUT_TYPES()))
                for name, opts in widgets:
                    if "tooltip" in opts:
                        self.assertTrue(opts["tooltip"].strip(), f"{key}.{name}")
                if widgets:
                    self.assertTrue(any("tooltip" in opts for _, opts in widgets),
                                    f"{key} 的可见 widget 没有任何 tooltip")

    def test_v3_node_schema_metadata(self):
        schema = image_gen_edit.NeoImageGenEdit.define_schema()
        self.assertTrue(schema.description.strip())
        self.assertTrue(schema.search_aliases)
        self.assertEqual(len(schema.search_aliases), len(set(schema.search_aliases)))
        self.assertTrue(any(_has_cjk(a) for a in schema.search_aliases))
        for out in schema.outputs:
            self.assertTrue(out.tooltip and out.tooltip.strip())
        self.assertTrue(any(getattr(i, "tooltip", None) for i in schema.inputs))


if __name__ == "__main__":
    unittest.main()
