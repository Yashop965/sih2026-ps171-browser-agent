#!/usr/bin/env python3
"""
Reusable YC-style ad video pipeline (theme-aware, big-type, premium framing).
Renders motion-graphics slides + real project screenshots with animated
PII-detection overlays, then encodes an MP4 via ffmpeg.

One run renders every theme in THEMES (project / black / light) so you get a
re-themed ad set for free.

Usage:
    python ad_pipeline/build_ad.py [--theme project|black|light|all]
"""

import argparse
import json
import math
import random
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------- constants
WIDTH, HEIGHT = 1920, 1080
FPS = 30
ROOT = Path(__file__).parent.parent  # project root
FONT_SCALE = 1.45          # global type scale (1.65 overshot after the font-path fix)
HERO_MAX_W = int(WIDTH * 0.68)   # title-card hero cap
MAX_HEAD_W = int(WIDTH * 0.74)    # any other headline cap
SHOT_W, SHOT_H = 1240, 850   # screenshot footprint
SAFE_TOP = 64                  # no ink above this
HEADLINE_BOTTOM = 205         # shot must start at/below this (keeps headline clear)

# Windows .ttf files use the real on-disk names (NOT the friendly "Segoe UI.ttf"
# which does NOT exist). Original code pointed at 'Segoe UI.ttf' / 'Segoe UI
# Bold.ttf' -> truetype() raised -> silent 10px Pillow default -> THAT was the
# actual cause of "all text looks too small". Now we resolve to a pair that
# exists and warn loudly if we can't.
FONT = "C:/Windows/Fonts/segoeui.ttf"
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
_font_cache = {}
_font_resolved = False
_FONT_FALLBACKS = [
    ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/calibrib.ttf"),
    ("C:/Windows/Fonts/bahnschrift.ttf", "C:/Windows/Fonts/bahnschrift.ttf"),
]

# ---------------------------------------------------------------- themes
# Each theme: bg + accent palette + panel/fill + orb/particle intensity.
# "WHITE" doubles as the primary text color, so the light theme flips it to
# near-black and every text element inverts automatically.
THEMES = {
    "project": {  # complements the extension UI (indigo on deep indigo-navy)
        "BG_TOP": (9, 11, 30), "BG_BOTTOM": (22, 26, 58),
        "CYAN": (99, 102, 241), "PURPLE": (129, 140, 248), "GREEN": (16, 185, 129),
        "PINK": (194, 65, 59), "YELLOW": (245, 158, 11),
        "WHITE": (245, 244, 241), "GRAY": (150, 154, 178), "DIM": (98, 104, 135),
        "PANEL": (24, 28, 60, 235), "FIELD_FILL": (34, 40, 78),
        "CHROME_FILL": (24, 30, 58), "BODY_FILL": (16, 20, 44), "CLOUD_FILL": (40, 18, 40),
        "ORB_ALPHA": 1.0, "PARTICLE_ALPHA": 1.0,
        "orbs": [("cyan", 380, 250, 220, 60), ("purple", 1560, 300, 260, 70),
                 ("blue", 1150, 860, 300, 60)],
    },
    "black": {   # LEAD THEME (user preference): true near-black, brighter "studio dark" accents
        "BG_TOP": (2, 2, 4), "BG_BOTTOM": (14, 14, 17),
        "CYAN": (129, 140, 248), "PURPLE": (167, 139, 250), "GREEN": (52, 211, 153),
        "PINK": (239, 68, 68), "YELLOW": (251, 191, 36),
        "WHITE": (250, 250, 252), "GRAY": (140, 140, 155), "DIM": (78, 78, 94),
        "PANEL": (18, 18, 22, 240), "FIELD_FILL": (26, 26, 32),
        "CHROME_FILL": (22, 22, 28), "BODY_FILL": (10, 10, 14), "CLOUD_FILL": (28, 10, 16),
        "ORB_ALPHA": 0.85, "PARTICLE_ALPHA": 0.7,
        "orbs": [("cyan", 380, 250, 220, 55), ("purple", 1560, 300, 260, 65),
                 ("blue", 1150, 860, 300, 55)],
    },
    "light": {   # warm paper system from Popup.css; WHITE flips to dark text
        "BG_TOP": (245, 244, 241), "BG_BOTTOM": (233, 231, 227),
        "CYAN": (99, 102, 241), "PURPLE": (79, 70, 229), "GREEN": (22, 101, 52),
        "PINK": (139, 46, 46), "YELLOW": (139, 105, 20),
        "WHITE": (10, 10, 10), "GRAY": (85, 88, 95), "DIM": (150, 150, 155),
        "PANEL": (255, 255, 255, 235), "FIELD_FILL": (237, 235, 231),
        "CHROME_FILL": (255, 255, 255), "BODY_FILL": (250, 249, 246),
        "CLOUD_FILL": (255, 240, 238),
        "ORB_ALPHA": 0.22, "PARTICLE_ALPHA": 0.28,
        "orbs": [("cyan", 380, 250, 240, 18), ("purple", 1560, 300, 260, 18)],
    },
}

# active palette (set by set_theme before rendering)
(BG_TOP, BG_BOTTOM, CYAN, PURPLE, GREEN, PINK, YELLOW,
 WHITE, GRAY, DIM, PANEL, FIELD_FILL, CHROME_FILL, BODY_FILL, CLOUD_FILL,
 ORB_ALPHA, PARTICLE_ALPHA, ORBS) = THEMES["project"].values()


def set_theme(name):
    t = THEMES[name]
    for key in ("BG_TOP", "BG_BOTTOM", "CYAN", "PURPLE", "GREEN", "PINK",
                "YELLOW", "WHITE", "GRAY", "DIM", "PANEL", "FIELD_FILL",
                "CHROME_FILL", "BODY_FILL", "CLOUD_FILL",
                "ORB_ALPHA", "PARTICLE_ALPHA"):
        globals()[key] = t[key]
    globals()["ORBS"] = t["orbs"]
    _bg_cache.clear()
    _font_cache.clear()
    return name


def _orb_color(name):
    return {"cyan": CYAN, "purple": PURPLE, "blue": (40, 90, 200),
            "amber": YELLOW}.get(name, CYAN)


def _resolve_fonts():
    """Pick the first regular+bold .ttf pair that exists on disk.

    Mutates module-level FONT/FONT_B. The ORIGINAL values ('Segoe UI.ttf',
    'Segoe UI Bold.ttf') do not exist on Windows — the real files are
    segoeui.ttf / segoeuib.ttf. If truetype() was fed the missing name it
    raised and the except branch silently returned Pillow's 10px bitmap
    default, which is why *every* string in the video rendered tiny. This
    resolver guarantees we only ever hand truetype() a real file (or warn).
    """
    global _font_resolved, FONT, FONT_B
    if _font_resolved:
        return
    for reg, bol in _FONT_FALLBACKS:
        if Path(reg).exists() and Path(bol).exists():
            FONT, FONT_B = reg, bol
            _font_resolved = True
            print(f"fonts -> {reg} / {bol}")
            return
    _font_resolved = True
    print("WARN: no regular+bold .ttf pair found in C:/Windows/Fonts — "
          "text will fall back to the tiny Pillow default. Set FONT/FONT_B "
          "or _FONT_FALLBACKS in build_ad.py.")


