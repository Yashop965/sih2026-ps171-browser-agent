/**
 * #170 — `getPageContext()` sent `location.href` raw while `captureDOM()` one
 * field away on the same payload sent a query-stripped URL. The strip the
 * snapshot clearly intended was undone.
 *
 * #165 — `maskProfileValues()` used `\b...\b`, which is unsatisfiable when the
 * profile value ends in punctuation, so those values crossed to /plan raw.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

// jsdom supplies location/document; drive them directly.
function setLocation(href: string) {
  delete (window as unknown as { location?: Location }).location;
  (window as unknown as { location: Location }).location = { href } as Location;
}

describe('#170 sanitizedPageUrl', () => {
  it('strips the query string', async () => {
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    expect(sanitizedPageUrl('https://bank.example/pay?aadhaar=1234&email=a@b.com')).toBe(
      'https://bank.example/pay'
    );
  });

  it('strips the fragment too', async () => {
    // Client-side apps routinely park PII in the hash; it is never sent to a
    // server but it does reach our outbound payload.
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    expect(sanitizedPageUrl('https://app.example/x#token=secret123')).toBe('https://app.example/x');
  });

  it('keeps origin and path, which the planner needs to reason about the page', async () => {
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    expect(sanitizedPageUrl('https://bank.example/deep/path?x=1')).toBe(
      'https://bank.example/deep/path'
    );
  });

  it('leaves a clean URL unchanged', async () => {
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    const clean = 'https://bank.example/pay';
    expect(sanitizedPageUrl(clean)).toBe(clean);
  });

  it('does not leak a token in a query param on any channel', async () => {
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    const out = sanitizedPageUrl('https://x.example/?session=eyJhbGciOi&pan=ABCDE1234F');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).not.toContain('ABCDE1234F');
  });

  it('degrades to empty on an unparseable href instead of throwing', async () => {
    // A throw here would fail the whole extract; an empty string just tells the
    // planner the page is unknown.
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    expect(sanitizedPageUrl('not a url')).toBe('');
  });
});

describe('#170 getPageContext', () => {
  it('reports a query-stripped url, not location.href', async () => {
    setLocation('https://bank.example/pay?aadhaar=999988887777&x=1');
    const { getPageContext } = await import('../src/lib/dom');
    const ctx = getPageContext();
    expect(ctx.url).toBe('https://bank.example/pay');
    expect(ctx.url).not.toContain('aadhaar');
    expect(ctx.url).not.toContain('999988887777');
  });

  it('is idempotent with the snapshot url for the same page', async () => {
    // The two call sites must not disagree - that disagreement WAS the bug.
    setLocation('https://bank.example/pay?q=1');
    const { getPageContext, sanitizedPageUrl } = await import('../src/lib/dom');
    expect(getPageContext().url).toBe(sanitizedPageUrl());
  });

  // Found while fixing #170: the SAME defect on a THIRD channel, and a wider
  // one. `openTabs` is built from browser.tabs (which returns the raw url,
  // query string and all) and the whole list crosses to the planner - so this
  // leaked the query string of every tab the user had open, not just the
  // current page. Pinned here because it is a background.ts call site and
  // would otherwise need the full SW harness to test.
  it('openTabs-style tab lists are stripped too', async () => {
    const { sanitizedPageUrl } = await import('../src/lib/dom');
    const tabs = [
      { tabId: 1, url: 'https://mail.example/inbox?email=a@b.com', title: 'Inbox' },
      { tabId: 2, url: 'https://bank.example/transfer?pan=ABCDE1234F', title: 'Pay' },
    ];
    const sent = tabs.map((t) => ({ ...t, url: sanitizedPageUrl(t.url) }));
    const json = JSON.stringify(sent);
    expect(json).not.toContain('a@b.com');
    expect(json).not.toContain('ABCDE1234F');
    // Still enough for the model to pick a tab by host.
    expect(sent[0].url).toBe('https://mail.example/inbox');
  });
});

describe('#165 maskProfileValues', () => {
  const profile = { city: 'Pune.' } as never;

  it('masks a value ending in a period (the issue case)', async () => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    const out = maskProfileValues('Fill the city field with Pune. and submit', profile);
    expect(out).not.toContain('Pune.');
    expect(out).toContain('<CITY>');
  });

  const punctuation: Array<[string, string]> = [
    ['Pune.', 'Fill Pune. now'],
    ['Bangalore,', 'Moving to Bangalore, today'],
    ['Acme Ltd.', 'Work at Acme Ltd. today'],
    ['Bangalore;', 'City Bangalore; done'],
    ['Bangalore)', 'City (Bangalore)'],
    ['Bangalore!', 'Wow Bangalore!'],
    ['Bangalore?', 'City Bangalore?'],
    ['Bangalore:', 'City Bangalore: here'],
  ];

  it.each(punctuation)('masks %j', async (value, text) => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    const out = maskProfileValues(text, { city: value } as never);
    expect(out).not.toContain(value);
  });

  it.each([
    ['Pune', 'Fill the city with Pune'],
    ['Mumbai', 'Mumbai is the city'],
    ["O'Connor", "Contact O'Connor"],
    ['12-B, MG Road', 'Flat at 12-B, MG Road'],
    ['A/B Ltd', 'Company A/B Ltd'],
    ['NY, USA', 'Office in NY, USA'],
    ['St. Louis', 'City St. Louis'],
  ])('still masks %j (no regression on word-edge values)', async (value, text) => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    const out = maskProfileValues(text, { city: value } as never);
    expect(out).not.toContain(value);
  });

  // The boundary is only dropped at a punctuation edge, so the guard that
  // stops `Pune` matching inside `Punegaon` must survive everywhere it
  // mattered. Dropping it wholesale would silently over-mask real words.
  it.each([
    ['Pune', 'Go to Punegaon today'],
    ['Pune', 'Punee'],
    ['Bank', 'Banker'],
    ['New York', 'New Yorker'],
    ['Dr. Sharma', 'Dr. Sharmas'],
  ])('does NOT over-mask %j inside a longer word', async (value, text) => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    expect(maskProfileValues(text, { city: value } as never)).toBe(text);
  });

  it('masks every occurrence, not just the first', async () => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    const out = maskProfileValues('Pune. then Pune. then Pune.', { city: 'Pune.' } as never);
    expect(out).toBe('<CITY> then <CITY> then <CITY>');
  });

  it('leaves values under 3 chars alone (unchanged behaviour)', async () => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    expect(maskProfileValues('a long string', { city: 'ab' } as never)).toBe('a long string');
  });

  it('does not throw on a value that is entirely punctuation', async () => {
    const { maskProfileValues } = await import('../src/lib/userProfile');
    expect(() => maskProfileValues('some text', { city: '...' } as never)).not.toThrow();
  });
});
