/**
 * Issue #76 - the "loop-detection" test used to build a local mock array and
 * assert on it, so it could pass forever no matter what the shipping code
 * did. The real loop-detection now lives in src/lib/loopDetection.ts
 * (delegated to by the SW agent loop in src/lib/agentRunner.ts). This file
 * tests THAT module directly:
 *   - isRepeatedAction  -> duplicate planned action on the same element
 *   - ScrollGuard       -> a "scroll storm" (no progress) is stopped
 *   - calculateMaxSteps -> the shared step budget (test and loop can't drift)
 */
import { describe, it, expect } from 'vitest';
import {
  isRepeatedAction,
  ScrollGuard,
  calculateMaxSteps,
} from '../src/lib/loopDetection';

describe('isRepeatedAction (the real loop-detect)', () => {
  it('flags a back-to-back same (targetId, type) as a loop', () => {
    const recent = [{ targetId: '7', type: 'CLICK' }];
    expect(isRepeatedAction(recent, { type: 'CLICK', targetId: 7 })).toBe(true);
    // Numeric id vs string target in history - still the same element.
    expect(isRepeatedAction(recent, { type: 'CLICK', targetId: '7' })).toBe(true);
  });

  it('does NOT flag a different element or a different action type', () => {
    const recent = [{ targetId: '7', type: 'CLICK' }];
    expect(isRepeatedAction(recent, { type: 'CLICK', targetId: 8 })).toBe(false);
    expect(isRepeatedAction(recent, { type: 'TYPE', targetId: 7 })).toBe(false);
  });

  it('ignores actions with no element target (SCROLL / NAVIGATE / WAIT / DONE)', () => {
    const recent = [{ targetId: 'scroll', type: 'SCROLL' }];
    // A targetless action cannot be a "repeated same element" loop; its guard
    // is the ScrollGuard / step budget, not isRepeatedAction.
    expect(isRepeatedAction(recent, { type: 'SCROLL' })).toBe(false);
    expect(isRepeatedAction(recent, { type: 'NAVIGATE', url: 'x' })).toBe(false);
  });

  it('is false when there is no history yet', () => {
    expect(isRepeatedAction([], { type: 'CLICK', targetId: 1 })).toBe(false);
  });

  it('compares only the most recent action', () => {
    const recent = [
      { targetId: '1', type: 'TYPE' },
      { targetId: '2', type: 'CLICK' },
    ];
    expect(isRepeatedAction(recent, { type: 'CLICK', targetId: 2 })).toBe(true);
    expect(isRepeatedAction(recent, { type: 'TYPE', targetId: 1 })).toBe(false);
  });

  it('VALUE-AWARE: re-typing a NEW value into the same box is NOT a loop', () => {
    // The Wikipedia two-search case: TYPE "Web browser" into the search box,
    // then TYPE "Progressive web app" into the SAME box. Different value =>
    // real progress, must not be skipped.
    const recent = [{ targetId: '2', type: 'TYPE', value: 'Web browser' }];
    expect(isRepeatedAction(recent, { type: 'TYPE', targetId: 2, value: 'Progressive web app' })).toBe(false);
  });

  it('VALUE-AWARE: re-typing the SAME value into the same box IS a loop', () => {
    const recent = [{ targetId: '2', type: 'TYPE', value: 'Web browser' }];
    expect(isRepeatedAction(recent, { type: 'TYPE', targetId: 2, value: 'Web browser' })).toBe(true);
  });

  it('VALUE-AWARE: SELECT honors the same value-aware rule', () => {
    const recent = [{ targetId: '9', type: 'SELECT', value: 'Option A' }];
    expect(isRepeatedAction(recent, { type: 'SELECT', targetId: 9, value: 'Option B' })).toBe(false);
    expect(isRepeatedAction(recent, { type: 'SELECT', targetId: 9, value: 'Option A' })).toBe(true);
  });
});

describe('ScrollGuard (stops a scroll storm)', () => {
  it('allows up to the threshold of consecutive scrolls, then blocks', () => {
    const guard = new ScrollGuard(3);
    expect(guard.nextScroll()).toEqual({ allowed: true, consecutive: 1 });
    expect(guard.nextScroll()).toEqual({ allowed: true, consecutive: 2 });
    expect(guard.nextScroll()).toEqual({ allowed: true, consecutive: 3 });
    // 4th consecutive scroll is a storm - blocked.
    const fourth = guard.nextScroll();
    expect(fourth.allowed).toBe(false);
    expect(fourth.consecutive).toBe(4);
  });

  it('a non-scroll action resets the counter', () => {
    const guard = new ScrollGuard(3);
    guard.nextScroll();
    guard.nextScroll();
    guard.noteOtherAction(); // user/planner did something else
    // After the reset, three more consecutive scrolls are again allowed.
    expect(guard.nextScroll()).toEqual({ allowed: true, consecutive: 1 });
  });

  it('respects a custom threshold', () => {
    const guard = new ScrollGuard(1);
    expect(guard.nextScroll().allowed).toBe(true);
    expect(guard.nextScroll().allowed).toBe(false);
  });

  it('exposes the running count', () => {
    const guard = new ScrollGuard(5);
    expect(guard.count).toBe(0);
    guard.nextScroll();
    guard.nextScroll();
    expect(guard.count).toBe(2);
    guard.noteOtherAction();
    expect(guard.count).toBe(0);
  });
});

describe('calculateMaxSteps (shared budget the loop and test both use)', () => {
  it('is generous for a small form', () => {
    // 3 inputs, 0 selects, 1 button -> max(20, 3*3+1+10) = 20
    expect(calculateMaxSteps(3, 0, 1)).toBe(20);
  });

  it('scales with field count', () => {
    // 10 inputs, 2 selects, 3 buttons -> totalFields=12; 12*3 + 3 + 10 = 49
    expect(calculateMaxSteps(10, 2, 3)).toBe(49);
  });

  it('caps at 100 for huge forms', () => {
    expect(calculateMaxSteps(50, 10, 5)).toBe(100);
  });
});
