#!/usr/bin/env python3
"""Guard the invariants that no single file can enforce by itself.

AGENTS.md keeps three such invariants in prose; this script makes CI fail when one drifts:

1. **Themes.** `library.css` carries a verbatim copy of every `:root[data-theme=…]` block in
   `reader.css`, the theme list lives in `reader.js` (`THEMES`) *and* in `settings.js`
   (`LIGHT_THEMES` / `DARK_THEMES`). Adding a skin in one place and forgetting another leaves the
   library page falling back to light, or the picker unable to select the skin at all.
2. **Extractor order.** A new file must be listed in `manifest.json` → `content_scripts[0].js` **and**
   in `EXTRACTOR_ORDER` in `android/tools/mirror.py`, in the same order, or one host silently runs
   without it.
3. **Mirrored files.** Every page file `mirror.py` copies must exist in `extension/`, and every file
   the manifest loads must exist on disk.

Run it from anywhere:  python3 .github/scripts/check_consistency.py
Exit code 1 on the first run that finds a problem; all problems are printed, not just the first.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent            # .github/scripts
REPO = HERE.parent.parent                         # repo root
EXT = REPO / "extension"

# "light" is the :root default (no theme block) and "custom" is user-defined, so neither has a
# `[data-theme]` block of its own.
NO_CSS_BLOCK = {"light", "custom"}

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:                        # a renamed/moved file is itself a finding
        fail(f"{path.relative_to(REPO)}: cannot read ({exc})")
        return ""


def css_themes(path: Path) -> set[str]:
    return set(re.findall(r'\[data-theme\s*=\s*["\']?([A-Za-z0-9_-]+)["\']?\]', read(path)))


def js_list(path: Path, name: str) -> list[str]:
    """Pull the string literals out of a `NAME = [ … ];` array (JS `const`, or Python)."""
    src = read(path).replace("\r\n", "\n")
    m = re.search(rf"(?:const\s+)?{name}\s*=\s*\[(.*?)\](?:\s*;)?", src, re.S)
    if not m:
        fail(f"{path.relative_to(REPO)}: `{name} = [ … ]` not found")
        return []
    return re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))


def check_themes() -> None:
    reader_css = css_themes(EXT / "reader.css")
    library_css = css_themes(EXT / "library.css")

    only_reader = sorted(reader_css - library_css)
    only_library = sorted(library_css - reader_css)
    if only_reader:
        fail(f"library.css is missing theme blocks for: {', '.join(only_reader)}"
             "  (copy each :root[data-theme=…] block from reader.css verbatim)")
    if only_library:
        fail(f"library.css has theme blocks reader.css does not: {', '.join(only_library)}")

    themes = js_list(EXT / "reader.js", "THEMES")
    if not themes:
        return
    picker = js_list(EXT / "settings.js", "LIGHT_THEMES") + js_list(EXT / "settings.js", "DARK_THEMES")

    dupes = sorted({t for t in picker if picker.count(t) > 1})
    if dupes:
        fail(f"settings.js lists a theme twice: {', '.join(dupes)}")

    if set(picker) != set(themes) - {"custom"}:
        missing = sorted(set(themes) - {"custom"} - set(picker))
        extra = sorted(set(picker) - set(themes))
        if missing:
            fail(f"settings.js picker is missing: {', '.join(missing)}")
        if extra:
            fail(f"settings.js picker offers themes reader.js does not know: {', '.join(extra)}")

    if reader_css != set(themes) - NO_CSS_BLOCK:
        missing = sorted(set(themes) - NO_CSS_BLOCK - reader_css)
        extra = sorted(reader_css - set(themes))
        if missing:
            fail(f"reader.css has no theme block for: {', '.join(missing)}")
        if extra:
            fail(f"reader.css defines a theme absent from THEMES: {', '.join(extra)}")

    print(f"themes: {len(themes)} in reader.js ({len(reader_css)} css blocks,"
          f" {len(library_css)} mirrored), {len(picker)} in the picker")


def check_extractor_order(manifest: dict) -> None:
    scripts = manifest["content_scripts"][0]["js"]
    in_manifest = [p for p in scripts if p.startswith("src/extractor/")]
    order = js_list(REPO / "android/tools/mirror.py", "EXTRACTOR_ORDER")
    if not order:
        return

    names_manifest = [Path(p).name for p in in_manifest]
    if names_manifest != order:
        fail("manifest.json content_scripts[0].js and EXTRACTOR_ORDER in android/tools/mirror.py "
             "disagree.\n    manifest: " + ", ".join(names_manifest) + "\n    mirror:   " + ", ".join(order))

    on_disk = sorted(p.name for p in (EXT / "src" / "extractor").glob("*.js"))
    if on_disk != sorted(names_manifest):
        unknown = sorted(set(on_disk) - set(names_manifest))
        missing = sorted(set(names_manifest) - set(on_disk))
        if unknown:
            fail("extractor file(s) on disk but not loaded by the manifest: " + ", ".join(unknown))
        if missing:
            fail("manifest loads extractor file(s) that do not exist: " + ", ".join(missing))

    for path in scripts:
        if not (EXT / path).exists():
            fail(f"manifest.json loads a missing file: extension/{path}")

    print(f"extractor: {len(order)} files, manifest order matches mirror.py")


def check_mirrored(manifest: dict) -> None:
    src = read(REPO / "android/tools/mirror.py").replace("\r\n", "\n")
    m = re.search(r"for name in \((.*?)\):", src, re.S)
    if not m:
        fail("android/tools/mirror.py: the page-copy `for name in ( … ):` list was not found")
        return
    copies = re.findall(r'"([^"]+)"', m.group(1))

    missing = [n for n in copies if not (EXT / n).exists()]
    for name in missing:
        fail(f"mirror.py copies extension/{name}, which does not exist")

    # anything the reader/library pages load by <script>/<link> must be in the copy list, or the
    # phone gets a page whose script 404s (Silent, because the page still renders).
    for page in ("reader.html", "library.html", "search.html", "settings.html"):
        html = read(EXT / page)
        for ref in re.findall(r'(?:src|href)="([^"?#]+\.(?:js|css))"', html):
            if ref.startswith(("src/", "fonts/", "http")) or ref.startswith("//"):
                continue
            if ref not in copies:
                fail(f"mirror.py does not copy extension/{ref} (loaded by {page})")

    print(f"mirrored: {len(copies)} page files listed, all present")


def main() -> int:
    manifest_path = EXT / "manifest.json"
    try:
        manifest = json.loads(read(manifest_path))
    except json.JSONDecodeError as exc:
        print(f"[consistency] manifest.json is not valid JSON: {exc}", file=sys.stderr)
        return 1

    check_themes()
    check_extractor_order(manifest)
    check_mirrored(manifest)

    if problems:
        print("\n[consistency] " + f"{len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print("  ✗ " + p, file=sys.stderr)
        return 1
    print("[consistency] all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
