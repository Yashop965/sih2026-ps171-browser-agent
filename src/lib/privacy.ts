/**
 * Privacy Utilities
 * 
 * PII detection and redaction functions used by React hooks
 */

import type { PrivacyEvent } from '../types';

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
    regex: /\b([A-Z]{4}0[A-Z0-9]{7})\b/g,
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
 * Detect PII in text
 */
export function detectPII(text: string): PIIDetection[] {
  const detections: PIIDetection[] = [];

  for (const [type, { regex, confidence }] of Object.entries(PATTERNS)) {
    // Reset lastIndex for global regexes
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
      return value.replace(/([A-Z]{4})0([A-Z0-9]{7})/, '$1********');
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
 * Check if value is a password field
 */
export function isPasswordField(element: Element): boolean {
  const type = element.getAttribute('type')?.toLowerCase();
  const name = (element.getAttribute('name') || '').toLowerCase();
  const id = (element.getAttribute('id') || '').toLowerCase();
  
  return (
    type === 'password' ||
    name.includes('password') ||
    name.includes('passwd') ||
    name.includes('pwd') ||
    id.includes('password') ||
    id.includes('passwd') ||
    id.includes('pwd')
  );
}

/**
 * Generate privacy event from detection
 */
export function createPrivacyEvent(
  type: string,
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
