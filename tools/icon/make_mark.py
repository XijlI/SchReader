"""Generate the SchReader mark from one outline.

    uv run --with pillow --with fonttools python tools/icon/make_mark.py

Writes `extension/icons/icon{16,32,48,128}.png` and the Android adaptive-icon layers
(`drawable/ic_launcher_foreground.xml`, `ic_launcher_monochrome.xml`) from the same glyph, so the
browser toolbar and the phone's launcher can never disagree again.

The letterform is Libre Caslon Text Bold (SIL Open Font License; see `OFL.txt` next to this file —
an OFL font may be used and embedded in a logo, only the font software itself cannot be sold).
`LibreCaslonText-Bold.ttf` is the wght=700 instance of the upstream variable font
(google/fonts -> ofl/librecaslontext), pinned so regeneration stays stable.

Geometry, in the 108 dp grid Android uses for adaptive icons:
  * the tile is full bleed and rounds its own corners at 24/108 for the PNGs (on the phone the
    launcher draws the mask, so the vector layer itself is square);
  * a launcher only shows the central 72 of those 108 dp, which is why `SAFE` is 58 * 72/108 —
    the same letter-to-tile ratio as the browser icons, instead of a letter that reads 34% bolder
    on the phone than in the toolbar.
"""
from __future__ import annotations

import pathlib

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
FONT = ROOT / "tools" / "icon" / "LibreCaslonText-Bold.ttf"
LETTER = "R"
INK, GOLD = (20, 19, 15), (247, 183, 5)
GRID = 108.0
CAP = 58.0                    # letter height on the 108 tile — the mark's one size constant
VISIBLE = 72.0                # adaptive icons: only the central 72 of 108 dp is ever shown
SAFE = CAP * VISIBLE / GRID   # 38.67 -> same share of the mask as the tile's letter, on the phone
SS = 8                        # supersample factor for the PNGs


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


def glyph_mask(target_px: int) -> Image.Image:
    """The gold letter as an RGBA image, its ink exactly `target_px` tall."""
    probe = ImageFont.truetype(str(FONT), 400)
    x0, y0, x1, y1 = probe.getbbox(LETTER)
    size = max(8, round(400 * target_px / (y1 - y0)))
    face = ImageFont.truetype(str(FONT), size)
    x0, y0, x1, y1 = (int(v) for v in face.getbbox(LETTER))   # PIL rounds the size to an int
    im = Image.new("RGBA", (x1 - x0 + 2, y1 - y0 + 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((-x0 + 1, -y0 + 1), LETTER, font=face, fill=GOLD + (255,))
    return im


def tile(px: int, cap_dp: float) -> Image.Image:
    """A browser icon: rounded ink tile with the letter centred, rendered at `px`."""
    big = px * SS
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * 24 / GRID), fill=INK + (255,))
    g = glyph_mask(round(cap_dp / GRID * big))
    im.alpha_composite(g, ((big - g.width) // 2, (big - g.height) // 2))
    return im.resize((px, px), Image.LANCZOS)


def write_vector(name: str, colour: str, note: str) -> None:
    body = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
            "<vector xmlns:android=\"http://schemas.android.com/apk/res/android\"\n"
            f"    android:width=\"{GRID:.0f}dp\"\n    android:height=\"{GRID:.0f}dp\"\n"
            f"    android:viewportWidth=\"{GRID:.0f}\"\n    android:viewportHeight=\"{GRID:.0f}\">\n"
            f"    <!-- {note} -->\n"
            "    <path\n"
            f"        android:fillColor=\"{colour}\"\n"
            f"        android:pathData=\"{letter_path(SAFE)}\" />\n"
            "</vector>\n")
    (ROOT / f"android/app/src/main/res/drawable/{name}.xml").write_text(body, encoding="utf-8")


def main() -> None:
    out = ROOT / "extension" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in (128, 48, 32, 16):
        # the tiny sizes get a slightly larger letter so it still reads in a toolbar
        tile(size, CAP if size >= 32 else 63).save(out / f"icon{size}.png")

    write_vector("ic_launcher_foreground", "#F7B705",
                 "gold serif R, generated from the same outline as the extension icons; drawn for "
                 "the central 72 of 108 dp a launcher actually shows")
    write_vector("ic_launcher_monochrome", "#FFFFFF",
                 "single-colour silhouette of the same R, for Android 13+ themed icons")
    print("icons written from", FONT.name)


if __name__ == "__main__":
    main()
