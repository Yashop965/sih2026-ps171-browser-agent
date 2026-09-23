#!/usr/bin/env python3
"""Standalone proof-clip assembler — the "real task + receipts" asset.

Renders just scene_run + scene_receipts + a branded CTA (reusing build_ad's
theme + scene machinery), then encodes:
  * a wide 1920x1080 clip (site hero)
  * a vertical 1080x1920 reframe (email / LinkedIn)

No audio here — this is the silent proof loop; attach ElevenLabs VO later if
wanted. 100% programmatic (Pillow -> ffmpeg), zero recordings.

Usage (run with a python that has PIL+numpy; from agent/):
    python ad_pipeline/assemble_clip.py --theme machina --out agency/clip
"""
import argparse
import shutil
import subprocess
from pathlib import Path

import build_ad
from build_ad import (Scenes, base_layer, ease, seg, font, rounded_panel,
                      WIDTH, HEIGHT, FPS, set_theme, load_config)
from PIL import Image, ImageDraw, ImageFilter

CLIP_ROOT = Path(__file__).resolve().parent
REPO_ROOT = CLIP_ROOT.parent  # agent/


def _scene_cta(img, d, t):
    """Branded close: seal + repo + tagline. Uses build_ad's theme globals."""
    c = build_ad.GREEN
    p1 = ease(seg(t, 0.0, 0.4))
    p2 = ease(seg(t, 0.25, 0.7))
    p3 = ease(seg(t, 0.55, 0.95))
    cx, cy = WIDTH // 2, 430
    if p1 > 0:
        d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90],
                  fill=(*build_ad.PANEL[:3], int(210 * p1)),
                  outline=(*c, int(255 * p1)), width=3)
        d.text((cx, cy - 20), "MACHINA", font=font(40, True),
               fill=(*build_ad.WHITE, int(255 * p1)), anchor="mm")
        d.text((cx, cy + 34), "browser agent", font=font(24),
               fill=(*build_ad.GRAY, int(255 * p1)), anchor="mm")
    tag = "One machine, the work finished — and logged."
    f2 = font(build_ad.fit_font(44, True, tag, build_ad.MAX_HEAD_W, floor=24))
    # fade the tagline through a glow layer for the premium look
    if p2 > 0:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.text((cx, 640), tag, font=f2, fill=(*build_ad.CYAN, int(150 * p2)), anchor="mm")
        layer = layer.filter(ImageFilter.GaussianBlur(10))
        ld = ImageDraw.Draw(layer)
        ld.text((cx, 640), tag, font=f2, fill=(*build_ad.WHITE, int(255 * p2)), anchor="mm")
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
    url = "machina-ten.vercel.app"
    if p3 > 0:
        d = ImageDraw.Draw(img, "RGBA")
        f3 = font(34, True)
        w = f3.getlength(url) + 96
        d.rounded_rectangle([cx - w // 2, 720, cx + w // 2, 720 + 80], radius=40,
                            fill=(*build_ad.PANEL[:3], int(240 * p3)),
                            outline=(*build_ad.CYAN, int(200 * p3)), width=2)
        d.text((cx, 760), url, font=f3, fill=(*build_ad.WHITE, int(255 * p3)), anchor="mm")
    return img


def render_clip(theme, out_mp4, durations, cta_text_url):
    set_theme(theme)
    config = load_config()
    scenes = Scenes(config, REPO_ROOT)

    blocks = [
        ("run", scenes.scene_run, durations["run"]),
        ("receipts", scenes.scene_receipts, durations["receipts"]),
        ("cta", _scene_cta, durations["cta"]),
    ]
    frames = CLIP_ROOT / f"frames_{theme}_clip"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)

    fade = int(0.25 * FPS)
    idx = 0
    for name, fn, dur in blocks:
        n = int(dur * FPS)
        for i in range(n):
            img, d = base_layer()
            tt = (i + 0.5) / n
            img = fn(img, d, tt)
            f = 1.0
            if i < fade:
                f = i / fade
            elif i >= n - fade:
                f = (n - 1 - i) / fade
            if f < 1.0:
                img = Image.blend(build_ad._bg_cache["bg"].copy(), img, f)
            img.save(frames / f"frame_{idx:05d}.png")
            idx += 1
            if idx % 90 == 0:
                print(f"  clip frame {idx}", flush=True)
    print(f"rendered {idx} clip frames")

    cmd = [
        "ffmpeg", "-y", "-framerate", str(FPS), "-i", str(frames / "frame_%05d.png"),
        "-c:v", "libx264", "-preset", "slow", "-crf", "17",
        "-x264-params", "aq-mode=3:deblock=-1,-1",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_mp4),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"wide clip -> {out_mp4}")
    return out_mp4


def make_vertical(src, dst):
    """Reframe 1920x1080 -> 1080x1920: blurred full-frame bg + sharp centred box."""
    vf = ("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
          "boxblur=20:2,eq=brightness=-0.08[bg];"
          "[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2")
    cmd = ["ffmpeg", "-y", "-i", str(src), "-filter_complex", vf,
           "-c:v", "libx264", "-preset", "slow", "-crf", "18",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"vertical clip -> {dst}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="machina", choices=list(build_ad.THEMES) + ["all"])
    ap.add_argument("--out", default=str(CLIP_ROOT.parent.parent / "agency" / "clip"),
                   help="output dir for the clips")
    ap.add_argument("--run", type=float, default=5.0, help="scene_run seconds")
    ap.add_argument("--receipts", type=float, default=6.0, help="scene_receipts seconds")
    ap.add_argument("--cta", type=float, default=4.0, help="cta seconds")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    durations = {"run": args.run, "receipts": args.receipts, "cta": args.cta}

    wide = out_dir / f"real-task-clip-wide-{args.theme}.mp4"
    render_clip(args.theme, wide, durations, "machina-ten.vercel.app")
    vert = out_dir / f"real-task-clip-vertical-{args.theme}.mp4"
    make_vertical(wide, vert)

    # stills for thumbnails (task / receipt / cta)
    total = int((durations["run"] + durations["receipts"] + durations["cta"]) * FPS)
    for label, frac in (("task", durations["run"] / total),
                        ("receipt", (durations["run"] + durations["receipts"] / 2) / total),
                        ("cta", 0.92)):
        sec = min(total - 1, int(frac * total))
        still = out_dir / f"clip-{label}.png"
        subprocess.run(["ffmpeg", "-y", "-ss", str(sec / FPS), "-i", str(wide),
                        "-frames:v", "1", str(still)], check=True, capture_output=True)
    print(f"done. clips + stills in {out_dir}")


if __name__ == "__main__":
    main()
