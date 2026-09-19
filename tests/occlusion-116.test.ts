/**
 * Issue #116 - hit-test (elementFromPoint) before every click/typing.
 *
 * A covered target (cookie banner, sticky header, modal over a button) used
 * to be acted on silently: the input was dispatched to the registry node and
 * landed on the overlay instead. Now doClick/doType hit-test the target's
 * center and reject covered targets BEFORE any input is dispatched.
 *
 * jsdom has no layout, so the test emulates geometry: getBoundingClientRect is
 * stubbed per element and document.elementFromPoint is shadowed with a
 * function whose behaviour we control. The "unavailable" and "zero-geometry"
 * tests prove the check degrades to proceed (never false-covers), which is
 * what keeps the rest of the suite green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execute, executeWithRetry, executeWithResilience } from '../src/lib/actions';

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) =>
    id === 1 ? liveTarget : id === 2 ? liveField : undefined,
  getElementByStableId: (_id: string) => undefined,
}));

const liveTarget = document.createElement('button');
liveTarget.textContent = 'Submit';
document.body.appendChild(liveTarget);

const liveField = document.createElement('input');
document.body.appendChild(liveField);

const overlay = document.createElement('div');
overlay.textContent = 'banner';
document.body.appendChild(overlay);

// What elementFromPoint reports at the target's center - the whole test
// revolves around this one switch.
let hitReport: Element | null = liveTarget;

// Count input actually dispatched onto the target, to prove a covered
// rejection happens BEFORE any event reaches it.
let inputDispatched = 0;
liveTarget.addEventListener('click', () => inputDispatched++);
liveField.addEventListener('input', () => inputDispatched++);

function setRect(el: Element, w: number, h: number, x = 0, y = 0) {
  // toJSON() is required: jsdom's scrollIntoView() serializes the DOMRect it
  // receives, and a plain stub object without it throws.
  (el as any).getBoundingClientRect = () =>
    ({
      x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
      toJSON: () => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }),
    }) as DOMRect;
}

beforeEach(() => {
  hitReport = liveTarget;
  document.elementFromPoint = (() => hitReport) as any;
  setRect(liveTarget, 100, 40, 10, 10);
  setRect(liveField, 200, 30, 5, 5);
  inputDispatched = 0;
});

afterEach(() => {
  // Drop the instance-level stubs so jsdom's own (zero-rect) behaviour is
  // back for the next test's explicit setup.
  delete (liveTarget as any).getBoundingClientRect;
  delete (liveField as any).getBoundingClientRect;
  delete (document as any).elementFromPoint;
});

describe('Issue #116 - occlusion hit-test', () => {
  it('rejects a CLICK when an overlay covers the target, and dispatches nothing', async () => {
    hitReport = overlay;
    const result = await execute({ type: 'CLICK', targetId: 1 });
    expect(result.ok).toBe(false);
    expect(result.covered).toBe(true);
    expect(result.stale).toBe(false); // the element exists - it is just blocked
    expect(result.error ?? '').toMatch(/covered/i);
    expect(inputDispatched).toBe(0);
  });

  it('rejects a TYPE when the field is covered', async () => {
    hitReport = overlay;
    const result = await execute({ type: 'TYPE', targetId: 2, value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.covered).toBe(true);
    expect(inputDispatched).toBe(0);
  });

  it('lets the action through when the target is on top', async () => {
    hitReport = liveTarget; // topmost node at the center is the target itself
    const result = await execute({ type: 'CLICK', targetId: 1 });
    expect(result.ok).toBe(true);
    expect(result.covered).toBeFalsy(); // success omits the flag (undefined)
    expect(inputDispatched).toBe(1);
  });

  it('degrades to proceed when elementFromPoint is unavailable', async () => {
    delete (document as any).elementFromPoint;
    const result = await execute({ type: 'CLICK', targetId: 1 });
    expect(result.ok).toBe(true);
  });

  it('degrades to proceed with zero-geometry rects (jsdom default layout)', async () => {
    delete (liveTarget as any).getBoundingClientRect; // back to jsdom's all-zero rect
    hitReport = overlay; // would be "covered" IF geometry existed - but it doesn't
    const result = await execute({ type: 'CLICK', targetId: 1 });
    expect(result.ok).toBe(true); // ambiguous = proceed, never false-cover
  });

  it('short-circuits executeWithRetry on a covered target (no blind re-click)', async () => {
    hitReport = overlay;
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    const result = await executeWithRetry({ type: 'CLICK', targetId: 1 });

    global.setTimeout = originalSetTimeout;
    expect(result.ok).toBe(false);
    expect(result.covered).toBe(true);
    // No 400ms retry delay was incurred - one attempt, then the planner
    // must dismiss the overlay and re-extract.
    expect(delays).not.toContain(400);
  });

  it('short-circuits executeWithResilience on a covered target (no backoff ladder)', async () => {
    hitReport = overlay;
    const result = await executeWithResilience({ type: 'CLICK', targetId: 1 }, 3);
    expect(result.ok).toBe(false);
    expect(result.covered).toBe(true);
    // The loop broke on the first covered result: no 200/400ms backoff ran,
    // so the whole call resolves fast (single attempt + 50ms settle).
    expect(result.durationMs ?? 0).toBeLessThan(1000);
  });
});
