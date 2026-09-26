/**
 * Outbound-send gate — issue #143 (P2 of the cross-tab orchestrator).
 *
 * The final *send* that pushes data off the device to a third party (send on a
 * chat surface like WhatsApp Web, submit-after-attach on a messaging app) must
 * pause the run for a human. This module is the pure, unit-testable core:
 *
 * - `isOutboundDomain(url, allowlist)` — is this page on a user opt-in
 *   outbound domain? The allowlist is a per-domain opt-in (see
 *   `loadOutboundAllowlist`); empty allowlist = gate fully OFF (zero change).
 * - `classifySendVerb(action, elements)` — is this action a send-classified
 *   verb (a "Send" button click, a composer submit)? Keyword-classified.
 * - `classifyOutboundSend(...)` — the decision: gate only when BOTH the page is
 *   an outbound domain AND the action is send-classified. **Fail closed**: on
 *   an outbound domain an action that cannot be proven non-send (unknown /
 *   unlabelled target) is gated, so a WhatsApp send is never fire-and-forget.
 *
 * PII note: the staged value shown to the user is resolved on-device for
 * display ONLY. The planner LLM never sees it (the #102/#141 token firewall
 * holds through the gate). This module is DOM- and browser-free so it is
 * testable in Node.
 */

// The action shape the runner resolves before execution (value already the
// real resolved value the executor will type/click).
export interface OutboundActionLike {
  type: string;
  targetId?: number | string;
  value?: string;
  url?: string;
  key?: string;
  [k: string]: unknown;
}

// One row of the element table (label/role/tag/text only - what the extractor
// reports). Kept loose: the gate reads a couple of fields, not the whole row.
export interface ElementLike {
  id?: number | string;
  role?: string;
  tag?: string;
  label?: string;
  text?: string;
  ariaLabel?: string;
  [k: string]: unknown;
}

/** Send-classified verbs (lower-cased, matched as substrings of a label). */
export const SEND_VERBS: readonly string[] = [
  'send',
  'send message',
  'send to',
  'post',
  'publish',
  'share',
  'attach & send',
  'attach and send',
  'send file',
  'send now',
  'submit message',
];

export interface OutboundHit {
  /** True when the action must pause for a human. */
  gated: boolean;
  /** Why: a send-verb match, a fail-closed unknown-on-outbound, or 'off'. */
  reason: string;
  /** The element the send targets (for the popup's staged-payload display). */
  elementLabel?: string;
}

export function isOutboundDomain(
  url: string | undefined,
  allowlist: string[] | null | undefined
): boolean {
  if (!url || !allowlist || allowlist.length === 0) return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // not a parseable http(s) URL -> not an outbound surface
  }
  return allowlist.some((raw) => {
    const d = String(raw).trim().toLowerCase();
    if (!d) return false;
    return host === d || host.endsWith('.' + d);
  });
}

/** The human-readable label of an element (label || text || ariaLabel || role). */
export function elementLabel(el: ElementLike | undefined): string {
  if (!el) return '';
  return String(el.label ?? el.text ?? el.ariaLabel ?? el.role ?? '').trim();
}

function findElement(
  elements: ElementLike[] | undefined,
  targetId: number | string | undefined
): ElementLike | undefined {
  if (elements && targetId !== undefined) {
    return elements.find((el) => String(el.id) === String(targetId));
  }
  return undefined;
}

/**
 * Is this action a send-classified verb? A CLICK whose target element's label
 * matches a send verb, or a KEY "Enter" (composer submit) on a send-labelled
 * control. Non-click/key actions and value-typed fields are NOT send verbs by
 * themselves.
 */
export function classifySendVerb(
  action: OutboundActionLike,
  elements?: ElementLike[]
): string | null {
  const t = String(action.type ?? '').toUpperCase();
  const el = findElement(elements, action.targetId);
  const label = elementLabel(el).toLowerCase();

  if (t === 'CLICK') {
    for (const verb of SEND_VERBS) if (label.includes(verb)) return verb;
    return null;
  }
  if (t === 'KEY' && String(action.key ?? '').toLowerCase() === 'enter') {
    // A composer Enter-submits only when the focused control is send-classified.
    for (const verb of SEND_VERBS) if (label.includes(verb)) return verb;
    return null;
  }
  // A plain TYPE into a send-labeled field on a chat surface is staging, not the
  // final send - the send is the follow-up CLICK/Enter, so it is not gated here.
  return null;
}

/**
 * The gate decision. Gated only when the page is an outbound domain AND the
 * action is send-classified; on an outbound domain, a CLICK/KEY whose target
 * cannot be proven non-send fails CLOSED (gated). Off-domain -> not gated.
 */
export function classifyOutboundSend(
  action: OutboundActionLike,
  url: string | undefined,
  elements: ElementLike[] | undefined,
  allowlist: string[] | null | undefined
): OutboundHit {
  if (!isOutboundDomain(url, allowlist)) {
    return { gated: false, reason: 'not-an-outbound-domain' };
  }
  const el = findElement(elements, action.targetId);
  const verb = classifySendVerb(action, elements);
  if (verb) {
    return { gated: true, reason: `send-verb:${verb}`, elementLabel: elementLabel(el) };
  }
  const t = String(action.type ?? '').toUpperCase();
  // Fail closed: on a chat/messaging domain, a CLICK or Enter that targets a
  // control we can't prove is a harmless navigation/link could be the send.
  // (An unlabelled paper-plane button on WhatsApp Web is exactly this.)
  if (t === 'CLICK' || (t === 'KEY' && String(action.key ?? '').toLowerCase() === 'enter')) {
    const label = elementLabel(el);
    // A clearly navigational link ("Profile", "Statuses", a named group) is not
    // a send - only an unlabelled / ambiguous target fails closed.
    const looksNavigational =
      el &&
      (el.role === 'link' || el.tag === 'a') &&
      label.length > 0 &&
      label.toLowerCase() !== 'send';
    if (!looksNavigational) {
      return {
        gated: true,
        reason: 'fail-closed:unproven-send-on-outbound',
        elementLabel: label || undefined,
      };
    }
  }
  return { gated: false, reason: 'safe-action-on-outbound-domain' };
}

/**
 * Build the staged payload the popup shows the user. The `value` is the
 * RESOLVED on-device value (already token-resolved by the runner) shown for
 * display only; it never crosses to the LLM. `destination` is the outbound
 * tab's url/title (safe to show).
 */
export interface StagedOutbound {
  action: string;
  destinationUrl: string;
  destinationTitle: string;
  elementLabel?: string;
  value: string;
  note?: string;
}

export function stageOutbound(
  hit: OutboundHit,
  action: OutboundActionLike,
  url: string,
  title: string,
  resolvedValue: string | undefined,
  note?: string
): StagedOutbound {
  return {
    action: String(action.type ?? ''),
    destinationUrl: url,
    destinationTitle: title,
    elementLabel: hit.elementLabel,
    value: resolvedValue ?? '',
    note,
  };
}
