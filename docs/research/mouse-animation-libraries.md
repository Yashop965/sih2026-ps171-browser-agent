# Mouse / Cursor Animation Libraries for the Agent-Cursor Overlay

Research date: 2026-09-22. Target: WXT Chrome-extension content script, vanilla TypeScript,
no React/Vue; the overlay (arrow + focus ring + action label) renders on top of arbitrary web
pages. All size/license/release claims below were verified against the npm registry, jsDelivr
CDN bytes, or GitHub as of 2026-09-22 — not blog posts.

## 1. Current implementation (`src/lib/agentCursor.ts`)

What it does today:

- Injects one fixed-position host div (`#__agent-cursor`) into `document.body` with
  `position:fixed; pointer-events:none; z-index:2147483647`.
- Three child nodes: a **ring** that hugs the target rect (+8px padding), an **arrow**
  (26px SVG pointer with white outline + drop-shadow), and a **label pill**
  (`CLICK · button`). Colour = action kind (CLICK/TYPE/SELECT/KEY).
- Positioning: `getBoundingClientRect()` → `transform: translate(...)`; movement is a
  fixed CSS `transition: transform 260ms cubic-bezier(.22,1,.36,1)`.
- Pure presentation layer: helpers (`cursorStyles`, `cursorLabel`) are exported and
  jsdom-testable; `showCursor`/`hideCursor`/`removeCursor` never throw.

Why it feels "rusty" (production gaps):

1. **Fixed 260ms duration for every hop** — a 50px nudge and a full-screen jump move at the
   same speed; real cursors are distance/velocity aware.
2. **Ring animates `width`/`height`** via CSS transition — layout properties, not
   transform-only, so reflows the host each hop; no spring/overshoot feel.
3. **No click/press feedback** — no ripple, no scale-down, no "settled" pulse on arrival.
4. **No sequenced effects** — ring pulse, label fade-in and travel are independent CSS
   transitions, not one interruptible timeline.
5. **No tween-interrupt/overwrite semantics** — retargeting mid-glide restarts the CSS
   transition; no velocity carry-over, so mid-flight changes look jerky.
6. **Single hardcoded easing**; no `prefers-reduced-motion` handling.
7. **No style isolation** — the overlay is a plain DOM node, so page CSS can
   target/hide `#__agent-cursor`; and viewport-relative coords go stale after page scroll.

## 2. Library comparison

| Library (v) | License | Size (min → gzip) | Content-script safe? | Key features | Maintenance (last release / activity) | Fit verdict |
|---|---|---|---|---|---|---|
| **GSAP** 3.15.0 | "Standard no-charge" — free incl. commercial (post-Webflow 2025); *not* MIT | core 71kB → **28kB**; InertiaPlugin +7kB → +3kB (both verified via CDN) | Yes: zero-dep UMD/ESM, rAF-driven, no CSS injection; bundles fine in Vite/WXT | transform-only x/y tweens, 20+ eases + custom bezier, timelines/stagger/keyframes, **overwrite modes**, optional Inertia (velocity-based deceleration) | 3.15.0 on 2026-04-13; 7 releases since 2025; ~3.6M weekly npm downloads | **Best fit** — exactly the features our overlay needs, incl. smooth retarget |
| **Anime.js** 4.5.0 | MIT (repo LICENSE verified) | full ESM bundle 116kB → **40kB** (tree-shakes in WXT/Vite) | Yes: bundlable ESM, zero deps | CSS/SVG/DOM/object animation, spring eases, timeline/stagger, keyframes | 4.5.0 on 2026-06-22; 27 releases since 2025 (sponsored, active); ~750K weekly | Strong runner-up if MIT-only is policy; lacks velocity-aware retargeting |
| **Motion** (motion.dev) 13.4.0 | MIT | full CDN bundle 144kB → **48kB**; depends on `framer-motion` (vanilla entry `/dom`) | Yes, but heavier: pulls framer-motion under the hood | springs, `animate()`, stagger, gestures; built around the framer-motion brand | 13.4.0 on 2026-09-16; extremely active (219 releases since 2025); ~15.4M weekly | Overkill — React-flavored brand, heaviest, no built-in ripple primitive |
| **vanilla-tween** | — | — | — | — | **Does not exist** (2026-09): npm 404 (incl. `@wrep`-scoped guesses), unpkg 404, no GitHub repo found; dead reference | Skip; closest real package is @tweenjs/tween.js (below) |
| **@tweenjs/tween.js** 25.0.0 (the actual "vanilla tween" option) | MIT | ESM 42kB → **7kB**, zero deps | Yes: pure object tweening + rAF loop | Robert-Penner eases, per-tween `onUpdate`, Group batching | 25.0.0 on 2024-07-26 — no release in 2+ years; ~8.1M weekly (inertia of adoption, not activity) | Too bare: no timeline/stagger/overwrite — you'd hand-roll the sequencing we want |
| **Popmotion** 11.0.5 | MIT | superseded | Yes, but irrelevant | springs/motions (historical base of Motion) | 11.0.5 on 2022-08-15 — **abandoned** | Don't use; if you wanted this, use Motion instead |
| **mouse-follower** 1.2.1 (Cuberto) | MIT | 11kB → 3kB | Mostly — but **requires GSAP at runtime** (`registerGSAP`), so adds a second animation dep | delayed mouse-follow cursor for marketing sites (speed, ease, skew) | 1.2.1 on 2026-08-31; low activity (2 releases since 2025) | Wrong model: follows real `mousemove` with a lag; we need programmatic tween-to-rect |
| **mouse-animations** 1.1.0 | MIT (registry) | main entry 0.3kB; advertised <5kB gz total; zero deps, typed | Yes: event-driven effects on the user's real cursor | CustomCursor (dot + lagging ring), Ripple, Particles, Image/Spotlight/Flashlight | 1.1.0 on 2026-08-12; active (7 releases since 2025) | Closest purpose-built lib, but follows the user's mouse; no `to(rect)` tweening API |
| **magic-mouse** 1.0.0 | **none declared** | 44kB unpacked | No | canvas cursor rendering | 2023-01-31 — abandoned | Unshippable in a distributed extension: no license |

