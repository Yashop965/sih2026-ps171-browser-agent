/**
 * The planner execute path, extracted from the background service worker.
 *
 * Issue #159 asked for background.ts to be split up. This is step 3 of three.
 * Step 1 moved the ledger message handlers, step 2 the planner navigation
 * channel.
 *
 * ## What this covers
 *
 * `executeChannel` handled two genuinely different things behind one
 * `action.type === 'SWITCH_TAB'` branch:
 *
 *   - the cross-tab HOP (77 lines) - repoint the run at another open web tab,
 *     harvesting the leaving tab first. Nine closure dependencies, and until
 *     now the only part of the SW with NO direct test: the existing #141 tests
 *     cover the runner that CALLS it and the server that PARSES it, but the
 *     hop itself was unreachable.
 *   - the generic forward (40 lines) - hand an action to the content script
 *     and log the result.
 *
 * Both are here rather than only the hop, because keeping the generic forward
 * behind would leave `executeChannel` in the SW as a branch that decides
 * between "call the extracted thing" and "do the thing" - i.e. no smaller, and
 * one more layer to read through.
 *
 * ## The behaviour most worth protecting
 *
 * A click or submit that NAVIGATES the tab tears down the content-script port
 * before it can reply (#86). The port error is indistinguishable from a real
 * failure by message text alone, so it is matched on a pattern and reported as
 * SUCCESS with a note. Reporting it as a failure makes the planner retry a
 * click that already worked.
 *
 * That regex is the highest-risk line in this file, which is why it is
 * exported and directly tested rather than buried here.
 */

import { browser } from 'wxt/browser';
import type { ExecuteResult } from './agentRunner';
import type { OpenTabInfo } from './tabHandoff';

/** How long a freshly-activated background tab gets to attach its content port. */
export const SWITCH_TAB_LOAD_MS = 3_000;

/**
 * Content-port errors that mean "the page went away mid-action", not "the
 * action failed".
 *
 * A navigation unloads the document and the content script with it, so the
 * `sendMessage` never gets a reply. Matched on text because the extension API
 * gives nothing structured to match on.
 *
 * Each alternative is anchored to the port-teardown phrasing Chrome actually
 * emits. A bare `closed` is NOT one of them: it also matches ordinary errors
 * like "the dropdown is closed", and treating a validation failure as a
 * successful navigation hides a real error from the ledger.
 */
export function isNavigationDisconnect(message: string): boolean {
  return /disconnect|Receiving end does not exist|Could not establish connection|No recipient|message port closed|port closed before/i.test(
    message
  );
}

export interface SwitchTabDeps {
  /** Which tab the run is driving now, or undefined if none. */
  driveTab: () => Promise<number | undefined>;
  /** Harvest the leaving tab's labeled values into the task handoff. */
  harvestIntoHandoff: (tabId: number) => Promise<void>;
  /** The planner-visible open-tab list, for resolving a `urlHint`. */
  openTabs: () => Promise<OpenTabInfo[]>;
  /**
   * Re-point the run's pinned target. A setter, not a value: `background.ts`
   * owns this state and three other places write it.
   */
  onTargetChanged: (target: { tabId: number; windowId: number }) => void;
  /**
   * Begin passively watching the tab being left, so an edit there reaches the
   * run's next token write (#144 P3). Called only on a real hop.
   */
  registerWatchedSource: (tabId: number, nextTargetTabId?: number) => Promise<void>;
  /** Bookkeeping only - a session failure must never fail the hop. */
  trackTabSession: (
    tabId: number,
    tab: { url?: string; windowId?: number; title?: string }
  ) => Promise<void>;
  waitForTabLoad: (tabId: number, timeoutMs: number) => Promise<boolean>;
  logExecution: (entry: {
    tabId: number;
    url: string;
    type: 'EXECUTION';
    selector: 'SWITCH_TAB';
    confidence: number;
    verified: boolean;
    action: 'SUCCESS';
  }) => void;
}

const isWebUrl = (u?: string): boolean =>
  !!u && (u.startsWith('http://') || u.startsWith('https://'));

