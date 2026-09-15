# HANDOFF BRIEF — SIH2026 PS171 "Ad-Video Pipeline" (for a pro model)

Copy this entire document into any LLM (Claude/GPT/others). It is self-contained:
project context, what we're building, current architecture, verified issues, tooling
assessment, and open decisions. Ask the model for: (a) a better execution path, (b)
tooling recommendations, (c) a revised shot list / design critique.

---

## 1. PROJECT CONTEXT

- **Repo:** https://github.com/Yashop965/sih2026-ps171-browser-agent
- **What it is:** SIH 2026 (Smart India Hackathon, ISRO college internal round),
  Problem Statement PS171 — "On-device Visual Perception for Light-weight Browser
  Agents". We built a Chrome (MV3) + Firefox (MV2) extension, a WXT browser agent
  that can complete multi-step web tasks (form filling etc.) while guaranteeing no PII
  leaves the device.
- **Core privacy architecture (from docs/PRD.md §2):**
  - Client (extension): content script (DOM extractor, vision worker, PII engine,
    session manager) + background service worker + React popup (TaskPanel,
    Set-of-Marks overlay, Privacy Ledger, Latency HUD).
  - Vision: Florence-2-base-ft ONNX (~180MB weights, ~200MB RAM) via WebGPU/
    Transformers.js, lazy-loaded. Set-of-Marks overlay renderer (~10ms). Parallel
    DOM fast-path (~10ms, handles 80%+ of structured forms).
  - Privacy Engine: PII detection (Aadhaar-Verhoeff, PAN, card-Luhn, UPI/IFSC,
    passwords) → redaction (canvas blur, text mask, field block) → tamper-proof
    Privacy Ledger (circular buffer, 500 entries).
  - Only **sanitized metadata** (element ids/roles/labels/boxes, task, step,
    checksum — zero pixels, zero raw DOM, zero PII) is POSTed to a local
    FastAPI planner.
  - Server: FastAPI planner (context builder → action planner → state manager) +
    LLM inference with local Ollama (qwen2.5:1.5b) as primary and
    OpenAI-compatible cloud API as fallback. Returns JSON actions
    (CLICK/TYPE/SCROLL/SELECT + confidence + reasoning).
  - Budgets: client ~270-300MB RAM (limit 500MB), server ~1.25GB (unbounded).
- **State:** 240/240 tests passing (vitest), 1.21MB total build, PII false
  positives cut 722→~15 via context-aware filtering, security hardening done
  (XSS, PII masking, URL sanitization, memory leaks, HTTPS).
- **Team (6):** Himanshi (UI), Anirudh (DOM), Yuvraj (backend), Laavannya (PII),
  Yash (optimization/testing, project lead for this pipeline), Vedant (tests).
- **User profile:** Yash wants: English only, concise output, parallel subagent
  work, screen visibility while testing, modern UI, no verbose narration.

## 2. THE TASK

Produce a ~60s YC/SaaS-launch-style **advertisement video** for the project
(style refs: "SaaS Explainer Video for YC AI Startup" and "Zelios Teamble" demo
videos on YouTube — big kinetic type, real product UI front-and-center, dark
cinematic, motion-graphics metric cards). No manual screen recording; everything
generated programmatically end-to-end. Additionally the same ad must exist in
**multiple visual themes**, with the **black theme as the lead** (user preference),
plus a "project" theme (indigo, complements the extension UI) and a "light"
theme (warm paper, matches Popup.css). Audio (music + voiceover) is built but
**deliberately deferred** — user said fix visuals first.

## 3. CURRENT PIPELINE (all local, no installs needed)

