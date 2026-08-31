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

import { redactString } from './pii/sanitizer';

/**
 * Detect PII in text
 * Wraps sanitizer.ts
 */
export function detectPII(text: string): PIIDetection[] {
  const { matches } = redactString(text, 'legacy_detect');
  return matches.map(m => ({
    type: m.type,
    value: '[REDACTED]',
    confidence: m.confidence,
  }));
}

/**
 * Redact PII from text
 * Wraps sanitizer.ts
 */
export function redactPII(text: string): { redacted: string; events: PIIDetection[] } {
  const { sanitized, matches } = redactString(text, 'legacy_redact');
  return {
    redacted: sanitized,
    events: matches.map(m => ({
      type: m.type,
      value: '[REDACTED]',
      confidence: m.confidence,
    })),
  };
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
