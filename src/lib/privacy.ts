/**
 * Privacy Utilities & Outbound Payload Scanner
 *
 * PII detection, redaction helpers, and client-side outbound payload scanner.
 */

import type { PrivacyEvent, PIIType } from '../types';
import { validateAadhaar, validatePAN as validatePANShared } from './pii/validators';

export interface PIIDetection {
  type: string;
  value: string;
  confidence: number;
}

// Pattern definitions for PII detection
const PATTERNS: Record<string, { regex: RegExp; confidence: number }> = {
  AADHAAR: {
    regex: /\b(\d{4}\s?\d{4}\s?\d{4})\b/g,
    confidence: 0.7,
  },
  PAN: {
    regex: /\b([A-Z]{5}\d{4}[A-Z]{1})\b/g,
    confidence: 0.85,
  },
  CREDIT_CARD: {
    regex: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
    confidence: 0.7,
  },
  IFSC: {
    regex: /\b([A-Z]{4}0[A-Z0-9]{6})\b/g, // 11 chars, not 12 (#163, #168)
    confidence: 0.85,
  },
  PHONE: {
    regex: /\b([+]?[\d\s-]{10,13})\b/g,
    confidence: 0.6,
  },
  EMAIL: {
    regex: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    confidence: 0.95,
  },
  PASSWORD_FIELD: {
    regex: /type=["']password["']/g,
    confidence: 0.99,
  },
};

/**
 * Outbound Payload Scanner
 *
 * Scans the exact serialized JSON payload right before sending to /plan.
 * Blocks network transmission if raw passwords or verified sensitive PII are present.
 * Never logs raw sensitive values.
 */
export function scanOutboundPayload(payload: any): {
  safe: boolean;
  error?: string;
  violations: string[];
} {
  const violations: string[] = [];
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // 1. Check for unredacted passwords
  if (/"value"\s*:\s*"[^"]*(?:password|passwd|secret|pin)[^"]*"/i.test(serialized)) {
    violations.push('UNREDACTED_PASSWORD_VALUE_DETECTED');
  }

  // 2. Check for raw 12-digit Aadhaar numbers in elements or text
  const aadhaarMatches = serialized.match(/\b\d{12}\b/g);
  if (aadhaarMatches) {
    for (const match of aadhaarMatches) {
      if (verhoeffCheck(match)) {
        violations.push('RAW_VERIFIED_AADHAAR_DETECTED');
        break;
      }
    }
  }

  // 3. Check for raw PAN numbers
  const panMatches = serialized.match(/\b[A-Z]{5}\d{4}[A-Z]{1}\b/g);
  if (panMatches) {
    for (const match of panMatches) {
      if (validatePAN(match)) {
        violations.push('RAW_VERIFIED_PAN_DETECTED');
        break;
      }
    }
  }

  // 4. Check for raw Credit Card numbers
  const cardMatches = serialized.match(/\b\d{16}\b/g);
  if (cardMatches) {
    for (const match of cardMatches) {
      if (luhnCheck(match)) {
        violations.push('RAW_VERIFIED_CREDIT_CARD_DETECTED');
        break;
      }
    }
  }

  if (violations.length > 0) {
    return {
      safe: false,
      error: `Outbound security scanner blocked payload transmission due to security violations: ${violations.join(', ')}`,
      violations,
    };
  }

  return { safe: true, violations: [] };
}

/**
 * Detect PII in text
 */
export function detectPII(text: string): PIIDetection[] {
  const detections: PIIDetection[] = [];

  for (const [type, { regex, confidence }] of Object.entries(PATTERNS)) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      detections.push({
        type,
        value: maskValue(match[1], type),
        confidence,
      });
    }
  }

  return detections;
}

/**
 * Redact PII from text
 */
export function redactPII(text: string): { redacted: string; events: PIIDetection[] } {
  let redacted = text;
  const events: PIIDetection[] = [];

  for (const [type, { regex, confidence }] of Object.entries(PATTERNS)) {
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) {
      for (const match of matches) {
        const masked = maskValue(match, type);
        redacted = redacted.replace(match, masked);
        events.push({ type, value: masked, confidence });
      }
    }
  }

  return { redacted, events };
}

/**
 * Mask sensitive values for display
 */
function maskValue(value: string, type: string): string {
  switch (type) {
    case 'AADHAAR':
      return value.replace(/(\d{4})\s?\d{4}\s?\d{4}/, '$1 XXX XXX');
    case 'PAN':
      return value.replace(/([A-Z]{5})(\d{4})([A-Z]{1})/, '$1*****$3');
    case 'CREDIT_CARD': {
      const digits = value.replace(/[\s-]/g, '');
      return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
    }
    case 'IFSC':
      // 11 characters, not 12: 4 letters + '0' + 6 alphanumerics. The old
      // {7} meant this mask never matched a real IFSC, so IFSC values were
      // left in place by the redactor (#163, #168).
      return value.replace(/([A-Z]{4}0[A-Z0-9]{6})/, '$1********');
    case 'PHONE':
      return value.replace(/(\+\d{2}|\d{2}) (\d{5}) (\d{5})/, '$1 $2 *****');
    case 'EMAIL': {
      const [local, domain] = value.split('@');
      return `${local.slice(0, 2)}***@${domain}`;
    }
    default:
      return '•'.repeat(Math.min(value.length, 8));
  }
}

/**
 * Check if element is a sensitive password field
 */
export function isPasswordField(element: Element): boolean {
  const type = element.getAttribute('type')?.toLowerCase();
  const name = (element.getAttribute('name') || '').toLowerCase();
  const id = (element.getAttribute('id') || '').toLowerCase();
  const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
  const placeholder = (element.getAttribute('placeholder') || '').toLowerCase();

  const SENSITIVE_PATTERN = /password|passwd|pwd|pin|secret/i;

  return (
    type === 'password' ||
    type === 'hidden' ||
    SENSITIVE_PATTERN.test(name) ||
    SENSITIVE_PATTERN.test(id) ||
    SENSITIVE_PATTERN.test(ariaLabel) ||
    SENSITIVE_PATTERN.test(placeholder)
  );
}

/**
 * Generate privacy event from detection
 */
export function createPrivacyEvent(
  type: PIIType,
  value: string,
  confidence: number,
  selector?: string
): PrivacyEvent {
  return {
    id: Math.random().toString(36).substring(2, 9),
    timestamp: new Date(),
    type: 'detected',
    category: type,
    detail: `${type}: ${maskValue(value, type)}`,
    confidence,
    selector: selector || '',
  };
}

// Internal validators for scanner
// Aadhaar check digit. The Verhoeff implementation lives in
// src/lib/pii/validators.ts - it used to be duplicated here with a wrong `p`
// table, which rejected ~90% of real Aadhaar numbers (#162, #175).
function verhoeffCheck(digits: string): boolean {
  return validateAadhaar(digits);
}

// Delegates to the single validator. The copy that used to live here checked
// index 2 (the third letter) instead of index 3 (the entity-type character),
// so it both rejected valid PANs and accepted invalid entity types.
function validatePAN(pan: string): boolean {
  return validatePANShared(pan);
}

function luhnCheck(number: string): boolean {
  if (number.length < 13 || number.length > 19) return false;
  let sum = 0;
  let isEven = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}