```
C:\Users\yashs\SIH2026\ps171-browser-agent\
├─ scripts/capture_ui_screens.mjs   Playwright (ESM .mjs, NOT .js — package.json
│                                   "type":"module"): opens public/pii-test-page.html,
│                                   public/mock-form.html, public/mock/government-portal.html
│                                   in headless Chromium @1440px 2x, fills PII fields with
│                                   sample values, records every input's bbox + isPii +
│                                   sample value → screenshots/*.png (+ _blank variants)
│                                   and screenshots/fields.json
├─ ad_pipeline/build_ad.py          Pillow frame renderer, 1920x1080@30fps → ffmpeg libx264
│                                   (1) FONT_SCALE=1.65 global type multiplier
│                                   (2) THEMES dict: project / black / light — palette +
│                                       chrome/body/cloud fills + orb/particle intensity;
│                                       WHITE doubles as text color so light auto-inverts
│                                   (3) 8 scenes, all copy in ad_pipeline/ad_config.json:
│                                       title → problem → detection (real gov-portal
│                                       screenshot, scan sweep, PII chips, masked values,
│                                       counter) → ARCHITECTURE (new: two-panel diagram from
│                                       PRD: extension Vision/Privacy blocks vs planner/LLM
│                                       blocks, animated packets, "0 PII crosses the line"
│                                       seal) → heatmap (accuracy) → formfill (blank form,
│                                       values type in) → metrics (3 count-up cards) → closing
│                                   (4) overlays anchored to fields.json bboxes → shows REAL UI
├─ ad_pipeline/assemble_final.py    numpy-synthesized ambient music bed +
│                                   edge-tts 7.x voiceover (async Communicate API) +
│                                   ffmpeg adelay/amix mux. NARRATION re-aligned to
│                                   the 62.5s / 8-scene timeline (architecture-aware
│                                   copy, text-hashed clip names to avoid stale TTS
│                                   cache). Still deferred: user said fix visuals
│                                   first.
├─ screenshots/                     (generated; git-ignored? no — committed once, fine)
└─ SIH2026_PS171_YC_Ad_{black,project,light}.mp4   (current deliverables, ~62.5s each)
```

Reproduce: `node scripts/capture_ui_screens.mjs` → `python ad_pipeline/build_ad.py
--theme all` → (optional) `python ad_pipeline/assemble_final.py --theme black`.

Local tooling: ffmpeg 8.1 (full MSYS build: x264/x265/svtav1/vmaf/whisper),
Python 3.14 (Pillow 11, numpy 2.5, edge-tts 7.2.8), Node 24 + Playwright 1.63
(chromium installed), Ollama CLI present (service not running), git-bash shell.

## 4. VERIFIED ISSUES & FIXES (this session)

**Fixed:**
0. **"All text too small" — ROOT CAUSE: broken font path.** `build_ad.py`
   pointed `FONT`/`FONT_B` at `C:/Windows/Fonts/Segoe UI.ttf` /
   `Segoe UI Bold.ttf`. Those filenames DO NOT EXIST on Windows (real files:
   `segoeui.ttf` / `segoeuib.ttf`). So `ImageFont.truetype()` raised, and the
   silent except branch returned Pillow's **10px bitmap default font** —
   every string in every video rendered at ~10px no matter what size we
   requested. Fix: a `_resolve_fonts()` that walks a fallback list
   (segoeui → arial → calibri → bahnschrift), resolves to a pair that
   exists on disk, and prints a loud WARN if it can't. Verified: `font(82,True)`
   now loads a 135px truetype ("On-Device" spans 661px) instead of the 10px
   bitmap. **This was the bug behind the user's "fonts are too small"
   complaint across all 3 themes** — not a scale-factor problem.
   With real fonts, a `fit_font()` auto-fit helper now guards every
   fixed-width container (title cards, detection chips, metrics numbers,
   arch panel titles/items, heatmap card, counter chip, problem headline)
   against overflow, because truetype text is 3-4x wider than the bitmap
   fallback had been.
