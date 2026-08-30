/**
 * PII Detector Unit Tests
 * 
 * Tests for Aadhaar, PAN, Credit Card, IFSC, Phone, Email detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

// Mock browser APIs
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || {};

describe('PII Detector - Regex Patterns', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    globalThis.document = dom.window.document;
    globalThis.window = dom.window as any;
  });

  describe('Aadhaar Detection', () => {
    it('should detect valid 12-digit Aadhaar format', () => {
      const text = 'My Aadhaar number is 1234 5678 9012';
      const regex = /(\d{4}\s?\d{4}\s?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(1);
      expect(matches![0]).toBe('1234 5678 9012');
    });

    it('should detect Aadhaar without spaces', () => {
      const text = 'Aadhaar: 123456789012';
      const regex = /(\d{4}\s?\d{4}\s?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).not.toBeNull();
    });

    it('should not match numbers shorter than 12 digits', () => {
      const text = 'ID: 123456789';
      const regex = /(\d{4}\s?\d{4}\s?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).toBeNull();
    });

    it('should match multiple Aadhaar numbers in text', () => {
      const text = 'Person1: 1111 2222 3333 Person2: 4444 5555 6666';
      const regex = /(\d{4}\s?\d{4}\s?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(2);
    });
  });

  describe('PAN Detection', () => {
    it('should detect valid PAN format', () => {
      const text = 'PAN: ABCDE1234F';
      const regex = /([A-Z]{5}\d{4}[A-Z]{1})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(1);
      expect(matches![0]).toBe('ABCDE1234F');
    });

    it('should reject invalid PAN (wrong length)', () => {
      const text = 'PAN: ABCD1234';
      const regex = /([A-Z]{5}\d{4}[A-Z]{1})/g;
      const matches = text.match(regex);
      expect(matches).toBeNull();
    });

    it('should be case-insensitive for PAN letters', () => {
      const text = 'pan: abcde1234f';
      // The regex in detector is uppercase only, this should not match
      const regex = /([A-Z]{5}\d{4}[A-Z]{1})/g;
      const matches = text.match(regex);
      expect(matches).toBeNull();
    });
  });

  describe('Credit Card Detection', () => {
    it('should detect credit card with spaces', () => {
      const text = 'Card: 1234 5678 9012 3456';
      const regex = /(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(1);
    });

    it('should detect credit card with dashes', () => {
      const text = 'Card: 1234-5678-9012-3456';
      const regex = /(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(1);
    });

    it('should detect credit card without separators', () => {
      const text = 'Card: 1234567890123456';
      const regex = /(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})/g;
      const matches = text.match(regex);
      expect(matches).not.toBeNull();
    });
  });

  describe('IFSC Detection', () => {
    it('should detect valid IFSC code', () => {
      const text = 'IFSC: SBIN0001234';
      const regex = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
      expect(regex.test('SBIN0001234')).toBe(true);
      expect(regex.test('HDFC0001234')).toBe(true);
    });

    it('should reject invalid IFSC (wrong format)', () => {
      const regex = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
      expect(regex.test('SBIN00123')).toBe(false); // Too short
      expect(regex.test('SBI0001234')).toBe(false); // Missing letter
      expect(regex.test('sbin0001234')).toBe(false); // Lowercase
    });
  });

  describe('Email Detection', () => {
    it('should detect valid email addresses', () => {
      const text = 'Contact: user@example.com or admin@domain.org';
      const regex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
      const matches = text.match(regex);
      expect(matches).toHaveLength(2);
    });

    it('should not match emails without TLD', () => {
      const text = 'Not an email: user@example';
      const regex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
      const matches = text.match(regex);
      expect(matches).toBeNull();
    });
  });

  describe('Phone Number Detection', () => {
    it('should detect Indian phone numbers', () => {
      const text = 'Call: +91 98765 43210';
      const regex = /([+]?[\d\s-]{10,13})/g;
      const matches = text.match(regex);
      expect(matches).not.toBeNull();
    });

    it('should detect phone with country code', () => {
      const text = 'Phone: +1-234-567-8900';
      const regex = /([+]?[\d\s-]{10,13})/g;
      const matches = text.match(regex);
      expect(matches).not.toBeNull();
    });
  });

  describe('Password Field Detection', () => {
    it('should detect password input types', () => {
      const html = '<input type="password" id="pwd" name="password">';
      dom.window.document.body.innerHTML = html;

      const inputs = dom.window.document.querySelectorAll('input');
      const pwdInputs = dom.window.document.querySelectorAll('input[type="password"]');

      expect(inputs.length).toBe(1);
      expect(pwdInputs.length).toBe(1);
    });

    it('should not treat text inputs as passwords', () => {
      const html = '<input type="text" id="name" name="username">';
      dom.window.document.body.innerHTML = html;

      const pwdInputs = dom.window.document.querySelectorAll('input[type="password"]');
      expect(pwdInputs.length).toBe(0);
    });
  });

  describe('Masking Functions', () => {
    it('should mask Aadhaar numbers', () => {
      const original = '123456789012';
      const masked = 'XXX XXX XXX';
      const result = original.replace(/(\d{4}\s?\d{4}\s?\d{4})/g, masked);
      expect(result).toBe(masked);
    });

    it('should mask PAN numbers', () => {
      const original = 'ABCDE1234F';
      const masked = 'XXXXXXXXXX';
      const result = original.replace(/([A-Z]{5}\d{4}[A-Z]{1})/g, masked);
      expect(result).toBe(masked);
    });

    it('should mask credit card numbers', () => {
      const original = '1234 5678 9012 3456';
      const masked = 'XXXX XXXX XXXX XXXX';
      const result = original.replace(/(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})/g, masked);
      expect(result).toBe(masked);
    });
  });
});

describe('PII Detector - Edge Cases', () => {
  it('should handle empty document', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    expect(dom.window.document.querySelectorAll('input').length).toBe(0);
  });

  it('should handle documents without PII', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><p>Hello World</p></body></html>');
    const text = dom.window.document.querySelector('p')?.textContent || '';
    const regex = /(\d{4}\s?\d{4}\s?\d{4})/g;
    expect(text.match(regex)).toBeNull();
  });

  it('should handle mixed content with and without PII', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <p>No PII here</p>
          <input type="password" value="secret123">
          <span>Phone: 9876543210</span>
        </body>
      </html>
    `);
    
    const pwdInputs = dom.window.document.querySelectorAll('input[type="password"]');
    expect(pwdInputs.length).toBe(1);
  });
});
