/**
 * #166 — cross-tab handoff labels are page text, and the firewall is their only
 * barrier. It does not catch person names.
 *
 * This file exists because a review of #188 found the first version of that fix
 * was PARTIAL while its description claimed the leak was closed. It closes
 * every structured PII type and leaves prose open. Both halves are pinned here:
 * the wins so they cannot silently regress, and the gap so it stays visible and
 * cannot be quietly forgotten.
 *
 * The gap is documented at length in handoffForPlanner's docstring, including
 * the upstream root cause in harvestFields. Do not "fix" it here with a
 * label-shape heuristic - that was tried and does not work.
 */

import { describe, it, expect } from 'vitest';
import { harvestToHandoff, handoffForPlanner } from '../src/lib/tabHandoff';

const sent = (label: string): string => {
  const out = handoffForPlanner(harvestToHandoff([{ label, value: 'v' }]))!;
  expect(out).toHaveLength(1);
  return out[0].label;
};

describe('#166 structured PII in a label is masked', () => {
  // Each of these is measured against the shipped path, not asserted from the
  // pattern list - a test that restates the regex would pass against the
  // unmasked code.
  it.each([
    ['Contact ravi.sharma@example.com', 'ravi.sharma@example.com'],
    ['Mobile +91 98765 43210', '98765'],
    ['PAN ABCDE1234F', 'ABCDE1234F'],
    ['Aadhaar 100000000004', '100000000004'],
    ['Card 4111111111111111', '4111111111111111'],
    ['IFSC SBIN0001234', 'SBIN0001234'],
  ])('does not send the raw value of %j', (label, secret) => {
    const out = sent(label);
    expect(out).not.toContain(secret);
    // And it keeps the field identity, so the planner can still use it.
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('text field');
  });

  it('keeps the token intact so the planner can still reference the field', () => {
    const out = handoffForPlanner(
      harvestToHandoff([{ label: 'Aadhaar 100000000004', value: 'v' }])
    )!;
    expect(out[0].token).toBe('<FIELD_1>');
  });

  it('NEVER includes the harvested value (unchanged hard rule)', () => {
    const out = handoffForPlanner(
      harvestToHandoff([{ label: 'Aadhaar 100000000004', value: 'SUPERSECRET' }])
    )!;
    expect(JSON.stringify(out)).not.toContain('SUPERSECRET');
  });

  it('still returns undefined for an empty handoff', () => {
    expect(handoffForPlanner(null)).toBeUndefined();
    expect(handoffForPlanner(undefined)).toBeUndefined();
    expect(
      handoffForPlanner({ values: {}, labels: {}, extractedAt: 0, sourceUrl: '' })
    ).toBeUndefined();
  });
});

describe('#166 KNOWN GAP — narrowed by #189, not eliminated', () => {
  // These were the issue's own headline examples. #189 fixed the leak UPSTREAM
  // in `harvestFields`, so `Ravi Sharma` never becomes a label to mask. What
  // remains is a genuinely undecidable case, documented here rather than
  // papered over: a bare name in a well-formed label/value row.
  //
  // `maskLabel` is unchanged and still has no NAME rule — adding one is the
  // false-positive machine #189 explicitly declined. These tests now pin the
  // RESIDUAL risk at the masking layer, where it belongs.
  it('maskLabel still passes prose through — #189 fixes this upstream', () => {
    const out = sent('Issued to Ravi Sharma on 12-03-2024');
    expect(out).toBe('Issued to Ravi Sharma on 12-03-2024');
  });

  it('the residual case is a bare name, which harvestFields can no longer gate', () => {
    // <th>Ravi Sharma</th><td>Account Holder</td> is structurally identical
    // to <th>Account holder</th><td>Ravi Sharma</td>. There is no signal that
    // separates them, so this crosses. Documented, not fixed.
    expect(sent('Ravi Sharma')).toBe('Ravi Sharma');
  });

  it('the codebase has no person-name detector, by design', () => {
    // Guards against someone adding a high-false-positive name regex later
    // without thinking about it. A name is two capitalised words; that shape
    // also matches every product title and company name.
    const out = sent('Acme Corporation Ltd');
    expect(out).toBe('Acme Corporation Ltd');
  });
});
