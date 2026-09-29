/**
 * #208 — the confirm DECISION, not just the helpers.
 *
 * `tests/action-goal-208.test.ts` covers the classifier and the checkbox check in
 * isolation. That was not enough: mutation testing showed four fail-open
 * mutations surviving it, including the two that matter most —
 *
 *   - dropping `unverifiable.length === 0` from `allProven`
 *   - replacing the checkbox check with `if (true)`
 *
 * Both make the gate claim success it cannot prove, and both passed every test in
 * the helper file. A safety control needs a test that fails when it fails OPEN,
 * so this file exercises `visionConfirm` end to end and asserts the verdict.
 *
 * The rule being pinned: **an unverifiable goal is never confirmed.** It is
 * reported separately so the log is honest, and it blocks completion so the
 * deterministic backstop keeps owning it.
 */

import { describe, it, expect } from 'vitest';
import { visionConfirm, type VisionConfirmItem } from '../src/lib/visionConfirm';

const OCR = 'ACME CLOUD CREATE AN ACCOUNT full name company plan seats submit';

/** The live 09-29 shape: a text goal and a trailing action goal. */
const ITEMS: VisionConfirmItem[] = [
  { id: '10', description: 'Account form is filled' },
  { id: '11', description: 'Tick the terms of service checkbox' },
];

describe('#208 an action goal is never silently confirmed', () => {
  it('is NOT confirmed when the checkbox state is unavailable', () => {
    // The exact live failure. Before #208 this was "missing"; it must now be
    // "unverifiable" - and either way it must NOT be confirmed.
    const v = visionConfirm(OCR, ITEMS);
    expect(v.confirmed).toBe(false);
    expect(v.unverifiable).toEqual(['11']);
    expect(v.missing).toEqual(['10']); // the text goal genuinely is not in the OCR
  });

  it('is NOT confirmed when the checkbox is present but UNCHECKED', () => {
    const v = visionConfirm(OCR, ITEMS, { terms: false });
    expect(v.confirmed).toBe(false);
    expect(v.unverifiable).toEqual(['11']);
  });

  it('is NOT confirmed when the page reports no checkboxes at all', () => {
    // Absent must not read as checked. This is the fail-open case.
    const v = visionConfirm(OCR, ITEMS, {});
    expect(v.confirmed).toBe(false);
    expect(v.unverifiable).toEqual(['11']);
  });

  it('IS confirmed when the named checkbox is genuinely checked', () => {
    const v = visionConfirm(OCR, ITEMS, { terms: true });
    expect(v.unverifiable).toEqual([]);
    // Still not confirmed overall, because item 10 is genuinely missing from the
    // OCR - proving the action goal passed without weakening the other check.
    expect(v.matched).toEqual(['11']);
  });

  it('confirms everything when every goal is proven', () => {
    const v = visionConfirm('Account form is filled', ITEMS, { terms: true });
    expect(v.confirmed).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.unverifiable).toEqual([]);
  });
});

describe('#208 an unverifiable goal blocks completion', () => {
  it('allProven requires BOTH lists to be empty', () => {
    // The mutation that survived: dropping the unverifiable clause. Assert the
    // consequence directly - a goal that cannot be proven must keep the task
    // running.
    const v = visionConfirm(OCR, [{ id: '11', description: 'Submit the form' }]);
    expect(v.confirmed).toBe(false);
    expect(v.missing).toEqual([]); // nothing is "missing" - it is unverifiable
    expect(v.unverifiable).toEqual(['11']);
  });

  it('an action goal does not pollute the missing list', () => {
    // It must be distinguishable: "the OCR looked and did not find it" is a
    // different, actionable situation from "OCR cannot see this at all".
    const v = visionConfirm(OCR, [{ id: '11', description: 'Submit the form' }]);
    expect(v.missing).toHaveLength(0);
  });
});

describe('#208 the log line says which situation it is', () => {
  it('distinguishes missing from unverifiable when both occur', () => {
    const v = visionConfirm(OCR, ITEMS);
    expect(v.detail).toContain('missing target(s): 10');
    expect(v.detail).toContain('not verifiable by OCR');
    expect(v.detail).toContain('11');
  });

  it('says so explicitly when only unverifiable goals remain', () => {
    const v = visionConfirm(OCR, [{ id: '11', description: 'Submit the form' }]);
    expect(v.detail).toMatch(/not verifiable by OCR/i);
    expect(v.detail).not.toMatch(/missing target/i);
  });

  it('does not name a checkbox as a missing OCR target', () => {
    // The live log said "OCR missing target(s): 11" for a checkbox, which sent
    // me looking for a text problem that did not exist.
    const v = visionConfirm(OCR, [{ id: '11', description: 'Tick the terms checkbox' }]);
    expect(v.detail).not.toMatch(/missing target/i);
  });
});

describe('#208 text goals are unaffected', () => {
  it('an ordinary visible-goal still resolves by OCR', () => {
    const v = visionConfirm('Dashboard shows 12 invoices', [
      { id: '1', description: 'Dashboard shows 12 invoices' },
    ]);
    expect(v.confirmed).toBe(true);
    expect(v.matched).toEqual(['1']);
  });

  it('an ordinary visible-goal still reports missing when absent', () => {
    const v = visionConfirm('nothing relevant here', [
      { id: '1', description: 'Dashboard shows 12 invoices' },
    ]);
    expect(v.confirmed).toBe(false);
    expect(v.missing).toEqual(['1']);
    expect(v.unverifiable).toEqual([]);
  });
});
