// src/lib/agentCursor.ts
//
// Issue #101 — computer-use style "agent cursor" overlay.
//
// Before every target-bearing action the content script positions this
// overlay over the element the agent is about to touch, and labels it with
// the ACTION KIND + element tag (never values: no typed text, no URLs, no
// PII reaches the overlay or the logs). It is a pure presentation layer:
// pointer-events:none, no layout impact, safe to leave on any page.
//
// Pure-ish + exported so the behaviour is unit-testable in jsdom: the DOM
// mutations are real (jsdom supports createElement/append/attribute), and
// the positioning decision is a pure helper (rect -> styles) that tests can
// call directly without relying on getBoundingClientRect.

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
 * where should the dot land and how big is the ring?
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

/** Build (once) or reuse the cursor overlay node on this page. */
function ensureCursorEl(): { dot: HTMLElement; ring: HTMLElement; label: HTMLElement } | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let host = document.getElementById(CURSOR_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = CURSOR_ID;
    // Presentation only: the page (and the agent's own actions) must never
    // be blocked by the overlay.
    host.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'pointer-events:none',
      'z-index:2147483647',
    ].join(';');
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'border-radius:6px',
      'transition:transform 260ms cubic-bezier(.22,1,.36,1), width 140ms ease, height 140ms ease, border-color 140ms ease, background 140ms ease',
    ].join(';');
    // #101 follow-up: the plain round dot read as "too plain" - a real mouse
    // arrow instead. A pointer SVG in a fixed 26px box, coloured by action
    // kind, white outline so it reads on any page background. The box gets a
    // transform glide so it eases to each new target rather than teleporting.
    const arrow = document.createElement('div');
    arrow.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'width:26px',
      'height:26px',
      'transition:transform 260ms cubic-bezier(.22,1,.36,1)',
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45))',
    ].join(';');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.style.overflow = 'visible';
    const path = document.createElementNS(svgNS, 'path');
    // Classic mouse-pointer arrow, tip at the top-left of the box.
    path.setAttribute('d', 'M4,2 L4,17 L7.6,13.6 L10.2,19.4 L12.6,18.4 L10,12.6 L15.2,12.6 Z');
    path.setAttribute('fill', KIND_COLORS.CLICK);
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    arrow.appendChild(svg);
    const label = document.createElement('div');
    label.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'font:600 11px/1 system-ui,sans-serif',
      'color:#fff',
      'padding:3px 7px',
      'border-radius:5px',
      'white-space:nowrap',
      'transition:transform 260ms cubic-bezier(.22,1,.36,1), background 140ms ease',
    ].join(';');
    host.appendChild(ring);
    host.appendChild(arrow);
    host.appendChild(label);
    document.body.appendChild(host);
  }
  const ring = host.firstElementChild as HTMLElement | null;
  const arrow = host.children[1] as HTMLElement | null;
  const label = host.children[2] as HTMLElement | null;
  if (!ring || !arrow || !label) return null;
  return { dot: arrow, ring, label };
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
    const node = ensureCursorEl();
    if (!node) return false;
    const { dot, ring, label } = node;
    const rect: CursorPosition = el.getBoundingClientRect
      ? el.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };
    const s = cursorStyles(rect, kind);
    const cx = Number.isFinite(rect.x) ? rect.x + (Number.isFinite(rect.width) ? rect.width : 0) / 2 : 0;
    const cy = Number.isFinite(rect.y) ? rect.y + (Number.isFinite(rect.height) ? rect.height : 0) / 2 : 0;
    // Ring: eased glide, centered on the element centre.
    ring.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    ring.style.width = s.width;
    ring.style.height = s.height;
    ring.style.border = s.border;
    ring.style.background = s.background;
    // Arrow: the pointer TIP is the hotspot (like a real OS cursor), so the
    // 24-unit tip at viewBox (4,2) lands on (cx, cy) - offset by that. The
    // 260ms transform transition (set in ensureCursorEl) makes it glide.
    dot.style.transform = `translate(${cx - 4}px, ${cy - 2}px)`;
    const color = KIND_COLORS[kind];
    const pathEl = dot.querySelector('svg path') as SVGPathElement | null;
    if (pathEl) pathEl.setAttribute('fill', color);
    // Label trails the arrow tip, bottom-right, like a cursor tooltip.
    label.style.transform = `translate(${cx + 14}px, ${cy + 14}px)`;
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    label.textContent = cursorLabel(kind, tag);
    label.style.background = color;
    node.dot.style.visibility = 'visible';
    node.ring.style.visibility = 'visible';
    node.label.style.visibility = 'visible';
    return true;
  } catch {
    return false;
  }
}

/** Hide the cursor (e.g. at task end / navigation). Idempotent. */
export function hideCursor(): void {
  try {
    const host = typeof document === 'undefined' ? null : document.getElementById(CURSOR_ID);
    if (!host) return;
    host.style.display = 'none';
  } catch {
    /* presentation layer - never fatal */
  }
}

/** Remove the overlay node entirely from the page. */
export function removeCursor(): void {
  try {
    if (typeof document === 'undefined') return;
    document.getElementById(CURSOR_ID)?.remove();
  } catch {
    /* presentation layer - never fatal */
  }
}
