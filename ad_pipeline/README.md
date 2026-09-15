# Ad Video Pipeline

End-to-end programmatic pipeline for the SIH2026 PS171 launch ad:
**9-scene / 56.5s** motion-graphics video in 3 themes, with real UI
screenshots, edge-tts voiceover, and a synthesized music bed.
Pillow + ffmpeg + numpy + edge-tts. Fully standalone — does **not** touch
`src/` or `tests/`.

## Pipeline (3 steps)

| Step | Command | What it does |
|------|---------|--------------|
| Render | `python ad_pipeline/build_ad.py --theme all` | Pillow frame render → ffmpeg libx264 encode, 1920×1080@30, CRF 16, one silent MP4 per theme |
| QC gate | `python ad_pipeline/qc_frames.py --theme all` | 67 deterministic full-res frame checks (tofu glyphs, banding/bitrate, headline collisions, PII-mask coverage). **Must pass 0 failures before shipping.** |
| Audio | `python ad_pipeline/assemble_final.py --theme all` | edge-tts voiceover + numpy music bed → muxed `_FINAL.mp4` per theme |

```bash
# full run from scratch
rm -rf ad_pipeline/frames_black ad_pipeline/frames_project ad_pipeline/frames_light
python ad_pipeline/build_ad.py --theme all      # or --theme black for one
python ad_pipeline/qc_frames.py --theme all
python ad_pipeline/assemble_final.py --theme all
```

Requires: `ffmpeg`, Python (Pillow, numpy, `edge-tts` for the voice step,
network). Optional upstream capture: `node scripts/capture_ui_screens.mjs`
(web-UI shots) and `node scripts/capture_extension_ui.mjs` (the real
extension popup → `screenshots/ext_popup.png`) — Playwright + Chromium.

## Scenes (9 scenes, 56.5s)

Durations live in `ad_config.json`:

```
title        4.5s   project name + tagline + 3 feature chips
problem      5.0s   "PII to the cloud" pain point + leaking-cloud graphic
detection    8.0s   real gov-portal screenshot, scan sweep, PII highlights (masked)
product      5.0s   THE real extension popup (screenshots/ext_popup.png) — framed, 3 callouts
architecture 7.5s   PRD diagram: extension vs planner, animated packets,
                   "0 PII crosses the line" privacy seal
heatmap      6.0s   PII test page, context-aware filtering ("0 false positives")
formfill     7.5s   blank form, values type in field-by-field, "0 PII uploaded"
metrics      6.0s   3 count-up cards: 240 tests / 1.21 MB build / 100% on-device
closing      7.0s   headline + GitHub chip + badges + credit
```

Overlays are anchored to real field bounding boxes from
`screenshots/fields.json` — the ad shows the actual product, not mockups.

## Themes

`--theme all` renders **black first (the lead theme)**, then project, light:

| Theme | Look |
|-------|------|
| `black` | near-black, bright studio-dark accents — **lead/primary deliverable** |
| `project` | deep indigo-navy, `#6366f1` / emerald `#10b981` / brick `#C2413B` — complements the extension UI |
| `light` | warm paper `#F5F4F1` matching `Popup.css`, text auto-inverts to dark |

Palettes in the `THEMES` dict at the top of `build_ad.py`;
`WHITE` doubles as text color so light theme flips it.

## Conventions

- **Black theme = lead.** `--theme all` orders black → project → light.
- **`FONT_SCALE` 1.45** global type multiplier (1.65 overshot after the
  font-path bugfix; title hero is separately capped by `HERO_MAX_W`).
- **CRF 16 encode + render-time gradient dither** (±2 LSB) — kills 8-bit
  banding, ~1.7 Mbps / ~11.6 MB silent video.
- **"0 PII crosses the line"** — recurring visual motif (arch seal,
  formfill done-chip, narration).
- **QC gate:** `qc_frames.py` (67 checks) must report 0 failures before
  any MP4 ships.
- PII values on screen are always **masked** (`48…12`-style chips).

## Voiceover + music (`assemble_final.py`)

- **Voice:** edge-tts `en-US-AriaNeural`, rate `-8%`. Clips cached by
  content-hash in `ad_pipeline/audio/` — re-runs skip unchanged lines.
- **Placement:** greedy, by *measured* clip duration, so lines never get
  cut mid-word (WARN + skip-overflow if a line would run past the video).
- **Music:** numpy-synthesized 4-chord ambient pad + noise/pulse,
  royalty-free and reproducible; mixed at 0.15 volume.
- **Mux:** `ffmpeg -c:v copy` (no video re-encode) + `amix`
  (music + 11 voice lines) → AAC 192k.
- Narration copy = the `NARRATION` list in `assemble_final.py`; all
  scene copy/durations = `ad_config.json`. Edit config → re-run, no
  code changes for copy.

## Deliverables

The **only** video deliverables (repo root, 56.5s, ~12 MB, aac 192k,
QC 67/0):

| File | Theme |
|------|-------|
| `SIH2026_PS171_YC_Ad_black_FINAL.mp4` | lead (black) |
| `SIH2026_PS171_YC_Ad_project_FINAL.mp4` | indigo, matches extension UI |
| `SIH2026_PS171_YC_Ad_light_FINAL.mp4` | warm paper, matches Popup.css |

All versioned/older MP4s in the root (`_v2`, pre-`_FINAL`, `Clean_*`,
`Production_*`, etc.) and the root `generate_*.py` scripts are obsolete
and being removed by a parallel cleanup — do not link to them.
`ad_config.json`'s `"output"` key still says `..._v2.mp4` but is unused;
`build_ad.py` hardcodes `SIH2026_PS171_YC_Ad_<theme>.mp4`.

## Files

```
scripts/capture_ui_screens.mjs    # Playwright: web-page shots + fields.json
scripts/capture_extension_ui.mjs  # headless capture of dist/chrome-mv3 popup
                                   #   → screenshots/ext_popup.png (idle-Live state)
ad_pipeline/build_ad.py           # Pillow renderer, 9 scenes, 3 themes, CRF16
ad_pipeline/qc_frames.py          # QC gate: 67 deterministic full-res checks
ad_pipeline/ad_config.json        # copy + scene durations (single source of truth)
ad_pipeline/assemble_final.py     # edge-tts + numpy music + ffmpeg mux
ad_pipeline/audio/                # content-hashed TTS cache
ad_pipeline/frames_<theme>/       # rendered frames (regenerate, don't commit)
ad_pipeline/HANDOFF.md            # full session history: issues, reviews, decisions
```

## References

- `ad_pipeline/HANDOFF.md` — complete session history: external-model
  reviews, P0–P5 fixes, user verdicts, tooling assessment.
- Hermes skill `video-generation` (Pillow + ffmpeg slide/scene videos)
  for cross-project patterns.
