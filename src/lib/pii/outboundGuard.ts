/**
 * Outbound Egress Guard for the live /plan path (issue #61)
 *
 * The live agent loop (popup -> fetch /plan) previously sent DOM labels /
 * names and the user's task to the planner WITHOUT redaction and WITHOUT the
 * outbound firewall. The full pipeline (redact -> firewall -> audit) lived
 * only in the background CAPTURE_AND_SEND handler, which has no live callers
 * - so the "0 PII crosses the line" guarantee was bypassed on the exact path
 * that actually runs.
 *
 * This module is that pipeline, factored out and reused on the live path:
 *   1. redactString() the PII-bearing string fields (task, element labels,
 *      names, placeholders). Masking happens in place, so the raw value is
 *      never transmitted.
 *   2. checkOutboundPayload() over the ENTIRE body as a final gate - the
 *      "last line of defence". It catches PII the redactor missed
 *      (validator-only patterns, residual in context, etc.).
 *
 * Pure: no browser / window / document / localStorage. Imports only
 * ./sanitizer (redactString), ./firewall (checkOutboundPayload) and the type
 * files - so it is unit-testable in Node with zero DOM.
 */

import { redactString } from './sanitizer';
import { checkOutboundPayload } from './firewall';
import { maskProfileValues, profileHintsForPayload, type UserProfile } from '../userProfile';
import type { PIIType } from '../../types';

/**
 * PII-bearing string fields on a live interactive element. We redact exactly
 * these keys (when present and a string) so we don't overfit to one shape and
 * don't touch geometry (rect, numeric ids) which carry no PII.
 */
const PII_FIELDS: readonly string[] = [
  'label',
  'name',
  'placeholder',
  'value',
  'text',
  'ariaLabel',
];

export interface LiveElement {
  [key: string]: unknown;
}

export interface OutboundPlanInput {
  /** The user's task description - free text, can carry PII. */
  task: string;
  /** Raw interactive elements from the content script (un-sanitized). */
  elements: LiveElement[];
  /** On-device page geometry (issue #59). Numeric/boolean - no PII. */
  context?: unknown;
  /** Filled-element history (ids + result). No PII. */
  history?: unknown[];
  /** Extra scalar fields the caller wants passed through unchanged. */
  passThrough?: Record<string, unknown>;
  /**
   * Issue #102: the local user profile. Raw values are NEVER sent - any that
   * appear in the task/elements are replaced with stable tokens (<EMAIL> ...),
   * and a token-only key->token map is added to the payload so the planner
   * knows which field a token means without the raw value. When omitted,
   * egress behaves exactly as before.
   */
  profile?: UserProfile;
}

export interface OutboundPlanResult {
  /** True when the firewall blocked the payload - DO NOT transmit. */
  blocked: boolean;
  /** Human-readable reason when blocked (never contains the raw PII value). */
  reason?: string;
  /** PII category that triggered the block, if any. */
  category?: PIIType | string;
  /** How many individual string fields were redacted (for the audit log). */
  redactedCount: number;
  /** The fully-sanitized request body, ready to POST when not blocked. */
  payload: Record<string, unknown>;
  /** Redaction events (type + selector only - no values). */
  events: Array<{ type: PIIType; selector: string }>;
}

/**
 * Build a sanitized /plan request body and run the outbound firewall over it.
 *
 * Returns the masked payload to send plus a `blocked` flag. Callers MUST check
 * `blocked` and abort when true; when false, `payload` is safe to transmit.
 */
export function guardOutboundPlan(input: OutboundPlanInput): OutboundPlanResult {
  const events: Array<{ type: PIIType; selector: string }> = [];
  let redactedCount = 0;

  // 0. Profile masking (issue #102): replace raw local-constant values with
  //    stable tokens BEFORE the general PII redactor, so the raw value is
  //    never present for the redactor (or anything downstream) to see.
  const profile = input.profile ?? {};
  const hasProfile = Object.keys(profile).length > 0;

  // 1. Redact the task (free text).
  const rawTask = input.task ?? '';
  const taskAfterMask = hasProfile ? maskProfileValues(rawTask, profile) : rawTask;
  const { sanitized: safeTask, matches: taskMatches } = redactString(taskAfterMask, 'task');
  if (safeTask !== rawTask) redactedCount++;
  for (const m of taskMatches) {
    if (m.redacted) events.push({ type: m.type, selector: 'task' });
  }

  // 2. Redact each element's PII-bearing string fields (in place on a copy).
  const safeElements: LiveElement[] = (input.elements ?? []).map((el, i) => {
    const copy: LiveElement = { ...el };
    for (const key of PII_FIELDS) {
      const raw = copy[key];
      if (typeof raw === 'string' && raw.length > 0) {
        // Mask profile values first (issue #102); the string type is preserved
        // on a local const so the redactor sees a `string`, not `unknown`.
        const masked = hasProfile ? maskProfileValues(raw, profile) : raw;
        const { sanitized, matches } = redactString(masked, `elements[${i}].${key}`);
        // Compare against the ORIGINAL raw value, not `masked`: profile-masking
        // already removed the PII, so redactString returns it unchanged and
        // `sanitized !== masked` would be false - leaving the raw value in the
        // copy. Against `raw` we correctly write back the token-masked value.
        if (sanitized !== raw) {
          copy[key] = sanitized;
          redactedCount++;
        }
        for (const m of matches) {
          if (m.redacted) events.push({ type: m.type, selector: `elements[${i}].${key}` });
        }
      }
    }
    return copy;
  });

  // 3. Assemble the exact body the popup would POST, with the sanitized task
  //    and elements. Geometry + history + pass-through scalars go through
  //    unchanged (they carry no PII, and the firewall still inspects them).
  //    Issue #102: add a token-only profile map (key -> <TOKEN>) so the
  //    planner knows which field a token refers to - NEVER the raw value.
  const profileHints = hasProfile ? profileHintsForPayload(profile) : {};
  const payload: Record<string, unknown> = {
    task: safeTask,
    elements: safeElements,
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(Object.keys(profileHints).length ? { profileHints } : {}),
    ...(input.passThrough ?? {}),
  };

  // 4. Final gate: outbound firewall over the ENTIRE payload.
  const firewall = checkOutboundPayload(payload);
  if (!firewall.passed) {
    return {
      blocked: true,
      reason: firewall.reason,
      category: firewall.blockedCategory as PIIType | string | undefined,
      redactedCount,
      payload,
      events,
    };
  }

  return { blocked: false, redactedCount, payload, events };
}
