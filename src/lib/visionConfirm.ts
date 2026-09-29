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
// #208: recognise an action goal, and check it against the DOM rather than OCR.
import { isActionGoal, checkboxSatisfied } from './actionGoal';

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
  /** #208: goals OCR structurally cannot prove (action-phrased). Reported
   *  separately from `missing` so "cannot verify" is never read as "looked
   *  and did not find it". Never counted as confirmed. */
  unverifiable: string[];
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
  openItems: VisionConfirmItem[],
  /**
   * #208: the page's checkbox state, read on device. Lets a goal that names an
   * ACTION ("tick the terms of service") be proven by the DOM rather than by OCR.
   * Absent = the DOM path is unavailable, and every action goal falls back to
   * unverifiable - the same verdict it had before, never "assumed fine".
   */
  checkboxState?: Record<string, boolean> | null
): VisionConfirmVerdict {
  const matched: string[] = [];
  const missing: string[] = [];
  // #208: goals OCR structurally cannot prove. Reported separately so the log
  // says "cannot verify this kind of goal" once instead of repeating
  // "missing" for something that could never match.
  const unverifiable: string[] = [];

  for (const item of openItems) {
    // #208: an action goal is a state change, not a string - no OCR can ever
    // contain it. If the page reports a matching checkbox that is checked, the
    // goal IS proven. Otherwise it is unverifiable, which is NOT the same as
    // missing: it must not be reported as a target the OCR failed to find.
    if (isActionGoal(item.description)) {
      if (checkboxSatisfied(item.description, checkboxState)) {
        matched.push(item.id);
      } else {
        unverifiable.push(item.id);
      }
      continue;
    }
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

  const allProven = openItems.length > 0 && missing.length === 0 && unverifiable.length === 0;
  // #208: lead with the actionable case. "cannot verify by OCR" is a different
  // situation from "the OCR looked and did not find it", and reading them as the
  // same is what made this look like a stuck task.
  const detail = allProven
    ? `OCR confirms all ${matched.length} open goal(s)`
    : missing.length && unverifiable.length
      ? `OCR missing target(s): ${missing.join(', ')}; not verifiable by OCR (action goal(s)): ${unverifiable.join(', ')}`
      : missing.length
        ? `OCR missing target(s): ${missing.join(', ')}`
        : unverifiable.length
          ? `Not verifiable by OCR (action goal(s)): ${unverifiable.join(', ')} - DOM state did not prove them`
          : 'no open goals to confirm';
  return { confirmed: allProven, matched, missing, unverifiable, detail };
}
