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
  // Credit/debit card: 13–19 digits (any grouping), Luhn-validated. C2: the
  // old 4-4-4-4 regex let 13/14/15/18/19-digit cards through this last line
  // of defence (a raw 15-digit card in payload.history was POSTed to /plan).
  // validateCard already accepts 13–19 via Luhn, so this widens detection to
  // the real card-length range without adding a false block on benign numbers
  // (a non-card 13-19-digit run fails Luhn and passes).
  {
    type: 'CREDIT_CARD',
    regex: /\b\d(?:[\s-]?\d){12,18}\b/g,
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
    regex: /\b(\+?91[\s-]?[6-9]\d{9}|[6-9]\d{9})\b/g,
    highPrecision: false,
    validator: validatePhone,
  },
  // UPI VPA: block on validator pass
  {
    type: 'UPI',
    regex: /\b[a-zA-Z0-9._-]+@[a-zA-Z0-9]+\b/g,
    highPrecision: false,
    validator: validateUPI,
  },
  // SSN (international): high precision regex
  {
    type: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    highPrecision: true,
  },
  // API key / secret value.
  //
  // Two patterns, because one is not enough (issue #164):
  //
  // 1. CONTEXTUAL - an assignment or label, e.g. "api_key=abc123...". Catches
  //    secrets the page described.
  // 2. BARE - the well-known literal prefixes, with no label required. A page
  //    that renders a token on its own ("AKIA...", "ghp_...", "xoxb-...") gave
  //    the contextual pattern nothing to match, so every one of these passed
  //    the last line of defence. The `highPrecision` flag means a bare match
  //    blocks, so these are narrow enough to be safe: each prefix is
  //    vendor-specific with a fixed shape and length.
  {
    type: 'API_KEY',
    regex: /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*([^\s,;'"\n]{8,})/gi,
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g, // GitHub PAT
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bfine_[A-Za-z0-9]{36}\b/g, // GitHub fine-grained PAT
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
    highPrecision: true,
  },
  {
    // Slack: xoxb/xoxp/xoxa/xoxr/xoxs bot+user+app tokens, plus the newer
    // xapp-… app-level token. All are secret-bearing.
    type: 'API_KEY',
    regex: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}\b/g,
    highPrecision: true,
  },
  {
    type: 'API_KEY',
    regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab PAT
    highPrecision: true,
  },
  {
    // JWT: three base64url segments, each non-empty, starting with eyJ (the
    // base64 of '{"'). Requires all three segments so ordinary dotted text
    // ("version 1.2.3") cannot match.
    type: 'API_KEY',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    highPrecision: true,
  },
  {
    // Private key blocks. A PEM header on a page is unambiguous.
    type: 'API_KEY',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
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
 * Per-structure budget for the deep (past-MAX_DEPTH) walk.
 *
 * Past MAX_DEPTH the walker stops descending into structure and instead
 * collects and scans every reachable string, so a secret at ANY depth is still
 * inspected. Depth is a cost control, not a security control - before this,
 * `depth > MAX_DEPTH` returned `{ passed: true }` and never looked at all
 * (issue #164).
 *
 * The limit counts STRINGS, not characters, and each is scanned through in full
 * (bounded individually by MAX_STRING_LENGTH). An earlier attempt sliced the
 * serialised blob to a fixed character count, which let a page push a secret out
 * of the scanned window by padding earlier keys - a page-controlled fail-open.
 * Measured: 600 chars of filler before the secret was enough to walk a PAN and a
 * key straight through. Counting strings makes position within the structure
 * irrelevant.
 */
const DEEP_STRING_BUDGET = 5_000;

/**
 * Collect every string reachable from a value.
 *
 * Used for the past-MAX_DEPTH path, where we deliberately do not walk one level
 * at a time. `seen` is required, not defensive: a page controls the shape of what
 * it returns, so a cyclic structure is possible and the walk must terminate.
 * WeakSet so we do not retain the page's objects.
 */
function collectStrings(
  value: unknown,
  out: string[],
  budget: number,
  seen: WeakSet<object>
): string[] {
  if (out.length >= budget) return out;
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const item of value) collectStrings(item, out, budget, seen);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value as object)) return out;
    seen.add(value as object);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectStrings((value as Record<string, unknown>)[key], out, budget, seen);
    }
  }
  return out;
}

/** Scan every string reachable from a value that sits past MAX_DEPTH. */
function inspectDeep(value: unknown, path: string): FirewallResult {
  const strings = collectStrings(value, [], DEEP_STRING_BUDGET, new WeakSet());
  for (const s of strings) {
    const result = inspectString(
      s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) : s,
      path
    );
    if (!result.passed) return result;
  }
  return { passed: true };
}

/**
 * Recursively inspect any JSON-serializable value for PII.
 *
 * @param value  The value to inspect (string, array, object, or primitive)
 * @param path   JSON-path label for audit purposes (no values in this string)
 * @param depth  Current recursion depth (guards against deeply-nested objects)
 */
export function inspectPayload(value: unknown, path = 'root', depth = 0): FirewallResult {
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
    if (depth > MAX_DEPTH) return inspectDeep(value, path);
    for (let i = 0; i < value.length; i++) {
      const result = inspectPayload(value[i], `${path}[${i}]`, depth + 1);
      if (!result.passed) return result;
    }
    return { passed: true };
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (depth > MAX_DEPTH) return inspectDeep(obj, path);
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
