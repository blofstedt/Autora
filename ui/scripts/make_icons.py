#!/usr/bin/env python3
"""Render the home-screen icons from the mark the app actually uses.

The icons have been through two older marks: a circle inside a circle, and the
four-point spark -- which read as somebody else's logo. The app now signs its
name with one equilateral triangle, rounded at the corners, so the icons are
that same triangle.

Committed as a script rather than four opaque PNGs because the answer to "what
is this and how do I change it" should be readable. The geometry below is the
same shape as `trianglePath` in src/lib/mark.ts -- apex up, corners filleted by
walking a sampled arc rather than by writing an SVG `A` command, which is what
lets the app morph it -- and the gradient is `--accent`, `--accent-2` and
`--glow` from theme.ts.

    python3 ui/scripts/make_icons.py

It also writes the two vector copies: public/icons/favicon.svg, which
index.html points at, and blofstedt-autora/icon.svg, the Umbrel store tile.

Rendered at 4x and downsampled rather than drawn at final size: Pillow's
polygon fill has no anti-aliasing, and a triangle with stair-stepped edges at
192px looks worse than a circle did.
"""

from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

OUT = pathlib.Path(__file__).resolve().parents[2] / "public" / "icons"
TILE = pathlib.Path(__file__).resolve().parents[2] / "blofstedt-autora" / "icon.svg"

#: The mark as src/lib/mark.ts draws it on the 32-unit grid the icon set uses.
#: `cy` is the middle of the box; the mark is drawn half a fillet above it by
#: `mark_at`, because that is where what you see lands in the middle.
MARK = {"box": 32, "cx": 16.0, "cy": 16.0, "R": 9.375, "fillet": 1.5}

#: The art the mark was designed at: a 512px master, r=24 fillets. Icons scale
#: from this rather than from the 32 grid, so the proportions are the
#: designer's.
ART = {"box": 512, "R": 150.0, "fillet": 24.0}

#: --accent, --accent-2 and --glow. Three stops rather than two: the mark in
#: the app is four soft colour fields, and a two-colour ramp of it reads flat.
VIOLET = (0x6E, 0x5B, 0xFF)
CYAN = (0x22, 0xD3, 0xEE)
MAGENTA = (0xC0, 0x6B, 0xFF)

#: The plate behind the mark. The app's own background, so a home screen shows
#: the same black the app opens on.
BACKDROP = (0x0B, 0x0A, 0x14)

#: Supersampling factor. 4x is the point where the edges stop being visible.
SS = 4

#: Points per fillet. Finer than the app needs -- nothing is interpolating
#: these -- so the corners are smooth even on the 512px icon.
STEPS = 24


def triangle(cx: float, cy: float, R: float, fillet: float, steps: int = STEPS):
    """One triangle: apex up, corners rounded, bounding box centred on (cx, cy).

    The same construction as `trianglePath` in src/lib/mark.ts: the fillet of a
    corner meets its two edges `fillet*sqrt(3)` along them, its centre sits
    `2*fillet` down the corner's bisector, and the arc between the two tangent
    points is sampled. `cy` is the middle of the shape you can see, not the
    circumcentre -- which a triangle puts a quarter of its height lower.
    """
    centre = (0.0, R / 4)                       # apex at -3R/4, base at +R/2
    vertices = [
        (
            centre[0] + R * math.cos(-math.pi / 2 + i * 2 * math.pi / 3),
            centre[1] + R * math.sin(-math.pi / 2 + i * 2 * math.pi / 3),
        )
        for i in range(3)
    ]

    inset = fillet * math.sqrt(3)

    def toward(v, w):
        length = math.hypot(w[0] - v[0], w[1] - v[1])
        return (v[0] + (w[0] - v[0]) / length * inset, v[1] + (w[1] - v[1]) / length * inset)

    points: list[tuple[float, float]] = []
    for i, v in enumerate(vertices):
        prev, nxt = vertices[(i + 2) % 3], vertices[(i + 1) % 3]
        start, end = toward(v, prev), toward(v, nxt)
        bisector = (prev[0] - v[0] + (nxt[0] - v[0]), prev[1] - v[1] + (nxt[1] - v[1]))
        blen = math.hypot(*bisector)
        arc = (v[0] + bisector[0] / blen * 2 * fillet, v[1] + bisector[1] / blen * 2 * fillet)
        a0 = math.atan2(start[1] - arc[1], start[0] - arc[0])
        a1 = math.atan2(end[1] - arc[1], end[0] - arc[0])
        sweep = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(steps):
            a = a0 + sweep * k / (steps - 1)
            points.append((cx + arc[0] + fillet * math.cos(a), cy + arc[1] + fillet * math.sin(a)))
    return points


def mark_at(span: float, size: float, lift: float = 0.0, steps: int = STEPS):
    """The mark's outline on a `size` box, its width `span` of that box.

    The mark is placed half a fillet above the middle of the box, because what
    you see of a rounded triangle is half a fillet *below* the ideal triangle's
    own box: a fillet takes a whole radius off the apex, where the corner's
    bisector is vertical, and nothing off the base, where the arc is tangent to
    it. Centring the ideal triangle instead leaves the mark sitting low -- which
    is what these icons were doing, 0.75 of the 32 units the app draws on, 2.3%
    of the height. `visible_centre` below is the check.
    """
    scale = span * size / (ART["R"] * math.sqrt(3))
    fillet = ART["fillet"] * scale
    cy = size / 2 - fillet / 2 + lift * size
    return triangle(size / 2, cy, ART["R"] * scale, fillet, steps)


