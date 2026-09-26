/**
 * Local User Profile — issue #102.
 *
 * A small, user-maintained set of personal constants (name, email, phone,
 * address, ...) the agent can reference when a task says "fill my email".
 * Everything is stored on-device in `browser.storage.local` and NEVER
 * egressed raw. Instead:
 *   - outbound /plan payloads carry only the KEY -> stable-TOKEN map
 *     (`email -> <EMAIL>`), so the planner LLM knows *which* field without
 *     ever seeing the raw value;
 *   - any raw value the user pastes into the task string is masked to its
 *     token BEFORE the general PII redactor runs;
 *   - the executor resolves the token back to the real value ON-DEVICE only
 *     when it is about to fill the field.
 *
 * The pure core (masking / token map / resolution) is DOM- and browser-free
 * so it is unit-testable in Node/jsdom. The storage helpers are thin and
 * guarded so importing this file in a non-browser context is safe.
 */

export type ProfileKey = 'name' | 'email' | 'phone' | 'address' | 'company' | 'city' | 'notes';

export type UserProfile = Partial<Record<ProfileKey, string>>;

/** Storage key (browser.storage.local) — matches the sih_* convention. */
export const PROFILE_STORAGE_KEY = 'sih_user_profile';

/**
 * Stable, non-reversible tokens. The LLM sees only the token; the executor
 * maps it back to the real value on-device. Deliberately opaque (no prefix
 * that leaks the value shape beyond the category).
 */
export const PROFILE_TOKENS: Record<ProfileKey, string> = {
  name: '<NAME>',
  email: '<EMAIL>',
  phone: '<PHONE>',
  address: '<ADDRESS>',
  company: '<COMPANY>',
  city: '<CITY>',
  notes: '<NOTES>',
};

const TOKEN_TO_KEY: Record<string, ProfileKey> = Object.fromEntries(
  (Object.keys(PROFILE_TOKENS) as ProfileKey[]).map((k) => [PROFILE_TOKENS[k], k])
) as Record<string, ProfileKey>;

export function profileToken(key: ProfileKey): string {
  return PROFILE_TOKENS[key];
}

export function keyForToken(token: string): ProfileKey | undefined {
  return TOKEN_TO_KEY[token];
}

/**
 * Replace any raw profile value that appears in `text` with its stable
 * token. Longest values are replaced first so a longer value that contains
 * a shorter one wins (e.g. full address over city). Values shorter than 3
 * chars are skipped (too common a string to safely treat as a personal
 * constant — e.g. a 2-letter "city").
 *
 * Pure + idempotent: re-running on already-masked text is a no-op because
 * the raw value is gone and the token isn't a value we replace.
 */
export function maskProfileValues(text: string, profile: UserProfile): string {
  if (!text) return text;
  const entries = (Object.keys(profile) as ProfileKey[])
    .filter((k) => (profile[k] ?? '').length >= 3)
    .map((k) => ({ value: profile[k] as string, token: PROFILE_TOKENS[k] }))
    .sort((a, b) => b.value.length - a.value.length);

  let out = text;
  for (const { value, token } of entries) {
    if (!value) continue;
    // Escape regex special chars in the value (addresses have spaces/dashes,
    // emails have dots, etc.).
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-boundary on both ends so a value is not clobbered inside a longer
    // word; a boundary is asserted against non-word chars on either side.
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), token);
  }
  return out;
}

/**
 * The token-only map safe to send to the planner. This is the ONLY profile
 * content that may cross to /plan — keys + tokens, never raw values.
 * Empty values are omitted (the LLM shouldn't see a `<CITY>` it can't use).
 */
export function profileHintsForPayload(profile: UserProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(profile) as ProfileKey[]) {
    const v = profile[key];
    if (v && v.trim()) out[key] = PROFILE_TOKENS[key];
  }
  return out;
}

/**
 * Resolve a planner action value back to the real on-device constant.
 * Returns the value UNCHANGED when it is not a profile token (so normal
 * agent-typed values pass through untouched). `undefined` when the token is
 * known but the user has no value stored for it (caller should fall back).
 */
export function resolveProfileValue(
  actionValue: string | undefined,
  profile: UserProfile
): string | undefined {
  if (typeof actionValue !== 'string') return undefined;
  const key = keyForToken(actionValue.trim());
  if (!key) return undefined;
  return profile[key];
}

/** Does this value (post-planner) reference the profile at all? */
export function isProfileToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim() in TOKEN_TO_KEY;
}

// ── On-device persistence (thin; safe to import in non-browser contexts) ──

/**
 * Read the profile from `browser.storage.local`. Returns an empty object
 * when no browser / no value (tests and SSR). Never throws.
 */
export async function loadProfile(): Promise<UserProfile> {
  try {
    const { storageGet } = await import('./storage');
    const v = await storageGet<unknown>(PROFILE_STORAGE_KEY, null);
    if (v && typeof v === 'object') {
      // Keep only known keys, coerce to string.
      const clean: UserProfile = {};
      for (const k of Object.keys(PROFILE_TOKENS) as ProfileKey[]) {
        if (typeof (v as Record<string, unknown>)[k] === 'string')
          clean[k] = (v as Record<string, string>)[k];
      }
      return clean;
    }
    return {};
  } catch {
    return {};
  }
}

/** Persist the profile to `browser.storage.local` (on-device only). */
export async function saveProfile(profile: UserProfile): Promise<void> {
  const { storageSet } = await import('./storage');
  await storageSet(PROFILE_STORAGE_KEY, profile);
}
