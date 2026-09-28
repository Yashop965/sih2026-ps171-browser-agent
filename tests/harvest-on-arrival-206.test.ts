/**
 * #206 — the arriving page is harvested, not only the departing one.
 *
 * ## The defect, observed live
 *
 * A complex E2E task ("read these values off two tables, then fill a form with
 * them") scored 0/12. The log said why in its first line:
 *
 *     Calculated max steps: 20 (need to fill 0 fields)
 *
 * and the agent's own opening note on that page was `Elements: 2 total
 * (0 inputs, 0 selects, 0 buttons)` — two nav links and a print button. The
 * eight `<th>/<td>` value pairs it needed were right there in the DOM.
 *
 * ## The capability was never missing
 *
 * `harvestFields()` reads those pairs correctly, and the PII panel independently
 * proved the DOM read works: it reported the account email and the tax
 * identifier with `td`-cell selectors, on that same page.
 *
 * So this is not a read failure and not a #189 filter rejection. It is a
 * **trigger gap**. `harvestTabIntoHandoff` is called from exactly one place:
 *
 *     // switchTab(), executeChannel.ts
 *     const from = await deps.driveTab();
 *     // Harvest the LEAVING tab first, while it is still the one being driven
 *     if (from !== undefined) await deps.harvestIntoHandoff(from);
 *
 * and the passive re-perception path explicitly excludes the driven tab:
 *
 *     if (currentTargetTab?.tabId === tabId) return;  // "would only add noise"
 *
 * **Net effect: the tab the agent is currently on is the one tab that is never
 * harvested.** The design harvests on departure; the task needs data on
 * arrival. In the failing run the agent started on the data page and never
 * switched away before the data mattered, so the handoff stayed empty for the
 * whole run.
 *
 * ## What is NOT changing
 *
 * The #141 privacy firewall is untouched. `handoffForPlanner` still returns
 * `{token, label}[]` and never a value; `resolveHandoffValue` still swaps the
 * token for the real value on-device at write time. This only decides WHEN a
 * page is read, never WHAT crosses to the LLM.
 *
 * ## Why these tests execute the code
 *
 * An earlier version of this file matched source text, and mutation testing
 * showed three real defects surviving it: dropping the policy gate, never
 * calling the hook at all, and never harvesting at task start all left every
 * assertion green. A source-reading test cannot fail when the wiring is gone.
 * These drive `navigateChannel` with fakes and assert on observed effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { navigateChannel } from '../src/lib/navChannel';

let tabsGet: (id: number) => Promise<{ url?: string; windowId?: number }>;
let tabsUpdate: (id: number, info: { url: string }) => Promise<unknown>;

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      get: (id: number) => tabsGet(id),
      update: (id: number, info: { url: string }) => tabsUpdate(id, info),
    },
  },
}));

interface Order {
  log: string[];
}

function makeDeps(order: Order) {
  return {
    driveTab: async () => 7,
    logExecution: () => {
      order.log.push('logExecution');
    },
    onTargetChanged: (t: { tabId: number }) => {
      order.log.push(`onTargetChanged:${t.tabId}`);
    },
    waitForTabLoad: async () => {
      order.log.push('waitForTabLoad');
    },
    onNavigated: async (tabId: number, url: string) => {
      order.log.push(`onNavigated:${tabId}:${url}`);
    },
  };
}

beforeEach(() => {
  tabsGet = async () => ({ url: 'https://target.test/form', windowId: 1 });
  tabsUpdate = async () => ({});
});

describe('#206 a successful navigation harvests the page it landed on', () => {
  it('calls onNavigated with the tab it arrived in', async () => {
    const order: Order = { log: [] };
    const r = await navigateChannel('https://target.test/form', makeDeps(order));
    expect(r.ok).toBe(true);
    expect(order.log.some((l) => l.startsWith('onNavigated:7'))).toBe(true);
  });

  it('uses the url the tab ACTUALLY has, not the requested one', async () => {
    // A redirect means the requested url is the wrong thing to attribute
    // the values to.
    tabsGet = async () => ({ url: 'https://target.test/after-redirect', windowId: 1 });
    const order: Order = { log: [] };
    await navigateChannel('https://target.test/form', makeDeps(order));
    expect(order.log).toContain('onNavigated:7:https://target.test/after-redirect');
  });

  it('harvests AFTER the load settled', async () => {
    // Before the load it would read the OLD document - the original bug.
    const order: Order = { log: [] };
    await navigateChannel('https://target.test/form', makeDeps(order));
    expect(order.log.indexOf('waitForTabLoad')).toBeLessThan(
      order.log.findIndex((l) => l.startsWith('onNavigated'))
    );
  });

  it('harvests AFTER the pinned target is re-asserted', async () => {
    // Otherwise it could read the wrong tab and merge foreign values in.
    const order: Order = { log: [] };
    await navigateChannel('https://target.test/form', makeDeps(order));
    expect(order.log.indexOf('onTargetChanged:7')).toBeLessThan(
      order.log.findIndex((l) => l.startsWith('onNavigated'))
    );
  });
});

describe('#206 the arrival harvest cannot fail a navigation that worked', () => {
  it('a throwing onNavigated still reports success', async () => {
    const order: Order = { log: [] };
    const deps = {
      ...makeDeps(order),
      onNavigated: async () => {
        throw new Error('content script did not answer');
      },
    };
    const r = await navigateChannel('https://target.test/form', deps);
    expect(r.ok).toBe(true);
  });

  it('a rejected onNavigated still reports success', async () => {
    const order: Order = { log: [] };
    const deps = { ...makeDeps(order), onNavigated: () => Promise.reject(new Error('x')) };
    const r = await navigateChannel('https://target.test/form', deps);
    expect(r.ok).toBe(true);
  });

  it('still logs the successful navigation', async () => {
    const order: Order = { log: [] };
    const deps = {
      ...makeDeps(order),
      onNavigated: async () => {
        throw new Error('boom');
      },
    };
    await navigateChannel('https://target.test/form', deps);
    expect(order.log).toContain('logExecution');
  });

  it('navigates fine with no onNavigated wired at all', async () => {
    // The hook is optional, so a caller that does not want harvesting is not
    // forced to pass a no-op.
    const order: Order = { log: [] };
    const deps: Record<string, unknown> = { ...makeDeps(order) };
    delete deps.onNavigated;
    const r = await navigateChannel('https://target.test/form', deps as never);
    expect(r.ok).toBe(true);
  });
});

describe('#206 the policy gate decides which pages are read', () => {
  it('does not harvest when the arrived url is not a web page', async () => {
    // e.g. a navigation that resolved to chrome:// - no content script there,
    // so the message would be answered by nobody.
    tabsGet = async () => ({ url: 'chrome://newtab', windowId: 1 });
    const order: Order = { log: [] };
    const r = await navigateChannel('https://target.test/form', makeDeps(order));
    expect(r.ok).toBe(true);
    expect(order.log.some((l) => l.startsWith('onNavigated'))).toBe(false);
  });

  it('does not harvest a refused url', async () => {
    // A refused url never navigates, so there is nothing to read.
    const order: Order = { log: [] };
    const r = await navigateChannel('javascript:alert(1)', makeDeps(order));
    expect(r.ok).toBe(false);
    expect(order.log.some((l) => l.startsWith('onNavigated'))).toBe(false);
  });
});

describe('#206 the arrival harvest is AWAITED, not fired and forgotten', () => {
  it('navigateChannel does not resolve until the harvest has finished', async () => {
    // The strongest form of this test. A floating promise here is a real race,
    // not a style point: the run's very next action is a /plan call, and if the
    // harvest has not landed the planner sees an empty handoff and sizes itself
    // with `need to fill 0 fields` - the exact 0/12 failure this change exists
    // to fix. Only an ordering assertion can catch it, because a text match on
    // `await` does not distinguish a real await from a comment.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finished = false;
    const order: Order = { log: [] };
    const deps = {
      ...makeDeps(order),
      onNavigated: async () => {
        await gate;
        finished = true;
      },
    };
    const nav = navigateChannel('https://target.test/form', deps);
    // Let the navigation reach the hook and block on the gate.
    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toBe(false);
    // The navigation promise must STILL be pending - that is the assertion.
    let settled = false;
    void nav.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    release();
    const r = await nav;
    expect(r.ok).toBe(true);
    expect(finished).toBe(true);
  });
});

describe('#206 the departing-tab harvest is not replaced', () => {
  it('switchTab still harvests the tab it leaves', () => {
    // A page the agent reads and then leaves must still contribute, and a page
    // it never returns to would otherwise be lost.
    const src = readFileSync('src/lib/executeChannel.ts', 'utf-8');
    expect(src).toMatch(/harvestIntoHandoff\(from\)/);
  });

  it('a run also harvests the page it STARTS on', () => {
    // The case the live 0/12 run hit: the agent began on the data page and
    // stayed there, so departure harvesting could never fire.
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    // The LAST resetCrossTabState() is the one in startTask; an earlier
    // unrelated one would make a naive "first match" search pass vacuously.
    const at = src.lastIndexOf('resetCrossTabState();');
    expect(at).toBeGreaterThan(0);
    // The explanatory comment sits between the two, so the window has to be
    // generous - but bounded, so this cannot match something far downstream.
    const block = src.slice(at, at + 1600);
    expect(block).toMatch(/harvestTabIntoHandoff\(active\.id\)/);
    expect(block).toMatch(/browser\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
  });

  it('the start harvest reads the tab the user is actually looking at', () => {
    // A harvest of the wrong tab is worse than none: it merges a stranger's
    // values into this task's handoff. The query must be the active tab in the
    // current window, not a remembered target.
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    const at = src.lastIndexOf('resetCrossTabState();');
    const block = src.slice(at, at + 1600);
    expect(block).toMatch(/const \[active\] = await browser\.tabs\.query/);
    // Not the pinned target, which may be a previous run's tab.
    expect(block).not.toMatch(/currentTargetTab\?\.tabId\)\s*await harvestTabIntoHandoff/);
  });

  it('the start harvest is AWAITED, not fired and forgotten', () => {
    // An earlier version used `void (async () => ...)` to keep the first /plan
    // fast. The live run proved that wrong: the harvest lost the race to step
    // 1's plan request, the planner got an empty handoff, and the run still
    // logged `need to fill 0 fields` - the exact failure this change exists to
    // fix. So the read must complete before the runner asks the planner what to
    // do. This test is the regression guard for that specific reversal.
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    const at = src.lastIndexOf('resetCrossTabState();');
    const block = src.slice(at, at + 1600);
    expect(block).toMatch(
      /const \[active\] = await browser\.tabs\.query[\s\S]{0,200}await harvestTabIntoHandoff\(active\.id\);/
    );
    // No floating promise around it any more.
    expect(block).not.toMatch(/void \(async \(\) => \{/);
  });

  it('the whole start-harvest body is wrapped in a try', () => {
    // Awaiting does not mean unguarded: a content script that does not answer
    // must not reject out of startTask.
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    const at = src.lastIndexOf('resetCrossTabState();');
    const block = src.slice(at, at + 1600);
    const tryAt = block.indexOf('try {');
    const queryAt = block.indexOf('browser.tabs.query');
    const catchAt = block.indexOf('} catch {');
    expect(tryAt).toBeGreaterThan(-1);
    expect(queryAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(queryAt);
  });
});

describe('#206 the arrival hook is wired to the SAME harvest as departure', () => {
  it('background passes a real harvest, not a no-op', () => {
    // Mutation testing showed `onNavigated: async () => {}` passing every
    // assertion above: navigateChannel's own tests inject their own hook, so
    // nothing checked that the SW actually connects the two. Without this the
    // whole feature is dead code in production while fully green.
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    expect(src).toMatch(
      /onNavigated: async \(tabId: number\) => \{\s*await harvestTabIntoHandoff\(tabId\);\s*\},/
    );
  });

  it('and it is wired into navigateChannel, not left dangling', () => {
    const src = readFileSync('src/entrypoints/background.ts', 'utf-8');
    const nav = src.indexOf('navChannel(url, {');
    expect(nav).toBeGreaterThan(-1);
    const deps = src.slice(nav, nav + 2000);
    expect(deps).toMatch(/onNavigated:/);
    expect(deps).toMatch(/waitForTabLoad,/);
  });
});

describe('#206 the privacy firewall is unchanged', () => {
  it('handoffForPlanner returns tokens and labels, never values', () => {
    const t = readFileSync('src/lib/tabHandoff.ts', 'utf-8');
    const body = t.slice(t.indexOf('export function handoffForPlanner'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toMatch(/token/);
    expect(fn).toMatch(/label/);
    expect(fn).not.toMatch(/values\[/);
  });

  it('resolveHandoffValue still resolves on-device at write time', () => {
    const t = readFileSync('src/lib/tabHandoff.ts', 'utf-8');
    const body = t.slice(t.indexOf('export function resolveHandoffValue'));
    expect(body.slice(0, 400)).toMatch(/h\.values\[/);
  });

  it('navChannel adds nothing page-derived to the plan payload', () => {
    const t = readFileSync('src/lib/navChannel.ts', 'utf-8');
    expect(t).not.toMatch(/crossTabMemory/);
  });
});
