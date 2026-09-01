/**
 * Payload Sanitizer
 *
 * Converts a raw DOM snapshot into a privacy-safe payload that can be
 * transmitted to the backend planner.
 *
 * Pipeline:
 *   raw snapshot → PII detection → validation → redaction → structured result
 *
 * Guarantees:
 *   - Raw PII values are NEVER included in the returned payload.
 *   - Sensitive string fields are replaced with "[REDACTED]".
 *   - Structural information (IDs, roles, labels) is preserved when safe.
 *   - Returns structured privacy metadata for the audit ledger.
 */

import type { PIIType } from '../../types';
import type { PIIMatch, SanitizationResult, SanitizedElement } from './types';
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
} from './validators';

// ─── Pattern definitions ──────────────────────────────────────────────────────

interface PatternDef {
  type: PIIType;
  regex: RegExp;
  baseConfidence: number;
  validator?: (raw: string) => boolean;
}

const PATTERNS: PatternDef[] = [
  // Aadhaar: 12 digits, with or without spaces
  {
    type: 'AADHAAR',
    regex: /\b(\d{4}\s?\d{4}\s?\d{4})\b/g,
    baseConfidence: 0.70,
    validator: validateAadhaar,
  },
  // PAN: AAAAA9999A
  {
    type: 'PAN',
    regex: /\b([A-Z]{5}\d{4}[A-Z]{1})\b/g,
    baseConfidence: 0.80,
    validator: validatePAN,
  },
  // Credit/Debit card: 16 digits optionally separated
  {
    type: 'CREDIT_CARD',
    regex: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
    baseConfidence: 0.70,
    validator: validateCard,
  },
  // IFSC: XXXX0XXXXXX
  {
    type: 'IFSC',
    regex: /\b([A-Z]{4}0[A-Z0-9]{6})\b/g,
    baseConfidence: 0.85,
    validator: validateIFSC,
  },
  // Email
  {
    type: 'EMAIL',
    regex: /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g,
    baseConfidence: 0.95,
    validator: validateEmail,
  },
  // Indian phone: 10 digits, optionally with +91 / 0 prefix
  {
    type: 'PHONE',
    regex: /\b(\+?91[\s\-]?[6-9]\d{9}|0[6-9]\d{9}|[6-9]\d{9})\b/g,
    baseConfidence: 0.70,
    validator: validatePhone,
  },
  // UPI VPA
  {
    type: 'UPI',
    regex: /\b([a-zA-Z0-9._\-]+@[a-zA-Z0-9]+)\b/g,
    baseConfidence: 0.75,
    validator: validateUPI,
  },
  // API keys / secrets (contextual — high false-positive risk; require context)
  {
    type: 'API_KEY',
    regex: /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*([^\s,;'"]{8,})/gi,
    baseConfidence: 0.80,
  },
  // SSN (international)
  {
    type: 'SSN',
    regex: /\b(\d{3}-\d{2}-\d{4})\b/g,
    baseConfidence: 0.85,
  },
];

// Confidence threshold — matches below this are low-confidence and still redacted
// but not counted as "verified".
const CONFIDENCE_THRESHOLD = 0.50;

// ─── String scanning ──────────────────────────────────────────────────────────

/**
 * Scan a string for PII patterns. Returns all matches found.
 * The returned `maskedValue` is safe for audit logs.
 */
export function scanString(text: string, selector: string): PIIMatch[] {
  if (!text || typeof text !== 'string') return [];
  const matches: PIIMatch[] = [];

  for (const def of PATTERNS) {
    // Reset global regex state before each use
    def.regex.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = def.regex.exec(text)) !== null) {
      const raw = m[1] ?? m[0];
      const isVerified = def.validator ? def.validator(raw) : false;
      const confidence = isVerified
        ? Math.min(def.baseConfidence + 0.15, 0.99)
        : def.baseConfidence;

      if (confidence < CONFIDENCE_THRESHOLD) continue;

      const masked =
        def.type === 'CREDIT_CARD' || def.type === 'DEBIT_CARD'
          ? maskCard(raw)
          : maskValue(raw, def.type);

      matches.push({
        type: def.type,
        maskedValue: masked,
        selector,
        baseConfidence: def.baseConfidence,
        confidence,
        isVerified,
        redacted: false, // set true after payload replacement
      });
    }
  }

  return matches;
}

/**
 * Replace all PII occurrences in `text` with "[REDACTED]".
 * Returns the sanitized string and the matches found.
 */
export function redactString(
  text: string,
  selector: string,
): { sanitized: string; matches: PIIMatch[] } {
  const matches = scanString(text, selector);
  if (matches.length === 0) return { sanitized: text, matches: [] };

  let sanitized = text;
  for (const def of PATTERNS) {
    def.regex.lastIndex = 0;
    sanitized = sanitized.replace(def.regex, '[REDACTED]');
  }

  const marked = matches.map((m) => ({ ...m, redacted: true }));
  return { sanitized, matches: marked };
}

// ─── Password-field detection ─────────────────────────────────────────────────

const PASSWORD_ATTRS = new Set(['password', 'passwd', 'pwd', 'pin', 'pass']);

export function isPasswordField(type: string | null, name: string): boolean {
  if (type === 'password') return true;
  const n = name.toLowerCase();
  for (const attr of PASSWORD_ATTRS) {
    if (n.includes(attr)) return true;
  }
  return false;
}