1. **Problem-scene "empty box" bug** — form fields were drawn on the base-layer
   draw object, then the opaque mini-browser canvas was pasted on top, erasing
   them. Fix: draw fields on the local `mini` canvas in local coords before the
   paste. (Root cause class: Pillow stale-draw-object-after-composite; this is
   the #1 recurring bug in this codebase.)
2. **Light-theme "wrong colors"** — chrome/body/cloud fills were hardcoded dark
   navy (fine on dark themes, clash on paper). Fix: added `CHROME_FILL`,
   `BODY_FILL`, `CLOUD_FILL` to every theme entry; `paste_screenshot` + problem
   scene now use them. Light `GREEN` raised to (22,101,52) for contrast.
3. **Architecture scene label overflow** — long center labels (~750px wide)
   spilled into side panels. Fix: shorter labels ("metadata · 0 PII", "JSON
   action") + wider gap (panels 70/1110) + compact 270px seal chip.
4. **Type scale** — global FONT_SCALE raised 1.5 → 1.65 (moot before fix #0,
   still correct after it).

**Open (need pro-model input / next round):**
- **A1. Title-card hero type is now TOO LARGE** (user verdict §4b: 1.65
  overshot the previous 10px-bitfont bug fix). DECISION: dial FONT_SCALE back
  to ~1.45-1.55, or make the title-card hero its own scale independent of the
  global multiplier. Also improve composition (kicker, spacing, card icons
  are currently plain ellipses — real glyphs would read more premium).
- **A2. Vision-model QC is unreliable on downscaled thumbnails** — it
  misreported "headline missing", "type too small", "Pll Shield" typo on
  frames that measured large/correct at full res. Mitigation now: QC only
  full-res extracted frames + pixel measurement. DECISION: keep manual QC or
  build an automated pass (e.g. render stills → local VLM via Ollama, or
  pixel-diff assertions for text presence)?
- **A3. Audio** — NARRATION re-aligned to the 62.5s/8-scene timeline
  (done this session). Remaining: actually render the voiced+music final
  (`python ad_pipeline/assemble_final.py`) once visuals are approved —
  still deferred per user.
- **A4. Screenshot framing "premium" feel** — user compared to YC refs and
  wanted screenshots to feel more cinematic (bigger, less dead space).
  Current SHOT_W/H = 1240×850 on 1920×1080 (reduced from 1320×900 so text can
  live around the shot). DECISION: push back to ~1400-1500 wide with tighter
  vertical layout, or add subtle parallax/ken-burns on the shot (ffmpeg
  zoompan or per-frame Pillow resize)?
- **A5. Scene pacing — user-confirmed too slow** (§4b: "just need it a little
  fast paced, we will do it later"). detection 10s + architecture 9s drag the
  middle. Propose trims to ~50-54s total, or ~15-20% faster count-up/stagger.
- **A6. Light theme colors — confirmed fixed** (this session's QC: dark text
  on warm-paper bg, no clash; chrome/body/cloud fills now theme-aware).
  Re-derive strictly from Popup.css vars only if the user still objects.
- **A7. Stale artifacts** — SIH2026_PS171_YC_Ad_v2.mp4 + _FINAL.mp4
  (pre-theme, old 7-scene audio) still in repo root; old scratch files
  (generate_yc_video.py, capture_screenshots.py era, old MP4s) clutter root.
  DECISION: clean up / move to a releases/ folder / delete?

## 4b. USER VERDICT ON LATEST RENDER (Sep 15)

- **Positive:** "video turned out great, every transition is smooth."
- **Text now TOO LARGE** — the 10px-bitfont bug was fixed at FONT_SCALE 1.65 and
  it overshot. User checked the `project` theme and wants type dialed back.
  **DECISION: propose FONT_SCALE ~1.45-1.55** (measure headline ink widths with
  the `_measure` pattern again after the change) and consider hero-only scaling
  for the title card instead of a global multiplier.
- **Pacing too slow** — user wants it "a little fast paced"; explicitly said
  "we will do it later," so keep it on the list, not top priority. Concrete
  idea: trim per-scene durations (e.g. 62.5s → ~50-54s) or speed up
  count-up/stagger timings by ~15-20%.
- User will take HANDOFF.md to a pro model for outside input; keep the doc
  current.

## 5. TOOLING ASSESSMENT (user asked: "if our tools aren't good enough, use
other tools found locally")

- **Sufficient as-is:** ffmpeg + Pillow + numpy + edge-tts + Playwright. This
  stack produced working multi-theme MP4s; no new installs were needed.
- **Already on the machine (no install):**
  - **moviepy 2.2.1** — pure-Python programmatic video editing (cuts,
    concatenation, compositing, text overlays, audio). Wraps ffmpeg. Could
    replace the hand-rolled ffmpeg concat in `assemble_final.py` with a
    cleaner, more readable editing API for the multi-clip + music + voiceover
    mix. **Biggest "free" win found — confirm it's what we want before
    rewriting the audio mux.**
  - **Ollama** (CLI installed, service not running) — run a local LLM/VLM to
    (a) polish narration copy, (b) auto-QC stills ("describe this frame,
    flag text artifacts"), (c) the project's own planner runs on it, so
    demoing real local inference is a judge-winning bonus. Start:
    `ollama serve` + `ollama pull qwen2.5:1.5b` (matches PRD).
  - **ffmpeg post-filters** — `zoompan`/`scale` for ken-burns on
    screenshots, `vignette`, `eq` for per-theme grading, `acodec` filters
    for music polish. Free wins, no new tool.
- **Agent-native / open-source options found (researched, NOT installed/verified —
  treat claims as unconfirmed):**
  - **browser-use/video-use** — "drop raw footage in a folder, chat with a
    coding agent, get final.mp4 back," 100% open source. Closest to the
    "let an agent do the editing" workflow the user wants; worth a look for
    iteration speed, but it's for *editing existing footage*, not
    programmatic motion-graphics authoring like our Pillow pipeline.
  - **Remotion** (remotion.dev) — React programmatic video, ships official
    **Agent Skills** for coding agents (`npx create-video@latest`). Better
    for complex tweening, 60fps, web-tech authoring; would abandon the
    working Pillow codebase. Only if the team wants web-based authoring.
  - **MCP servers for video editing** — several exist to let an LLM drive
    ffmpeg by natural language: `kush36agrawal/video_editor_mcp`,
    `yubraaj11/ffmpeg-mcp` (FastMCP), `KyaniteLabs/kinocut` (guardrailed,
    trim/caption/repurpose), `mcp-ffmpeg-tools`. Could be wired into Hermes
    via `hermes mcp` / an MCP client so the agent edits without hand-writing
    ffmpeg args. Verify each project's maintenance + Windows/MSYS ffmpeg
    compatibility before adopting.
  - **Motion Canvas / Manim** — alternate code-rendered engines (TS / Python)
    if the animation style ever outgrows Pillow.
- **Recommendation (mine, for the pro model to challenge):** stay on
  Pillow+ffmpeg for *authoring* (it works, reproducible, no new deps for
  teammates); adopt **moviepy** for the audio/multi-clip *mix* step; add
  **Ollama-assisted QC** + ffmpeg post-filters for the cinematic pass. Only
  consider Remotion or an MCP video-editing server if we outgrow per-frame
  Pillow authoring or want 60fps/web authoring.

## 6. CONSTRAINTS / PREFERENCES FOR THE PLAN YOU PRODUCE

- Windows + git-bash (POSIX syntax; PowerShell builtins don't work).
- Python 3.14, ESM JS (`.mjs` for scripts), no new installs unless justified.
- User hates: verbose narration, non-English output, hand-holding,
  fabricated verification. Wants: concrete file paths, real tool output,
  parallelism, "show me on screen".
- Deliverable standard: every claim backed by a command's actual output
  (ffprobe durations, volumedetect, test counts). The repo gate is
  `npm run test` (240 tests, vitest) — ad_pipeline changes are standalone
  Python and don't touch src/ or tests/, so syntax-check + rendered-frame QC
  is the relevant verification for video work.

## 8. FINAL STATE (post external-review round, Sep 15)

Three outside models reviewed: Gemini (`SIH2026_Ad_Pipeline_Review_by_gemini.md`),
ChatGPT (`AGENT_EXECUTION_PLAN_by_chatGPT.md`), Claude
(`AD_PIPELINE_WORK_ORDER_by_claude.py` + `qc_frames_by_claude.py`).

**Route chosen:** Claude's work order = engineering backbone + ChatGPT's
creative layer (hook copy, "0 PII crosses the line" motif, product-first
framing). **Rejected** Gemini's moviepy recommendation — moviepy
decode/re-encode would degrade the CRF-16 motion-graphics deliverable;
authoring stays on Pillow, mux stays on ffmpeg `-c:v copy`.

**P0 credibility fixes (verified against frames + code):**
- Credit-line tofu heart + "Arjun Sharma" typed into both name fields:
  `scripts/capture_ui_screens.mjs` First/Last Name mapping fixed, `fields.json`
  regenerated; heart removed from the credit copy.
- PII mask showing unredacted values: mask inset inflated so it fully covers
  each field.
- Detection headline clipping the mock: headline band reserved in
  `paste_screenshot` (P0-6).
- Arch card breaking its panel: block height + item rows shrunk to fit
  (P2-7).

**P1 typography:** FONT_SCALE 1.65 → 1.45 (user verdict "too large");
metric-derived line height; `HERO_MAX_W` (0.68·W) cap on the title hero;
headline caps on metrics/closing. Title L1/L2 collision fixed — measured
54px clean gap at full res (vision model's "touching" read was the
downscale-thumbnail illusion; measure ground-truth ink, not thumbnails).

**P2/P3/P4:** new **Product-UI scene** (9th) — the real built popup
(`dist/chrome-mv3/popup.html`) captured headless in idle-Live state via
`scripts/capture_extension_ui.mjs` → `screenshots/ext_popup.png` (840×2004
@2x), framed + 3 callouts, placed after detection. Pacing 62.5s → 56.5s
(durations trimmed; arch 9→7.5; new product 5s). Encode upgraded to CRF 16 +
render-time gradient dither (kills the 0.36 Mbps banding) → ~1.7 Mbps / ~11.6 MB.

**P5 QC gate:** `ad_pipeline/qc_frames.py` (adapted from Claude's
`qc_frames_by_claude.py`): deterministic full-res checks — tofu glyph coverage
(tested against the resolved font, not a hardcoded char list), encode bitrate,
top-edge headline-collision (gated on ink-width to ignore full-bleed
screenshots + gradient misreads), headline width. Run as a build gate:
`python ad_pipeline/qc_frames.py --theme all` → **67 checks, 0 failures**.

**Open item reconciled:** Claude's §11 "0.38 MB build" is a false positive.
`dist/chrome-mv3` = 1,208,900 bytes = **1.21 MB (decimal)**; the on-screen
figure is accurate.

**Current deliverables (56.5s, 1920×1080@30, CRF16, all QC-green):**
- `SIH2026_PS171_YC_Ad_black.mp4`  (lead, ~11.6 MB)
- `SIH2026_PS171_YC_Ad_project.mp4` (~12.0 MB)
- `SIH2026_PS171_YC_Ad_light.mp4`  (~11.7 MB)

**Known limitation (documented, not blocking):** the alive/busy popup state
(task + PII rows populated) is a WXT `chrome`-resolution rabbit hole
(`window.chrome` is read-only in headless Chromium; needs
`Object.defineProperty(window,'chrome',{value:STUB})` + `globalThis.browser`).
Only the idle-Live state is captured.

**Still deferred (per user):** `python ad_pipeline/assemble_final.py` to mux
music + edge-tts voiceover into `SIH2026_PS171_YC_Ad_FINAL.mp4` once the
visuals are approved. `assemble_final.py` narration needs re-alignment to the
new 56.5s / 9-scene timeline (was 62.5s/8).

## 8b. USER-REPORTED FIXES + VOICEOVER (Sep 15, round 2)

User flagged 4 issues on the 56.5s build; all fixed + re-rendered + QC-green:
1. **Arch seal "0 PII / crosses the line" spilled past the chip** — widened the
   chip (270→288) and centered the two-line text block inside it; both lines now
   fit, verified in-frame.
2. **Closing "that respects your privacy" written TWICE** — root cause: the
   `ad_config.json` closing `headline` was a 2-line string ending in that phrase
   AND the deep-merge injected DEFAULT's `headline2` = same phrase → rendered
   twice (white + purple ghost). Fixed by making the config headline single-line
   ("The browser agent") so headline=L1 + headline2=L2. Also lowered the github
   chip (y 575→600) to centre it in the gap between the sub-line and the badges.
3. **Title card: kicker nearly touched "On-Device" + bulky badges** — kicker
   moved up 62px (clean gap now); the 3 feature chips shrunk and made variable-
   width so each hugs its own label. NOTE: a `x0` accumulation bug had pushed
   "Privacy Ledger" off-frame (only 2 chips rendered) — found by measuring the
   real video frame, not the vision thumbnail (which kept mis-reporting 2 chips);
   removed the stray `x0 = x + cw + gap` mutation. All 3 chips verified on-frame.
4. **Product popup too small** — the tall portrait popup (840×2004 @2x) was
   height-capped to ~304×725; bumped the frame so it now runs ~full frame height
   (~70–90% depending on theme), annotations clear of it.

**Voiceover + music (previously deferred, now built):** `assemble_final.py`
re-aligned to the 56.5s / 9-scene timeline. `NARRATION` rewritten to 11 concise,
scene-anchored lines carrying the "0 PII crosses the line" motif; TTS (edge-tts
`en-US-AriaNeural`, -8%) cached by content hash; placement is GREEDY by measured
clip duration (no mid-word cutoffs, WARN if a line would overflow the video).
Ambient music bed re-synthesized at 56.5s. Mux uses `ffmpeg -c:v copy` (no video
re-encode) + `amix` (1 input music @0.15 + 11 voice lines) → aac 192k.
Run: `python ad_pipeline/assemble_final.py --theme all`.

**Deliverables (56.5s, 1920×1080@30, CRF16, QC 67/0):**
- silent: `SIH2026_PS171_YC_Ad_{black,project,light}.mp4`
- voiced+music: `SIH2026_PS171_YC_Ad_{black,project,light}_FINAL.mp4`
  (audio mean -28.6 dB / max -8.3 dB, no clipping)

## 9. OPEN ITEMS CARRIED (pre-review §4, now resolved)
- A1 type size → done (FONT_SCALE 1.45, hero cap). A5 pacing → done (56.5s).
- A4 cinematic framing → partial (product scene + ken-burns noted; 1440×810
  shot sizing applied to new work; base SHOT stays 1240×850). A6 light colors
  → confirmed. A2 automated QC → done (`qc_frames.py` gate).
- A7 stale artifacts → still open (`_v2.mp4` / `_FINAL.mp4` / scratch files in
  repo root).

## 10. ASKED OF THE PRO MODEL (all now answered in §8)

0. (User verdict, §4b) Confirm the type-size rollback: FONT_SCALE 1.65 is too
   large — propose exact new value or hero-only scaling, and a faster-pacing
   plan (62.5s → ~50-54s) without losing the smooth transitions.
1. Better execution path for remaining work (A1–A7) in order, with concrete
   commands/edits per item.
2. Shot-list + pacing critique of the 8 scenes vs the two reference SaaS
   videos (title 5.5 / problem 7 / detection 10 / architecture 9 / heatmap 8 /
   formfill 9 / metrics 7 / closing 7 = 62.5s).
3. Tooling call: confirm Pillow+ffmpeg(+moviepy for the mix step) vs switch to
   Remotion/video-use/MCP video-editing servers, trade-offs explicit.
4. Design critique: title-card composition and "premium screenshot" framing
   (what exactly should change in scene_title / paste_screenshot).
5. A safe cleanup plan for stale repo-root artifacts (A7) that won't break the
   team's other workflows (docs/, server/, E2E test pages are in use).
