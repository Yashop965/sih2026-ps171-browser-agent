/**
 * The live planner navigation path, extracted from the background service worker.
 *
 * Issue #159 asked for background.ts to be split up. This is step 2 of three.
 * Step 1 moved the ledger message handlers out to `lib/ledgerMessages.ts`.
 *
 * ## Why this one, and not executeChannel
 *
 * Three candidates sat in the same 370-line region. Measured, they were:
 *
 *   navigateChannel    91 lines   5 closure deps
 *   extractChannel     62 lines   5 closure deps
 *   executeChannel    134 lines   8 closure deps
 *
 * `navigateChannel` is the smallest with a clean boundary, AND it is the one
 * that already has an extracted, directly-tested policy (`resolveNavUrl` from
 * #190/#191) and a behavioural suite (`nav-recoverable-behaviour-192.test.ts`).
 * Extracting it leaves the existing tests covering code that moved rather than
 * code that was rewritten - which is the safest way to do a refactor of
 * navigation, the one area where a mistake breaks the product visibly.
 *
 * `executeChannel` (134 lines, 8 deps) is left for its own PR. It is the last
 * remaining untestable block, and it should not share a review with a
 * navigation rewrite.
 *
 * ## The one piece of shared mutable state
 *
 * `currentTargetTab` lives in the background closure and is written from three
 * places (a SWITCH_TAB handler, resetCrossTabState, and this module). It is
 * passed in as a getter and an `onTargetChanged` callback rather than captured,
 * because a copy would silently stop re-asserting the target - the exact bug
 * #141 fixed, and the one that lets a run drift onto the wrong tab.
 *
 * Note the setter is called on the SUCCESS path only, and deliberately not when
 * the url is refused. `driveTab()` is not pure: on a refused url it has already
 * cleared a dead `currentTargetTab` and fallen back to the active tab, so
 * re-asserting here would resurrect a tab that is already gone.
 */

import { browser } from 'wxt/browser';
import { resolveNavUrl } from './navUrl';

/** The shape `background.ts` keeps for its pinned per-run target tab. */
interface PinnedTarget {
  tabId: number;
  windowId: number;
}

interface NavResult {
  ok: boolean;
  error?: string;
  /**
   * True when the instruction was bad but the environment is fine, so the
   * runner can re-plan instead of ending the run. Environment failures (no tab,
   * thrown error) are fatal and leave this unset.
   */
  recoverable?: boolean;
}

/**
 * The boundary the background service worker passes in.
 *
 * `onTargetChanged` receives the shape `background.ts` stores, which is why
 * `PinnedTarget` is structurally identical to the pinned target there rather
 * than a type import - the two files have no reason to share a declaration for
 * two fields.
 */
export interface NavigateDeps {
  /**
   * Resolves which tab to drive, clearing a dead pinned target as a side
   * effect. Returns undefined when no web tab is available.
   */
  driveTab: () => Promise<number | undefined>;
  /**
   * Log a successful navigation to the privacy ledger.
   *
   * No `timestamp` here on purpose. The pre-extraction code passed
   * `timestamp: Date.now()` computed AFTER `waitForTabLoad`, and
   * `PrivacyLedger.log()` already defaults the field to `Date.now()` at the
   * moment it is called. So passing it or omitting it lands on the same
   * instant - the only difference would be a few microseconds, and a ledger
   * that claims a time the ledger did not itself observe is worse than one
   * that stamps itself.
   */
  logExecution: (entry: {
    tabId: number;
    url: string;
    type: 'EXECUTION';
    selector: 'NAVIGATE';
    confidence: number;
    verified: boolean;
    action: 'SUCCESS';
  }) => void;
  /**
   * Re-assert the pinned target after a successful navigation so a later
   * tabs.query fallback cannot drift the run onto another tab (#141).
   */
  onTargetChanged: (target: PinnedTarget) => void;
  /**
   * Wait for the tab to finish loading. Injected rather than imported so this
   * module has no dependency on the service worker's own internals.
   */
  waitForTabLoad: (tabId: number, timeoutMs: number) => Promise<boolean>;
}

export const NAV_LOAD_TIMEOUT_MS = 10_000;

/**
 * Handle one planner NAVIGATE action.
 *
 * This is the path that ACTUALLY carries a planner NAVIGATE (the runner calls
 * `d.navigate`) - the separate `NAVIGATE_TAB` message handler is a different
 * entry point into the same policy.
 */
export async function navigateChannel(url: unknown, deps: NavigateDeps): Promise<NavResult> {
  try {
    // #192: resolve the tab FIRST, because a relative target needs a real base
    // and the tab's current url is the only real base available in a service
    // worker.
    //
    // This reorder has one side effect worth naming, which the review of #191
    // caught: `driveTab` is not pure. When the pinned target is set but its tab
    // is gone or no longer a web page, driveTab clears it and falls back to
    // the active tab. So a REFUSED url (javascript:, a relative url with no
    // usable base) now clears that state, where previously the refusal happened
    // first and left it alone.
    //
    // That is the safer of the two behaviours: the pinned tab is already dead,
    // and leaving a stale id set is what makes a later tabs.query fallback
    // drift a run onto the wrong tab. The next driveTab call re-establishes the
    // target from the active tab anyway.
    const tabId = await deps.driveTab();
    if (tabId === undefined) return { ok: false, error: 'No web tab found' };

    // #159: the same policy the NAVIGATE_TAB handler uses, now shared rather
    // than duplicated. This copy had drifted in the same two ways: the
    // `http://invalid` placeholder base, and - the real one - no non-string
    // guard, so `new URL(42, base)` navigated to `http://invalid/42`.
    // resolveNavUrl refuses those.
    //
    // `base` is the tab's current url, read fresh: a relative target the planner
    // emitted ("/profile") resolves against the page the agent is actually on.
    // Without it the target lands on the .invalid placeholder and the
    // navigation silently fails.
    const currentUrl = await browser.tabs
      .get(tabId)
      .then((t) => t.url)
      .catch(() => undefined);
    const nav = resolveNavUrl(url, currentUrl);
    if (!nav.ok || !nav.url) {
      // #192: recoverable - the url was refused, not the browser broken. The
      // planner is told and can re-plan. See agentRunner's NAVIGATE branch:
      // without this flag the whole run ends on a bad url.
      return { ok: false, error: nav.error ?? 'invalid url', recoverable: true };
    }

    // Relative target and no usable base - the resolved url points at the
    // placeholder host and will not load. Say so precisely, because "invalid
    // url" would send the planner looking for a syntax problem that is not
    // there.
    if (nav.needsBase) {
      return {
        ok: false,
        recoverable: true,
        error:
          currentUrl === undefined
            ? 'relative url but the current page url is unknown - use an absolute url'
            : 'relative url could not be resolved - use an absolute url',
      };
    }

    const target = nav.url;
    await browser.tabs.update(tabId, { url: target });
    await deps.waitForTabLoad(tabId, NAV_LOAD_TIMEOUT_MS);
    // #141: a navigation inside the task re-asserts the target so a later
    // tabs.query fallback can't drift the run onto another tab.
    const moved = await browser.tabs.get(tabId).catch(() => null);
    deps.onTargetChanged({ tabId, windowId: moved?.windowId ?? 0 });
    deps.logExecution({
      tabId,
      url: target,
      type: 'EXECUTION',
      selector: 'NAVIGATE',
      confidence: 1,
      verified: true,
      action: 'SUCCESS',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
