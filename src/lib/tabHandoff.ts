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
 * Merge a fresh harvest into an existing handoff (multi-source tasks). A
 * task that reads values from tab A AND tab B keeps both: tokens continue
 * the base's numbering, dedupe is global by value (so the same value
 * harvested on two tabs collapses to the FIRST token, which is what every
 * earlier plan call already saw), and the cap still bounds the total.
 * `harvestToHandoff` alone is last-tab-wins; use this one on the switch
 * path so a bare re-ground never clobbers a prior harvest.
 */
export function mergeHandoff(
  base: TabHandoff,
  incoming: TabHandoff,
): TabHandoff {
  if (Object.keys(incoming.values).length === 0) return base;
  const values: Record<string, string> = { ...base.values };
  const labels: Record<string, string> = { ...base.labels };
  const byValue = new Map<string, string>();
  for (const [token, value] of Object.entries(base.values)) {
    byValue.set(value, token);
  }
  // Continue numbering after the base's last token.
  let n = Object.keys(base.values).length;
  for (const [token, value] of Object.entries(incoming.values)) {
    if (n >= MAX_HANDOFF_FIELDS) break;
    const existing = byValue.get(value);
    if (existing) continue; // already tokenised (possibly by an earlier hop)
    // Re-number: the base's tokens keep their names; only NEW tokens are
    // minted at <FIELD_n+1> so the merged handoff stays gap-free.
    if (n === 0 || token !== fieldToken(n)) {
      const fresh = fieldToken(n);
      values[fresh] = value;
      labels[fresh] = incoming.labels[token] ?? labels[token] ?? `field ${n + 1}`;
      byValue.set(value, fresh);
    } else {
      values[token] = value;
      labels[token] = incoming.labels[token] ?? labels[token] ?? `field ${n + 1}`;
      byValue.set(value, token);
    }
    n += 1;
  }
  return {
    values,
    labels,
    extractedAt: incoming.extractedAt,
    sourceUrl: `${base.sourceUrl} → ${incoming.sourceUrl}`,
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
