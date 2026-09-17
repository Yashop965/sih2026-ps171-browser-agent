/**
 * Goal backstop — issue #100 fast path.
 *
 * The planner is stateless across pages and (with a flaky small model) often
 * keeps signalling DONE-with-open-items or re-doing work even though the
 * target page is already on screen. This module is the DETERMINISTIC fix:
 * no LLM, no model — pure URL/title matching against the runner's checklist.
 *
 * For each OPEN checklist item we decide whether the current page
 * (URL + title) is "the goal" for that item:
 *   - quoted spans in the item ("…'Progressive web app'…") are checked first;
 *   - otherwise the item's content tokens (stopwords removed) must be
 *     substantially present in the page title/URL.
 *
 * An item the backstop confirms is returned as `autoDone` so the runner can
 * flip it (sticky-merge already makes done permanent). The vision model
 * (Florence-2, the optional confirm path) is NOT needed here — this is what
 * kills the "stuck at 2/4 for 40 steps" symptom with zero new dependencies.
 *
 * Pure + exported: unit-testable with no live browser.
 */

// Common English stop words for checklist descriptions.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'with', 'from',
  'that', 'this', 'it', 'its', 'at', 'as', 'when', 'after', 'then', 'so',
  'we', 'you', 'i', 'he', 'she', 'they', 'them', 'his', 'her', 'our', 'your',
  'open', 'opened', 'click', 'clicked', 'search', 'searched', 'look', 'lookup',
  'up', 'looked', 'navigate', 'navigated', 'visit', 'visited', 'find', 'found',
  'go', 'went', 'article', 'page', 'link', 'result', 'results', 'tab',
]);

/** Normalize a string for matching: lowercase, drop punctuation + url-slug
 *  separators, collapse whitespace. "Progressive_web-app" -> "progressive webapp"?
 *  No — we split tokens after normalization so slugs and prose compare fairly:
 *  "progressive_web_app" -> "progressive web app" -> token set.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-–—/\\|<>]/g, ' ') // slug + path separators -> spaces
    .replace(/[^a-z0-9$@.!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter(Boolean));
}

/**
 * Pull out quoted spans ('x', "x", «x») — the planner's way of naming an
 * exact target. Returns [] when there are none.
 */
export function quotedSpans(description: string): string[] {
  const spans: string[] = [];
  const re = /['«""]([^'»""]{2,})['»""]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) spans.push(m[1].trim());
  return spans;
}

/** Content tokens of a description: stopwords dropped. */
export function contentTokens(description: string): string[] {
  return [...tokens(description)].filter((t) => !STOPWORDS.has(t));
}

/** Does phrase p occur in text t (prose), allowing p itself to be a phrase? */
function phraseInText(phrase: string, text: string): boolean {
  const a = normalize(phrase);
  const b = normalize(text);
  if (a.length < 4) return false; // too short to be a reliable target
  return b.includes(a);
}

/** Fraction of a's content tokens present in b's token set (0..1). */
function tokenOverlap(a: string, b: string): number {
  const at = contentTokens(a);
  if (at.length === 0) return 0;
  const bt = tokens(b);
  const hit = at.filter((t) => bt.has(t)).length;
  return hit / at.length;
}

export interface GoalBackstopInput {
  /** The one open checklist item being tested. */
  item: { id: string; description?: string };
  /** Current page URL (may be empty in odd contexts). */
  url: string;
  /** Current page title (may be empty). */
  title: string;
}

export interface GoalBackstopVerdict {
  /** true when the page satisfies the item. */
  done: boolean;
  /** How we decided (for logging / transparency). */
  reason: 'quoted-in-title' | 'quoted-in-url' | 'tokens-in-title' | 'tokens-in-url' | 'no-signal' | 'insufficient';
  /** The signal text (phrase or token list) that fired. */
  signal?: string;
  /** Score in [0,1] for the strongest candidate rule (0 when none). */
  score: number;
}

/**
 * Decide whether the current page (url+title) satisfies one open checklist
 * item. Deliberately conservative: a miss is ALWAYS "not done" (the runner
 * keeps looping), a hit must be unambiguous.
 */
export function goalBackstop(input: GoalBackstopInput): GoalBackstopVerdict {
  const { item, url, title } = input;
  const desc = (item.description ?? '').trim();

  // URL signals use only host + last path segment ("the page slug"). Query
  // strings (e.g. ?search=Progressive_web_app on a search-results page) are
  // deliberately excluded so a SEARCHED-FOR item doesn't confirm before the
  // article is actually OPEN.
  let urlHost = '';
  let urlSlug = '';
  if (url) {
    try {
      const u = new URL(url);
      urlHost = u.hostname;
      const segs = u.pathname.split('/').filter(Boolean);
      urlSlug = segs.length ? segs[segs.length - 1] : '';
    } catch {
      urlHost = '';
      urlSlug = url;
    }
  }

  // 1) quoted spans — exact target names
  for (const span of quotedSpans(desc)) {
    if (phraseInText(span, title)) {
      return { done: true, reason: 'quoted-in-title', signal: span, score: 1 };
    }
    if (urlSlug && phraseInText(span, urlSlug)) {
      return { done: true, reason: 'quoted-in-url', signal: span, score: 1 };
    }
    if (urlHost && phraseInText(span, urlHost)) {
      return { done: true, reason: 'quoted-in-url', signal: span, score: 0.9 };
    }
  }

  // 2) token overlap (only when the description actually has content words)
  const descTokens = contentTokens(desc);
  if (descTokens.length === 0) {
    return { done: false, reason: 'no-signal', score: 0 };
  }
  const titleScore = tokenOverlap(desc, title);
  const urlScore = urlSlug ? tokenOverlap(desc, urlSlug) : 0;
  const best = Math.max(titleScore, urlScore);
  // Require a strong majority of the item's content words to be present.
  if (best >= 0.8) {
    const viaTitle = titleScore >= urlScore;
    return {
      done: true,
      reason: viaTitle ? 'tokens-in-title' : 'tokens-in-url',
      signal: descTokens.join(' '),
      score: best,
    };
  }
  return { done: false, reason: 'insufficient', score: best };
}
