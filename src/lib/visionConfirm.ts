/**
 * Vision confirm — issue #100 optional proof layer.
 *
 * The goalBackstop fast path (URL/title string match) is deterministic and
 * dependency-free. This is the OPTIONAL on-device proof: the content script
 * OCRs the visible screen with Florence-2 (screenshot never leaves the
 * device) and we ask "is the open goal's target text actually rendered?"
 *
 * Pure + exported so it's unit-testable with no live browser and no model:
 * we just feed it the OCR text and the still-open checklist items.
 */

import { contentTokens, quotedSpans, normalize } from './goalBackstop';

export interface VisionConfirmItem {
  id: string;
  description?: string;
}

export interface VisionConfirmVerdict {
  /** true when every open item's target text is present in the OCR. */
  confirmed: boolean;
  /** Which items matched (for a short, PII-safe log line). */
  matched: string[];
  /** Which items did NOT match. */
  missing: string[];
  /** One-line human summary. */
  detail: string;
}

/** The searchable target for one item: its quoted span(s) if present, else
 *  its content-token phrase. Empty when the item has no usable signal. */
export function itemTargets(item: VisionConfirmItem): string[] {
  const desc = (item.description ?? '').trim();
  const quoted = quotedSpans(desc);
  if (quoted.length) return quoted;
  const toks = contentTokens(desc);
  return toks.length ? [toks.join(' ')] : [];
}

/** Does a single target string appear in the OCR text? Quoted targets need an
 *  exact (normalized) substring; token targets need ALL content tokens present
 *  (order-free) so a re-wrapped line still matches. */
export function targetInOcr(target: string, ocrText: string): boolean {
  const ocr = normalize(ocrText);
  if (!ocr) return false;
  const quoted = target.startsWith('"') || target.startsWith('‘') || target.startsWith(" '");
  if (quoted) {
    return ocr.includes(normalize(target));
  }
  // Token target: every content word must be present in the OCR.
  const words = target.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // Require all words, but tolerate one missing if there are 3+ (OCR drops
  // occasional characters on dense pages).
  const present = words.filter((w) => ocr.includes(normalize(w)));
  return words.length <= 3 ? present.length === words.length : present.length >= words.length - 1;
}

/**
 * Decide whether the on-device OCR proves the open goals are on screen.
 * Confirms only when EVERY open item has a usable target AND that target is
 * present in the OCR. If any item has no target, or any target is missing,
 * we return confirmed:false so the deterministic loop carries on (safe).
 */
export function visionConfirm(
  ocrText: string,
  openItems: VisionConfirmItem[]
): VisionConfirmVerdict {
  const matched: string[] = [];
  const missing: string[] = [];

  for (const item of openItems) {
    const targets = itemTargets(item);
    if (targets.length === 0) {
      // No usable signal for this item - treat as "cannot prove", not "proven".
      missing.push(item.id);
      continue;
    }
    const ok = targets.some((t) => targetInOcr(t, ocrText));
    if (ok) matched.push(item.id);
    else missing.push(item.id);
  }

  const allProven = openItems.length > 0 && missing.length === 0;
  const detail = allProven
    ? `OCR confirms all ${matched.length} open goal(s)`
    : missing.length
      ? `OCR missing target(s): ${missing.join(', ')}`
      : 'no open goals to confirm';
  return { confirmed: allProven, matched, missing, detail };
}
