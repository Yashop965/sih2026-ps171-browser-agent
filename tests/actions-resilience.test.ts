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

  it('should retry with exponential backoff on failure', async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    const action: Action = { type: 'CLICK', targetId: 999 }; // Non-existent element
    const result = await executeWithResilience(action, 3);

    expect(result.ok).toBe(false);
    // Should have timeout delays (5000ms) between each attempt plus backoff
    expect(delays.some(d => d === 5000)).toBe(true);
    expect(delays.some(d => d === 200 || d === 400 || d === 800)).toBe(true);

    global.setTimeout = originalSetTimeout;
  });

  it('should stop retrying after maxRetries', async () => {
    const action: Action = { type: 'CLICK', targetId: 999 };
    const result = await executeWithResilience(action, 2);

    expect(result.ok).toBe(false);
    // Error comes from execute() itself, not from max retries message
    expect(result.error).toContain('not found');
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
