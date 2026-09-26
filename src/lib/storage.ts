/**
 * Typed access to `browser.storage.local` (issue #175).
 *
 * Why this exists: five modules each hand-rolled their own `storage.local.get`
 * / `.set` call, their own key name and their own error handling. In a privacy
 * project that matters twice - it is hard to answer "what persists, and where?",
 * and it is easy for one call site to skip the try/catch its neighbour has.
 *
 * It deliberately does NOT serialise.
 *
 * `browser.storage.local` is a structured-clone store: every existing call
 * site writes a live value (`{ [K]: entries }`, `{ [K]: profile }`) and reads
 * it back already-parsed. A JSON round-trip here would be a behaviour change,
 * not a refactor - it would hand callers a *string* where they expect an
 * object, and would fail on anything structured-clone handles but JSON does
 * not (Date, Map, undefined-as-value). So this wrapper is a thin, typed,
 * uniformly best-effort passthrough over exactly what the code did before.
 *
 * It also does not rename any key. `task`, `startUrl`, `providerKey` and
 * `apiKey` in the popup predate the `sih_` convention; renaming them would
 * silently drop real users' stored data. They are registered under their real
 * names so the inventory is honest, and left alone.
 */

import { browser } from 'wxt/browser';

/**
 * Every persisted key, in one place.
 *
 * `sih_` is the project convention. The rest are pre-existing keys that must
 * keep their current names to avoid data loss.
 */
export const STORAGE_KEYS = {
  // Ledgers (issue #72) - survive service-worker death.
  privacyLedger: 'sih_privacy_ledger',
  auditLedger: 'sih_audit_ledger',
  // SW-owned task state.
  taskState: 'sih_agent_task_state',
  // Popup.
  recentTasks: 'sih_recent_tasks',
  task: 'task',
  startUrl: 'startUrl',
  providerKey: 'providerKey',
  apiKey: 'apiKey',
  // Libraries.
  userProfile: 'sih_user_profile',
  outboundAllowlist: 'sih_outbound_allowlist',
  // context.ts session/profile/autofill records, keyed by bare sub-key.
  // These must match context.ts's literals EXACTLY - `autoFillPatterns` has a
  // capital F. It is verified by a test that greps the real call sites, because
  // a registry that quietly disagrees with the code it documents is worse than
  // no registry at all.
  contextProfile: 'profile',
  contextAutofill: 'autoFillPatterns',
  contextSessions: 'activeSessions',
  contextLastSession: 'lastSessionId',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Read one key.
 *
 * Returns `fallback` for a missing key or a storage failure. The value is
 * returned as stored (no parsing) - callers already expect the live object.
 * Never throws: a storage fault must not take down the caller.
 */
export async function storageGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const snap = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const v = snap?.[key];
    return v === undefined || v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/**
 * Read several keys in one call, each with its own fallback.
 *
 * Stands in for the `get([A, B, ...])` sites; keys absent from storage come
 * back as their fallback rather than `undefined`, so a caller can read `task`
 * and `startUrl` without five null checks.
 */
export async function storageGetMany<T extends Record<string, unknown>>(defaults: T): Promise<T> {
  const keys = Object.keys(defaults);
  if (!keys.length) return { ...defaults };
  try {
    const snap = (await browser.storage.local.get(keys)) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...defaults };
    for (const k of keys) {
      const v = snap?.[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out as T;
  } catch {
    return { ...defaults };
  }
}

/** Write one key. Best-effort: a write failure is never worth crashing on. */
export async function storageSet(key: string, value: unknown): Promise<void> {
  try {
    await browser.storage.local.set({ [key]: value });
  } catch {
    /* durability is best-effort; never block the live loop */
  }
}

/** Write several keys in one call. Best-effort, as `storageSet`. */
export async function storageSetMany(values: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage.local.set(values);
  } catch {
    /* best-effort */
  }
}

/** Delete one or more keys. Best-effort, as `storageSet`. */
export async function storageRemove(keys: string | string[]): Promise<void> {
  try {
    await browser.storage.local.remove(keys);
  } catch {
    /* best-effort */
  }
}
