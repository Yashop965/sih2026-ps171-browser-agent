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
    ring.style.cssText = ['position:absolute', 'border-radius:6px', 'transition:all 80ms ease-out'].join(';');
    const dot = document.createElement('div');
    dot.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'width:12px',
      'height:12px',
      'border-radius:50%',
      'transform:translate(-50%,-50%)',
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    const label = document.createElement('div');
    label.style.cssText = [
      'position:absolute',
      'top:0',
      'left:100%',
      'margin-left:6px',
      'margin-top:-8px',
      'font:600 11px/1 system-ui,sans-serif',
      'color:#fff',
      'padding:3px 7px',
      'border-radius:5px',
      'white-space:nowrap',
    ].join(';');
    host.appendChild(ring);
    host.appendChild(dot);
    host.appendChild(label);
    document.body.appendChild(host);
  }
  const ring = host.firstElementChild as HTMLElement | null;
  const dot = host.children[1] as HTMLElement | null;
  const label = host.children[2] as HTMLElement | null;
  if (!ring || !dot || !label) return null;
  return { dot, ring, label };
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
    // Host is pinned at (0,0); dot and ring both centre on the element centre.
    ring.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    ring.style.width = s.width;
    ring.style.height = s.height;
    ring.style.border = s.border;
    ring.style.background = s.background;
    dot.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    dot.style.background = KIND_COLORS[kind];
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    label.textContent = cursorLabel(kind, tag);
    label.style.background = KIND_COLORS[kind];
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
