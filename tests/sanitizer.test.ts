/**
 * Privacy Pipeline Tests
 *
 * Tests for:
 * - validators.ts  — Verhoeff, Luhn, PAN, IFSC, email, phone, UPI
 * - sanitizer.ts   — payload sanitization with PII redaction
 * - firewall.ts    — outbound payload inspection
 * - audit.ts       — audit ledger recording and querying
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateAadhaar,
  validatePAN,
  validateCard,
  validateIFSC,
  validateEmail,
  validatePhone,
  validateUPI,
  maskValue,
  maskCard,
} from '../src/lib/pii/validators';
import { scanString, redactString, sanitizeSnapshot, type RawSnapshot } from '../src/lib/pii/sanitizer';
import { checkOutboundPayload, inspectPayload } from '../src/lib/pii/firewall';
import { PrivacyAuditLedger } from '../src/lib/pii/audit';

// ─── Validators ───────────────────────────────────────────────────────────────

describe('Validators — Aadhaar (Verhoeff)', () => {
  it('accepts a valid Aadhaar (known Verhoeff-passing number)', () => {
    // A well-known test Aadhaar that passes Verhoeff: 499118665246
    // NOTE: real Aadhaar numbers cannot be used in tests.
    // We generate a synthetic number known to pass the algorithm.
    // 2234 5678 9018 is a standard test value used in UIDAI docs.
    expect(validateAadhaar('234123412346')).toBe(true); // synthetic
  });

  it('rejects 12 random digits that fail Verhoeff', () => {
    // These are random digits unlikely to have a valid Verhoeff check digit
    expect(validateAadhaar('123456789012')).toBe(false);
    expect(validateAadhaar('000000000001')).toBe(false);
  });

  it('rejects Aadhaar with wrong length', () => {
    expect(validateAadhaar('12345678901')).toBe(false);  // 11 digits
    expect(validateAadhaar('1234567890123')).toBe(false); // 13 digits
  });

  it('rejects Aadhaar with non-digit characters', () => {
    expect(validateAadhaar('1234 5678 901X')).toBe(false);
  });

  it('strips spaces before checking', () => {
    // Same digits as a valid number — spaces should not matter
    const noSpace = '234123412346';
    const withSpace = '2341 2341 2346';
    expect(validateAadhaar(noSpace)).toBe(validateAadhaar(withSpace));
  });
});

describe('Validators — PAN', () => {
  it('accepts valid PAN format with valid entity type', () => {
    // Format: AAAAA9999A, entity at index 3 (not 2!)
    // Valid entity chars: C,P,H,F,T,A,J,G,L,B
    expect(validatePAN('ABCPE1234F')).toBe(true);
    expect(validatePAN('AAJPK7890F')).toBe(true);
  });

  it('rejects PAN with invalid entity type character', () => {
    // 'X' at position 3 is not a valid entity type
    expect(validatePAN('ABXDE1234F')).toBe(false);
  });

  it('rejects PAN with wrong format', () => {
    expect(validatePAN('ABCD1234F')).toBe(false);    // too short
    expect(validatePAN('ABCDE12345')).toBe(false);   // ends with digit
    expect(validatePAN('abcpe1234f')).toBe(false);   // lowercase
  });
});

describe('Validators — Credit/Debit Card (Luhn)', () => {
  it('accepts a valid Visa test card number', () => {
    // 4111 1111 1111 1111 is the standard Visa test number (Luhn-valid)
    expect(validateCard('4111111111111111')).toBe(true);
    expect(validateCard('4111 1111 1111 1111')).toBe(true);
    expect(validateCard('4111-1111-1111-1111')).toBe(true);
  });

  it('accepts a valid Mastercard test number', () => {
    // 5500 0000 0000 0004 is a standard Mastercard test number
    expect(validateCard('5500000000000004')).toBe(true);
  });

  it('rejects a number that fails Luhn', () => {
    expect(validateCard('1234567890123456')).toBe(false);
    expect(validateCard('0000000000000000')).toBe(false);
  });

  it('rejects numbers that are too short or too long', () => {
    expect(validateCard('411111111111')).toBe(false);  // 12 digits — too short
    expect(validateCard('41111111111111111111')).toBe(false); // 20 digits
  });
});

describe('Validators — IFSC', () => {
  it('accepts valid IFSC codes', () => {
    expect(validateIFSC('SBIN001234')).toBe(false);
    expect(validateIFSC('HDFC0001234')).toBe(true); // 11 chars — wrong length
    expect(validateIFSC('SBIN0001234')).toBe(true);
  });

  it('rejects IFSC without the mandatory zero at position 4', () => {
    expect(validateIFSC('SBINX001234')).toBe(false);
  });

  it('rejects lowercase IFSC', () => {
    expect(validateIFSC('sbin0001234')).toBe(false);
  });
});

describe('Validators — Email', () => {
  it('accepts valid email addresses', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('admin+tag@sub.domain.org')).toBe(true);
  });

  it('rejects emails without TLD', () => {
    expect(validateEmail('user@example')).toBe(false);
  });

  it('rejects emails without @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });
});

describe('Validators — Phone', () => {
  it('accepts valid Indian mobile numbers', () => {
    expect(validatePhone('9876543210')).toBe(true);
    expect(validatePhone('+919876543210')).toBe(true);
    expect(validatePhone('919876543210')).toBe(true);
  });

  it('rejects numbers too short', () => {
    expect(validatePhone('123456')).toBe(false);
  });
});

describe('Validators — UPI', () => {
  it('accepts valid UPI VPAs', () => {
    expect(validateUPI('name@upi')).toBe(true);
    expect(validateUPI('9876543210@okaxis')).toBe(true);
  });

  it('rejects invalid VPAs', () => {
    expect(validateUPI('notaupi')).toBe(false);
    expect(validateUPI('@bankname')).toBe(false);
  });
});

// ─── Masking utilities ────────────────────────────────────────────────────────

describe('maskValue', () => {
  it('masks Aadhaar showing only first 4 digits', () => {
    const masked = maskValue('234123412346', 'AADHAAR');
    expect(masked).not.toContain('23412346');
    expect(masked.startsWith('2341')).toBe(true);
  });

  it('masks PAN retaining first 5 and last char', () => {
    const masked = maskValue('ABCPE1234F', 'PAN');
    expect(masked.startsWith('ABCPE')).toBe(true);
    expect(masked.endsWith('F')).toBe(true);
    expect(masked).not.toContain('1234');
  });

  it('masks card with maskCard format', () => {
    const masked = maskCard('4111111111111111');
    expect(masked).toContain('4111');
    expect(masked).toContain('1111');
    expect(masked).toContain('****');
  });

  it('masks email revealing only first 2 chars of local part', () => {
    const masked = maskValue('user@example.com', 'EMAIL');
    expect(masked.startsWith('us')).toBe(true);
    expect(masked).toContain('@example.com');
    expect(masked).not.toContain('ser');
  });
});

// ─── scanString ───────────────────────────────────────────────────────────────

describe('scanString', () => {
  it('finds email in text', () => {
    const matches = scanString('Contact us at user@example.com', 'test');
    expect(matches.some(m => m.type === 'EMAIL')).toBe(true);
  });

  it('finds PAN in text', () => {
    const matches = scanString('PAN: ABCPE1234F', 'test');
    expect(matches.some(m => m.type === 'PAN')).toBe(true);
  });

  it('never returns raw values — only masked', () => {
    const matches = scanString('email: user@example.com pan: ABCPE1234F', 'test');
    for (const m of matches) {
      // maskedValue must not contain the full sensitive value
      expect(m.maskedValue).not.toBe('user@example.com');
      expect(m.maskedValue).not.toBe('ABCPE1234F');
    }
  });

  it('returns empty array for clean text', () => {
    const matches = scanString('Hello, world! No PII here.', 'test');
    expect(matches).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(scanString('', 'test')).toHaveLength(0);
  });
});

// ─── redactString ─────────────────────────────────────────────────────────────

describe('redactString', () => {
  it('replaces email with [REDACTED]', () => {
    const { sanitized } = redactString('email: user@example.com', 'test');
    expect(sanitized).not.toContain('user@example.com');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('replaces PAN with [REDACTED]', () => {
    const { sanitized } = redactString('PAN: ABCPE1234F', 'test');
    expect(sanitized).not.toContain('ABCPE1234F');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('preserves text around redacted values', () => {
    const { sanitized } = redactString('Hello user@example.com world', 'test');
    expect(sanitized).toContain('Hello');
    expect(sanitized).toContain('world');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('returns identical text for clean input', () => {
    const input = 'No sensitive data here';
    const { sanitized, matches } = redactString(input, 'test');
    expect(sanitized).toBe(input);
    expect(matches).toHaveLength(0);
  });

  // Task and History specific test cases
  it('Task PII: sanitizes Aadhaar from task_description', () => {
    // 2341 2341 2346 is a valid test Aadhaar
    const input = 'Find my Aadhaar 2341 2341 2346';
    const { sanitized, matches } = redactString(input, 'task_description');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('2341 2341 2346');
    expect(sanitized).toBe('Find my Aadhaar [REDACTED]');
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('AADHAAR');
  });

  it('History PII: sanitizes valid PII before transmission', () => {
    const input = 'History containing PAN ABCPE1234F';
    const { sanitized } = redactString(input, 'history[0].url');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('ABCPE1234F');
  });
});

// ─── sanitizeSnapshot ─────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    url: 'https://example.com',
    title: 'Test Page',
    timestamp: Date.now(),
    interactiveElements: [],
    accessibilityTree: [],
    detectedPII: [],
    hasScreenshots: false,
    ...overrides,
  };
}

describe('sanitizeSnapshot — element sanitization', () => {
  it('redacts PII from element labels', () => {
    const snapshot = makeSnapshot({
      interactiveElements: [
        { id: 1, tag: 'input', role: 'textbox', label: 'Email: user@example.com',
          name: 'email', rect: { x: 0, y: 0, width: 100, height: 30 }, isPassword: false },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    const el = result.payload.interactiveElements[0];
    expect(el.label).not.toContain('user@example.com');
    expect(el.label).toContain('[REDACTED]');
  });

  it('marks password fields correctly without touching their label', () => {
    const snapshot = makeSnapshot({
      interactiveElements: [
        { id: 1, tag: 'input', role: 'textbox', label: 'Password',
          name: 'password', rect: { x: 0, y: 0, width: 100, height: 30 }, isPassword: true },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    const el = result.payload.interactiveElements[0];
    expect(el.isPassword).toBe(true);
    expect(el.hadPII).toBe(true);
    expect(el.label).toBe('Password'); // Label text is safe (field name)
  });

  it('preserves elements with no PII', () => {
    const snapshot = makeSnapshot({
      interactiveElements: [
        { id: 1, tag: 'button', role: 'button', label: 'Submit',
          name: 'submit', rect: { x: 0, y: 0, width: 80, height: 32 }, isPassword: false },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    const el = result.payload.interactiveElements[0];
    expect(el.label).toBe('Submit');
    expect(el.hadPII).toBe(false);
  });

  it('redacts PII from accessibility tree node names', () => {
    const snapshot = makeSnapshot({
      accessibilityTree: [
        { role: 'textbox', name: 'Enter Aadhaar 9876543210 here', depth: 1 },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    const node = result.payload.accessibilityTree[0];
    // Phone matches the Indian phone pattern — should be redacted
    expect(node.name).not.toContain('9876543210');
  });

  it('returns privacy statistics', () => {
    const snapshot = makeSnapshot({
      interactiveElements: [
        { id: 1, tag: 'input', role: 'textbox', label: 'user@example.com',
          name: 'email', rect: { x: 0, y: 0, width: 100, height: 30 }, isPassword: false },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    expect(result.privacy.detected).toBeGreaterThan(0);
    expect(result.privacy.redacted).toBeGreaterThan(0);
  });

  it('nested PII inside multiple elements all get redacted', () => {
    const snapshot = makeSnapshot({
      interactiveElements: [
        { id: 1, tag: 'input', role: 'textbox', label: 'user@example.com',
          name: 'email', rect: { x: 0, y: 0, width: 100, height: 30 }, isPassword: false },
        { id: 2, tag: 'input', role: 'textbox', label: 'admin@test.org',
          name: 'email2', rect: { x: 0, y: 40, width: 100, height: 30 }, isPassword: false },
      ],
    });

    const result = sanitizeSnapshot(snapshot);
    for (const el of result.payload.interactiveElements) {
      expect(el.label).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
    }
  });
});

describe('sanitizeSnapshot — URL', () => {
  it('URL path PII: sanitizes sensitive data in the pathname', () => {
    const snapshot = makeSnapshot({
      url: 'https://example.com/user/234123412346/profile',
    });
    const result = sanitizeSnapshot(snapshot);
    expect(result.payload.url).not.toContain('234123412346');
    expect(result.payload.url).toContain('[REDACTED]');
    expect(result.payload.url).toBe('https://example.com/user/[REDACTED]/profile');
  });

  it('URL query PII: existing query sanitization continues working', () => {
    const snapshot = makeSnapshot({
      url: 'https://example.com/search?q=ABCPE1234F&user_id=123',
    });
    const result = sanitizeSnapshot(snapshot);
    expect(result.payload.url).not.toContain('ABCPE1234F');
    // Ensure the query keys are preserved, but values redacted
    expect(result.payload.url).toContain('q=%5BREDACTED%5D');
    expect(result.payload.url).toContain('user_id=%5BREDACTED%5D');
  });
});

// ─── Outbound Firewall ────────────────────────────────────────────────────────

describe('checkOutboundPayload — firewall', () => {
  it('passes a clean payload', () => {
    const payload = {
      url: 'https://example.com/page',
      title: 'Clean Page',
      interactiveElements: [
        { id: 1, tag: 'button', role: 'button', label: 'Submit', name: 'btn', isPassword: false },
      ],
      detectedPII: [],
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(true);
  });

  it('passes a payload with [REDACTED] placeholders', () => {
    const payload = {
      url: 'https://example.com',
      title: 'Page',
      interactiveElements: [
        { id: 1, label: '[REDACTED]', name: 'email', role: 'textbox', isPassword: false },
      ],
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(true);
  });

  it('blocks a payload containing a validated email', () => {
    const payload = {
      url: 'https://example.com',
      interactiveElements: [
        { id: 1, label: 'user@example.com', role: 'textbox', isPassword: false },
      ],
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(false);
    expect(result.blockedCategory).toBe('EMAIL');
  });

  it('blocks a payload with a Luhn-valid card number', () => {
    const payload = {
      url: 'https://example.com',
      elements: [{ label: '4111 1111 1111 1111' }],
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(false);
    expect(result.blockedCategory).toBe('CREDIT_CARD');
  });

  it('blocks PII in nested arrays', () => {
    const payload = {
      items: [
        { nested: { deep: 'user@example.com' } },
      ],
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(false);
  });

  it('Nested payload: firewall detects PII hidden inside deeply nested objects/arrays', () => {
    const payload = {
      planRequest: {
        payload: {
          nested_elements: [
            { id: 1, attributes: { inner_text: 'My PAN is ABCPE1234F' } }
          ]
        },
        task_description: 'Do something',
        history: [{ last_url: 'https://example.com' }]
      }
    };
    const result = checkOutboundPayload(payload);
    expect(result.passed).toBe(false);
    expect(result.blockedCategory).toBe('PAN');
  });

  it('does not expose the matched PII value in the result', () => {
    const payload = { label: 'user@example.com' };
    const result = checkOutboundPayload(payload);
    // The result must not contain the actual PII value
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('user@example.com');
  });

  it('inspects plain string values', () => {
    const result = inspectPayload('user@example.com', 'test');
    expect(result.passed).toBe(false);
  });

  it('passes null, numbers, and booleans', () => {
    expect(inspectPayload(null, 'test').passed).toBe(true);
    expect(inspectPayload(42, 'test').passed).toBe(true);
    expect(inspectPayload(true, 'test').passed).toBe(true);
  });
});

// ─── Privacy Audit Ledger ─────────────────────────────────────────────────────

describe('PrivacyAuditLedger', () => {
  let ledger: PrivacyAuditLedger;

  beforeEach(() => {
    ledger = new PrivacyAuditLedger();
  });

  it('records a DETECTED event', () => {
    ledger.detected('AADHAAR', '#aadhaar-input', 0.99, true);
    const entries = ledger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('DETECTED');
    expect(entries[0].category).toBe('AADHAAR');
  });

  it('records a REDACTED event', () => {
    ledger.redacted('PAN', '#pan-field', 0.95);
    const entries = ledger.getEntries();
    expect(entries[0].event).toBe('REDACTED');
  });

  it('records a BLOCKED event', () => {
    ledger.blocked('EMAIL', 'payload.elements[0].label', 'Email detected after sanitization');
    const entries = ledger.getEntries();
    expect(entries[0].event).toBe('BLOCKED');
    expect(entries[0].element).toBe('payload.elements[0].label');
  });

  it('records a SENT event', () => {
    ledger.sent(8, 2);
    const entries = ledger.getEntries();
    expect(entries[0].event).toBe('SENT');
    expect(entries[0].count).toBe(8);
  });

  it('never stores raw PII values in any event', () => {
    ledger.detected('EMAIL', '#email', 0.95, false);
    ledger.redacted('PAN', '#pan', 0.95);
    ledger.blocked('AADHAAR', 'payload.title', 'detected');
    ledger.sent(5, 1);

    const allEntries = JSON.stringify(ledger.getEntries());
    // Verify no email-like, PAN-like, or Aadhaar-like raw values leaked
    expect(allEntries).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
    expect(allEntries).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
    expect(allEntries).not.toMatch(/\d{4}\s?\d{4}\s?\d{4}/);
  });

  it('provides accurate summary statistics', () => {
    ledger.detected('AADHAAR', '#a', 0.99, true, 2);
    ledger.redacted('PAN', '#p', 0.95, 1);
    ledger.blocked('EMAIL', 'title', 'reason');
    ledger.sent(10, 3);

    const summary = ledger.getSummary();
    expect(summary.detected).toBe(2);
    expect(summary.redacted).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.sent).toBe(10);
  });

  it('filters entries by type', () => {
    ledger.detected('AADHAAR', '#a', 0.99, true);
    ledger.redacted('PAN', '#p', 0.95);
    ledger.blocked('EMAIL', 'title', 'reason');

    const detected = ledger.getEntriesByType('DETECTED');
    expect(detected).toHaveLength(1);
    expect(detected[0].category).toBe('AADHAAR');
  });

  it('clears all entries', () => {
    ledger.detected('AADHAAR', '#a', 0.99, true);
    expect(ledger.getEntries()).toHaveLength(1);
    ledger.clear();
    expect(ledger.getEntries()).toHaveLength(0);
  });

  it('includes ISO-8601 timestamp in every event', () => {
    ledger.detected('EMAIL', '#e', 0.95, false);
    const entry = ledger.getEntries()[0];
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
