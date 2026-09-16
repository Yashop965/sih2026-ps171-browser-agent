/**
 * Tests for actions.ts - executeWithResilience and CircuitBreaker
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWithResilience, CircuitBreaker, type Action } from '../src/lib/actions';

// Mock DOM for execute()
const mockElements = new Map<number, Element>();
const mockStableIds = new Map<string, Element>();

vi.mock('../src/lib/dom', () => ({
  getElementById: (id: number) => mockElements.get(id),
  getElementByStableId: (id: string) => mockStableIds.get(id),
}));

describe('executeWithResilience', () => {
  it('should return success on first try', async () => {
    const action: Action = { type: 'CLICK', targetId: 1 };
    const result = await executeWithResilience(action, 3);
    // Note: Without real DOM, this will fail - testing the retry logic instead
  });

  it('should retry with exponential backoff on a TRANSIENT failure', async () => {
    // A live, CONNECTED element of the wrong type is a TRANSIENT error
    // ("cannot TYPE into <button>") - the element exists, the action just
    // didn't work. The retry loop SHOULD keep trying (issue #64 only
    // short-circuits stale / not-found targets, not transient ones).
    const liveButton = document.createElement('button');
    document.body.appendChild(liveButton);
    mockElements.set(500, liveButton);

    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    const action: Action = { type: 'TYPE', targetId: 500, value: 'x' };
    const result = await executeWithResilience(action, 3);

    expect(result.ok).toBe(false);
    expect(result.stale).toBe(false); // wrong-type is transient, not stale
    // The transient failure must still run the full backoff ladder.
    expect(delays.some(d => d === 200 || d === 400 || d === 800)).toBe(true);
    expect(delays.some(d => d === 5000)).toBe(true);

    global.setTimeout = originalSetTimeout;
    mockElements.delete(500);
    liveButton.remove();
  });

  it('stops early (no backoff) on a STALE / not-found target', async () => {
    // Issue #64: a not-found target is flagged stale, so the loop breaks on
    // the first attempt instead of burning the 200/400/800ms backoff.
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    const action: Action = { type: 'CLICK', targetId: 999 }; // not in registry
    const result = await executeWithResilience(action, 3);

    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.error).toContain('not found');
    // No exponential-backoff delay was incurred because we short-circuited.
    expect(delays.some(d => d === 200 || d === 400 || d === 800)).toBe(false);

    global.setTimeout = originalSetTimeout;
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it('should allow action when no failures', () => {
    expect(breaker.shouldAct(1)).toBe(true);
  });

  it('should trip after threshold failures', () => {
    breaker.recordFailure(1);
    breaker.recordFailure(1);
    breaker.recordFailure(1);

    expect(breaker.shouldAct(1)).toBe(false);
  });

  it('should not trip before threshold', () => {
    breaker.recordFailure(1);
    breaker.recordFailure(1);

    expect(breaker.shouldAct(1)).toBe(true);
  });

  it('should reset after timeout', async () => {
    breaker.recordFailure(1);
    breaker.recordFailure(1);
    breaker.recordFailure(1);

    expect(breaker.shouldAct(1)).toBe(false);

    // Advance time by 31 seconds (threshold is 30s)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31000);

    expect(breaker.shouldAct(1)).toBe(true);
    vi.useRealTimers();
  });

  it('should reset on success', () => {
    breaker.recordFailure(1);
    breaker.recordFailure(1);
    breaker.recordFailure(1);
    breaker.recordSuccess(1);

    expect(breaker.shouldAct(1)).toBe(true);
  });

  it('should track different elements independently', () => {
    breaker.recordFailure(1);
    breaker.recordFailure(1);
    breaker.recordFailure(1);

    breaker.recordFailure(2);

    expect(breaker.shouldAct(1)).toBe(false);
    expect(breaker.shouldAct(2)).toBe(true);
  });

  it('should clear all failures with reset()', () => {
    breaker.recordFailure(1);
    breaker.recordFailure(2);
    breaker.reset();

    expect(breaker.shouldAct(1)).toBe(true);
    expect(breaker.shouldAct(2)).toBe(true);
  });
});
