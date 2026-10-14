#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Neo Gallery — Deploy preprocessed presets to Alibaba Cloud OSS
#
# Usage:
#   python gallery_deploy_oss.py --source <output_dir> --bucket <bucket> --prefix <prefix>
#
# Credentials are read from environment variables:
#   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_ENDPOINT
# Or passed via  , --access-key-secret, --endpoint
#
# Requires: pip install oss2

import argparse
import hashlib
import mimetypes
import os
import sys
from pathlib import Path

try:
    import oss2
except ImportError:
    print("[ERROR] oss2 not installed. Run: pip install oss2")
    sys.exit(1)


# File extensions that should get Cache-Control: max-age for CDN caching
STATIC_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov"}


def md5_file(filepath: Path) -> str:
    h = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def guess_content_type(filepath: Path) -> str:
    ct, _ = mimetypes.guess_type(str(filepath))
    return ct or "application/octet-stream"


def collect_files(source_dir: Path) -> list[tuple[Path, str]]:
    """Collect all files under source_dir, return (local_path, relative_key) pairs."""
    files = []
    for p in sorted(source_dir.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(source_dir).as_posix()
        files.append((p, rel))
    return files


def deploy(source_dir: Path, bucket_name: str, prefix: str, endpoint: str,
           access_key_id: str, access_key_secret: str, dry_run: bool, skip_unchanged: bool):
    bucket = None
    if not dry_run:
        auth = oss2.Auth(access_key_id, access_key_secret)
        bucket = oss2.Bucket(auth, endpoint, bucket_name)
        try:
            bucket.get_bucket_info()
            print(f"[OK] Connected to bucket: {bucket_name}")
        except Exception as e:
            print(f"[ERROR] Cannot access bucket: {e}")
            sys.exit(1)

    files = collect_files(source_dir)
    total = len(files)
    print(f"Found {total} files to upload")

    uploaded = 0
    skipped = 0
    failed = 0

    for i, (local_path, rel_key) in enumerate(files):
        oss_key = f"{prefix}{rel_key}" if prefix else rel_key
        content_type = guess_content_type(local_path)
        file_size = local_path.stat().st_size

        # Progress
        pct = (i + 1) / total * 100
        print(f"  [{i+1}/{total}] ({pct:.0f}%) {rel_key} ({file_size:,} bytes)", end="")

        if dry_run:
            print(" [DRY RUN]")
            uploaded += 1
            continue

        # Skip unchanged files by comparing ETag (MD5)
        if skip_unchanged:
            try:
                remote_meta = bucket.head_object(oss_key)
                remote_etag = remote_meta.etag.lower().strip('"')
                local_etag = md5_file(local_path)
                if remote_etag == local_etag:
                    print(" [SKIP]")
                    skipped += 1
                    continue
            except oss2.exceptions.NoSuchKey:
                pass
            except Exception:
                pass

        # Build headers
        headers = {"Content-Type": content_type}
        if local_path.suffix.lower() in STATIC_EXTENSIONS:
            headers["Cache-Control"] = "public, max-age=31536000, immutable"

        try:
            bucket.put_object_from_file(oss_key, str(local_path), headers=headers)
            print(" [OK]")
            uploaded += 1
        except Exception as e:
            print(f" [FAIL] {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"Uploaded: {uploaded}, Skipped: {skipped}, Failed: {failed}")

    # Print the index URL
    if not dry_run and uploaded > 0:
        index_key = f"{prefix}index.json" if prefix else "index.json"
        # Construct public URL
        endpoint_base = endpoint.replace("https://", "").replace("http://", "")
        public_url = f"https://{bucket_name}.{endpoint_base}/{index_key}"
        print(f"\nIndex URL: {public_url}")
        print(f"Use this URL in gallery_settings.json -> oss_presets.index_url")


def main():
    parser = argparse.ArgumentParser(
        description="Deploy Neo Gallery preprocessed presets to Alibaba Cloud OSS"
    )
    parser.add_argument("--source", type=str, required=True,
                        help="Path to preprocessed output directory (from gallery_preprocess.py)")
    parser.add_argument("--bucket", type=str, required=True,
                        help="OSS bucket name")
    parser.add_argument("--prefix", type=str, default="gallery/presets/",
                        help="OSS key prefix (default: gallery/presets/)")
    parser.add_argument("--endpoint", type=str, default=os.environ.get("OSS_ENDPOINT", ""),
                        help="OSS endpoint (or set OSS_ENDPOINT env var)")
    parser.add_argument("--access-key-id", type=str, default=os.environ.get("OSS_ACCESS_KEY_ID", ""),
                        help="Access Key ID (or set OSS_ACCESS_KEY_ID env var)")
    parser.add_argument("--access-key-secret", type=str, default=os.environ.get("OSS_ACCESS_KEY_SECRET", ""),
                        help="Access Key Secret (or set OSS_ACCESS_KEY_SECRET env var)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List files without uploading")
    parser.add_argument("--skip-unchanged", action="store_true", default=True,
                        help="Skip files whose ETag matches local MD5 (default: True)")
    parser.add_argument("--no-skip-unchanged", action="store_true",
                        help="Upload all files regardless of remote state")

    args = parser.parse_args()

    source_dir = Path(args.source).resolve()
    if not source_dir.exists():
        print(f"[ERROR] Source directory does not exist: {source_dir}")
        sys.exit(1)

    index_path = source_dir / "index.json"
    if not index_path.exists():
        print(f"[ERROR] index.json not found in {source_dir}")
        print("Run gallery_preprocess.py first to generate the index.")
        sys.exit(1)

    if args.dry_run:
        print("[DRY RUN MODE]")

    skip = args.skip_unchanged and not args.no_skip_unchanged

    if not args.dry_run:
        if not args.endpoint:
            print("[ERROR] --endpoint or OSS_ENDPOINT is required")
            sys.exit(1)
        if not args.access_key_id or not args.access_key_secret:
            print("[ERROR] --access-key-id/--access-key-secret or OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET required")
            sys.exit(1)

    print(f"Neo Gallery OSS Deploy")
    print(f"  Source:   {source_dir}")
    print(f"  Bucket:   {args.bucket}")
    print(f"  Prefix:   {args.prefix}")
    print(f"  Endpoint: {args.endpoint or '(dry run)'}")
    print(f"  Skip:     {skip}")
    print()

    deploy(
        source_dir=source_dir,
        bucket_name=args.bucket,
        prefix=args.prefix,
        endpoint=args.endpoint,
        access_key_id=args.access_key_id,
        access_key_secret=args.access_key_secret,
        dry_run=args.dry_run,
        skip_unchanged=skip,
    )


if __name__ == "__main__":
    main()
