// src/lib/agentCursor.ts
//
// Issue #101 / #132 / #137 / #139 — computer-use style "agent cursor" overlay.
//
// v5.3 (user iteration 2026-09-24, movement-engine rework → #139): the
// pointer is the svgrepo "select" cursor, MIRRORED so its tip points
// top-left (classic cursor direction). Behaviors:
//
//   Theme-aware colors, themed off the PAGE: the shape inverts when the
//     page background (html/body, with a local fallback) is dark — black
//     shape + white outline on light sites, white shape + dark outline on
//     dark sites (sampled live, per travel target). A dark card under the
//     tip no longer flips the cursor white on a light page.
//   Border-tracing working glow: a soft blue aura that HUGS the arrow's
//     outline (a blurred blue stroke of the same path, painted behind the
//     arrow — not a separate circular blob) and breathes while the agent
//     is working/thinking ("the agent is doing something right now").
//   Distance-aware travel (loopGeometry v5.3): the hop size picks the
//     path — very close hops snap straight, short–mid hops take a gentle
//     curve, far hops swing ONE small closed 360° loop, and very far hops
//     swing TWO small loops ("a cheerful agent path"). The loop radius
//     scales with the A→B distance, clamped to [36, 120]px, and the whole
//     loop stays inside the tab viewport (8px margin); when a loop can't
//     fit, the hop degrades to the simple curve. Constant arc-length speed
//     (~320px/s, floor 0.9s, cap 4s, no easing) keeps it smooth and
//     watchable; loop joins are G1 (tangent-continuous).
//   No indicators: the v3 presence badge / center dot / sonar ring are
//     GONE — the pointer + border glow + halo + label are the only nodes.
//
// The public API is UNCHANGED (showCursor / pulseCursor / hideCursor /
// removeCursor / startThinkingPulse / stopThinkingPulse / cursorLabel /
// cursorStyles / travelDuration / THINKING_PULSE), so background.ts,
// content.ts, the runner, and the existing tests keep working.
//
// PII contract (unchanged, critical): the overlay never carries values.
// The label is `<KIND> · <TAG>` only — no typed text, no URLs, no PII.
//
// `cursorStyles` / `cursorLabel` / `travelDuration` / `loopGeometry` /
// `samplePageDark` stay pure + jsdom-testable; the GSAP layer is only
// exercised in the live browser.

import { gsap } from 'gsap';

export type CursorActionKind = 'CLICK' | 'TYPE' | 'SELECT' | 'KEY';

export interface CursorPosition {
  /** Viewport (client) coordinates, as from getBoundingClientRect(). */
  x: number;
  y: number;
  width: number;
  height: number;
}

const CURSOR_ID = '__agent-cursor';

// v3: clean, saturated focus colors for the target halo (action kind).
const KIND_COLORS: Record<CursorActionKind, string> = {
  CLICK: '#2563eb',
  TYPE: '#059669',
  SELECT: '#7c3aed',
  KEY: '#d97706',
};

// v5: theme-aware pointer colors. On LIGHT sites the shape is black
// (#111827, reads as black) with a white outline. On DARK sites it
// inverts to white with a near-black outline, so the cursor never turns
// into an invisible blob on a dark page.
const ACCENT = '#2563eb'; // brand blue — halo, working glow, label border
const THEME_LIGHT = { fill: '#111827', stroke: '#ffffff' }; // light sites
const THEME_DARK = { fill: '#ffffff', stroke: '#0f172a' }; // dark sites

// v5.1: the border-tracing "working" glow. Rendered as a blurred blue
// stroke of the SAME cursor path, painted behind the arrow, so the glow
// hugs the arrow's silhouette exactly (its scale/opacity carry the
// "working now" pulse).
const GLOW = {
  /** Resting aura scale (steady "agent present" glow). */
  restScale: 1.0,
  /** Aura scale while a travel is in flight (working, pre-arrival). */
  activeScale: 1.15,
  /** Resting opacity of the aura (peaks at 1.0 when active/pulsing). */
  restOpacity: 0.55,
};

// v5.1: pointer geometry. The shape is the "select" cursor from the user's
// reference (svgrepo select-cursor, 2026-09-23), MIRRORED via a group
// transform so its tip points top-left like a classic cursor. v5.1: the
// box is 24px (34px read as "too big"). The viewBox is 188.324 wide and
// the mirrored tip sits at ~(32, 2) in viewBox units, so at 24px the tip
// is ~(4.1, 0.3) px inside the box — TIP_OFFSET below. Positioning the
// div at (cx - TIP_OFFSET.x, cy - TIP_OFFSET.y) puts the tip exactly on
// the target's centre.
const ARROW_SIZE = 24;
const TIP_OFFSET = { x: 4, y: 0 };
// Two subpaths: the outer contour + the inset detail line (both wind the
// same way -> a solid fill with the classic double-line cursor look).
const CURSOR_PATH_D =
  'M104.552,188.324 l-1.126-0.023 c-8.686-0.485 -16.159-6.421 -18.601-14.758 ' +
  'l-14.164-48.403 l-52.088-10.344 c-8.548-1.675 -15.124-8.622 -16.348-17.279 ' +
  'c-1.224-8.638 3.162-17.134 10.91-21.137 L156.295,2.228 ' +
  'c7.49-3.883 17.143-2.596 23.369,3.119 c6.336,5.827 8.371,15.078 5.083,23.018 ' +
  'l-61.193,147.287 C120.334,183.355 112.872,188.324 104.552,188.324 z ' +
  'M165.741,11.643 c-1.401,0 -2.803,0.346 -4.055,0.989 L18.516,86.789 ' +
  'c-3.339,1.722 -5.223,5.375 -4.697,9.092 c0.529,3.729 3.351,6.713 7.022,7.445 ' +
  'l59.061,11.71 l16.154,55.225 c1.055,3.591 4.269,6.152 8.011,6.358 h0.48 ' +
  'c3.585,0 6.793-2.139 8.183-5.467 l61.188-147.261 ' +
  'c1.413-3.414 0.538-7.399 -2.184-9.907 C170.098,12.475 167.965,11.643 165.741,11.643 z';