def font(size, bold=False):
    """Return a truetype font at the requested (scaled) size.

    Resolves FONT/FONT_B to a pair that actually exists on disk (the original
    'Segoe UI.ttf' paths did not, which silently produced 10px default-font
    text in every frame). Falls back to Pillow default with a loud warning so
    the failure mode is never invisible again.
    """
    _resolve_fonts()
    size = int(size * FONT_SCALE)
    key = (size, bold)
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(FONT_B if bold else FONT, size)
        except Exception:
            print(f"WARN: truetype failed for "
                  f"{'bold' if bold else 'reg'} {FONT_B if bold else FONT} "
                  f"@{size}px — using Pillow default (text will be tiny)")
            _font_cache[key] = ImageFont.load_default()
    return _font_cache[key]


# ---------------------------------------------------------------- easing
def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def seg(t, start, end):
    if t <= start:
        return 0.0
    if t >= end:
        return 1.0
    return (t - start) / (end - start)


# ---------------------------------------------------------------- base layer
_bg_cache = {}


def base_layer(ambient=1.0):
    if "bg" not in _bg_cache:
        bg = Image.new("RGB", (WIDTH, HEIGHT))
        d = ImageDraw.Draw(bg)
        for y in range(HEIGHT):
            r = y / HEIGHT
            col = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * r) for i in range(3))
            d.line([(0, y), (WIDTH, y)], fill=col)
        for oname, ox, oy, rad, strength in ORBS:
            col = _orb_color(oname)
            glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            for i in range(rad, 0, -2):
                a = int(strength * ORB_ALPHA * (1 - i / rad) ** 2)
                gd.ellipse([ox - i, oy - i, ox + i, oy + i],
                           fill=(col[0], col[1], col[2], a))
            bg = Image.alpha_composite(bg.convert("RGBA"), glow).convert("RGB")
        # P4: dither the gradient (+/-2 LSB) to kill 8-bit banding at the source
        import numpy as _np
        arr = _np.asarray(bg).astype(_np.int16)
        arr += _np.random.RandomState(7).randint(-2, 3, arr.shape).astype(_np.int16)
        bg = Image.fromarray(_np.clip(arr, 0, 255).astype(_np.uint8))
        _bg_cache["bg"] = bg
    if "particles" not in _bg_cache:
        rng = random.Random(42)
        parts = []
        for _ in range(46):
            parts.append([
                rng.uniform(0, WIDTH), rng.uniform(0, HEIGHT),
                rng.uniform(0.2, 0.9),
                rng.uniform(1.2, 2.6),
                rng.choice(["cyan", "purple", "white", "green"]),
                rng.uniform(0.25, 0.6),
            ])
        _bg_cache["particles"] = parts
    img = _bg_cache["bg"].copy()
    d = ImageDraw.Draw(img, "RGBA")
    pcol = {"cyan": CYAN, "purple": PURPLE, "white": WHITE, "green": GREEN}
    for i, p in enumerate(_bg_cache["particles"]):
        x, y, sp, r, cname, a = p
        y = (y + sp * 1080 * 0.004 * (i * 7 + 1)) % (HEIGHT + 20) - 10
        col = pcol[cname]
        d.ellipse([x - r, y - r, x + r, y + r],
                  fill=(*col, int(a * 255 * ambient * PARTICLE_ALPHA)))
    return img, d


# ---------------------------------------------------------------- helpers
def rounded_panel(d, box, radius=18, fill=PANEL, outline=None, width=2):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def mask_str(v):
    v = (v or "").strip()
    if not v:
        return "••••"
    if len(v) <= 4:
        return "•" * len(v)
    return v[:2] + "…" + v[-2:]


def fit_font(base, bold, text, max_w, step=2, floor=12):
    """Largest base (<= base) whose scaled text fits in max_w px. Real truetype
    fonts are far wider than the old 10px bitmap fallback, so fixed sizes
    overflow their containers — auto-fit instead of hand-tuned sizes."""
    b = base
    while b > floor and font(b, bold).getlength(text) > max_w:
        b -= step
    return b


def line_height(size, bold=False, leading=1.18):
    """P1: derive line spacing from real font metrics instead of a hard-coded
    constant — the root cause of the title L1/L2 collision (glyph height now
    scales but the gap did not)."""
    f = font(size, bold)
    a, d = f.getmetrics()
    return int((a + d) * leading)


def screenshot_fit(png_path, max_w, max_h):
    im = Image.open(png_path).convert("RGB")
    sc = min(max_w / im.width, max_h / im.height)
    im = im.resize((int(im.width * sc), int(im.height * sc)), Image.LANCZOS)
    return im, im.width, im.height


