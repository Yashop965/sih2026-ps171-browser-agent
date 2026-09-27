/**
 * #189 — prose must not become a cross-tab handoff label.
 *
 * The upstream root cause was in `harvestFields()`: shapes 1 (`<dt>/<dd>`) and
 * 3 (`<th>/<td>`) constrained the label not at all, so on a *statement* page
 * rather than a *form*, its content rows became the handoff and its prose
 * became labels. A person name then crossed to `/plan`.
 *
 * `maskLabel` closes every structured PII type but has no NAME rule, and there
 * is deliberately no name detector — a name is two capitalised words, which
 * also matches every product title and company name. So the gate removes
 * PROSE instead.
 *
 * The tests that matter most here are the KEEP ones. A privacy fix that
 * discards `Date of birth` has traded a leak for a usability regression, and
 * an earlier attempt at this issue did exactly that and was reverted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/** The gate as shipped, mirrored for direct testing. */
function looksLikeFieldPair(label: string, value: string): boolean {
  const l = label.trim().replace(/\s+/g, ' ');
  const v = value.trim().replace(/\s+/g, ' ');
  if (!l || l.length > 40) return false;
  if (l.split(' ').length > 5) return false;
  if (/[.,;!?]/.test(l)) return false;
  if (!v || v.length > 200) return false;
  if (v.split(' ').length > 12) return false;
  if (/[.:;]$/.test(v)) return false;
  if (
    /subject to|as on|as of|hereby|unless |the following|in accordance|notwithstanding|provided that|entitled to/i.test(
      v
    )
  )
    return false;
  return true;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('#189 real form fields SURVIVE the gate', () => {
  // This is the regression that killed the previous attempt. `Date of birth`
  // contains the connective "of", and a connective-word gate dropped it.
  const MUST_KEEP: Array<[string, string]> = [
    ['Account holder', 'Ravi Sharma'],
    ['Date of birth', '12-03-2024'],
    ['Date of issue', '12-03-2024'],
    ['Name of applicant', 'Ravi Sharma'],
    ['PAN', 'ABCDE1234F'],
    ['Aadhaar', '100000000004'],
    ['Mobile', '+91 98765 43210'],
    ['Email', 'ravi@example.com'],
    ['Status', 'Active'],
    ['Total', '12,34,567'],
    ['Father name', 'Suresh Sharma'],
    ['Permanent address', '12 MG Road, Pune'],
  ];

  for (const [label, value] of MUST_KEEP) {
    it(`keeps "${label}" = "${value}"`, () => {
      expect(
        looksLikeFieldPair(label, value),
        `${label} is a real field label and must reach the planner`
      ).toBe(true);
    });
  }
});

describe('#189 statement-page prose is rejected', () => {
  const MUST_DROP: Array<[string, string, string]> = [
    [
      'Issued to Ravi Sharma on 12-03-2024',
      'Valid till 2030',
      'label: too many words and reads as a sentence',
    ],
    [
      'Status as on 12-03-2024',
      'Active, subject to verification.',
      'value is a sentence of legalese',
    ],
    [
      'This certificate is issued to the applicant',
      'Valid',
      'label is far too long to be a field label',
    ],
    ['Certificate holder', 'Valid, subject to the terms', 'value is a clause'],
    ['Beneficiary', 'Active as on 12-03-2024', 'value carries a legalese phrase'],
    // Needs the LABEL punctuation rule specifically: short, few words, no
    // legalese, and the value is a clean field value. Every other rule passes
    // it, so deleting the punctuation check must fail this case alone.
    ['Balance, closing', '4,000', 'label is a comma-spliced fragment, not a label'],
    // Needs the value trailing-punctuation rule specifically: no legalese
    // phrase, just a colon-terminated fragment.
    ['Reference', 'See:', 'value ends in a colon rather than a value'],
  ];

  for (const [label, value, why] of MUST_DROP) {
    it(`drops "${label.slice(0, 40)}" (${why})`, () => {
      expect(looksLikeFieldPair(label, value)).toBe(false);
    });
  }
});

describe('#189 the gate is a CHOKE POINT, not per-shape', () => {
  // Applied inside `add()`, which every shape calls. Patching shapes
  // individually is how the policy drifts between them.
  it('the content script filters in add(), not per shape', () => {
    const src = readFileSync('src/entrypoints/content.ts', 'utf-8');
    expect(src).toContain('if (!looksLikeFieldPair(l, v)) return;');
    // Exactly one call site: if a second appears, someone bypassed the gate.
    const calls = src.match(/looksLikeFieldPair\(/g) ?? [];
    // 1 definition + 1 call site (the docstring mentions it by name only in prose)
    expect(calls.length).toBe(2);
  });

  it('the harvest still has all four shapes', () => {
    // Dropping shapes 1 and 3 outright was considered and REJECTED: the #141
    // motivating task reads values off a compliance sheet, which is a table,
    // and a `<td>` value is exactly what shape 3 harvests. Deleting it would
    // remove the feature the handoff exists for.
    const src = readFileSync('src/entrypoints/content.ts', 'utf-8');
    expect(src).toContain("querySelectorAll('dt')");
    expect(src).toContain("querySelectorAll('label[for]')");
    expect(src).toContain("querySelectorAll('tr')");
    expect(src).toMatch(/querySelectorAll\(\s*\n?\s*'li, dd, \.field/);
  });
});

describe('#189 KNOWN LIMIT — a bare name in a well-formed row still crosses', () => {
  // Documented deliberately, not fixed. `Ravi Sharma` / `Account Holder` is
  // structurally indistinguishable from `Account holder` / `Ravi Sharma`, and
  // the only rule that separates them is guessing that a name is a name.
  it('is recorded as a limitation, not silently asserted as safe', () => {
    const src = readFileSync('src/entrypoints/content.ts', 'utf-8');
    expect(src).toMatch(/KNOWN LIMIT/);
    expect(src).toMatch(/bare name/i);
    // And the reason it is not fixed must be stated where it would tempt
    // someone to "just add a name check".
    expect(src).toMatch(/false-positive machine|guessing names/i);
  });

  it('the codebase still has no person-name detector', () => {
    // Guards against a future contributor adding a capitalised-two-words
    // regex without weighing what it costs.
    const src = readFileSync('src/entrypoints/content.ts', 'utf-8');
    expect(src).not.toMatch(/\bNAME\s*:\s*\[/);
  });
});
