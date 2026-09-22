// src/lib/agentCursor.ts
//
// Issue #101 / #132 / #137 / #139 — computer-use style "agent cursor" overlay.
//
// v5.1 (user iteration 2026-09-23): the pointer is the svgrepo "select"
// cursor, MIRRORED so the tip points top-left (classic cursor direction).
// Behaviors:
//
//   Theme-aware colors: the shape inverts when the page under the tip is
//     dark — dark/black shape + white outline on light sites, white shape
//     + dark outline on dark sites (sampled live, per travel target).
//   Border-tracing working glow: a soft blue aura that HUGS the arrow's
//     outline (a blurred blue stroke of the same path, painted behind the
//     arrow — not a separate circular blob) and breathes while the agent
//     is working/thinking ("the agent is doing something right now").
//   Loop travel: every hop completes a single ~300° circular loop around
//     the start point, then exits straight to the destination — the
//     cursor visibly "swings around" instead of snapping or riding a
//     shallow S. Constant arc-length speed (slower on purpose, ~380px/s,
//     floor 0.9s, cap 4s) so the movement is watchable and smooth.
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
 * v5.1 pacing (user: "a lot more smooth movement but slow"): the cursor
 * travels at ~380px/s along the actual loop path (was 850px/s straight),
 * with a 0.9s FLOOR so even a tiny hop shows a visible loop, and a 4s cap
 * so cross-screen jumps stay deliberate, not sluggish. Pure
 * (testable): returns seconds. Hops of 2px or less still snap
 * instantly (no visible travel to speak of).
 */
export function travelDuration(dist: number): number {
  if (!Number.isFinite(dist) || dist <= 2) return 0;
  return Math.min(4, Math.max(0.9, dist / 380));
}

export interface LoopGeometry {
  /** false when the hop is too short to loop (<= 8px) — snap instead. */
  loop: boolean;
  /** Loop circle center. */
  cx: number;
  cy: number;
  /** Loop radius (px). */
  r: number;
  /** Entry angle on the circle (the start point), radians. */
  alpha0: number;
  /** Signed sweep angle (radians; ~±300°, sign = rotation direction). */
  sweep: number;
  /** Point where the loop exits (the start of the straight tail). */
  exit: { x: number; y: number };
  /** Tail length from exit -> destination (px). */
  tailLen: number;
  /** Arc length of the loop portion (px). */
  arcLen: number;
  /** Total path length the cursor rides (arcLen + tailLen). */
  pathLen: number;
}

/**
 * v5.1: the loop-travel geometry. Given a start and end viewport
 * position, describe a path that (1) completes a single ~300° circular
 * loop based at the START point, then (2) exits in a straight tail to
 * the destination — "a single loop (circular movement) completed
 * between start and destination".
 *
 * - The rotation direction is DETERMINISTIC (left/right of travel), so
 *   the same start/end pair always takes the same loop — reproducible.
 * - `jitter` (default 0, clamped to [-1,1]) randomly scales the radius
 *   and sweep a little, so consecutive hops vary organically. With
 *   jitter=0 the function is purely deterministic (testable).
 * - Hops of 8px or less cannot loop meaningfully: `loop=false` and the
 *   caller snaps.
 * - Non-finite inputs degrade to (0,0) -> (0,0) + loop=false, never NaN.
 */
export function loopGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  jitter = 0,
): LoopGeometry {
  const fx = Number.isFinite(from.x) ? from.x : 0;
  const fy = Number.isFinite(from.y) ? from.y : 0;
  const tx = Number.isFinite(to.x) ? to.x : 0;
  const ty = Number.isFinite(to.y) ? to.y : 0;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  const jj = Number.isFinite(jitter) ? Math.max(-1, Math.min(1, jitter)) : 0;

  const r = Math.max(48, Math.min(160, 0.3 * len)) * (1 + 0.1 * jj);
  if (len < 8 || r <= 0) {
    return {
      loop: false,
      cx: fx, cy: fy, r: 0, alpha0: 0, sweep: 0,
      exit: { x: tx, y: ty },
      tailLen: len, arcLen: 0, pathLen: len,
    };
  }
  // Deterministic rotation direction: going right -> counter-clockwise
  // (sweep negative in screen coords, y-down), going left -> clockwise.
  // Back-and-forth hops therefore loop in opposite directions.
  const side = dx >= 0 ? -1 : 1;
  // Unit normal of the travel direction, chosen by `side`.
  const nx = (-dy / len) * -side;
  const ny = (dx / len) * -side;
  // The loop circle is based AT the start: its center is one radius away
  // along the normal, so the start point lies ON the circle.
  const cx = fx + nx * r;
  const cy = fy + ny * r;
  const alpha0 = Math.atan2(fy - cy, fx - cx);
  // ~300° (5/6 of a full circle), ±8% via jitter: "a single loop
  // completed" without a perfect 360° (which would just return to the
  // start and stall).
  const sweep = side * Math.PI * 2 * (0.85 + 0.08 * jj);
  const alphaE = alpha0 + sweep;
  const exit = { x: cx + r * Math.cos(alphaE), y: cy + r * Math.sin(alphaE) };
  const arcLen = r * Math.abs(sweep);
  const tailLen = Math.hypot(tx - exit.x, ty - exit.y);
  return { loop: true, cx, cy, r, alpha0, sweep, exit, arcLen, tailLen, pathLen: arcLen + tailLen };
}

