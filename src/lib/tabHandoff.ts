/**
 * Cross-tab handoff — issue #141 (P1 sequenced SWITCH_TAB).
 *
 * One task may span several open tabs ("read the values on the data tab, fill
 * the form on the form tab"). The pure core of that flow lives here so it is
 * unit-testable with no live browser:
 *
 * - `harvestToHandoff`: turns a content-script field harvest (label/value
 *   pairs from a tab) into a token-keyed handoff. Tokens (<FIELD_1>, …) are
 *   what the planner sees; the VALUES stay on-device in the service worker
 *   and are resolved back into TYPE/SELECT actions at execution time — the
 *   LLM never sees the raw value (same firewall rule as the #102 profile
 *   tokens, applied to page-derived data).
 * - `handoffForPlanner`: the planner payload section — tokens + labels only.
 * - `resolveHandoffValue`: on-device token → value resolution for the SW.
 *
 * PII note: harvested values can be personal data. They cross only
 * SW-local state → executor input. Never the /plan payload, never the log.
 */

// One row of a content-script field harvest (see content.ts HARVEST_FIELDS).
export interface HarvestedField {
  label: string;
  value: string;
}

// Token-keyed cross-tab memory, owned by the service worker.
export interface TabHandoff {
  /** '<FIELD_1>' -> value harvested on-device. */
  values: Record<string, string>;
  /** '<FIELD_1>' -> human-readable label (safe to show the planner). */
  labels: Record<string, string>;
  /** When the values were harvested. */
  extractedAt: number;
  /** Where the values came from. */
  sourceUrl: string;
}

// What the runner hands /plan so the planner can pick a switch target.
export interface OpenTabInfo {
  tabId: number;
  url: string;
  title: string;
}

/** Max fields harvested per tab (dense pages must not blow up the handoff). */
export const MAX_HANDOFF_FIELDS = 50;

export function emptyHandoff(): TabHandoff {
  return { values: {}, labels: {}, extractedAt: 0, sourceUrl: '' };
}

export function isHandoffToken(value: string | undefined | null): boolean {
  return !!value && /^<FIELD_\d+>$/.test(value.trim());
}

/** Token form, 1-based: index 0 -> '<FIELD_1>'. */
export function fieldToken(index: number): string {
  return `<FIELD_${index + 1}>`;
}

/**
 * Build a fresh handoff from a harvest. Sequential, stable ordering:
 * de-duplicated by value (a page that repeats "Acme Ltd" in three cells
 * yields one token, not three). Labels are dedup-keyed too — first wins.
 */
export function harvestToHandoff(
  fields: HarvestedField[],
  sourceUrl: string,
): TabHandoff {
  const values: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const byValue = new Map<string, string>(); // value -> token
  let n = 0;
  for (const f of fields) {
    const value = (f.value ?? '').trim();
    if (!value) continue;
    const existing = byValue.get(value);
    if (existing) continue;
    const token = fieldToken(n);
    n += 1;
    byValue.set(value, token);
    values[token] = value;
    const label = (f.label ?? '').trim();
    labels[token] = label || `field ${n}`;
    if (n >= MAX_HANDOFF_FIELDS) break;
  }
  return {
    values,
    labels,
    extractedAt: Date.now(),
    sourceUrl,
  };
}

/**
 * The /plan payload section: what the planner may reference. Tokens + labels
 * ONLY — never the values (that would defeat the firewall). Empty handoff ->
 * undefined (the payload key is omitted, so single-tab tasks see no change).
 */
export function handoffForPlanner(
  h: TabHandoff | null | undefined,
): Array<{ token: string; label: string }> | undefined {
  if (!h || Object.keys(h.values).length === 0) return undefined;
  return Object.keys(h.values).map((token) => ({
    token,
    label: h.labels[token] ?? `field ${token.slice(-1)}`,
  }));
}

/**
 * On-device resolution at execution time: a TYPE/SELECT value that IS a
 * handoff token becomes the harvested value. Unknown tokens / non-tokens
 * return undefined (the action proceeds with its original value — a planner
 * that hallucinated a token just types the literal, which it already saw).
 */
export function resolveHandoffValue(
  value: string | undefined,
  h: TabHandoff | null | undefined,
): string | undefined {
  if (value === undefined || !isHandoffToken(value) || !h) return undefined;
  return h.values[value.trim()];
}