def visible_centre(span: float, size: float, steps: int = STEPS):
    """The middle of the mark you can actually see, on its own `size` box."""
    points = mark_at(span, size, steps=steps)
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def gradient(big: int, box: tuple[float, float, float, float]) -> Image.Image:
    """The brand ramp, top-left to bottom-right, through all three stops.

    Painted across `box` -- the mark's own bounding box -- rather than across
    the plate: a ramp that runs the whole 512px icon spends its middle on empty
    background and hands the mark a slice of one colour, so the triangle comes
    out flat cyan. Across the mark itself it is violet at the top corner, cyan
    down the middle, magenta at the base.
    """
    image = Image.new("RGB", (big, big))
    pixels = image.load()
    stops = [VIOLET, CYAN, MAGENTA]
    x0, y0, x1, y1 = box
    for y in range(big):
        for x in range(big):
            t = ((x - x0) / max(x1 - x0, 1) + (y - y0) / max(y1 - y0, 1)) / 2
            t = min(max(t, 0.0), 1.0)
            pos = t * (len(stops) - 1)
            i = min(int(pos), len(stops) - 2)
            f = pos - i
            pixels[x, y] = tuple(round(a + (b - a) * f) for a, b in zip(stops[i], stops[i + 1]))
    return image


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    return mask


def icon(size: int, *, corner: float, span: float, transparent: bool) -> Image.Image:
    """One icon.

    `corner` is the corner radius as a fraction of the width, `span` how much
    of the width the mark's widest side takes. `transparent` rounds the image
    itself off; without it the background bleeds to the edges, which is what a
    platform that applies its own mask needs.
    """
    big = size * SS
    points = mark_at(span, big)
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    art = gradient(big, (min(xs), min(ys), max(xs), max(ys)))

    # A soft bloom of the same shape underneath, so the mark sits in its plate
    # rather than being stuck onto it -- the app paints the same glow behind
    # its own header mark.
    glow = Image.new("L", (big, big), 0)
    ImageDraw.Draw(glow).polygon(points, fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(big * 0.06))

    plate = Image.new("RGBA", (big, big), BACKDROP + (255,))
    plate.paste(Image.new("RGBA", (big, big), VIOLET + (255,)), (0, 0), glow)

    shape = Image.new("L", (big, big), 0)
    ImageDraw.Draw(shape).polygon(points, fill=255)
    plate.paste(art.convert("RGBA"), (0, 0), shape)

    if transparent:
        plate.putalpha(rounded_mask(big, corner * big))

    return plate.resize((size, size), Image.LANCZOS)


def svg(size: int = 32) -> str:
    """The mark as vector, on the 32-unit grid, for the favicon and the tile."""
    points = mark_at(
        MARK["R"] * math.sqrt(3) / MARK["box"], MARK["box"], steps=16
    )
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    outline = " ".join(f"{x:.3f},{y:.3f}" for x, y in points)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="{size}" height="{size}">
  <defs>
    <linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="{min(xs):.2f}" y1="{min(ys):.2f}" x2="{max(xs):.2f}" y2="{max(ys):.2f}">
      <stop offset="0%" stop-color="#6e5bff"/>
      <stop offset="50%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#c06bff"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="52%">
      <stop offset="0%" stop-color="#6e5bff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#6e5bff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="plate"><rect width="32" height="32" rx="7.5"/></clipPath>
  </defs>
  <g clip-path="url(#plate)">
    <rect width="32" height="32" fill="#0b0a14"/>
    <rect width="32" height="32" fill="url(#glow)"/>
    <polygon points="{outline}" fill="url(#brand)"/>
  </g>
</svg>
"""


#: (size, span) of every icon that gets drawn, for the centring check.
SHAPES = ((192, 0.52), (512, 0.52), (512, 0.40), (180, 0.52))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # Centred on the mark you can see, not on the ideal triangle it is built
    # from. Asserted rather than assumed: an icon that sits low is exactly the
    # thing nobody notices until they look at the tile, which is how this got
    # here.
    for size, span in SHAPES:
        x, y = visible_centre(span, size)
        print(
            f"  centre  {size}px span {span}: x {x:.2f} y {y:.2f}"
            f" (off centre {y - size / 2:+.3f})"
        )
        assert abs(x - size / 2) < size * 0.005, f"{size}px {span}: off centre in x"
        assert abs(y - size / 2) < size * 0.005, f"{size}px {span}: sitting low"

    # `purpose: any`. Nothing masks these, so they carry their own corners.
    for size in (192, 512):
        icon(size, corner=0.22, span=0.52, transparent=True).save(
            OUT / f"icon-{size}.png"
        )

    # `purpose: maskable`. Android crops to a shape of its choosing, so the
    # background has to reach the edges and the mark has to stay well inside
    # the safe zone -- the middle 80% -- or the platform clips its corners off.
    icon(512, corner=0, span=0.40, transparent=False).save(
        OUT / "icon-maskable-512.png"
    )

    # iOS rounds this itself and composites it onto white, so: no alpha, no
    # corners of our own.
    icon(180, corner=0, span=0.52, transparent=False).save(
        OUT / "apple-touch-icon.png"
    )

    favicon = svg()
    (OUT / "favicon.svg").write_text(favicon)
    TILE.write_text(favicon)

    for path in sorted(OUT.iterdir()):
        if path.suffix == ".png":
            with Image.open(path) as rendered:
                print(f"  {path.name:<28} {rendered.size[0]}x{rendered.size[1]} {rendered.mode}")
        else:
            print(f"  {path.name:<28} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
