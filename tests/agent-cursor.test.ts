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
  quadBezierLUT,
  quadBezierPoint,
  SNAP_MAX,
  LOOP_FAR_1,
  LOOP_FAR_2,
  LOOP_R,
  VIEWPORT_MARGIN,
  CURVE_BOW,
  type TravelMode,
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

describe('travelDuration (v5.3: slow, watchable travel pacing)', () => {
  it('snaps tiny hops (<=2px) instantly', () => {
    expect(travelDuration(0)).toBe(0);
    expect(travelDuration(2)).toBe(0);
  });
  it('scales with distance at ~320px/s (deliberately slow so travel is watchable)', () => {
    // 1280px / 320 = 4.0 -> capped; 640px / 320 = 2.0 exactly.
    expect(travelDuration(640)).toBeCloseTo(2.0, 3);
    expect(travelDuration(1280)).toBe(4); // capped at 4s
  });
  it('has a 0.9s floor so short hops still show a visible path', () => {
    expect(travelDuration(30)).toBe(0.9);
    expect(travelDuration(200)).toBe(0.9); // 200/320=0.625 -> floored to 0.9
  });
  it('never returns NaN', () => {
    expect(travelDuration(Number.NaN)).toBe(0);
  });
});

describe('loopGeometry (v5.3: distance-aware travel shaping)', () => {
  it('snaps very-close hops (≤ SNAP_MAX) with no visible swing', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 50, y: 0 });
    expect(g.mode).toBe('snap');
    expect(g.loop).toBe(false);
    expect(g.loops).toBe(0);
    expect(g.pathLen).toBeCloseTo(50, 6);
    // Path takes the direct line (no middle segment).
    expect(g.approachShare).toBeCloseTo(1, 6);
  });

  it('takes a curve for short–mid hops (< LOOP_FAR_1)', () => {
    // len = 100 -> curve band.
    const g = loopGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(g.mode).toBe('curve');
    expect(g.loop).toBe(false);
    expect(g.loops).toBe(0);
    expect(g.curveCtrl).toBeTruthy();
    // Control point bows perpendicular to the hop direction.
    expect(g.curveCtrl!.y).not.toBeCloseTo(0, 1); // some offset
    expect(g.arcLen).toBeGreaterThan(100); // curve longer than chord
  });

  it('loops for far hops (≥ LOOP_FAR_1) with ONE circle', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(g.mode).toBe('loop');
    expect(g.loop).toBe(true);
    expect(g.loops).toBe(1);
    // The closed loop is 360° + the small connecting arc to B's tangent.
    const deg = Math.abs(g.sweep) * (180 / Math.PI);
    expect(deg).toBeGreaterThanOrEqual(360);
    expect(deg).toBeLessThan(360 + 180);
    expect(g.pathLen).toBeCloseTo(g.approachLen + g.arcLen + g.finalLen, 6);
  });

  it('swings TWO small loops for very-far hops (≥ LOOP_FAR_2)', () => {
    const g = loopGeometry({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(g.mode).toBe('loop');
    expect(g.loops).toBe(2);
    // Two full circles + a small connecting arc.
    const deg = Math.abs(g.sweep) * (180 / Math.PI);
    expect(deg).toBeGreaterThanOrEqual(720);
    expect(deg).toBeLessThan(720 + 180);
  });

  it('scales the loop radius with distance, clamped to [LOOP_R.min, LOOP_R.max]', () => {
    // Short-hop curve (no radius).
    const c = loopGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(c.r).toBe(0);
    // Far hop: 300px -> desired r = 0.25*300=75 (within clamp).
    const g1 = loopGeometry({ x: 0, y: 0 }, { x: 300, y: 0 });
    expect(g1.r).toBeCloseTo(75, 0);
    // Very far: 1000px -> desired r = 0.25*1000=250 -> clamped to max.
    const g2 = loopGeometry({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(g2.r).toBeCloseTo(LOOP_R.max, 0);
    // Minimal far hop: just above LOOP_FAR_1 (e.g. 270px) -> r=67.5.
    const g3 = loopGeometry({ x: 0, y: 0 }, { x: 270, y: 0 });
    expect(g3.r).toBeCloseTo(0.25 * 270, 0);
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
    const toEntry = { x: g.entry.x - 0, y: g.entry.y - 0 };
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

  it('is deterministic with jitter=0; jitter varies the path organically', () => {
    const a = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0);
    const b = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0);
    expect(a).toEqual(b);
    const c = loopGeometry({ x: 10, y: 20 }, { x: 300, y: 400 }, 0.5);
    expect(c.r).not.toBeCloseTo(a.r, 3); // organic radius variation (or curveBow)
    expect(c.cx).not.toBeCloseTo(a.cx, 3); // organic center variation
  });

  it('never retraces: opposite travel directions loop opposite ways', () => {
    const right = loopGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, 0);
    const back = loopGeometry({ x: 400, y: 0 }, { x: 0, y: 0 }, 0);
    expect(Math.sign(right.sweep)).not.toBe(Math.sign(back.sweep));
  });

  it('degrades to curve when a loop does not fit the viewport', () => {
    // A viewport too narrow: even the minimum loop can't fit.
    const g = loopGeometry(
      { x: 10, y: 50 }, { x: 400, y: 50 },
      0,
      { width: 100, height: 100 },
    );
    expect(g.mode).toBe('curve');
    expect(g.curveCtrl).toBeTruthy();
  });

  it('keeps a fitting loop inside the viewport with margin', () => {
    // Wide enough viewport -> loop fits (with margin).
    const g = loopGeometry(
      { x: 20, y: 60 }, { x: 280, y: 60 },
      0,
      { width: 300, height: 200 },
    );
    expect(g.mode).toBe('loop');
    const M = VIEWPORT_MARGIN;
    expect(g.cx - g.r).toBeGreaterThanOrEqual(M - 1); // right edge
    expect(g.cx + g.r).toBeLessThanOrEqual(300 - M + 1); // left edge
    expect(g.cy - g.r).toBeGreaterThanOrEqual(M - 1);
    expect(g.cy + g.r).toBeLessThanOrEqual(200 - M + 1);
  });

  it('never returns NaN for garbage input (NaN coerces to a valid hop, all-finite out)', () => {
    // NaN in the from/to coords coerces to 0 (finite), so the geometry is a
    // valid (0,0) -> (500,500) hop (very far -> 2-loop). The contract: every
    // OUTPUT field is finite — never NaN/Infinity.
    const g = loopGeometry({ x: NaN, y: NaN }, { x: 500, y: 500 });
    const all = [g.cx, g.cy, g.r, g.alpha0, g.sweep, g.approachLen, g.finalLen, g.arcLen, g.pathLen, g.entry.x, g.entry.y, g.exit.x, g.exit.y];
    expect(all.every(Number.isFinite)).toBe(true);
  });
});

describe('quadBezierLUT / quadBezierPoint', () => {
  it('splits the curve into N segments with monotonically increasing cumulative length', () => {
    const a = { x: 0, y: 0 };
    const c = { x: 50, y: -40 }; // control bows upward (y-down screen, so negative y = up).
    const b = { x: 100, y: 0 };
    const lut = quadBezierLUT(a, c, b, 32);
    expect(lut.pts.length).toBe(33);
    for (let i = 1; i < lut.cum.length; i++) {
      expect(lut.cum[i]).toBeGreaterThan(lut.cum[i - 1]);
    }
    expect(lut.total).toBeCloseTo(lut.cum[lut.cum.length - 1]);
  });

  it('samples exact endpoints at u=0 and u=1', () => {
    const a = { x: 10, y: 20 };
    const c = { x: 30, y: 40 };
    const b = { x: 50, y: 60 };
    const lut = quadBezierLUT(a, c, b, 8);
    expect(quadBezierPoint(lut, 0)).toEqual(a);
    expect(quadBezierPoint(lut, 1)).toEqual(b);
  });

  it('clamps outside [0,1] to the nearest endpoint', () => {
    const a = { x: 0, y: 0 };
    const c = { x: 0, y: 0 };
    const b = { x: 100, y: 100 };
    const lut = quadBezierLUT(a, c, b, 4);
    expect(quadBezierPoint(lut, -0.5).x).toBe(0);
    expect(quadBezierPoint(lut, 1.5).x).toBe(100);
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

describe('samplePageDark (v5.3: PAGE-level theme, not local-element)', () => {
  it('returns null (light fallback) when nothing is sampleable', () => {
    // jsdom has no layout / elementFromPoint returns null -> light default.
    expect(samplePageDark(10, 10)).toBeNull();
  });
  it('reads a dark PAGE background via html/body first', () => {
    // Page-level sampling: the function checks documentElement then body.
    // The first non-transparent background wins — early return.
    const fakeBody = { parentElement: null };
    const fakeDocEl = { parentElement: null };
    const calls: Array<{ el: unknown }> = [];
    const fakeDoc = {
      documentElement: fakeDocEl,
      body: fakeBody,
      elementFromPoint: () => ({ parentElement: null }),
      defaultView: {
        getComputedStyle: (el: unknown) => {
          calls.push({ el });
          if (el === fakeBody || el === fakeDocEl) {
            return { backgroundColor: 'rgb(15, 23, 42)' }; // #0f172a -> dark
          }
          return { backgroundColor: 'transparent' };
        },
      },
    } as unknown as Document;
    expect(samplePageDark(10, 10, fakeDoc)).toBe(true);
    // Called with documentElement first; body may or may not be called
    // depending on whether the first match is non-transparent.
    expect(calls.some((c) => c.el === fakeDocEl)).toBe(true);
  });
  it('defaults to LIGHT (black arrow) on a light page, ignoring local dark elements', () => {
    // The page-level background is light; a dark card under the tip must
    // NOT flip the cursor white (that was the bug).
    const fakeBody = { parentElement: null };
    const fakeLocal = { parentElement: null };
    const fakeDoc = {
      documentElement: fakeBody,
      body: fakeBody,
      elementFromPoint: () => fakeLocal,
      defaultView: {
        getComputedStyle: (el: unknown) => {
          if (el === fakeLocal) {
            return { backgroundColor: 'rgb(15, 23, 42)' }; // dark card
          }
          return { backgroundColor: 'rgb(252, 252, 255)' }; // light page
        },
      },
    } as unknown as Document;
    expect(samplePageDark(10, 10, fakeDoc)).toBe(false); // light page wins
  });
  it('falls back to the local walk when the page background is transparent', () => {
    // Some sites leave body/html transparent and set the theme on a
    // full-viewport div reached by walking up from the hit element.
    const fakeLocal = { parentElement: null };
    const fakeDoc = {
      documentElement: { parentElement: null },
      body: { parentElement: null },
      elementFromPoint: () => fakeLocal,
      defaultView: {
        getComputedStyle: (el: unknown) => {
          if (el === fakeLocal) {
            return { backgroundColor: 'rgb(15, 23, 42)' };
          }
          return { backgroundColor: 'transparent' };
        },
      },
    } as unknown as Document;
    expect(samplePageDark(10, 10, fakeDoc)).toBe(true);
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

  it('v5.3: mounts the border-tracing aura + halo, and NO badge/dot/sonar', () => {
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
