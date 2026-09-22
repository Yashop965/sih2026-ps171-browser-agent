// src/lib/agentCursor.ts
//
// Issue #101 / #132 / #137 — computer-use style "agent cursor" overlay, v3.
//
// v3 (Notion-agent make-over, user reference 2026-09-22): the visual
// language is the Notion/Linear agent-cursor concept — a CLEAN, rounded
// dark arrow (solid, high-contrast, reads on any page) with a "presence
// badge" at the hotspot: a small concentric ring + center dot, like a
// recording/sentinel indicator. The target box is a soft rounded halo
// tinted by action kind (a gentle focus glow, not a hard box).
//
//   Idle / thinking : the badge's center dot breathes (slow yoyo scale)
//                     and a faint sonar ring pings out from the tip.
//   Gliding         : transform-only travel (v2 pacing: 850px/s, 0.25s
//                     floor, 1.2s cap) — deliberate, never teleporting.
//   Action lands    : the tip badge flashes the action color + a ripple.
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

// v3: the Notion-style presence badge at the hotspot — a constant agent
// accent so the badge reads as "the agent", independent of the action.
const ACCENT = '#2563eb';
const ARROW_FILL = '#111827';
const ARROW_STROKE = '#ffffff';

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
  arrow: HTMLElement;
  badge: HTMLElement;
  badgeDot: HTMLElement;
  sonar: HTMLElement;
  label: HTMLElement;
  ripple: HTMLElement;
}

/**
 * Build (once) or reuse the v3 cursor overlay. The host is a plain fixed
 * node in the light DOM — so `document.getElementById(CURSOR_ID)` keeps
 * working and the pointer-events:none / z-index contract holds for the
 * page. Its *inner* nodes live in an open shadow root with `all:initial`
 * so hostile host-page CSS cannot hide or restyle them.
 *
 * Node map (all absolutely-positioned, centred via xPercent/yPercent so
 * every motion is transform-only):
 *   .ac-halo    — the soft rounded target box (kind-tinted glow)
 *   .ac-arrow   — the clean rounded dark arrow, hotspot at top-left
 *   .ac-badge   — the presence badge ring (concentric circle) at the tip
 *   .ac-dot     — the badge's center dot (breathes while thinking)
 *   .ac-sonar   — the faint pinging sonar ring (thinking only)
 *   .ac-label   — the dark `<KIND> · <TAG>` pill
 *   .ac-ripple  — the click confirmation ripple
 */
function ensureCursorEl(): OverlayNodes | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(CURSOR_ID) as HTMLElement | null;
  if (!host || !host.dataset.agentCursor3) {
    // A pre-v3 host (or a stale node without the new badge/sonar) is
    // replaced wholesale rather than migrated.
    host?.remove();
    host = document.createElement('div');
    host.id = CURSOR_ID;
    host.dataset.agentCursor3 = '1';
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
.ac-arrow{position:absolute;top:0;left:0;width:22px;height:22px;pointer-events:none;will-change:transform,opacity;
filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,.45));}
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
    // The halo box (width/height/border/bg) is set instantly when the target
    // changes — it is our own glow, not page content — and the GLIDE is a
    // transform-only x/y tween, so no layout property ever animates.
    shadow.appendChild(halo);

    const arrow = document.createElement('div');
    arrow.className = 'ac-arrow';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    // Clean, rounded mouse-pointer arrow (Notion-agent style): tip at the
    // top-left of the box, soft stroke-linejoin so no sharp 90° corners.
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M4.5,2.5 L4.5,17.5 L8.1,14.2 L10.4,19.6 L13,18.5 L10.7,13.1 L15.8,13.1 Z');
    path.setAttribute('fill', ARROW_FILL);
    path.setAttribute('stroke', ARROW_STROKE);
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
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
  const arrow = shadow.querySelector('.ac-arrow') as HTMLElement | null;
  const badge = shadow.querySelector('.ac-badge') as HTMLElement | null;
  const badgeDot = shadow.querySelector('.ac-dot') as HTMLElement | null;
  const sonar = shadow.querySelector('.ac-sonar') as HTMLElement | null;
  const label = shadow.querySelector('.ac-label') as HTMLElement | null;
  const ripple = shadow.querySelector('.ac-ripple') as HTMLElement | null;
  if (!halo || !arrow || !badge || !badgeDot || !sonar || !label || !ripple) return null;
  return { host: host as HTMLElement, halo, arrow, badge, badgeDot, sonar, label, ripple };
}

/** Last known cursor position (the arrow tip) — origin of every travel. */
let lastPos = { x: 0, y: 0 };
/** Active travel timeline; killed on every retarget (overwrite semantics). */
let travel: gsap.core.Timeline | null = null;
/** The idle thinking-pulse tweens (single, interruptible): dot heartbeat. */
let thinkingPulse: gsap.core.Tween | null = null;
/** v3: the idle sonar ping (expands + fades, loops) - killed with the pulse. */
let sonarPing: gsap.core.Tween | null = null;

