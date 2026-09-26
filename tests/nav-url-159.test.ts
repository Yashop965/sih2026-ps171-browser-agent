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

describe('relative targets resolve, they are not refused', () => {
  // The planner emits these routinely. Refusing them would break multi-page
  // autonomy, which is the whole point of NAVIGATE_TAB.
  it.each(['/dashboard', '/a/b/c?q=1', 'settings/profile'])('resolves %j', (target) => {
    const r = resolveNavUrl(target);
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/^http:\/\//);
  });

  it('a resolved relative target never lands on a real host', () => {
    // The placeholder base is RFC 2606 `.invalid`, which cannot be registered.
    // So a relative target that fails to carry its own host cannot silently
    // land somewhere real.
    for (const t of ['/dashboard', 'settings/profile', 'example.com/x']) {
      const r = resolveNavUrl(t);
      expect(r.ok).toBe(true);
      expect(r.url).toContain('.invalid');
    }
  });

  it('a protocol-relative target keeps its own host', () => {
    // //evil.example/x is NOT relative in the dangerous sense - it names a host.
    const r = resolveNavUrl('//evil.example/x');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('http://evil.example/x');
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
