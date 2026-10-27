"""Generate the SchReader mark from one outline.

    uv run --with pillow --with svglib --with reportlab --with rlPyCairo --with fonttools \
        python tools/icon/make_mark.py

Writes `extension/icons/icon{16,32,48,128}.png` and
`android/app/src/main/res/drawable/ic_launcher_foreground.xml` from the same path data, so the
browser toolbar and the phone's launcher can never disagree again.

The letterform is Literata Bold (SIL Open Font License, so embedding its outline is unambiguous),
pulled from the glyph itself rather than redrawn by hand.
"""
from __future__ import annotations

import io
import pathlib

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image
from reportlab.graphics import renderPM
from svglib.svglib import svg2rlg

ROOT = pathlib.Path(__file__).resolve().parents[2]
FONT = ROOT / "tools" / "icon" / "Literata-Bold.ttf"
LETTER = "R"
INK, GOLD = "#14130f", "#f7b705"
GRID = 108.0
SAFE = 52.0          # adaptive icons: keep the art inside the central 66/108 safe zone


def letter_path(target_h: float, cx: float = GRID / 2, cy: float = GRID / 2) -> str:
    face = TTFont(FONT)
    glyphs = face.getGlyphSet()
    name = face.getBestCmap()[ord(LETTER)]

    bounds = BoundsPen(glyphs)
    glyphs[name].draw(bounds)
    assert bounds.bounds is not None, f"{LETTER} has no outline in {FONT.name}"
    x0, y0, x1, y1 = bounds.bounds

    scale = target_h / (y1 - y0)
    dx = cx - scale * (x0 + x1) / 2
    dy = cy + scale * (y0 + y1) / 2          # font y-up -> svg y-down
    pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}")
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, dx, dy)))
    return pen.getCommands()


def tile_svg(size: int, letter_h: float) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">'
            f'<rect width="108" height="108" rx="24" fill="{INK}"/>'
            f'<path fill="{GOLD}" d="{letter_path(letter_h)}"/></svg>')


def raster(svg: str, px: int, ss: int = 8) -> Image.Image:
    """Supersample then Lanczos down: at 16 px a single-pass render loses the serifs."""
    drawing = svg2rlg(io.BytesIO(svg.encode()))
    big = px * ss
    scale = big / GRID
    drawing.width, drawing.height = GRID * scale, GRID * scale
    drawing.scale(scale, scale)
    buf = io.BytesIO()
    renderPM.drawToFile(drawing, buf, fmt="PNG", bg=0xFFFFFF)
    buf.seek(0)
    im = Image.open(buf).convert("RGBA")
    px_map = im.load()
    for y in range(im.height):                      # rounded corners back to transparent
        for x in range(im.width):
            r, g, b, _ = px_map[x, y]
            if (r, g, b) == (255, 255, 255):
                px_map[x, y] = (255, 255, 255, 0)
    return im.resize((px, px), Image.LANCZOS)


def main() -> None:
    out = ROOT / "extension" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in (128, 48, 32, 16):
        # the tiny sizes get a slightly larger letter so it still reads in a toolbar
        raster(tile_svg(size, letter_h=58 if size >= 32 else 63), size).save(out / f"icon{size}.png")

    fg = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
          "<vector xmlns:android=\"http://schemas.android.com/apk/res/android\"\n"
          f"    android:width=\"{GRID:.0f}dp\"\n    android:height=\"{GRID:.0f}dp\"\n"
          f"    android:viewportWidth=\"{GRID:.0f}\"\n    android:viewportHeight=\"{GRID:.0f}\">\n"
          "    <!-- gold serif R, generated from the same outline as the extension icons -->\n"
          "    <path\n        android:fillColor=\"#F7B705\"\n"
          f"        android:pathData=\"{letter_path(SAFE)}\" />\n</vector>\n")
    (ROOT / "android/app/src/main/res/drawable/ic_launcher_foreground.xml").write_text(fg, encoding="utf-8")
    print("icons written from", FONT.name)


if __name__ == "__main__":
    main()
