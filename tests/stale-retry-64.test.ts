/**
 * Issue #64 - executeWithResilience / executeWithRetry must NOT blind-retry
 * a stale / not-found element. When the target is gone from the DOM the loop
 * should stop and flag `stale` so the planner re-extracts (re-registers the
 * elements) instead of re-acting on a dead id for the full backoff.
 *
 * Registry behaviour (src/lib/dom mock):
 *   - id 7        -> a live, connected <button>  -> doType throws a
 *                  TRANSIENT "cannot TYPE into <button>" (element exists,
 *                  just the wrong kind) -> NOT stale.
 *   - any other id -> absent -> resolve() throws "not found" -> STALE.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  execute,
  executeWithResilience,
  executeWithRetry,
} from '../src/lib/actions';

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) => (id === 7 ? getLiveButton() : undefined),
  getElementByStableId: (_id: string) => undefined,
  // #118: no guards captured -> resolve() skips the freshness check.
  getGuardForId: () => undefined,
  getGuardForStableId: () => undefined,
  verifyElementFreshness: () => true,
}));

function getLiveButton(): HTMLElement {
  const g = globalThis as unknown as { __liveBtn?: HTMLElement };
  if (!g.__liveBtn) {
    const b = document.createElement('button');
    document.body.appendChild(b);
    g.__liveBtn = b;
  }
  return g.__liveBtn;
}

describe('Issue #64 - stale element short-circuit', () => {
  it('execute() flags a not-found target as stale', async () => {
    const result = await execute({ type: 'CLICK', targetId: 999 });
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.error ?? '').toMatch(/not found/i);
  });

  it('executeWithResilience stops after the first stale failure (no 3x backoff)', async () => {
    const result = await executeWithResilience({ type: 'CLICK', targetId: 999 }, 3);
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    // The loop must break on the first stale result: no 200+400ms backoff,
    // so a single transient execute() is all that runs.
    expect(result.durationMs ?? 0).toBeLessThan(1000);
  });

  it('executeWithRetry returns immediately on a stale target', async () => {
    const result = await executeWithRetry({ type: 'TYPE', targetId: 999, value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    // No 400ms retry delay + second attempt was incurred.
    expect(result.durationMs ?? 0).toBeLessThan(1000);
  });

  it('a transient (wrong-element-type) failure is NOT flagged stale', async () => {
    // id 7 is a live <button> -> doType throws "cannot TYPE into <button>",
    // a transient error the retry loop is allowed to keep working on.
    const result = await execute({ type: 'TYPE', targetId: 7, value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/cannot type/i);
    expect(result.stale).toBe(false);
  });
});
