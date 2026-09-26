/**
 * Navigation URL policy, extracted from the NAVIGATE_TAB handler.
 *
 * Issue #159 asked for background.ts to be split up, on the grounds that a
 * 1,200-line closure interleaves seven feature concerns and is effectively
 * untestable. That is right, but the fix is not "move lines around" — it is
 * to pull out the parts that have a real boundary and can be proven.
 *
 * This is the highest-value one to extract, because it is a SECURITY check
 * sitting inline in a message handler, where a test can only reach it by
 * standing up the whole service worker with a fake `browser.tabs`. The
 * NAVIGATE_TAB path is the only place the extension navigates a tab without
 * going through the content script, so it is the only place this policy is
 * enforced at all.
 *
 * Two rules, and the second one is the subtle one:
 *
 *  1. Only http(s). `javascript:`, `data:`, `file:`, `chrome:` are refused.
 *     A NAVIGATE to a `javascript:` URL executes script in the page with the
 *     page's origin - the extension would be handing a page-controlled string
 *     to the browser as code.
 *
 *  2. A RELATIVE url is resolved against a placeholder base rather than
 *     refused. The planner legitimately emits `/dashboard` and
 *     `example.com/x`, and refusing those would break multi-page autonomy.
 *     The placeholder base is `http://invalid` - deliberately not a real host,
 *     because a relative target must not silently inherit a real origin. What
 *     comes back is an absolute URL on a host that will not resolve, so the
 *     browser reports it as a navigation failure rather than quietly landing
 *     somewhere unintended.
 */

export interface NavUrlResult {
  ok: boolean;
  /** The absolute URL to navigate to. Present only when ok. */
  url?: string;
  /** Why it was refused. Present only when !ok. */
  error?: string;
}

/** Schemes the extension will navigate a tab to. Everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Placeholder base for resolving a relative target. RFC 2606 reserves
 * `.invalid`, so this can never be a real registrable host - a relative
 * target that fails to carry its own host cannot end up pointing somewhere
 * real.
 */
const RELATIVE_BASE = 'http://relative-target.invalid';

export function resolveNavUrl(target: unknown): NavUrlResult {
  // A missing or non-string target is a model bug, not a URL. Refuse it
  // explicitly rather than letting `new URL(undefined, base)` coerce to the
  // string "undefined" and navigate somewhere surprising.
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, error: 'invalid url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(target, RELATIVE_BASE);
  } catch {
    return { ok: false, error: 'invalid url' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    // The protocol is echoed back so the caller can log exactly what was
    // refused - useful when the planner emitted something unexpected.
    return { ok: false, error: `refused protocol: ${parsed.protocol}` };
  }

  return { ok: true, url: parsed.href };
}
