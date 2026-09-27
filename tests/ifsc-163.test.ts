/**
 * #163 — IFSC detection could not match a real IFSC.
 *
 * The detector's pre-filter required `{7}` alphanumerics after the `0`, i.e. a
 * 12-character string. A real IFSC is 11: 4 letters + `0` + 6 alphanumerics.
 * Because the pre-filter gates entry into the pipeline, nothing downstream ever
 * saw a real IFSC.
 *
 * The fix (`{6}`) is already in the tree — it landed with #182. This file is
 * the regression guard, and it drives the real `PIIManager` over a real DOM
 * rather than re-testing the regex, because the bug was never the regex in
 * isolation: it was the regex disagreeing with `validateIFSC`, and nothing
 * caught that.
 *
 * It also pins the ADJACENT risk. `SBIN0000123` is 11 chars, and so are plenty
 * of non-IFSC strings. A loosened pattern that starts matching those is a new
 * false positive, and a false positive here means a real field gets redacted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { PIIManager } from '../src/lib/pii/detector';
import { validateIFSC } from '../src/lib/pii/validators';

const REAL_IFSC = [
  'SBIN0000123',
  'HDFC0000123',
  'ICIC0000001',
  'PUNB0123456',
  'KKBK0000261',
  'BARB0000101',
  'UTIB0000194',
];

const NOT_IFSC = [
  'SBIN1000123', // 5th char must be 0
  'SBI0000123', // only 3 letters
  'SBINX000123', // 5 letters before the 0
  'SBIN00001234', // 12 chars - the shape the old {7} pattern wanted
  'sbin0000123', // lowercase
  'SBIN-000-123',
  'SBIN000012', // 10 chars
];

/**
 * `scanValue` — where the IFSC pattern lives — runs ONLY on form elements that
 * carry a value (`input`, `select`, `textarea`). A `<span>` holding an IFSC is
 * handled by the separate text scanner, which does not use these `checks`.
 *
 * The first version of this file used `<span>` and every positive failed with
 * "expected [] to include 'IFSC'" - not because the pattern was wrong, but
 * because the fixture never reached the code under test.
 */
function detect(values: string[]): Map<string, string[]> {
  const rows = values
    .map(
      (v) =>
        `<div><label for="f${v}">Bank IFSC code</label>` +
        `<input id="f${v}" name="ifsc" value="${v}"></div>`
    )
    .join('');
  const dom = new JSDOM(`<!doctype html><body>${rows}</body>`, { url: 'https://bank.example/' });
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  globalThis.document = dom.window.document as unknown as typeof globalThis.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  try {
    PIIManager.getInstance().clear();
    const dets = PIIManager.getInstance().scanDocument();
    const out = new Map<string, string[]>();
    for (const d of dets) {
      const arr = out.get(d.type) ?? [];
      arr.push(d.value);
      out.set(d.type, arr);
    }
    return out;
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
}

describe('#163: a real IFSC is detected', () => {
  beforeEach(() => undefined);
  afterEach(() => PIIManager.getInstance().clear());

  it.each(REAL_IFSC)('detects %s as IFSC', (code) => {
    // Sanity: the fixture really is a valid IFSC per the canonical validator.
    expect(validateIFSC(code)).toBe(true);

    const types = detect([code]);
    const found = [...types.entries()].filter(([, vals]) => vals.length > 0);
    expect(found.map(([t]) => t)).toContain('IFSC');
  });

  it('detects every real IFSC on one page', () => {
    const types = detect(REAL_IFSC);
    const ifscHits = types.get('IFSC') ?? [];
    // One per code, all values redacted (non-card PII is stored fully redacted).
    expect(ifscHits.length).toBe(REAL_IFSC.length);
    expect(ifscHits.every((v) => v === '[REDACTED]')).toBe(true);
  });
});

describe('#163: non-IFSC strings are not detected as IFSC', () => {
  it.each(NOT_IFSC)('does not claim %s', (code) => {
    const types = detect([code]);
    expect(types.get('IFSC') ?? []).toHaveLength(0);
  });

  it('the 12-character form is no longer what the pattern wants', () => {
    // Explicit, because this is the exact shape the old {7} rule matched. If
    // someone "fixes" a regression by going back to {7}, this fails.
    const types = detect(['SBIN00001234']);
    expect(types.get('IFSC') ?? []).toHaveLength(0);
  });
});

describe('#163: the detector and the validator agree', () => {
  it('every real IFSC passes BOTH', () => {
    // The original bug was a disagreement between these two. Pin the
    // agreement directly rather than trusting each in isolation.
    for (const code of REAL_IFSC) {
      expect(validateIFSC(code)).toBe(true);
      const types = detect([code]);
      expect([...types.keys()]).toContain('IFSC');
    }
  });

  it('no fixture is accepted by one and rejected by the other', () => {
    const all = [...REAL_IFSC, ...NOT_IFSC];
    for (const code of all) {
      const types = detect([code]);
      const detected = (types.get('IFSC') ?? []).length > 0;
      const valid = validateIFSC(code);
      expect(detected, `${code}: detected=${detected} valid=${valid}`).toBe(valid);
    }
  });
});
