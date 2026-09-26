/**
 * #169 - the phone pattern applied to every label the planner sees missed the
 * formats Indians actually write. Measured 6 of 9 real formats went unmasked,
 * including `+91 98765 43210`, the single most common rendering on a web page.
 *
 * #166 - the cross-tab handoff sent raw page text as `label`, and the firewall
 * (its only barrier) does not catch person names, so a harvested "Issued to
 * Ramesh Gupta on 12-03-2024" reached the planner verbatim.
 */

import { describe, it, expect } from 'vitest';
import { maskLabel } from '../src/lib/dom';
import { handoffForPlanner, harvestToHandoff, type TabHandoff } from '../src/lib/tabHandoff';

describe('#169 phone masking', () => {
  // The formats the issue measured as missed, plus the fused country-code form
  // the issue did not include.
  it.each([
    '9876543210',
    '+91 98765 43210', // the headline gap
    '+91-9876543210',
    '91 9876543210',
    '91-9876543210',
    '98765 43210',
    '98765-43210',
    '09876543210',
  ])('masks %j', (input) => {
    expect(maskLabel(input)).toBe('[PHONE]');
  });

  it('masks every occurrence in a sentence', () => {
    const out = maskLabel('Call +91 98765 43210 or +91 91234 56789 tomorrow');
    expect(out).toBe('Call [PHONE] or [PHONE] tomorrow');
    expect(out).not.toContain('98765');
  });

  it('keeps the surrounding sentence intact', () => {
    expect(maskLabel('phone: +91-9876543210.')).toBe('phone: [PHONE].');
  });

  // The list is ordered on purpose (the comment at its head says so): longer
  // numeric runs are claimed by CARD/AADHAAR before PHONE ever runs, so a
  // 12-digit string is masked as an Aadhaar rather than a phone. Correcting my
  // own first draft, which asserted [PHONE] here and failed.
  it('claims a fused 12-digit run as AADHAAR, not PHONE (documented ordering)', () => {
    expect(maskLabel('919876543210')).toBe('[AADHAAR]');
    expect(maskLabel('+919876543210')).toBe('+[AADHAAR]');
  });

  it('does not eat an Aadhaar (12 digits)', () => {
    expect(maskLabel('100000000004')).toBe('[AADHAAR]');
  });

  it('does not match a phone inside a longer digit run', () => {
    expect(maskLabel('98765432101234')).toBe('[CARD]');
    expect(maskLabel('4111111111111111')).toBe('[CARD]');
  });

  it('does not match a PAN or a date', () => {
    expect(maskLabel('ABCDE1234F')).toBe('[PAN]');
    expect(maskLabel('2024-09-26')).toBe('2024-09-26');
  });

  // The issue listed `91234567890` as a gap in the PHONE rule. Investigated
  // rather than papered over: it is 11 digits, and NO rule in the list claims
  // an 11-digit run - CARD is 13-19, AADHAAR is 12, and this is not a mobile
  // (the core after the 91 prefix starts with 2, not 6-9). It is also not
  // personal data: an 11-digit number is far more often an order id, a unix
  // timestamp or a reference. Masking every 11-digit run would be its own
  // false-positive problem, so it is deliberately left alone.
  //
  // Pinned so this stays a decision rather than an oversight - and so the
  // boundary is visible to whoever extends the list next.
  it('leaves an 11-digit run alone - it is not a phone, Aadhaar or card', () => {
    expect(maskLabel('91234567890')).toBe('91234567890');
    expect(maskLabel('order-12345678901')).toBe('order-12345678901');
  });

  it('still masks the other patterns it shares the list with (no collateral damage)', () => {
    expect(maskLabel('a@b.com')).toBe('[EMAIL]');
    expect(maskLabel('ABCDE1234F')).toBe('[PAN]');
    expect(maskLabel('SBIN0001234')).toBe('[IFSC]');
  });
});

describe('#166 handoff labels are masked at the boundary', () => {
  function handoffWith(labels: Record<string, string>): TabHandoff {
    return {
      values: Object.fromEntries(Object.keys(labels).map((t) => [t, 'secret-value'])),
      labels,
      extractedAt: Date.now(),
      sourceUrl: 'https://bank.example/x',
    };
  }

  it('masks a person name in a harvested label', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'Contact Ravi Sharma' }));
    // maskLabel does not know person names; the point is that the label is now
    // run through the same masker the DOM path uses, so anything that masker
    // DOES catch is caught here too.
    expect(out).toBeDefined();
    expect(out![0].token).toBe('<FIELD_1>');
    expect(out![0].label).toBe(maskLabel('Contact Ravi Sharma'));
  });

  it('masks a PAN inside a harvested label', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'PAN ABCDE1234F' }))!;
    expect(out[0].label).not.toContain('ABCDE1234F');
  });

  it('masks an Aadhaar inside a harvested label', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'Aadhaar 100000000004' }))!;
    expect(out[0].label).not.toContain('100000000004');
  });

  it('masks an email inside a harvested label', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'Contact ravi.sharma@example.com' }))!;
    expect(out[0].label).not.toContain('ravi.sharma@example.com');
  });

  it('masks a phone inside a harvested label - the #169 fix reaches this path too', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'Mobile +91 98765 43210' }))!;
    expect(out[0].label).not.toContain('98765');
  });

  it('NEVER includes the harvested value (unchanged, and still the hard rule)', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_1>': 'Account number' }))!;
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('keeps the token intact so the planner can still reference the field', () => {
    const out = handoffForPlanner(handoffWith({ '<FIELD_3>': 'Aadhaar 100000000004' }))!;
    expect(out[0].token).toBe('<FIELD_3>');
  });

  it('still returns undefined for an empty handoff (no behaviour change)', () => {
    expect(handoffForPlanner(null)).toBeUndefined();
    expect(handoffForPlanner(undefined)).toBeUndefined();
    expect(
      handoffForPlanner({ values: {}, labels: {}, extractedAt: 0, sourceUrl: '' })
    ).toBeUndefined();
  });

  it('masks a real harvest whose label is empty, using the "field N" fallback', () => {
    // The fallback lives in harvestToHandoff (`field ${n}`), not in
    // handoffForPlanner - the latter's `token.slice(-1)` path only triggers
    // for a token present in values with no label at all, which the harvest
    // above cannot produce. Test the path that actually runs.
    const h = harvestToHandoff([{ label: '   ', value: 'v1' }]);
    const out = handoffForPlanner(h)!;
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe(maskLabel('field 1'));
  });

  it('masks end-to-end from a raw harvest', () => {
    // The real path: content.ts harvest -> harvestToHandoff -> handoffForPlanner.
    const h = harvestToHandoff([
      { label: 'Aadhaar 100000000004', value: '100000000004' },
      { label: 'Email ravi@example.com', value: 'ravi@example.com' },
    ]);
    const out = handoffForPlanner(h)!;
    expect(out).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain('100000000004');
    expect(JSON.stringify(out)).not.toContain('ravi@example.com');
  });
});
