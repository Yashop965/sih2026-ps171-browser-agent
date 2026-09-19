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

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) => els.get(id),
  getElementByStableId: (_id: string) => undefined,
}));

afterEach(() => {
  vi.useRealTimers();
  els.clear();
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
});
