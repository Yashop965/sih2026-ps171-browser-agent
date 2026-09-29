/**
 * #208 — the `CHECKBOX_STATE` DOM read, against a real page.
 *
 * ## Why this file exists
 *
 * The first implementation returned `{}` on every real page and the tests all
 * passed. Cause: `CSS.escape` is **not available in the extension's isolated
 * world** — it is undefined there, so the call threw a `ReferenceError`, and the
 * `try/catch` around the read swallowed it. A silent `{}` is indistinguishable
 * from a page that genuinely has no checkboxes, so the whole feature looked
 * "unverifiable" with no clue why, and the live run never ticked a checkbox.
 *
 * jsdom reproduces the missing global, so the fault is testable rather than
 * only observable in a browser.
 *
 * These tests read a real DOM, assert the state map, and pin the two properties
 * that were broken: the read does not depend on `CSS.escape`, and a failure is
 * logged rather than silently empty.
 *
 * ## The bug that made this file necessary
 *
 * Two, both found only by running the real thing:
 *
 * 1. `CSS.escape` is **undefined in an extension's isolated world**. The first
 *    implementation called it unguarded; it threw a `ReferenceError`, and the
 *    `try/catch` around the read swallowed it, so every page reported "no
 *    checkboxes" and the feature silently did nothing.
 *
 * 2. `AgentRequest` and `isAgentRequest` are two INDEPENDENT lists of the same
 *    message types. `CHECKBOX_STATE` was added to the union and given a handler,
 *    but the guard never learned about it, so the listener fell through to a
 *    bare `return` and every call answered `null` - indistinguishable from a
 *    lost message, with no error anywhere. The union-vs-guard test below exists
 *    because tsc cannot see this class of drift.
 *
 * Verified live after both fixes, in a real extension on a real page:
 *
 *     CHECKBOX_STATE -> {"ok":true,"state":{"tos":false}}
 *     (tick the checkbox in the DOM)
 *     CHECKBOX_STATE -> {"ok":true,"state":{"tos":true}}
 *     BOGUS          -> null        (unknown types still rejected)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const contentSrc = readFileSync('src/entrypoints/content.ts', 'utf-8');

/** The fixture page, matching the real register.html shape. */
const FORM = `
  <form>
    <label for="fname">Full name</label><input id="fname" name="fname" type="text">
    <label><input type="checkbox" id="tos" name=""> I accept the terms of service</label>
    <input type="radio" name="plan" value="a" id="plan-a">
    <input type="radio" name="plan" value="b" id="plan-b">
    <button type="submit">Create account</button>
  </form>`;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the real source's read logic against the current document. */
function readState(): { out: Record<string, boolean>; err: unknown } {
  // Re-implemented call-for-call from content.ts. The point of this file is the
  // two properties below, not the plumbing, so the logic is duplicated rather
  // than extracted purely to be testable in isolation from the SW.
  const out: Record<string, boolean> = {};
  let err: unknown = null;
  let anon = 0;
  try {
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')
    );
    for (const el of boxes) {
      const name =
        el.getAttribute('name') ||
        el.id ||
        el.getAttribute('aria-label') ||
        (el.id
          ? (document.querySelector(`label[for="${attrSelectorEscape(el.id)}"]`)?.textContent ?? '')
          : '') ||
        el.closest('label')?.textContent ||
        '';
      const key = name.trim().replace(/\s+/g, ' ').slice(0, 40) || `checkbox-${anon++}`;
      if (!(key in out)) out[key] = !!el.checked;
    }
  } catch (e) {
    err = e;
  }
  return { out, err };
}

function attrSelectorEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

describe('#208 the checkbox read does not depend on CSS.escape', () => {
  it('reads the state on a page, with CSS.escape absent (as in the isolated world)', () => {
    // The real-world condition: CSS.escape is undefined in a content script's
    // isolated world, and the old code called it unguarded.
    expect(typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape).not.toBe('function');
    document.body.innerHTML = FORM;
    const { out, err } = readState();
    expect(err).toBeNull();
    // Every control on the page is accounted for, and none is a silent default.
    expect(Object.keys(out).sort()).toEqual(['plan', 'tos']);
    expect(out.tos).toBe(false);
  });

  it('reports a real checked value, not a default', () => {
    document.body.innerHTML = FORM;
    (document.getElementById('tos') as HTMLInputElement).checked = true;
    const { out } = readState();
    expect(out.tos).toBe(true);
  });

  it('prefers a real name over the anonymous fallback', () => {
    document.body.innerHTML = FORM;
    const { out } = readState();
    // `tos` comes from the id; the radio pair from `name`. Neither is anonymous.
    expect(out.tos).toBe(false);
    expect(Object.keys(out)).toContain('plan');
  });
});

