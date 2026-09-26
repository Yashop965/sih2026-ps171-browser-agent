/**
 * Outbound-domain allowlist — issue #143 (P2 outbound-send gate).
 *
 * A small, user-maintained list of DOMAINS the agent is allowed to drive
 * outbound sends on (e.g. `web.whatsapp.com`). It is the opt-in switch for
 * the gate: with an EMPTY allowlist the gate is fully off and behaviour is
 * byte-identical to pre-P2 (no domain is ever "outbound"). Stored on-device
 * in `browser.storage.local` — never egressed, never sent to the planner.
 */

/** Storage key (browser.storage.local) — matches the sih_* convention. */
export const OUTBOUND_STORAGE_KEY = 'sih_outbound_allowlist';

/** Pure: normalise a raw list into trimmed, lower-cased, de-duped domains. */
export function normalizeDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const d = item
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '');
    if (!d) continue;
    const host = d.split('/')[0];
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/**
 * Read the allowlist from `browser.storage.local`. Returns [] when no
 * browser / no value (tests and SSR) — gate off. Never throws.
 */
export async function loadOutboundAllowlist(): Promise<string[]> {
  try {
    const { storageGet } = await import('./storage');
    return normalizeDomains(await storageGet<unknown>(OUTBOUND_STORAGE_KEY, null));
  } catch {
    return [];
  }
}

/** Persist the allowlist to `browser.storage.local` (on-device only). */
export async function saveOutboundAllowlist(domains: string[]): Promise<void> {
  const { storageSet } = await import('./storage');
  await storageSet(OUTBOUND_STORAGE_KEY, normalizeDomains(domains));
}