/**
 * Hop the run to another open web tab.
 *
 * Target resolution, in order: an explicit `tabId` (only if it is really a web
 * page), then a `urlHint` matched against url then title, then - rather than
 * failing - the tab we are already on. A bare SWITCH_TAB therefore re-grounds
 * the run instead of ending it, which is deliberate: a planner that emits one
 * with no target is asking to re-ground, not to fail.
 */
export async function switchTab(
  action: { tabId?: unknown; urlHint?: unknown },
  deps: SwitchTabDeps
): Promise<ExecuteResult> {
  const from = await deps.driveTab();
  // Harvest the LEAVING tab first, while it is still the one being driven -
  // after the hop its content script may not answer.
  if (from !== undefined) await deps.harvestIntoHandoff(from);

  let next: number | undefined;
  if (typeof action.tabId === 'number') {
    try {
      const t = await browser.tabs.get(action.tabId);
      if (isWebUrl(t?.url)) next = t.id;
    } catch {
      next = undefined;
    }
  }
  if (next === undefined && typeof action.urlHint === 'string' && action.urlHint) {
    const hint = action.urlHint.toLowerCase();
    const tabs = await deps.openTabs();
    const hit =
      tabs.find((t) => t.url.toLowerCase().includes(hint)) ||
      tabs.find((t) => t.title.toLowerCase().includes(hint));
    next = hit?.tabId;
  }
  if (next === undefined) next = from;
  if (next === undefined) return { ok: false, error: 'no web tab to switch to' };

  try {
    await browser.tabs.update(next, { active: true });
    const target = await browser.tabs.get(next);
    deps.onTargetChanged({ tabId: next, windowId: target?.windowId ?? 0 });
    // Watch the LEAVING tab passively, registered AFTER the target repoint so
    // the leaving tab - which was just the focus tab - is a valid watch
    // target, and a no-op hop (from === next) never watches the tab the agent
    // is about to drive.
    if (from !== undefined && from !== next) {
      await deps.registerWatchedSource(from, next);
    }
    // Bookkeeping only; the helper swallows its own failures.
    await deps.trackTabSession(next, target ?? {});
    // A background tab is not mid-navigation, but give its content script a
    // beat so the next EXTRACT finds the port attached.
    await deps.waitForTabLoad(next, SWITCH_TAB_LOAD_MS);
    deps.logExecution({
      tabId: next,
      url: target?.url || '',
      type: 'EXECUTION',
      selector: 'SWITCH_TAB',
      confidence: 1,
      verified: true,
      action: 'SUCCESS',
    });
    return { ok: true, note: 'tab switched - will re-extract the new tab' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface ForwardDeps {
  driveTab: () => Promise<number | undefined>;
  logExecution: (entry: {
    tabId: number;
    url: string;
    type: 'EXECUTION';
    selector: string;
    confidence: number;
    verified: boolean;
    action: 'SUCCESS' | 'FAILURE';
    error?: string;
  }) => void;
}

/**
 * Hand an action to the content script on the driven tab.
 *
 * A port error that looks like a navigation is reported as SUCCESS, because the
 * action almost certainly worked and the next EXTRACT re-plans on the new page.
 */
export async function forwardToContentScript(
  action: { targetId?: unknown; [k: string]: unknown },
  deps: ForwardDeps
): Promise<ExecuteResult> {
  const tabId = await deps.driveTab();
  if (tabId === undefined) return { ok: false, error: 'No web tab found' };
  try {
    const result: any = await browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action });
    deps.logExecution({
      tabId,
      url: '',
      type: 'EXECUTION',
      selector: action?.targetId?.toString() || '',
      confidence: 1,
      verified: result?.ok === true,
      action: result?.ok ? 'SUCCESS' : 'FAILURE',
      error: result?.error,
    });
    return result;
  } catch (e) {
    const msg = String(e);
    if (isNavigationDisconnect(msg)) {
      deps.logExecution({
        tabId,
        url: '',
        type: 'EXECUTION',
        selector: action?.targetId?.toString() || '',
        confidence: 1,
        verified: true,
        action: 'SUCCESS',
      });
      return { ok: true, note: 'page navigated - will re-extract the new page' };
    }
    return { ok: false, error: msg };
  }
}
