/**
 * #192 — a relative NAVIGATE target silently failed.
 *
 * There is no page context in a service worker, so `/profile` used to resolve
 * against a placeholder host and the navigation simply did not happen. The
 * planner never said a NAVIGATE url had to be absolute, and it only checked
 * that a url was PRESENT, not what shape it was — so a relative url from the
 * LLM passed every check and then failed at the browser.
 *
 * Fixed in two places:
 *   1. resolveNavUrl takes an optional real `base`, so a relative target
 *      resolves against the tab the agent is actually on.
 *   2. The planner prompt now states the url must be absolute.
 *
 * A third layer: when neither can help, the error says so precisely instead of
 * the generic "invalid url", which would send the planner hunting a syntax
 * problem that does not exist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveNavUrl } from '../src/lib/navUrl';

const PAGE = 'https://bank.example/dashboard';

describe('a real base makes relative targets work', () => {
  it.each([
    ['/profile', 'https://bank.example/profile'],
    // 'profile' against '/dashboard' resolves to '/profile', not
    // '/dashboard/profile' - the last segment is replaced. I asserted the
    // latter when writing the test; the implementation is right.
    ['profile', 'https://bank.example/profile'],
    ['./profile', 'https://bank.example/profile'],
    ['../up', 'https://bank.example/up'],
    ['?tab=2', 'https://bank.example/dashboard?tab=2'],
    ['#section', 'https://bank.example/dashboard#section'],
    ['//other.example/x', 'https://other.example/x'],
  ])('resolves %j against the current page', (target, expected) => {
    const r = resolveNavUrl(target, PAGE);
    expect(r.ok).toBe(true);
    expect(r.url).toBe(expected);
    // The whole point: it no longer needs a placeholder.
    expect(r.needsBase).toBe(false);
  });

  it('an absolute target ignores the base entirely', () => {
    const r = resolveNavUrl('https://other.example/x', PAGE);
    expect(r.url).toBe('https://other.example/x');
    expect(r.needsBase).toBe(false);
  });
});

describe('needsBase tells the caller the url will not load', () => {
  it.each(['/profile', 'profile', '?tab=2', '#s', 'bank.example/x'])(
    'flags %j when no base is available',
    (target) => {
      const r = resolveNavUrl(target);
      expect(r.ok).toBe(true); // the SCHEME check passes...
      expect(r.url).toContain('.invalid'); // ...but it lands nowhere
      expect(r.needsBase).toBe(true); // ...and the caller must know
    }
  );

  it('does not flag an absolute or protocol-relative target', () => {
    // These carry their own authority, so no base was needed and there is
    // nothing to warn about.
    for (const t of ['https://x.example/a', 'http://x.example/a', '//x.example/a']) {
      expect(resolveNavUrl(t).needsBase).toBe(false);
    }
  });
});

describe('a hostile or unusable base cannot widen what is reachable', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome://settings',
    'not a url',
    '/relative/base',
    '',
    '   ',
  ])('ignores the non-http(s) base %j', (base) => {
    // If a bad base were honoured, `/x` would resolve onto that base's origin.
    // It must fall back to the placeholder instead.
    const r = resolveNavUrl('/x', base);
    expect(r.ok).toBe(true);
    expect(r.url).toContain('.invalid');
    expect(r.needsBase).toBe(true);
  });

  it('ignores a non-string base', () => {
    for (const base of [undefined, null, 42, {}, ['https://x.example']]) {
      const r = resolveNavUrl('/x', base as unknown as string);
      expect(r.url).toContain('.invalid');
      expect(r.needsBase).toBe(true);
    }
  });

  it('a javascript: target is refused even WITH a valid base', () => {
    // The base must not become a way to smuggle a dangerous scheme through.
    const r = resolveNavUrl('javascript:alert(1)', PAGE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('javascript:');
  });

  it('a relative base cannot be chained to escape onto another host', () => {
    // `//evil.example` as a base is protocol-relative and has no protocol, so
    // it is not a usable absolute base.
    const r = resolveNavUrl('/x', '//evil.example');
    expect(r.url).toContain('.invalid');
  });
});

describe('#192 review: the ordering and the prompt', () => {
  const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');
  // Since #159 step 2 the planner navigation path lives in lib/navChannel.ts;
  // background.ts keeps only the wiring adapter and the NAVIGATE_TAB handler.
  const navChannel = readFileSync('src/lib/navChannel.ts', 'utf-8');
  const planner = readFileSync('server/planner.py', 'utf-8');

  it('resolves the tab before the url, so a real base exists', () => {
    // driveTab must come BEFORE resolveNavUrl in navigateChannel. If the url
    // were resolved first there would be no tab, and therefore no base, and
    // the fix would silently do nothing.
    //
    // Scoped to the function body - it ends at the first line that is exactly
    // `}` at column 0 (the module-level function's closing brace). Searching
    // for a following `const` name is fragile: an earlier version looked for
    // `const executeChannel`, which is defined BEFORE this one, so the search
    // returned -1 and the slice silently covered the wrong region.
    //
    // Read from lib/navChannel.ts since #159 step 2; the adapter left in
    // background.ts is wiring only and has no ordering to preserve.
    const i = navChannel.indexOf('export async function navigateChannel');
    const end = navChannel.indexOf('\n}', i);
    expect(end).toBeGreaterThan(i);
    const body = navChannel.slice(i, end);
    const driveAt = body.indexOf('deps.driveTab()');
    const resolveAt = body.indexOf('resolveNavUrl(url');
    expect(driveAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(driveAt).toBeLessThan(resolveAt);
  });

  it('passes the tab current url as the base', () => {
    // And currentUrl must come from the tab, freshly read. Whitespace- and
    // dot-tolerant: Prettier wraps this chain as
    //   browser.tabs\n    .get(tabId)\n    .then(...)
    // so a strict `browser.tabs.get` never matches the formatted source.
    const flat = navChannel.replace(/\s+/g, ' ');
    expect(flat).toMatch(/browser\.tabs\s*\.\s*get\(tabId\)\s*\.\s*then\(\(t\) => t\.url\)/);
    expect(flat).toMatch(/resolveNavUrl\(url, currentUrl\)/);
  });

  it('reports a precise reason instead of the generic "invalid url"', () => {
    // "invalid url" would send the planner looking for a syntax error that is
    // not there. Both branches must name the real problem. One branch is in
    // the extracted module, the other in the message handler still inline.
    expect(navChannel).toContain('relative url but the current page url is unknown');
    expect(navChannel).toContain('relative url could not be resolved');
    expect(bg).toContain('relative url but the current page url is unknown');
    expect(bg).toContain('relative url could not be resolved');
  });

  it('gives the NAVIGATE_TAB handler a base too', () => {
    // Review of #191: the handler was still calling resolveNavUrl with NO
    // base and ignoring needsBase, so a relative url there "navigated" to the
    // placeholder host. Fixed in the same change; this guards it.
    const i = bg.indexOf("case 'NAVIGATE_TAB'");
    const body = bg.slice(i, i + 3000);
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toMatch(/resolveNavUrl\(target, currentUrl\)/);
    expect(body).toContain('nav.needsBase');
  });

  it('both navigation paths handle needsBase', () => {
    // Two call sites in TWO files, each of which must refuse rather than
    // navigate to the placeholder. Counted across both so a third copy cannot
    // appear unnoticed - a duplicated needsBase check is the #191 bug waiting
    // to come back.
    const flat = (bg + navChannel).replace(/\s+/g, ' ');
    const needsBaseChecks = flat.match(/if \(nav\.needsBase\)/g) ?? [];
    expect(needsBaseChecks.length).toBe(2);
  });

  it('the planner prompt now requires an absolute url', () => {
    // Without this the LLM keeps emitting relative urls and the runner keeps
    // rejecting them.
    expect(planner).toMatch(/MUST be absolute/);
    expect(planner).toMatch(/https:\/\/.*http:\/\//);
  });
});
