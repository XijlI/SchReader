#!/usr/bin/env python3
"""Keep the site list in `manifest.json` in step with `extension/src/whitelist.js`.

Chrome wants the allowed sites in the manifest at install time (`content_scripts.matches`
plus `host_permissions`), but nothing in the manifest can read a JS file — so the list
lives twice. This script owns the copy:

    python3 .github/scripts/sync_whitelist.py           # rewrite manifest.json from the JS list
    python3 .github/scripts/sync_whitelist.py --check   # exit 1 when the two have drifted

Every domain becomes two patterns (`*://d/*` and `*://*.d/*`) because a `*.` host pattern
is not guaranteed to match the bare domain in every Chrome version.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WHITELIST = ROOT / "extension" / "src" / "whitelist.js"
MANIFEST = ROOT / "extension" / "manifest.json"


def read_domains() -> list[str]:
    text = WHITELIST.read_text(encoding="utf-8")
    m = re.search(r"const DEFAULT_DOMAINS = \[(.*?)\n  \];", text, re.S)
    if not m:
        sys.exit(f"[whitelist] ERROR: DEFAULT_DOMAINS not found in {WHITELIST}")
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return re.findall(r"'([^']+)'", body)


def patterns(domains: list[str]) -> list[str]:
    out: list[str] = []
    for d in domains:
        for p in (f"*://{d}/*", f"*://*.{d}/*"):
            if p not in out:
                out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail instead of rewriting when the manifest is out of date")
    args = ap.parse_args()

    domains = read_domains()
    if not domains:
        sys.exit("[whitelist] ERROR: the JS list is empty")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    want = patterns(domains)

    manifest["host_permissions"] = want
    for entry in manifest.get("content_scripts", []):
        entry["matches"] = want

    rendered = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    current = MANIFEST.read_text(encoding="utf-8")

    if args.check:
        if rendered != current:
            print("[whitelist] manifest.json is out of date — "
                  "run: python3 .github/scripts/sync_whitelist.py", file=sys.stderr)
            return 1
        print(f"[whitelist] manifest matches whitelist.js ({len(domains)} domains)")
        return 0

    if rendered != current:
        MANIFEST.write_text(rendered, encoding="utf-8")
        print(f"[whitelist] manifest.json updated — {len(domains)} domains, {len(want)} patterns")
    else:
        print(f"[whitelist] manifest.json already current — {len(domains)} domains")
    return 0


if __name__ == "__main__":
    sys.exit(main())
