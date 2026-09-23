# SIH 2026 PS171 — On-device Visual Perception for Light-weight Browser Agents

**Institution:** ISRO  
**Problem Statement:** SIH26171 — On-device Visual Perception for Light-weight Browser Agents  
**Hackathon:** Smart India Hackathon 2026 (College Internal Round)  
**Original deadline:** September 2, 2026 (production hardening continues post-submission)

![vitest: 438/438](https://img.shields.io/badge/vitest-438%2F438%20passing-22c55e?style=for-the-badge)
![pytest: 74/74](https://img.shields.io/badge/pytest-74%2F74%20passing-22c55e?style=for-the-badge)
![build: 1.33 MB](https://img.shields.io/badge/build-1.33%20MB%20chrome-mv3-6366f1?style=for-the-badge)
![PII off-device: 0](https://img.shields.io/badge/PII%20off-device-0%20leaks-ef4444?style=for-the-badge)

> **Current state (verified 2026-09-23):** `main` clean · **438/438** vitest + **74/74**
> pytest passing · Chrome MV3 build **1.33 MB** · 0 PII off-device · agent cursor
> v5.3 (distance-aware travel: snap/curve/1-loop/2-loops, page-level theme fix,
> viewport-contained loops) · task-history cache · live VLM indicator ·
> planner on a zero-reasoning fast model · 3-hop live E2E passing end-to-end.
> Repo:
> [`github.com/Yashop965/sih2026-ps171-browser-agent`](https://github.com/Yashop965/sih2026-ps171-browser-agent).

---

## 🎬 See It Work

<video
  src="SIH2026_PS171_YC_Ad_project_FINAL.mp4"
  poster="media/poster-project.jpg"
  controls muted autoplay loop playsinline
  preload="metadata"
  style="max-width: 720px; width: 100%; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.25); background:#0b0d17;"
></video>

<p align="center">
  <sub>90-second programmatic launch-ad — real extension footage, no stock assets.
  Switch theme: <a href="SIH2026_PS171_YC_Ad_black_FINAL.mp4"><b>black</b></a> ·
  <a href="SIH2026_PS171_YC_Ad_light_FINAL.mp4"><b>light</b></a> ·
  <a href="SIH2026_PS171_YC_Ad_project_FINAL.mp4"><b>project (above)</b></a>
  — pipeline: <a href="./ad_pipeline/README.md"><code>ad_pipeline/</code></a>
</sub>
</p>

---

## 📋 Problem Statement

Most AI agent pipelines run server-side, requiring users to send full screenshots or DOM data to third-party clouds. This is unacceptable for sensitive environments (government portals, banking, Aadhaar/PAN data) under India's DPDP Act 2023. ISRO's PS171 challenges teams to build a **fully on-device browser agent** that processes visual perception locally, redacts PII before any data leaves the machine, and sends only anonymized UI metadata to a planner for action generation. The agent must autonomously execute UI commands while maintaining provable privacy guarantees — a live audit log showing exactly what was blocked, redacted, and sent. This project matters because it demonstrates that high-accuracy AI automation can coexist with strict data sovereignty, a requirement increasingly critical for Indian government digital services and citizen-facing applications.

---

## 🏠 Project Overview

Most AI agent pipelines run server-side, requiring users to send full screenshots or DOM data to third-party clouds. This is unacceptable for sensitive environments (government portals, banking, Aadhaar/PAN data) under India's DPDP Act 2023.

**We build a local browser extension that processes visual perception entirely on-device**, redacts PII before any data leaves the machine, and sends only anonymized UI metadata to a planner (local Ollama or cloud API). The client executes returned actions autonomously.

### What We Deliver

| Component | Description |
|-----------|-------------|
| **Chrome/Firefox Extension** | MV3-compatible extension built with WXT + React |
| **Client-Side Vision** | Florence-2 ONNX model running in-browser via Transformers.js + WebGPU (lazy-loaded) |
| **Privacy Engine** | Layered PII detection (Aadhaar, PAN, cards, passwords, faces) with checksum validation + context-aware filtering |
| **Privacy Ledger** | Tamper-detecting, SHA-256-chained audit log of every redacted/blocked/sent element, persisted across SW restarts |
| **Autonomous Task Runner** | SW-owned loop; goal-driven across pages via a planner-authored **task checklist** as cross-page memory; action vocabulary includes `KEY`/`NAVIGATE`/`WAIT` for multi-page autonomy |
| **Server Planner** | FastAPI backend receiving only sanitized metadata; LLM generates UI action commands + maintains the checklist |
| **End-to-End Demo** | Autonomous multi-page task (e.g. two Wikipedia searches) completing a realistic workflow |

### Feature highlights (post-deadline hardening)

- **Autonomy (#84/#85/#86):** goal-driven multi-page execution — `NAVIGATE` via background `NAVIGATE_TAB`, `WAIT` primitive, `KEY` primitive (press Enter/Tab/arrows so a search actually submits), and robust web-tab resolution so the agent never targets its own extension page.
- **Cross-page memory (#99):** the planner is stateless across pages, so after each navigation it used to re-reason from scratch and re-do completed steps. Fix: the planner authors a small ordered **task checklist** of sub-goals; the runner tracks it (`mergeChecklist`, sticky-`done`), feeds it back to `/plan` each step, and **gates DONE** on it (3-strike cap → best-effort degraded).
- **Planner loop-guard (#130):** the runner detects repeated no-op actions and feeds a PII-safe `loopWarning` back into the planner prompt (with NPTEL-style Rule 20: a submit is proven by a *distinctive page change*). Kills the "re-typing the same value forever" loop seen in live runs.
- **Agent cursor v5 (#137 → v5.2, movement engine open in #139):** the visible agent cursor is the user-referenced "select" pointer (mirrored, tip top-left), **theme-aware** — a black shape + white outline on light sites, inverting to white + dark outline on dark sites (sampled live per target) — with a **border-tracing blue working glow** that hugs the pointer's silhouette and breathes while the agent works/thinks. Every hop now rides a **single closed 360° loop** (straight approach → one full circle, G1-continuous in and out → straight tail onto the target) at a deliberately slow, constant ~320px/s so the motion is smooth and watchable. Transform-only, shadow-DOM + `all:initial` isolation so hostile page CSS can't hide it. The loop **placement/shape** is flagged for a rework pass in #139 (and a known open: the arrow did not switch to black on light mode yet — tracked in #139).
- **Task history (#134):** the popup caches recent prompts (`sih_recent_tasks`, cap 8, deduped) with one-click re-run and outcome-tinted status rails — the last task is persisted and reusable across popup opens.
- **Live VLM indicator (#136):** a compact popup pill shows the on-device vision pipeline state (ready / loading / idle / unavailable) plus the last OCR outcome, polled from the active tab. Pure status — no pixels or PII leave the device.
- **Fast planner model (#133):** the planner runs on a zero-reasoning model that answers in ~3 s instead of the CoT default's ~5 s per step (~4× faster live, no degraded calls). Both options are documented in `server/.env.example` with measured timings.
- **Lower-section modernization (#135):** the PII heatmap tab renders the real card component (the dead inline dot-grid is gone), and a "quiet" toggle hides low-confidence unverified detections so the ledger reads "what matters."
- **PII criticals closed (#130):** audit C1–C3 fixed — logs never record resolved profile values, 13–19-digit cards are blocked at the last-line firewall (was 16-digit-only), and non-card PII detections store a fully `[REDACTED]` sentinel instead of a 4-character prefix.
- **Port retry (#105):** a navigating click drops the content port; the very next `EXTRACT` hit "Receiving end does not exist" and crashed the run. `src/lib/portRetry.ts` (`withPortRetry`) retries the transient case and fails fast on genuine errors.
- **Live CDP/id discovery (#98):** `scripts/run_autonomy_live.mjs` discovers the live extension id from all `chrome-extension://` CDP targets (the old hardcoded id 404'd on a spun-down service worker). `scripts/run_autonomy_3hop.mjs` is the current live benchmark driver (3-hop Wikipedia task).

### Related Documents
- [Product Requirements Document (PRD)](./docs/PRD.md) — Detailed feature specifications, acceptance criteria, and technical constraints
- [Session logs](./docs/SESSION-2026-09-16.md) · [SESSION-2026-09-17](./docs/SESSION-2026-09-17.md) — autonomy + live re-run + checklist
- [Testing guide](./docs/TESTING-GUIDE.md) · [API](./docs/API.md)
- [Audit findings](./docs/AUDIT-FINDINGS.md) — issues #59–#77
- [Codebase audit — `src/lib`](./docs/audit/01-src-lib.md) · [server + entrypoints](./docs/audit/02-server-and-entrypoints.md) — 2026-09-22 deep audit (critical/major/minor findings; C1–C3 closed in #130)
- [Mouse animation library research](./docs/research/mouse-animation-libraries.md) — 9-lib comparison, GSAP chosen for the agent cursor
- [PII benchmark report](./docs/PII_BENCHMARK_REPORT.md) — recall/precision by PII type + adversarial resistance

---

## 📊 Live Dashboard

*Every number below was re-verified on 2026-09-22 by running the suites — not copy-pasted from a stale report. Charts are inline SVG (`media/charts/`), regenerated any time via `python scripts/generate_readme_charts.py`.*

### Health

| Metric | Value | Since |
|---|---|---|
| **Vitest unit tests** | **429 / 429 passing** · 34 files | cursor v5 work |
| **Python server tests** | **74 / 74 passing** · 9 files | PR #127 |
| **Chrome MV3 build** | **1.33 MB** (Firefox MV2 same tree) | PR #137 |
| **PII off-device leaks** | **0** (raw PII never leaves the machine; last-line firewall on egress) | audit C1–C3 |
| **Live 3-hop E2E** | **Wikipedia ×3, 6/6 checklist, DONE** on the fast planner model (~7 s/step) | PR #133 |
| **Planner model** | **zero-reasoning `agnes-3.0-flash`** — ~4× faster than the CoT default, no degraded calls | PR #133 |
| **Repo** | **235 commits · 62 PRs · 66 issues closed** | today |
| **Codebase** | **~12.4 k LOC** client TS + **~6.8 k LOC** server Python | today |

<details>
<summary>📈 Test coverage by module (429 tests, top 15 + rest) — click to expand</summary>

![Unit test coverage by module (429 passing, 34 files)](media/charts/tests-by-module.svg)

</details>

<details open>
<summary>🛡️ PII detection performance (click to collapse)</summary>

![PII detection performance by type](media/charts/pii-recall.svg)

![PII false-positive reduction: 722 → 15 (98%)](media/charts/pii-false-positive-reduction.svg)

</details>

### What shipped since the last dashboard (2026-09-17 → 09-22)

| Change | Effect |
|---|---|
| **Agent cursor v5.2 (movement engine → #139)** | The user-referenced "select" pointer (mirrored, tip top-left, 24px), theme-aware colors (black on light / white on dark sites) + a **border-tracing blue working glow** that hugs the pointer silhouette and breathes while the agent works. Travel = a **single closed 360° loop** (straight approach → one full G1-continuous circle → straight tail onto target) at a slow constant ~320px/s. Transform-only, shadow-DOM + `all:initial` isolation. Open in #139: loop placement/shape rework + the light-mode color still inverts to white on some light pages |
| **Task history (#134)** | Popup persists a `sih_recent_tasks` list (cap 8, deduped, one-click re-run, status-tinted rails, relative timestamps, Clear) — the last prompt is cached and reused |
| **Live VLM indicator (#136)** | `VlmIndicator` polls the active tab's on-device vision pipeline via a new `VISION_STATUS` message; compact status pill (ready / loading / idle / unavailable + last-OCR outcome). Pure state — no pixels, no PII leave the device |
| **Lower-section modernization (#135)** | Heatmap tab renders the real card `Heatmap` component (removed the dead inline dot-grid); a "quiet" de-noise toggle hides unverified PII matches below 70% confidence |
| **Fast planner model (#133)** | Planner switched to zero-reasoning `agnes-3.0-flash` (~2.9 s/step vs 5.3 s on the CoT default; ~4× faster live). Both options + timing evidence documented in `server/.env.example`; the live 3-hop E2E now runs at ~7 s/step |
| **PII criticals C1–C3** fixed | Log no longer records resolved profile values · 13–19-digit cards firewall-blocked (was 16-only) · non-card PII detections now store `[REDACTED]`, not a 4-char prefix |
| **Planner loop-guard** | Runner feeds a PII-safe `loopWarning` back to `/plan` when the same no-op action repeats; planner Rule 20: a submit is proven by a *distinctive page change*, not "I pressed Enter" (NPTEL report pattern) |
| **LLM reasoning-model fixes** | `reasoning_content` fallback when `content` is empty + 30 s → 90 s per-request timeout — the "planner degraded" mid-run stalls are gone |
| **GSAP agent cursor (v1–v2)** | Distance-scaled transform-only travel, mid-glide retarget, arrival-pulse + click-ripple, shadow-DOM isolation so hostile page CSS can't hide it, reduced-motion fallback (v3 above builds on this) |
| **Tolerant `<select>` matching** | Normalized/unique-substring option matching (`matchSelectOption`) — stops the "no option matching" re-typing loop and closes audit M3 |
| **`<all_urls>` host permission** | Unblocks `captureVisibleTab` for the on-device VLM path (#113 model load proven; live extension loop is the remaining piece) |
| **Codebase audit + module reference** | `docs/audit/01-src-lib.md` (25 findings) · `docs/audit/02-server-and-entrypoints.md` (24 findings + API) · `docs/research/mouse-animation-libraries.md` (9-lib comparison) |

---

## 🛠️ Tech Stack

### Frontend (Browser Extension)
| Technology | Purpose |
|------------|---------|
| **WXT** | Cross-browser extension framework (Chrome MV3 + Firefox MV2) |
| **React 19 + TypeScript** | UI components for popup, SoM overlay, heatmap, resource monitor, ledger |
| **TailwindCSS** | Utility-first styling for the extension popup and overlays |
| **Transformers.js v3** | In-browser ONNX model inference via WebGPU/WASM |
| **ONNX Runtime Web** | GPU-accelerated model execution in browser |

### Backend (Planner Server)
| Technology | Purpose |
|------------|---------|
| **Python 3.11+** | Language runtime |
| **FastAPI** | Async API server for action planning |
| **Ollama** | Local LLM inference (`qwen2.5:1.5b` / `qwen2.5:3b`) |
| **OpenAI-compatible client** | Fallback to cloud APIs during SIH evaluation |

### Vision Models
| Model | Size | Role |
|-------|------|------|
| **Florence-2-base-ft** | 231M params | Primary on-device grounding model (WebGPU/WASM) |
| **Moondream2** (GGUF) | 1.93B params | Fallback captioning/VQA |
| **ShowUI-2B** (quantized) | 2B params | Alternative grounding model |

---

## 💻 System Design & Memory Budget

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER EXTENSION (Client)                    │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Content      │  │ Vision       │  │ Privacy Engine        │  │
│  │ Script       │  │ Pipeline     │  │ (PII Detector +       │  │
│  │              │  │              │  │  Redactor + Ledger)   │  │
│  │ • DOM Extract│  │ • Florence-2 │  │ • Aadhaar (Verhoeff)  │  │
│  │ • A11y Tree  │  │ • Face Detect│  │ • PAN format          │  │
│  │ • Screenshot │  │ • SoM Overlay│  │ • Card (Luhn)         │  │
│  └──────┬───────┘  └──────┬───────┘  │ • Password fields     │  │
│         │                  │          │ • UPI/IFSC/Email      │  │
│         └────────┬─────────┘          │ • Faces (blur)       │  │
│                  ▼                    └──────────┬────────────┘  │
│  ┌───────────────────────────────────────────────┐               │
│  │        Sanitized Metadata Payload              │               │
│  │  [{id, role, label, x, y, width, height, type}]│             │
│  └───────────────────────────┬─────────────────────┘               │
└───────────────────────────────┼────────────────────────────────────┘
                                │ HTTP POST (sanitized only)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PLANNER SERVER (FastAPI)                     │
│  • Receive sanitized element metadata + task + checklist        │
│  • Parse natural-language task prompt                            │
│  • Query LLM (Ollama / Cloud API)                                │
│  ✓ No pixels, no raw DOM, no PII                                │
│  → Returns: { action, checklist, ... }  (checklist gates DONE)  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                EXTENSION EXECUTOR (SW-owned)                     │
│  • Execute action: CLICK / TYPE / SCROLL / SELECT / NAVIGATE /  │
│    WAIT / KEY / DONE                                             │
│  • Track task checklist as cross-page memory                    │
│  • Retry transient content-port drops after navigating clicks   │
│  • Capture new state → loop until task complete or max steps    │
│  • Show live popup: heatmap, resource monitor, privacy ledger    │
└─────────────────────────────────────────────────────────────────┘
```

### Action Vocabulary

| Action | Purpose |
|--------|---------|
| `CLICK` | Click an element by target id |
| `TYPE` | Type text into an input (value-aware dedupe) |
| `SELECT` | Choose a value from a `<select>` |
| `SCROLL` | Scroll the page (up/down/into-view) |
| `NAVIGATE` | Open a URL / move the tab (via background `NAVIGATE_TAB` + wait-for-load) |
| `WAIT` | Let the page settle (`waitMs`; executor cap 30 s) |
| `KEY` | Press a key (`Enter`, `Tab`, `ArrowDown`, …) so a typed search actually submits |
| `DONE` | Signal task complete — gated by the task checklist (or empty → legacy) |

### Tiered Inference Pipeline

```
Step Start
    │
    ▼
DOM Extraction (~10ms) ──→ Has actionable info? ──→ Yes ──→ Execute directly
    │
    No
    ▼
Vision Grounding (WebGPU, ~300-1000ms) ──→ SoM Overlay
    │
    ▼
Send sanitized metadata + checklist to planner
    │
    ▼
Execute returned action (retry content-port drops after navigating clicks)
    │
    ▼
Capture new state → update checklist → loop
```

### Memory Budget Table (Hard Cap: 500MB)

| Component | Model/Size | RAM Footprint | Notes |
|-----------|------------|---------------|-------|
| **Florence-2-base-ft (INT8)** | 231M params, ONNX | ~200 MB | Primary vision model, WebGPU-accelerated, lazy-loaded |
| **DOM Extraction Engine** | Content script | ~5-10 MB | Lightweight, reads accessibility tree |
| **Privacy Engine** | Regex + checksum validators | ~10-15 MB | Aadhaar (Verhoeff), PAN, Luhn, face detection |
| **SoM Overlay Renderer** | Canvas-based | ~15-25 MB | Numbered bounding boxes, React overlay |
| **Transformers.js Runtime** | WebGPU backend | ~50-75 MB | ONNX Runtime Web initialization |
| **Extension Popup (React)** | UI components | ~20-30 MB | Tailwind-styled popup, heatmap, monitor, ledger |
| **Privacy Ledger** | storage.local | ~10-20 MB | Tamper-detecting audit trail, persists across SW death |
| **Buffer/Overhead** | — | ~50-80 MB | Screenshot buffers, temp allocations |
| **TOTAL** | — | **~360-455 MB** | ✅ Within 500MB hard cap |

> **Critical:** The 500MB cap is non-negotiable for evaluation. All models must be INT8 quantized. Lazy loading is mandatory — vision model loads only when needed, not at extension install.

### Latency Budget

| Path | Target | Measured |
|------|--------|----------|
| DOM extraction | <10 ms | ~5-8 ms |
| Vision grounding (WebGPU) | <1000 ms | ~300-800 ms |
| PII detection + redaction | <50 ms | ~20-40 ms |
| Server round-trip (local Ollama) | <500 ms | ~200-400 ms |
| **Total per step** | **<1.5 s** | **~1-1.2 s** |

---

## 👥 Team Roles & Branching Strategy

### Team Roster

| Member | GitHub | Role | Responsibilities |
|--------|--------|------|------------------|
| **Himanshi** | Himanshi-256 | Frontend Lead | Extension UI, SoM overlay, popup, Tailwind styling, PPT |
| **Anirudh** | anirudh657 | Frontend | React components, heatmap, resource monitor, privacy ledger UI |
| **Yuvraj** | YuvrajGora | Backend Lead | FastAPI server, Ollama integration, action protocol |
| **Laavannya** | — | Backend | PII detection, sanitization, firewall, audit log (complete) |
| **Yash** | Yashop965 | Optimization + Testing | Memory profiling, INT8 quantization, latency tuning, ad video, judge report, E2E |
| **Vedant** | VedantSinghal | Testing | Test suites, CI gates |

### Branching Strategy

**Main branch protection:** `main` is protected — no direct pushes. All changes via pull requests with at least one approval (review comment on every PR; GitHub blocks self-approving own PRs, so use `gh pr review N --comment`).

**Feature branch naming convention:**
```
feat/<username>-<feature>
```

**Merge workflow:**
1. Create feature branch from `main`
2. Commit with conventional commits (`feat:`, `fix:`, `docs:`)
3. Push and open PR targeting `main`
4. Require 1 approval + passing CI checks
5. Squash merge to `main`

---

## 🎯 Judging Criteria Alignment

The official evaluation weights from ISRO PS171:

| Metric | Weight | Our Target | Key Features |
|--------|--------|------------|--------------|
| **Accuracy of visual context from screen** | 25% | Hybrid DOM + vision grounding | Florence-2 SoM overlay, DOM fallback, 90%+ element detection |
| **Recall + Precision of PII detection** | 20% | Checksum-validated regex + context-aware filtering + face detection | Aadhaar (Verhoeff), PAN, Luhn cards, password blackout — false positives cut 722 → ~15 |
| **Precision of redaction** | 20% | Layered redaction with tamper-detecting privacy ledger | Zero PII in outbound payload, live audit log, 100% redaction precision |
| **Client-side resource utilization** | 20% | INT8 quantized models, lazy loading | <500MB RAM, WebGPU acceleration, DOM path <10ms |
| **Overall end-to-end latency** | 15% | Tiered pipeline: DOM (~10ms) → Vision (~1s) | <1.5s per action step, live resource monitor |

### Scoring Strategy

> **Key Insight:** Privacy metrics (40% combined) outweigh agent accuracy (25%). Our differentiator is the **provable privacy pipeline** — a tamper-detecting ledger showing exactly what was blocked, redacted, and sent.

**Must-haves for full marks:**
- ✅ Working Chrome AND Firefox extension
- ✅ In-browser vision model (WebGPU or WASM fallback)
- ✅ PII redaction demonstrated BEFORE any network request
- ✅ Server receives ONLY sanitized metadata
- ✅ End-to-end task demo (multi-page autonomy)
- ✅ Privacy ledger showing audit trail

---

## 🚀 Quick Setup Instructions

### Prerequisites

- **Node.js 20+** and **npm/pnpm**
- **Python 3.11+**
- **Ollama** (for local LLM inference)
- **Chrome** or **Firefox** (Chrome with WebGPU enabled)

### Install & Run (5 minutes)

```bash
# 1. Navigate
cd C:/Users/yashs/SIH2026/ps171-browser-agent

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies
pip install -r server/requirements.txt

# 4. Pull local LLM model
ollama pull qwen2.5:1.5b

# 5. Start the planner server (Terminal 1)
python -m uvicorn server.main:app --port 8000
#    — real LLM key lives in server/.env (gitignored)

# 6. Build the extension (Terminal 2)
npm run build        # → dist/chrome-mv3 + dist/firefox-mv2
#   or dev mode:  npm run dev:client
```

> Smoke-test: `POST /plan` → check `degraded: false` **and** that `checklist` echoes back (the current contract).

### Load Extension in Browser

1. Open `chrome://extensions` (or `about:debugging` in Firefox)
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select `C:\Users\yashs\SIH2026\ps171-browser-agent\dist\chrome-mv3`
5. **Reload the extension after every rebuild** — the running service worker keeps the old code. MV3 SW spins down when idle.

### Run the Demo

1. Start the planner server, then open the extension
2. For a controlled PII demo, serve the test page: `node scripts/e2e-server.js` → `http://localhost:3000/pii-test-page.html`
3. Click the extension icon, enter a task (e.g. *"Fill the form and submit"*)
4. Watch the SoM overlay / heatmap appear and the extension execute actions
5. Observe the Privacy Ledger tracking all redactions in real time

**Live multi-page driver:** `node scripts/run_bug_c_e2e.mjs` (kicks off via the real popup UI, then watches the persisted `browser.storage.local` log — robust to the agent clobbering the popup-as-a-tab). `scripts/run_autonomy_live.mjs` is the older DOM-scraping variant with live extension-id discovery.

---

## 📁 Project Structure

```
ps171-browser-agent/
├── README.md                 # This file
├── LICENSE                   # MIT License
├── wxt.config.ts             # WXT extension configuration (srcDir: src)
├── tsconfig.json             # TypeScript configuration
├── tailwind.config.js        # Tailwind CSS configuration
├── server/                   # FastAPI planner server
│   ├── main.py               # FastAPI application entrypoint
│   ├── planner.py            # LLM planning + task-checklist prompt rules
│   ├── action_executor.py    # Action execution / UACC
│   ├── llm_clients/          # Ollama + OpenAI-compatible providers
│   ├── middleware/           # Validation, rate limiting
│   └── requirements.txt
├── src/                      # WXT extension source (srcDir: src)
│   ├── entrypoints/
│   │   ├── background.ts     # MV3 service worker (session-owned loop, ledger, port retry)
│   │   ├── content.ts        # Content script (DOM, vision, privacy)
│   │   └── popup/
│   │       ├── index.html    # Popup UI entry
│   │       └── main.tsx      # React mount
│   ├── components/
│   │   ├── Heatmap.tsx       # PII heatmap cards (modern, emoji icons)
│   │   ├── PrivacyLedger.tsx # Live PII audit log
│   │   ├── ResourceMonitor.tsx # RAM/CPU latency + resource HUD
│   │   └── SoMOverlay.tsx    # Set-of-Marks bounding boxes
│   ├── hooks/
│   │   ├── usePIIDetector.ts
│   │   ├── useVisionModel.ts # Transformers.js model loading
│   │   └── useSystemResources.ts
│   ├── lib/
│   │   ├── agentRunner.ts    # SW-owned autonomous task loop
│   │   ├── sessionManager.ts # Session-driven task lifecycle
│   │   ├── actions.ts        # Action executor (CLICK/TYPE/.../KEY/DONE)
│   │   ├── loopDetection.ts  # Loop/repeat detection module
│   │   ├── portRetry.ts      # withPortRetry (transient content-port drops)
│   │   ├── providerConfig.ts # LLM provider selection + fallback
│   │   ├── profiler.ts       # Resource/latency profiling
│   │   ├── dom.ts            # DOM extraction helpers
│   │   ├── privacy.ts        # PII orchestration
│   │   ├── pii/              # PII pipeline: detector, redactor, firewall,
│   │   │                     #   outboundGuard, sanitizer, validators,
│   │   │                     #   privacyLedger, audit (SHA-256 chain)
│   │   ├── vision/           # florence2.ts, som.ts, memory.ts
│   │   └── vision.ts         # Vision model orchestration
│   ├── types/index.ts        # Shared TypeScript types (AgentAction, PII, …)
│   ├── workers/              # Web Workers for vision inference
│   ├── manifest.json
│   └── browser.ts            # Cross-browser API shim
├── public/                   # Static assets + pii-test-page.html (controlled E2E)
│   ├── icon.svg
│   └── pii-test-page.html
├── scripts/                  # e2e drivers, dev server, quantize, verify
│   ├── e2e-server.js         # Static server for pii-test-page.html (port 3000)
│   ├── run_bug_c_e2e.mjs     # Live multi-page E2E driver (recommended)
│   ├── run_autonomy_live.mjs # Older DOM-scraping driver + live ext-id discovery
│   ├── verify_florence2.mjs  # Vision pipeline verification
│   └── quantize.py
├── docs/                     # All project documentation
│   ├── PRD.md
│   ├── API.md
│   ├── TESTING-GUIDE.md
│   ├── AUDIT-FINDINGS.md
│   ├── SESSION-2026-09-16.md / SESSION-2026-09-17.md
│   └── …
└── ad_pipeline/              # Programmatic demo-video pipeline (Pillow + ffmpeg + TTS)
```

---

## 📅 Timeline

The college internal round deadline was **September 2, 2026**. The core 4-day build
(foundation → core features → integration → polish) shipped the autonomous,
privacy-first extension. Post-deadline hardening shipped in two waves:

- **Sep 10–17:** PII false-positive reduction (722 → ~15), heatmap redesign, live
  multi-page autonomy (#84/#85/#86), planner task-checklist cross-page memory
  (#99), port-retry (#105).
- **Sep 19–22 (hardening wave 1):** jev-ultrafast pattern port (PRs #124/#125 — occlusion check,
  aria-hidden/inert filter, event-aware settle, freshness guard, extract cap,
  value gate), live-validation fixes (planner truncation, stableId resolution,
  form-submit, per-page memory, 0-element stall safety), on-device VLM
  verification (#113 model load proven), codebase audit, GSAP cursor, PII
  criticals C1–C3, and the planner loop-guard (PR #130) — verified by a clean
  3-hop live E2E.
- **Sep 19–22 (UI/UX make-over wave, PR #137):** Notion-style **agent cursor v3**
  (#137 — presence badge + sonar ping), **task history** (#134 — cached prompts,
  one-click re-run), **live VLM indicator** (#136), **lower-section modernization**
  (#135 — card heatmap + "quiet" PII de-noise), and the **fast planner model**
  (#133 — zero-reasoning, ~4× faster live). Shipped as one squash-merged PR with
  all suites green (421/421 vitest · 74/74 pytest · 1.33 MB build).
- **Sep 23 (cursor v5 wave, this PR):** agent cursor rebuilt to the user's
  reference — the "select" pointer (mirrored, tip top-left), **theme-aware
  colors** (black on light / white on dark sites), a **border-tracing blue
  working glow** (blurred stroke of the same path — no badge/dot/sonar), and
  **closed-loop travel** (v5.2: one full 360° circle between A and B, G1
  tangent-continuous, constant ~320px/s, slow + watchable). 429/429 vitest ·
  74/74 pytest · 1.33 MB. The movement-pattern engine is being reworked next
  (issue #139), which also tracks the open light-mode color bug.

Open feature issues **#100–#104 / #113 / #115 / #139** (local vision stop,
agent-cursor overlay hardening, local user-profile, heatmap visual polish,
on-device VLM live loop, VLM fallback extractor, **cursor movement-pattern
engine rework**) are scoped; most cursor/VLM pieces now have a
proven standalone path. The on-device VLM *live end-to-end* loop (#113) is the
one remaining open item — the model loads on-device and the new `VlmIndicator`
(#136) surfaces its state, but the full OCR-confirmed run still needs a live pass.

---

## 🎯 Demo Strategy

### Primary Demo: Government Portal / Multi-page Task
1. Open a mock income-tax / Aadhaar enrollment form (or `pii-test-page.html`)
2. Click extension icon, enter: *"Fill all fields with test data and submit"*
3. Extension autonomously:
   - Captures state, runs vision, generates SoM overlay
   - Redacts any pre-existing PII (passwords, Aadhaar numbers) **before** egress
   - Sends sanitized metadata + checklist to the planner
   - Receives action commands and executes them (click / type / select / key / navigate / wait)
4. Live popup shows: heatmap cards, resource monitor, and the privacy ledger
   scrolling in real time.

### Adversarial Moment
Invite judges to type a fake Aadhaar number or credit card into the form — watch it get caught and redacted before any network request.

### Offline Mode
Flip Wi-Fi off mid-demo — DOM path + local Ollama continue working, proving the offline/sovereignty story.

---

## 🔧 Risk Mitigation

| Risk | Mitigation |
|------|------------|
| WebGPU unavailable (older hardware/Firefox) | WASM fallback for Transformers.js |
| Small model accuracy limits | Hybrid DOM+vision consensus; fast DOM path first |
| Stateless planner re-does completed work across pages | Planner-authored task checklist as cross-page memory (#99), DONE gated on it |
| Navigating click drops content port → crash | `withPortRetry` retries the transient case, fails fast on genuine errors (#105) |
| Slow CPU inference | INT8 quantized models, lazy load, tiered pipeline |
| Missing PII detector | Defense in depth: regex + checksums + structural blacklisting + context-aware filtering |
| Scope creep | Cap agent at the action vocabulary; one polished demo flow |

---

## 🎬 Video Ad Pipeline

Programmatic launch-ad video (9 scenes, 56.5s, 3 themes) built with
Pillow + ffmpeg + edge-tts — real extension screenshots, no manual
recording. **See [`ad_pipeline/README.md`](./ad_pipeline/README.md)**
for the full pipeline, quick-start commands, and conventions.

**Final deliverables** (repo root, ~12 MB each, QC 67/0):

| File | Theme |
|------|-------|
| `SIH2026_PS171_YC_Ad_black_FINAL.mp4` | lead (black) |
| `SIH2026_PS171_YC_Ad_project_FINAL.mp4` | indigo, matches extension UI |
| `SIH2026_PS171_YC_Ad_light_FINAL.mp4` | warm paper, matches Popup.css |

Rebuild: `python ad_pipeline/build_ad.py --theme all` →
`python ad_pipeline/qc_frames.py --theme all` →
`python ad_pipeline/assemble_final.py --theme all`.

---

## 📚 References

- **Problem Statement:** [SIH 2026 PS171](https://sidh.nihm.ac.in/page/participants/problem-statements)
- **Transformers.js v3:** https://huggingface.co/blog/transformersjs-v3
- **Florence-2-base-ft:** https://huggingface.co/microsoft/Florence-2-base-ft
- **WXT Framework:** https://wxt.dev
- **Ollama:** https://ollama.com
- **Reference Implementation:** https://github.com/shashank-tomar0/super-agent
- **OS-Atlas:** https://github.com/OS-Atlas/OS-Atlas
- **ShowUI-2B:** https://huggingface.co/showlab/ShowUI-2B
- **DPDP Act 2023:** https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf
- **Research Dossier:** [PS171_Deep_Research_Dossier.md](../Team_Pack/2_BACKUP_PS171_Browser_Agent/PS171_Deep_Research_Dossier.md)

---

## 📜 License

MIT License — see [LICENSE](./LICENSE) for details.

---

*Built for Smart India Hackathon 2026 · Team of 6, B.Tech CSE · All tools free/open-source*
