// src/lib/agentCursor.ts
//
// Issue #101 / #132 / #137 / #139 — computer-use style "agent cursor" overlay.
//
// v5 (user reference 2026-09-23): the pointer is the svgrepo "select"
// cursor, MIRRORED so the tip points top-left (classic cursor direction).
// Three v5 behaviors:
//
//   Theme-aware colors: the shape inverts when the page under the tip is
//     dark — dark shape + white outline on light sites, white shape +
//     dark outline on dark sites (sampled live, per travel target).
//   Working glow: a soft blue aura around the cursor boundary, steady at
//     rest, pulsing while the agent is working/thinking (the "agent is
//     doing something right now" cue).
//   S-curve travel: every hop rides a randomized quadratic bézier
//     (deterministic control point, so a given start/end pair always
//     takes the same arc) instead of a straight line — fluid, engineered
//     motion, still arc-length-timed at the v2 850px/s pacing with the
//     0.25s floor / 1.2s cap. Never instant (except the <=2px snap and
//     reduced-motion).
//
// The public API is UNCHANGED (showCursor / pulseCursor / hideCursor /
// removeCursor / startThinkingPulse / stopThinkingPulse / cursorLabel /
// cursorStyles / travelDuration / THINKING_PULSE), so background.ts,
// content.ts, the runner, and the existing tests keep working.
//
// PII contract (unchanged, critical): the overlay never carries values.
// The label is `<KIND> · <TAG>` only — no typed text, no URLs, no PII.
//
// `cursorStyles` / `cursorLabel` / `travelDuration` stay pure +
// jsdom-testable; the GSAP layer is only exercised in the live browser.

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

// v5: theme-aware pointer colors. On light sites: dark shape + white
// outline. On dark sites (sampled): white shape + dark outline, so the
// cursor never turns into a black blob on a dark page.
const ACCENT = '#2563eb'; // brand blue — halo, working glow, label border
const THEME_LIGHT = { fill: '#111827', stroke: '#ffffff' }; // light sites
const THEME_DARK = { fill: '#ffffff', stroke: '#0f172a' }; // dark sites

// v5: the "working" glow around the cursor boundary. A soft blue aura
// (its own node, painted behind the arrow) that is steady at rest and
// PULSES while the agent is working — the "agent is doing something
// right now" cue.
const GLOW = {
  /** Resting aura scale (steady "agent present" glow). */
  restScale: 1.0,
  /** Aura scale while a travel is in flight (working, pre-arrival). */
  activeScale: 1.18,
  /** Resting opacity of the aura (peaks at 1.0 when active/pulsing). */
  restOpacity: 0.55,
};

// v5: pointer geometry. The shape is the "select" cursor from the user's
// reference (svgrepo select-cursor, 2026-09-23), MIRRORED via a group
// transform so its tip points top-left like a classic cursor. TIP_OFFSET
// is where the tip sits inside the ARROW_SIZE box (viewBox is 188.324
// wide; the mirrored tip is at ~(32, 2) in viewBox units), so positioning
// the div at (cx - TIP_OFFSET.x, cy - TIP_OFFSET.y) puts the tip exactly
// on the target's centre.
const ARROW_SIZE = 34;
const TIP_OFFSET = { x: 6, y: 0 };
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
 * Pure so it is trivially unit-testable: given the element's on-screen rect,
 * where should the cursor land and how big is the ring?
 *
 * - The dot sits at the element's center.
 * - The ring hugs the element's box (+8px padding).
 * - Zero/negative/NaN rects (detached or unrendered nodes) collapse to a
 *   ring-less dot at (0,0) rather than producing `NaNpx` CSS.
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
 * Travel duration for a hop of `dist` viewport px. v2 pacing: the cursor
 * moves at roughly 850px/s (was 1600 — it read as "teleporting"), with a
 * 0.25s FLOOR so even a 30px nudge glides instead of snapping, and a 1.2s
 * cap so a corner-to-corner travel is deliberate, not sluggish. Pure
 * (testable): returns seconds. Hops of 2px or less still snap instantly
 * (no visible travel to speak of).
 */