export function cursorLabel(kind: CursorActionKind, targetTag: string): string {
  return `${kind} · ${targetTag}`;
}

/**
 * Compute the fixed-position CSS for the cursor from a target rect.
 * Pure so it is trivially unit-testable: given the element's on-screen
 * rect, where should the cursor land and how big is the ring?
 *
 * - The cursor tip sits at the element's center.
 * - The target halo hugs the element's box (+8px padding).
 * - Zero/negative/NaN rects (detached or unrendered nodes) collapse to a
 *   halo-less cursor at (0,0) rather than producing `NaNpx` CSS.
 */
export function cursorStyles(
  rect: CursorPosition,
  kind: CursorActionKind,
): { transform: string; width: string; height: string; border: string; background: string } {
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const w = clean(rect.width);
  const h = clean(rect.height);
  const cx = clean(rect.x + w / 2);
  const cy = clean(rect.y + h / 2);
  const ringed = w > 0 && h > 0;
  return {
    transform: `translate(${cx}px, ${cy}px) translate(-50%, -50%)`,
    width: ringed ? `${w + 8}px` : '0px',
    height: ringed ? `${h + 8}px` : '0px',
    border: ringed ? `2px solid ${KIND_COLORS[kind]}` : 'none',
    background: ringed ? `${KIND_COLORS[kind]}14` : 'transparent',
  };
}

/**
 * Travel duration for a hop whose PATH length is `dist` viewport px.
 * v5.2 pacing (user: "a lot more smooth movement but slow"): the cursor
 * travels at ~320px/s along the actual loop path, with a 0.9s FLOOR so
 * even a tiny hop shows a full loop and a 4s cap so cross-screen jumps
 * stay deliberate, not sluggish. Constant speed (no easing inside the
 * travel) keeps the loop perfectly smooth. Pure (testable): returns
 * seconds. Hops of 2px or less still snap instantly (no visible travel
 * to speak of).
 */
export function travelDuration(dist: number): number {
  if (!Number.isFinite(dist) || dist <= 2) return 0;
  return Math.min(4, Math.max(0.9, dist / 320));
}

// ── v5.3 travel shaping: distance-aware loop counts + viewport fit ─────────
/** Hops at or under this px travel a straight path (no loop to swing). */
export const SNAP_MAX = 60;
/** Hops at least this far swing ONE small loop; at least this far, TWO. */
export const LOOP_FAR_1 = 260;
export const LOOP_FAR_2 = 700;
/** Loop radius: scaled with distance, clamped to this band (small loops). */
export const LOOP_R = { min: 36, max: 120, factor: 0.25 };
/** Keep the whole loop inside the tab viewport (px margin from the edge). */
export const VIEWPORT_MARGIN = 8;
/** Gentle-curve bow for mid hops (0 -> straight path on the shortest hops). */
export const CURVE_BOW = { min: 24, max: 90, factor: 0.18 };

export type TravelMode = 'snap' | 'curve' | 'loop';

export interface LoopGeometry {
  /** How the hop is drawn: straight / single gentle bow / closed loop(s). */
  mode: TravelMode;
  /** Number of full 360° circles to swing (0/1/2); 'curve'/'snap' = 0. */
  loops: number;
  /** true only when mode === 'loop' (kept for back-compat). */
  loop: boolean;
  /** Loop circle center (mid-point, jitter-offset); the curve ctrl otherwise. */
  cx: number;
  cy: number;
  /** Loop radius (px); 0 for curve/snap. */
  r: number;
  /** Entry point of the drawn middle (from-point for curve; loop tangent). */
  entry: { x: number; y: number };
  /** Exit point of the drawn middle (to-point for curve; loop tangent). */
  exit: { x: number; y: number };
  /** Entry angle on the loop circle (radians); 0 for curve/snap. */
  alpha0: number;
  /**
   * Signed sweep (radians): `2π*loops` closed circles + the small connecting
   * arc that carries the cursor to B's tangent point, so entry AND exit stay
   * tangent-continuous (G1) and the exit lands smoothly on B. 0 for curve.
   */
  sweep: number;
  /** Length of the straight approach A -> entry (loop mode only). */
  approachLen: number;
  /** Length of the straight exit -> B segment (loop mode only). */
  finalLen: number;
  /** Length of the drawn middle: arc (loop) or curve (bezier). */
  arcLen: number;
  /** Total path length the cursor rides (approach + middle + final). */
  pathLen: number;
  /** Path share [0..1] of the straight approach segment. */
  approachShare: number;
  /** Path share [0..1] of the middle (arc/curve) segment. */
  arcShare: number;
  /** Quadratic-bezier control point (only when mode === 'curve'). */
  curveCtrl?: { x: number; y: number };
}

/** Pre-compute a quadratic-bezier arc-length LUT for constant-speed travel. */
export function quadBezierLUT(
  a: { x: number; y: number },
  c: { x: number; y: number },
  b: { x: number; y: number },
  n = 32,
): { pts: Array<{ x: number; y: number }>; cum: number[]; total: number } {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    pts.push({
      x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
      y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
    });
  }
  const cum: number[] = new Array(pts.length).fill(0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum[i] = total;
  }
  return { pts, cum, total };
}

