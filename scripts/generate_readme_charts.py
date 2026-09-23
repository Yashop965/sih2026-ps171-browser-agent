"""Generate the README dashboard charts as inline-friendly SVG files.
No dependencies (pure string templates). Output: media/charts/*.svg
"""
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "charts")
os.makedirs(OUT, exist_ok=True)

GREEN = "#22c55e"
INDIGO = "#6366f1"
RED = "#ef4444"
AMBER = "#f59e0b"
GRAY = "#94a3b8"
TEXT = "#334155"
MUTED = "#64748b"
TRACK = "#e2e8f0"

# ---------------------------------------------------------------- chart 1
ROW_H = 34
LABEL_W = 210
# vitest tests-per-module (top 15 + other). Verified against the live
# 438/438 run (2026-09-24, cursor v5.3 — agent-cursor suite grew 18 -> 35).
top = [
    ("pii-sanitizer", 63), ("pii-recall-precision", 37), ("agent-cursor", 35),
    ("agent-runner", 30), ("pii-detector", 24), ("firefox-compatibility", 21),
    ("session-manager", 21), ("loop-detection", 15), ("user-profile", 13),
    ("vision-utilities", 12), ("context", 11), ("dom-extraction", 11),
    ("vision-confirm", 11), ("actions-resilience", 10), ("goal-backstop", 10),
]
other = 438 - sum(v for _, v in top)
rows = top + [("other (19 files)", other)]
maxv = max(v for _, v in rows)

def bar_chart(title, subtitle, data, value_color, bar_w_scale=3.4, w=760, row_h=34):
    label_w = 210
    h = 64 + row_h * len(data) + 28
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="Segoe UI,Helvetica,Arial,sans-serif">']
    s.append(f'<rect width="{w}" height="{h}" fill="#ffffff"/>')
    s.append(f'<text x="20" y="30" font-size="18" font-weight="700" fill="{TEXT}">{title}</text>')
    s.append(f'<text x="20" y="50" font-size="12" fill="{MUTED}">{subtitle}</text>')
    y = 78
    for name, v in data:
        bw = int(v * bar_w_scale)
        s.append(f'<text x="{label_w}" y="{y-4}" font-size="13" fill="{TEXT}" text-anchor="end">{name}</text>')
        s.append(f'<rect x="{label_w+12}" y="{y-13}" width="{bw}" height="17" rx="4" fill="{value_color}"/>')
        s.append(f'<text x="{label_w+12+bw+8}" y="{y-2}" font-size="13" font-weight="600" fill="{MUTED}">{v}</text>')
        y += row_h
    s.append('</svg>')
    return "\n".join(s)

svg1 = bar_chart(
    "Unit test coverage by module (vitest)",
    "438/438 passing · 34 test files · verified 2026-09-24 (cursor v5.3)",
    [(n, v) for n, v in rows], GREEN,
)
open(os.path.join(OUT, "tests-by-module.svg"), "w").write(svg1)

# ---------------------------------------------------------------- chart 2
# PII detection recall by type (docs/PII_BENCHMARK_REPORT.md) + adversarial.
recall = [
    ("PAN (checksum)", 100, GREEN),
    ("Credit card (Luhn)", 100, GREEN),
    ("Email", 100, GREEN),
    ("Phone", 100, GREEN),
    ("Password field", 100, GREEN),
    ("Adversarial (13 cases)", 92.3, AMBER),
    ("IFSC input-field", 0, RED),
]
maxv2 = 100.0

def vbar(value, color, maxv=100, track_w=460, label=None):
    s = []
    s.append(f'<rect x="{LABEL_W+12}" y="-13" width="{track_w}" height="17" rx="4" fill="{TRACK}"/>')
    bw = int(value / maxv * track_w)
    if bw > 2:
        s.append(f'<rect x="{LABEL_W+12}" y="-13" width="{bw}" height="17" rx="4" fill="{color}"/>')
    s.append(f'<text x="{LABEL_W+12+track_w+8}" y="{-2}" font-size="13" font-weight="600" fill="{MUTED}">{value:g}%</text>')
    return "\n".join(s)

h2 = 64 + ROW_H * len(recall) + 28
s2 = [f'<svg xmlns="http://www.w3.org/2000/svg" width="760" height="{h2}" viewBox="0 0 760 {h2}" font-family="Segoe UI,Helvetica,Arial,sans-serif">']
s2.append(f'<rect width="760" height="{h2}" fill="#ffffff"/>')
s2.append(f'<text x="20" y="30" font-size="18" font-weight="700" fill="{TEXT}">PII detection performance</text>')
s2.append(f'<text x="20" y="50" font-size="12" fill="{MUTED}">docs/PII_BENCHMARK_REPORT.md · verified 2026-09-22 · 0 verified false positives for Aadhaar &amp; cards</text>')
y = 78
for name, v, color in recall:
    s2.append(f'<text x="{LABEL_W}" y="{y-4}" font-size="13" fill="{TEXT}" text-anchor="end">{name}</text>')
    s2.append(vbar(v, color, 100, 460))
    y += ROW_H
s2.append('</svg>')
open(os.path.join(OUT, "pii-recall.svg"), "w").write("\n".join(s2))

# ---------------------------------------------------------------- chart 3
# False-positive reduction: 722 -> ~15 (context-aware filtering), 98% drop.
def fp_chart():
    vals = [("before (raw regex)", 722, GRAY), ("after (context-aware)", 15, GREEN)]
    track_w, bw_max = 460, 460
    h3 = 64 + 2 * 60 + 40
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="760" height="{h3}" viewBox="0 0 760 {h3}" font-family="Segoe UI,Helvetica,Arial,sans-serif">']
    s.append(f'<rect width="760" height="{h3}" fill="#ffffff"/>')
    s.append(f'<text x="20" y="30" font-size="18" font-weight="700" fill="{TEXT}">PII false positives on benchmark corpus</text>')
    s.append(f'<text x="20" y="50" font-size="12" fill="{MUTED}">context-aware filtering + checksum/Luhn validation · 98% reduction</text>')
    y = 90
    for name, v, color in vals:
        bw = max(int(v / 722 * bw_max), 6)
        s.append(f'<text x="{LABEL_W}" y="{y-4}" font-size="13" fill="{TEXT}" text-anchor="end">{name}</text>')
        s.append(f'<rect x="{LABEL_W+12}" y="{y-13}" width="{bw}" height="17" rx="4" fill="{color}"/>')
        s.append(f'<text x="{LABEL_W+12+bw+8}" y="{y-2}" font-size="13" font-weight="600" fill="{MUTED}">{v}</text>')
        y += 44
    s.append(f'<text x="{LABEL_W+12}" y="{y+8}" font-size="12" fill="{MUTED}">↓ 98% fewer false positives, zero verified FPs for Aadhaar &amp; card types</text>')
    s.append('</svg>')
    return "\n".join(s)

open(os.path.join(OUT, "pii-false-positive-reduction.svg"), "w").write(fp_chart())
print("charts written:", os.listdir(OUT))
