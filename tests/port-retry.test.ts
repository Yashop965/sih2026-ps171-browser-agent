/**
 * Tests for src/lib/portRetry.ts - the transient "content port not up yet"
 * retry used by the service-worker's EXTRACT channel.
 *
 * After a navigating action the content script re-injects, and for a few
 * hundred ms `tabs.sendMessage` either throws "Receiving end does not exist"
 * or resolves undefined. withPortRetry must keep trying through those
 * transients and give up (non-transiently) on genuine errors.
 */
import { describe, it, expect } from 'vitest';
import {
  withPortRetry,
  isPortNotReady,
  PORT_NOT_READY,
} from '../src/lib/portRetry';

// No real sleeping in tests: count delays instead.
function makeClock(delays: number[] = [0, 0, 0]) {
  let i = 0;
  return {
    sleep: async (ms: number) => { delays[i++] = ms; },
    delays,
  };
}

describe('isPortNotReady', () => {
  it('matches the transient port-dropped messages', () => {
    expect(isPortNotReady('Receiving end does not exist.')).toBe(true);
    expect(isPortNotReady(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
    expect(PORT_NOT_READY.test('No recipient for message')).toBe(true);
  });

  it('does not match genuine errors', () => {
    expect(isPortNotReady('No web tab found')).toBe(false);
    expect(isPortNotReady('invalid url')).toBe(false);
  });
});

describe('withPortRetry', () => {
  it('returns the value on the first successful call', async () => {
    const r = await withPortRetry(async () => ({ hello: 1 }), (v) => v === undefined, { sleep: () => Promise.resolve() });
    expect(r.ok).toBe(true);
    expect((r as any).value).toEqual({ hello: 1 });
  });

  it('retries through transient thrown port errors, then succeeds', async () => {
    let calls = 0;
    const clock = makeClock([400, 400, 400]);
    const r = await withPortRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Receiving end does not exist.');
        return { n: 42 };
      },
      (v) => v === undefined,
      { ...clock },
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    expect(clock.delays.slice(0, 2)).toEqual([400, 400]);
  });

  it('retries through "no listener yet" (undefined) resolutions, then succeeds', async () => {
    let calls = 0;
    const r = await withPortRetry(
      async () => {
        calls++;
        return calls < 2 ? undefined : { ok: true };
      },
      (v) => v === undefined,
      { sleep: () => Promise.resolve() },
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('reports transient no-snapshot after exhausting attempts', async () => {
    let calls = 0;
    const r = await withPortRetry(
      async () => { calls++; return undefined; },
      (v) => v === undefined,
      { attempts: 3, sleep: () => Promise.resolve() },
    );
    expect(r.ok).toBe(false);
    expect((r as any).transient).toBe(true);
    expect((r as any).error).toBe('No snapshot');
    expect(calls).toBe(3);
  });

  it('does NOT retry a genuine (non-port) error - returns immediately', async () => {
    let calls = 0;
    const r = await withPortRetry(
      async () => {
        calls++;
        throw new Error('No web tab found');
      },
      (v) => v === undefined,
      { sleep: () => Promise.resolve() },
    );
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe('No web tab found');
    expect((r as any).transient).toBe(false);
    expect(calls).toBe(1); // not retried
  });

  it('honors a custom delay + attempts budget', async () => {
    const clock = makeClock([7, 7, 7, 7]);
    let calls = 0;
    const r = await withPortRetry(
      async () => { calls++; return undefined; },
      (v) => v === undefined,
      { attempts: 4, delayMs: 7, sleep: (ms) => clock.sleep(ms) },
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(4);
    expect(clock.delays.slice(0, 3)).toEqual([7, 7, 7]); // 3 retries, not after last
  });
});