export function travelDuration(dist: number): number {
  if (!Number.isFinite(dist) || dist <= 2) return 0;
  return Math.min(1.2, Math.max(0.25, dist / 850));
}

/**
 * v5: the S-curve travel control point. Given a start and end viewport
 * position, return the control point of a quadratic bézier that bows the
 * path to one side of the straight line — so the cursor glides in a smooth
 * "S" rather than a rigid straight shot.
 *
 * - The bow side is DETERMINISTIC (chosen from the segment orientation),
 *   so the same start/end pair always takes the same arc — reproducible,
 *   and no two consecutive hops flip to the same side back-to-back.
 * - The bow depth is 18% of the segment length, so short hops stay
 *   almost straight and long hops show a clear curve.
 * - Segments of 0 length (or sub-4px, i.e. no visible travel) return the
 *   end point itself: the "curve" degenerates to a snap, and the caller
 *   skips the bézier tween.
 *
 * Pure + jsdom-testable (no DOM, no RNG).
 */
export function curveControlPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number; curved: boolean } {
  const fx = Number.isFinite(from.x) ? from.x : 0;
  const fy = Number.isFinite(from.y) ? from.y : 0;
  const tx = Number.isFinite(to.x) ? to.x : 0;
  const ty = Number.isFinite(to.y) ? to.y : 0;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  if (len < 4) return { x: tx, y: ty, curved: false };
  // Deterministic side: bow to the left of the direction of travel when
  // going right (dx >= 0), to the right when going left. This makes
  // back-and-forth hops (A->B->A) take opposite arcs, so consecutive
  // travels never retrace the same curve.
  const left = dx >= 0 ? 1 : -1;
  const nx = -dy / len; // unit normal of the segment (perpendicular)
  const ny = dx / len;
  const bow = 0.18 * len * left;
  const cx = fx + dx / 2 + nx * bow;
  const cy = fy + dy / 2 + ny * bow;
  return { x: cx, y: cy, curved: true };
}

/**
 * v5: sample whether the page area under a viewport point is dark.
 *
 * Walks up the element tree from the point (document.elementFromPoint)
 * and collects computed backgrounds; the first one with real coverage
 * (a non-transparent color) wins. A page background with multiple
 * layers collapses to the LAST declared layer that is opaque. Luminance
 * (0.2126 R + 0.7152 G + 0.0722 B, per WCAG relative-luminance weights on
 * 0-255 values) under 128 counts as "dark".
 *
 * Returns `null` when nothing sampleable is under the point (e.g. jsdom,
 * no layout) — callers fall back to the light theme, which is the safe
 * default. Never throws: theme detection is presentation-only.
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
 * v3: the idle "thinking" beat. While the agent is between actions (mostly
 * waiting on the planner LLM, which takes seconds) the cursor breathes:
 * the presence badge's center dot pulses and a faint sonar ring pings out
 * of the tip — so the agent reads as "alive", and the visible pacing
 * matches the LLM-bound step latency instead of fighting it. One
 * interruptible tween; `travel()` / `pulseCursor()` / `stopThinkingPulse()`
 * kill it. Pure timing constants so tests can pin the contract.
 */
export const THINKING_PULSE = {
  /** Period of one breathing cycle (out+back), seconds. */
  period: 1.6,
  /** Badge dot scale peak (1.0 resting -> 1.35 peak). */
  ringScalePeak: 1.35,
  /** Arrow resting opacity while thinking (dips from 1.0). */
  arrowDim: 0.7,
  /** Sonar ping travel (1.0 -> 2.6 scale) + one cycle seconds. */
  sonarScale: 2.6,
};

interface OverlayNodes {
  host: HTMLElement;
  halo: HTMLElement;
  aura: HTMLElement; // v5: the blue "working" glow behind the arrow
  arrow: HTMLElement;
  badge: HTMLElement;
  badgeDot: HTMLElement;
  sonar: HTMLElement;
  label: HTMLElement;
  ripple: HTMLElement;
}

