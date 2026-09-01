/**
 * Outbound Privacy Firewall
 *
 * Performs a final recursive inspection of any JSON-serializable payload
 * BEFORE it is transmitted to the backend planner.
 *
 * The backend must never be the first privacy barrier. This firewall is the
 * last line of defence inside the browser.
 *
 * Behaviour:
 *   - Recursively walks strings, arrays, and objects
 *   - Runs lightweight PII patterns against every string value
 *   - Runs checksum validators on high-confidence candidates
 *   - If probable / validated PII is found → blocks the request
 *   - Records an audit event (without storing the raw value)
 *   - Returns FirewallResult with location and category (no raw value)
 *
 * Usage:
 *   const result = inspectPayload(sanitizedPayload);
 *   if (!result.passed) {
 *     // block the fetch; record a BLOCKED audit event
 *   }
 */

import type { PIIType } from '../../types';
import type { FirewallResult } from './types';
import {
  validateAadhaar,
  validatePAN,
  validateCard,
  validateIFSC,
  validateEmail,
  validatePhone,
  validateUPI,
} from './validators';

// ─── Firewall patterns ────────────────────────────────────────────────────────

interface FirewallPattern {
  type: PIIType;
  regex: RegExp;
  /** When true, a regex match is sufficient to block */
  highPrecision: boolean;
  /** Optional checksum validator — when present, match + validation = block */
  validator?: (raw: string) => boolean;
}

const FIREWALL_PATTERNS: FirewallPattern[] = [
  // Aadhaar: only block when Verhoeff checksum passes (reduces false positives
  // on generic 12-digit numbers like timestamps)
  {
    type: 'AADHAAR',
    regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    highPrecision: false,
    validator: validateAadhaar,
  },
  // PAN: format + entity-type character check
  {
    type: 'PAN',
    regex: /\b[A-Z]{5}\d{4}[A-Z]{1}\b/g,
    highPrecision: false,
    validator: validatePAN,
  },
  // Credit/debit card: block when Luhn passes
  {
    type: 'CREDIT_CARD',
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    highPrecision: false,
    validator: validateCard,
  },
  // Email: high precision regex, block on match
  {
    type: 'EMAIL',
    regex: /\b[^\s@]+@[^\s@]+\.[^\s@]{2,}\b/g,
    highPrecision: true,
    validator: validateEmail,
  },
  // IFSC: precise format, block on match
  {
    type: 'IFSC',
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    highPrecision: true,
    validator: validateIFSC,
  },
  // Indian phone: only block when format validates
  {
    type: 'PHONE',
    regex: /\b(\+?91[\s\-]?[6-9]\d{9}|[6-9]\d{9})\b/g,
    highPrecision: false,
    validator: validatePhone,
  },
  // UPI VPA: block on validator pass
  {
    type: 'UPI',
    regex: /\b[a-zA-Z0-9._\-]+@[a-zA-Z0-9]+\b/g,
    highPrecision: false,
    validator: validateUPI,
  },
  // SSN (international): high precision regex
  {
    type: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    highPrecision: true,
  },
  // API key / secret value (contextual — look for assignment patterns)
  {
    type: 'API_KEY',
    regex: /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*([^\s,;'"]{8,})/gi,
    highPrecision: true,
  },
];

// ─── String inspection ────────────────────────────────────────────────────────

/**
 * Check a single string for PII. Returns a FirewallResult.
 * Never exposes the matched value.
 */
function inspectString(text: string, path: string): FirewallResult {
  for (const pat of FIREWALL_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = pat.regex.exec(text)) !== null) {
      const candidate = m[1] ?? m[0];

      if (pat.validator) {
        if (pat.validator(candidate)) {
          return {
            passed: false,
            blockedCategory: pat.type,
            location: path,
            reason: `Validated ${pat.type} detected at ${path}`,
          };
        }
        // If validator fails, treat as low-confidence — continue scanning
      } else if (pat.highPrecision) {
        // High-precision pattern without validator: block on match
        return {
          passed: false,
          blockedCategory: pat.type,
          location: path,
          reason: `${pat.type} pattern matched at ${path}`,
        };
      }
    }
  }

  return { passed: true };
}

// ─── Recursive object walker ──────────────────────────────────────────────────

const MAX_DEPTH = 10;
const MAX_STRING_LENGTH = 10_000;

/**
 * Recursively inspect any JSON-serializable value for PII.
 *
 * @param value  The value to inspect (string, array, object, or primitive)
 * @param path   JSON-path label for audit purposes (no values in this string)
 * @param depth  Current recursion depth (guards against deeply-nested objects)
 */
export function inspectPayload(
  value: unknown,
  path = 'root',
  depth = 0,
): FirewallResult {
  if (depth > MAX_DEPTH) return { passed: true }; // treat excessively nested as safe

  if (typeof value === 'string') {
    if (value.length === 0 || value === '[REDACTED]') return { passed: true };
    if (value.length > MAX_STRING_LENGTH) {
      // Truncate to first 10k characters for scanning — very long strings are
      // unlikely to be PII values but could be binary data.
      return inspectString(value.slice(0, MAX_STRING_LENGTH), path);
    }
    return inspectString(value, path);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = inspectPayload(value[i], `${path}[${i}]`, depth + 1);
      if (!result.passed) return result;
    }
    return { passed: true };
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const result = inspectPayload(obj[key], `${path}.${key}`, depth + 1);
      if (!result.passed) return result;
    }
    return { passed: true };
  }

  // Numbers, booleans, null — safe
  return { passed: true };
}

/**
 * Convenience: run the firewall on a complete outbound payload object.
 * Returns a FirewallResult. If `passed` is false, DO NOT transmit the payload.
 */
export function checkOutboundPayload(payload: unknown): FirewallResult {
  return inspectPayload(payload, 'payload', 0);
}
