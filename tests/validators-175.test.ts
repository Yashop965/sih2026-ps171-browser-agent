/**
 * #162 / #168 / #175 — the Aadhaar, PAN and IFSC validators, verified against
 * the specification rather than against this codebase.
 *
 * Why this file exists in this shape: the original Aadhaar validator carried a
 * wrong Verhoeff `p` table, so it accepted roughly one real Aadhaar in ten. The
 * suite stayed green because its fixtures were chosen to agree with the broken
 * implementation. A test whose expected values come from the code under test
 * cannot detect a defect in it, so everything here is derived from the
 * algorithm and the published format specs:
 *
 *   - Aadhaar: Verhoeff check digit, verified against a UIDAI-published sample
 *     and a generate-then-validate round trip.
 *   - PAN:     the Income Tax / NSDL entity-type character at index 3.
 *   - IFSC:    11 characters — 4 letters, a literal 0, then 6 alphanumerics.
 *
 * The oracle below is written once, independently of src/lib, and used to
 * generate the inputs.
 */

import { describe, it, expect } from 'vitest';
import {
  validateAadhaar,
  validatePAN,
  validateIFSC,
  PAN_ENTITY_CHARS,
} from '../src/lib/pii/validators';

// ── Oracle: canonical Verhoeff, written once here ───────────────────────────
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function canonicalAadhaar(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** Build a genuinely valid Aadhaar: 11 arbitrary digits + the right check digit. */
function makeValidAadhaar(seed: number): string {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % 10;
  };
  const base = Array.from({ length: 11 }, next).join('');
  for (let cd = 0; cd < 10; cd++) {
    if (canonicalAadhaar(base + String(cd))) return base + String(cd);
  }
  throw new Error('no check digit found');
}

// ── Aadhaar ──────────────────────────────────────────────────────────────────

describe('validateAadhaar — accepts real numbers', () => {
  it('accepts the UIDAI-published sample 999999990019', () => {
    // The original implementation returned false for this.
    expect(canonicalAadhaar('999999990019')).toBe(true); // oracle sanity
    expect(validateAadhaar('999999990019')).toBe(true);
  });

  it('accepts 100% of generated valid Aadhaars', () => {
    // Measured before the fix: 10.1%. One real Aadhaar in ten was detected.
    const generated = Array.from({ length: 2000 }, (_, i) => makeValidAadhaar(i + 1));
    const accepted = generated.filter((n) => validateAadhaar(n)).length;
    expect(accepted).toBe(generated.length);
  });

  it('accepts a valid number formatted with spaces', () => {
    const valid = makeValidAadhaar(4242);
    expect(validateAadhaar(`${valid.slice(0, 4)} ${valid.slice(4, 8)} ${valid.slice(8)}`)).toBe(
      true
    );
  });
});

describe('validateAadhaar — rejects invalid numbers', () => {
  it('rejects every single-digit corruption of a valid number', () => {
    const source = Array.from({ length: 200 }, (_, i) => makeValidAadhaar(i + 9000));
    const falsePositives: string[] = [];

    for (const n of source) {
      for (let pos = 0; pos < 12; pos++) {
        for (let delta = 1; delta <= 9; delta++) {
          const d = Number(n[pos]) + delta;
          if (d > 9) continue;
          const corrupted = n.slice(0, pos) + String(d) + n.slice(pos + 1);
          if (canonicalAadhaar(corrupted)) continue; // still legitimately valid
          if (validateAadhaar(corrupted)) falsePositives.push(corrupted);
        }
      }
    }
    expect(falsePositives).toEqual([]);
  });

  it('rejects adjacent transpositions (Verhoeff catches these by construction)', () => {
    const source = Array.from({ length: 200 }, (_, i) => makeValidAadhaar(i + 20000));
    const accepted: string[] = [];
    for (const n of source) {
      for (let i = 0; i < n.length - 1; i++) {
        const swapped = n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2);
        if (swapped !== n && !canonicalAadhaar(swapped) && validateAadhaar(swapped)) {
          accepted.push(swapped);
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it.each([
    ['wrong length (11)', '12345678901'],
    ['wrong length (13)', '1234567890123'],
    ['non-digits', '1234 5678 901X'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(validateAadhaar(value)).toBe(false);
  });

  it('does not treat the first digit as the check digit', () => {
    // The original stopped one digit early and compared against the FIRST
    // digit, so it disagreed with the canonical algorithm ~90% of the time.
    // Two numbers differing only in the first digit must not share a verdict
    // unless the checksum genuinely says so.
    const valid = makeValidAadhaar(777);
    const altered = '9' + valid.slice(1);
    expect(canonicalAadhaar(altered)).toBe(false);
    expect(validateAadhaar(altered)).toBe(false);
  });
});

// ── PAN ──────────────────────────────────────────────────────────────────────

describe('validatePAN — entity-type character', () => {
  // Per the Income Tax / NSDL specification the entity type is the FOURTH
  // character (index 3) of AAAAA9999A.
  const SPEC = ['A', 'B', 'C', 'F', 'G', 'H', 'J', 'K', 'L', 'P', 'T'];

  it('exports the full entity vocabulary', () => {
    // 'K' (partnership) was missing entirely; 'B' was missing from the two
    // other copies of this list in the codebase.
    for (const ch of SPEC) {
      expect(PAN_ENTITY_CHARS.has(ch)).toBe(true);
    }
    expect(PAN_ENTITY_CHARS.size).toBe(SPEC.length);
  });

  for (const ch of SPEC) {
    it(`accepts entity type '${ch}' at index 3`, () => {
      expect(validatePAN(`ABC${ch}D1234Z`)).toBe(true);
    });
  }

  it('rejects an invalid entity type at index 3', () => {
    // The old copies checked index 2, so this passed regardless of the real
    // entity character.
    expect(validatePAN('ABCZD1234Z')).toBe(false);
  });

  it('reads index 3, not index 2', () => {
    // Valid entity at index 3, arbitrary letter at index 2: must be accepted.
    expect(validatePAN('AXCPB1234C')).toBe(true);
  });

  it.each([
    ['lowercase', 'abcPB1234c'],
    ['too short', 'ABCPB123Z'],
    ['digits in the letter block', 'AB1PB1234Z'],
    ['empty', ''],
  ])('rejects a malformed PAN: %s', (_label, value) => {
    expect(validatePAN(value)).toBe(false);
  });
});

// ── IFSC ─────────────────────────────────────────────────────────────────────

describe('validateIFSC — 11 characters', () => {
  it.each(['HDFC0001234', 'SBIN0000001', 'ICIC0006480', 'PUNB0123456'])(
    'accepts the real IFSC %s',
    (ifsc) => {
      expect(ifsc).toHaveLength(11);
      expect(validateIFSC(ifsc)).toBe(true);
    }
  );

  it('rejects a 12-character string', () => {
    // This is what the old {7} patterns produced.
    expect(validateIFSC('HDFC00012345')).toBe(false);
  });

  it('rejects a 10-character string', () => {
    expect(validateIFSC('HDFC000123')).toBe(false);
  });
});