/**
 * Build (once) or reuse the v5 cursor overlay. The host is a plain fixed
 * node in the light DOM — so `document.getElementById(CURSOR_ID)` keeps
 * working and the pointer-events:none / z-index contract holds for the
 * page. Its *inner* nodes live in an open shadow root with `all:initial`
 * so hostile host-page CSS cannot hide or restyle them.
 *
 * Node map (all absolutely-positioned, centred via xPercent/yPercent so
 * every motion is transform-only):
 *   .ac-halo   — the soft rounded target box (kind-tinted glow)
 *   .ac-aura   — v5: the blue "working" aura behind the arrow (pulses)
 *   .ac-arrow  — the select-cursor shape (mirrored, tip top-left)
 *   .ac-badge  — the presence badge ring at the tip
 *   .ac-dot    — the badge's center dot (breathes while thinking)
 *   .ac-sonar  — the faint pinging sonar ring (thinking only)
 *   .ac-label  — the dark `<KIND> · <TAG>` pill
 *   .ac-ripple — the click confirmation ripple
 */
function ensureCursorEl(): OverlayNodes | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(CURSOR_ID) as HTMLElement | null;
  if (!host || !host.dataset.agentCursor5) {
    // A pre-v5 host (or a stale node without the aura) is replaced
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
    // `all:initial` on :host so no inheritable host property (font, color,
    // direction) leaks in; the overlay is fully self-styled below.
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;top:0;left:0;pointer-events:none;}
.ac-halo{position:absolute;top:0;left:0;border-radius:14px;pointer-events:none;will-change:transform;
box-shadow:0 0 0 0 transparent,0 0 18px 2px rgba(37,99,235,0);}
.ac-aura{position:absolute;top:0;left:0;width:${ARROW_SIZE + 26}px;height:${ARROW_SIZE + 26}px;
margin:${-TIP_OFFSET.x - 13}px 0 0 ${-TIP_OFFSET.y - 13}px;pointer-events:none;will-change:transform,opacity;
background:radial-gradient(circle at 30% 12%, ${ACCENT}b3 0%, ${ACCENT}40 45%, rgba(37,99,235,0) 72%);
border-radius:50%;opacity:${GLOW.restOpacity};transform:translate(0,0) scale(${GLOW.restScale});}
.ac-arrow{position:absolute;top:0;left:0;width:${ARROW_SIZE}px;height:${ARROW_SIZE}px;pointer-events:none;
will-change:transform,opacity;filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,.35));}
.ac-arrow svg{display:block;overflow:visible;}
.ac-badge{position:absolute;top:0;left:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
border:2px solid ${ACCENT};background:rgba(255,255,255,.85);pointer-events:none;will-change:transform;
box-shadow:0 1px 3px rgba(0,0,0,.35),0 0 8px ${ACCENT}66;display:flex;align-items:center;justify-content:center;}
.ac-dot{width:6px;height:6px;border-radius:50%;background:${ACCENT};will-change:transform;}
.ac-sonar{position:absolute;top:0;left:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
border:1.5px solid ${ACCENT};opacity:0;pointer-events:none;will-change:transform,opacity;}
.ac-label{position:absolute;top:0;left:0;pointer-events:none;font:600 11px/1 system-ui,sans-serif;
color:#fff;background:#0f172aee;padding:4px 10px;border-radius:9999px;white-space:nowrap;
box-shadow:0 2px 8px rgba(0,0,0,.28);will-change:transform;letter-spacing:.02em;opacity:0;}
.ac-ripple{position:absolute;top:0;left:0;width:56px;height:56px;margin:-28px 0 0 -28px;
border-radius:50%;pointer-events:none;opacity:0;transform:scale(.25);will-change:transform,opacity;}`;
    shadow.appendChild(style);

    const halo = document.createElement('div');
    halo.className = 'ac-halo';
    // The halo box (width/height/border/bg) is set instantly when the
    // target changes — it is our own glow, not page content — and the
    // GLIDE is a transform-only x/y tween, so no layout property animates.
    shadow.appendChild(halo);

    // v5: the working aura — a soft blue radial glow painted BEHIND the
    // arrow. Its scale/opacity are the "agent is working now" signal:
    // steady at rest, brighter + pulsing while the agent thinks or a
    // travel is in flight.
    const aura = document.createElement('div');
    aura.className = 'ac-aura';
    shadow.appendChild(aura);

    const arrow = document.createElement('div');
    arrow.className = 'ac-arrow';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 188.324 188.324');
    svg.setAttribute('width', String(ARROW_SIZE));
    svg.setAttribute('height', String(ARROW_SIZE));
    // v5: the "select" cursor from the user's reference, MIRRORED so the
    // tip points top-left (the original points top-right). The fill/stroke
    // are theme-applied by applyTheme() — the attrs below are the light
    // default so the first paint is already correct.
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

    const badge = document.createElement('div');
    badge.className = 'ac-badge';
    const dot = document.createElement('div');
    dot.className = 'ac-dot';
    badge.appendChild(dot);
    shadow.appendChild(badge);

    const sonar = document.createElement('div');
    sonar.className = 'ac-sonar';
    shadow.appendChild(sonar);

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
  const badge = shadow.querySelector('.ac-badge') as HTMLElement | null;
  const badgeDot = shadow.querySelector('.ac-dot') as HTMLElement | null;
  const sonar = shadow.querySelector('.ac-sonar') as HTMLElement | null;
  const label = shadow.querySelector('.ac-label') as HTMLElement | null;
  const ripple = shadow.querySelector('.ac-ripple') as HTMLElement | null;
  if (!halo || !aura || !arrow || !badge || !badgeDot || !sonar || !label || !ripple) return null;
  return { host: host as HTMLElement, halo, aura, arrow, badge, badgeDot, sonar, label, ripple };
}

/**
 * v5: flip the pointer between the light/dark themes. Called on every
 * travel against the TARGET point — so the cursor inverts exactly when
 * it lands on (or glides into) a dark area. jsdom / no-layout / unknown
 * sample falls back to the light theme (dark shape on white outline),
 * which is the safe default.
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

/** Last known cursor position (the arrow tip) — origin of every travel. */
let lastPos = { x: 0, y: 0 };
/** Active travel timeline; killed on every retarget (overwrite semantics). */
let travel: gsap.core.Timeline | null = null;
/** The idle thinking-pulse tweens (single, interruptible): dot heartbeat. */
let thinkingPulse: gsap.core.Tween | null = null;
/** v3: the idle sonar ping (expands + fades, loops) - killed with the pulse. */
let sonarPing: gsap.core.Tween | null = null;
/** v5: the working aura's looped scale-pulse (killed with the travel). */
let auraPulse: gsap.core.Tween | null = null;

/** Host-page reduced-motion preference, checked per call. */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** v5: point the aura at the tip and give it a steady "working now" pulse. */
function startAuraPulse(nodes: OverlayNodes): void {
  try {
    auraPulse?.kill();
    const tip = { x: lastPos.x - TIP_OFFSET.x, y: lastPos.y - TIP_OFFSET.y };
    gsap.set(nodes.aura, {
      x: tip.x, y: tip.y, xPercent: -50, yPercent: -50,
      scale: GLOW.restScale, opacity: GLOW.restOpacity,
    });
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

/** v5: settle the aura (an HTMLElement) back to its steady resting glow. */
function restAura(aura: HTMLElement | null): void {
  try {
    auraPulse?.kill();
    auraPulse = null;
    if (aura) gsap.set(aura, { scale: GLOW.restScale, opacity: GLOW.restOpacity });
  } catch {
    /* presentation layer - never fatal */
  }
}

const GLOW_PERIOD_HALF = 0.55; // half-cycle of the working-aura pulse

/**
 * v5: the S-curve travel engine. Every hop rides a quadratic bézier that
 * bows to one side of the straight line (deterministic side from
 * `curveControlPoint`), so the agent's cursor glides in smooth arcs
 * instead of rigid straight shots — and consecutive back-and-forth hops
 * take opposite arcs, never retracing.
 *
 * - The arrow + badge + sonar + aura follow the CURVE (transform-only
 *   x/y via a sampled path, no layout properties animate).
 * - The HALO follows the straight line: it is the target indicator, and
 *   it should sit on the element while the cursor approaches it.
 * - The LABEL fades in near arrival.
 * - Duration = travelDuration of the STRAIGHT distance, so pacing keeps
 *   the v2 850px/s feel (floor 0.25s, cap 1.2s) even though the path is
 *   slightly longer.
 * - Theme: the pointer is re-sampled at start / mid / end of the travel
 *   (applyTheme), so it inverts as it crosses a light->dark boundary.
 */
function travelCurve(
  nodes: OverlayNodes,
  target: { x: number; y: number },
  cx: number,
  cy: number,
): void {
  // Re-steer from the arrow's CURRENT on-screen position (transform state),
  // so a mid-glide retarget glides from where the cursor actually is, not
  // from the last committed target. `gsap.getProperty` returns the live
  // transform; the tip sits TIP_OFFSET inside the ARROW box.
  const onScreenX = typeof gsap.getProperty === 'function' ? gsap.getProperty(nodes.arrow, 'x') : 0;
  const onScreenY = typeof gsap.getProperty === 'function' ? gsap.getProperty(nodes.arrow, 'y') : 0;
  const from = {
    x: (Number(onScreenX) || 0) + TIP_OFFSET.x,
    y: (Number(onScreenY) || 0) + TIP_OFFSET.y,
  };
  let cp = curveControlPoint(from, target);
  const t = { x: target.x, y: target.y };
  const lx = cx + 14, ly = cy + 14; // label target

  // v5: "random curves" — the base S-arc from `curveControlPoint` is
  // deterministic (reproducible), but each hop adds a random perpendicular
  // jitter to the control point so no two travels trace the same curve.
  // Presentation-only: it varies the SHAPE of the glide, never the
  // endpoints or timing, and is skipped for reduced motion / short hops.
  if (cp.curved && !prefersReducedMotion()) {
    const segLen = Math.hypot(target.x - from.x, target.y - from.y);
    if (segLen > 4) {
      const jitter = (Math.random() * 2 - 1) * 0.12 * segLen; // ±12% of the hop
      const nx = -(target.y - from.y) / segLen;
      const ny = (target.x - from.x) / segLen;
      cp = { ...cp, x: cp.x + nx * jitter, y: cp.y + ny * jitter };
    }
  }

  // Quadratic bézier sampler: B(u) = (1-u)^2 P0 + 2(1-u)u C + u^2 P1,
  // evaluated at the CURVE's control point so the cursor rides the arc.
  const curve = (u: number): { x: number; y: number } => {
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const c = u * u;
    return { x: a * from.x + b * cp.x + c * t.x, y: a * from.y + b * cp.y + c * t.y };
  };

  const badgeTo = { x: t.x - TIP_OFFSET.x + 4, y: t.y - TIP_OFFSET.y + 4 };
  const dist = Math.hypot(t.x - from.x, t.y - from.y);
  const dur = travelDuration(dist);
  const straightOnly = !cp.curved || dur <= 0;

  // Theme: sample at the target before travel so the pointer is already the
  // right colour when it lands; re-sampled mid-flight + on arrival below.
  applyTheme(nodes, cx, cy);

  travel?.kill();
  travel = null;

  if (prefersReducedMotion() || straightOnly) {
    // No curve / no animation: instant placement (still themed + aured).
    gsap.set(nodes.arrow, { x: t.x - TIP_OFFSET.x, y: t.y - TIP_OFFSET.y, scale: 1, opacity: 1 });
    gsap.set(nodes.aura, { x: t.x - TIP_OFFSET.x, y: t.y - TIP_OFFSET.y, xPercent: -50, yPercent: -50, scale: GLOW.restScale, opacity: GLOW.restOpacity });
    gsap.set(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.badge, { x: badgeTo.x, y: badgeTo.y, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: badgeTo.x, y: badgeTo.y, xPercent: -50, yPercent: -50, opacity: 0 });
    gsap.set(nodes.label, { x: lx, y: ly, opacity: 1 });
    restAura(nodes.aura);
    lastPos = t;
    return;
  }

  // The cursor + badge + aura + sonar ride the S-curve via a progress
  // sampler: GSAP tweens a 0->1 progress and each frame we evaluate the
  // quadratic bézier and set transforms. The HALO (the target indicator)
  // glides STRAIGHT — it marks "where the action lands", not the pointer.
  const prog = { t: 0 };
  const frame = (): void => {
    const p = curve(prog.t);
    const ax = p.x - TIP_OFFSET.x;
    const ay = p.y - TIP_OFFSET.y;
    gsap.set(nodes.arrow, { x: ax, y: ay, scale: 1, opacity: 1 });
    gsap.set(nodes.aura, { x: ax, y: ay, xPercent: -50, yPercent: -50, scale: GLOW.activeScale, opacity: 1 });
    gsap.set(nodes.badge, { x: ax + 4, y: ay + 4, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: ax + 4, y: ay + 4, xPercent: -50, yPercent: -50, opacity: 0 });
  };

  const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
  tl.to(prog, { t: 1, duration: dur, ease: 'sine.inOut', immediateRender: true, onUpdate: frame }, 0);
  tl.to(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
  tl.to(nodes.label, { x: lx, y: ly, duration: dur * 0.9, ease: 'power1.inOut', opacity: 1 }, dur * 0.1);
  // Mid-travel theme re-sample: if the path crosses into a dark area,
  // invert the pointer halfway through so it never sits the wrong colour.
  tl.call(() => applyTheme(nodes, cx, cy), undefined, dur * 0.5);
  // Arrival beat: halo settle-pulse + label fade-in, sequenced after the
  // travel in ONE interruptible timeline.
  tl.fromTo(nodes.halo, { scale: 0.96 }, { scale: 1, duration: 0.26, ease: 'power2.out' }, dur);
  tl.fromTo(nodes.label, { opacity: 0.4 }, { opacity: 1, duration: 0.22, ease: 'power1.out' }, dur);
  // The aura keeps pulsing while the agent is "working on" this target.
  tl.call(() => startAuraPulse(nodes), undefined, dur + 0.1);

  travel = tl;
  lastPos = t;
}

/** v5: the agent is now WAITING (planner round-trip) — breathe + glow. */
export function startThinkingPulse(): void {
  try {
    if (prefersReducedMotion()) return;
    const nodes = ensureCursorEl();
    if (!nodes) return;
    stopThinkingPulse();
    // Place the badge + sonar at the current tip before breathing (they
    // may have never had a travel run, e.g. overlay just built).
    const tip = { x: lastPos.x - TIP_OFFSET.x, y: lastPos.y - TIP_OFFSET.y };
    const bx = tip.x + 4;
    const by = tip.y + 4;
    gsap.set(nodes.badge, { x: bx, y: by, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: bx, y: by, xPercent: -50, yPercent: -50, scale: 1, opacity: 0.5 });
    gsap.set(nodes.badgeDot, { scale: 1, opacity: 1 });

    // v5: while the agent thinks, the WORKING AURA pulses (the "the agent
    // is alive and doing something" cue) instead of the v3 dot heartbeat.
    startAuraPulse(nodes);

    // Sonar ping: a separate loop that expands out of the tip and fades,
    // then restarts - the "alive and listening" cue. From 1.0/0.5 to
    // sonarScale/0 so each cycle is a visible expanding ring.
    sonarPing = gsap.fromTo(
      nodes.sonar,
      { scale: 1, opacity: 0.5 },
      {
        scale: THINKING_PULSE.sonarScale,
        opacity: 0,
        duration: THINKING_PULSE.period,
        repeat: -1,
        ease: 'sine.out',
        transformOrigin: 'center',
        overwrite: 'auto',
      },
    );
    // Keep the exported THINKING_PULSE contract exercised (the badge dot
    // still breathes, just less prominently than in v3).
    thinkingPulse = gsap.to(nodes.badgeDot, {
      scale: THINKING_PULSE.ringScalePeak,
      opacity: THINKING_PULSE.arrowDim,
      duration: THINKING_PULSE.period / 2,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
      transformOrigin: 'center',
    });
  } catch {
    /* presentation layer - never fatal */
  }
}

/** The agent is acting again — stop thinking, let the aura settle. */
export function stopThinkingPulse(): void {
  try {
    thinkingPulse?.kill();
    thinkingPulse = null;
    sonarPing?.kill();
    sonarPing = null;
    const host = typeof document === 'undefined' ? null : document.getElementById(CURSOR_ID);
    const shadow = host?.shadowRoot;
    if (shadow) {
      gsap.set(shadow.querySelector('.ac-dot'), { scale: 1, opacity: 1 });
      gsap.set(shadow.querySelector('.ac-sonar'), { scale: 1, opacity: 0 });
      gsap.set(shadow.querySelector('.ac-arrow'), { opacity: 1, scale: 1 });
      gsap.set(shadow.querySelector('.ac-badge'), { scale: 1, opacity: 1 });
      restAura(shadow.querySelector('.ac-aura') as HTMLElement | null);
    }
  } catch {
    /* presentation layer - never fatal */
  }
}

/**
 * Position + colour the overlay for a centre/box/kind. Never throws.
 *
 * v5: this now only (a) tints the target HALO by action kind and
 * (b) hands the travel to `travelCurve` — the S-curve bézier engine that
 * also re-samples the page theme under the target (applyTheme) so the
 * pointer inverts on dark sites. `kind` still drives the halo tint.
 */
function moveOverlay(
  nodes: OverlayNodes,
  cx: number,
  cy: number,
  s: { width: string; height: string; border: string; background: string },
  kind: CursorActionKind,
): void {
  const color = KIND_COLORS[kind];

  // v3: the target box is a soft rounded HALO (radius + soft glow), not a
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

  // The arrow tip is the hotspot; travel the S-curve to it (themed +
  // aured) — the engine owns the halo glide, label, and arrival beat.
  const target = { x: cx, y: cy };
  travelCurve(nodes, target, cx, cy);
}

/**
 * Position the agent cursor over a target element for a kind of action.
 * Reads the element's *current* rect (the executor has already scrolled it
 * into view), colours it by action kind, and labels it `<KIND> · <TAG>`.
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
 * Call this the moment an action *lands* (from the executor), not when the
 * cursor is presented. Pure presentation; never throws; no-op under
 * reduced motion (a ripple is a visual effect, not information).
 */
export function pulseCursor(): void {
  try {
    const nodes = ensureCursorEl();
    if (!nodes) return;
    if (prefersReducedMotion()) return;
    stopThinkingPulse();
    // v5: the tip sits TIP_OFFSET inside the ARROW box, which is pinned at
    // lastPos (the element centre) — so the ripple fires at the tip, not
    // the centre, matching where the user's eye is watching.
    const tipX = lastPos.x - TIP_OFFSET.x;
    const tipY = lastPos.y - TIP_OFFSET.y;
    gsap.fromTo(
      nodes.ripple,
      { scale: 0.25, opacity: 0.5, x: tipX, y: tipY, backgroundColor: KIND_COLORS.CLICK },
      { scale: 2.6, opacity: 0, duration: 0.6, ease: 'power2.out', overwrite: 'auto' },
    );
    // The landing beat is a quick scale-pop on the target halo (the
    // "action landed" feedback), plus a brightening working-aura blip.
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
