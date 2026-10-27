#!/usr/bin/env python3
"""Zip `extension/` into the file attached to a GitHub release.

Chrome / Edge want the archive's root to be the folder that contains
`manifest.json`, so entries are stored flat (`manifest.json`, `src/content.js`, …),
not under an `extension/` prefix.

    python3 .github/scripts/zip_extension.py --out dist/schreader-chrome-v0.2.0.zip
"""
import argparse
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {"__pycache__", "node_modules"}


def collect(src: Path) -> list[Path]:
    files = []
    for path in sorted(src.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(src)
        if any(part.startswith(".") or part in SKIP_DIRS for part in rel.parts):
            continue
        files.append(path)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT / "extension"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-version", default=None,
                    help="fail unless the zipped manifest.json carries this version")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    if not (src / "manifest.json").exists():
        print(f"[zip] ERROR: no manifest.json under {src}", file=sys.stderr)
        return 1

    files = collect(src)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            zf.write(path, path.relative_to(src).as_posix())

    if args.expect_version:
        import json
        with zipfile.ZipFile(out) as zf:
            version = json.loads(zf.read("manifest.json").decode("utf-8"))["version"]
        if version != args.expect_version:
            print(f"[zip] ERROR: manifest version {version} != {args.expect_version}",
                  file=sys.stderr)
            return 1
        print(f"[zip] manifest version {version} ok")

    print(f"[zip] {len(files)} files -> {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
