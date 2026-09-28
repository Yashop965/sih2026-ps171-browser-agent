/**
 * #206 — when should a page be harvested into the task handoff?
 *
 * The rule, stated once so it can be tested without a browser:
 *
 *   A page is worth harvesting when the agent has ARRIVED on it, not only when
 *   it leaves. A task that reads a value and then types it somewhere else reads
 *   it while it is still ON the page — so harvesting on departure alone leaves
 *   the source page's own values out of the handoff for the entire run.
 *
 * Observed live: a complex task scored 0/12 because the agent sat on the data
 * page the whole time and the handoff stayed empty (`need to fill 0 fields`).
 *
 * This module owns only the *timing* decision. What crosses to the LLM is
 * unchanged and still governed by `handoffForPlanner` (tokens + masked labels,
 * never values) and `resolveHandoffValue` (on-device swap at write time).
 */

/** A page worth harvesting, or a reason not to. */
export interface HarvestDecision {
  harvest: boolean;
  /** Short reason, for the log. Never carries page text or PII. */
  reason: string;
}

export interface HarvestCandidate {
  /** The tab the agent just landed on, if the navigation succeeded. */
  tabId: number | undefined;
  /** The url now in that tab, when known. */
  url?: string;
  /** True when the navigation itself failed. */
  navigationFailed?: boolean;
}

/** Non-web schemes have no content script to answer. */
export function isHarvestableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Should the agent harvest the page it just arrived on?
 *
 * Yes, unless the navigation failed or the page is not a web page. The
 * exclusions that existed before this (#141's "don't passively harvest the
 * driven tab") are deliberately NOT applied here: that exclusion is correct
 * for a *watched* tab being polled in the background, and wrong for the tab the
 * agent is actively working on, which is precisely where the values are.
 */
export function shouldHarvestOnArrival(candidate: HarvestCandidate): HarvestDecision {
  if (candidate.navigationFailed) {
    return { harvest: false, reason: 'navigation failed - nothing to read' };
  }
  if (candidate.tabId === undefined) {
    return { harvest: false, reason: 'no tab' };
  }
  if (!isHarvestableUrl(candidate.url)) {
    // chrome://, about:, file: - no content script, so the message would be
    // answered by nothing and `withPortRetry` would just burn its retries.
    return { harvest: false, reason: 'not a web page' };
  }
  return { harvest: true, reason: 'arrived on a web page' };
}
