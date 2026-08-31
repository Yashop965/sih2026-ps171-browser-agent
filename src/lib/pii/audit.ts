/**
 * Privacy Audit Ledger
 *
 * Provides an importable, testable audit mechanism for the PII pipeline.
 * All events are stored without the raw PII value — only safe metadata.
 *
 * Event types:
 *   DETECTED  — PII pattern found in page content
 *   REDACTED  — Sensitive value replaced with [REDACTED] in payload
 *   BLOCKED   — Outbound firewall blocked a request due to residual PII
 *   SENT      — Sanitized payload transmitted to backend
 *
 * Example ledger entry:
 *   {
 *     timestamp: "2026-08-31T00:00:00.000Z",
 *     event: "REDACTED",
 *     category: "AADHAAR",
 *     element: "element#3.label",
 *     confidence: 0.99,
 *     reason: "Verhoeff validation passed",
 *     count: 1
 *   }
 */

import type { AuditEvent, AuditEventType } from './types';

const MAX_ENTRIES = 2000;

export class PrivacyAuditLedger {
  private entries: AuditEvent[] = [];

  // ─── Recording ──────────────────────────────────────────────────────────────

  /**
   * Record a DETECTED event.
   * @param category  PII type label (AADHAAR, PAN, …)
   * @param element   Safe element identifier (selector or name, no values)
   * @param confidence  Detection confidence 0–1
   * @param verified  Whether checksum validation passed
   * @param count     Number of instances found
   */
  detected(
    category: string,
    element: string,
    confidence: number,
    verified: boolean,
    count = 1,
  ): void {
    this.push({
      event: 'DETECTED',
      category,
      element,
      confidence,
      reason: verified
        ? `${category} detected — checksum/format validated`
        : `${category} pattern matched — unverified`,
      count,
    });
  }

  /**
   * Record a REDACTED event.
   */
  redacted(
    category: string,
    element: string,
    confidence: number,
    count = 1,
  ): void {
    this.push({
      event: 'REDACTED',
      category,
      element,
      confidence,
      reason: `Replaced ${count} ${category} instance(s) with [REDACTED]`,
      count,
    });
  }

  /**
   * Record a BLOCKED event.
   * @param category   PII category that triggered the block
   * @param location   JSON path where PII was found (no raw value)
   * @param reason     Description of why the request was blocked
   */
  blocked(category: string, location: string, reason: string): void {
    this.push({
      event: 'BLOCKED',
      category,
      element: location,
      reason,
      count: 1,
    });
  }

  /**
   * Record a SENT event (successful transmission).
   * @param elementCount  Number of UI elements in the payload
   * @param piiCount      Number of PII items (already redacted) in the payload
   */
  sent(elementCount: number, piiCount: number): void {
    this.push({
      event: 'SENT',
      category: 'PAYLOAD',
      element: `${elementCount} elements`,
      reason: `Sanitized payload transmitted — ${piiCount} PII fields stripped`,
      count: elementCount,
    });
  }

  // ─── Querying ────────────────────────────────────────────────────────────────

  getEntries(): AuditEvent[] {
    return [...this.entries];
  }

  getEntriesByType(type: AuditEventType): AuditEvent[] {
    return this.entries.filter((e) => e.event === type);
  }

  getSummary(): {
    total: number;
    detected: number;
    redacted: number;
    blocked: number;
    sent: number;
    byCategory: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    let detected = 0, redacted = 0, blocked = 0, sent = 0;

    for (const entry of this.entries) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + entry.count;
      if (entry.event === 'DETECTED') detected += entry.count;
      else if (entry.event === 'REDACTED') redacted += entry.count;
      else if (entry.event === 'BLOCKED') blocked += entry.count;
      else if (entry.event === 'SENT') sent += entry.count;
    }

    return {
      total: this.entries.length,
      detected,
      redacted,
      blocked,
      sent,
      byCategory,
    };
  }

  clear(): void {
    this.entries = [];
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private push(partial: Omit<AuditEvent, 'timestamp'>): void {
    const entry: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
  }
}

// Module-level singleton — can also be instantiated per-session
export const privacyAuditLedger = new PrivacyAuditLedger();
