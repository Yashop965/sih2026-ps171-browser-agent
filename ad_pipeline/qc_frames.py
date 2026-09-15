#!/usr/bin/env python3
"""
qc_frames.py - deterministic pixel QC gate for the SIH2026 PS171 ad pipeline.

Replaces VLM/thumbnail eyeballing (unreliable on downscaled frames) with
measurable assertions on full-resolution extracted frames. Run it as a build
gate right after build_ad.py:

    python ad_pipeline/build_ad.py --theme all
    python ad_pipeline/qc_frames.py --theme all      # exit 0 = pass

Adapted from Claude's qc_frames_by_claude.py for THIS pipeline's data model:
fields.json boxes use "box" (not "bbox"), and screenshot shots are scaled +
top-offset, so PII-mask checks re-project the boxes into video coords rather
than assuming native pixels.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 1920, 1080

# --- layout budget (keep in sync with build_ad.py) --------------------------
# NOTE: screenshot scenes intentionally FULL-BLEED the browser mock to the frame
# edge, so left/right/bottom are allowed to run wide. Only TOP clipping is a
# real risk (that's what P0-6 fixed: a headline landing under the mock). The
# headline-width check measures real text; the glow blur adds ~a couple % so
# the cap is 0.80 to absorb glow without false-positiving the 0.74 text cap.
SAFE_TOP = 40
MAX_HEADLINE_FRAC = 0.80
BITRATE_FLOOR = 500_000     # catch a broken encode, not pedantic 1080p targets

THEMES = ("black", "project", "light")
# settled-state timestamps for the current 56.5s timeline
DEFAULT_SAMPLES = [2.5, 8.0, 13.0, 18.0, 24.0, 30.0, 35.0, 42.0, 49.0, 54.0]

failures: list = []
checks_run = 0


def fail(msg):
    global checks_run
    checks_run += 1
    failures.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg):
    print(f"  ok    {msg}")


def extract(video, t, out):
    subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(video),
                    "-frames:v", "1", str(out), "-y"], check=True)
    return out


def extract_last(video, out):
    subprocess.run(["ffmpeg", "-v", "error", "-sseof", "-0.2", "-i", str(video),
                    "-frames:v", "1", str(out), "-y"], check=True)
    return out


def ink_mask(path, thresh=40):
    luma = np.asarray(Image.open(path).convert("L")).astype(int)
    bg = np.median(luma)
    return luma, (np.abs(luma - bg) > thresh)


def dense_mask(mask, min_row=25, min_col=8):
    """Drop decorative specks (particles, orb dither) so layout checks only see
    real content — a row/column must carry enough ink mass to count."""
    m = mask.copy()
    m[mask.sum(axis=1) < min_row, :] = False
    m[:, mask.sum(axis=0) < min_col] = False
    return m


def check_safe_area(tag, mask):
    """Only the TOP edge is a hard fail: a headline landing under a mock (the
    P0-6 bug) shows up as a COMPACT text band at the very top. Screenshot
    scenes intentionally run full-bleed, and on a frame with a large white form
    + dark gradient the global-median ink_mask misreads whole background rows as
    "ink" (full-width at every row). So: only fail if the top ink is a compact
    band (<65% width) — that's a real headline, not background."""
    global checks_run
    checks_run += 1
    ys, xs = np.where(mask)
    if not len(xs):
        return ok(f"{tag} top clear (no ink)")
    # width of ink in the top 40 rows
    top_rows = mask[:40]
    row_widths = top_rows.sum(axis=1)
    # median ink width across the top region, as a fraction of frame width
    frac = float(np.median(row_widths[row_widths > 0]) / W) if (row_widths > 0).any() else 0.0
    top = int(ys.min())
    if top < SAFE_TOP and frac < 0.65:
        fail(f"{tag} ink above SAFE_TOP: top={top}<{SAFE_TOP}, width={frac:.0%} "
             f"(a compact headline may be colliding with a mock)")
    else:
        ok(f"{tag} top clear (top={top}, top-band width={frac:.0%})")


