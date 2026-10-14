#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""LoRA 打标目录标签格式化：把已生成好的 .txt 统一成「, 」分隔（触发词独立在最前）。

与 lora_tag._clean_caption 使用同一套分隔符（, ， ; ； 换行），只改写 .txt，
改写前把原文件备份到 <dir>.txtbak/。触发词缺省时取每条标签开头的 ASCII 串

Usage:
  python format_tags.py <dataset_dir> [--trigger baitaohua] [--dry-run]
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

SEPARATORS = r"[,，;；\n]"


def format_caption(text: str, trigger: str = "") -> tuple[str, str]:
    """返回 (触发词, 格式化后的标签串)。"""
    text = (text or "").strip().strip('"').strip("'").strip()
    parts = [p.strip() for p in re.split(SEPARATORS, text) if p.strip()]
    if not parts:
        return trigger, ""
    if not trigger:
        m = re.match(r"[A-Za-z]+", parts[0])
        trigger = m.group(0) if m else ""
    if trigger:
        if parts[0].lower() == trigger.lower():
            parts.pop(0)
        elif parts[0].lower().startswith(trigger.lower()):
            parts[0] = parts[0][len(trigger):].strip()
        parts.insert(0, trigger)
    parts = [p for p in parts if p]
    return trigger, ", ".join(parts)


def main():
    ap = argparse.ArgumentParser(description="格式化 LoRA 打标目录的 .txt 标签分隔符")
    ap.add_argument("dir")
    ap.add_argument("--trigger", default="", help="触发词；缺省时从每条标签开头的 ASCII 串识别")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写文件")
    args = ap.parse_args()

    d = Path(args.dir)
    if not d.is_dir():
        sys.exit(f"目录不存在: {d}")
    txts = sorted(d.glob("*.txt"))
    if not txts:
        sys.exit("该目录没有 .txt 标签文件")

    bak = d.with_name(d.name + ".txtbak")
    changed = 0
    for f in txts:
        old = f.read_text(encoding="utf-8")
        _, new = format_caption(old, args.trigger)
        if not new or new == old.strip():
            continue
        changed += 1
        print(f"{f.name}: {new[:70]}")
        if not args.dry_run:
            bak.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, bak / f.name)
            f.write_text(new, encoding="utf-8")
    print(f"{'预览' if args.dry_run else '已改写'} {changed}/{len(txts)} 个 .txt"
          + ("" if args.dry_run else f"，原文件备份在 {bak}"))


if __name__ == "__main__":
    main()
