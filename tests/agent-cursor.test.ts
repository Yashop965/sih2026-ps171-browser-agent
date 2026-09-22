// tests/agent-cursor.test.ts — issue #101 visual agent-cursor overlay
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cursorLabel,
  cursorStyles,
  travelDuration,
  showCursor,
  pulseCursor,
  hideCursor,
  removeCursor,
} from '../src/lib/agentCursor';

const CURSOR_ID = '__agent-cursor';

// The overlay's inner nodes live in an OPEN shadow root on the host (so
// hostile page CSS can't reach them); tests read through it.
const shadowLabel = (hostId: string) =>
  (document.getElementById(hostId) as HTMLElement)
    ?.shadowRoot?.querySelector('.ac-label') as HTMLElement | null;

describe('cursorLabel', () => {
  it('is kind + element tag, never a value', () => {
    expect(cursorLabel('CLICK', 'button')).toBe('CLICK · button');
    expect(cursorLabel('TYPE', 'input')).toBe('TYPE · input');
  });
  it('never includes the action value or a URL', () => {
    // The value/URL never flow into this function, so the label cannot leak.
    expect(cursorLabel('TYPE', 'input')).not.toContain('password');
  });
});

describe('cursorStyles', () => {
  it('centres the dot on a normal rect and sizes the ring', () => {
    const s = cursorStyles({ x: 100, y: 50, width: 80, height: 40 }, 'CLICK');
    // centre = (100 + 40, 50 + 20) = (140, 70)
    expect(s.transform).toBe('translate(140px, 70px) translate(-50%, -50%)');
    expect(s.width).toBe('88px'); // +8 padding
    expect(s.height).toBe('48px');
    expect(s.border).toContain('2px solid');
  });

  it('uses a different colour per action kind', () => {
    const click = cursorStyles({ x: 0, y: 0, width: 10, height: 10 }, 'CLICK');
    const type = cursorStyles({ x: 0, y: 0, width: 10, height: 10 }, 'TYPE');
    expect(click.border).not.toBe(type.border);
  });

  it('collapses a zero/NaN rect to a ring-less dot instead of NaN CSS', () => {
    const s = cursorStyles({ x: 0, y: 0, width: 0, height: 0 }, 'CLICK');
    expect(s.width).toBe('0px');
    expect(s.border).toBe('none');
    expect(s.transform).not.toContain('NaN');
    const nan = cursorStyles({ x: NaN, y: NaN, width: NaN, height: NaN }, 'KEY');
    expect(nan.transform).not.toContain('NaN');
  });
});

describe('travelDuration (distance-scaled, clamped)', () => {
  it('snaps tiny hops (<=2px) instantly', () => {
    expect(travelDuration(0)).toBe(0);
    expect(travelDuration(2)).toBe(0);
  });
  it('scales with distance (~1600px/s)', () => {
    expect(travelDuration(800)).toBeCloseTo(0.5, 5);
  });
  it('clamps long jumps to the 0.15-0.6s band', () => {
    expect(travelDuration(10)).toBe(0.15);
    expect(travelDuration(4000)).toBe(0.6);
  });
  it('never returns NaN', () => {
    expect(travelDuration(Number.NaN)).toBe(0);
  });
});

describe('showCursor / hideCursor / removeCursor (jsdom)', () => {
  beforeEach(() => {
    removeCursor();
    document.body.innerHTML = '';
  });
  afterEach(() => removeCursor());

  it('creates the overlay on first use and positions it on the target', () => {
    const el = document.createElement('button');
    el.textContent = 'Go';
    document.body.appendChild(el);
    // jsdom rects are all zero, so the ring collapses but the node still
    // lands.
    const ok = showCursor(el, 'CLICK');
    expect(ok).toBe(true);
    const host = document.getElementById(CURSOR_ID) as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.style.pointerEvents).toBe('none');
    // Inner nodes are shadow-isolated: the label is NOT a light-DOM child.
    expect(host.children.length).toBe(0);
    expect(host.shadowRoot?.querySelectorAll('*').length).toBeGreaterThan(0);
    expect(shadowLabel(CURSOR_ID)?.textContent).toBe('CLICK · button');
  });

  it('is idempotent - one host, reused on repeat calls', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    showCursor(el, 'TYPE');
    showCursor(el, 'CLICK');
    const hosts = document.querySelectorAll(`#${CURSOR_ID}`);
    expect(hosts.length).toBe(1);
    expect(shadowLabel(CURSOR_ID)?.textContent).toBe('CLICK · input');
  });

  it('never throws for a detached element', () => {
    const el = document.createElement('span'); // not appended
    expect(() => showCursor(el, 'KEY')).not.toThrow();
  });

  it('pulseCursor never throws and no-ops gracefully', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    showCursor(el, 'CLICK');
    expect(() => pulseCursor()).not.toThrow();
  });

  it('hideCursor hides but keeps the node; removeCursor removes it', () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    showCursor(el, 'CLICK');
    hideCursor();
    expect(document.getElementById(CURSOR_ID)?.style.display).toBe('none');
    removeCursor();
    expect(document.getElementById(CURSOR_ID)).toBeNull();
  });
});