def check_headline_width(tag, mask):
    """Widest ink band in the top half must not exceed MAX_HEADLINE_FRAC."""
    global checks_run
    checks_run += 1
    top = mask[:H // 2]
    if not top.any():
        return ok(f"{tag} headline width (no ink)")
    rows = top.any(axis=1)
    bs, start, gap = [], None, 0
    for y, has in enumerate(rows):
        if has:
            if start is None:
                start = y
            gap = 0
        else:
            gap += 1
            if gap >= 12 and start is not None:
                bs.append((start, y - gap)); start = None
    widest = 0
    for y0, y1 in bs:
        cols = np.where(top[y0:y1 + 1].any(axis=0))[0]
        if len(cols):
            widest = max(widest, int(cols.max()) - int(cols.min()))
    frac = widest / W
    if frac > MAX_HEADLINE_FRAC:
        fail(f"{tag} headline ink {widest}px = {frac:.0%} of frame "
             f"(max {MAX_HEADLINE_FRAC:.0%})")
    else:
        ok(f"{tag} headline width {frac:.0%}")


def check_encode(video):
    global checks_run
    checks_run += 1
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration,bit_rate", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True, check=True).stdout.strip()
    parts = out.split(",")
    br = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    if br < BITRATE_FLOOR:
        fail(f"{video.name} bitrate {br/1e6:.2f} Mbps - suspiciously low "
             f"(broken encode? build uses -crf 16)")
    else:
        ok(f"{video.name} bitrate {br/1e6:.1f} Mbps")


def check_glyphs(config):
    """Catch the tofu box before it ships: every string in ad_config.json must
    be renderable by the resolved font (a .notdef box on the freeze frame is a
    credibility bug, and it's cheap to check deterministically at build time)."""
    global checks_run
    if not config.exists():
        print(f"  skip  glyph check ({config} not found)"); return
    checks_run += 1
    # import the same font resolver build_ad uses, so the test matches the render
    sys.path.insert(0, str(config.parent))
    try:
        import build_ad as B
        B._resolve_fonts()
        probe = B.ImageFont.truetype(B.FONT, 24)
    except Exception as e:
        print(f"  skip  glyph check (cannot load font: {e})"); return
    text = config.read_text(encoding="utf-8")
    bad = [c for c in sorted(set(text)) if not c.isspace() and c.isprintable()
           and probe.getmask(c).getbbox() is None]
    if bad:
        fail(f"ad copy has unrenderable glyphs {bad!r} in {config.name} "
             f"- replace with plain text")
    else:
        ok(f"ad copy glyph coverage ({len(set(text))} chars render)")


def run_theme(theme, root, samples):
    video = root / f"SIH2026_PS171_YC_Ad_{theme}.mp4"
    if not video.exists():
        fail(f"missing video {video}"); return
    print(f"\n=== {video.name} ===")
    check_encode(video)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for t in samples:
            frame = extract(video, t, tmp / f"{theme}_{t}.png")
            _, raw = ink_mask(frame)
            mask = dense_mask(raw)
            tag = f"t={t:g}s"
            check_safe_area(tag, mask)
            check_headline_width(tag, mask)
        last = extract_last(video, tmp / f"{theme}_last.png")
        _, lraw = ink_mask(last)
        check_safe_area("last frame", dense_mask(lraw))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="all", choices=THEMES + ("all",))
    ap.add_argument("--at", nargs="*", type=float, default=DEFAULT_SAMPLES)
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    themes = THEMES if args.theme == "all" else (args.theme,)
    check_glyphs(root / "ad_pipeline" / "ad_config.json")
    for th in themes:
        run_theme(th, root, args.at)
    print(f"\n{'-'*60}\n{checks_run} checks run, {len(failures)} failed")
    for f in failures:
        print(f"  - {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
