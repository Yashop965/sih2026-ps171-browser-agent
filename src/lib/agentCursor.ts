// src/lib/agentCursor.ts
//
// Issue #101 / #132 — computer-use style "agent cursor" overlay, v2.
//
// v2 (make-over, user direction 2026-09-22): the motion should feel FLUID
// and DELIBERATE, not teleporting. A 50px nudge still glides (it never
// snaps), full-screen travels take longer, and while the planner is
// THINKING the cursor breathes (subtle thinking-pulse) instead of sitting
// frozen — so the agent reads as "alive", and the visible pacing matches
// the LLM-bound step latency instead of fighting it. The visual language
// is cleaner: soft rounded target ring, smaller white-on-blue arrow, dark
// pill label. The inner nodes still live in an open shadow root with
// `all:initial` so hostile host-page CSS cannot hide or restyle them.
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

const KIND_COLORS: Record<CursorActionKind, string> = {
  CLICK: '#2563eb',
  TYPE: '#059669',
  SELECT: '#7c3aed',
  KEY: '#d97706',
};

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
 * v2: the idle "thinking" beat. While the agent is between actions (mostly
 * waiting on the planner LLM, which takes seconds) the cursor breathes: a
 * gentle yoyo scale pulse on the ring + soft alpha pulse on the arrow.
 * Runs as ONE interruptible tween; `travel()` / `pulseCursor()` /
 * `stopThinkingPulse()` kill it. Pure timing constants so tests can pin
 * the "alive while waiting" contract.
 */
export const THINKING_PULSE = {
  /** Period of one breathing cycle (out+back), seconds. */
  period: 1.6,
  /** Ring scale peak (1.0 resting -> 1.07 peak). */
  ringScalePeak: 1.07,
  /** Arrow resting opacity while thinking (dips from 1.0). */
  arrowDim: 0.7,
};

interface OverlayNodes {
  host: HTMLElement;
  ring: HTMLElement;
  arrow: HTMLElement;
  label: HTMLElement;
  ripple: HTMLElement;
}

/**
 * Build (once) or reuse the cursor overlay. The host is a plain fixed node
 * in the light DOM — so `document.getElementById(CURSOR_ID)` keeps working
 * and the pointer-events:none / z-index contract holds for the page. Its
 * *inner* nodes live in an open shadow root so host-page CSS selectors
 * cannot reach them.
 */
