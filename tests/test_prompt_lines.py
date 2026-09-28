# SPDX-License-Identifier: Apache-2.0
# ComfyUI-Neo-Nodes - 多行提示词集合标题提取单元测试
# 覆盖 _extract_title：正常中文提示词回归 + H3 字段头/时间戳去噪

import os
import sys
import importlib
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)

prompt_lines = importlib.import_module("prompt_lines")


class TestExtractTitle(unittest.TestCase):
    def test_normal_chinese_prompt_unchanged(self):
        self.assertEqual(
            prompt_lines._extract_title("一位年轻女性端坐于户外木质椅子上，身着碎花裙"),
            "女性端坐于户外木质椅子上",
        )

    def test_h3_field_header_stripped(self):
        title = prompt_lines._extract_title("integrated_multimodal_description: A woman sits in a cafe, sipping coffee")
        self.assertNotIn("integrated_multimodal_description", title)
        self.assertEqual(title, "A woman sits in a cafe")

    def test_h3_timestamp_range_stripped(self):
        title = prompt_lines._extract_title("A man walks down the street 00:00.000 - 00:05.000")
        self.assertNotIn("00:00.000", title)
        self.assertNotIn("00:05.000", title)
        self.assertEqual(title, "A man walks down the street")

    def test_h3_single_timestamp_stripped(self):
        title = prompt_lines._extract_title("overall_soundscape: Soft room tone at 00:02.500 then silence")
        self.assertNotIn("overall_soundscape", title)
        self.assertNotIn("00:02.500", title)

    def test_normal_prompt_with_year_not_stripped(self):
        # 年份 / 普通数字不应被当作时间戳误删
        self.assertEqual(prompt_lines._extract_title("A photo from 2024, vintage style"), "A photo from 2024")


if __name__ == "__main__":
    unittest.main()