# ================================================================ scenes
class Scenes:
    def __init__(self, config, root: Path):
        self.cfg = config
        self.root = root
        self.shots_dir = root / "screenshots"
        self.fields = json.loads((self.shots_dir / "fields.json").read_text())
        self.shots = {}
        for name in ("gov_portal", "pii_heatmap", "form_demo", "form_demo_blank",
                     "ext_popup"):
            p = self.shots_dir / f"{name}.png"
            if p.exists():
                self.shots[name] = p

    # ---- 1. title
    def scene_title(self, img, d, t):
        c = self.cfg["title"]
        w = WIDTH // 2
        p1 = ease(seg(t, 0.05, 0.45))
        p2 = ease(seg(t, 0.35, 0.75))
        p3 = ease(seg(t, 0.6, 0.95))
        # YC-hero composition: small kicker, then TWO big stacked headline lines.
        # P1: cap the hero to HERO_MAX_W and derive the L1->L2 gap from real
        # font metrics so the two lines never collide (the measured 9px overlap).
        hero = c.get("headline", "")
        hero2 = c.get("headline2")
        base = fit_font(104, True, max((hero, hero2 or "", c.get("subheadline", "")),
                                       key=len), HERO_MAX_W, floor=40)
        lh = line_height(base, True)
        # stack the block optically centred, kicker above (issue 3a: give the
        # kicker real breathing room from the "On-Device" hero so they never
        # read as overlapping)
        block_top = 330
        sub_col = (195, 200, 220) if WHITE[0] > 128 else (80, 84, 100)
        img = self._fade_text(img, c["kicker"], w, block_top - 108, font(30, True), PURPLE, p1)
        if hero2:
            img = self._fade_text(img, hero, w, block_top, font(base, True), WHITE, p1, glow=CYAN)
            img = self._fade_text(img, hero2, w, block_top + lh, font(base, True),
                                  PURPLE, p1, glow=CYAN)
            sub_y = block_top + 2 * lh + 18
        else:
            img = self._fade_text(img, hero, w, block_top, font(base, True), WHITE, p1, glow=CYAN)
            sub_y = block_top + lh + 30
        img = self._fade_text(img, c["subheadline"], w, sub_y,
                              font(fit_font(40, False, c["subheadline"], WIDTH - 400, floor=20)),
                              sub_col, p2)
        # three feature cards (glyph icons instead of plain ellipses) —
        # issue 3b: each chip hugs its own label (variable width, group-centred)
        # so a short label like "PII Shield" doesn't sit in a wide empty chip.
        d = ImageDraw.Draw(img, "RGBA")
        badges = c["badges"]
        icon_colors = [CYAN, GREEN, PURPLE]
        glyphs = ["\u2713", "\u2192", "\u25CF"]
        pad_h = 24          # left pad before icon, right pad after text
        icon_d = 34        # icon circle diameter
        gap = 34
        # per-chip widths sized to their own label
        lbs = [fit_font(22, True, b, 400, floor=13) for b in badges]
        chip_w = [int(font(lbs[i], True).getlength(badges[i])) + pad_h*2 + icon_d + 12
                  for i in range(len(badges))]
        total = sum(chip_w) + gap * (len(badges) - 1)
        x0 = w - total // 2
        chip_top = 750
        for i, b in enumerate(badges):
            if p3 <= 0:
                continue
            drift = int(18 * (1 - p3))
            x = x0 + sum(chip_w[:i]) + i * gap      # group-centred; do NOT also
            cw = chip_w[i]                          # mutate x0 (double-count bug)
            rounded_panel(d, [x, chip_top + drift, x + cw, chip_top + 70 + drift],
                          radius=35, fill=(*PANEL[:3], int(235 * p3)),
                          outline=(*DIM, int(120 * p3)), width=2)
            # icon: tight circle, vertically centred in the chip
            icy = chip_top + 35 + drift
            icx = x + pad_h + icon_d // 2
            d.ellipse([icx - icon_d//2, icy - icon_d//2, icx + icon_d//2, icy + icon_d//2],
                      fill=(*icon_colors[i], 90), outline=icon_colors[i], width=3)
            d.text((icx, icy), glyphs[i % len(glyphs)],
                   font=font(16, True), fill=icon_colors[i], anchor="mm")
            # label, left-aligned after the icon, vertically centred
            tx = x + pad_h + icon_d + 12
            d.text((tx, icy), b, font=font(lbs[i], True),
                   fill=(*WHITE, int(255 * p3)), anchor="lm")
        return img

    def _fade_text(self, img, text, x, y, fnt, color, p, glow=None):
        if p <= 0:
            return img
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        a = int(255 * p)
        if glow:
            g = ImageDraw.Draw(layer)
            g.text((x, y), text, font=fnt, fill=(*glow, int(190 * p)), anchor="mm")
            layer = layer.filter(ImageFilter.GaussianBlur(16))
            ld = ImageDraw.Draw(layer)
        ld.text((x, y), text, font=fnt, fill=(*color, a), anchor="mm")
        return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    # ---- 2. problem
    def scene_problem(self, img, d, t):
        c = self.cfg["problem"]
        p1 = ease(seg(t, 0.0, 0.3))
        p2 = ease(seg(t, 0.25, 0.6))
        p3 = ease(seg(t, 0.55, 0.9))
        # headline: top-center, two stacked lines, auto-fit
        head_lines = c["headline"].split("\n")
        hbase = fit_font(46, True, max(head_lines, key=len), WIDTH - 160, floor=24)
        for j, hl in enumerate(head_lines):
            img = self._fade_text(img, hl, WIDTH // 2, 130 + j * 78, font(hbase, True),
                                  WHITE, p3, glow=PINK)
        # mini browser with form on left (fields drawn INSIDE the local canvas
        # before the opaque paste, or the paste wipes them out -> "empty box")
        bx, by, bw, bh = 200, 400, 560, 480
        if p1 > 0:
            mini = Image.new("RGBA", (bw, bh + 44), (0, 0, 0, 0))
            md = ImageDraw.Draw(mini)
            md.rounded_rectangle([0, 0, bw, 44], radius=14, fill=CHROME_FILL)
            for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
                md.ellipse([16 + i * 24, 14, 32 + i * 24, 30], fill=col)
            md.rounded_rectangle([0, 40, bw, bh + 40], radius=14,
                                 fill=BODY_FILL, outline=(*DIM, 90), width=2)
            fields = ["Full Name", "Email", "Phone", "Aadhaar", "PAN", "Password"]
            for i, f in enumerate(fields):
                fx, fy = 40, 96 + i * 62          # LOCAL coords inside `mini`
                if p1 > i / 6:
                    md.rounded_rectangle([fx, fy, fx + 170, fy + 36], radius=8,
                                         fill=FIELD_FILL, outline=(*DIM, 120), width=1)
                    md.text((fx + 14, fy + 8), f, font=font(15), fill=GRAY)
                    md.rounded_rectangle([fx + 190, fy, bw - 150, fy + 36], radius=8,
                                         fill=FIELD_FILL, outline=(*DIM, 120), width=1)
            img.paste(mini, (bx, by), mini)
        # cloud on the right
        cx, cy = 1250, 600
        if p2 > 0:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            for k in range(6):
                fx = int(790 + (cx - 110 - 790) * k / 6)
                fy = int(cy + math.sin(k * 1.1) * 20)
                if k / 6 <= p2:
                    ld.ellipse([fx - 6, fy - 6, fx + 6, fy + 6], fill=(*PINK, 210))
            for i in range(70, 0, -3):
                ld.ellipse([cx - 100 - i, cy - 66 - i // 2, cx + 100 + i, cy + 66 + i // 2],
                           outline=(*PINK, int(45 * p2)))
            for ex, ey, ry in ((cx, cy, 100), (cx - 150, cy - 10, 70), (cx + 150, cy - 10, 70)):
                ld.ellipse([ex - ry, ey - ry, ex + ry, ey + ry],
                           fill=CLOUD_FILL, outline=PINK, width=3)
            ld.text((cx, cy - 6), "Cloud API", font=font(30, True), fill=PINK, anchor="mm")
            layer = layer.filter(ImageFilter.GaussianBlur(1))
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
            d = ImageDraw.Draw(img, "RGBA")
            if p2 > 0.4:
                for k in range(4):
                    dp = ((t * 3) + k / 4) % 1.0
                    dx = int(cx + 170 + dp * 80)
                    dy = int(cy - 90 - dp * 160)
                    d.text((dx, dy), c["leaking"][k % len(c["leaking"])],
                           font=font(15), fill=(*PINK, int(210 * p3)))
        # sub-lines: bottom-center, kept above the lower glow band
        for i, line in enumerate(c["lines"]):
            lbase = fit_font(28, False, line, WIDTH - 320, floor=16)
            img = self._fade_text(img, line, WIDTH // 2, 880 + i * 46, font(lbase),
                                  GRAY, ease(seg(t, 0.6 + i * 0.08, 0.85 + i * 0.08)))
        return img

    # ---- shared: big cinematic browser frame + real screenshot
    def paste_screenshot(self, img, name, url, title_text=None, t=0.0, box_w=SHOT_W, box_h=SHOT_H):
        # P0-6: reserve the top headline band, then anchor the browser below it
        # consistently (detection/heatmap/formfill all share this -> no scene
        # puts its mock under a headline anymore).
        body_top = HEADLINE_BOTTOM + 14
        avail_h = (HEIGHT - 24) - body_top
        # P2-4: subtle 3% ken-burns push-in over the scene ("camera approaches").
        z = 1.0 + 0.03 * ease(t)
        shot, sw, sh = screenshot_fit(
            self.shots[name], int(box_w * z), int(min(box_h, avail_h) * z))
        sy = body_top + max(0, int((avail_h - sh) * 0.15))   # top-weight, small gap
        sx = (WIDTH - sw) // 2
        if title_text:
            p_head = ease(seg(t, 0.0, 0.25))
            hb = fit_font(52, True, title_text, WIDTH - 160, floor=28)
            img = self._fade_text(img, title_text, WIDTH // 2, HEADLINE_BOTTOM // 2 + 10,
                                  font(hb, True), WHITE, p_head, glow=CYAN)
        shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle([sx - 16, sy - 60, sx + sw + 16, sy + sh + 20],
                             radius=28, fill=(0, 0, 0, 165))
        shadow = shadow.filter(ImageFilter.GaussianBlur(20))
        img = Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        chrome = CHROME_FILL
        d.rounded_rectangle([sx - 8, sy - 58, sx + sw + 8, sy + sh + 8], radius=22,
                            fill=chrome, outline=(*CYAN, 80), width=2)
        d.rounded_rectangle([sx, sy - 58, sx + sw, sy - 10], radius=16, fill=CHROME_FILL)
        for i, col in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
            d.ellipse([sx + 18 + i * 26, sy - 45, sx + 34 + i * 26, sy - 29], fill=col)
        url_bar = BODY_FILL
        d.rounded_rectangle([sx + 110, sy - 48, sx + sw - 18, sy - 18], radius=14,
                            fill=url_bar, outline=(*DIM, 120), width=1)
        d.text((sx + 128, sy - 45), "https://" + url, font=font(14), fill=GRAY)
        img.paste(shot, (sx, sy))
        return img, (sx, sy, sw, sh)

    # ---- 3. detection over real gov portal
    def scene_detection(self, img, d, t):
        c = self.cfg["detection"]
        img, (sx, sy, sw, sh) = self.paste_screenshot(
            img, "gov_portal", c["url"], c["headline"], t, SHOT_W, SHOT_H)
        d = ImageDraw.Draw(img, "RGBA")
        sc = sw / 2880
        ff = self.fields["gov_portal"]
        pii_fields = [(i, f) for i, f in enumerate(ff) if f["isPii"]]
        n = len(pii_fields)
        sweep_p = ease(seg(t, 0.15, 0.85))
        sweep_y = sy + int(sweep_p * sh)
        if 0.15 < t < 0.85:
            sweep_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            sld = ImageDraw.Draw(sweep_layer)
            for i in range(46):
                a = int(110 * (1 - i / 46))
                sld.rectangle([sx - 24, sweep_y - 46 + i, sx + sw + 24, sweep_y - 44 + i],
                              fill=(*CYAN, a))
            sld.rectangle([sx - 24, sweep_y, sx + sw + 24, sweep_y + 4], fill=CYAN)
            img = Image.alpha_composite(img.convert("RGBA"), sweep_layer).convert("RGB")
        mask_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        mld = ImageDraw.Draw(mask_layer)
        for f in ff:
            if not f["isPii"] or not f.get("value"):
                continue
            x, y, w, h = [f["box"][k] for k in ("x", "y", "w", "h")]
            bx = sx + x * 2 * sc
            by = sy + 4 + y * 2 * sc
            bw = (w * 2) * sc
            bh = (h * 2) * sc
            # P0-5: cover the WHOLE field (was inset 8px -> values peeked out).
            mld.rounded_rectangle([bx - 2, by - 2, bx + bw + 2, by + bh + 2],
                                  radius=6, fill=(16, 20, 40, 255))
            mld.text((bx + bw // 2, by + bh // 2), "•" * 6, font=font(int(20 * sc * 2)),
                     fill=(*DIM, 220), anchor="mm")
        img = Image.alpha_composite(img.convert("RGBA"), mask_layer).convert("RGB")
        layers = Image.new("RGBA", img.size, (0, 0, 0, 0))
        fld = ImageDraw.Draw(layers)
        results = Image.new("RGBA", img.size, (0, 0, 0, 0))
        rld = ImageDraw.Draw(results)
        for idx, (fi, f) in enumerate(pii_fields):
            threshold = 0.15 + 0.70 * (idx + 0.5) / n
            if sweep_p < threshold:
                continue
            fx, fy, fw, fh = [f["box"][k] for k in ("x", "y", "w", "h")]
            box = (sx + fx * 2 * sc, sy + 4 + fy * 2 * sc,
                   sx + (fx + fw) * 2 * sc, sy + 4 + (fy + fh) * 2 * sc)
            color = CYAN
            pop = ease_out(min(1.0, (sweep_p - threshold) / 0.12 + 0.3))
            fld.rounded_rectangle([box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6],
                                  radius=10, outline=(*color, int(255 * pop)), width=3)
            fld.rounded_rectangle([box[0] - 13, box[1] - 13, box[2] + 13, box[3] + 13],
                                  radius=15, outline=(*color, int(90 * pop)), width=2)
            # short label: strip the "Enter " placeholder prefix so the chip fits
            label = (c["labels"][fi] if fi in c.get("labels", {}) else f["label"])
            label = label.replace("Enter ", "").strip()
            masked = c.get("masked", {}).get(str(fi)) or mask_str(f.get("value", ""))
            chip_txt = f"{label}  ·  {masked}"
            chw = font(18, True)
            tw = chw.getlength(chip_txt)
            cx0 = box[2] + 20
            if cx0 + tw + 56 > WIDTH - 20:
                cx0 = box[0] - tw - 56 - 20
            cy0 = (box[1] + box[3]) // 2 - 20
            rld.rounded_rectangle([cx0, cy0, cx0 + tw + 46, cy0 + 40], radius=20,
                                  fill=(*PANEL[:3], 235), outline=(*GREEN, 180), width=2)
            rld.text((cx0 + 22, cy0 + 7), chip_txt, font=chw, fill=GREEN)
            rld.ellipse([cx0 + tw + 16, cy0 + 8, cx0 + tw + 40, cy0 + 32], fill=GREEN)
            rld.text((cx0 + tw + 28, cy0 + 9), "✓", font=font(16, True), fill=(6, 20, 12))
        img = Image.alpha_composite(img.convert("RGBA"), layers).convert("RGB")
        img = Image.alpha_composite(img.convert("RGBA"), results).convert("RGB")
        p_c = ease(seg(t, 0.85, 1.0))
        if p_c > 0:
            cnt_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            cld = ImageDraw.Draw(cnt_layer)
            ct = f"{c['count']} / {n} PII fields detected on-device"
            # auto-fit so the chip can't run past the left edge of the shot
            ct_base = fit_font(26, True, ct, sw - 90, floor=14)
            ct_font = font(ct_base, True)
            cw = ct_font.getlength(ct)
            cxx = sx + sw - cw - 70
            cxx = max(sx + 20, cxx)          # never clip into the panel
            cld.rounded_rectangle([cxx, sy - 84, cxx + cw + 48, sy - 30], radius=32,
                                  fill=(*GREEN, 70), outline=GREEN, width=2)
            cld.text((cxx + 24, sy - 76), ct, font=ct_font, fill=GREEN)
            img = Image.alpha_composite(img.convert("RGBA"), cnt_layer).convert("RGB")
        return img

    # ---- 4. architecture (from docs/PRD.md section 2.1/2.2)
    def _panel_block(self, img, x, y, w, h, title, items, prog, accent):
        """One component block inside a panel. Items stagger in with prog."""
        if prog <= 0:
            return img
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        alpha = int(255 * min(1.0, prog * 4))
        rounded_panel(ld, [x, y, x + w, y + h], radius=18,
                      fill=(*PANEL[:3], int(225 * min(1, prog * 3))),
                      outline=(*accent, int(130 * min(1, prog * 3))), width=2)
        ld.rounded_rectangle([x + 18, y + 18, x + 24, y + 60], radius=3,
                             fill=(*accent, alpha))
        tb = fit_font(28, True, title, w - 60)
        ld.text((x + 40, y + 28), title, font=font(tb, True), fill=(*WHITE, alpha))
        iy = y + 84
        n = len(items)
        for i, it in enumerate(items):
            p_i = max(0.0, min(1.0, (prog - (i + 0.4) / (n + 1)) * (n + 1)))
            if p_i <= 0:
                continue
            a_i = int(255 * p_i)
            drift = int(10 * (1 - p_i))
            ib = fit_font(24, False, "·  " + it, w - 60, floor=13)
            ld.text((x + 44, iy + drift), "·  " + it, font=font(ib), fill=(*GRAY, a_i))
            iy += 44
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        return img

    def scene_architecture(self, img, d, t):
        c = self.cfg["architecture"]
        img = self._fade_text(img, c["headline"], WIDTH // 2, 150, font(56, True),
                              WHITE, ease(seg(t, 0.0, 0.22)), glow=CYAN)
        # panels (wider center gap for the privacy-seal chip)
        lx, ly, lw = 70, 250, 740
        rx, rw = 1110, 740
        panel_alpha = ease(seg(t, 0.05, 0.3))
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        for px, pt in ((lx, c["left_title"]), (rx, c["right_title"])):
            ld.rounded_rectangle([px, ly, px + rw, 950], radius=26,
                                 fill=(*PANEL[:3], int(120 * panel_alpha)),
                                 outline=(*DIM, int(120 * panel_alpha)), width=2)
            ptb = fit_font(26, True, pt, rw - 60, floor=14)
            ld.text((px + 34, ly + 26), pt, font=font(ptb, True),
                    fill=(*CYAN, int(255 * panel_alpha)))
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        # left blocks: vision pipeline + privacy engine (P2-7: fit inside panel)
        lh = 272
        progs = [ease(seg(t, 0.18, 0.5)), ease(seg(t, 0.38, 0.7))]
        for bi, blk in enumerate(c["left_blocks"]):
            img = self._panel_block(img, lx + 30, ly + 90 + bi * (lh + 30), lw - 60, lh,
                                    blk["title"], blk["items"], progs[bi],
                                    CYAN if bi == 0 else GREEN)
        # right blocks: planner + LLM
        progs_r = [ease(seg(t, 0.3, 0.65)), ease(seg(t, 0.5, 0.85))]
        for bi, blk in enumerate(c["right_blocks"]):
            img = self._panel_block(img, rx + 30, ly + 90 + bi * (lh + 30), rw - 60, lh,
                                    blk["title"], blk["items"], progs_r[bi],
                                    PURPLE if bi == 0 else YELLOW)
        # arrows + packets between the panels
        p_arrow = ease(seg(t, 0.7, 0.95))
        if p_arrow > 0:
            img = Image.alpha_composite(img.convert("RGBA"),
                                        self._flow_arrows(t, p_arrow, c)).convert("RGB")
        return img

    def _flow_arrows(self, t, p, c):
        """Forward (sanitized metadata, cyan) + return (JSON action, green)
        arrows with animated packets, plus the compact '0 PII' seal chip."""
        layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        x0, x1 = 815, 1105
        yf, yr = 430, 700
        a = int(255 * p)
        # forward arrow
        ld.line([(x0, yf), (x1, yf)], fill=(*CYAN, a), width=4)
        ld.polygon([(x1, yf), (x1 - 22, yf - 13), (x1 - 22, yf + 13)], fill=(*CYAN, a))
        # return arrow
        ld.line([(x1, yr), (x0, yr)], fill=(*GREEN, a), width=4)
        ld.polygon([(x0, yr), (x0 + 22, yr - 13), (x0 + 22, yr + 13)], fill=(*GREEN, a))
        # traveling packets (3 each)
        for k in range(3):
            pf = ((t * 5) + k / 3) % 1.0
            px = x0 + int((x1 - x0 - 26) * pf)
            ld.ellipse([px, yf - 5, px + 10, yf + 5], fill=(*CYAN, a))
            pr = ((t * 5) + k / 3) % 1.0
            px2 = x1 - int((x1 - x0 - 26) * pr)
            ld.ellipse([px2, yr - 5, px2 + 10, yr + 5], fill=(*GREEN, a))
        # labels (short, fit the 290px gap)
        ld.text(((x0 + x1) // 2, yf - 34), c["fw"], font=font(20, True),
                fill=(*CYAN, a), anchor="mm")
        ld.text(((x0 + x1) // 2, yr + 34), c["rev"], font=font(20, True),
                fill=(*GREEN, a), anchor="mm")
        # compact privacy-seal chip in the gap (P0: widen + centre so the
        # "crosses the line" sub-text stays inside the box, not spilling into
        # the panel gap)
        cx, cyy = (x0 + x1) // 2, 560
        chip_w, chip_h = 288, 96
        ld.rounded_rectangle([cx - chip_w // 2, cyy - chip_h // 2,
                              cx + chip_w // 2, cyy + chip_h // 2],
                             radius=48, fill=(*CLOUD_FILL, 240), outline=PINK, width=3)
        # padlock glyph, centred-left inside the chip
        lockx = cx - chip_w // 2 + 46
        ld.arc([lockx - 18, cyy - 26, lockx + 18, cyy + 2], start=180, end=360,
               fill=WHITE, width=5)
        ld.rounded_rectangle([lockx - 24, cyy - 4, lockx + 24, cyy + 30],
                             radius=6, fill=WHITE)
        # two-line seal text, centred in the chip's right portion
        text_cx = cx + 24
        ld.text((text_cx, cyy - 15), "0 PII", font=font(30, True),
                fill=WHITE, anchor="mm")
        ld.text((text_cx, cyy + 21), "crosses the line", font=font(15, False),
                fill=(*WHITE, int(200 * p)), anchor="mm")
        layer = layer.filter(ImageFilter.GaussianBlur(0.4))
        return layer

    # ---- 4b. product — the actual extension popup, framed + annotated
    def scene_product(self, img, d, t):
        c = self.cfg["product"]
        p_head = ease(seg(t, 0.0, 0.25))
        p_shot = ease(seg(t, 0.15, 0.5))
        p_sub = ease(seg(t, 0.6, 0.9))
        hb = fit_font(52, True, c["headline"], WIDTH - 160, floor=28)
        img = self._fade_text(img, c["headline"], WIDTH // 2, HEADLINE_BOTTOM // 2 + 10,
                              font(hb, True), WHITE, p_head, glow=GREEN)
        # frame the real popup UI (ext_popup.png) — issue 4: make it BIG, it's
        # the "here's the actual product" hero. The popup is a tall portrait
        # (~1:2.4), so it's height-limited; push it to nearly full frame height.
        shot = self.shots.get("ext_popup")
        if shot is None:
            return img
        pimg = Image.open(shot).convert("RGB")
        px, py = 210, HEADLINE_BOTTOM + 40          # start just under the headline
        max_w, max_h = 660, HEADLINE_BOTTOM + 40 + 812   # ~812px tall popup
        s = min(max_w / pimg.width, max_h / pimg.height, 1.0)
        pw, ph = int(pimg.width * s), int(pimg.height * s)
        pimg = pimg.resize((pw, ph), Image.LANCZOS)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        a = int(255 * p_shot)
        drift = int(18 * (1 - p_shot))
        # drop shadow + white "app window" card behind the real UI
        shd = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shd)
        sd.rounded_rectangle([px - 14, py - 14 + drift, px + pw + 14, py + ph + 14 + drift],
                             radius=22, fill=(0, 0, 0, 150))
        layer = Image.alpha_composite(layer, shd)
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle([px - 10, py - 10 + drift, px + pw + 10, py + ph + 10 + drift],
                             radius=18, fill=(255, 255, 255, int(245 * p_shot)),
                             outline=(*GREEN, a), width=3)
        img = img.convert("RGBA")
        img = Image.alpha_composite(img, layer).convert("RGB")
        # paste the actual popup pixels
        img.paste(pimg, (px, py + drift))
        # right-side annotations (the "what you're looking at" callouts)
        ann_x = px + pw + 70
        anns = [
            ("Task panel", "type a task, agent plans + executes", CYAN),
            ("PII detections", "Aadhaar · PAN · card — redacted on-device", PINK),
            ("Privacy ledger", "tamper-proof audit of every action", GREEN),
        ]
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        for i, (ttl, desc, col) in enumerate(anns):
            p_i = ease(seg(t, 0.4 + i * 0.12, 0.6 + i * 0.12))
            if p_i <= 0:
                continue
            ay = py + 40 + i * 168 + int(12 * (1 - p_i))
            ai = int(255 * p_i)
            ld.ellipse([ann_x, ay, ann_x + 40, ay + 40],
                       fill=(*col, int(90 * p_i)), outline=(*col, ai), width=3)
            tb = fit_font(28, True, ttl, 460)
            ld.text((ann_x + 62, ay + 2), ttl, font=font(tb, True),
                    fill=(*WHITE, ai))
            db = fit_font(19, False, desc, 440, floor=13)
            ld.text((ann_x + 62, ay + 44), desc, font=font(db),
                    fill=(*GRAY, ai))
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        # bottom sub-line
        sb = fit_font(26, False, c["sub"], WIDTH - 200, floor=15)
        img = self._fade_text(img, c["sub"], WIDTH // 2, HEIGHT - 90, font(sb),
                              GRAY, p_sub)
        return img

    # ---- 5. heatmap page (accuracy)
    def scene_heatmap(self, img, d, t):
        c = self.cfg["heatmap"]
        img, (sx, sy, sw, sh) = self.paste_screenshot(
            img, "pii_heatmap", c["url"], c["headline"], t)
        sc = sw / 2880
        ff = self.fields["pii_heatmap"]
        p_mark = ease(seg(t, 0.3, 0.75))
        if p_mark > 0:
            layers = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layers)
            for f in ff:
                if not f["isPii"]:
                    continue
                x, y, w, h = f["box"].values()
                box = (sx + x * 2 * sc, sy + 4 + y * 2 * sc,
                       sx + (x + w) * 2 * sc, sy + 4 + (y + h) * 2 * sc)
                ld.rounded_rectangle([box[0] - 5, box[1] - 5, box[2] + 5, box[3] + 5],
                                     radius=9, outline=(*CYAN, int(220 * p_mark)), width=3)
            card_x, card_y = sx + sw - 380, sy + 30
            ld.rounded_rectangle([card_x, card_y, card_x + 350, card_y + 124],
                                  radius=20, fill=PANEL, outline=GREEN, width=3)
            ld.text((card_x + 175, card_y + 46), "0 false positives",
                    font=font(fit_font(32, True, "0 false positives", 330)), fill=GREEN,
                    anchor="mm")
            ld.text((card_x + 175, card_y + 88), "on price-table text",
                    font=font(fit_font(20, False, "on price-table text", 330)),
                    fill=GRAY, anchor="mm")
            img = Image.alpha_composite(img.convert("RGBA"), layers).convert("RGB")
        p_sub = ease(seg(t, 0.6, 0.9))
        if p_sub > 0:
            img = self._fade_text(img, c["sub"], WIDTH // 2, sy + sh + 34,
                                  font(fit_font(28, False, c["sub"], WIDTH - 240, floor=16)),
                                  GRAY, p_sub)
        return img

    # ---- 5. secure form fill
    def scene_formfill(self, img, d, t):
        c = self.cfg["formfill"]
        blank = self.shots.get("form_demo_blank")
        name = "form_demo_blank" if blank else "form_demo"
        img, (sx, sy, sw, sh) = self.paste_screenshot(
            img, name, c["url"], c["headline"], t)
        sc = sw / 2880
        ff = self.fields["form_demo"]
        n = len(ff)
        for i, f in enumerate(ff):
            start, end = 0.25 + 0.6 * i / n, 0.25 + 0.6 * (i + 1) / n
            p = seg(t, start, end)
            if p <= 0:
                continue
            x, y, w, h = f["box"].values()
            vx = sx + x * 2 * sc + 26
            vy = sy + 4 + y * 2 * sc + 8
            value = f.get("value", "")
            if not value:
                continue
            shown = value[: max(0, int(len(value) * ease(p)))]
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            if p < 0.99:
                ld.rounded_rectangle([vx - 12, vy - 8, vx + w * sc - 6, vy + h * sc + 8],
                                     radius=8, outline=(*PURPLE, 190), width=2)
            if shown:
                ld.text((vx, vy), shown, font=font(int(20 * sc * 2)),
                        fill=(20, 26, 52), anchor="lm")
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        p_done = ease(seg(t, 0.9, 1.0))
        if p_done > 0:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            ct = c["done"]
            cf = font(28, True)
            cw = cf.getlength(ct)
            cx0 = WIDTH // 2 - cw // 2 - 46
            ld.rounded_rectangle([cx0, HEIGHT - 140, cx0 + cw + 92, HEIGHT - 80],
                                 radius=30, fill=(*GREEN, 75), outline=GREEN, width=2)
            ld.text((WIDTH // 2, HEIGHT - 110), ct, font=cf, fill=GREEN, anchor="mm")
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        return img

    # ---- 6. metrics
    def scene_metrics(self, img, d, t):
        c = self.cfg["metrics"]
        p_head = ease(seg(t, 0.0, 0.25))
        # P1: cap the metrics headline (measured 83% wide at base 64)
        mh = fit_font(64, True, c["headline"], MAX_HEAD_W, floor=30)
        img = self._fade_text(img, c["headline"], WIDTH // 2, 160, font(mh, True),
                               WHITE, p_head, glow=CYAN)
        d = ImageDraw.Draw(img, "RGBA")
        cols = [CYAN, GREEN, PURPLE]
        n = len(c["stats"])
        cw, gap = 470, 52
        total = cw * n + gap * (n - 1)
        x0 = WIDTH // 2 - total // 2
        for i, s in enumerate(c["stats"]):
            p = ease(seg(t, 0.25 + i * 0.15, 0.55 + i * 0.15))
            if p <= 0:
                continue
            x = x0 + i * (cw + gap)
            drift = int(26 * (1 - p))
            cy0, cy1 = 330 + drift, 770 + drift
            rounded_panel(d, [x, cy0, x + cw, cy1], radius=26,
                          fill=(*PANEL[:3], int(235 * p)),
                          outline=(*cols[i], int(130 * p)), width=3)
            target = s["value"]
            cur = target * ease_out(seg(t, 0.3 + i * 0.15, 0.75 + i * 0.15))
            txt = (f"{cur:.{s.get('decimals', 0)}f}" if s.get("decimals") else f"{int(cur)}")
            # auto-fit: fit the FULL final string (e.g. "1.21 MB") inside the
            # card so the number never overflows its panel
            final_txt = ((f"{target:.{s.get('decimals', 0)}f}" if s.get("decimals")
                          else f"{int(target)}") + s.get("suffix", ""))
            base = 86
            while base > 40 and font(base, True).getlength(final_txt) > cw - 90:
                base -= 4
            d.text((x + cw // 2, 510 + drift), txt + s.get("suffix", ""),
                   font=font(base, True), fill=cols[i], anchor="mm")
            # auto-fit label the same way
            lbl = s["label"]
            lbase = 28
            while lbase > 16 and font(lbase).getlength(lbl) > cw - 70:
                lbase -= 2
            d.text((x + cw // 2, 660 + drift), lbl, font=font(lbase),
                   fill=GRAY, anchor="mm")
        p_sub = ease(seg(t, 0.75, 0.95))
        img = self._fade_text(img, c.get("sub", ""), WIDTH // 2, 860, font(30), GRAY, p_sub)
        return img

    # ---- 7. closing
    def scene_closing(self, img, d, t):
        c = self.cfg["closing"]
        p1 = ease(seg(t, 0.05, 0.4))
        p2 = ease(seg(t, 0.35, 0.7))
        p3 = ease(seg(t, 0.65, 0.95))
        # P1: cap the closing headline to MAX_HEAD_W (it measured 85% wide at 80).
        cl = fit_font(80, True, max(c["headline"].split("\n"), key=len), MAX_HEAD_W, floor=40)
        img = self._fade_text(img, c["headline"], WIDTH // 2, 330, font(cl, True),
                              WHITE, p1, glow=CYAN)
        if c.get("headline2"):
            h2 = fit_font(58, True, c["headline2"], MAX_HEAD_W, floor=30)
            img = self._fade_text(img, c["headline2"], WIDTH // 2, 430, font(h2, True),
                                  PURPLE, p1, glow=CYAN)
        img = self._fade_text(img, c["sub"], WIDTH // 2, 515, font(32), GRAY, p2)
        if p2 > 0:
            url = c["repo"]
            shown = url[: max(0, int(len(url) * ease_out(seg(t, 0.45, 0.95))))]
            fnt = font(34, True)
            w = fnt.getlength(shown) + 96
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            chip = (20, 28, 60) if WHITE[0] > 128 else (255, 255, 255)
            # issue 2b: sit the chip centred in the gap between sub-line (515)
            # and the badges (720) instead of floating high near the sub-line
            chip_y = 600
            ld.rounded_rectangle([WIDTH // 2 - w // 2, chip_y, WIDTH // 2 + w // 2, chip_y + 80],
                                 radius=40, fill=(*chip, 240), outline=CYAN, width=2)
            ld.text((WIDTH // 2 - w // 2 + 48, chip_y + 40), shown, font=fnt,
                    fill=WHITE, anchor="lm")
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        if p3 > 0:
            fnt = font(24, True)
            gap = 34
            widths = [fnt.getlength(b) + 64 for b in c["badges"]]
            total = sum(widths) + gap * (len(c["badges"]) - 1)
            bx = WIDTH // 2 - total // 2
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            chip = (24, 28, 60) if WHITE[0] > 128 else (255, 255, 255)
            for i, b in enumerate(c["badges"]):
                by = 720
                ld.rounded_rectangle([bx, by, bx + widths[i], by + 58], radius=29,
                                     fill=(*chip, int(225 * p3)),
                                     outline=(*CYAN, int(140 * p3)), width=2)
                ld.text((bx + widths[i] // 2, by + 28), b, font=fnt,
                        fill=(*CYAN, int(255 * p3)), anchor="mm")
                bx += widths[i] + gap
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        if p3 > 0:
            img = self._fade_text(img, c.get("credit", ""), WIDTH // 2, 940, font(24), DIM, p3)
        return img

    # ----------------------------------------------------------------
    def render(self, out_dir: Path, output: str):
        scenes = [
            ("title", self.scene_title, self.cfg["title"]["duration"]),
            ("problem", self.scene_problem, self.cfg["problem"]["duration"]),
            ("detection", self.scene_detection, self.cfg["detection"]["duration"]),
            ("product", self.scene_product, self.cfg["product"]["duration"]),
            ("architecture", self.scene_architecture, self.cfg["architecture"]["duration"]),
            ("heatmap", self.scene_heatmap, self.cfg["heatmap"]["duration"]),
            ("formfill", self.scene_formfill, self.cfg["formfill"]["duration"]),
            ("metrics", self.scene_metrics, self.cfg["metrics"]["duration"]),
            ("closing", self.scene_closing, self.cfg["closing"]["duration"]),
        ]
        fade = int(0.35 * FPS)
        out_dir.mkdir(parents=True, exist_ok=True)
        idx = 0
        total = 0
        for name, fn, dur in scenes:
            n = int(dur * FPS)
            for i in range(n):
                img, d = base_layer()
                t = (i + 0.5) / n
                img = fn(img, d, t)
                f = 1.0
                if i < fade:
                    f = i / fade
                elif i >= n - fade:
                    f = (n - 1 - i) / fade
                if f < 1.0:
                    bg = _bg_cache["bg"].copy()
                    img = Image.blend(bg, img, f)
                img.save(out_dir / f"frame_{idx:05d}.png")
                idx += 1
                if idx % 150 == 0:
                    print(f"  frame {idx}/{total or '?'}", flush=True)
            total += n
        print(f"rendered {idx} frames")
        vf = Path(output)
        # P4: CRF 16 + aq-mode kills the banding the old CRF 22/363kbps showed.
        cmd = [
            "ffmpeg", "-y", "-framerate", str(FPS), "-i", str(out_dir / "frame_%05d.png"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "16",
            "-x264-params", "aq-mode=3:deblock=-1,-1",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(vf),
        ]
        print("encoding...")
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"done -> {vf}")


# config with all copy text ------------------------------------------------
DEFAULT_CONFIG = {
    "title": {
        "duration": 5.5,
        "kicker": "SIH 2026  ·  PS171  ·  BROWSER AGENT",
        "headline": "On-Device",
        "headline2": "Visual Perception",
        "subheadline": "Your browser. Your data. Never the cloud.",
        "badges": ["PII Shield", "Secure Autofill", "Privacy Ledger"],
    },
    "problem": {
        "duration": 7,
        "headline": "Every form you fill\nsends PII to the cloud.",
        "lines": [
            "Agents that read your page",
            "can leak Aadhaar, PAN, bank details",
            "to third-party APIs.",
        ],
        "leaking": ["PAN", "Aadhaar", "IFSC", "Card"],
    },
    "detection": {
        "duration": 10,
        "url": "gov.in/apply/subsidy",
        "headline": "We built the shield into the browser.",
        "count": 9,
    },
    "architecture": {
        "duration": 9,
        "headline": "Privacy-first by architecture.",
        "left_title": "EXTENSION · WXT MV3 (on-device)",
        "right_title": "PLANNER · FastAPI (server)",
        "left_blocks": [
            {
                "title": "Vision Pipeline",
                "items": [
                    "Screenshot capture · ~50ms",
                    "Florence-2 ONNX · WebGPU",
                    "Set-of-Marks overlay · ~10ms",
                    "DOM fast-path · ~10ms",
                ],
            },
            {
                "title": "Privacy Engine",
                "items": [
                    "PII detection · Aadhaar / PAN / Luhn",
                    "Redaction · blur + text mask",
                    "Tamper-proof privacy ledger",
                ],
            },
        ],
        "right_blocks": [
            {
                "title": "Planner Service",
                "items": [
                    "Context builder (sanitized only)",
                    "Action planner · state manager",
                    "Validation middleware",
                ],
            },
            {
                "title": "LLM Inference",
                "items": [
                    "Ollama · qwen2.5:1.5b (local)",
                    "Cloud API (OpenAI-compatible)",
                    "Graceful fallback strategy",
                ],
            },
        ],
        "fw": "metadata · 0 PII",
        "rev": "JSON action",
    },
    "product": {
        "duration": 5,
        "url": "chrome-extension://···/popup",
        "headline": "This is the actual product.",
        "sub": "Task panel · live PII detections · tamper-proof privacy ledger.",
    },
    "heatmap": {
        "duration": 8,
        "url": "localhost/pii-test-page",
        "headline": "Precision, not noise.",
        "sub": "Context-aware filtering: price tables and headings are ignored.",
    },
    "formfill": {
        "duration": 9,
        "url": "localhost/mock-form",
        "headline": "Autofill that never leaks.",
        "done": "✓  Form filled · 0 PII uploaded",
    },
    "metrics": {
        "duration": 7,
        "headline": "Battle-tested, production-grade.",
        "stats": [
            {"value": 240, "label": "unit + e2e tests passing"},
            {"value": 1.21, "decimals": 2, "suffix": " MB", "label": "total build size"},
            {"value": 100, "suffix": "%", "label": "on-device, zero uploads"},
        ],
        "sub": "Chromium + Firefox · MV3 + MV2 · 30 fps ready",
    },
    "closing": {
        "duration": 7,
        "headline": "The browser agent",
        "headline2": "that respects your privacy.",
        "sub": "Built by 6 engineers for SIH 2026 — ISRO challenge PS171.",
        "repo": "github.com/Yashop965/sih2026-ps171-browser-agent",
        "badges": ["ISRO · SIH 2026", "Open Source", "v1.0"],
        "credit": "Built with WXT + Playwright + ffmpeg",
    },
}


def load_config():
    p = Path(__file__).parent / "ad_config.json"
    if p.exists():
        base = json.loads(p.read_text())
    else:
        base = dict(DEFAULT_CONFIG)
        p.write_text(json.dumps(base, indent=2))
        print(f"wrote default config -> {p}")
    # deep-merge: fill missing sub-keys from DEFAULT so a partial block in
    # ad_config.json (e.g. {"architecture": {"duration": 7.5}}) never drops
    # the full data (left_blocks/right_blocks/fw/rev) that only DEFAULT holds.
    for k, dv in DEFAULT_CONFIG.items():
        if k not in base:
            base[k] = dv
        elif isinstance(dv, dict) and isinstance(base[k], dict):
            for sk, sv in dv.items():
                base[k].setdefault(sk, sv)
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="all",
                    choices=list(THEMES.keys()) + ["all"])
    ap.add_argument("--frames", default=None)
    args = ap.parse_args()
    config = load_config()
    # "all" renders black first (user-preferred lead theme), then project, light
    if args.theme == "all":
        themes = ["black", "project", "light"]
    else:
        themes = [args.theme]
    for th in themes:
        set_theme(th)
        stem = f"SIH2026_PS171_YC_Ad_{th}"
        frames = Path(args.frames) if args.frames else Path(__file__).parent / f"frames_{th}"
        out = ROOT / f"{stem}.mp4"
        Scenes(config, ROOT).render(frames, out)


if __name__ == "__main__":
    main()
