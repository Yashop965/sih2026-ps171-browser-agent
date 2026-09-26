/**
 * #174 - `resolveWebTab()` had two unguarded `browser.tabs.query` calls, and
 * the EXECUTE handler calls it OUTSIDE its try block (deliberately, so the
 * catch can see `tabId`). A query rejection therefore became an unhandled
 * promise rejection inside the async IIFE: `sendResponse` was never called and
 * the channel stayed open forever.
 *
 * #167 - `watchTickFires()` is pure, exported and tested, but had zero
 * production call sites. The shipped poll inlined a DIFFERENT rule
 * (`url changed OR title changed`), so the tests were green and described
 * behaviour that never shipped.
 *
 * Both are service-worker concerns, so these tests exercise the shipped
 * functions' logic against the exact conditions, plus the shape of the fix in
 * the real source (which is where the wiring actually lives).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { watchTickFires } from '../src/lib/tabOrchestrator';

const BG = resolve(__dirname, '../src/entrypoints/background.ts');
const bgSrc = () => readFileSync(BG, 'utf8');

describe('#174 resolveWebTab must never reject', () => {
  // The real function, driven through the real code path. `browser.tabs.query`
  // is made to reject the way it does in production: the extension loses host
  // permission when a tab navigates cross-origin, or the user revokes it.
  function loadResolveWebTab(queryImpl: () => Promise<unknown[]>) {
    // The function is module-private, so re-implement nothing: extract the
    // shipped source and evaluate it with a stubbed browser. That is the only
    // way to test it without standing up a full SW harness - and it means the
    // test breaks if the shipped function is renamed or restructured.
    //
    // The extracted text is a `function` DECLARATION, which is hoisted inside
    // the eval'd scope and shadows any outer `let` of the same name - hence the
    // assignment below rather than relying on a binding.
    const src = bgSrc();
    const start = src.indexOf('async function resolveWebTab');
    expect(start).toBeGreaterThan(-1);

    // Brace-match to the function's real end rather than searching for a
    // sentinel like '\n}\n': the function's closing brace is the last char
    // before a blank line, so a fixed delimiter silently returns an empty
    // string. Braces are counted from the first '{' after the signature, so
    // braces inside strings or comments in the body are handled correctly by
    // virtue of being balanced.
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(braceStart);
    let decl = src.slice(start, end);
    expect(decl).toContain('browser.tabs.query');

    // The extracted text is TypeScript, and `new Function` evaluates plain
    // JS. Strip the two annotations this function carries - the parameter type
    // and the return type - rather than pulling in a transpiler. If the
    // signature ever grows another annotation the next expect() fails loudly
    // instead of silently skipping the test.
    decl = decl
      .replace(/sender:\s*Runtime\.MessageSender/, 'sender')
      .replace(/\):\s*Promise<[^>]*>\s*\{/, ') {')
      // The nested helper's own annotation: `(u?: string) =>`.
      .replace(/\(u\?:\s*string\)/, '(u)');
    expect(decl).not.toMatch(/\?:\s*string/);
    expect(decl).not.toContain('Promise<');
    expect(decl).not.toContain('Runtime.MessageSender');

    const factory = new Function('browser', 'hostOfUrl', `${decl}\nreturn resolveWebTab;`);
    return factory({ tabs: { query: queryImpl } }, (u: string) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return '';
      }
    }) as (sender: unknown) => Promise<number | undefined>;
  }

  const boom = () => Promise.reject(new Error('Cannot read properties of null'));

  it('returns undefined instead of rejecting when tabs.query throws', async () => {
    const resolveWebTab = loadResolveWebTab(boom as never);
    // The whole point: a resolved value, so the caller's `if (!tabId)` branch
    // runs and the channel gets its "No web tab found" answer.
    await expect(resolveWebTab({})).resolves.toBeUndefined();
  });

  it('never rejects even when the first query succeeds and the second throws', async () => {
    let call = 0;
    const resolveWebTab = loadResolveWebTab((() => {
      call += 1;
      // First call (active tab) returns a non-web tab, so it falls through to
      // the second query - which rejects. This is the path that was unguarded.
      if (call === 1) return Promise.resolve([{ id: 9, url: 'chrome://extensions' }]);
      return Promise.reject(new Error('permission revoked'));
    }) as never);
    await expect(resolveWebTab({})).resolves.toBeUndefined();
  });

  it('still resolves the active web tab on the happy path (no regression)', async () => {
    const resolveWebTab = loadResolveWebTab((() =>
      Promise.resolve([{ id: 42, url: 'https://example.com/x' }])) as never);
    expect(await resolveWebTab({})).toBe(42);
  });

  it('returns the sender tab without querying at all when it is already web', async () => {
    const query = vi.fn(() => Promise.reject(new Error('should not be called')));
    const resolveWebTab = loadResolveWebTab(query as never);
    const got = await resolveWebTab({ tab: { id: 7, url: 'https://a.example', windowId: 1 } });
    expect(got).toBe(7);
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to a background web tab when the active one is not web', async () => {
    let call = 0;
    const resolveWebTab = loadResolveWebTab((() => {
      call += 1;
      if (call === 1) return Promise.resolve([{ id: 1, url: 'chrome://newtab' }]);
      return Promise.resolve([
        { id: 1, url: 'chrome://newtab' },
        { id: 2, url: 'https://real.example/page' },
      ]);
    }) as never);
    expect(await resolveWebTab({})).toBe(2);
  });
});

describe('#174 the EXECUTE call site cannot hang', () => {
  // resolveWebTab handles its own rejections, but the cost of being wrong is a
  // channel that never responds, so the call site answers too.
  it('wraps the EXECUTE resolve in a try that sends a response', () => {
    const src = bgSrc();
    const execCase = src.slice(src.indexOf("case 'EXECUTE':"), src.indexOf("case 'NAVIGATE_TAB':"));
    expect(execCase).toContain('try {');
    expect(execCase).toMatch(/catch[\s\S]{0,400}sendResponse\(/);
  });

  it('does not declare tabId with const before an await it must survive', () => {
    // The original shape - `const tabId = await resolveWebTab(sender)` outside a
    // try - is exactly what cannot report a failure.
    const src = bgSrc();
    const execCase = src.slice(src.indexOf("case 'EXECUTE':"), src.indexOf("case 'NAVIGATE_TAB':"));
    expect(execCase).not.toMatch(/const tabId = await resolveWebTab/);
  });
});

describe('#167 the shipped poll uses the tested policy', () => {
  it('calls watchTickFires in the poll body', () => {
    expect(bgSrc()).toContain('watchTickFires(watch.trigger, watch.snapshot, next)');
  });

  it('no longer carries the divergent inline rule', () => {
    // This exact expression is the bug: it ignores the trigger and fires on
    // either field under both trigger kinds.
    expect(bgSrc()).not.toMatch(
      /next\.url !== watch\.snapshot\.url \|\| next\.title !== watch\.snapshot\.title/
    );
  });

  it('records a trigger when registering a watched tab', () => {
    const src = bgSrc();
    const i = src.indexOf('watchedSourceTabs.set(tabId, {');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 320)).toContain('trigger:');
  });

  it('advances the snapshot after a tick so a flapping title cannot re-fire', () => {
    const src = bgSrc();
    const i = src.indexOf('watchTickFires(watch.trigger');
    expect(src.slice(i, i + 900)).toContain('watch.snapshot =');
  });

  // Regression found in self-review of #187. The poll compares against
  // watch.snapshot, but the EVENT path (watcherUrlListener) used to fire a
  // re-perception on a url change without ever recording that the url moved.
  // The poll's next tick then saw snapshot.url === next.url and reported "no
  // change" - so the event's re-perception was the only one that ever happened
  // for that navigation, and the title comparison was left comparing against a
  // pre-navigation title indefinitely.
  it('the event path also advances the snapshot url', () => {
    const src = bgSrc();
    const i = src.indexOf('const watcherUrlListener');
    // Generous window: the function is heavily commented, and a fixed
    // narrow slice silently started failing when a comment was rewrapped.
    const body = src.slice(i, i + 2000);
    expect(body).toContain('changeInfo.url');
    expect(body).toMatch(/snapshot\s*=\s*\{[^}]*url/);
  });

  it('event + poll on one url change yields exactly one re-perception', () => {
    // Composed, not just asserted per-path: the event records the url, so the
    // poll that follows must not report a second change.
    const trigger = { urlChange: true, pollMs: 60_000 };
    let snap = { url: 'https://x.example/a', title: 'A' };
    let fired = 0;

    // event path, as shipped
    const onUrlEvent = (u: string) => {
      if (snap.url !== u) snap = { ...snap, url: u };
      fired++;
    };
    // poll, as shipped
    const poll = (u: string, t: string) => {
      if (watchTickFires(trigger, snap, { url: u, title: t })) fired++;
      snap = { url: u, title: t };
    };

    onUrlEvent('https://x.example/b');
    poll('https://x.example/b', 'A'); // url already recorded by the event
    expect(fired).toBe(1);
  });

  it('the poll still catches a url change when the event is missed', () => {
    // The event path is the fast path, not the only path. If the SW was asleep
    // and the event never arrived, the poll must still notice on its own.
    const trigger = { urlChange: true, pollMs: 60_000 };
    const snap = { url: 'https://x.example/a', title: 'A' };
    expect(watchTickFires(trigger, snap, { url: 'https://x.example/b', title: 'A' })).toBe(true);
  });

  it('the poll still catches a title-only change (the SPA case it exists for)', () => {
    const trigger = { urlChange: true, pollMs: 60_000 };
    const snap = { url: 'https://x.example/b', title: 'A' };
    expect(watchTickFires(trigger, snap, { url: 'https://x.example/b', title: 'Loaded' })).toBe(
      true
    );
  });
});

describe('#167 the policy the tests pin', () => {
  // These restate the divergence: the two triggers watch DIFFERENT fields, so
  // the old inline `url || title` rule over-fired.
  it('a title change fires once a poll trigger is present, whatever the url did', () => {
    // Correcting my own first draft of this test: I asserted false here,
    // reasoning "urlChange only watches the url". But this trigger set ALSO
    // carries pollMs, and a poll trigger watches the title - which is exactly
    // why the production poll must delegate here rather than re-deriving the
    // rule inline. The trigger fields are independent, not exclusive.
    expect(
      watchTickFires(
        { urlChange: true, pollMs: 60_000 },
        { url: 'a', title: 'x' },
        { url: 'a', title: 'y' }
      )
    ).toBe(true);
  });

  it('a urlChange-ONLY trigger ignores a title change', () => {
    // The genuinely exclusive case: no poll trigger, so the title is not watched.
    expect(
      watchTickFires({ urlChange: true }, { url: 'a', title: 'x' }, { url: 'a', title: 'y' })
    ).toBe(false);
  });

  it('a poll-ONLY trigger ignores a url change (the event path owns that)', () => {
    expect(
      watchTickFires({ pollMs: 30_000 }, { url: 'a', title: 'x' }, { url: 'b', title: 'x' })
    ).toBe(false);
  });

  it('the production trigger fires on a real url change', () => {
    expect(
      watchTickFires(
        { urlChange: true, pollMs: 60_000 },
        { url: 'a', title: 'x' },
        { url: 'b', title: 'x' }
      )
    ).toBe(true);
  });

  it('the production trigger fires on a real title change', () => {
    expect(
      watchTickFires(
        { urlChange: true, pollMs: 60_000 },
        { url: 'a', title: 'x' },
        { url: 'a', title: 'y' }
      )
    ).toBe(true);
  });

  it('no trigger set never fires', () => {
    expect(watchTickFires({}, { url: 'a', title: 'x' }, { url: 'b', title: 'y' })).toBe(false);
  });
});
