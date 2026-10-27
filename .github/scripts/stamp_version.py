#!/usr/bin/env python3
"""Write the release version into extension/manifest.json.

Called by .github/workflows/release.yml only. The stamp is never committed: the
repo keeps its checked-in version, and every build takes the tag's version
instead. Chrome requires 1-4 dot-separated integers in manifest.version.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True, help="already normalised, e.g. 0.2.0")
    ap.add_argument("--manifest", default=str(ROOT / "extension" / "manifest.json"))
    args = ap.parse_args()

    path = Path(args.manifest)
    data = json.loads(path.read_text(encoding="utf-8"))
    old = data.get("version")
    data["version"] = args.version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[stamp] extension manifest version {old} -> {args.version}")


if __name__ == "__main__":
    main()
