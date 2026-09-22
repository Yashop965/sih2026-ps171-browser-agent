/**
 * PII Precision Regression Test — issue #104
 *
 * Encodes the ground truth of `public/pii-test-page.html` so that any detector
 * change that either (a) re-introduces the known false positives (price-table
 * digits, the planted Aadhaar read as a phone, sentinel values) or (b) drops a
 * planted true positive (the two real emails, the real phone, the password
 * field, the Aadhaar) is caught in CI.
 *
 * The assertion block at the bottom is the post-fix target; run against the
 * unfixed detector to see the "before" false-positive list in the report.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { PIIManager } from '../src/lib/pii/detector';

const PAGE = readFileSync('public/pii-test-page.html', 'utf8');

describe('PII precision regression on pii-test-page.html', () => {
  let dom: JSDOM;
  let originalDocument: Document;

  beforeEach(() => {
    dom = new JSDOM(PAGE, { url: 'https://example.com/' });
    originalDocument = globalThis.document as unknown as Document;
    globalThis.document = dom.window.document as unknown as typeof globalThis.document;
    globalThis.window = dom.window as unknown as typeof globalThis.window;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  const byType = (dets: ReturnType<typeof PIIManager.prototype.getDetections>) => {
    const m: Record<string, ReturnType<typeof PIIManager.prototype.getDetections>> = {};
    for (const d of dets) (m[d.type] ||= []).push(d);
    return m;
  };

  it('detects ALL planted true positives', () => {
    const dets = PIIManager.getInstance().scanDocument();
    const t = byType(dets);
    // C3: non-card PII values are stored FULLY redacted ('[REDACTED]') - the
    // old first-4-chars prefix (`raje***`) was itself the C3 leak. We now pin
    // the privacy contract: correct per-type COUNTS + a fully-redacted value,
    // instead of a partial-raw prefix. Card types keep the first4/last4 mask.
    const emailVals = (t['EMAIL'] || []).map((d) => d.value).sort();
    // 2 real emails: the support contact + the profile email (deduped per leaf)
    expect(emailVals).toEqual(['[REDACTED]', '[REDACTED]']);

    // 1 real phone in the profile section - NOT the planted Aadhaar
    const phoneVals = (t['PHONE'] || []).map((d) => d.value);
    expect(phoneVals).toEqual(['[REDACTED]']);

    // The planted "1234 5678 9012" is detected as AADHAAR (not phone), redacted
    expect((t['AADHAAR'] || []).length).toBeGreaterThanOrEqual(1);
    expect((t['AADHAAR'] || [])[0].value).toBe('[REDACTED]');

    // The password field is always detected (type=password)
    expect((t['PASSWORD_FIELD'] || []).length).toBe(1);
  });

  it('has ZERO false positives on the controlled page', () => {
    const dets = PIIManager.getInstance().scanDocument();
    const byT = byType(dets);

    // (1) The planted Aadhaar "1234 5678 9012" must NOT also register as a
    //     phone - exactly one PHONE (the real profile phone) is expected. A
    //     mis-classified aadhaar would inflate this to 2.
    expect((byT['PHONE'] || []).length).toBe(1);

    // (2) No double-report of the same element + type (ancestor-containment
    //     dedupe, issue #104). Post-C3 the value is a shared '[REDACTED]'
    //     sentinel, so it can no longer discriminate distinct PII - key on the
    //     originating selector instead. A broken dedupe that re-reports the
    //     same element shows up as a repeated selector.
    const seen = new Map<string, number>();
    for (const d of dets) {
      const key = `${d.type}::${d.selector}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const [key, n] of seen) {
      if (n > 1) console.log(`DUPLICATE: ${key} x${n}`);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('reports no phone detection originating from the price table', () => {
    const dets = PIIManager.getInstance().scanDocument();
    // A price-table phone FP would now surface via its element's selector, not
    // a redacted value - key the check on the selector.
    const tablePhones = dets.filter(
      (d) => d.type === 'PHONE' && /Laptop|Mouse|Keyboard|Monitor|45000|12000/i.test(d.selector || ''),
    );
    expect(tablePhones.length).toBe(0);
  });
});
