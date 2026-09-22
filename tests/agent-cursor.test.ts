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
  loopGeometry,
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

describe('travelDuration (v5.2: slow, watchable loop pacing)', () => {
  it('snaps tiny hops (<=2px) instantly', () => {
    expect(travelDuration(0)).toBe(0);
    expect(travelDuration(2)).toBe(0);
  });
  it('scales with distance at ~320px/s (deliberately slow so the loop is watchable)', () => {
    // 1280px / 320 = 4.0 -> capped; 640px / 320 = 2.0 exactly.
    expect(travelDuration(640)).toBeCloseTo(2.0, 3);
    expect(travelDuration(1280)).toBe(4); // capped at 4s
  });
  it('has a 0.9s floor so short hops still show a full loop', () => {
    expect(travelDuration(30)).toBe(0.9);
    expect(travelDuration(200)).toBe(0.9); // 200/320=0.625 -> floored to 0.9
  });
  it('never returns NaN', () => {
    expect(travelDuration(Number.NaN)).toBe(0);
  });
});

describe('loopGeometry (v5.2: one CLOSED 360° loop while traveling A -> B)', () => {
  it('loops for a real hop: one full circle + connecting arc', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(g.loop).toBe(true);
    // The closed loop is exactly 360° plus the small connecting arc that
    // carries the cursor to B's tangent point (G1 exit).
    const deg = Math.abs(g.sweep) * (180 / Math.PI);
    expect(deg).toBeGreaterThanOrEqual(360);
    expect(deg).toBeLessThan(360 + 180);
    // pathLen = approach + arc + final.
    expect(g.pathLen).toBeCloseTo(g.approachLen + g.arcLen + g.finalLen, 6);
  });

  it('entry + exit sit on the loop circle, and the joins are tangent-continuous (G1)', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 400, y: 300 });
    // entry/exit are ON the circle.
    expect(Math.hypot(g.entry.x - g.cx, g.entry.y - g.cy)).toBeCloseTo(g.r, 1);
    expect(Math.hypot(g.exit.x - g.cx, g.exit.y - g.cy)).toBeCloseTo(g.r, 1);
    // G1 at the entry: approach A->entry direction == loop departure
    // direction (cosine of the angle between them ~ 1.0).
    const w = Math.sign(g.sweep) || 1;
    const a0 = g.alpha0;
    const toEntry = {
      x: g.entry.x - 0,
      y: g.entry.y - 0,
    };
    const Le = Math.hypot(toEntry.x, toEntry.y);
    const nE = { x: toEntry.x / Le, y: toEntry.y / Le };
    const loopDir = { x: w * -Math.sin(a0), y: w * Math.cos(a0) };
    const cosEntry = nE.x * loopDir.x + nE.y * loopDir.y;
    expect(cosEntry).toBeGreaterThan(0.99);
    // G1 at the exit: loop arrival direction == exit->B direction.
    const aE = a0 + g.sweep;
    const toB = { x: 400 - g.exit.x, y: 300 - g.exit.y };
    const Lb = Math.hypot(toB.x, toB.y);
    const nB = { x: toB.x / Lb, y: toB.y / Lb };
    const loopDirE = { x: w * -Math.sin(aE), y: w * Math.cos(aE) };
    const cosExit = nB.x * loopDirE.x + nB.y * loopDirE.y;
    expect(cosExit).toBeGreaterThan(0.99);
  });

  it('is deterministic with jitter=0; jitter varies the loop organically', () => {
    const a = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0);
    const b = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0);
    expect(a).toEqual(b);
    const c = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0.5);
    expect(c.r).not.toBeCloseTo(a.r, 3); // organic radius variation
    expect(c.cx).not.toBeCloseTo(a.cx, 3); // organic center variation
  });

  it('never retraces: opposite travel directions loop opposite ways', () => {
    const right = loopGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, 0);
    const back = loopGeometry({ x: 400, y: 0 }, { x: 0, y: 0 }, 0);
    expect(Math.sign(right.sweep)).not.toBe(Math.sign(back.sweep));
  });

  it('snaps sub-40px hops (no room to read a loop)', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 20, y: 0 });
    expect(g.loop).toBe(false);
    expect(g.pathLen).toBeCloseTo(20, 6);
  });

  it('never returns NaN for garbage input (NaN coerces to a valid hop, all-finite out)', () => {
    // NaN in the from/to coords coerces to 0 (finite), so the geometry is a
    // valid (0,0) -> (500,500) hop. The contract: every OUTPUT field is
    // finite — never NaN/Infinity.
    const g = loopGeometry({ x: NaN, y: NaN }, { x: 500, y: 500 });
    const all = [g.cx, g.cy, g.r, g.alpha0, g.sweep, g.approachLen, g.finalLen, g.arcLen, g.pathLen, g.entry.x, g.entry.y, g.exit.x, g.exit.y];
    expect(all.every(Number.isFinite)).toBe(true);
  });
});

describe('thinking pulse (v5.1: border-glow breath while the planner waits)', () => {
  it('exposes stable, sane timing constants', () => {
    expect(THINKING_PULSE.period).toBeGreaterThan(1);
    // v5.1: the working aura breathes up to this scale (heartbeat on the
    // arrow's border, not a separate ring).
    expect(THINKING_PULSE.scalePeak).toBeGreaterThan(1);
    expect(THINKING_PULSE.arrowDim).toBeGreaterThan(0);
    expect(THINKING_PULSE.arrowDim).toBeLessThan(1);
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
    // jsdom rects are all zero, so the halo collapses but the node still
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

  it('v5.1: mounts the border-tracing aura + halo, and NO badge/dot/sonar', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    showCursor(el, 'CLICK');
    const shadow = (document.getElementById(CURSOR_ID) as HTMLElement).shadowRoot!;
    // The border-tracing "working" glow: a blurred blue SVG stroke of the
    // same cursor path, hugging the arrow's silhouette.
    expect(shadow.querySelector('.ac-aura')).toBeTruthy();
    expect(shadow.querySelector('.ac-aura svg path')).toBeTruthy();
    // The user asked for the blue dot to be GONE — no badge, no center
    // dot, no sonar ring anywhere in the overlay.
    expect(shadow.querySelector('.ac-badge')).toBeNull();
    expect(shadow.querySelector('.ac-dot')).toBeNull();
    expect(shadow.querySelector('.ac-sonar')).toBeNull();
    // Soft target halo remains (the element box, not a cursor indicator).
    expect(shadow.querySelector('.ac-halo')).toBeTruthy();
    // The pointer is the "select" cursor path, mirrored so the tip points
    // top-left, defaulting to the LIGHT theme (black shape on light sites).
    const grp = shadow.querySelector('.ac-arrow svg g');
    expect(grp?.getAttribute('transform')).toContain('scale(-1,1)');
    const path = shadow.querySelector('.ac-arrow svg path');
    expect(path?.getAttribute('fill')).toBe('#111827'); // black on light
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
