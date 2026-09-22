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
  startThinkingPulse,
  stopThinkingPulse,
  THINKING_PULSE,
  curveControlPoint,
  samplePageDark,
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

describe('travelDuration (v2: slower, fluid, never teleports)', () => {
  it('snaps tiny hops (<=2px) instantly', () => {
    expect(travelDuration(0)).toBe(0);
    expect(travelDuration(2)).toBe(0);
  });
  it('scales with distance (~850px/s, slower than v1 so it reads as a glide)', () => {
    // 800px / 850 = 0.94s (was 0.5s at ~1600px/s in v1)
    expect(travelDuration(800)).toBeCloseTo(800 / 850, 3);
  });
  it('has a 0.25s floor so short nudges glide instead of snapping', () => {
    expect(travelDuration(30)).toBe(0.25);
    expect(travelDuration(100)).toBe(0.25); // 100/850=0.118 -> floored to 0.25
  });
  it('caps long jumps at 1.2s (deliberate, not sluggish)', () => {
    expect(travelDuration(4000)).toBe(1.2);
  });
  it('never returns NaN', () => {
    expect(travelDuration(Number.NaN)).toBe(0);
  });
});

describe('thinking pulse (v3: badge-dot heartbeat + sonar ping while the planner waits)', () => {
  it('exposes stable, sane timing constants', () => {
    expect(THINKING_PULSE.period).toBeGreaterThan(1);
    // v3: the badge's center dot breathes up to this scale (a heartbeat,
    // not the whole ring scaling like v2).
    expect(THINKING_PULSE.ringScalePeak).toBeGreaterThan(1);
    expect(THINKING_PULSE.arrowDim).toBeGreaterThan(0);
    expect(THINKING_PULSE.arrowDim).toBeLessThan(1);
    // v3: the sonar ping expands out of the tip up to this scale.
    expect(THINKING_PULSE.sonarScale).toBeGreaterThan(THINKING_PULSE.ringScalePeak);
  });
});

describe('curveControlPoint (v5: S-curve travel, deterministic + testable)', () => {
  it('bows the control point off the straight line for a real hop', () => {
    const cp = curveControlPoint({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(cp.curved).toBe(true);
    // Midpoint is (200, 0); the bow pushes the control point off the line
    // so the cursor glides in an arc, not a rigid straight shot.
    expect(cp.x).toBeCloseTo(200, 0);
    expect(cp.y).not.toBe(0); // a genuine arc
  });
  it('is deterministic (same inputs -> same curve)', () => {
    const a = curveControlPoint({ x: 10, y: 20 }, { x: 300, y: 400 });
    const b = curveControlPoint({ x: 10, y: 20 }, { x: 300, y: 400 });
    expect(a).toEqual(b);
  });
  it('degenerates to a snap for sub-4px hops (no visible curve)', () => {
    const cp = curveControlPoint({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(cp.curved).toBe(false);
    expect(cp).toEqual({ x: 2, y: 0, curved: false });
  });
  it('never returns NaN for garbage input', () => {
    const cp = curveControlPoint({ x: NaN, y: NaN }, { x: 500, y: 500 });
    expect(Number.isFinite(cp.x)).toBe(true);
    expect(Number.isFinite(cp.y)).toBe(true);
  });
});

describe('samplePageDark (v5: theme-aware colour inversion)', () => {
  it('returns null (light fallback) when nothing is sampleable', () => {
    // jsdom has no layout / elementFromPoint returns null -> light default.
    expect(samplePageDark(10, 10)).toBeNull();
  });
  it('reads a dark page background under the point and reports dark=true', () => {
    // Stub elementFromPoint + getComputedStyle on a fake doc to verify the
    // luminance path end-to-end without a real browser.
    const fakeDoc = {
      elementFromPoint: () => ({ parentElement: null }),
      defaultView: {
        getComputedStyle: () => ({ backgroundColor: 'rgb(15, 23, 42)' }), // #0f172a -> dark
      },
    } as unknown as Document;
    expect(samplePageDark(10, 10, fakeDoc)).toBe(true);
  });
  it('reads a light page background and reports dark=false', () => {
    const fakeDoc = {
      elementFromPoint: () => ({ parentElement: null }),
      defaultView: {
        getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
      },
    } as unknown as Document;
    expect(samplePageDark(10, 10, fakeDoc)).toBe(false);
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

  it('v5: mounts the aura (working glow), presence badge, sonar, and halo', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    showCursor(el, 'CLICK');
    const shadow = (document.getElementById(CURSOR_ID) as HTMLElement).shadowRoot!;
    // v5: the blue "agent is working" aura sits behind the arrow.
    expect(shadow.querySelector('.ac-aura')).toBeTruthy();
    // The presence badge = concentric ring with a center dot (unchanged).
    const badge = shadow.querySelector('.ac-badge') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.querySelector('.ac-dot')).toBeTruthy();
    // Faint sonar ping + soft target halo.
    expect(shadow.querySelector('.ac-sonar')).toBeTruthy();
    expect(shadow.querySelector('.ac-halo')).toBeTruthy();
    // The pointer is the "select" cursor path, mirrored so the tip points
    // top-left, defaulting to the light theme (dark shape on white outline).
    const grp = shadow.querySelector('.ac-arrow svg g');
    expect(grp?.getAttribute('transform')).toContain('scale(-1,1)');
    const path = shadow.querySelector('.ac-arrow svg path');
    expect(path?.getAttribute('fill')).toBe('#111827'); // light-theme default
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

  it('startThinkingPulse / stopThinkingPulse are idempotent and never throw', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    showCursor(el, 'CLICK');
    expect(() => startThinkingPulse()).not.toThrow();
    expect(() => startThinkingPulse()).not.toThrow(); // second call restarts, no dup tween
    expect(() => stopThinkingPulse()).not.toThrow();
    // A new travel stops the pulse automatically.
    startThinkingPulse();
    expect(() => showCursor(el, 'TYPE')).not.toThrow();
    expect(() => stopThinkingPulse()).not.toThrow();
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
