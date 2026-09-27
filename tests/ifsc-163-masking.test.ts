/**
 * Review of #194: does a detected IFSC actually get masked downstream?
 *
 * `validateIFSC` gates entries in firewall.ts and sanitizer.ts, so the
 * detector/validator agreement the new test pins matters only if the value
 * reaches those. Checked end to end rather than assumed.
 *
 * Two different masking contracts are in play, and conflating them would be
 * wrong:
 *   - the DETECTOR stores non-card PII as '[REDACTED]' (fully redacted)
 *   - maskValue() renders a partial mask for display: 'SBIN0***'
 *
 * The bank prefix (SBIN) is deliberately kept — an IFSC is not a secret in the
 * way a card number is, and the prefix is what makes the value recognisable as
 * a bank code rather than noise. What must not survive is the BRANCH code,
 * which identifies the specific bank branch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { PIIManager } from '../src/lib/pii/detector';
import { validateIFSC, maskValue } from '../src/lib/pii/validators';

const CODE = 'SBIN0000123'; // bank prefix SBIN, '0', branch code 000123

function detectOne(value: string) {
  const dom = new JSDOM(
    `<!doctype html><body><div><label for="f">Bank IFSC code</label>` +
      `<input id="f" name="ifsc" value="${value}"></div></body>`,
    { url: 'https://bank.example/' }
  );
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  globalThis.document = dom.window.document as unknown as typeof globalThis.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  try {
    PIIManager.getInstance().clear();
    return PIIManager.getInstance().scanDocument();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
}

describe('#194 review: an IFSC is detected and masked downstream', () => {
  afterEach(() => PIIManager.getInstance().clear());

  it('validateIFSC accepts it', () => {
    expect(validateIFSC(CODE)).toBe(true);
  });

  it('the detector finds it in a form field', () => {
    expect(detectOne(CODE).map((d) => d.type)).toContain('IFSC');
  });

  it('the stored value is fully redacted, not a partial prefix', () => {
    // A partial-raw STORED value would be a leak in its own right: the
    // detector's contract for non-card PII is complete redaction.
    const ifsc = detectOne(CODE).filter((d) => d.type === 'IFSC');
    expect(ifsc.length).toBeGreaterThan(0);
    for (const d of ifsc) {
      expect(d.value).toBe('[REDACTED]');
      expect(d.value).not.toContain('SBIN');
      expect(d.value).not.toContain('000123');
    }
  });

  it('maskValue keeps the bank prefix but drops the branch code', () => {
    const m = maskValue(CODE, 'IFSC');
    // The bank prefix is retained on purpose — an IFSC prefix is public
    // information and is what makes the value recognisable as a bank code.
    expect(m).toContain('SBIN');
    // The branch code identifies the specific branch and must not survive.
    expect(m).not.toContain('000123');
    expect(m).toBe('SBIN0***');
  });

  it('the firewall validator agrees, so no IFSC-shaped value escapes the strict rule', () => {
    // firewall.ts / sanitizer.ts register validateIFSC directly. A code the
    // detector claims but the validator rejects would be redacted as
    // IFSC-shaped while escaping the stricter rule.
    for (const bad of ['SBIN1000123', 'SBI0000123', 'SBIN00001234', 'sbin0000123']) {
      expect(validateIFSC(bad), bad).toBe(false);
      expect(
        detectOne(bad).filter((d) => d.type === 'IFSC'),
        bad
      ).toHaveLength(0);
    }
  });
});