/**
 * v5: sample whether the page area under a viewport point is dark.
 *
 * Walks up the element tree from the point (document.elementFromPoint)
 * and collects computed backgrounds; the first one with real coverage
 * (a non-transparent color) wins. Luminance (0.2126 R + 0.7152 G +
 * 0.0722 B, WCAG relative-luminance weights on 0-255 values) under 128
 * counts as "dark".
 *
 * Returns `null` when nothing sampleable is under the point (e.g. jsdom,
 * no layout) — callers fall back to the light theme (black arrow), which
 * is the safe default. Never throws: theme detection is presentation-only.
 */
export function samplePageDark(
  x: number,
  y: number,
  doc: Document = document,
): boolean | null {
  try {
    if (!doc || !doc.elementFromPoint || !doc.defaultView) return null;
    const win = doc.defaultView;
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
 * v5.1: the loop-travel engine. Every hop completes a single ~300°
 * circular loop based at the start point, then exits in a straight tail
 * to the destination — "a single loop (circular movement) completed
 * between start and destination".
 *
 * - The arrow + border aura ride the LOOP PATH (transform-only x/y via a
 *   progress sampler: GSAP tweens 0->1 and each frame we evaluate the
 *   arc + tail position and set transforms — no layout animates).
 * - The HALO (the target indicator) glides STRAIGHT to the element — it
 *   marks "where the action lands", not the pointer's scenic route.
 * - The LABEL fades in near arrival.
 * - Constant arc-length speed: the whole path is timed by its true
 *   length at ~380px/s (floor 0.9s / cap 4s) — deliberately slow and
 *   smooth, so the working is watchable. `ease:'none'` keeps velocity
 *   constant along the loop (the smoothest circular motion).
 * - Theme: the pointer is re-sampled at the loop's apex + on arrival
 *   (applyTheme), so it inverts as it crosses a light->dark boundary.
 */
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
  // Presentation-only organic variation: each hop's loop varies slightly
  // in radius + sweep (never the endpoints or timing contract). Skipped
  // under reduced motion (then jitter=0 keeps the path deterministic).
  const jitter = prefersReducedMotion() ? 0 : Math.random() * 2 - 1;
  const geo = loopGeometry(from, target, jitter);
  const t = { x: target.x, y: target.y };
  const lx = cx + 14, ly = cy + 14; // label target

  const dist = geo.pathLen;
  const dur = travelDuration(dist);
  const loopless = !geo.loop || dur <= 0;

  // Theme: sample at the target before travel so the pointer is already
  // the right colour when it lands; re-sampled at the loop apex below.
  applyTheme(nodes, cx, cy);

  travel?.kill();
  travel = null;

  const arrowTo = { x: t.x - TIP_OFFSET.x, y: t.y - TIP_OFFSET.y };

  if (prefersReducedMotion() || loopless) {
    // No loop / no animation: instant placement (still themed + glowed).
    gsap.set(nodes.arrow, { x: arrowTo.x, y: arrowTo.y, scale: 1, opacity: 1 });
    gsap.set(nodes.aura, { x: arrowTo.x, y: arrowTo.y, scale: GLOW.restScale, opacity: GLOW.restOpacity });
    gsap.set(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.label, { x: lx, y: ly, opacity: 1 });
    restAura(nodes.aura);
    lastPos = t;
    return;
  }

  // Arc + tail sampler, constant speed: u in [0, w] rides the loop
  // circle (sweep proportional to u), u in (w, 1] rides the straight
  // tail from the loop exit to the destination.
  const w = geo.arcLen / Math.max(1, geo.pathLen); // arc share of the path
  const pathPos = (u: number): { x: number; y: number } => {
    if (u <= 0) return { x: from.x, y: from.y };
    if (u >= 1) return { x: t.x, y: t.y };
    if (u < w) {
      const ang = geo.alpha0 + geo.sweep * (u / w);
      return {
        x: geo.cx + geo.r * Math.cos(ang),
        y: geo.cy + geo.r * Math.sin(ang),
      };
    }
    const v = (u - w) / (1 - w);
    return {
      x: geo.exit.x + (t.x - geo.exit.x) * v,
      y: geo.exit.y + (t.y - geo.exit.y) * v,
    };
  };

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
