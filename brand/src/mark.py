# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "numpy", "resvg-py"]
# ///
"""Draws the Phosphor mark from geometry and renders every raster that carries it.

The mark is the letter P, drawn in the left face of an isometric box and extruded
along the box's depth axis (30 degrees down and to the right), then sliced into
four slabs with a gap between each pair. The three back slabs show only the strip
of their top and left faces that the slab in front leaves uncovered, so each one
is an L that bends around the P's rounded top left corner. Every edge is vertical
or on a 30 degree line, every rounded corner is a circular arc in the picture
plane, and the gaps are translations of the same outline along the depth axis,
which is why they widen a little around the bends: that is what a real cut looks
like from this angle.

    uv run src/mark.py            writes ../phosphor-mark.svg and every PNG
    uv run src/mark.py --svg      writes only the SVG

Run from brand/ or from brand/src; paths resolve from this file.
"""
import io, math, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
import resvg_py

C, S = math.cos(math.radians(30)), 0.5

# The P, in the units of its own face: 640 square, stroke about 190.
PW = PH = 640
STEM, TOP, BOT, RIGHT = 190, 185, 185, 150   # stroke of the stem, top bar, bowl bottom, bowl side
LEG = 140                                    # height of the stem below the bowl
R = 178                                      # the fillet on the P's obtuse corners, in the picture plane
R_HOLE = 110                                 # the fillet on the counter's obtuse corners
R_CROWN = 220                                # the back slab's shoulder, the highest point of the mark
BAND_H = 156                                 # a back slab's visible strip, measured horizontally
GAP_H = 54                                   # a cut, measured horizontally
BAND_X, GAP_X = BAND_H / C, GAP_H / C        # the same two along the depth axis

INK = {"white-on-black": ("#0E0F13", "#ECEEF1"), "green-on-black": ("#0E0F13", "#3FFF6C"),
       "black-on-green": ("#3FFF6C", "#0E0F13"), "black-on-white": ("#FFFFFF", "#111111")}
MARK_SHARE = 0.6475      # the mark's height as a share of a square logo canvas, as the kit has always had it

def face(a, b):          # a point on the P's face to the picture plane; the face's x axis runs up and right
    return (a * C, -a * S - b)

def depth(x):            # a step along the depth axis, down and right
    return (x * C, x * S)

def add(p, q):
    return (p[0] + q[0], p[1] + q[1])

def outline(pts):
    """Polygon [(point, fillet radius)] to SVG path data with circular fillets at the rounded vertices."""
    n = len(pts); out = []; tang = []
    for i, (p, r) in enumerate(pts):
        p0, p1 = pts[i - 1][0], pts[(i + 1) % n][0]
        d1 = (p[0] - p0[0], p[1] - p0[1]); l1 = math.hypot(*d1); d1 = (d1[0] / l1, d1[1] / l1)
        d2 = (p1[0] - p[0], p1[1] - p[1]); l2 = math.hypot(*d2); d2 = (d2[0] / l2, d2[1] / l2)
        phi = math.acos(max(-1, min(1, d1[0] * d2[0] + d1[1] * d2[1])))
        tang.append((r * math.tan(phi / 2) if r else 0, l2, d1, d2))
    for i, (t, l2, _, _) in enumerate(tang):
        assert t + tang[(i + 1) % n][0] <= l2 + 1e-6, f"fillets overlap on the edge after {pts[i][0]}"
    for i, (p, r) in enumerate(pts):
        t, _, d1, d2 = tang[i]
        if not r:
            out.append(("L", p)); continue
        sweep = 1 if d1[0] * d2[1] - d1[1] * d2[0] > 0 else 0
        out.append(("L", (p[0] - d1[0] * t, p[1] - d1[1] * t)))
        out.append(("A", r, sweep, (p[0] + d2[0] * t, p[1] + d2[1] * t)))
    d = []
    for k, seg in enumerate(out):
        if seg[0] == "L":
            d.append(("M" if k == 0 else "L") + f"{seg[1][0]:.2f} {seg[1][1]:.2f}")
        else:
            d.append(f"A{seg[1]} {seg[1]} 0 0 {seg[2]} {seg[3][0]:.2f} {seg[3][1]:.2f}")
    return " ".join(d) + " Z"

def pieces():
    front = [(face(0, 0), 0), (face(0, PH), R), (face(PW, PH), 0), (face(PW, LEG), R), (face(STEM, LEG), 0), (face(STEM, 0), 0)]
    hole = [(face(STEM, LEG + BOT), 0), (face(PW - RIGHT, LEG + BOT), R_HOLE), (face(PW - RIGHT, PH - TOP), 0), (face(STEM, PH - TOP), R_HOLE)]
    bands = []
    x = 0.0
    for k in (3, 2, 1):
        xf = x - GAP_X; xb = x = xf - BAND_X
        b, f = depth(xb), depth(xf)
        bands.append([(add(face(0, 0), b), 0), (add(face(0, PH), b), R), (add(face(PW, PH), b), R_CROWN if k == 1 else 0),
                      (add(face(PW, PH), f), 0), (add(face(0, PH), f), R), (add(face(0, 0), f), 0)])
    return [front, hole] + bands

