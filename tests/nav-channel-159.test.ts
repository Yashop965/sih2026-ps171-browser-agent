/**
 * Behavioural tests for the extracted planner navigation path (#159 step 2).
 *
 * nav-relative-192.test.ts and nav-url-159.test.ts assert the SHAPE of this
 * code - that the tab is resolved before the url, that a base is passed, that
 * a third copy cannot appear. Those are worth keeping, but they would all pass
 * against a function that throws on every input.
 *
 * So: call the real exported `navigateChannel` with stubbed deps and a stubbed
 * `browser.tabs`, and check what it actually does.
 *
 * This replaces no prior coverage. `nav-recoverable-behaviour-192.test.ts`
 * exercises the CONSUMER (agentRunner's NAVIGATE branch, deciding whether a
 * failure ends the run); this exercises the thing that produces the result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browser } from 'wxt/browser';
import { navigateChannel, NAV_LOAD_TIMEOUT_MS, type NavigateDeps } from '../src/lib/navChannel';

vi.mock('wxt/browser', () => ({
  browser: { tabs: { get: vi.fn(), update: vi.fn() } },
}));

const get = browser.tabs.get as unknown as ReturnType<typeof vi.fn>;
const update = browser.tabs.update as unknown as ReturnType<typeof vi.fn>;

/**
 * Build a deps object, keeping the vi.fn handles so tests can assert on them.
 *
 * Typed against the real `NavigateDeps` (no cast on the argument) so a change
 * to the boundary breaks this file at compile time instead of at runtime.
 */
function makeDeps(over: Partial<NavigateDeps> = {}) {
  const deps = {
    driveTab: vi.fn(async () => 7),
    logExecution: vi.fn(),
    onTargetChanged: vi.fn(),
    waitForTabLoad: vi.fn(async () => true),
    ...over,
  };
  return deps as typeof deps & NavigateDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ id: 7, windowId: 3, url: 'https://bank.example/dashboard' });
  update.mockResolvedValue(undefined);
});

describe('a successful navigation', () => {
  it('navigates the driven tab and reports ok', async () => {
    const deps = makeDeps();
    const r = await navigateChannel('https://bank.example/pay', deps);
    expect(r).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(7, { url: 'https://bank.example/pay' });
  });

  it('resolves the tab BEFORE reading its url for the base', async () => {
    // Order matters: with no tab there is no base, so a relative url would
    // resolve against the placeholder. driveTab must win.
    const order: string[] = [];
    const deps = makeDeps({
      driveTab: vi.fn(async () => {
        order.push('driveTab');
        return 7;
      }),
    });
    get.mockImplementation(async () => {
      order.push('tabs.get');
      return { id: 7, windowId: 3, url: 'https://bank.example/dashboard' };
    });
    await navigateChannel('/profile', deps);
    expect(order[0]).toBe('driveTab');
  });

  it('re-asserts the pinned target, keeping the tab window', async () => {
    const deps = makeDeps();
    await navigateChannel('https://bank.example/pay', deps);
    expect(deps.onTargetChanged).toHaveBeenCalledWith({ tabId: 7, windowId: 3 });
  });

  it('falls back to windowId 0 when the tab read fails', async () => {
    // A closed tab must not produce a NaN/undefined windowId in the pinned
    // target - a later tabs.query fallback keys off this.
    get.mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce(null);
    const deps = makeDeps();
    await navigateChannel('https://bank.example/pay', deps);
    expect(deps.onTargetChanged).toHaveBeenCalledWith({ tabId: 7, windowId: 0 });
  });

  it('logs the navigation to the privacy ledger', async () => {
    const deps = makeDeps();
    await navigateChannel('https://bank.example/pay', deps);
    expect(deps.logExecution).toHaveBeenCalledWith({
      tabId: 7,
      url: 'https://bank.example/pay',
      type: 'EXECUTION',
      selector: 'NAVIGATE',
      confidence: 1,
      verified: true,
      action: 'SUCCESS',
    });
  });

  it('waits for the page to load before returning', async () => {
    // Without this the next EXTRACT reads a half-rendered DOM.
    const deps = makeDeps();
    await navigateChannel('https://bank.example/pay', deps);
    expect(deps.waitForTabLoad).toHaveBeenCalledWith(7, NAV_LOAD_TIMEOUT_MS);
  });
});

