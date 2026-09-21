#!/usr/bin/env python3
"""Render the home-screen icons from the mark the app actually uses.

The icons used to be a circle inside a circle -- an older mark that nothing in
the running app had drawn for a long time. The header, the Umbrel store tile
and the favicon had all moved to the four-point spark, so a phone that
installed Autora got a shape found nowhere in it, and the one place the icon is
seen at full size was the one place it was wrong.

Committed as a script rather than four opaque PNGs because the answer to "what
is this and how do I change it" should be readable. The geometry below is the
same polygon as `IconSpark` in src/components/Icons.tsx, and the gradient is
`--accent` to `--accent-2` from styles.css, which is what `.brand-mark` paints
behind the spark in the header.

    python3 ui/scripts/make_icons.py

Rendered at 4x and downsampled rather than drawn at final size: Pillow's
polygon fill has no anti-aliasing, and a star with stair-stepped edges at 192px
looks worse than the ball did.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parents[1] / "public" / "icons"

#: --accent to --accent-2, along the top-left/bottom-right diagonal, which is
#: what both `.brand-mark` and the inline favicon use.
START = (0x6E, 0x5B, 0xFF)
END = (0x22, 0xD3, 0xEE)

#: `IconSpark`'s path, as its eight corners in its own 24x24 box. Its bounding
#: box is 14 wide and 14 tall centred on (12, 10.5) -- not on the box's middle,
#: which is why it is re-centred below rather than used as-is.
SPARK = [
    (12, 3.5), (13.9, 8.6), (19, 10.5), (13.9, 12.4),
    (12, 17.5), (10.1, 12.4), (5, 10.5), (10.1, 8.6),
]

#: Supersampling factor. 4x is the point where the edges stop being visible.
SS = 4


def unit_spark() -> list[tuple[float, float]]:
    """The spark centred on the origin, its longest axis spanning 1.0."""
    xs = [p[0] for p in SPARK]
    ys = [p[1] for p in SPARK]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    return [((x - cx) / span, (y - cy) / span) for x, y in SPARK]


def gradient(size: int) -> Image.Image:
    """The brand gradient, corner to corner."""
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            # Distance along the diagonal, 0 at the top-left, 1 at bottom-right.
            t = (x + y) / (2 * (size - 1)) if size > 1 else 0.0
            pixels[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(START, END)
            )
    return image


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    return mask


def icon(size: int, *, corner: float, spark: float, transparent: bool) -> Image.Image:
    """One icon.

    `corner` is the corner radius as a fraction of the width, `spark` how much
    of the width the mark spans. `transparent` rounds the image itself off;
    without it the background bleeds to the edges, which is what a platform
    that applies its own mask needs.
    """
    big = size * SS
    art = gradient(big)

    points = [
        (big / 2 + x * spark * big, big / 2 + y * spark * big)
        for x, y in unit_spark()
    ]
    ImageDraw.Draw(art).polygon(points, fill=(255, 255, 255))

    if transparent:
        art = art.convert("RGBA")
        art.putalpha(rounded_mask(big, corner * big))

    return art.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # `purpose: any`. Nothing masks these, so they carry their own corners.
    for size in (192, 512):
        icon(size, corner=0.22, spark=0.54, transparent=True).save(
            OUT / f"icon-{size}.png"
        )

    # `purpose: maskable`. Android crops to a shape of its choosing, so the
    # background has to reach the edges and the mark has to stay well inside
    # the safe zone -- the middle 80% -- or the platform clips its points off.
    icon(512, corner=0, spark=0.40, transparent=False).save(
        OUT / "icon-maskable-512.png"
    )

    # iOS rounds this itself and composites it onto white, so: no alpha, no
    # corners of our own.
    icon(180, corner=0, spark=0.54, transparent=False).save(
        OUT / "apple-touch-icon.png"
    )

    for path in sorted(OUT.iterdir()):
        with Image.open(path) as rendered:
            print(f"  {path.name:<28} {rendered.size[0]}x{rendered.size[1]} {rendered.mode}")


if __name__ == "__main__":
    main()