/** Host-page reduced-motion preference, checked per call. */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** v3: the agent is now WAITING (planner round-trip) — breathe. */
export function startThinkingPulse(): void {
  try {
    if (prefersReducedMotion()) return;
    const nodes = ensureCursorEl();
    if (!nodes) return;
    stopThinkingPulse();
    // Place the badge + sonar at the current tip before breathing (they
    // may have never had a travel run, e.g. overlay just built).
    const tip = { x: lastPos.x - 4, y: lastPos.y - 2 };
    const bx = tip.x + 4;
    const by = tip.y + 4;
    gsap.set(nodes.badge, { x: bx, y: by, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: bx, y: by, xPercent: -50, yPercent: -50, scale: 1, opacity: 0.5 });
    gsap.set(nodes.badgeDot, { scale: 1, opacity: 1 });

    // Heartbeat: the badge's center dot pulses (scale + a soft opacity
    // dip), one yoyo repeat = one breathing cycle, runs until killed.
    thinkingPulse = gsap.to(nodes.badgeDot, {
      scale: THINKING_PULSE.ringScalePeak,
      opacity: THINKING_PULSE.arrowDim,
      duration: THINKING_PULSE.period / 2,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
      transformOrigin: 'center',
    });
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
  } catch {
    /* presentation layer - never fatal */
  }
}

/** The agent is acting again — stop breathing and restore full presence. */
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

  // The presence badge + sonar pin to the arrow tip, not the element
  // centre — they travel with the arrow, like a sentinel on the pointer.
  const badgeX = target.x + 4;
  const badgeY = target.y + 4;

  // Moving = acting: stop the idle breathing first.
  stopThinkingPulse();

  // Kill any in-flight travel and re-steer FROM THE CURRENT position, so a
  // mid-glide retarget never teleports back to the previous origin.
  travel?.kill();
  travel = null;

  if (prefersReducedMotion()) {
    // No animation at all: instant placement, no ripple/pulse.
    gsap.set(nodes.arrow, { x: target.x, y: target.y, scale: 1, opacity: 1 });
    gsap.set(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.badge, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, opacity: 0 });
    gsap.set(nodes.label, { x: cx + 14, y: cy + 14, opacity: 1 });
    lastPos = target;
    return;
  }

  // v3 motion: a slower, longer glide (0.25s floor) with a soft
  // slow-out/slow-in curve reads as a real cursor gliding, not a teleport.
  const dur = travelDuration(Math.hypot(target.x - from.x, target.y - from.y));
  const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
  if (dur > 0) {
    // Transform-only travel (x/y are transforms, never layout).
    tl.to(nodes.arrow, { x: target.x, y: target.y, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
    tl.to(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
    tl.to(nodes.badge, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', immediateRender: true }, 0);
    tl.to(nodes.sonar, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, duration: dur, ease: 'sine.inOut', opacity: 0 }, 0);
    tl.to(nodes.label, { x: cx + 14, y: cy + 14, duration: dur * 0.9, ease: 'power1.inOut', opacity: 1 }, dur * 0.1);
    // Arrival beat: halo settle-pulse + label fade-in, sequenced after the
    // travel in ONE interruptible timeline.
    tl.fromTo(nodes.halo, { scale: 0.96 }, { scale: 1, duration: 0.26, ease: 'power2.out' }, dur);
    tl.fromTo(nodes.label, { opacity: 0.4 }, { opacity: 1, duration: 0.22, ease: 'power1.out' }, dur);
  } else {
    // No travel distance: snap everything instantly.
    gsap.set(nodes.arrow, { x: target.x, y: target.y, scale: 1, opacity: 1 });
    gsap.set(nodes.halo, { x: cx, y: cy, xPercent: -50, yPercent: -50, scale: 1 });
    gsap.set(nodes.badge, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, scale: 1, opacity: 1 });
    gsap.set(nodes.sonar, { x: badgeX, y: badgeY, xPercent: -50, yPercent: -50, opacity: 0 });
    gsap.set(nodes.label, { x: cx + 14, y: cy + 14, opacity: 1 });
  }
  // v3: the arrow stays the constant clean dark shape (Notion reference);
  // the ACTION KIND is carried by the halo tint + the badge border color.
  tl.to(nodes.badge, { borderColor: color, duration: 0.25, ease: 'power1.out' }, 0);
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
    // v3: the landing beat is a quick scale-pop on the target halo (the
    // "action landed" feedback), not on a separate ring node anymore.
    gsap.fromTo(
      nodes.halo,
      { scale: 1 },
      { scale: 1.06, duration: 0.14, yoyo: true, repeat: 1, ease: 'power1.inOut', overwrite: 'auto' },
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
