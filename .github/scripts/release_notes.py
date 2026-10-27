#!/usr/bin/env python3
"""Build the body of a GitHub release: English first, a collapsible 中文 section last.

    python3 .github/scripts/release_notes.py --version 0.2.0 --tag v0.2.0 \
        --signed true --out notes.md

The English part is generated from `git log` since the previous `v*` tag, grouped
by conventional-commit type. Curated text always wins when it exists:

    docs/release-notes/v0.2.0.md         replaces the generated English body
    docs/release-notes/v0.2.0.zh-CN.md   replaces the generated 中文 section

`docs/release-notes.md` is appended as a manual "Notes" block when present.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NOTES_DIR = ROOT / "docs" / "release-notes"

GROUPS = [
    ("feat", "Features", "新功能"),
    ("fix", "Fixes", "修复"),
    ("perf", "Performance", "性能"),
    ("refactor", "Refactoring", "重构"),
    ("docs", "Documentation", "文档"),
    ("build", "Build & packaging", "构建与打包"),
    ("ci", "CI", "CI"),
    ("test", "Tests", "测试"),
    ("chore", "Chores", "杂项"),
]
OTHER = ("other", "Other changes", "其他改动")
GROUP_LABEL = {key: (en, zh) for key, en, zh in GROUPS}
GROUP_LABEL[OTHER[0]] = (OTHER[1], OTHER[2])

CONVENTIONAL = re.compile(
    r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?(?P<breaking>!)?:\s*(?P<subject>.+)$"
)
MAX_PER_GROUP = 25
MAX_TOTAL = 60


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    ).stdout.strip()


def previous_tag(tag: str) -> str | None:
    for rev in (f"{tag}^", "HEAD^"):
        try:
            out = git("describe", "--tags", "--abbrev=0", "--match", "v*", rev)
            if out and out != tag:
                return out
        except subprocess.CalledProcessError:
            continue
    return None


def collect_commits(tag: str) -> tuple[list[dict], str | None]:
    prev = previous_tag(tag)
    rng = f"{prev}..HEAD" if prev else "HEAD"
    raw = git("log", "--no-merges", "--pretty=%s", "-n", "200", rng) if prev else \
        git("log", "--no-merges", "--pretty=%s", "-n", "200", "HEAD")
    commits = []
    for subject in [line for line in raw.splitlines() if line.strip()]:
        if re.match(r"^(chore|ci)(\(.+\))?!?:\s*(release|bump)", subject, re.I):
            continue  # version-bump noise
        m = CONVENTIONAL.match(subject)
        if m:
            kind = m.group("type").lower()
            kind = kind if kind in GROUP_LABEL else "other"
            scope = m.group("scope")
            text = m.group("subject").strip()
            commits.append({
                "kind": kind,
                "scope": scope.strip() if scope else "",
                "text": text,
                "breaking": bool(m.group("breaking")),
            })
        else:
            commits.append({"kind": "other", "scope": "", "text": subject.strip(), "breaking": False})
    return commits, prev


def bullet(commit: dict) -> str:
    scope = f"**{commit['scope']}:** " if commit["scope"] else ""
    flag = " **(breaking)**" if commit["breaking"] else ""
    return f"- {scope}{commit['text']}{flag}"


def group_commits(commits: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in commits[:MAX_TOTAL]:
        out.setdefault(c["kind"], []).append(c)
    return out


def curated(version: str, lang: str) -> str | None:
    suffix = ".zh-CN.md" if lang == "zh" else ".md"
    path = NOTES_DIR / f"v{version}{suffix}"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return None


def download_table(version: str, signed: bool, zh: bool) -> str:
    apk = f"schreader-android-v{version}.apk"
    ext = f"schreader-chrome-v{version}.zip"
    if zh:
        return "\n".join([
            "| 文件 | 是什么 |",
            "|---|---|",
            f"| `{apk}` | 安卓 App，Android 8.0+（minSdk 26）。传到手机点开安装即"
            f"{'可（已用项目签名密钥签名，能覆盖安装旧版本）。' if signed else '可（本次为 CI 调试签名，装前请先卸载旧版）。'} |",
            f"| `{ext}` | Chrome / Edge 扩展（Manifest V3）。解压后打开 `chrome://extensions`，"
            "开开发者模式，点「加载已解压的扩展程序」，选中解压出来的文件夹。 |",
            "| `SHA256SUMS.txt` | 上面两个文件的 SHA-256 校验值。 |",
        ])
    return "\n".join([
        "| File | What it is |",
        "|---|---|",
        f"| `{apk}` | Android app, Android 8.0+ (minSdk 26). Copy it to the phone and tap to install"
        f"{' — signed with the project release key, so it installs over an older version.' if signed else ' — this build carries the CI debug signature, uninstall the previous copy first.'} |",
        f"| `{ext}` | Chrome / Edge extension (Manifest V3). Unzip, open `chrome://extensions`, "
        "turn on Developer mode, click \"Load unpacked\" and pick the unzipped folder. |",
        "| `SHA256SUMS.txt` | SHA-256 checksums for both files. |",
    ])


def english_body(version: str, tag: str, signed: bool, commits: list[dict],
                 prev: str | None) -> str:
    manual = curated(version, "en")
    if manual:
        return manual

    grouped = group_commits(commits)
    lines = [
        "English notes below. A collapsible 中文说明 sits at the end of this page.",
        "",
        f"Tag `{tag}` — one source of truth in `extension/`, mirrored into the Android app at build time.",
        "",
        "## Downloads",
        "",
        download_table(version, signed, zh=False),
        "",
        "> The extension and the app ship the same reader page and extractor; they differ only in how "
        "they get the page HTML.",
        "",
        "## What changed",
        "",
    ]
    if not commits:
        lines.append("_No commit messages on this branch range._")
    else:
        breaking = [c for c in commits if c["breaking"]]
        if breaking:
            lines += ["### ⚠️ Breaking changes", ""]
            lines += [bullet(c) for c in breaking[:MAX_PER_GROUP]]
            lines.append("")
        for key, (label_en, _) in GROUP_LABEL.items():
            items = grouped.get(key)
            if not items:
                continue
            lines += [f"### {label_en}", ""]
            lines += [bullet(c) for c in items[:MAX_PER_GROUP]]
            if len(items) > MAX_PER_GROUP:
                lines.append(f"- …and {len(items) - MAX_PER_GROUP} more")
            lines.append("")

    repo = ""
    try:
        repo = git("config", "--get", "remote.origin.url")
    except subprocess.CalledProcessError:
        pass
    slug = re.search(r"github\.com[:/](?P<slug>[^/]+/[^/.]+)", repo)
    if slug and prev:
        lines.append(
            f"**Full changelog:** [`{prev}…{tag}`](https://github.com/{slug.group('slug')}"
            f"/compare/{prev}...{tag})"
        )
    elif slug:
        lines.append(f"**Repository:** https://github.com/{slug.group('slug')}")
    lines.append("")
    return "\n".join(lines)


def chinese_section(version: str, signed: bool, commits: list[dict]) -> str:
    manual = curated(version, "zh")
    inner = manual if manual else ""
    if not inner:
        grouped = group_commits(commits)
        counts = "、".join(
            f"{GROUP_LABEL[key][1]} {len(grouped[key])} 项"
            for key, _, _ in GROUPS + [OTHER] if key in grouped
        ) or "无改动记录"
        inner_lines = [
            f"本次共 {len(commits[:MAX_TOTAL])} 项改动：{counts}。",
            "",
            "条目保留提交原文（英文），右侧英文说明里有完整描述。",
            "",
            "## 下载",
            "",
            download_table(version, signed, zh=True),
            "",
            "## 改动列表",
            "",
        ]
        for key, (_, label_zh) in GROUP_LABEL.items():
            items = grouped.get(key)
            if not items:
                continue
            inner_lines += [f"### {label_zh}", ""]
            inner_lines += [bullet(c) for c in items[:MAX_PER_GROUP]]
            inner_lines.append("")
        inner = "\n".join(inner_lines)

    return "\n".join([
        "<a id=\"chinese\"></a>",
        "<details>",
        "<summary>中文说明（点开）</summary>",
        "",
        inner.strip(),
        "",
        "</details>",
        "",
    ])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--signed", default="true", choices=["true", "false"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tag = args.tag or f"v{args.version}"
    signed = args.signed == "true"
    commits, prev = collect_commits(tag)

    parts = [english_body(args.version, tag, signed, commits, prev)]
    if not signed:
        parts.insert(1, "\n> ⚠️ **This APK is debug-signed** because the signing secrets are not "
                        "configured. Uninstall the previous version before installing this one.\n")
    parts.append(chinese_section(args.version, signed, commits))

    notes = "\n".join(parts).rstrip() + "\n"
    Path(args.out).write_text(notes, encoding="utf-8")
    print(f"[notes] wrote {args.out} ({len(notes):,} bytes, {len(commits)} commits, "
          f"previous tag: {prev or 'none'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
