/**
 * The storage wrapper (#175) must be a behaviour-preserving passthrough, not a
 * new policy. These tests pin the three things that could silently break every
 * persisted value if the wrapper were "improved":
 *
 *  1. NO serialisation. `browser.storage.local` is a structured-clone store;
 *     every pre-existing call site stored live objects. A JSON round-trip would
 *     hand callers a string where they expect an object.
 *  2. Missing key -> the caller's fallback, never `undefined`.
 *  3. A storage fault must not throw. Durability is best-effort by design.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, unknown>();
let failNext = false;

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          if (failNext) throw new Error('storage unavailable');
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          if (failNext) throw new Error('storage unavailable');
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          if (failNext) throw new Error('storage unavailable');
          for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
        }),
      },
    },
  },
}));

import {
  storageGet,
  storageGetMany,
  storageSet,
  storageSetMany,
  storageRemove,
  STORAGE_KEYS,
} from '../src/lib/storage';

beforeEach(() => {
  store.clear();
  failNext = false;
  vi.clearAllMocks();
});

describe('storageGet', () => {
  it('returns the stored value AS STORED - no JSON round-trip', async () => {
    const ledger = [{ id: 1, kind: 'redacted', at: new Date(1700000000000) }];
    await storageSet('k', ledger);

    const back = await storageGet<typeof ledger>('k', []);
    expect(back).toEqual(ledger);
    // A real Date survives; a JSON round-trip would have made it a string.
    expect(back[0].at).toBeInstanceOf(Date);
    expect(typeof back[0].at).not.toBe('string');
  });

  it('returns the fallback for a missing key', async () => {
    expect(await storageGet('nope', 'fallback')).toBe('fallback');
  });

  it('returns the fallback for an explicitly-undefined stored value', async () => {
    await storageSet('u', undefined);
    expect(await storageGet('u', 'fallback')).toBe('fallback');
  });

  it('never throws when storage rejects - returns the fallback', async () => {
    failNext = true;
    await expect(storageGet('k', 'safe')).resolves.toBe('safe');
  });
});

describe('storageGetMany', () => {
  it('fills present keys and falls back for absent ones, in one call', async () => {
    await storageSet('a', 1);
    const out = await storageGetMany({ a: 0, b: 99, c: 'zz' });
    expect(out).toEqual({ a: 1, b: 99, c: 'zz' });
  });

  it('preserves falsy stored values (0, "", false) rather than replacing them', async () => {
    await storageSet('zero', 0);
    await storageSet('empty', '');
    await storageSet('no', false);
    const out = await storageGetMany<Record<string, unknown>>({ zero: 1, empty: 'x', no: true });
    expect(out).toEqual({ zero: 0, empty: '', no: false });
  });

  it('returns all fallbacks on a storage fault', async () => {
    failNext = true;
    await expect(storageGetMany({ a: 1, b: 2 })).resolves.toEqual({ a: 1, b: 2 });
  });

  it('does not call storage at all for an empty request', async () => {
    const { browser } = await import('wxt/browser');
    await storageGetMany({});
    expect(browser.storage.local.get).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('storageSet writes one key and swallows failures', async () => {
    await storageSet('x', { n: 1 });
    expect(store.get('x')).toEqual({ n: 1 });
    failNext = true;
    await expect(storageSet('y', 1)).resolves.toBeUndefined();
  });

  it('storageSetMany writes several keys in one call', async () => {
    const { browser } = await import('wxt/browser');
    await storageSetMany({ p: 'a', q: 'b' });
    expect(store.get('p')).toBe('a');
    expect(store.get('q')).toBe('b');
    expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('storageRemove deletes a single key and an array of keys', async () => {
    await storageSetMany({ r: 1, s: 2 });
    await storageRemove('r');
    expect(store.has('r')).toBe(false);
    await storageRemove(['s']);
    expect(store.has('s')).toBe(false);
  });
});

describe('STORAGE_KEYS', () => {
  it('keeps the pre-existing non-sih_ popup keys under their real names', async () => {
    // Renaming these would silently drop real users' stored data, which is why
    // they are registered rather than normalised.
    expect(STORAGE_KEYS.task).toBe('task');
    expect(STORAGE_KEYS.startUrl).toBe('startUrl');
    expect(STORAGE_KEYS.providerKey).toBe('providerKey');
    expect(STORAGE_KEYS.apiKey).toBe('apiKey');
  });

  it('keeps every sih_ key identical to the name it had before the wrapper', () => {
    expect(STORAGE_KEYS.privacyLedger).toBe('sih_privacy_ledger');
    expect(STORAGE_KEYS.auditLedger).toBe('sih_audit_ledger');
    expect(STORAGE_KEYS.taskState).toBe('sih_agent_task_state');
    expect(STORAGE_KEYS.recentTasks).toBe('sih_recent_tasks');
    expect(STORAGE_KEYS.userProfile).toBe('sih_user_profile');
    expect(STORAGE_KEYS.outboundAllowlist).toBe('sih_outbound_allowlist');
  });

  it('has no duplicate key VALUES', () => {
    const vals = Object.values(STORAGE_KEYS);
    expect(new Set(vals).size).toBe(vals.length);
  });
});
