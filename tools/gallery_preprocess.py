#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Neo Gallery — Offline preprocessor: scan presets, generate thumbnails + index.json
#
# Usage:
#   python gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]
#
# The output directory will contain:
#   index.json          — full directory index with metadata
#   thumbnails/         — pre-generated JPEG thumbnails
#   <subdir>/           — copies of media + txt files (ready for OSS upload)

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS
THUMB_SIZE = 320


def generate_image_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        from PIL import Image
        with Image.open(source_path) as img:
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"  [WARN] Failed to generate thumbnail for {source_path.name}: {e}")
        return False


def generate_video_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            print("  [WARN] ffmpeg not found, skipping video thumbnail")
            return False
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            ffmpeg_path, "-ss", "00:00:00.500",
            "-i", str(source_path),
            "-vframes", "1", "-y", str(cache_path)
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            cmd = [ffmpeg_path, "-i", str(source_path), "-vframes", "1", "-y", str(cache_path)]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                return False
        if cache_path.stat().st_size < 1024:
            cache_path.unlink(missing_ok=True)
            return False
        return True
    except Exception:
        return False


def generate_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    if source_path.suffix.lower() in VIDEO_EXTENSIONS:
        return generate_video_thumbnail(source_path, cache_path, size)
    return generate_image_thumbnail(source_path, cache_path, size)


def parse_txt_preview(txt_path: Path, max_chars: int = 500) -> str:
    if not txt_path or not txt_path.exists():
        return ""
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            raw = f.read(max_chars)
        lines = raw.strip().splitlines()[:2]
        result = []
        for line in lines:
            m = re.match(r"^\d+\s*\|\s*(.*)", line)
            result.append(m.group(1).strip() if m else line.strip())
        return "\n".join(result)
    except Exception:
        return ""


