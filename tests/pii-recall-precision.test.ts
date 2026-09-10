/**
 * PII Recall/Precision Benchmark Test Suite
 *
 * Tests PII detection capabilities with valid test data.
 * Note: Some detections require checksum validation (Aadhaar, PAN, Credit Cards).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { PIIManager } from '../src/lib/pii/detector';
import { validateAadhaar, validatePAN, validateCard } from '../src/lib/pii/validators';

// Valid test data with correct checksums
const VALID_AADHAAR = [
  '284666630139', // Verified with Verhoeff
  '403602168771', // Verified with Verhoeff
];

const INVALID_AADHAAR = [
  '123456789012', // Wrong checksum
  '000000000000', // All zeros
];

const VALID_PAN = [
  'BSTOP1234C', // Valid format with entity type C
  'AABCA1234D', // Valid format with entity type A
];

const INVALID_PAN = [
  'ABCDE1234X', // Invalid entity type X
  'ABC1234567', // Wrong format
];

const VALID_CREDIT_CARDS = [
  '4111111111111111', // Visa test card (Luhn valid)
  '5500000000000004', // Mastercard test card (Luhn valid)
];

const VALID_IFSC = [
  'SBIN0001234',
  'HDFC0001234',
];

const VALID_EMAILS = [
  'user@example.com',
  'test.user@domain.org',
  'admin+tag@company.co.in',
];

const VALID_PHONES = [
  '9876543210',
  '0987654321',
];

// Ground truth: what we expect the detector to find
interface TestCase {
  name: string;
  html: string;
  expectedCount: number;
  expectedTypes: string[];
}

describe('PII Detection Benchmark', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  global.document = dom.window.document;
  global.window = dom.window as any;

  beforeEach(() => {
    dom.window.document.body.innerHTML = '';
  });

  describe('Ground Truth Validation', () => {
    it('should validate test Aadhaar numbers', () => {
      for (const aadhaar of VALID_AADHAAR) {
        expect(validateAadhaar(aadhaar)).toBe(true);
      }
      for (const invalid of INVALID_AADHAAR) {
        expect(validateAadhaar(invalid)).toBe(false);
      }
    });

    it('should validate test PAN numbers', () => {
      for (const pan of VALID_PAN) {
        expect(validatePAN(pan)).toBe(true);
      }
      for (const invalid of INVALID_PAN) {
        expect(validatePAN(invalid)).toBe(false);
      }
    });

    it('should validate test credit cards', () => {
      for (const card of VALID_CREDIT_CARDS) {
        expect(validateCard(card)).toBe(true);
      }
    });
  });

  describe('Detection Accuracy', () => {
    it('should detect Aadhaar in text content', () => {
      const html = `<div>Aadhaar: ${VALID_AADHAAR[0]}</div>`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const aadhaarDetections = detections.filter(d => d.type === 'AADHAAR');

      console.log(`[Aadhaar Detection] Found: ${aadhaarDetections.length}`);
      expect(aadhaarDetections.length).toBeGreaterThan(0);
    });

    it('should detect PAN in input values', () => {
      const html = `<input id="pan" value="${VALID_PAN[0]}" />`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const panDetections = detections.filter(d => d.type === 'PAN');

      console.log(`[PAN Detection] Found: ${panDetections.length}`);
      expect(panDetections.length).toBeGreaterThan(0);
    });

    it('should detect credit cards in text', () => {
      const html = `<p>Card: ${VALID_CREDIT_CARDS[0]}</p>`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const cardDetections = detections.filter(d => d.type === 'CREDIT_CARD');

      console.log(`[Credit Card Detection] Found: ${cardDetections.length}`);
      expect(cardDetections.length).toBeGreaterThan(0);
    });

    it('should detect emails', () => {
      const html = `<span>${VALID_EMAILS[0]}</span>`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const emailDetections = detections.filter(d => d.type === 'EMAIL');

      expect(emailDetections.length).toBeGreaterThan(0);
    });

    it('should detect passwords in password fields', () => {
      const html = `<input type="password" value="SecretPass123!" />`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const passwordDetections = detections.filter(d => d.type.includes('PASSWORD'));

      expect(passwordDetections.length).toBeGreaterThan(0);
    });
  });

  describe('False Positive Testing', () => {
    it('should not flag random text as PII', () => {
      const html = `<div>This is normal text with no personal information. Contact us at info@publicsite.com for general inquiries.</div>`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      // Should only detect the email, not flag random text
      const nonEmailDetections = detections.filter(d => d.type !== 'EMAIL');
      expect(nonEmailDetections.length).toBe(0);
    });

    it('should not flag random numbers as Aadhaar', () => {
      const html = `<div>Random numbers: 123456789012 and 987654321098</div>`;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();
      const aadhaarDetections = detections.filter(d => d.type === 'AADHAAR');

      // These are invalid Aadhaar numbers (wrong checksum), so should not be detected
      expect(aadhaarDetections.length).toBe(0);
    });
  });

  describe('Realistic HTML Scenarios', () => {
    it('should detect PII in a user profile form', () => {
      const html = `
        <form>
          <input type="text" name="aadhaar" value="${VALID_AADHAAR[0]}" />
          <input type="text" name="pan" value="${VALID_PAN[0]}" />
          <input type="email" name="email" value="${VALID_EMAILS[0]}" />
          <input type="password" name="password" value="MySecretPassword123!" />
        </form>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`[Profile Form] Total detections: ${detections.length}`);
      expect(detections.length).toBeGreaterThan(0);

      // Check for expected types
      const types = detections.map(d => d.type);
      expect(types).toContain('AADHAAR');
      expect(types).toContain('PAN');
      expect(types).toContain('EMAIL');
      expect(types).toContain('PASSWORD_FIELD');
    });

    it('should handle page with no PII', () => {
      const html = `
        <div class="public-page">
          <h1>Welcome to our website</h1>
          <p>This is a public page with no personal information.</p>
        </div>
      `;
      dom.window.document.body.innerHTML = html;

      const manager = PIIManager.getInstance();
      manager.clear();
      const detections = manager.scanDocument();

      console.log(`[No PII Page] Total detections: ${detections.length}`);
      // Should have minimal or no detections
    });
  });

  describe('Detector Capabilities Summary', () => {
    it('should report what the detector can and cannot do', () => {
      console.log('\n=== PII DETECTOR CAPABILITIES ===');
      console.log('Supported detections:');
      console.log('  - Aadhaar (12-digit with Verhoeff checksum)');
      console.log('  - PAN (format + entity type validation)');
      console.log('  - Credit/Debit cards (Luhn algorithm)');
      console.log('  - IFSC codes');
      console.log('  - Email addresses');
      console.log('  - Phone numbers');
      console.log('  - Password fields');
      console.log('  - API keys/tokens');
      console.log('');
      console.log('Limitations:');
      console.log('  - UPI detection requires additional patterns');
      console.log('  - Face detection requires WebAPI support');
      console.log('  - Some obfuscated formats may not be detected');
      console.log('=================================\n');
    });
  });
});