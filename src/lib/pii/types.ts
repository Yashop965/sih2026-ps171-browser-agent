/**
 * PII Module — Internal Types
 *
 * These types are internal to src/lib/pii/. They extend the global
 * types in src/types/index.ts without conflicting with them.
 */

import type { PIIType } from '../../types';

// ─── Match / Detection ───────────────────────────────────────────────────────

export interface PIIMatch {
  /** Category of PII detected (AADHAAR, PAN, EMAIL, …) */
  type: PIIType;
  /**
   * Safe masked representation for debugging — NEVER the raw value.
   * e.g. "1234 **** **** 5678"
   */
  maskedValue: string;
  /** CSS / XPath selector of the source element */
  selector: string;
  /** 0–1 confidence before validation */
  baseConfidence: number;
  /** Confidence after checksum / format validation */
  confidence: number;
  /** True only when a checksum/format validator confirmed the match */
  isVerified: boolean;
  /** True after the value has been replaced with [REDACTED] in the payload */
  redacted: boolean;
}

// ─── Sanitised Element ───────────────────────────────────────────────────────

export interface SanitizedElement {
  id: number;
  tag: string;
  role: string;
  /** Label text — PII values replaced with [REDACTED] */
  label: string;
  /** Element name attribute — PII values replaced with [REDACTED] */
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  isPassword: boolean;
  /** True if any PII was found and redacted from this element */
  hadPII: boolean;
}

// ─── Sanitisation Result ─────────────────────────────────────────────────────

export interface SanitizationResult {
  /**
   * True when the payload is considered safe to transmit.
   * False means the outbound firewall blocked the payload.
   */
  safe: boolean;
  /** The sanitised payload ready for transmission */
  payload: {
    url: string;
    title: string;
    timestamp: number;
    interactiveElements: SanitizedElement[];
    accessibilityTree: Array<{
      role: string;
      name: string;
      expanded?: boolean;
      checked?: string;
      required?: boolean;
      disabled?: boolean;
      depth: number;
    }>;
    detectedPII: Array<{
      type: string;
      selector: string;
      confidence: number;
      verified: boolean;
    }>;
    hasScreenshots: boolean;
  };
  /** Privacy statistics for this sanitisation pass */
  privacy: {
    detected: number;
    redacted: number;
    blocked: number;
    outboundPII: number;
  };
  /** All PII matches found, with masked values only */
  matches: PIIMatch[];
}

// ─── Audit Events ─────────────────────────────────────────────────────────────

export type AuditEventType = 'DETECTED' | 'REDACTED' | 'BLOCKED' | 'SENT';

export interface AuditEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Type of event */
  event: AuditEventType;
  /** PII category (AADHAAR, PAN, …) or "PAYLOAD" */
  category: string;
  /** Element selector or description — safe, no values */
  element: string;
  /** Confidence score, if available */
  confidence?: number;
  /** Human-readable reason for the event */
  reason: string;
  /** Number of items this event refers to */
  count: number;
}

// ─── Firewall Result ──────────────────────────────────────────────────────────

export interface FirewallResult {
  /** True means the payload is clean and safe to transmit */
  passed: boolean;
  /** When passed is false, describes what was found — without the raw value */
  blockedCategory?: PIIType | string;
  /** JSON path where PII was found, e.g. "elements[2].label" */
  location?: string;
  reason?: string;
}
