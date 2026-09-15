#!/usr/bin/env python3
"""
Final ad assembly: video + ambient music bed (synthesized, royalty-free) +
ElevenLabs voiceover (Daniel, eleven_multilingual_v2) + synthesized SFX,
muxed into one MP4 with ffmpeg.

Usage:
    python ad_pipeline/assemble_final.py --theme all

The ElevenLabs API key is read from the gitignored .env at the repo root
(ELEVENLABS_API_KEY). No credentials are committed anywhere.

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
import json
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent.parent
WORK = Path(__file__).parent / "audio"
VIDEO_DUR = 56.5

MUSIC_VOLUME = 0.07          # bed stays under the voice (pad variant)
VOICE_NAME = "Daniel - Steady Broadcaster"
XI_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"   # Daniel (public voice)
XI_MODEL = "eleven_multilingual_v2"
VOICE_GAIN = 1.6          # voice rides on top of music (amix normalize=0)
GAP = 0.5            # breathing room between consecutive lines
LEAD_IN = 0.8        # first line starts this far in

# Synthesized SFX (royalty-free, generated with numpy — no external assets).
# Each entry: (name, start_s, end_s, label).
#  whooshes on scene cuts, ping on the product reveal, impact on the
#  "Zero PII crosses the line" seal, chime on the closing card.
SFX = [
    ("cut_1",   4.5,  5.6,  "whoosh into problem"),
    ("cut_2",   9.5, 10.6,  "whoosh into detection"),
    ("cut_3",  22.5, 23.6,  "whoosh into architecture"),
    ("impact", 28.4, 29.7,  "'0 PII crosses the line' seal"),
    ("cut_4",  30.0, 31.1,  "whoosh into heatmap"),
    ("cut_5",  36.0, 37.1,  "whoosh into autofill"),
    ("cut_6",  43.5, 44.6,  "whoosh into metrics"),
]

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


def synth_music(path: Path, duration: float = VIDEO_DUR, variant: str = "pad"):
    """Royalty-free background bed. Two variants (both smooth — no hard
    chord-change chugs, no pulse wobble, no noise texture):
      'pad'      — six slow chords, 50%-overlap raised-cosine crossfades,
                   gently detuned pairs for width, one-pole lowpass,
                   1.5s fade-in / 2.5s fade-out.
      'arpeggio' — quiet plucked notes in a slow Am-F-C-G pattern; sparse
                   enough to sit under the voice.
    """
    sr = 44100
    n = int(duration * sr)
    out = np.zeros(n, dtype=np.float64)

    chords = [
        [220.00, 261.63, 329.63],   # Am
        [174.61, 220.00, 261.63],   # F
        [130.81, 164.81, 196.00],   # C
        [196.00, 246.94, 293.66],   # G
    ]

    if variant == "pad":
        seq = [chords[0], chords[1], chords[2], chords[3], chords[1], chords[2]]
        seg = n // len(seq)
        xfade = seg // 2                       # 50% overlap crossfade
        for ci, chord in enumerate(seq):
            s0 = ci * seg
            s1 = min(n, s0 + seg + xfade)
            m = s1 - s0
            tt = np.arange(m) / sr
            sig = np.zeros(m)
            for f in chord:
                sig += (np.sin(2 * np.pi * f * (1 - 0.004) * tt)   # detuned
                        + np.sin(2 * np.pi * f * (1 + 0.004) * tt)
                        + 0.4 * np.sin(2 * np.pi * f * 2 * tt))
            w = 0.5 * (1 - np.cos(np.pi * np.linspace(0, 1, m)))   # 0->1->0
            out[s0:s1] += sig * w
        # gentle one-pole lowpass (~1.2 kHz) so it stays warm, not bright
        a = 1 - np.exp(-2 * np.pi * 1200 / sr)
        lp = np.empty_like(out)
        y = 0.0
        for i in range(n):
            y = y + a * (out[i] - y)
            lp[i] = y
        out = lp
        # tempo-locked gentle pulse (~96 BPM) so the bed drives rather than
        # drifts — subtle: 15% amplitude swing, raised-cosine shape
        bpm = 96.0
        beat = 60.0 / bpm
        tt = np.arange(n) / sr
        phase = (tt % beat) / beat
        pulse = 1.0 + 0.15 * np.cos(np.pi * (1 - phase)) ** 2
        out *= pulse
    elif variant == "arpeggio":
        notes = [
            220.00, 329.63, 440.00, 329.63,    # Am
            174.61, 261.63, 349.23, 261.63,    # F
            130.81, 196.00, 261.63, 196.00,    # C
            196.00, 293.66, 392.00, 293.66,    # G
        ]
        step = 0.55                             # slow, ~109 BPM eighths
        i = 0
        while i * step < duration:
            f = notes[i % len(notes)]
            j0 = int(i * step * sr)
            j1 = min(n, j0 + int(1.5 * sr))
            if j0 < n:
                tt = np.arange(j1 - j0) / sr
                pluck = (np.sin(2 * np.pi * f * tt)
                         + 0.3 * np.sin(2 * np.pi * f * 2 * tt)) * np.exp(-2.2 * tt)
                out[j0:j1] += 0.5 * pluck
            i += 1
    else:
        raise ValueError(f"unknown music variant {variant}")

    out /= np.max(np.abs(out)) + 1e-9
    fin = int(1.5 * sr)
    fout = int(2.5 * sr)
    out[:fin] *= np.linspace(0, 1, fin)
    out[-fout:] *= np.linspace(1, 0, fout)
    pcm = (np.clip(out, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"music ({variant}) -> {path.name}")


def get_dur(p: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(p)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def load_xi_key() -> str:
    """Read ELEVENLABS_API_KEY from the gitignored .env at repo root."""
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            s = line.strip()
            if s.startswith("ELEVENLABS_API_KEY") and "=" in s and not s.startswith("#"):
                return s.split("=", 1)[1].strip()
    import os
    k = os.environ.get("ELEVENLABS_API_KEY", "")
    if not k:
        raise SystemExit("ELEVENLABS_API_KEY missing: set it in .env or the environment")
    return k


XI_KEY = None


def synth_xi_clip(text: str, out: Path):
    """One ElevenLabs TTS call (Daniel, multilingual v2), 429-aware retry."""
    global XI_KEY
    import time, urllib.request, urllib.error
    if XI_KEY is None:
        XI_KEY = load_xi_key()
    body = json.dumps({
        "text": text,
        "model_id": XI_MODEL,
        "voice_settings": {
            "stability": 0.35,
            "similarity_boost": 0.75,
            "style": 0.3,
            "use_speaker_boost": True,
        },
    }).encode()
    last = None
    for attempt in range(5):
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{XI_VOICE_ID}",
            data=body,
            headers={"xi-api-key": XI_KEY, "Content-Type": "application/json",
                     "Accept": "audio/mpeg"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out.write_bytes(r.read())
            return
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2.0 * (attempt + 1))
                last = e
                continue
            raise
        except Exception as e:
            last = e
            time.sleep(1.5)
    raise SystemExit(f"ElevenLabs TTS failed after retries: {last}")


def make_voiceover(dir_: Path):
    """Synthesize each narration line to a wav (ElevenLabs mp3 -> wav so we
    can sample it for numpy mixing). Cached by content hash. Returns a list
    of (text, path, measured_duration_s) in NARRATION order."""
    clips = []
    for at, text in NARRATION:
        h = hashlib.sha1(f"xi|{XI_VOICE_ID}|{XI_MODEL}|{text}".encode()).hexdigest()[:12]
        out = dir_ / f"xi_{h}.mp3"
        if not out.exists():
            synth_xi_clip(text, out)
            print(f"tts -> {out.name}  ({text[:38]}...)")
        wav = dir_ / f"xi_{h}.wav"
        if not wav.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out),
                            "-ar", "44100", "-ac", "1", str(wav)], check=True)
        clips.append((text, wav, get_dur(wav)))
    print(f"voiceover: {len(clips)} clips (ElevenLabs / {VOICE_NAME})")
    return clips


# ---- Synthesized SFX (numpy, royalty-free) ----

def synth_sfx(name: str, path: Path):
    sr = 44100
    rng = np.random.default_rng(hash(name) & 0xFFFF)
    sig = np.zeros(0)
    if name.startswith("cut"):
        # whoosh: 0.9s band-passed noise, rising->falling amplitude, fast attack
        n = int(0.9 * sr)
        t = np.arange(n) / sr
        noise = rng.standard_normal(n)
        k = np.hanning(int(0.05 * sr))   # short kernel (must be <= n)
        noise = np.convolve(noise, k, "same")[:n]
        env = np.sin(np.pi * (t / 0.9)) ** 1.6          # up-down shape
        sig = 0.5 * noise * env
    elif name == "ping":
        # soft bright ping: 2nd + 4th harmonics of 880, exp decay
        n = int(1.4 * sr)
        t = np.arange(n) / sr
        sig = (0.6 * np.sin(2 * np.pi * 880 * t)
               + 0.25 * np.sin(2 * np.pi * 1760 * t)) * np.exp(-3.2 * t)
    elif name == "impact":
        # low thud: 55Hz sine + decaying noise burst
        n = int(1.3 * sr)
        t = np.arange(n) / sr
        sub = np.sin(2 * np.pi * 55 * t) * np.exp(-2.6 * t)
        n2 = int(0.25 * sr)
        burst = rng.standard_normal(n2) * np.linspace(1, 0, n2)
        sig = np.zeros(n)
        sig[:n2] += 0.4 * burst
        sig += 0.5 * sub
    elif name == "chime":
        # two-note rising chime (E5 -> A5), gentle decay
        n = int(2.3 * sr)
        t = np.arange(n) / sr
        a = np.sin(2 * np.pi * 659.25 * t) * np.exp(-1.6 * t)
        b = np.sin(2 * np.pi * 880.0 * t) * np.exp(-1.6 * np.clip(t - 0.5, 0, None))
        sig = 0.45 * a + 0.45 * b
    else:
        raise ValueError(f"unknown sfx {name}")
    sig = np.clip(sig / (np.max(np.abs(sig)) + 1e-9), -1, 1)
    pcm = (sig * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"sfx -> {path.name}")


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


def _read_wav_mono(path: Path) -> np.ndarray:
    """Read a 16-bit PCM wav -> float64 mono samples in [-1,1] @44100.
    All sources here are already 44.1kHz mono, so no resampling needed."""
    with wave.open(str(path), "rb") as w:
        assert w.getsampwidth() == 2, f"{path} must be 16-bit PCM"
        frames = w.readframes(w.getnframes())
    a = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    if w.getnchannels() > 1:
        a = a.reshape(-1, w.getnchannels()).mean(axis=1)
    return a


def mix_audio(video: Path, music: Path, clips, placed) -> Path:
    """Numpy mix at EXACT levels (replaces ffmpeg amix, which normalizes by
    1/N inputs and buried the voice under the music bed):
      music bed @ MUSIC_VOLUME, voice @ VOICE_GAIN, SFX @ SFX_GAIN, each
      placed at its measured offset; composite peak-normalized to -2.0 dBFS.
    Writes WORK/mixed.wav and returns its path."""
    sr = 44100
    dur = get_dur(video)
    n = int(dur * sr)
    mix = np.zeros(n, dtype=np.float64)

    # 1) music bed
    m = _read_wav_mono(music)[:n] * MUSIC_VOLUME
    mix += m

    # 2) voice lines at their greedy-placed offsets
    for (text, path, _d), (start, _end) in zip(clips, placed):
        v = _read_wav_mono(path)
        i0 = int(start * sr)
        seg = v[:n - i0] if i0 + len(v) > n else v
        mix[i0:i0 + len(seg)] += seg * VOICE_GAIN
    print(f"  voice: {len(clips)} lines @ {VOICE_GAIN}x")

    # 3) SFX at fixed offsets (synthesize on demand, then mix)
    SFX_GAIN = 0.45
    for name, s0, _s1, label in SFX:
        sp = WORK / f"sfx_{name}.wav"
        if not sp.exists():
            synth_sfx(name, sp)
        s = _read_wav_mono(sp)
        i0 = int(s0 * sr)
        seg = s[:n - i0] if i0 + len(s) > n else s
        mix[i0:i0 + len(seg)] += seg * SFX_GAIN
        print(f"  sfx {name:7} @ {s0:5.1f}s  ({label})")

    # 4) peak-normalize composite to -2.0 dBFS headroom
    peak = np.max(np.abs(mix)) + 1e-9
    mix = mix / peak * 10 ** (-2.0 / 20)
    out = WORK / "mixed.wav"
    pcm = (mix.astype(np.float32) * 32767).astype(np.int16)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"mixed -> {out.name}  (pre-norm peak {20*np.log10(peak):.1f} dB)")
    return out


def mux(video: Path, out: Path, music_variant: str = "pad"):
    WORK.mkdir(parents=True, exist_ok=True)
    video = ensure_silent_video(video, out)
    dur = get_dur(video)
    music = WORK / f"music_{music_variant}.wav"
    if not music.exists():
        synth_music(music, dur, variant=music_variant)
    clips = make_voiceover(WORK)
    placed = place_lines(clips, dur)
    mixed = mix_audio(video, music, clips, placed)

    cmd = ["ffmpeg", "-y", "-i", str(video), "-i", str(mixed),
           "-map", "0:v", "-map", "1:a",
           "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-shortest", "-movflags", "+faststart", str(out)]
    print("muxing...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        raise SystemExit(1)
    # tidy any recovered silent-source temp
    if video.stem.endswith(".silent"):
        video.unlink(missing_ok=True)
    print(f"final -> {out}  ({get_dur(out):.1f}s)")


def ensure_silent_video(v: Path, o: Path) -> Path:
    """The mux needs a video-only source. If the silent base MP4 was cleaned
    up, recover its video stream (copy, no re-encode) from the existing
    _FINAL file."""
    if v.exists():
        return v
    if o.exists():
        silent = v.with_suffix(".silent.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(o),
                        "-c:v", "copy", "-an", str(silent)], check=True)
        print(f"recovered video stream -> {silent.name} (from {o.name})")
        return silent
    raise SystemExit(f"video source missing: {v} (and no {o.name} to recover from)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default=str(ROOT / "SIH2026_PS171_YC_Ad_project.mp4"))
    ap.add_argument("--out", default=str(ROOT / "SIH2026_PS171_YC_Ad_project_FINAL.mp4"))
    ap.add_argument("--theme", default="black", choices=["project", "black", "light", "all"],
                   help="theme name; picks the default video + out paths if not overridden. "
                        "'all' muxes every theme.")
    ap.add_argument("--music", default="pad", choices=["pad", "arpeggio"],
                   help="background bed variant (both smooth, no chord chugs)")
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
        print(f"\n=== {th} (music: {a.music}) ===")
        mux(Path(v), Path(o), music_variant=a.music)


if __name__ == "__main__":
    main()