// ─── Element sanitisation ─────────────────────────────────────────────────────

export interface RawElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  isPassword: boolean;
  type?: string | null;
}

/**
 * Sanitise a single interactive element.
 * Returns the sanitised element and any PII matches found.
 */
function sanitizeElement(
  raw: RawElement,
): { element: SanitizedElement; matches: PIIMatch[] } {
  const allMatches: PIIMatch[] = [];
  const selector = `element#${raw.id}`;

  // If it's a password field, redact label too (it may contain "Password" — safe,
  // but the value must never appear).
  if (raw.isPassword) {
    allMatches.push({
      type: 'PASSWORD_FIELD',
      maskedValue: '••••••••',
      selector,
      baseConfidence: 0.99,
      confidence: 0.99,
      isVerified: true,
      redacted: true,
    });
    return {
      element: {
        id: raw.id,
        tag: raw.tag,
        role: raw.role,
        label: raw.label, // label text is safe (it's the field name like "Password")
        name: raw.name,
        rect: raw.rect,
        isPassword: true,
        hadPII: true,
      },
      matches: allMatches,
    };
  }

  // Scan label and name for PII
  const { sanitized: label, matches: labelMatches } = redactString(raw.label, selector + '.label');
  const { sanitized: name, matches: nameMatches } = redactString(raw.name, selector + '.name');

  allMatches.push(...labelMatches, ...nameMatches);

  return {
    element: {
      id: raw.id,
      tag: raw.tag,
      role: raw.role,
      label,
      name,
      rect: raw.rect,
      isPassword: false,
      hadPII: allMatches.length > 0,
    },
    matches: allMatches,
  };
}

// ─── Accessibility tree sanitisation ─────────────────────────────────────────

interface RawARIA {
  role: string;
  name: string;
  expanded?: boolean;
  checked?: string;
  required?: boolean;
  disabled?: boolean;
  depth: number;
}

function sanitizeARIA(node: RawARIA): { node: RawARIA; matches: PIIMatch[] } {
  const { sanitized: name, matches } = redactString(node.name, `aria[${node.role}]`);
  return { node: { ...node, name }, matches };
}

// ─── Main sanitiser ───────────────────────────────────────────────────────────

export interface RawSnapshot {
  url: string;
  title: string;
  timestamp: number;
  interactiveElements: RawElement[];
  accessibilityTree: RawARIA[];
  detectedPII: Array<{
    type: string;
    selector: string;
    confidence: number;
    isVerified?: boolean;
    redacted: boolean;
  }>;
  hasScreenshots?: boolean;
}

/**
 * Sanitize a raw DOM snapshot, producing a privacy-safe payload.
 *
 * @param snapshot  Raw snapshot from the content script
 * @returns         SanitizationResult with safe payload and privacy metadata
 */
export function sanitizeSnapshot(snapshot: RawSnapshot): SanitizationResult {
  const allMatches: PIIMatch[] = [];

  // 1. Sanitize URL (strip query-string values that may contain PII)
  let safeUrl = snapshot.url;
  try {
    const u = new URL(snapshot.url);
    // Remove values from query params — keep keys for navigation context
    const params = new URLSearchParams();
    u.searchParams.forEach((_v, k) => params.set(k, '[REDACTED]'));
    u.search = params.toString() ? `?${params.toString()}` : '';
    safeUrl = u.toString();
  } catch {
    // If URL parsing fails, just use as-is and let the redactor handle it
  }

  // Run the redactor over the URL to catch PII in the path and hash fragment
  const { sanitized: finalUrl, matches: urlMatches } = redactString(safeUrl, 'url');
  safeUrl = finalUrl;
  allMatches.push(...urlMatches);

  // 2. Sanitize title
  const { sanitized: safeTitle, matches: titleMatches } = redactString(snapshot.title, 'title');
  allMatches.push(...titleMatches);

  // 3. Sanitize interactive elements
  const sanitizedElements: SanitizedElement[] = [];
  for (const el of snapshot.interactiveElements) {
    const { element, matches } = sanitizeElement(el);
    sanitizedElements.push(element);
    allMatches.push(...matches);
  }

  // 4. Sanitize accessibility tree
  const sanitizedTree: RawARIA[] = [];
  for (const node of snapshot.accessibilityTree) {
    const { node: safeNode, matches } = sanitizeARIA(node);
    sanitizedTree.push(safeNode);
    allMatches.push(...matches);
  }

  // 5. Build the PII summary for the server (no raw values)
  const piiSummary = snapshot.detectedPII.map((p) => ({
    type: p.type,
    selector: p.selector,
    confidence: p.confidence,
    verified: p.isVerified ?? false,
  }));

  const redactedCount = allMatches.filter((m) => m.redacted).length;

  return {
    safe: true, // Firewall runs separately and may change this
    payload: {
      url: safeUrl,
      title: safeTitle,
      timestamp: snapshot.timestamp,
      interactiveElements: sanitizedElements,
      accessibilityTree: sanitizedTree,
      detectedPII: piiSummary,
      hasScreenshots: snapshot.hasScreenshots ?? false,
    },
    privacy: {
      detected: allMatches.length,
      redacted: redactedCount,
      blocked: 0,
      outboundPII: 0,
    },
    matches: allMatches,
  };
}
