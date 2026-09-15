#!/usr/bin/env python3
"""
Final ad assembly: video + ambient music bed (synthesized, royalty-free) +
edge-tts voiceover narration, muxed into one MP4 with ffmpeg.

Usage:
    python ad_pipeline/assemble_final.py \
        --video SIH2026_PS171_YC_Ad_v2.mp4 \
        --out SIH2026_PS171_YC_Ad_FINAL.mp4

Narration lines are aligned to the build_ad.py 9-scene / 56.5s timeline:
title 0-4.5 | problem 4.5-9.5 | detection 9.5-17.5 | product 17.5-22.5
architecture 22.5-30 | heatmap 30-36 | formfill 36-43.5 | metrics 43.5-49.5
closing 49.5-56.5

Lines are placed greedily by MEASURED TTS duration (no mid-word cutoffs):
each line starts at the later of (a) its scene min-start and (b) the previous
line's end + gap, so narration never overlaps or gets trimmed.
"""

import argparse
import hashlib
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent.parent
WORK = Path(__file__).parent / "audio"
VIDEO_DUR = 56.5

MUSIC_VOLUME = 0.15
VOICE_VOICE = "en-US-AriaNeural"
VOICE_RATE = "-8%"
GAP = 0.5            # breathing room between consecutive lines
LEAD_IN = 0.8        # first line starts this far in

# (scene_min_start, text) — 9-scene 56.5s timeline. "0 PII crosses the line"
# is the recurring boundary motif. One idea per line, scene-anchored, short
# enough that greedy placement keeps every line inside its scene window.
NARRATION = [
    (0.8,   "On-device visual perception, for your browser."),
    (4.8,   "Every form you fill leaks PII to the cloud."),
    (10.0,  "So we built the shield into the browser."),
    (14.0,  "It scans on-device and finds every PII field."),
    (18.0,  "This is the actual product."),
    (23.0,  "Privacy first by architecture."),
    (26.5,  "Zero PII ever crosses the line."),
    (30.5,  "Context-aware, so price tables stay untouched."),
    (37.0,  "Autofill that fills everything and uploads nothing."),
    (44.0,  "Two forty tests, a one point two one megabyte build."),
    (49.5,  "The browser agent that respects your privacy. SIH twenty twenty six."),
]