/** Constant-speed position along a quadratic bezier at progress u in [0,1]. */
export function quadBezierPoint(
  lut: { pts: Array<{ x: number; y: number }>; cum: number[]; total: number },
  u: number,
): { x: number; y: number } {
  const { pts, cum, total } = lut;
  if (total <= 0) return pts[0];
  const target = Math.max(0, Math.min(1, u)) * total;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1];
  const f = seg > 0 ? (target - cum[i - 1]) / seg : 0;
  const p0 = pts[i - 1], p1 = pts[i];
  return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
}

/**
 * v5.3: the travel-shaping decision, by distance. While traveling from A to
 * B the cursor takes the path that matches the hop size:
 *
 * - **Very close (≤ SNAP_MAX)** → **snap**: no visible swing at all (a loop
 *   would be larger than the hop). The engine places the cursor instantly.
 * - **Short–mid hops (SNAP_MAX → LOOP_FAR_1)** → **curve**: a single gentle
 *   quadratic bow (the "curved path"), bow scaled with the distance.
 * - **Far hops (≥ LOOP_FAR_1)** → **loop**: one SMALL closed 360° loop, with
 *   tangent-continuous (G1) entry/exit — the "agent" swing.
 * - **Very far hops (≥ LOOP_FAR_2)** → **two small loops** (still bounded
 *   by the radius clamp) — the "cheerful" long-haul path.
 *
 * The loop radius is scaled with the A→B distance and clamped to
 * [LOOP_R.min, LOOP_R.max] (the loops stay small and readable). When a
 * `viewport` is passed, the whole loop is kept inside it (center pulled in,
 * radius capped to fit); if even the minimum radius no longer fits, the hop
 * **degrades to the curve** instead of escaping the tab.
 *
 * - Rotation side is DETERMINISTIC (rightward travel swings one way,
 *   leftward the other) — same A/B pair always takes the same path.
 * - `jitter` (default 0, clamped [-1,1]) offsets the center/radius/bow
 *   organically per hop; jitter=0 is deterministic (testable).
 * - Non-finite inputs degrade to the snap geometry, never NaN.
 */
export function loopGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  jitter = 0,
  viewport?: { width: number; height: number },
): LoopGeometry {
  const fx = Number.isFinite(from.x) ? from.x : 0;
  const fy = Number.isFinite(from.y) ? from.y : 0;
  const tx = Number.isFinite(to.x) ? to.x : 0;
  const ty = Number.isFinite(to.y) ? to.y : 0;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  const jj = Number.isFinite(jitter) ? Math.max(-1, Math.min(1, jitter)) : 0;
  const w = dx >= 0 ? 1 : -1; // deterministic rotation side
  const ux = len > 0 ? dx / len : 1, uy = len > 0 ? dy / len : 0;
  const px = -uy, py = ux; // perpendicular (90° rotated, y-down screen)

  // ── gentle quadratic-bow fallback (used by the curve band AND when a
  //    loop can't fit the viewport). The bow scales with distance, stays
  //    organic with jitter, and is capped by the viewport when given.
  const curveFallback = (): LoopGeometry => {
    let bow = Math.max(
      CURVE_BOW.min,
      Math.min(CURVE_BOW.max, CURVE_BOW.factor * len),
    ) * (1 + 0.35 * jj);
    bow = Math.max(12, bow);
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      bow = Math.min(bow, Math.min(viewport.width, viewport.height) / 4);
    }
    const cx = (fx + tx) / 2 + px * bow * w;
    const cy = (fy + ty) / 2 + py * bow * w;
    const ctrl = { x: cx, y: cy };
    const total = quadBezierLUT({ x: fx, y: fy }, ctrl, { x: tx, y: ty }, 24).total;
    return {
      mode: 'curve', loops: 0, loop: false,
      cx, cy, r: 0,
      entry: { x: fx, y: fy }, exit: { x: tx, y: ty },
      alpha0: 0, sweep: 0,
      approachLen: 0, finalLen: 0,
      arcLen: total, pathLen: total,
      approachShare: 0, arcShare: 1,
      curveCtrl: ctrl,
    };
  };

  // ── very close / garbage: no visible swing (engine places instantly).
  if (!Number.isFinite(len) || len <= SNAP_MAX) {
    return {
      mode: 'snap', loops: 0, loop: false,
      cx: tx, cy: ty, r: 0,
      entry: { x: fx, y: fy }, exit: { x: tx, y: ty },
      alpha0: 0, sweep: 0,
      approachLen: len, finalLen: 0, arcLen: 0, pathLen: len,
      approachShare: 1, arcShare: 0,
    };
  }

  // ── short–mid hop: the curved path.
  if (len < LOOP_FAR_1) return curveFallback();

  // ── far hop: small closed loop(s), distance-scaled + clamped radius.
  const loops = len >= LOOP_FAR_2 ? 2 : 1;
  // Loop center: mid-way along the hop, pushed sideways by the jitter so no
  // two hops swing the loop in exactly the same place.
  let cxF = fx + ux * len / 2 + px * jj * 0.2 * len;
  let cyF = fy + uy * len / 2 + py * jj * 0.2 * len;
  // Radius: scaled with the A→B distance, clamped to the [min, max] band
  // (loops stay small), jittered organically.
  let r = Math.max(
    LOOP_R.min,
    Math.min(LOOP_R.max, LOOP_R.factor * len * (1 + 0.1 * jj)),
  );
  // Viewport containment: pull the center inside the margin box, cap r so
  // the whole circle stays visible; if even the min radius no longer fits,
  // degrade to the curve (the user's "becomes a simple curve" rule).
  if (
    viewport &&
    viewport.width > 2 * VIEWPORT_MARGIN &&
    viewport.height > 2 * VIEWPORT_MARGIN
  ) {
    const M = VIEWPORT_MARGIN;
    cxF = Math.max(M, Math.min(viewport.width - M, cxF));
    cyF = Math.max(M, Math.min(viewport.height - M, cyF));
    const fit = Math.min(
      cxF - M,
      viewport.width - M - cxF,
      cyF - M,
      viewport.height - M - cyF,
    );
    r = Math.min(r, fit);
    if (r < LOOP_R.min) return curveFallback();
  }

  // Tangent point FROM an external point P to the circle (C, r):
  //   T = C + (r²/D²)·(P−C) ± (r·√(D²−r²)/D)·perp(P−C)/D
  // implemented numerically; `side` picks which of the two tangents.
  const tangents = (Px: number, Py: number): Array<{ x: number; y: number }> => {
    const ddx = Px - cxF;
    const ddy = Py - cyF;
    const D = Math.hypot(ddx, ddy);
    if (D <= r) return []; // P inside/on the circle - no real tangents
    const k = (r * r) / (D * D);
    const s = (r * Math.sqrt(D * D - r * r)) / D;
    const pnx = -ddy / D, pny = ddx / D; // unit perpendicular of (P-C)
    return [
      { x: cxF + k * ddx + s * pnx, y: cyF + k * ddy + s * pny },
      { x: cxF + k * ddx - s * pnx, y: cyF + k * ddy - s * pny },
    ];
  };
  const tAs = tangents(fx, fy);
  const tBs = tangents(tx, ty);
  if (tAs.length < 2 || tBs.length < 2) return curveFallback();

  // Pick the same SIDE for A and B (the loop sits on one side of the
  // line): side s is chosen by the rotation direction so the entry is
  // tangent-continuous (the approach arrives the way the loop departs).
  const side = w === 1 ? 0 : 1;
  const entry = tAs[side];
  const exit = tBs[side === 0 ? 1 : 0]; // opposite side index on B (mirror)

  const phiA = Math.atan2(entry.y - cyF, entry.x - cxF);
  const phiB = Math.atan2(exit.y - cyF, exit.x - cxF);
  // The signed angle from phiA to phiB in the sweep direction (0..2π),
  // so the exit tangent continues the same rotation.
  let delta = (phiB - phiA) * w;
  delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // `loops` closed 360° circles + the connecting arc to B's tangent point.
  const sweep = w * (2 * Math.PI * loops + delta);

  const approachLen = Math.hypot(entry.x - fx, entry.y - fy);
  const arcLen = Math.abs(sweep) * r;
  const finalLen = Math.hypot(tx - exit.x, ty - exit.y);
  const pathLen = approachLen + arcLen + finalLen;
  return {
    mode: 'loop', loops, loop: true, cx: cxF, cy: cyF, r,
    entry, exit, alpha0: phiA, sweep,
    approachLen, finalLen, arcLen, pathLen,
    approachShare: pathLen > 0 ? approachLen / pathLen : 0,
    arcShare: pathLen > 0 ? arcLen / pathLen : 0,
  };
}

