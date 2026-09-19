/**
 * Issue #119 - event-aware post-input settle replaces the blanket 120ms sleep.
 *
 * After a plain action the executor settles ~50ms (was 120ms). After typing
 * into a combobox it polls for a visible [role="option"] in the field's
 * aria-controls/aria-owns root, bounded to 200ms, so an autocomplete that
 * appears before the re-extract is actually observed.
 *
 * Pinned with fake timers where the sleep windows are asserted; the
 * combobox path is asserted on real elapsed duration (it polls every 20ms,
 * which fake timers would race with Date.now()).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execute, type Action } from '../src/lib/actions';

const els = new Map<number, Element>();
const stableEls = new Map<string, Element>();

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) => els.get(id),
  getElementByStableId: (id: string) => stableEls.get(id),
}));

afterEach(() => {
  vi.useRealTimers();
  els.clear();
  stableEls.clear();
  // hasVisibleSuggestion falls back to querying <document> when the field's
  // aria-controls root is absent, so a [role=option] left behind by an earlier
  // case would be "visible" for the next one. Reset the body so each settle
  // test sees a clean document.
  document.body.innerHTML = '';
});

function visibleOption() {
  const opt = document.createElement('li');
  opt.setAttribute('role', 'option');
  // jsdom reports zero rects, so pretend this suggestion has a visible box.
  (opt as any).getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
  document.body.appendChild(opt);
  return opt;
}

describe('Issue #119 - settle windows', () => {
  it('settles a plain CLICK in ~50ms, not 120ms', async () => {
    vi.useFakeTimers();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    els.set(41, btn);

    const p = execute({ type: 'CLICK', targetId: 41 });
    let done = false;
    p.then(() => (done = true));
    // Not settled at 40ms...
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    // ...but settled by 60ms (the 50ms settle).
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(done).toBe(true);
  });

  it('a TYPE into a NON-combobox field settles in ~50ms', async () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    els.set(42, input);

    const p = execute({ type: 'TYPE', targetId: 42, value: 'abc' });
    let done = false;
    p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(done).toBe(true);
    expect(input.value).toBe('abc');
  });

  it('a TYPE into a combobox polls for the suggestion list (>= one 20ms tick past a non-appearing list)', async () => {
    // No fake timers here: the poll loop is bounded by Date.now() and we
    // want to prove it waits ~200ms when no suggestion ever becomes visible.
    const input = document.createElement('input');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'no-list');
    const emptyList = document.createElement('ul');
    emptyList.id = 'no-list';
    document.body.appendChild(input);
    document.body.appendChild(emptyList);
    els.set(43, input);

    const t0 = performance.now();
    const result = await execute({ type: 'TYPE', targetId: 43, value: 'go' });
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    // It should have polled the 200ms cap (not the 50ms plain settle).
    expect(elapsed).toBeGreaterThanOrEqual(190);
    // And it must not run away beyond the cap + margin.
    expect(elapsed).toBeLessThan(400);
  });

  it('a TYPE into a combobox returns early when the suggestion list is already visible', async () => {
    const input = document.createElement('input');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'list');
    const list = document.createElement('ul');
    list.id = 'list';
    document.body.appendChild(input);
    document.body.appendChild(list);
    list.appendChild(visibleOption()); // suggestion present + visible up front
    els.set(44, input);

    const t0 = performance.now();
    const result = await execute({ type: 'TYPE', targetId: 44, value: 'a' });
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    // Visible on first poll: no need to wait out the cap.
    expect(elapsed).toBeLessThan(190);
  });

  it('resolves a combobox via STABLE ID and still polls for suggestions (review gap #2)', async () => {
    // settleFor's lookup branches on the target's type: a string targetId goes
    // through getElementByStableId, not getElementById. Register the combobox
    // under its stable id and assert the poll still runs to the cap when no
    // suggestion ever appears - proving the stable-id branch reaches the same
    // combobox settle path as the numeric one.
    const input = document.createElement('input');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', 'stable-list');
    const emptyList = document.createElement('ul');
    emptyList.id = 'stable-list';
    document.body.appendChild(input);
    document.body.appendChild(emptyList);
    stableEls.set('input|query|textbox|search', input);

    const t0 = performance.now();
    const result = await execute({
      type: 'TYPE',
      targetId: 'input|query|textbox|search',
      value: 'q',
    });
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    expect(input.value).toBe('q');
    // If the stable-id branch had silently fallen through to the plain 50ms
    // settle, this would be well under the 190ms combobox floor.
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(400);
  });
});
