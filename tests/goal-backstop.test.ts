// tests/goal-backstop.test.ts — issue #100 fast-path backstop
import { describe, it, expect } from 'vitest';
import {
  goalBackstop,
  normalize,
  quotedSpans,
  contentTokens,
} from '../src/lib/goalBackstop';

const PWA = {
  url: 'https://en.wikipedia.org/wiki/Progressive_web_app',
  title: 'Progressive web app - Wikipedia',
};
const BROWSER = {
  url: 'https://en.wikipedia.org/wiki/Web_browser',
  title: 'Web browser - Wikipedia',
};

describe('goalBackstop — quoted spans', () => {
  it('flags an item when its quoted target is in the title', () => {
    const v = goalBackstop({ item: { id: '1', description: "open 'Progressive web app'" }, ...PWA });
    expect(v.done).toBe(true);
    expect(v.reason).toBe('quoted-in-title');
  });

  it('flags an item when its quoted target is in the URL only', () => {
    // 'wikipedia.org' appears in the host (en.wikipedia.org) but not in the
    // page title, so the only possible hit is the URL check.
    const v = goalBackstop({ item: { id: '2', description: 'visit "wikipedia.org"' }, ...PWA });
    expect(v.done).toBe(true);
    expect(v.reason).toBe('quoted-in-url');
  });

  it('does NOT flag when the quoted target is on a different page', () => {
    const v = goalBackstop({ item: { id: '3', description: "open 'Progressive web app'" }, ...BROWSER });
    expect(v.done).toBe(false);
  });

  it('a search-results page mentioning the target does NOT confirm it', () => {
    // w/index.php?search=Progressive_web_app is the SEARCH step, not the
    // article — the goal ("open the article") is still open here.
    const search = {
      url: 'https://en.wikipedia.org/w/index.php?search=Progressive_web_app',
      title: 'Wikipedia',
    };
    const v = goalBackstop({ item: { id: '7', description: "open 'Progressive web app' article" }, ...search });
    expect(v.done).toBe(false);
  });
});

describe('goalBackstop — token overlap', () => {
  it('flags an item whose content words are mostly in the title', () => {
    const v = goalBackstop({ item: { id: '4', description: 'Progressive web app article' }, ...PWA });
    expect(v.done).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(0.8);
  });

  it('ignores a description with no content words', () => {
    const v = goalBackstop({ item: { id: '5', description: 'open the page' }, ...PWA });
    expect(v.done).toBe(false);
    expect(v.reason).toBe('no-signal');
  });

  it('rejects a weak overlap (different article)', () => {
    const v = goalBackstop({ item: { id: '6', description: 'Progressive web app' }, ...BROWSER });
    expect(v.done).toBe(false);
  });
});

describe('helpers', () => {
  it('normalize turns slug separators into spaces', () => {
    expect(normalize('Progressive_web-app')).toBe('progressive web app');
    expect(normalize('Progressive Web App')).toBe('progressive web app');
  });

  it('quotedSpans pulls single and double quotes', () => {
    expect(quotedSpans("search 'Web browser' then \"PWA\"")).toEqual(['Web browser', 'PWA']);
    expect(quotedSpans('no quotes here')).toEqual([]);
  });

  it('contentTokens drops stopwords', () => {
    expect(contentTokens('open the web browser page')).toEqual(['web', 'browser']);
  });
});