/**
 * v5.3: sample whether the PAGE under a viewport point is dark — themed off
 * the page-level background, not the local element under the tip.
 *
 * 1) PAGE LEVEL (the theme of the site): the first non-transparent
 *    background of `documentElement` / `body` wins — light page → dark
 *    arrow, dark page → white arrow. This is the primary signal, so a
 *    dark banner/card sitting under the cursor can no longer flip the
 *    whole cursor white on a light site.
 * 2) LOCAL fallback: sites that set their theme on a full-viewport div
 *    instead of body/html (common with CSS resets that leave body
 *    transparent) — walk up from `elementFromPoint` to the first opaque
 *    background, exactly like the v5 implementation.
 *
 * Luminance (0.2126 R + 0.7152 G + 0.0722 B, WCAG weights on 0-255
 * values) under 128 counts as "dark". Returns `null` when nothing is
 * sampleable (e.g. jsdom, no layout) — callers fall back to the light
 * theme (black arrow), the safe default. Never throws: theme detection
 * is presentation-only.
 */
export function samplePageDark(
  x: number,
  y: number,
  doc: Document = document,
): boolean | null {
  try {
    const win = doc?.defaultView;
    if (!win || typeof win.getComputedStyle !== 'function') return null;
    // 1) page-level background first.
    for (const el of [doc?.documentElement, doc?.body]) {
      if (!el) continue;
      const lum = bgLuminance(win.getComputedStyle(el).backgroundColor);
      if (lum !== null) return lum < 128;
    }
    // 2) local fallback (page background transparent: the theme lives on
    //    a full-viewport div reached by walking up from the hit element).
    if (typeof doc.elementFromPoint !== 'function') return null;
    let el = doc.elementFromPoint(x, y) as Element | null;
    for (let i = 0; i < 8 && el; i++) {
      const bg = win.getComputedStyle(el).backgroundColor;
      const lum = bgLuminance(bg);
      if (lum !== null) return lum < 128;
      if (el === doc.body || el === doc.documentElement) break;
      el = el.parentElement;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse `rgb(a)` / `rgba(a)` / `#hex` into 0-255 luminance, or null when transparent/unknown. */
function bgLuminance(color: string): number | null {
  const t = color.trim().toLowerCase();
  if (!t || t === 'transparent') return null;
  let r = 0, g = 0, b = 0, a = 1;
  if (t.startsWith('#') && t.length >= 7) {
    const n = parseInt(t.slice(1, 7), 16);
    if (Number.isNaN(n)) return null;
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = t.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
    if (!m) return null;
    r = parseInt(m[1], 10); g = parseInt(m[2], 10); b = parseInt(m[3], 10);
    if (m[4]) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  }
  if (a < 0.25) return null; // near-transparent: no real coverage
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * v5.1: the idle "thinking" beat. While the agent waits on the planner,
 * the border-tracing WORKING GLOW breathes (scale + opacity) — the
 * "the agent is alive and working" cue. The v3 badge-dot heartbeat and
 * sonar ring are gone (no indicators). One interruptible tween;
 * `travelCurve` / `pulseCursor` / `stopThinkingPulse()` kill it. Pure
 * timing constants so tests can pin the contract.
 */
export const THINKING_PULSE = {
  /** Period of one breathing cycle (out+back), seconds. */
  period: 1.6,
  /** Aura scale peak while thinking (1.0 resting -> 1.18 peak). */
  scalePeak: 1.18,
  /** Arrow resting opacity while thinking (dips from 1.0). */
  arrowDim: 0.7,
};

interface OverlayNodes {
  host: HTMLElement;
  halo: HTMLElement;
  aura: HTMLElement; // v5.1: the border-tracing blue "working" glow (SVG)
  arrow: HTMLElement;
  label: HTMLElement;
  ripple: HTMLElement;
}

/**
 * Build (once) or reuse the v5.1 cursor overlay. The host is a plain
 * fixed node in the light DOM — so `document.getElementById(CURSOR_ID)`
 * keeps working and the pointer-events:none / z-index contract holds for
 * the page. Its *inner* nodes live in an open shadow root with
 * `all:initial` so hostile host-page CSS cannot hide or restyle them.
 *
 * Node map (all absolutely-positioned, motion is transform-only):
 *   .ac-halo   — the soft rounded target box (kind-tinted glow)
 *   .ac-aura   — v5.1: blurred blue stroke of the cursor path, hugging
 *                the arrow's silhouette; painted BEHIND the arrow,
 *                breathes while the agent works
 *   .ac-arrow  — the select-cursor shape (mirrored, tip top-left)
 *   .ac-label  — the dark `<KIND> · <TAG>` pill
 *   .ac-ripple — the click confirmation ripple
 *
 * There is deliberately NO badge, center dot, or sonar ring — the
 * pointer itself + its border glow are the indicator.
 */
function ensureCursorEl(): OverlayNodes | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(CURSOR_ID) as HTMLElement | null;
  if (!host || !host.dataset.agentCursor5) {
    // A pre-v5.1 host (or a stale node without the aura) is replaced
    // wholesale rather than migrated.
    host?.remove();
    host = document.createElement('div');
    host.id = CURSOR_ID;
    host.dataset.agentCursor5 = '1';
    host.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'pointer-events:none',
      'z-index:2147483647',
      'width:0',
      'height:0',
    ].join(';');
    const shadow = host.attachShadow({ mode: 'open' });
    // `all:initial` on :host so no inheritable host property (font,
    // color, direction) leaks in; the overlay is fully self-styled below.
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;top:0;left:0;pointer-events:none;}
.ac-halo{position:absolute;top:0;left:0;border-radius:14px;pointer-events:none;will-change:transform;
box-shadow:0 0 0 0 transparent,0 0 18px 2px rgba(37,99,235,0);}
.ac-aura{position:absolute;top:0;left:0;width:${ARROW_SIZE}px;height:${ARROW_SIZE}px;
pointer-events:none;will-change:transform,opacity;opacity:${GLOW.restOpacity};
transform:translate(0,0) scale(${GLOW.restScale});}
.ac-aura svg{display:block;overflow:visible;filter:blur(5px);}
.ac-aura path{fill:none;stroke:${ACCENT};stroke-width:34;stroke-linejoin:round;}
.ac-arrow{position:absolute;top:0;left:0;width:${ARROW_SIZE}px;height:${ARROW_SIZE}px;pointer-events:none;
will-change:transform,opacity;filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,.35));}
.ac-arrow svg{display:block;overflow:visible;}
.ac-label{position:absolute;top:0;left:0;pointer-events:none;font:600 11px/1 system-ui,sans-serif;
color:#fff;background:#0f172aee;padding:4px 10px;border-radius:9999px;white-space:nowrap;
box-shadow:0 2px 8px rgba(0,0,0,.28);will-change:transform;letter-spacing:.02em;opacity:0;}
.ac-ripple{position:absolute;top:0;left:0;width:56px;height:56px;margin:-28px 0 0 -28px;
border-radius:50%;pointer-events:none;opacity:0;transform:scale(.25);will-change:transform,opacity;}`;
    shadow.appendChild(style);

    const halo = document.createElement('div');
    halo.className = 'ac-halo';
    shadow.appendChild(halo);

    // v5.1: the working aura — a blurred blue stroke of the SAME cursor
    // path, sized exactly like the arrow and painted just BEHIND it, so
    // the glow traces the arrow's border instead of floating as a blob.
    // Its scale/opacity carry the "agent is working now" breathing.
    const aura = document.createElement('div');
    aura.className = 'ac-aura';
    const auraNS = 'http://www.w3.org/2000/svg';
    const auraSvg = document.createElementNS(auraNS, 'svg');
    auraSvg.setAttribute('viewBox', '0 0 188.324 188.324');
    auraSvg.setAttribute('width', String(ARROW_SIZE));
    auraSvg.setAttribute('height', String(ARROW_SIZE));
    const auraGrp = document.createElementNS(auraNS, 'g');
    auraGrp.setAttribute('transform', 'translate(188.324,0) scale(-1,1)');
    const auraPath = document.createElementNS(auraNS, 'path');
    auraPath.setAttribute('d', CURSOR_PATH_D);
    auraGrp.appendChild(auraPath);
    auraSvg.appendChild(auraGrp);
    aura.appendChild(auraSvg);
    shadow.appendChild(aura);

    const arrow = document.createElement('div');
    arrow.className = 'ac-arrow';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 188.324 188.324');
    svg.setAttribute('width', String(ARROW_SIZE));
    svg.setAttribute('height', String(ARROW_SIZE));
    // v5.1: the "select" cursor, MIRRORED so the tip points top-left.
    // Fill/stroke are theme-applied by applyTheme() — the attrs below
    // are the LIGHT default (black arrow) so the first paint is already
    // correct for light sites.
    const grp = document.createElementNS(svgNS, 'g');
    grp.setAttribute('transform', 'translate(188.324,0) scale(-1,1)');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', CURSOR_PATH_D);
    path.setAttribute('fill', THEME_LIGHT.fill);
    path.setAttribute('stroke', THEME_LIGHT.stroke);
    path.setAttribute('stroke-width', '14');
    path.setAttribute('stroke-linejoin', 'round');
    grp.appendChild(path);
    svg.appendChild(grp);
    arrow.appendChild(svg);
    shadow.appendChild(arrow);

    const label = document.createElement('div');
    label.className = 'ac-label';
    shadow.appendChild(label);

    const ripple = document.createElement('div');
    ripple.className = 'ac-ripple';
    shadow.appendChild(ripple);

    document.body.appendChild(host);
  }
  const shadow = (host as HTMLElement).shadowRoot;
  if (!shadow) return null;
  const halo = shadow.querySelector('.ac-halo') as HTMLElement | null;
  const aura = shadow.querySelector('.ac-aura') as HTMLElement | null;
  const arrow = shadow.querySelector('.ac-arrow') as HTMLElement | null;
  const label = shadow.querySelector('.ac-label') as HTMLElement | null;
  const ripple = shadow.querySelector('.ac-ripple') as HTMLElement | null;
  if (!halo || !aura || !arrow || !label || !ripple) return null;
  return { host: host as HTMLElement, halo, aura, arrow, label, ripple };
}

/**
 * v5.1: flip the pointer between the light/dark themes. Called on every
 * travel against the TARGET point — so the cursor inverts exactly when
 * it lands on (or glides into) a dark area. jsdom / no-layout / unknown
 * sample falls back to the LIGHT theme (black arrow), which is the safe
 * default. Never throws.
 */
function applyTheme(nodes: OverlayNodes, cx: number, cy: number): void {
  try {
    const dark = samplePageDark(cx, cy);
    const theme = dark ? THEME_DARK : THEME_LIGHT;
    const path = nodes.arrow.querySelector('svg path');
    if (!path) return;
    path.setAttribute('fill', theme.fill);
    path.setAttribute('stroke', theme.stroke);
  } catch {
    /* presentation layer - never fatal */
  }
}

/** Last known cursor position (the arrow TIP at the target centre). */
let lastPos = { x: 0, y: 0 };
/** Active travel timeline; killed on every retarget (overwrite semantics). */
let travel: gsap.core.Timeline | null = null;
/** v5.1: the working aura's looped breath (killed with the travel). */
let auraPulse: gsap.core.Tween | null = null;
const GLOW_PERIOD_HALF = 0.55; // half-cycle of the working-aura breath

/** Host-page reduced-motion preference, checked per call. */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** v5.1: point the aura at the arrow and give it a steady "working now" breath. */
function startAuraPulse(nodes: OverlayNodes): void {
  try {
    auraPulse?.kill();
    const ax = lastPos.x - TIP_OFFSET.x;
    const ay = lastPos.y - TIP_OFFSET.y;
    gsap.set(nodes.aura, { x: ax, y: ay, scale: GLOW.restScale, opacity: GLOW.restOpacity });
    auraPulse = gsap.to(nodes.aura, {
      scale: GLOW.activeScale,
      opacity: 1,
      duration: GLOW_PERIOD_HALF,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
      transformOrigin: 'center',
    });
  } catch {
    /* presentation layer - never fatal */
  }
}

/** v5.1: settle the aura (an HTMLElement) back to its steady resting glow. */
function restAura(aura: HTMLElement | null): void {
  try {
    auraPulse?.kill();
    auraPulse = null;
    if (aura) gsap.set(aura, { scale: GLOW.restScale, opacity: GLOW.restOpacity });
  } catch {
    /* presentation layer - never fatal */
  }
}

/**
 * v5.3: the travel engine. Every hop glides from A to B on the path that
 * `loopGeometry` chose for the distance:
 *
 * - **snap** (very close): instant placement — no visible swing.
 * - **curve** (short–mid, or a loop that couldn't fit the viewport): a
 *   single gentle quadratic bow, constant speed along the arc length.
 * - **loop** (far / very far): straight approach -> 1 or 2 small closed
 *   360° loops (distance-scaled + clamped radius, kept inside the tab
 *   viewport) -> straight exit onto B. G1 joins, constant ~320px/s —
 *   deliberately slow and smooth so the working is watchable.
 *
 * - The arrow + border aura ride the chosen PATH (transform-only x/y via a
 *   progress sampler: GSAP tweens 0->1 and each frame we evaluate the
 *   position and set transforms — no layout animates).
 * - The HALO (the target indicator) glides STRAIGHT to the element — it
 *   marks "where the action lands", not the pointer's scenic route.
 * - The LABEL fades in near arrival.
 * - Constant speed: the whole path is timed by its true length at
 *   ~320px/s (floor 0.9s / cap 4s). `ease:'none'` keeps velocity constant
 *   along the whole travel (the smoothest circular motion).
 * - Theme: the pointer is re-sampled at the target and the path's apex
 *   (applyTheme), so it inverts as it crosses a light->dark boundary.
 */
/** The tab's current viewport (for the loop's containment check). */
function currentViewport(): { width: number; height: number } | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  } catch {
    /* no window (jsdom edge) */
  }
  return undefined;
}

function travelCurve(
  nodes: OverlayNodes,
  target: { x: number; y: number },
  cx: number,
  cy: number,
): void {
  // Re-steer from the arrow's CURRENT on-screen position (transform
  // state), so a mid-glide retarget loops from where the cursor
  // actually is, not from the last committed target. The arrow div sits
  // at tip - TIP_OFFSET; add the offset back to get the live tip.
  const onScreenX = typeof gsap.getProperty === 'function' ? gsap.getProperty(nodes.arrow, 'x') : 0;
  const onScreenY = typeof gsap.getProperty === 'function' ? gsap.getProperty(nodes.arrow, 'y') : 0;
  const from = {
    x: (Number(onScreenX) || 0) + TIP_OFFSET.x,
    y: (Number(onScreenY) || 0) + TIP_OFFSET.y,
  };
  // Presentation-only organic variation: each hop's path varies slightly
  // (loop radius / center / curve bow — never the endpoints or the timing
  // contract). Skipped under reduced motion (then jitter=0 keeps the path
  // deterministic).
  const jitter = prefersReducedMotion() ? 0 : Math.random() * 2 - 1;
  const geo = loopGeometry(from, target, jitter, currentViewport());
  const t = { x: target.x, y: target.y };
  const lx = cx + 14, ly = cy + 14; // label target

  const dist = geo.pathLen;
  const dur = travelDuration(dist);

  // Theme: sample at the target before travel so the pointer is already
  // the right colour when it lands; re-sampled at the path apex below.
  applyTheme(nodes, cx, cy);

  travel?.kill();
  travel = null;

  const arrowTo = { x: t.x - TIP_OFFSET.x, y: t.y - TIP_OFFSET.y };

  // snap (very close hop) / reduced motion / no time: instant placement
  // (still themed + glowed) — a 60px-or-less hop has no room to swing.
  if (geo.mode === 'snap' || prefersReducedMotion() || dur <= 0) {
    gsap.set(nodes.arrow, { x: arrowTo.x, y: arrowTo.y, scale: 1, opacity: 1 });
    gsap.set(nodes.aura, { x: arrowTo.x, y: arrowTo.y, scale: GLOW.restScale, opacity: GLOW.restOpacity });
    gsap.set(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.label, { x: lx, y: ly, opacity: 1 });
    restAura(nodes.aura);
    lastPos = t;
    return;
  }

  // Position sampler for the chosen middle: the loop's 3-segment path
  // (straight approach -> closed loop(s) -> straight exit, G1-continuous)
  // or the curve's constant-speed quadratic bezier.
  let pathPos: (u: number) => { x: number; y: number };
  if (geo.mode === 'loop') {
    const sA = geo.approachShare; // path share of the approach segment
    const sF = sA + geo.arcShare; // approach + middle
    pathPos = (u: number): { x: number; y: number } => {
      if (u <= 0) return { x: from.x, y: from.y };
      if (u >= 1) return { x: t.x, y: t.y };
      if (u < sA) {
        const v = sA > 0 ? u / sA : 1;
        return {
          x: from.x + (geo.entry.x - from.x) * v,
          y: from.y + (geo.entry.y - from.y) * v,
        };
      }
      if (u < sF) {
        const au = sF - sA > 0 ? (u - sA) / (sF - sA) : 1;
        const ang = geo.alpha0 + geo.sweep * au;
        return {
          x: geo.cx + geo.r * Math.cos(ang),
          y: geo.cy + geo.r * Math.sin(ang),
        };
      }
      const v = 1 - sF > 0 ? (u - sF) / (1 - sF) : 1;
      return {
        x: geo.exit.x + (t.x - geo.exit.x) * v,
        y: geo.exit.y + (t.y - geo.exit.y) * v,
      };
    };
  } else {
    // curve: a gentle quadratic bow, sampled at constant ARC-LENGTH speed.
    const lut = quadBezierLUT(from, geo.curveCtrl ?? { x: (from.x + t.x) / 2, y: (from.y + t.y) / 2 }, t, 32);
    pathPos = (u: number): { x: number; y: number } => quadBezierPoint(lut, u);
  }

  // The cursor + border aura ride the loop; the HALO (the target
  // indicator) glides straight — it marks "where the action lands".
  const prog = { t: 0 };
  const frame = (): void => {
    const p = pathPos(prog.t);
    const ax = p.x - TIP_OFFSET.x;
    const ay = p.y - TIP_OFFSET.y;
    gsap.set(nodes.arrow, { x: ax, y: ay, scale: 1, opacity: 1 });
    gsap.set(nodes.aura, { x: ax, y: ay, scale: GLOW.activeScale, opacity: 1 });
  };

  const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
  // Constant speed along the loop path (`none`): the smoothest circular
  // motion — no easing lumps inside the loop itself.
  tl.to(prog, { t: 1, duration: dur, ease: 'none', immediateRender: true, onUpdate: frame }, 0);
  tl.to(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
  tl.to(nodes.label, { x: lx, y: ly, duration: dur * 0.9, ease: 'power1.inOut', opacity: 1 }, dur * 0.1);
  // At the loop's apex (~half the travel), re-sample the theme so the
  // pointer inverts if it swung over a dark area.
  tl.call(() => applyTheme(nodes, cx, cy), undefined, dur * 0.5);
  // Arrival beat: halo settle-pulse + label brighten, after the travel.
  tl.fromTo(nodes.halo, { scale: 0.96 }, { scale: 1, duration: 0.26, ease: 'power2.out' }, dur);
  tl.fromTo(nodes.label, { opacity: 0.4 }, { opacity: 1, duration: 0.22, ease: 'power1.out' }, dur);
  // The border aura keeps breathing while the agent works on the target.
  tl.call(() => startAuraPulse(nodes), undefined, dur + 0.1);

  travel = tl;
  lastPos = t;
}

/** v5.1: the agent is now WAITING (planner round-trip) — breathe the border glow. */
export function startThinkingPulse(): void {
  try {
    if (prefersReducedMotion()) return;
    const nodes = ensureCursorEl();
    if (!nodes) return;
    stopThinkingPulse();
    // The working cue is the border-tracing aura breathing (v5.1) — the
    // v3 badge-dot heartbeat + sonar ping are gone. Place the aura at
    // the current arrow position first (it may never have had a
    // travel, e.g. the overlay was just built).
    startAuraPulse(nodes);
  } catch {
    /* presentation layer - never fatal */
  }
}

/** The agent is acting again — stop thinking, let the aura settle. */
export function stopThinkingPulse(): void {
  try {
    restAura(
      (typeof document === 'undefined'
        ? null
        : document.getElementById(CURSOR_ID)?.shadowRoot?.querySelector('.ac-aura')) as HTMLElement | null,
    );
    const host = typeof document === 'undefined' ? null : document.getElementById(CURSOR_ID);
    const shadow = host?.shadowRoot;
    if (shadow) gsap.set(shadow.querySelector('.ac-arrow'), { opacity: 1, scale: 1 });
  } catch {
    /* presentation layer - never fatal */
  }
}

/**
 * Position + colour the overlay for a centre/box/kind. Never throws.
 *
 * v5.1: this now only (a) tints the target HALO by action kind and
 * (b) hands the travel to `travelCurve` — the circular-loop engine that
 * also re-samples the page theme under the target (applyTheme) so the
 * pointer inverts on dark sites (black arrow on light sites).
 */
function moveOverlay(
  nodes: OverlayNodes,
  cx: number,
  cy: number,
  s: { width: string; height: string; border: string; background: string },
  kind: CursorActionKind,
): void {
  const color = KIND_COLORS[kind];

  // The target box is a soft rounded HALO (radius + soft glow), not a
  // hard 2px border. cursorStyles still returns border/background for
  // test-compat; we apply them as halo tint + box-shadow instead.
  const ringed = s.width !== '0px' && s.height !== '0px';
  nodes.halo.style.width = s.width;
  nodes.halo.style.height = s.height;
  nodes.halo.style.border = ringed ? `1.5px solid ${color}55` : 'none';
  nodes.halo.style.background = s.background;
  nodes.halo.style.boxShadow = ringed
    ? `0 0 0 4px ${color}1a, 0 0 22px 4px ${color}40`
    : 'none';

  // Moving = acting: stop the idle breathing first.
  stopThinkingPulse();

  // The arrow tip is the hotspot; loop-travel to it (themed + glowed) —
  // the engine owns the halo glide, label, and arrival beat.
  const target = { x: cx, y: cy };
  travelCurve(nodes, target, cx, cy);
}

/**
 * Position the agent cursor over a target element for a kind of action.
 * Reads the element's *current* rect (the executor has already scrolled
 * it into view), colours it by action kind, and labels it
 * `<KIND> · <TAG>`.
 *
 * Never throws: this is a presentation overlay, and a failure here must
 * not take the action down with it. Returns whether it actually moved.
 */
export function showCursor(el: Element, kind: CursorActionKind): boolean {
  try {
    const nodes = ensureCursorEl();
    if (!nodes) return false;
    const rect: CursorPosition = el.getBoundingClientRect
      ? el.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };
    const s = cursorStyles(rect, kind);
    const cx = Number.isFinite(rect.x) ? rect.x + (Number.isFinite(rect.width) ? rect.width : 0) / 2 : 0;
    const cy = Number.isFinite(rect.y) ? rect.y + (Number.isFinite(rect.height) ? rect.height : 0) / 2 : 0;

    moveOverlay(nodes, cx, cy, s, kind);

    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    nodes.label.textContent = cursorLabel(kind, tag);
    nodes.host.style.display = '';
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire the click-ripple + settle pulse at the current cursor position.
 * Call this the moment an action *lands* (from the executor), not when
 * the cursor is presented. Pure presentation; never throws; no-op
 * under reduced motion (a ripple is a visual effect, not information).
 */
export function pulseCursor(): void {
  try {
    const nodes = ensureCursorEl();
    if (!nodes) return;
    if (prefersReducedMotion()) return;
    stopThinkingPulse();
    // The arrow tip sits exactly on lastPos (the element centre) — the
    // tip is the hotspot the user watches, so the ripple fires there.
    gsap.fromTo(
      nodes.ripple,
      { scale: 0.25, opacity: 0.5, x: lastPos.x, y: lastPos.y, backgroundColor: KIND_COLORS.CLICK },
      { scale: 2.6, opacity: 0, duration: 0.6, ease: 'power2.out', overwrite: 'auto' },
    );
    // The landing beat is a quick scale-pop on the target halo (the
    // "action landed" feedback), plus a brightening border-glow blip.
    gsap.fromTo(
      nodes.halo,
      { scale: 1 },
      { scale: 1.06, duration: 0.14, yoyo: true, repeat: 1, ease: 'power1.inOut', overwrite: 'auto' },
    );
    gsap.fromTo(
      nodes.aura,
      { opacity: GLOW.restOpacity },
      { opacity: 1, duration: 0.12, yoyo: true, repeat: 1, ease: 'power1.inOut', overwrite: 'auto' },
    );
  } catch {
    /* presentation layer - never fatal */
  }
}

/** Hide the cursor (e.g. at task end / navigation). Idempotent. */
export function hideCursor(): void {
  try {
    travel?.kill();
    travel = null;
    stopThinkingPulse();
    const host = typeof document === 'undefined' ? null : document.getElementById(CURSOR_ID);
    if (host) host.style.display = 'none';
  } catch {
    /* presentation layer - never fatal */
  }
}

/** Remove the overlay node entirely from the page. */
export function removeCursor(): void {
  try {
    if (typeof document === 'undefined') return;
    travel?.kill();
    travel = null;
    stopThinkingPulse();
    document.getElementById(CURSOR_ID)?.remove();
  } catch {
    /* presentation layer - never fatal */
  }
}
