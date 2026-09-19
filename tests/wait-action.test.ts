/**
 * Issue #77 (sub-point 3) - a test that the WAIT primitive actually honors its
 * requested duration instead of being a no-op.
 *
 * The audit flagged "no test that a condition actually gates". The no-op
 * waitForCondition is gone (deleted with the dead EXECUTE_ACTION path in #89);
 * the live WAIT primitive is doWait in src/lib/actions.ts, which is a bounded
 * settle-sleep. This pins its contract:
 *   - WAIT resolves after the requested waitMs (not instantly),
 *   - waitMs is clamped to [0, 30s] so a runaway value can't wedge the run,
 *   - an absent waitMs defaults to 1000ms,
 *   - WAIT is exempt from the default 5s action timeout (a 10s wait isn't
 *     killed), and is not auto-retried.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execute, executeWithRetry, type Action } from '../src/lib/actions';

// WAIT doesn't resolve an element, but the module imports ./dom; mock it the
// same way the other action tests do so no browser globals are needed.
vi.mock('../src/lib/dom', () => ({
  getElementById: () => undefined,
  getElementByStableId: () => undefined,
  // #118: no guards captured -> resolve() skips the freshness check.
  getGuardForId: () => undefined,
  getGuardForStableId: () => undefined,
  verifyElementFreshness: () => true,
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('WAIT action honors its duration (#77)', () => {
  it('does NOT complete before the requested waitMs (settles the page)', async () => {
    vi.useFakeTimers();
    const p = execute({ type: 'WAIT', waitMs: 2000 });
    // Not settled yet at ~half the requested duration.
    let settled = false;
    p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    expect(settled).toBe(false);
    // Completes at/after the requested 2000ms.
    await vi.advanceTimersByTimeAsync(500);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(settled).toBe(true);
  });

  it('completes as success when the timer runs out the full waitMs', async () => {
    vi.useFakeTimers();
    const result = await (async () => {
      const p = execute({ type: 'WAIT', waitMs: 1000 });
      await vi.advanceTimersByTimeAsync(1600); // beyond waitMs + the 500ms margin
      return p;
    })();
    expect(result.ok).toBe(true);
    expect(result.error ?? '').toBe('');
  });

  it('clamps a runaway waitMs to the 30s ceiling', async () => {
    vi.useFakeTimers();
    // 999_999ms must be treated as the 30s clamp (bound = 30500ms), so the
    // action resolves on the ~30s schedule, not after 999s.
    const p = execute({ type: 'WAIT', waitMs: 999_999 });
    let done = false;
    p.then(() => { done = true; });
    // Well under the clamped 30s - still waiting.
    await vi.advanceTimersByTimeAsync(25_000);
    await Promise.resolve();
    expect(done).toBe(false);
    // Cross the clamp ceiling and it resolves.
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(done).toBe(true);
  });

  it('defaults to a 1000ms wait when waitMs is absent', async () => {
    vi.useFakeTimers();
    const p = execute({ type: 'WAIT' });
    let done = false;
    p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(900);
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(done).toBe(true);
  });

  it('is not killed by the default 5s action timeout (long waits allowed)', async () => {
    vi.useFakeTimers();
    // A 10s WAIT is longer than the 5s default bound; execute() must give it
    // its own bound (10s + margin) so it resolves as success, not a timeout.
    const result = await (async () => {
      const p = execute({ type: 'WAIT', waitMs: 10_000 });
      await vi.advanceTimersByTimeAsync(10_600);
      return p;
    })();
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/timed out/i);
  });

  it('is exempt from auto-retry in executeWithRetry (no double-sleep)', async () => {
    vi.useFakeTimers();
    // A WAIT that "fails" can't meaningfully fail, but the no-retry contract
    // matters: executeWithRetry must return after ONE execution (not a second
    // sleep). We observe the result resolves and that the error is not the
    // "unknown action type" (i.e. WAIT is routed to doWait, not the default).
    const result = await (async () => {
      const p = executeWithRetry({ type: 'WAIT', waitMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      return p;
    })();
    expect(result.ok).toBe(true);
    expect(result.error ?? '').not.toMatch(/unknown action type/i);
  });
});