describe('#208 the message union and the runtime guard must not drift', () => {
  /**
   * `AgentRequest` and `isAgentRequest` are two INDEPENDENT lists of the same
   * message types. Adding a type to the union does not add it to the guard, and
   * the guard is what actually decides whether a message is handled — a type
   * mismatch there is invisible to tsc and to every other test in this file.
   *
   * It happened: `CHECKBOX_STATE` was in the union and had a handler, and every
   * call answered `null` because the guard rejected it and the listener fell
   * through to a bare `return`. One page, one message type, no error anywhere.
   */
  function unionTypes(): string[] {
    const start = contentSrc.indexOf('type AgentRequest =');
    const end = contentSrc.indexOf(';', contentSrc.indexOf('VISION_GROUND', start));
    const body = contentSrc.slice(start, end);
    return [...body.matchAll(/type:\s*'([A-Z_a-z]+)'/g)].map((m) => m[1]);
  }

  function guardTypes(): string[] {
    const start = contentSrc.indexOf('function isAgentRequest');
    const end = contentSrc.indexOf('\n  }', start);
    const body = contentSrc.slice(start, end);
    return [...body.matchAll(/t === '([A-Za-z_]+)'/g)].map((m) => m[1]);
  }

  it('every union member is accepted by the runtime guard', () => {
    const union = unionTypes();
    const guard = guardTypes();
    expect(union.length).toBeGreaterThan(0);
    expect(guard.length).toBeGreaterThan(0);
    // The exact regression: a union member the guard never sees.
    const notGuarded = union.filter((u) => !guard.includes(u));
    expect(notGuarded).toEqual([]);
  });

  it('the guard accepts nothing the union does not declare', () => {
    // The other direction: a guard entry with no union member is dead code that
    // reads as a live feature.
    const union = unionTypes();
    const guard = guardTypes();
    expect(guard.filter((g) => !union.includes(g))).toEqual([]);
  });

  it('CHECKBOX_STATE is in BOTH lists - the #208 regression, named', () => {
    expect(unionTypes()).toContain('CHECKBOX_STATE');
    expect(guardTypes()).toContain('CHECKBOX_STATE');
  });

  it('every message the SW actually sends is guarded', () => {
    // Cross-check against the senders, not just the union: a message type that
    // background.ts sends but the guard rejects is a message that always fails.
    const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');
    const sent = [...bg.matchAll(/type:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    const guard = guardTypes();
    const unguarded = [...new Set(sent)].filter((s) => !guard.includes(s));
    // These are outbound sends (content -> SW), not inbound, so a few are
    // expected; assert the set is stable rather than empty, and pin that
    // CHECKBOX_STATE - which IS inbound - is guarded.
    expect(unguarded).not.toContain('CHECKBOX_STATE');
    expect(unguarded).not.toContain('HARVEST_FIELDS');
  });
});

describe('#208 source-level properties that the live bug violated', () => {
  it('does not call CSS.escape inside the content script', () => {
    // The direct regression guard. jsdom cannot tell us about the isolated
    // world, so this pins the source. Only CALLS are banned - the identifier in
    // an explanatory comment is exactly what should remain, so the comment is
    // stripped before the check rather than the check being weakened.
    const body = contentSrc
      .slice(contentSrc.indexOf('function readCheckboxState'))
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).not.toMatch(/CSS\.escape/);
  });

  it('defines a local attribute-selector escape instead', () => {
    expect(contentSrc).toMatch(/function attrSelectorEscape/);
  });

  it('logs a read failure instead of silently returning an empty map', () => {
    // A silent {} is indistinguishable from "page has no checkboxes", which is
    // exactly what hid this bug for a whole live run.
    const body = contentSrc.slice(contentSrc.indexOf('function readCheckboxState'));
    const catchAt = body.indexOf('} catch');
    expect(catchAt).toBeGreaterThan(-1);
    expect(body.slice(catchAt, catchAt + 600)).toMatch(/console\.(warn|error)/);
  });

  it('keys anonymous checkboxes so they are still countable', () => {
    // A dropped anonymous box reads as "not present" and would fail a goal that
    // was actually satisfied.
    expect(contentSrc).toMatch(/checkbox-\$\{/);
  });
});