def synth_music(path: Path, duration: float = VIDEO_DUR):
    """Soft ambient pad: four slow chord changes + airy texture + slow pulse."""
    sr = 44100
    n = int(duration * sr)
    t = np.linspace(0, duration, n, endpoint=False)

    chords = [
        [220.00, 261.63, 329.63],   # A C E
        [174.61, 220.00, 261.63],   # F A C
        [130.81, 164.81, 196.00],   # C E G
        [196.00, 246.94, 293.66],   # G B D
    ]
    seg = duration / len(chords)
    out = np.zeros(n, dtype=np.float64)
    for ci, chord in enumerate(chords):
        s0 = int(ci * seg * sr)
        s1 = min(n, s0 + int(seg * sr))
        local = t[s0:s1] - ci * seg
        sig = np.zeros(s1 - s0)
        for f in chord:
            sig += (np.sin(2 * np.pi * f * local)
                    + 0.35 * np.sin(2 * np.pi * f * 2 * local)
                    + 0.18 * np.sin(2 * np.pi * f * 3 * local))
        seg_len = s1 - s0
        fade = max(1, min(int(1.2 * sr), seg_len // 2))
        env = np.ones(seg_len)
        env[:fade] = np.linspace(0, 1, fade)
        env[-fade:] = np.linspace(1, 0, fade)
        out[s0:s1] = sig * env
    out /= np.max(np.abs(out))
    # airy noise texture
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n).astype(np.float32)
    k = np.hanning(sr)
    noise = np.convolve(noise, k, "same")
    out = out + 0.012 * noise
    # slow heartbeat pulse
    out = out * (0.9 + 0.1 * np.sin(2 * np.pi * 0.5 * t))
    pcm = (np.clip(out, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"music -> {path}")


def get_dur(p: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(p)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def make_voiceover(dir_: Path):
    """Synthesize each line to an mp3 cached by content hash. Returns a list of
    (text, path, measured_duration_s) in NARRATION order."""
    import asyncio
    import edge_tts
    clips = []
    for at, text in NARRATION:
        h = hashlib.sha1(f"{VOICE_VOICE}|{VOICE_RATE}|{text}".encode()).hexdigest()[:12]
        out = dir_ / f"v_{h}.mp3"
        if not out.exists():
            tts = edge_tts.Communicate(text, voice=VOICE_VOICE, rate=VOICE_RATE)
            asyncio.run(tts.save(str(out)))
            print(f"tts -> {out.name}  ({text[:38]}...)")
        clips.append((text, out, get_dur(out)))
    print(f"voiceover: {len(clips)} clips")
    return clips


def place_lines(clips, dur=VIDEO_DUR, lead=LEAD_IN, gap=GAP):
    """Greedy placement: each line starts at the later of its scene min-start
    and the previous line's end + gap. Returns [start, end] pairs. No line is
    ever trimmed mid-word; a line that can't fully fit before `dur` gets a
    loud warning so it can be shortened, not silently cut."""
    placed = []
    cursor = lead
    for i, (text, path, d) in enumerate(clips):
        min_start = NARRATION[i][0]
        start = max(min_start, cursor)
        end = start + d
        if end > dur:
            print(f"  WARN line {i} '{text[:30]}...' ends at {end:.1f}s > video "
                  f"{dur}s - shorten this line or it will be trimmed")
        placed.append([start, end])
        cursor = end + gap
    return placed


def mux(video: Path, out: Path):
    WORK.mkdir(parents=True, exist_ok=True)
    dur = get_dur(video)
    music = WORK / "music.wav"
    if not music.exists():
        synth_music(music, dur)
    clips = make_voiceover(WORK)
    placed = place_lines(clips, dur)

    cmd = ["ffmpeg", "-y", "-i", str(video), "-i", str(music)]
    for _text, path, _d in clips:
        cmd += ["-i", str(path)]

    filters = [f"[1:a]atrim=0:{dur:.2f},volume={MUSIC_VOLUME}[m]"]
    labels = ["m"]
    for i, ((text, path, d), (start, end)) in enumerate(zip(clips, placed)):
        k = i + 2                       # ffmpeg input index
        ms = int(start * 1000)
        # play the clip in full from `start`; trim only if it would run past
        # the video end (defensive, keeps -shortest happy)
        trim = max(0.3, min(d, dur - start))
        filters.append(
            f"[{k}:a]atrim=0:{trim:.2f},"
            f"adelay={ms}|{ms},afade=t=in:st=0:d=0.08[v{i}]")
        labels.append(f"v{i}")
        print(f"  line {i:02d} @ {start:5.1f}s -> {end:5.1f}s  {text[:36]}")
    filters.append(
        f"{''.join('[' + l + ']' for l in labels)}"
        f"amix=inputs={len(labels)}:duration=longest:dropout_transition=0[aout]")
    graph = ";\n".join(filters)

    cmd += ["-filter_complex", graph,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart", str(out)]
    print("muxing...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        raise SystemExit(1)
    print(f"final -> {out}  ({get_dur(out):.1f}s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=str(ROOT / "SIH2026_PS171_YC_Ad_project.mp4"))
    ap.add_argument("--out", default=str(ROOT / "SIH2026_PS171_YC_Ad_project_FINAL.mp4"))
    ap.add_argument("--theme", default="black", choices=["project", "black", "light", "all"],
                   help="theme name; picks the default video + out paths if not overridden. "
                        "'all' muxes every theme.")
    a = ap.parse_args()
    themes = ["black", "project", "light"] if a.theme == "all" else [a.theme]
    for th in themes:
        if a.video == str(ROOT / "SIH2026_PS171_YC_Ad_project.mp4"):
            v = str(ROOT / f"SIH2026_PS171_YC_Ad_{th}.mp4")
        else:
            v = a.video
        if a.out == str(ROOT / "SIH2026_PS171_YC_Ad_project_FINAL.mp4"):
            o = str(ROOT / f"SIH2026_PS171_YC_Ad_{th}_FINAL.mp4")
        else:
            o = a.out
        print(f"\n=== {th} ===")
        mux(Path(v), Path(o))


if __name__ == "__main__":
    main()
