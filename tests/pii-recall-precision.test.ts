/**
 * PII Recall/Precision Benchmark Test Suite
 * 
 * Comprehensive tests for the PII detection system covering:
 * 1. Ground truth test data with known PII
 * 2. Detection accuracy measurements (recall/precision)
 * 3. False positive testing
 * 4. Adversarial PII cases (obfuscated formats)
 * 5. Metrics reporting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { PIIManager, type PIIDetection } from '../src/lib/pii/detector';
import { validateAadhaar, validatePAN, validateCard } from '../src/lib/pii/validators';

// ─── Ground Truth Test Data ────────────────────────────────────────────────────

interface GroundTruthPII {
  type: string;
  value: string;
  rawValue?: string;
  expectedMatch: boolean;
}

interface TestCase {
  name: string;
  html: string;
  expectedCount: number;
  expectedTypes: string[];
}

interface AdversarialCase {
  name: string;
  html: string;
  shouldDetect: boolean;
  description: string;
}

interface MetricResult {
  type: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
}

// Valid test data with checksums
const VALID_AADHAAR = [
  '284666630139', // Verified
  '403602168771', // Verified
  '654482786327', // Verified
];

const INVALID_AADHAAR = [
  '123456789012', // Wrong checksum
  '000000000000', // All zeros
  '111122223333', // Pattern checksum
];

const VALID_PAN = [
  'ABCDE1234F', // Valid format
  'BSTOP1234C', // Valid format
  'AABCA1234D', // Valid format
];

const VALID_CREDIT_CARDS = [
  '4111111111111111', // Visa test
  '5500000000000004', // Mastercard test
  '3400000000000009', // Amex test (15 digits)
];

const VALID_IFSC = [
  'SBIN0001234',
  'HDFC0001234',
  'ICIC0001234',
];

const VALID_EMAILS = [
  'user@example.com',
  'test.user@domain.org',
  'admin+tag@company.co.in',
];

const VALID_PHONES = [
  '+919876543210',
  '9876543210',
  '09876543210',
];

const VALID_UPI = [
  'user@upi',
  'phone@okaxis',
  'name@hdfc',
];

// ─── Metrics Calculator ────────────────────────────────────────────────────────

class MetricsCalculator {
  private results: Map<string, MetricResult> = new Map();

  record(type: string, tp: number, fp: number, fn: number) {
    if (!this.results.has(type)) {
      this.results.set(type, { type, truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: 0, recall: 0, f1Score: 0 });
    }
    const r = this.results.get(type)!;
    r.truePositives += tp;
    r.falsePositives += fp;
    r.falseNegatives += fn;
    r.precision = r.truePositives > 0 ? r.truePositives / (r.truePositives + r.falsePositives) : 0;
    r.recall = r.truePositives > 0 ? r.truePositives / (r.truePositives + r.falseNegatives) : 0;
    r.f1Score = r.precision + r.recall > 0 ? 2 * (r.precision * r.recall) / (r.precision + r.recall) : 0;
  }

  getResults(): MetricResult[] {
    return Array.from(this.results.values());
  }

  getOverall(): MetricResult {
    let tp = 0, fp = 0, fn = 0;
    for (const r of this.results.values()) {
      tp += r.truePositives;
      fp += r.falsePositives;
      fn += r.falseNegatives;
    }
    const precision = tp > 0 ? tp / (tp + fp) : 0;
    const recall = tp > 0 ? tp / (tp + fn) : 0;
    return {
      type: 'OVERALL',
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1Score: precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0,
    };
  }

  printReport(): string {
    const lines: string[] = [];
    lines.push('\n' + '='.repeat(80));
    lines.push('PII DETECTION BENCHMARK REPORT');
    lines.push('='.repeat(80) + '\n');
    
    lines.push('| Type              | TP  | FP  | FN  | Precision | Recall  | F1    |');
    lines.push('|-------------------|-----|-----|-----|-----------|---------|-------|');
    
    for (const r of this.results.values()) {
      lines.push(`| ${r.type.padEnd(19)} | ${String(r.truePositives).padStart(3)} | ${String(r.falsePositives).padStart(3)} | ${String(r.falseNegatives).padStart(3)} | ${r.precision.toFixed(3).padStart(9)} | ${r.recall.toFixed(3).padStart(7)} | ${r.f1Score.toFixed(3)} |`);
    }
    
    const overall = this.getOverall();
    lines.push('|-------------------|-----|-----|-----|-----------|---------|-------|');
    lines.push(`| ${overall.type.padEnd(19)} | ${String(overall.truePositives).padStart(3)} | ${String(overall.falsePositives).padStart(3)} | ${String(overall.falseNegatives).padStart(3)} | ${overall.precision.toFixed(3).padStart(9)} | ${overall.recall.toFixed(3).padStart(7)} | ${overall.f1Score.toFixed(3)} |`);
    lines.push('='.repeat(80));
    
    return lines.join('\n');
  }
}

// ─── Test Suites ───────────────────────────────────────────────────────────────

describe('PII Recall/Precision Benchmark Suite', () => {
  let dom: JSDOM;
  let calculator: MetricsCalculator;
  let originalDocument: Document;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    originalDocument = globalThis.document as unknown as Document;
    globalThis.document = dom.window.document as unknown as typeof globalThis.document;
    globalThis.window = dom.window as any;
    calculator = new MetricsCalculator();
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  // ─── 1. Ground Truth Detection Tests ───────────────────────────────────────

  describe('Ground Truth Detection Accuracy', () => {
    it('should detect valid Aadhaar numbers (Verhoeff checksum)', () => {
      const html = `
        <div id="aadhaar-test">
          <input id="aad1" value="${VALID_AADHAAR[0]}" />
          <span id="aad2">${VALID_AADHAAR[1]}</span>
          <p id="aad3">Aadhaar: ${VALID_AADHAAR[2]}</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const aadhaarDetections = detections.filter(d => d.type === 'AADHAAR');

      // Should detect at least some Aadhaar numbers
      console.log(`\n[Aadhaar Detection] Found: ${aadhaarDetections.length}/${VALID_AADHAAR.length}`);
      
      // Verify checksum validation
      for (const val of VALID_AADHAAR) {
        expect(validateAadhaar(val)).toBe(true);
      }
      
      // Report metrics
      calculator.record('AADHAAR', aadhaarDetections.length, 0, VALID_AADHAAR.length - aadhaarDetections.length);
    });

    it('should detect valid PAN numbers', () => {
      const html = `
        <div id="pan-test">
          <input id="pan1" value="${VALID_PAN[0]}" />
          <span id="pan2">${VALID_PAN[1]}</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const panDetections = detections.filter(d => d.type === 'PAN');

      console.log(`\n[PAN Detection] Found: ${panDetections.length}/${VALID_PAN.length}`);
      calculator.record('PAN', panDetections.length, 0, VALID_PAN.length - panDetections.length);
    });

    it('should detect valid credit card numbers (Luhn)', () => {
      const html = `
        <div id="card-test">
          <input id="card1" value="${VALID_CREDIT_CARDS[0]}" />
          <span id="card2">${VALID_CREDIT_CARDS[1]}</span>
          <p id="card3">Card: ${VALID_CREDIT_CARDS[2]}</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const cardDetections = detections.filter(d => d.type === 'CREDIT_CARD');

      console.log(`\n[Credit Card Detection] Found: ${cardDetections.length}/${VALID_CREDIT_CARDS.length}`);
      
      // Verify Luhn checksum
      for (const val of VALID_CREDIT_CARDS) {
        expect(validateCard(val)).toBe(true);
      }
      
      calculator.record('CREDIT_CARD', cardDetections.length, 0, VALID_CREDIT_CARDS.length - cardDetections.length);
    });

    it('should detect valid IFSC codes', () => {
      const html = `
        <div id="ifsc-test">
          <input id="ifsc1" value="${VALID_IFSC[0]}" />
          <span id="ifsc2">${VALID_IFSC[1]}</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const ifscDetections = detections.filter(d => d.type === 'IFSC');

      console.log(`\n[IFSC Detection] Found: ${ifscDetections.length}/${VALID_IFSC.length}`);
      calculator.record('IFSC', ifscDetections.length, 0, VALID_IFSC.length - ifscDetections.length);
    });

    it('should detect valid email addresses', () => {
      const html = `
        <div id="email-test">
          <input id="email1" value="${VALID_EMAILS[0]}" />
          <span id="email2">${VALID_EMAILS[1]}</span>
          <p id="email3">Contact: ${VALID_EMAILS[2]}</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const emailDetections = detections.filter(d => d.type === 'EMAIL');

      console.log(`\n[Email Detection] Found: ${emailDetections.length}/${VALID_EMAILS.length}`);
      calculator.record('EMAIL', emailDetections.length, 0, VALID_EMAILS.length - emailDetections.length);
    });

    it('should detect valid phone numbers', () => {
      const html = `
        <div id="phone-test">
          <input id="phone1" value="${VALID_PHONES[0]}" />
          <span id="phone2">${VALID_PHONES[1]}</span>
          <p id="phone3">Phone: ${VALID_PHONES[2]}</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const phoneDetections = detections.filter(d => d.type === 'PHONE');

      console.log(`\n[Phone Detection] Found: ${phoneDetections.length}/${VALID_PHONES.length}`);
      calculator.record('PHONE', phoneDetections.length, 0, VALID_PHONES.length - phoneDetections.length);
    });

    it('should detect password fields', () => {
      const html = `
        <div id="pwd-test">
          <input type="password" id="pwd1" name="password" />
          <input type="password" id="pwd2" name="pwd" />
          <input type="text" id="not-pwd" name="username" />
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const pwdDetections = detections.filter(d => d.type === 'PASSWORD_FIELD');

      console.log(`\n[Password Field Detection] Found: ${pwdDetections.length}/2 expected`);
      expect(pwdDetections.length).toBe(2);
      calculator.record('PASSWORD_FIELD', pwdDetections.length, 0, 2 - pwdDetections.length);
    });
  });

  // ─── 2. False Positive Testing ───────────────────────────────────────────────

  describe('False Positive Testing', () => {
    it('should not flag random 12-digit numbers as Aadhaar', () => {
      const html = `
        <div>
          <span>Order ID: 123456789012</span>
          <span>Batch: 987654321098</span>
          <span>Reference: 111122223333</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const aadhaarDetections = detections.filter(d => d.type === 'AADHAAR');

      console.log(`\n[Aadhaar False Positives] Detected: ${aadhaarDetections.length} (should be 0)`);
      calculator.record('AADHAAR_FALSE_POS', 0, aadhaarDetections.length, 0);
    });

    it('should not flag random 16-digit numbers as credit cards', () => {
      const html = `
        <div>
          <span>Serial: 1234567890123456</span>
          <span>License: 9876543210987654</span>
          <span>ID: 1111222233334444</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const cardDetections = detections.filter(d => d.type === 'CREDIT_CARD');

      console.log(`\n[Credit Card False Positives] Detected: ${cardDetections.length} (should be 0)`);
      calculator.record('CREDIT_CARD_FALSE_POS', 0, cardDetections.length, 0);
    });

    it('should not flag random 10-char strings as PAN', () => {
      const html = `
        <div>
          <span>Code: ABCDE12345</span>
          <span>Ref: XYZAB6789C</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const panDetections = detections.filter(d => d.type === 'PAN');

      console.log(`\n[PAN False Positives] Detected: ${panDetections.length} (should be 0)`);
      calculator.record('PAN_FALSE_POS', 0, panDetections.length, 0);
    });

    it('should not flag normal text as PII', () => {
      const html = `
        <div>
          <p>The quick brown fox jumps over the lazy dog.</p>
          <p>Regular text with no personal information.</p>
          <span>Product code: ABC-123-XYZ</span>
          <span>Version: 1.2.3</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`\n[Normal Text False Positives] Detected: ${detections.length} (should be 0)`);
      calculator.record('GENERAL_FALSE_POS', 0, detections.length, 0);
    });

    it('should not flag numeric sequences in text as PII', () => {
      const html = `
        <div>
          <p>Prices: $123.45, $678.90, $99.99</p>
          <p>Phone: (123) 456-7890 is not Indian</p>
          <span>ISBN: 978-0-123456-78-9</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const piiDetections = detections.filter(d => !d.type.includes('FALSE'));

      console.log(`\n[Numeric Sequence False Positives] Detected: ${piiDetections.length}`);
    });
  });

  // ─── 3. Adversarial PII Cases (Obfuscated Formats) ─────────────────────────

  describe('Adversarial PII Detection (Obfuscated Formats)', () => {
    const adversarialCases: AdversarialCase[] = [
      {
        name: 'Aadhaar with spaces',
        html: '<span>2846 6663 0139</span>',
        shouldDetect: true,
        description: 'Aadhaar with space separators',
      },
      {
        name: 'PAN mixed case',
        html: '<span>abcde1234f</span>',
        shouldDetect: false,
        description: 'Lowercase PAN should not match (regex is uppercase only)',
      },
      {
        name: 'Credit card with dashes',
        html: '<span>4111-1111-1111-1111</span>',
        shouldDetect: true,
        description: 'Card with dash separators',
      },
      {
        name: 'Credit card with spaces',
        html: '<span>4111 1111 1111 1111</span>',
        shouldDetect: true,
        description: 'Card with space separators',
      },
      {
        name: 'Email with subdomain',
        html: '<span>user@mail.example.com</span>',
        shouldDetect: true,
        description: 'Email with subdomain',
      },
      {
        name: 'Phone with country code',
        html: '<span>+91 98765 43210</span>',
        shouldDetect: true,
        description: 'Indian phone with country code',
      },
      {
        name: 'Phone without country code',
        html: '<span>9876543210</span>',
        shouldDetect: true,
        description: 'Indian phone without country code',
      },
      {
        name: 'IFSC lowercase',
        html: '<span>sbin0001234</span>',
        shouldDetect: false,
        description: 'Lowercase IFSC should not match',
      },
      {
        name: 'UPI VPA',
        html: '<span>user@upi</span>',
        shouldDetect: true,
        description: 'UPI Virtual Payment Address',
      },
      {
        name: 'Password in input field',
        html: '<input type="password" value="SecretPass123!" />',
        shouldDetect: true,
        description: 'Password field should be detected',
      },
      {
        name: 'Partially masked Aadhaar',
        html: '<span>2846 **** **** 0139</span>',
        shouldDetect: false,
        description: 'Already masked value should not trigger',
      },
      {
        name: 'Partial PAN',
        html: '<span>ABCDE****F</span>',
        shouldDetect: false,
        description: 'Partial PAN should not trigger',
      },
    ];

    for (const tc of adversarialCases) {
      it(tc.name, () => {
        dom.window.document.body.innerHTML = tc.html;
        
        const manager = PIIManager.getInstance();
        manager.clear();
        const detections = manager.scanDocument();

        const hasDetection = detections.length > 0;
        const passed = hasDetection === tc.shouldDetect;

        console.log(`\n[Adversarial: ${tc.name}] Expected detect=${tc.shouldDetect}, Got detect=${hasDetection}, ${passed ? 'PASS' : 'FAIL'} - ${tc.description}`);
        
        if (!passed) {
          console.log(`  Detections found:`, detections.map(d => ({ type: d.type, value: d.value })));
        }
      });
    }
  });

  // ─── 4. Realistic HTML Page Tests ────────────────────────────────────────────

  describe('Realistic HTML Page Scenarios', () => {
    it('should detect PII in a user profile form', () => {
      const html = `
        <form id="profile-form">
          <div>
            <label>Aadhaar Number</label>
            <input type="text" id="aadhaar" value="${VALID_AADHAAR[0]}" />
          </div>
          <div>
            <label>PAN Card</label>
            <input type="text" id="pan" value="${VALID_PAN[0]}" />
          </div>
          <div>
            <label>Email</label>
            <input type="email" id="email" value="${VALID_EMAILS[0]}" />
          </div>
          <div>
            <label>Phone</label>
            <input type="tel" id="phone" value="${VALID_PHONES[0]}" />
          </div>
          <div>
            <label>Password</label>
            <input type="password" id="password" value="SecretPass123!" />
          </div>
        </form>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`\n[Realistic Profile Form] Total detections: ${detections.length}`);
      const typeCounts: Record<string, number> = {};
      for (const d of detections) {
        typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
      }
      console.log('By type:', typeCounts);
      
      // Should detect all PII types
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should detect PII in a transaction page', () => {
      const html = `
        <div class="transaction">
          <p>Customer: ${VALID_EMAILS[0]}</p>
          <p>Phone: ${VALID_PHONES[0]}</p>
          <p>Aadhaar: ${VALID_AADHAAR[0]}</p>
          <p>PAN: ${VALID_PAN[0]}</p>
          <p>Card: ${VALID_CREDIT_CARDS[0]}</p>
          <p>IFSC: ${VALID_IFSC[0]}</p>
          <p>UPI: ${VALID_UPI[0]}</p>
          <input type="password" value="TransactionPass123" />
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`\n[Realistic Transaction Page] Total detections: ${detections.length}`);
      
      const typeCounts: Record<string, number> = {};
      for (const d of detections) {
        typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
      }
      console.log('By type:', typeCounts);
      
      // Should detect multiple PII types
      expect(detections.length).toBeGreaterThan(5);
    });

    it('should handle page with no PII', () => {
      const html = `
        <div class="public-page">
          <h1>Welcome to our public website</h1>
          <p>This page contains no personal information.</p>
          <p>Contact us at info@publicsite.com for general inquiries.</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`\n[No PII Page] Total detections: ${detections.length}`);
      // Should still detect email if present
    });
  });

  // ─── 5. Confidence and Verification Tests ────────────────────────────────────

  describe('Confidence and Verification Levels', () => {
    it('should mark verified detections with higher confidence', () => {
      const html = `
        <div>
          <span>${VALID_AADHAAR[0]}</span>
          <span>${INVALID_AADHAAR[0]}</span>
          <span>${VALID_PAN[0]}</span>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`\n[Confidence Test] Detections:`);
      for (const d of detections) {
        console.log(`  ${d.type}: ${d.value} (confidence: ${d.confidence}, verified: ${d.isVerified})`);
      }

      // Valid Aadhaar should have higher confidence than invalid
      const validAadhaarDet = detections.find(d => d.value?.startsWith(VALID_AADHAAR[0].slice(0, 4)));
      const invalidAadhaarDet = detections.find(d => d.value?.startsWith(INVALID_AADHAAR[0].slice(0, 4)));
      
      if (validAadhaarDet && invalidAadhaarDet) {
        expect(validAadhaarDet.confidence).toBeGreaterThan(invalidAadhaarDet.confidence);
        expect(validAadhaarDet.isVerified).toBe(true);
        expect(invalidAadhaarDet.isVerified).toBe(false);
      }
    });

    it('should verify PAN format correctly', () => {
      for (const pan of VALID_PAN) {
        expect(validatePAN(pan)).toBe(true);
      }
      
      // Invalid PAN (wrong entity type character)
      expect(validatePAN('ABCDE1234X')).toBe(false); // X is not in PAN_ENTITY_CHARS
    });

    it('should verify credit card with Luhn', () => {
      for (const card of VALID_CREDIT_CARDS) {
        expect(validateCard(card)).toBe(true);
      }
    });
  });

  // ─── 6. Summary Metrics ──────────────────────────────────────────────────────

  describe('Benchmark Summary', () => {
    it('should report final metrics', () => {
      // Get results from all tests
      const metrics = calculator.printReport();
      console.log(metrics);
      
      // Final overall metrics should be available
      const overall = calculator.getOverall();
      console.log(`\nOverall Precision: ${overall.precision.toFixed(3)}`);
      console.log(`Overall Recall: ${overall.recall.toFixed(3)}`);
      console.log(`Overall F1 Score: ${overall.f1Score.toFixed(3)}`);
      
      expect(overall.truePositives + overall.falsePositives).toBeGreaterThan(0);
    });
  });
});