def scan_presets_directory(presets_dir: Path, output_dir: Path, thumb_size: int, copy_media: bool):
    """Scan presets directory and build index + thumbnails."""
    index = {
        "version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_url": "",
        "directories": {},
    }

    thumb_dir = output_dir / "thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    if not presets_dir.exists():
        print(f"[ERROR] Presets directory not found: {presets_dir}")
        return index

    # Scan first-level subdirectories
    subdirs = sorted([p for p in presets_dir.iterdir() if p.is_dir()])
    if not subdirs:
        print(f"[WARN] No subdirectories found in {presets_dir}")

    total_items = 0
    total_thumbs = 0

    for subdir in subdirs:
        dir_name = subdir.name
        print(f"\n[{dir_name}] Scanning...")

        dir_entries = []
        stems: dict[str, list[Path]] = {}

        for p in subdir.iterdir():
            if not p.is_file():
                continue
            lower = p.suffix.lower()
            if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
                continue
            stems.setdefault(p.stem, []).append(p)

        for stem, files in sorted(stems.items()):
            media_file = None
            media_type = None
            txt_file = None

            for f in files:
                if f.suffix.lower() in VIDEO_EXTENSIONS:
                    media_file = f
                    media_type = "video"
                elif f.suffix.lower() in IMG_EXTENSIONS:
                    if media_file is None:
                        media_file = f
                        media_type = "image"
                elif f.suffix.lower() == ".txt":
                    txt_file = f

            if not media_file:
                continue

            # Generate thumbnail
            thumb_subdir = thumb_dir / dir_name
            thumb_path = thumb_subdir / f"{stem}.jpg"
            thumb_ok = False
            if not thumb_path.exists():
                thumb_ok = generate_thumbnail(media_file, thumb_path, thumb_size)
                if thumb_ok:
                    total_thumbs += 1
            else:
                thumb_ok = True

            # Relative thumbnail path (for OSS URL construction)
            thumb_rel = f"thumbnails/{dir_name}/{stem}.jpg" if thumb_ok else ""

            # Parse txt preview
            txt_content = parse_txt_preview(txt_file)

            entry = {
                "filename": media_file.name,
                "type": media_type,
                "size": media_file.stat().st_size,
                "mtime": media_file.stat().st_mtime,
                "txt_content": txt_content,
                "thumbnail": thumb_rel,
            }
            dir_entries.append(entry)

            # Copy media + txt to output
            if copy_media:
                dest_subdir = output_dir / dir_name
                dest_subdir.mkdir(parents=True, exist_ok=True)
                dest_media = dest_subdir / media_file.name
                if not dest_media.exists():
                    shutil.copy2(media_file, dest_media)
                if txt_file:
                    dest_txt = dest_subdir / txt_file.name
                    if not dest_txt.exists():
                        shutil.copy2(txt_file, dest_txt)

            total_items += 1

        index["directories"][dir_name] = {
            "name": dir_name,
            "items": dir_entries,
        }
        print(f"  {len(dir_entries)} items, {sum(1 for e in dir_entries if e['thumbnail'])} thumbnails")

    # Also scan root-level files (not in any subdirectory)
    root_entries = []
    root_stems: dict[str, list[Path]] = {}
    for p in presets_dir.iterdir():
        if not p.is_file():
            continue
        lower = p.suffix.lower()
        if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
            continue
        root_stems.setdefault(p.stem, []).append(p)

    for stem, files in sorted(root_stems.items()):
        media_file = None
        media_type = None
        txt_file = None
        for f in files:
            if f.suffix.lower() in VIDEO_EXTENSIONS:
                media_file = f
                media_type = "video"
            elif f.suffix.lower() in IMG_EXTENSIONS:
                if media_file is None:
                    media_file = f
                    media_type = "image"
            elif f.suffix.lower() == ".txt":
                txt_file = f
        if not media_file:
            continue

        thumb_path = thumb_dir / f"{stem}.jpg"
        thumb_ok = False
        if not thumb_path.exists():
            thumb_ok = generate_thumbnail(media_file, thumb_path, thumb_size)
            if thumb_ok:
                total_thumbs += 1
        else:
            thumb_ok = True

        thumb_rel = f"thumbnails/{stem}.jpg" if thumb_ok else ""
        txt_content = parse_txt_preview(txt_file)

        root_entries.append({
            "filename": media_file.name,
            "type": media_type,
            "size": media_file.stat().st_size,
            "mtime": media_file.stat().st_mtime,
            "txt_content": txt_content,
            "thumbnail": thumb_rel,
        })
        total_items += 1

    if root_entries:
        index["directories"]["_root"] = {
            "name": "_root",
            "items": root_entries,
        }

    print(f"\n{'='*50}")
    print(f"Total: {total_items} items, {total_thumbs} thumbnails generated")
    print(f"Output: {output_dir}")

    return index


def main():
    parser = argparse.ArgumentParser(
        description="Neo Gallery preprocessor — generate index.json and thumbnails for OSS deployment"
    )
    parser.add_argument(
        "--presets", type=str, required=True,
        help="Path to the local presets directory (e.g. ComfyUI-Neo-Nodes/gallery/presets)"
    )
    parser.add_argument(
        "--output", type=str, required=True,
        help="Output directory for index.json + thumbnails + media copies"
    )
    parser.add_argument(
        "--size", type=int, default=THUMB_SIZE,
        help=f"Thumbnail size in pixels (default: {THUMB_SIZE})"
    )
    parser.add_argument(
        "--no-copy", action="store_true",
        help="Skip copying media files to output (only generate index + thumbnails)"
    )
    parser.add_argument(
        "--base-url", type=str, default="",
        help="Base URL prefix for OSS (written into index.json for reference)"
    )

    args = parser.parse_args()

    presets_dir = Path(args.presets).resolve()
    output_dir = Path(args.output).resolve()

    if not presets_dir.exists():
        print(f"[ERROR] Presets directory does not exist: {presets_dir}")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Neo Gallery Preprocessor")
    print(f"  Presets:  {presets_dir}")
    print(f"  Output:   {output_dir}")
    print(f"  Size:     {args.size}px")
    print(f"  Copy:     {'no' if args.no_copy else 'yes'}")

    index = scan_presets_directory(presets_dir, output_dir, args.size, not args.no_copy)
    index["base_url"] = args.base_url

    # Write index.json
    index_path = output_dir / "index.json"
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"\n[DONE] index.json written to {index_path}")


if __name__ == "__main__":
    main()