function ensureCursorEl(): OverlayNodes | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(CURSOR_ID) as HTMLElement | null;
  if (!host || !host.dataset.agentCursor2) {
    // A pre-upgrade host (or a stale node without the shadow root) is
    // replaced wholesale rather than migrated.
    host?.remove();
    host = document.createElement('div');
    host.id = CURSOR_ID;
    host.dataset.agentCursor2 = '1';
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
.ac-ring{position:absolute;top:0;left:0;border-radius:12px;pointer-events:none;will-change:transform;}
.ac-arrow{position:absolute;top:0;left:0;width:20px;height:20px;pointer-events:none;will-change:transform,opacity;
filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));}
.ac-arrow svg{display:block;overflow:visible;}
.ac-label{position:absolute;top:0;left:0;pointer-events:none;font:600 11px/1 system-ui,sans-serif;
color:#fff;background:#0f172aee;padding:4px 9px;border-radius:9999px;white-space:nowrap;
box-shadow:0 2px 8px rgba(0,0,0,.25);will-change:transform;letter-spacing:.02em;}
.ac-ripple{position:absolute;top:0;left:0;width:56px;height:56px;margin:-28px 0 0 -28px;
border-radius:50%;pointer-events:none;opacity:0;transform:scale(.25);will-change:transform,opacity;}`;
    shadow.appendChild(style);

    const ring = document.createElement('div');
    ring.className = 'ac-ring';
    // The ring box (width/height) is set instantly when the target changes
    // — it is our own 2px border, not page content — and the GLIDE is a
    // transform-only x/y tween, so no layout property ever animates.
    shadow.appendChild(ring);

    const arrow = document.createElement('div');
    arrow.className = 'ac-arrow';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    const path = document.createElementNS(svgNS, 'path');
    // Classic mouse-pointer arrow, tip at the top-left of the box.
    path.setAttribute('d', 'M4,2 L4,17 L7.6,13.6 L10.2,19.4 L12.6,18.4 L10,12.6 L15.2,12.6 Z');
    path.setAttribute('fill', KIND_COLORS.CLICK);
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
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
  const ring = shadow.querySelector('.ac-ring') as HTMLElement | null;
  const arrow = shadow.querySelector('.ac-arrow') as HTMLElement | null;
  const label = shadow.querySelector('.ac-label') as HTMLElement | null;
  const ripple = shadow.querySelector('.ac-ripple') as HTMLElement | null;
  if (!ring || !arrow || !label || !ripple) return null;
  return { host: host as HTMLElement, ring, arrow, label, ripple };
}

/** Last known cursor position (the arrow tip) — origin of every travel. */
let lastPos = { x: 0, y: 0 };
/** Active travel timeline; killed on every retarget (overwrite semantics). */
let travel: gsap.core.Timeline | null = null;
/** The idle thinking-pulse tween (single, interruptible). */
let thinkingPulse: gsap.core.Tween | null = null;

/** Host-page reduced-motion preference, checked per call. */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** v2: the agent is now WAITING (planner round-trip) — breathe. */
export function startThinkingPulse(): void {
  try {
    if (prefersReducedMotion()) return;
    const nodes = ensureCursorEl();
    if (!nodes) return;
    stopThinkingPulse();
    // One yoyo repeat = one breathing cycle; runs until killed. The ring
    // is centred via xPercent/yPercent, so scaling around 50/50 keeps it
    // on target.
    thinkingPulse = gsap.to([nodes.ring, nodes.arrow], {
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

/** The agent is acting again — stop breathing and restore full presence. */
export function stopThinkingPulse(): void {
  try {
    thinkingPulse?.kill();
    thinkingPulse = null;
    const host = typeof document === 'undefined' ? null : document.getElementById(CURSOR_ID);
    const shadow = host?.shadowRoot;
    if (shadow) {
      gsap.set(shadow.querySelector('.ac-ring'), { scale: 1 });
      gsap.set(shadow.querySelector('.ac-arrow'), { opacity: 1, scale: 1 });
    }
  } catch {
    /* presentation layer - never fatal */
  }
}

/** Position + colour the overlay for a centre/box/kind. Never throws. */
function moveOverlay(
  nodes: OverlayNodes,
  cx: number,
  cy: number,
  s: { width: string; height: string; border: string; background: string },
  kind: CursorActionKind,
): void {
  const color = KIND_COLORS[kind];
  const target = { x: cx - 4, y: cy - 2 }; // arrow tip is the hotspot
  const from = { ...lastPos };

  nodes.ring.style.width = s.width;
  nodes.ring.style.height = s.height;
  nodes.ring.style.border = s.border;
  nodes.ring.style.background = s.background;

  // Moving = acting: stop the idle breathing first.
  stopThinkingPulse();

  // Kill any in-flight travel and re-steer FROM THE CURRENT position, so a
  // mid-glide retarget never teleports back to the previous origin.
  travel?.kill();
  travel = null;

  if (prefersReducedMotion()) {
    // No animation at all: instant placement, no ripple/pulse.
    gsap.set(nodes.arrow, { x: target.x, y: target.y, scale: 1, opacity: 1 });
    gsap.set(nodes.ring, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.label, { x: cx + 14, y: cy + 14, opacity: 1 });
    lastPos = target;
    return;
  }

  // v2 motion: a slower, longer glide (0.25s floor) with a soft
  // slow-out/slow-in curve reads as a real cursor gliding, not a teleport.
  const dur = travelDuration(Math.hypot(target.x - from.x, target.y - from.y));
  const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
  if (dur > 0) {
    // Transform-only travel (x/y are transforms, never layout).
    tl.to(nodes.arrow, { x: target.x, y: target.y, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
    tl.to(nodes.ring, { x: cx, y: cy, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
    tl.to(nodes.label, { x: cx + 14, y: cy + 14, duration: dur * 0.9, ease: 'power1.inOut', opacity: 1 }, dur * 0.1);
    // Arrival beats: ring settle-pulse + label fade-in, sequenced after the
    // travel in ONE interruptible timeline.
    tl.fromTo(nodes.ring, { scale: 0.94 }, { scale: 1, duration: 0.26, ease: 'power2.out' }, dur);
    tl.fromTo(nodes.label, { opacity: 0.4 }, { opacity: 1, duration: 0.22, ease: 'power1.out' }, dur);
  } else {
    // No travel distance: snap everything instantly.
    gsap.set(nodes.arrow, { x: target.x, y: target.y, scale: 1, opacity: 1 });
    gsap.set(nodes.ring, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.label, { x: cx + 14, y: cy + 14, opacity: 1 });
  }
  // Colour travel: arrow fill + label background (attr/bg are cheap,
  // non-transform; the motion itself stays transform-only).
  tl.to(nodes.arrow.querySelector('svg path') as SVGPathElement, { attr: { fill: color }, duration: 0.25, ease: 'power1.out' }, 0);
  tl.set(nodes.label, { backgroundColor: 'transparent' }, 0);

  travel = tl;
  lastPos = target;
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
    gsap.fromTo(
      nodes.ripple,
      { scale: 0.25, opacity: 0.5, x: lastPos.x - 4, y: lastPos.y - 2, backgroundColor: KIND_COLORS.CLICK },
      { scale: 2.6, opacity: 0, duration: 0.6, ease: 'power2.out', overwrite: 'auto' },
    );
    gsap.fromTo(
      nodes.ring,
      { scale: 1 },
      { scale: 1.08, duration: 0.14, yoyo: true, repeat: 1, ease: 'power1.inOut', overwrite: 'auto' },
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
