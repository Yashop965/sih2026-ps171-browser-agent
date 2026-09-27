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
 *     refused, so the scheme check still runs on it.
 *
 *     Read that carefully: a relative target is NOT made to work by this.
 *     There is no page context in a service worker, so `/dashboard` resolves
 *     to `http://relative-target.invalid/dashboard` - a host that cannot
 *     resolve, and the navigation fails. It failed before this extraction too
 *     (against `http://invalid`), so this is not a regression; it is a
 *     pre-existing limitation that was easy to mistake for support.
 *
 *     The placeholder is RFC 2606 `.invalid` rather than `http://invalid`
 *     specifically so the failure is unmissable and cannot accidentally be a
 *     registrable host. See #192 for making a relative target actually
 *     resolve against the active tab, or for refusing it with an error the
 *     planner can act on.
 *
 * Do not fold `doNavigate` in src/lib/actions.ts into this. It resolves
 * against `location.href` because it runs IN the page, where a relative target
 * has a real base. Same scheme rule, deliberately different base - unifying
 * them would break the content script.
 */

export interface NavUrlResult {
  ok: boolean;
  /** The absolute URL to navigate to. Present only when ok. */
  url?: string;
  /** Why it was refused. Present only when !ok. */
  error?: string;
  /**
   * The target was relative and needed a real base to resolve against.
   *
   * When this is true the caller's `url` is a placeholder that will NOT
   * resolve - see `base`. Present so the caller can either supply a base and
   * retry, or report a precise reason instead of a generic failure.
   */
  needsBase?: boolean;
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

export function resolveNavUrl(target: unknown, base?: string): NavUrlResult {
  // A missing or non-string target is a model bug, not a URL. Refuse it
  // explicitly rather than letting `new URL(undefined, base)` coerce to the
  // string "undefined" and navigate somewhere surprising.
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, error: 'invalid url' };
  }

  // A base is only trusted if it is itself an absolute http(s) URL. Anything
  // else - including a non-string - falls back to the placeholder, so a bad
  // base can never widen what is reachable.
  let baseHref = RELATIVE_BASE;
  if (typeof base === 'string' && base.trim()) {
    try {
      const b = new URL(base);
      if (ALLOWED_PROTOCOLS.has(b.protocol)) baseHref = b.href;
    } catch {
      // Not a usable base - keep the placeholder.
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(target, baseHref);
  } catch {
    return { ok: false, error: 'invalid url' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    // The protocol is echoed back so the caller can log exactly what was
    // refused - useful when the planner emitted something unexpected.
    return { ok: false, error: `refused protocol: ${parsed.protocol}` };
  }

  // If the target carried its own authority (absolute, or protocol-relative)
  // the base was ignored, and there is nothing to warn about. If it did not,
  // the result only works because we supplied a real base; if we fell back to
  // the placeholder, say so, because that URL will not load.
  const targetHasAuthority = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//');
  const usedPlaceholder = baseHref === RELATIVE_BASE;

  return {
    ok: true,
    url: parsed.href,
    needsBase: !targetHasAuthority && usedPlaceholder,
  };
}