describe('a refused url is recoverable, not fatal', () => {
  // The distinction is the whole point of #192: a bad instruction should let
  // the planner re-plan, while a broken environment should end the run.
  it.each([
    ['javascript:alert(1)', 'dangerous scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['file:///etc/passwd', 'file scheme'],
  ])('refuses %s as recoverable (%s)', async (url) => {
    const deps = makeDeps();
    const r = await navigateChannel(url, deps);
    expect(r.ok).toBe(false);
    expect(r.recoverable).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([[42], [null], [{ href: 'https://bank.example' }], [['https://bank.example']]])(
    'refuses the non-string %p as recoverable',
    async (url) => {
      const deps = makeDeps();
      const r = await navigateChannel(url, deps);
      expect(r.ok).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(update).not.toHaveBeenCalled();
    }
  );

  it('does not log a refusal to the privacy ledger', async () => {
    // Only real navigations are execution events. Logging a refusal would put a
    // SUCCESS-shaped record in the tamper-evident trail for nothing.
    const deps = makeDeps();
    await navigateChannel('javascript:alert(1)', deps);
    expect(deps.logExecution).not.toHaveBeenCalled();
  });

  it('does not re-assert the pinned target on a refusal', async () => {
    // driveTab has already cleared a dead target and fallen back to the active
    // tab. Re-asserting here would resurrect a tab that is gone.
    const deps = makeDeps();
    await navigateChannel('javascript:alert(1)', deps);
    expect(deps.onTargetChanged).not.toHaveBeenCalled();
  });
});

describe('a relative url resolves against the page the agent is on', () => {
  it.each([
    ['/profile', 'https://bank.example/profile'],
    ['?tab=2', 'https://bank.example/dashboard?tab=2'],
    ['#section', 'https://bank.example/dashboard#section'],
  ])('resolves %s against the live tab url', async (target, expected) => {
    const deps = makeDeps();
    const r = await navigateChannel(target, deps);
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(7, { url: expected });
  });

  it('refuses a relative url when the current page url is unknown', async () => {
    // Both tab reads fail, so there is no base. It must SAY that, not claim
    // "invalid url" and send the planner hunting a syntax error.
    get.mockRejectedValue(new Error('no permission'));
    const deps = makeDeps();
    const r = await navigateChannel('/profile', deps);
    expect(r.ok).toBe(false);
    expect(r.recoverable).toBe(true);
    expect(r.error).toContain('current page url is unknown');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('environment failures stay fatal', () => {
  it('reports no tab without claiming it is recoverable', async () => {
    const deps = makeDeps({ driveTab: vi.fn(async () => undefined) });
    const r = await navigateChannel('https://bank.example/pay', deps);
    expect(r).toEqual({ ok: false, error: 'No web tab found' });
    expect(r.recoverable).toBeUndefined();
  });

  it('reports a thrown error without claiming it is recoverable', async () => {
    const deps = makeDeps({
      driveTab: vi.fn(async () => {
        throw new Error('extension context invalidated');
      }),
    });
    const r = await navigateChannel('https://bank.example/pay', deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('extension context invalidated');
    expect(r.recoverable).toBeUndefined();
  });

  it('never rejects - the runner awaits this channel', async () => {
    // A rejected promise here would surface as a channel that never answers.
    const deps = makeDeps({
      waitForTabLoad: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(navigateChannel('https://bank.example/pay', deps)).resolves.toBeDefined();
  });
});
