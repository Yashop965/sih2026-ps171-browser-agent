/**
 * Behavioural tests for the extracted execute path (#159 step 3).
 *
 * Until now the SWITCH_TAB hop and the generic content-script forward were
 * reachable only by standing up a service worker. The #141 suites cover the
 * runner that CALLS executeChannel and the server that PARSES a SWITCH_TAB -
 * never the hop itself.
 *
 * These call the real exported functions with stubbed deps and a stubbed
 * `browser.tabs`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { browser } from 'wxt/browser';
import {
  switchTab,
  forwardToContentScript,
  isNavigationDisconnect,
  SWITCH_TAB_LOAD_MS,
  type SwitchTabDeps,
  type ForwardDeps,
} from '../src/lib/executeChannel';

vi.mock('wxt/browser', () => ({
  browser: { tabs: { get: vi.fn(), update: vi.fn(), sendMessage: vi.fn() } },
}));

const get = browser.tabs.get as unknown as ReturnType<typeof vi.fn>;
const update = browser.tabs.update as unknown as ReturnType<typeof vi.fn>;
const sendMessage = browser.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;

function makeSwitchDeps(over: Partial<SwitchTabDeps> = {}) {
  const deps = {
    driveTab: vi.fn(async () => 1),
    harvestIntoHandoff: vi.fn(async () => {}),
    openTabs: vi.fn(async () => [
      { tabId: 1, url: 'https://bank.example/a', title: 'Account' },
      { tabId: 2, url: 'https://docs.google.com/s/1', title: 'Payslip' },
    ]),
    onTargetChanged: vi.fn(),
    registerWatchedSource: vi.fn(async () => {}),
    trackTabSession: vi.fn(async () => {}),
    waitForTabLoad: vi.fn(async () => true),
    logExecution: vi.fn(),
    ...over,
  };
  return deps as typeof deps & SwitchTabDeps;
}

function makeForwardDeps(over: Partial<ForwardDeps> = {}) {
  const deps = {
    driveTab: vi.fn(async () => 1),
    logExecution: vi.fn(),
    ...over,
  };
  return deps as typeof deps & ForwardDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({
    id: 2,
    windowId: 5,
    url: 'https://docs.google.com/s/1',
    title: 'Payslip',
  });
  update.mockResolvedValue(undefined);
  sendMessage.mockResolvedValue({ ok: true });
});

describe('the cross-tab hop resolves its target', () => {
  it('uses an explicit tabId when it is a real web page', async () => {
    const deps = makeSwitchDeps();
    const r = await switchTab({ tabId: 2 }, deps);
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(2, { active: true });
  });

  it('refuses an explicit tabId that is not a web page', async () => {
    // The planner is an LLM; a tabId can point at chrome:// or an extension
    // page. Driving one would extract the agent's own UI.
    get.mockResolvedValue({ id: 9, windowId: 1, url: 'chrome://settings' });
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 9 }, deps);
    expect(update).not.toHaveBeenCalledWith(9, { active: true });
  });

  it('falls back to a urlHint matched against the url', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ urlHint: 'docs.google.com' }, deps);
    expect(update).toHaveBeenCalledWith(2, { active: true });
  });

  it('falls back to a urlHint matched against the title', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ urlHint: 'payslip' }, deps);
    expect(update).toHaveBeenCalledWith(2, { active: true });
  });

  it('prefers the url match over the title match', async () => {
    // Deterministic, so the planner's stated target is not decided by
    // whichever open tab happens to be listed first.
    const deps = makeSwitchDeps({
      openTabs: vi.fn(async () => [
        { tabId: 3, url: 'https://x.example/payslip', title: 'Nothing' },
        { tabId: 2, url: 'https://docs.google.com/1', title: 'payslip' },
      ]),
    });
    await switchTab({ urlHint: 'payslip' }, deps);
    expect(update).toHaveBeenCalledWith(3, { active: true });
  });

  it('re-grounds on the current tab rather than failing', async () => {
    // A bare SWITCH_TAB is a planner asking to re-ground. Failing the run
    // would end a task over a recoverable instruction.
    const deps = makeSwitchDeps();
    const r = await switchTab({}, deps);
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(1, { active: true });
    expect(r.error).toBeUndefined();
  });

  it('fails only when there is genuinely no tab to switch to', async () => {
    const deps = makeSwitchDeps({ driveTab: vi.fn(async () => undefined) });
    const r = await switchTab({}, deps);
    expect(r).toEqual({ ok: false, error: 'no web tab to switch to' });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('the hop harvests the tab it is leaving, first', () => {
  it('harvests before switching, not after', async () => {
    // After the hop the leaving tab's content script may be gone, so a
    // harvest ordered second silently loses the values.
    const order: string[] = [];
    const deps = makeSwitchDeps({
      harvestIntoHandoff: vi.fn(async () => {
        order.push('harvest');
      }),
    });
    update.mockImplementation(async () => {
      order.push('update');
    });
    await switchTab({ tabId: 2 }, deps);
    expect(order).toEqual(['harvest', 'update']);
  });

  it('watches the leaving tab only on a real hop', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 2 }, deps);
    expect(deps.registerWatchedSource).toHaveBeenCalledWith(1, 2);
  });

  it('does not watch the tab it is about to drive', async () => {
    // A no-op hop (from === next) must not register the focus tab as a
    // source: it would be watched and re-perceived while being driven.
    // The explicit-tabId lookup must resolve to the SAME tab, or this is a
    // real hop and watching is correct.
    get.mockResolvedValue({ id: 1, windowId: 5, url: 'https://bank.example/a', title: 'Account' });
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 1 }, deps);
    expect(deps.registerWatchedSource).not.toHaveBeenCalled();
  });

  it('skips the harvest entirely when there is no current tab', async () => {
    const deps = makeSwitchDeps({ driveTab: vi.fn(async () => undefined) });
    await switchTab({ tabId: 2 }, deps);
    expect(deps.harvestIntoHandoff).not.toHaveBeenCalled();
  });
});

describe('the hop updates the pinned target and the ledger', () => {
  it('re-points the target, keeping the tab window', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 2 }, deps);
    expect(deps.onTargetChanged).toHaveBeenCalledWith({ tabId: 2, windowId: 5 });
  });

  it('falls back to windowId 0 when the tab read fails', async () => {
    // The POST-hop read is `await browser.tabs.get(next)` with NO `.catch()` -
    // the same as the original inline code, and deliberate: a throw there
    // aborts the hop and returns {ok:false}, because if the tab cannot be read
    // after activation, activating it did not work, and reporting success
    // would leave the run pointed at a tab it never confirmed.
    //
    // So the windowId-0 fallback is reached by a read that RESOLVES to null
    // (tab closed between update and get), not by one that rejects.
    let reads = 0;
    get.mockImplementation(async () => {
      reads += 1;
      // 1 = pre-hop target lookup, 2 = post-hop read.
      return reads === 1
        ? { id: 2, windowId: 5, url: 'https://docs.google.com/s/1', title: 'Payslip' }
        : null;
    });
    const deps = makeSwitchDeps();
    const r = await switchTab({ tabId: 2 }, deps);
    expect(r.ok).toBe(true);
    expect(deps.onTargetChanged).toHaveBeenCalledWith({ tabId: 2, windowId: 0 });
  });

  it('fails the hop when the post-hop tab read throws', async () => {
    // The counterpart: an unreadable tab means the activation did not take,
    // so this must NOT report success or re-point the target.
    let reads = 0;
    get.mockImplementation(async () => {
      reads += 1;
      if (reads === 1)
        return { id: 2, windowId: 5, url: 'https://docs.google.com/s/1', title: 'Payslip' };
      throw new Error('tab vanished');
    });
    const deps = makeSwitchDeps();
    const r = await switchTab({ tabId: 2 }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tab vanished');
  });

  it('logs the hop to the privacy ledger', async () => {
    // Same reason: do not inherit a neighbour's `get` mock.
    get.mockImplementation(async (id: number) => ({
      id,
      windowId: 5,
      url: 'https://docs.google.com/s/1',
      title: 'Payslip',
    }));
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 2 }, deps);
    expect(deps.logExecution).toHaveBeenCalledWith({
      tabId: 2,
      url: 'https://docs.google.com/s/1',
      type: 'EXECUTION',
      selector: 'SWITCH_TAB',
      confidence: 1,
      verified: true,
      action: 'SUCCESS',
    });
  });

  it('waits for the newly activated tab before returning', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 2 }, deps);
    expect(deps.waitForTabLoad).toHaveBeenCalledWith(2, SWITCH_TAB_LOAD_MS);
  });

  it('records a session for the tab, best-effort', async () => {
    const deps = makeSwitchDeps();
    await switchTab({ tabId: 2 }, deps);
    expect(deps.trackTabSession).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ url: expect.any(String) })
    );
  });
});

describe('the generic forward hands the action to the content script', () => {
  it('sends EXECUTE to the driven tab and returns the result', async () => {
    const deps = makeForwardDeps();
    sendMessage.mockResolvedValue({ ok: true, note: 'clicked' });
    const r = await forwardToContentScript({ type: 'CLICK', targetId: 'e12' }, deps);
    expect(sendMessage).toHaveBeenCalledWith(1, {
      type: 'EXECUTE',
      action: { type: 'CLICK', targetId: 'e12' },
    });
    expect(r).toEqual({ ok: true, note: 'clicked' });
  });

  it('logs a failure as FAILURE with the error', async () => {
    const deps = makeForwardDeps();
    sendMessage.mockResolvedValue({ ok: false, error: 'element gone' });
    await forwardToContentScript({ type: 'CLICK', targetId: 'e12' }, deps);
    expect(deps.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FAILURE', verified: false, error: 'element gone' })
    );
  });

  it('reports no tab without logging anything', async () => {
    const deps = makeForwardDeps({ driveTab: vi.fn(async () => undefined) });
    const r = await forwardToContentScript({ type: 'CLICK' }, deps);
    expect(r).toEqual({ ok: false, error: 'No web tab found' });
    expect(deps.logExecution).not.toHaveBeenCalled();
  });
});

describe('a navigation mid-action is a success, not a failure', () => {
  // A click that navigates tears down the content port before it can reply
  // (#86). Reporting that as a failure makes the planner retry a click that
  // already worked.
  it.each([
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
    'No recipient frame with id 12',
    'disconnected',
  ])('treats %s as a navigation, not a failure', async (msg) => {
    const deps = makeForwardDeps();
    sendMessage.mockRejectedValue(new Error(msg));
    const r = await forwardToContentScript({ type: 'CLICK', targetId: 'e12' }, deps);
    expect(r.ok).toBe(true);
    expect(r.note).toContain('page navigated');
  });

  it('logs the navigation as a verified SUCCESS', async () => {
    const deps = makeForwardDeps();
    sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    await forwardToContentScript({ type: 'CLICK', targetId: 'e12' }, deps);
    expect(deps.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUCCESS', verified: true })
    );
  });

  it('still reports a genuine failure', async () => {
    const deps = makeForwardDeps();
    sendMessage.mockRejectedValue(new Error('permission denied on this frame'));
    const r = await forwardToContentScript({ type: 'CLICK' }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('permission denied');
    expect(deps.logExecution).not.toHaveBeenCalled();
  });

  it('the matcher does not fire on an ordinary error mentioning "closed"', () => {
    // "closed" alone is too loose: a form validation error can read "field is
    // closed" and be a real failure. Reporting it as a successful navigation
    // would hide a real error from the ledger AND tell the planner not to
    // retry.
    expect(isNavigationDisconnect('The dropdown is closed')).toBe(false);
  });
});

describe('the port-error policy has exactly one home', () => {
  // Found during this extraction: the EXECUTE message handler carried a SECOND
  // copy of the same regex. Tightening the extracted module would have left
  // that one still calling "the dropdown is closed" a navigation - the drift
  // #190's review caught in the URL policy, one file over.
  const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');

  it('leaves no inline copy of the pattern in the service worker', () => {
    // Scoped to CODE, not raw text: withPortRetry's docstring quotes the
    // Chrome message ("Receiving end does not exist") when explaining what it
    // retries. A blanket substring check fails on that comment - and a test
    // that has to be weakened to accommodate a comment is the wrong shape.
    // The pattern is a regex literal, so look for the literal.
    expect(bg).not.toMatch(/\/disconnect\|/);
    expect(bg).not.toMatch(/No recipient\|closed/);
  });

  it('routes both call sites through the shared policy', () => {
    // 1 = the EXECUTE message handler here. The generic forward moved into
    // lib/executeChannel.ts and calls the function directly.
    const uses = (bg.match(/isNavigationDisconnect\(/g) ?? []).length;
    expect(uses).toBe(1);
  });
});
