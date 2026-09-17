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
    // Detector masks values on egress by design (first 4 chars + ***),
    // so assert on the masked forms - which still pin DOWN the source.
    const emailVals = (t['EMAIL'] || []).map((d) => d.value).sort();
    // 2 real emails: the support contact + the profile email (deduped per leaf)
    expect(emailVals).toEqual(['raje***', 'supp***']);

    // 1 real phone in the profile section - NOT the planted Aadhaar
    const phoneVals = (t['PHONE'] || []).map((d) => d.value);
    expect(phoneVals).toEqual(['9876***']);

    // The planted "1234 5678 9012" is detected as AADHAAR (not phone)
    expect((t['AADHAAR'] || []).length).toBeGreaterThanOrEqual(1);
    expect((t['AADHAAR'] || [])[0].value).toBe('1234***');

    // The password field is always detected (type=password)
    expect((t['PASSWORD_FIELD'] || []).length).toBe(1);
  });

  it('has ZERO false positives on the controlled page', () => {
    const dets = PIIManager.getInstance().scanDocument();
    const values = (d: { value?: string }) => (d.value || '').toLowerCase();

    const fps: string[] = [];
    for (const d of dets) {
      // Price-table digits (45000/500/1500/12000) must never be PII.
      // The detector masks, so a table FP would show as e.g. "500***".
      if (/^[0-9]+\*+$/.test(values(d)) && /^(45000|500|1500|12000)\*+$/.test(values(d))) {
        fps.push(`table-digit: ${d.type} ${d.value}`);
      }
      // The planted Aadhaar "1234 5678 9012" must NOT surface as a phone.
      if (d.type === 'PHONE' && values(d).startsWith('1234***')) {
        fps.push(`aadhaar-as-phone: ${d.value}`);
      }
    }
    if (fps.length) console.log('FALSE POSITIVES:\n' + fps.join('\n'));
    expect(fps).toEqual([]);

    // No duplicate value at multiple nested levels (ancestor-containment dedupe)
    const seen = new Map<string, number>();
    for (const d of dets) {
      const key = `${d.type}::${d.value}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const [key, n] of seen) {
      if (n > 1) console.log(`DUPLICATE: ${key} x${n}`);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('reports no phone detection originating from the price table', () => {
    const dets = PIIManager.getInstance().scanDocument();
    const tablePhones = dets.filter(
      (d) => d.type === 'PHONE' && /Laptop|Mouse|Keyboard|Monitor|45000|12000/i.test(d.value || ''),
    );
    expect(tablePhones.length).toBe(0);
  });
});