## 3. Recommendation

**GSAP 3.15 core, plus InertiaPlugin if the travel should feel inertial.** It is the only
candidate that delivers (1) transform-only coordinate tweens with custom-bezier or
overshoot eases — a direct replacement for the fixed 260ms CSS transition — (2)
timelines + stagger + keyframes, so travel, ring pulse, label fade and click ripple
sequence into one interruptible unit, and (3) `overwrite` modes with velocity
carry-over, so a mid-glide retarget re-steers smoothly instead of teleporting. The
"standard no-charge" license is free for commercial use (since 2025); it is not MIT,
but the code is public and the terms are unambiguous for a shipped extension. Core is
~28kB gzipped (+3kB Inertia), zero-dep, no CSS injection — Vite tree-shakes it into the
content script with no network dependency on the host page. If MIT-only is a hard
policy, fall back to **Anime.js 4.5** (40kB gz, springs, MIT) and accept the missing
velocity-aware retarget.

## 4. Integration notes (if adopting GSAP)

**Bundle & import.** `import { gsap } from "gsap"; import InertiaPlugin from "gsap/InertiaPlugin";
gsap.registerPlugin(InertiaPlugin);` WXT bundles this into the content script — zero deps, no
CDN, so arbitrary host pages can't break it at runtime.

**Cursor travel (arrow).** Animate `x`/`y` as transforms only:
`gsap.to(arrow, { x: cx-4, y: cy-2, duration: clamp(dist/1600, 0.15, 0.6), ease: "power3.out",
overwrite: "auto", immediateRender: true })`. With Inertia: `inertia.to(arrow, { x, y,
resistance: 3 })` for velocity-based deceleration. Keep `will-change: transform` on the moving
node; never animate layout properties.

**Focus ring.** Kill the width/height CSS transition: set ring `width`/`height` to the target
(+8px) instantly (cheap — it's our own 2px border, not page content) and animate only
`transform: translate(...) scale(0.92 → 1)` so the pulse stays GPU-only. Arrival pulse: a
short `gsap.fromTo` on scale + border-color.

**Click ripple.** On action fire, spawn one temporary div inside the host, then
`gsap.fromTo(ripple, { scale: 0.25, opacity: 0.55 }, { scale: 2.4, opacity: 0, duration: 0.45,
ease: "power2.out", onComplete: () => ripple.remove() })` — transform/opacity only.

**Sequencing.** `gsap.timeline({ defaults: { overwrite: "auto" } })`: travel → ring pulse →
label fade-in. One timeline per target; a new `showCursor` call kills the previous timeline
mid-flight and re-targets from the current position (overwrite semantics, no jump).

**Z-index / pointer-events / isolation on arbitrary pages.**
- Host keeps `position:fixed; pointer-events:none; z-index:2147483647` (Int32 max — no page
  CSS can exceed it; a tie is cosmetic-only since we intercept nothing).
- **Add a shadow root:** `host.attachShadow({ mode: "open" })` and move ring/arrow/label/ripple
  into it with a scoped `<style>`. Page CSS (including hostile `#__agent-cursor{display:none}`
  or `*{pointer-events:auto}`) then cannot reach the inner nodes; only inheritable properties
  (font, color) leak in — set `all:initial` on the shadow root or override them in the shadow
  style. This is the single biggest hardening over the current implementation.
- Keep every overlay node `pointer-events:none` so neither the user's mouse nor the agent's own
  dispatched events are intercepted.

**Scroll/resize staleness.** Coords are viewport-relative; attach a rAF-throttled
scroll/resize listener that re-runs the pure `cursorStyles()` + `gsap.set()` (no animation) so
the overlay stays glued to the target while the executor scrolls.

**Iframes.** Top-frame overlay only; elements inside cross-origin iframes are unreachable from
this content script (out of scope — would need `all_frames` injection + a background message).

**Reduced motion.** `gsap.matchMedia()` (or a plain media-query check) → when
`prefers-reduced-motion` is set, use `gsap.set()` (instant positioning), skip ripple/pulse.

**Testability.** Keep `cursorStyles()`/`cursorLabel()` pure as they are; funnel movement through
one `travelTo(cx, cy, kind)` helper and mock/`gsap.ticker` in jsdom tests. Never-throw invariant
stays: wrap the timeline in try/catch and fall back to `gsap.set()`.
