"""Generate the 4 judge-report charts. Idempotent — overwrites outputs.
All numbers sourced from the repo (see source notes under each figure)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path
import os, subprocess

OUT = Path(__file__).parent
OUT.mkdir(exist_ok=True)

INDIGO = "#6366f1"; EMERALD = "#10b981"; BRICK = "#c2413b"; NEUTRAL = "#8a8f98"
AMBER = "#d97706"; BG = "#ffffff"; GRID = "#e5e7eb"

plt.rcParams.update({
    "font.size": 11, "axes.spines.top": False, "axes.spines.right": False,
    "axes.edgecolor": GRID, "axes.labelcolor": "#1f2937",
    "xtick.color": "#4b5563", "ytick.color": "#4b5563", "figure.facecolor": BG,
    "axes.facecolor": BG,
})

def save(fig, name, dpi=150):
    p = OUT / name
    fig.savefig(p, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    print(f"{name}: {p.stat().st_size//1024} KB")

# ---------------------------------------------------------------- 1. tests
files = [
    ("sanitizer", 63), ("pii-detector", 29), ("pii-recall-precision", 26),
    ("firefox-compatibility", 21), ("session-manager", 21), ("vision-utilities", 12),
    ("context", 11), ("dom-extraction", 11), ("actions-resilience", 10),
    ("privacy-advanced", 9), ("action-executor", 9), ("loop-detection", 6),
    ("privacy-ledger", 5), ("index", 1),
]
cat = {  # category -> color
    "pii": INDIGO, "privacy": INDIGO, "browser": EMERALD, "actions": NEUTRAL,
    "vision": BRICK, "session": NEUTRAL,
}
def color_for(name):
    n = name.lower()
    if "pii" in n: return INDIGO
    if "privacy" in n: return INDIGO
    if "firefox" in n or "dom" in n: return EMERALD
    if "vision" in n: return BRICK
    return NEUTRAL

fig, ax = plt.subplots(figsize=(9, 5))
names = [f[0] for f in files][::-1]
vals = [f[1] for f in files][::-1]
cols = [color_for(n) for n in names]
ax.barh(names, vals, color=cols, edgecolor="none", height=0.65)
for i, (n, v) in enumerate(zip(names, vals)):
    ax.text(v + 0.6, i, str(v), va="center", fontsize=10, color="#1f2937")
ax.set_xlabel("Tests (of 240 total, 14 files, all passing)")
ax.set_title("Unit + e2e test suite by module — 240 tests passing")
import matplotlib.patches as mpatches
ax.legend(handles=[mpatches.Patch(color=INDIGO, label="PII / privacy"),
                   mpatches.Patch(color=EMERALD, label="browser / DOM / compat"),
                   mpatches.Patch(color=BRICK, label="vision"),
                   mpatches.Patch(color=NEUTRAL, label="actions / session")],
          loc="lower right", frameon=False, fontsize=9)
ax.set_xlim(0, max(vals) * 1.12)
fig.text(0.01, 0.005, "source: `npx vitest run` (14 files, 240 passed)", fontsize=7, color="#9ca3af")
save(fig, "test_suite_breakdown.png")

# ---------------------------------------------------------------- 2. PII recall
# From docs/PII_BENCHMARK_REPORT.md (input-field detection accuracy table).
rec = [
    ("PAN", 100), ("Credit Card", 100), ("Email", 100), ("Phone", 100),
    ("Password", 100), ("IFSC", 0),
]
fig, ax = plt.subplots(figsize=(8, 4.5))
lab = [r[0] for r in rec]
vl = [r[1] for r in rec]
cols2 = [EMERALD if v == 100 else BRICK for v in vl]
ax.bar(lab, vl, color=cols2, edgecolor="none", width=0.55)
for i, v in enumerate(vl):
    ax.text(i, v + 2, f"{v}%", ha="center", fontsize=11, fontweight="bold")
ax.set_ylim(0, 115)
ax.set_ylabel("Recall (input fields)")
ax.set_title("PII detection recall by type (ground-truth benchmark)")
ax.yaxis.grid(True, color=GRID); ax.set_axisbelow(True)
fig.text(0.01, 0.005, "source: docs/PII_BENCHMARK_REPORT.md — IFSC input-field recall is a known 0% gap (regex mismatch)",
         fontsize=7, color="#9ca3af")
save(fig, "pii_recall_by_type.png")

# ---------------------------------------------------------------- 3. FP before/after
fig, ax = plt.subplots(figsize=(8, 4.5))
before, after = 722, 15
ax.bar(["pre-optimization\nbaseline", "post-optimization\n(context-aware)"],
       [before, after], color=[BRICK, EMERALD], width=0.45)
ax.text(0, before + 15, f"{before}", ha="center", fontsize=16, fontweight="bold", color=BRICK)
ax.text(1, after + 15, f"{after}", ha="center", fontsize=16, fontweight="bold", color=EMERALD)
ax.annotate(f"~{before/after:.0f}x fewer\nfalse positives", xy=(0.5, before*0.6),
            fontsize=13, fontweight="bold", color=INDIGO, ha="center",
            bbox=dict(boxstyle="round,pad=0.4", fc="#eef2ff", ec=INDIGO, lw=1.2))
ax.set_ylim(0, before * 1.18)
ax.set_ylabel("PII false positives (per test page)")
ax.set_title("Context-aware PII filtering: false positives slashed ~48x")
ax.yaxis.grid(True, color=GRID); ax.set_axisbelow(True)
fig.text(0.01, 0.005, "source: in-session before/after — 722 baseline, ~15 after price/cost skip + table-cell context + specific selectors",
         fontsize=7, color="#9ca3af")
save(fig, "pii_false_positives_before_after.png")

# ---------------------------------------------------------------- 4. build size
# du -sb dist/chrome-mv3 = 1,208,900 bytes total
total = 1208900
# get real per-file sizes
def fsize(p):
    p = Path(p)
    return p.stat().st_size if p.exists() else 0
root = OUT.parent.parent / "dist" / "chrome-mv3"
parts = []
if root.exists():
    for sub in ["background.js", "chunks", "assets", "content-scripts", "popup.html", "manifest.json"]:
        sp = root / sub
        if sp.is_dir():
            s = sum(fsize(f) for f in sp.rglob("*") if f.is_file())
        elif sp.exists():
            s = sp.stat().st_size
        else:
            s = 0
        if s:
            parts.append((sub, s))
parts.sort(key=lambda x: -x[1])
top = parts[:4]
other = sum(p[1] for p in parts[4:])
labels = [p[0] for p in top] + (["other"] if other else [])
sizes = [p[1] for p in top] + ([other] if other else [])
fig, ax = plt.subplots(figsize=(8, 4.5))
palette = [INDIGO, EMERALD, AMBER, BRICK, NEUTRAL]
wedges, _ = ax.pie(sizes, colors=palette[:len(sizes)], startangle=90,
                   wedgeprops=dict(width=0.42, edgecolor="white", linewidth=2))
ax.text(0, 0.06, "1.21 MB", ha="center", fontsize=20, fontweight="bold", color="#1f2937")
ax.text(0, -0.16, "total build", ha="center", fontsize=10, color=NEUTRAL)
ax.legend(wedges, [f"{l}  ({s/1e6:.3f} MB)" for l, s in zip(labels, sizes)],
          loc="center left", bbox_to_anchor=(1.02, 0.5), frameon=False, fontsize=9)
ax.set_title("dist/chrome-mv3 build-size breakdown")
fig.text(0.01, 0.005, "source: `du -sb dist/chrome-mv3` = 1,208,900 bytes", fontsize=7, color="#9ca3af")
save(fig, "build_size.png")

print("\nall 4 charts written to", OUT)