def bbox(polys):
    """The ink box, with every fillet sampled so a rounded shoulder is measured where the ink is."""
    xs, ys = [], []
    for pts in polys:
        n = len(pts)
        for i, (p, r) in enumerate(pts):
            if not r:
                xs.append(p[0]); ys.append(p[1]); continue
            p0, p1 = pts[i - 1][0], pts[(i + 1) % n][0]
            d1 = (p[0] - p0[0], p[1] - p0[1]); l1 = math.hypot(*d1); d1 = (d1[0] / l1, d1[1] / l1)
            d2 = (p1[0] - p[0], p1[1] - p[1]); l2 = math.hypot(*d2); d2 = (d2[0] / l2, d2[1] / l2)
            phi = math.acos(max(-1, min(1, d1[0] * d2[0] + d1[1] * d2[1]))); t = r * math.tan(phi / 2)
            side = 1 if d1[0] * d2[1] - d1[1] * d2[0] > 0 else -1
            cx, cy = p[0] - d1[0] * t - side * d1[1] * r, p[1] - d1[1] * t + side * d1[0] * r
            a0 = math.atan2(p[1] - d1[1] * t - cy, p[0] - d1[0] * t - cx)
            for k in range(0, 61):
                a = a0 + side * phi * k / 60; xs.append(cx + r * math.cos(a)); ys.append(cy + r * math.sin(a))
    return min(xs), min(ys), max(xs), max(ys)

def mark_svg():
    """The mark as path data in a box the size of its own ink, 64.75 units tall like the kit's first trace."""
    polys = pieces(); x0, y0, x1, y1 = bbox(polys)
    k = 64.75 / (y1 - y0)
    moved = [[((round((p[0] - x0) * k, 6), round((p[1] - y0) * k, 6)), r * k) for p, r in poly] for poly in polys]
    d = " ".join(outline(poly) for poly in moved)
    w = (x1 - x0) * k
    return w, 64.75, d

ROOT = Path(__file__).resolve().parent.parent

def render(svg, w, h):
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=w, height=h)))).convert("RGBA")

def mark_doc(w, h, d, ink, mark_h, cx, cy, ground=None, rx=0, tile=None):
    """A square-or-not canvas with the mark centred at (cx, cy) at height mark_h. ground fills the canvas
    (rounded by rx); tile draws a rounded square of that size instead, centred, for transparent corners."""
    mw, mh, path = MARK
    k = mark_h / mh
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">']
    if tile:
        parts.append(f'<rect x="{(w - tile) / 2}" y="{(h - tile) / 2}" width="{tile}" height="{tile}" rx="{rx}" fill="{ground}"/>')
    elif ground:
        parts.append(f'<rect width="{w}" height="{h}" rx="{rx}" fill="{ground}"/>')
    parts.append(f'<path transform="translate({cx - mw * k / 2:.3f} {cy - mh * k / 2:.3f}) scale({k:.6f})" fill="{ink}" fill-rule="evenodd" d="{d}"/></svg>')
    return "".join(parts)

def logo(name, ground, ink, size=2000, rx=0, tile=None):
    doc = mark_doc(size, size, MARK[2], ink, size * MARK_SHARE if not tile else tile * MARK_SHARE, size / 2, size / 2, ground, rx, tile)
    im = render(doc, size, size)
    if not tile and not rx: im = im.convert("RGB")
    im.save(ROOT / name, optimize=True); print("wrote", name, im.size, im.mode)

def rebanner(name, ground, ink):
    """Swap the traced mark in a banner for the drawn one, at the same height and centre; the name stays."""
    im = Image.open(ROOT / name).convert("RGB"); a = np.array(im, float)
    g = np.array([int(ground[i:i + 2], 16) for i in (1, 3, 5)], float); i_ = np.array([int(ink[i:i + 2], 16) for i in (1, 3, 5)], float)
    ax = i_ - g; t = np.clip(((a - g) @ ax) / (ax @ ax), 0, 1)
    cols = np.where(t.max(axis=0) > 0.5)[0]
    gaps = np.where(np.diff(cols) > 40)[0]
    x0, x1 = cols[0], cols[gaps[0]]                       # the mark: the first run of ink columns, before the word
    rows = np.where(t[:, x0:x1 + 1].max(axis=1) > 0.5)[0]; y0, y1 = rows[0], rows[-1]
    a[y0 - 3:y1 + 4, x0 - 3:x1 + 4] = g
    base = Image.fromarray(a.astype(np.uint8), "RGB").convert("RGBA")
    doc = mark_doc(im.width, im.height, MARK[2], ink, y1 - y0 + 1, (x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2)
    over = render(doc, im.width, im.height)
    out = Image.alpha_composite(base, over).convert("RGB"); out.save(ROOT / name, optimize=True)
    print("wrote", name, "mark box", (x0, y0, x1, y1))

MARK = mark_svg()

if __name__ == "__main__":
    w, h, d = MARK
    (ROOT / "phosphor-mark.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}"><path fill="currentColor" fill-rule="evenodd" d="{d}"/></svg>\n')
    print(f"wrote phosphor-mark.svg  box {w:.2f} x {h:.2f}  band {BAND_H} gap {GAP_H} fillet {R} crown {R_CROWN}")
    if "--svg" in sys.argv: sys.exit()
    for way, (ground, ink) in INK.items():
        logo(f"phosphor-logo-{way}.png", ground, ink)
    logo("phosphor-logo-white-on-black-rounded.png", *INK["white-on-black"], rx=450, tile=2000)
    logo("phosphor-app-icon.png", *INK["green-on-black"], size=1024, rx=185, tile=824)
    for net in ("twitter", "linkedin"):
        rebanner(f"phosphor-banner-{net}.png", *INK["green-on-black"])
        rebanner(f"phosphor-banner-{net}-white-on-black.png", *INK["white-on-black"])
