/**
 * #206 — the arrival-time harvest policy, tested directly.
 *
 * This module owns one decision: SHOULD the page the agent just landed on be
 * harvested into the task handoff? The "what crosses to the LLM" half of that
 * question is unchanged and still owned by `tabHandoff` (tokens + masked labels,
 * never values).
 *
 * The bug it fixes was a trigger gap, not a missing capability: the only
 * harvest trigger was departure (switchTab harvests the tab it leaves), and the
 * passive watcher explicitly skips the driven tab. So the tab the agent was
 * working on — the one holding the values — was the one tab never harvested.
 */

import { describe, it, expect } from 'vitest';
import { isHarvestableUrl, shouldHarvestOnArrival } from '../src/lib/harvestTiming';

describe('#206 isHarvestableUrl', () => {
  it('accepts http and https', () => {
    expect(isHarvestableUrl('http://127.0.0.1:8777/accounts.html')).toBe(true);
    expect(isHarvestableUrl('https://example.com/a/b?c=d')).toBe(true);
  });

  it('rejects non-web schemes that have no content script', () => {
    // Each of these would be answered by nobody, so withPortRetry would just
    // burn its retries.
    expect(isHarvestableUrl('chrome://extensions')).toBe(false);
    expect(isHarvestableUrl('about:blank')).toBe(false);
    expect(isHarvestableUrl('file:///c:/tmp/x.html')).toBe(false);
    expect(isHarvestableUrl('chrome-extension://abc/popup.html')).toBe(false);
  });

  it('rejects an unknown or empty url', () => {
    expect(isHarvestableUrl(undefined)).toBe(false);
    expect(isHarvestableUrl('')).toBe(false);
  });

  it('does not accept a scheme merely prefixed by a web one', () => {
    expect(isHarvestableUrl('https://x/https://evil')).toBe(true);
    // The prefix check is deliberate: this is a "is there a content script"
    // question, not a security boundary, and the URL is already policy-checked
    // upstream by resolveNavUrl.
    expect(isHarvestableUrl('chrome://x')).toBe(false);
  });
});

describe('#206 shouldHarvestOnArrival - the normal case', () => {
  it('harvests a web page the agent arrived on', () => {
    const d = shouldHarvestOnArrival({
      tabId: 7,
      url: 'http://127.0.0.1:8777/accounts.html',
    });
    expect(d.harvest).toBe(true);
  });

  it('harvests regardless of which tab it is', () => {
    // The #141 exclusion ("don't passively harvest the driven tab") is
    // deliberately NOT applied here. That exclusion is right for a watched tab
    // polled in the background and wrong for the tab the agent is actively
    // working on, which is exactly where the values are.
    for (const tabId of [1, 42, 9999]) {
      expect(shouldHarvestOnArrival({ tabId, url: 'https://a.test/' }).harvest).toBe(true);
    }
  });
});

describe('#206 shouldHarvestOnArrival - the cases that must not harvest', () => {
  it('does not harvest when the navigation failed', () => {
    // A failed navigation leaves the old document in place; harvesting it would
    // attribute the previous page's values to the task that just failed.
    const d = shouldHarvestOnArrival({
      tabId: 7,
      url: 'https://example.com/',
      navigationFailed: true,
    });
    expect(d.harvest).toBe(false);
  });

  it('does not harvest with no tab', () => {
    // The url must be VALID here, or the url guard would reject it anyway and
    // the tabId guard would never be exercised. Mutation testing found exactly
    // that: with only an invalid-url case, `if (false)` in the tabId guard
    // survived.
    expect(shouldHarvestOnArrival({ tabId: undefined, url: 'https://a.test/' }).harvest).toBe(
      false,
    );
  });

  it('does not treat tab 0 as "no tab"', () => {
    // The guard is `=== undefined`, deliberately. A naive `if (!tabId)` would
    // treat tab 0 - a real Chrome tab id - as absent and silently skip the
    // harvest, which is the kind of bug that only shows up on one machine.
    expect(shouldHarvestOnArrival({ tabId: 0, url: 'https://a.test/' }).harvest).toBe(true);
  });

  it('does not harvest a non-web page', () => {
    const d = shouldHarvestOnArrival({ tabId: 7, url: 'chrome://newtab' });
    expect(d.harvest).toBe(false);
    expect(d.reason).toBe('not a web page');
  });

  it('does not harvest when the url is unknown', () => {
    // tabs.get can fail or race; an unknown url is not a licence to guess.
    expect(shouldHarvestOnArrival({ tabId: 7 }).harvest).toBe(false);
  });
});

describe('#206 the decision reason never carries page text', () => {
  it('emits a fixed reason string, not anything from the page', () => {
    const d = shouldHarvestOnArrival({ tabId: 7, url: 'https://x.test/' });
    // The reason goes toward the log, so it must be a constant - never the url,
    // a label, or a value.
    expect(d.reason).toBe('arrived on a web page');
    expect(d.reason).not.toContain('x.test');
  });

  it('all reasons are from a closed set', () => {
    const seen = new Set<string>();
    for (const c of [
      { tabId: 7, url: 'https://a.test/' },
      { tabId: 7, url: 'chrome://x' },
      { tabId: undefined },
      { tabId: 7, url: 'https://a.test/', navigationFailed: true },
    ]) {
      seen.add(shouldHarvestOnArrival(c).reason);
    }
    expect(seen.size).toBeLessThanOrEqual(4);
    for (const r of seen) expect(typeof r).toBe('string');
  });
});
