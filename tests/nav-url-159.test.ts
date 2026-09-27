/**
 * #159 — the NAVIGATE_TAB URL policy, extracted from background.ts.
 *
 * This is the one security check in the service worker that no test could
 * reach: it lived inline in a message handler, so testing it meant standing up
 * a whole background script with a fake `browser.tabs`. It guards the only
 * path that navigates a tab WITHOUT going through the content script, which
 * is precisely why it was worth extracting rather than just tidied.
 *
 * The two rules:
 *   1. only http(s) — a `javascript:` NAVIGATE executes in the page's origin
 *   2. a relative target is RESOLVED, not refused — the planner legitimately
 *      emits `/dashboard`, and refusing it would break multi-page autonomy
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveNavUrl } from '../src/lib/navUrl';

describe('refuses dangerous schemes', () => {
  it.each([
    'javascript:alert(1)',
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)', // case must not smuggle it through
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome://settings',
    'chrome-extension://abc/popup.html',
    'moz-extension://abc/popup.html',
    'ftp://files.example/x',
    'vbscript:msgbox(1)',
    'about:blank',
    'blob:https://x.example/uuid',
  ])('refuses %j', (target) => {
    const r = resolveNavUrl(target);
    expect(r.ok).toBe(false);
    expect(r.url).toBeUndefined();
  });

  // The browser strips tabs/newlines from a URL's scheme, so
  // "java\tscript:alert(1)" is a live javascript: URL. If the policy compared
  // the raw string instead of the parsed protocol, this would navigate.
  it('refuses a scheme obfuscated with a tab or newline', () => {
    for (const t of ['java\tscript:alert(1)', 'javascript\n:alert(1)', 'java\nscript:alert(1)']) {
      const r = resolveNavUrl(t);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('javascript:');
    }
  });

  it('echoes the refused protocol so the caller can log it', () => {
    expect(resolveNavUrl('ftp://x.example/f').error).toBe('refused protocol: ftp:');
  });
});

describe('accepts http(s)', () => {
  it.each([
    ['https://bank.example/pay', 'https://bank.example/pay'],
    ['http://bank.example/pay', 'http://bank.example/pay'],
    ['HTTP://OK.EXAMPLE/P', 'http://ok.example/P'], // normalises case
    ['https://bank.example/pay?a=1#f', 'https://bank.example/pay?a=1#f'],
    ['https://bank.example:8443/x', 'https://bank.example:8443/x'],
  ])('accepts %j', (target, expected) => {
    const r = resolveNavUrl(target);
    expect(r.ok).toBe(true);
    expect(r.url).toBe(expected);
  });
});

describe('relative targets resolve to an unresolvable host - they do NOT work', () => {
  // There is no page context in a service worker, so a relative target has no
  // real base. It resolves against the RFC 2606 placeholder and the navigation
  // then fails.
  //
  // The first version of this file claimed these "must not be refused because
  // the planner legitimately emits /dashboard" and asserted only that the
  // result was http://. That assertion was weak enough to pass while the
  // docstring next to it was wrong. Asserted properly below.
  it.each(['/dashboard', '/a/b/c?q=1', 'settings/profile'])(
    'resolves %j onto the .invalid placeholder',
    (target) => {
      const r = resolveNavUrl(target);
      expect(r.ok).toBe(true); // the SCHEME check passes...
      expect(r.url).toContain('.invalid'); // ...but it lands nowhere real
    }
  );

  it('does NOT resolve a relative target against a real origin', () => {
    // The specific regression risk: a relative target quietly inheriting the
    // current page's host. It cannot, because the base is a constant.
    const r = resolveNavUrl('/dashboard');
    expect(r.url).not.toMatch(/bank\.example/);
    expect(r.url).toBe('http://relative-target.invalid/dashboard');
  });

  it('a protocol-relative target keeps its own host, and that DOES work', () => {
    // //evil.example/x names a host, so it is not relative in that sense.
    const r = resolveNavUrl('//evil.example/x');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('http://evil.example/x');
  });
});

describe('#159 review: no duplicated copy of the policy survives', () => {
  // The review of #190 found the same scheme check inlined a SECOND time, in
  // navigateChannel - and that copy is the LIVE one, because the runner
  // reaches navigation through d.navigate, not through the NAVIGATE_TAB
  // message. Extracting only the handler would have left the path that
  // actually runs on the old behaviour.
  //
  // These read the source so the invariant is enforced, not remembered.
  // Resolved from the cwd, not import.meta.url - under Vitest import.meta.url
  // is not a file: URL, so readFileSync(URL) throws "The URL must be of
  // scheme file". Vitest runs from the repo root.
  const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');
  // Since #159 step 2 the planner navigation path lives in lib/navChannel.ts;
  // background.ts keeps only the wiring adapter and the NAVIGATE_TAB handler.
  // The ordering / base / needsBase guarantees are asserted against the module
  // that now owns them, and separately against the handler still in this file.
  const navChannel = readFileSync('src/lib/navChannel.ts', 'utf-8');

  it('no longer inlines a URL parse against a placeholder base', () => {
    // The smell: `new URL(x, 'http://invalid')` inlined in a handler.
    expect(bg).not.toMatch(/new URL\([^)]*'http:\/\/invalid'/);
  });

  it('routes BOTH navigation call sites through resolveNavUrl', () => {
    // The two call sites live in DIFFERENT files since #159 step 2: the
    // planner path moved to lib/navChannel.ts, the NAVIGATE_TAB message
    // handler stayed here. Counted across both, because a third inline copy is
    // the exact thing this test exists to prevent.
    //
    // The import lines read `from '../lib/navUrl'` / `from './navUrl'` and so
    // do not match `resolveNavUrl(`.
    const uses = (bg + navChannel).match(/resolveNavUrl\(/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('does not claim the type is string when nothing enforces it', () => {
    // Both sites were typed `url: string` while only truthiness-checking an
    // LLM-supplied value upstream. The type is now `unknown` - on the handler
    // here, and on the extracted `navigateChannel(url: unknown, ...)` in
    // navChannel.ts.
    expect(bg).not.toMatch(/NAVIGATE_TAB'; url: string/);
    expect(bg).not.toMatch(/navigateChannel = async \(url: string\)/);
    expect(navChannel).toMatch(/navigateChannel\(url: unknown/);
  });

  it('leaves no URL policy inlined in the adapter', () => {
    // The adapter's whole job is wiring. If navigation policy creeps back into
    // background.ts it will drift from navChannel.ts - which is precisely what
    // #190's review caught when two copies diverged.
    const adapter = bg.slice(bg.indexOf('const navigateChannel'));
    expect(adapter.slice(0, 400)).not.toMatch(/new URL\(/);
    expect(adapter.slice(0, 400)).not.toMatch(/needsBase/);
  });
});

describe('malformed input fails closed', () => {
  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    [undefined, 'undefined'],
    [null, 'null'],
    [undefined, 'missing'],
  ])('refuses %s (%s)', (target) => {
    // A missing url is a model bug. It must NOT be coerced to the string
    // "undefined" and navigated.
    const r = resolveNavUrl(target);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid url');
  });

  it('refuses non-string types rather than coercing them', () => {
    for (const t of [42, true, { href: 'https://x.example' }, ['https://x.example']]) {
      const r = resolveNavUrl(t);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid url');
    }
  });

  it('never returns ok with a missing url', () => {
    // The handler branches on `!nav.ok || !nav.url`, so both must agree.
    for (const t of ['javascript:x', '', undefined, 42, 'https://ok.example/']) {
      const r = resolveNavUrl(t);
      if (r.ok) expect(r.url).toBeTruthy();
      else expect(r.url).toBeUndefined();
    }
  });
});
