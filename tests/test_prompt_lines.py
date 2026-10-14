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

    def test_h3_align_line_i2v_zh_no_title(self):
        self.assertEqual(
            prompt_lines._extract_title("对于目标视频，在目标视频第 0.00 秒处，<Picture 1>（来自 [Shot 1]）被完整引用。"),
            "(未命名)",
        )

    def test_h3_align_line_i2v_en_no_title(self):
        self.assertEqual(
            prompt_lines._extract_title("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."),
            "(未命名)",
        )

    def test_h3_align_line_fl2v_zh_no_title(self):
        self.assertEqual(
            prompt_lines._extract_title("参考图与目标视频的对齐方式——Picture 1（来自 Shot 1）对齐目标视频第 0.00 秒处；Picture 2（来自 Shot 2）对齐目标视频第 10.00 秒处。"),
            "(未命名)",
        )

    def test_h3_align_line_fl2v_en_no_title(self):
        self.assertEqual(
            prompt_lines._extract_title("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 10.00-second mark of the target video."),
            "(未命名)",
        )


if __name__ == "__main__":
    unittest.main()
