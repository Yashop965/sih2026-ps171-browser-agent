/**
 * #171 — the PII audit trail reaching the panel.
 *
 * The panel could not show the audit ledger even after the runner started
 * writing to it: `PrivacyLedger.tsx` fetched only GET_PRIVACY_LEDGER. This
 * covers the read side - the shape the UI receives, and the classification it
 * renders by.
 *
 * The critical property is the last group: an audit entry carries category,
 * selector and reason, and must never carry a raw value. If that regresses,
 * the "tamper-proof" proof panel would start displaying the PII it exists to
 * prove was stopped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
vi.mock('wxt/browser', () => ({
  browser: { runtime: { sendMessage: (...a: unknown[]) => sendMessage(...a) } },
}));

import { fetchAuditLog, auditToneOf, auditLabelOf, buildExport } from '../src/lib/ledgerClient';
import type { AuditEvent } from '../src/lib/pii/types';

const AADHAAR = '100000000004';

beforeEach(() => {
  sendMessage.mockReset();
});

describe('fetchAuditLog', () => {
  it('asks for the audit ledger, not the activity one', async () => {
    sendMessage.mockResolvedValue([]);
    await fetchAuditLog();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_AUDIT_LOG' });
  });

  it('returns [] when the worker answers with something that is not an array', async () => {
    sendMessage.mockResolvedValue(undefined);
    expect(await fetchAuditLog()).toEqual([]);
    sendMessage.mockResolvedValue({ oops: true });
    expect(await fetchAuditLog()).toEqual([]);
  });

  it('maps a well-formed entry through unchanged', async () => {
    const entry: AuditEvent = {
      timestamp: '2026-09-26T10:00:00.000Z',
      event: 'BLOCKED',
      category: 'API_KEY',
      element: 'step 3',
      reason: 'residual secret in payload',
      count: 1,
    };
    sendMessage.mockResolvedValue([entry]);
    expect(await fetchAuditLog()).toEqual([entry]);
  });

  it('coerces every field defensively - a malformed entry cannot crash the panel', async () => {
    sendMessage.mockResolvedValue([
      null,
      { event: 'SENT' },
      { event: 'DETECTED', category: 42, count: 'many', timestamp: {} },
    ]);
    const out = await fetchAuditLog();
    expect(out).toHaveLength(3);
    for (const e of out) {
      expect(typeof e.event).toBe('string');
      expect(typeof e.category).toBe('string');
      expect(typeof e.element).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(typeof e.count).toBe('number');
    }
    // The bad count falls back rather than rendering "×many".
    expect(out[2].count).toBe(1);
    expect(out[2].category).toBe('42');
  });

  it('does NOT pass through unknown fields a future AuditEvent might gain', async () => {
    // Rebuilt field-by-field rather than spread, so nothing unexamined reaches
    // the UI. A leaked field here would be rendered verbatim.
    sendMessage.mockResolvedValue([
      {
        timestamp: 't',
        event: 'REDACTED',
        category: 'PAN',
        element: 'elements[0].label',
        reason: 'r',
        count: 1,
        rawValue: AADHAAR,
        secret: 'sk-live-should-never-render',
      },
    ]);
    const [only] = await fetchAuditLog();
    expect(Object.keys(only).sort()).toEqual([
      'category',
      'confidence',
      'count',
      'element',
      'event',
      'reason',
      'timestamp',
    ]);
    expect(JSON.stringify(only)).not.toContain(AADHAAR);
    expect(JSON.stringify(only)).not.toContain('sk-live');
  });
});

describe('audit classification', () => {
  it('BLOCKED is the loud tone - it is the line that says the agent was stopped', () => {
    expect(auditToneOf('BLOCKED')).toBe('blocked');
  });

  it('REDACTED and DETECTED warn; SENT is clean', () => {
    expect(auditToneOf('REDACTED')).toBe('warning');
    expect(auditToneOf('DETECTED')).toBe('warning');
    expect(auditToneOf('SENT')).toBe('clean');
  });

  it('an unrecognised event type warns rather than reading as clean', () => {
    // Fail-safe: an unknown type must never render as the reassuring colour.
    expect(auditToneOf('SOMETHING_NEW' as AuditEvent['event'])).toBe('warning');
  });

  it('labels every known event', () => {
    expect(auditLabelOf('DETECTED')).toBe('detected');
    expect(auditLabelOf('REDACTED')).toBe('redacted');
    expect(auditLabelOf('BLOCKED')).toBe('blocked');
    expect(auditLabelOf('SENT')).toBe('sent');
  });
});

describe('the export carries the audit trail', () => {
  // The exported JSON is the artifact a judge inspects. If it omitted the
  // audit ledger, the panel could show the trail while the exported proof could
  // not - the worse failure, because the export is what gets read afterwards.
  const AUDIT: AuditEvent[] = [
    {
      timestamp: '2026-09-26T10:00:01.000Z',
      event: 'REDACTED',
      category: 'AADHAAR',
      element: 'elements[0].label',
      reason: 'Replaced 1 AADHAAR instance(s) with [REDACTED]',
      count: 1,
    },
    {
      timestamp: '2026-09-26T10:00:00.000Z',
      event: 'BLOCKED',
      category: 'API_KEY',
      element: 'step 3',
      reason: 'residual secret',
      count: 1,
    },
  ];

  it('includes a piiAudit section with the records and a summary', async () => {
    const out = await buildExport([], [], AUDIT);
    expect(out.piiAudit.total).toBe(2);
    expect(out.piiAudit.records).toHaveLength(2);
    expect(out.piiAudit.summary.redacted).toBe(1);
    expect(out.piiAudit.summary.blocked).toBe(1);
  });

  it('numbers audit records oldest-first, matching the main records array', async () => {
    const out = await buildExport([], [], AUDIT);
    // Input arrives newest-first from the worker; the export is oldest-first.
    expect(out.piiAudit.records[0].event).toBe('BLOCKED');
    expect(out.piiAudit.records[0].seq).toBe(1);
    expect(out.piiAudit.records[1].event).toBe('REDACTED');
  });

  it('stays backward-compatible: no audit arg yields an empty section, not a crash', async () => {
    const out = await buildExport([], []);
    expect(out.piiAudit.total).toBe(0);
    expect(out.piiAudit.records).toEqual([]);
    expect(out.records).toEqual([]);
  });

  it('does NOT spread an audit entry - an unknown field cannot reach the file', async () => {
    const leaky = [{ ...AUDIT[0], rawValue: AADHAAR, secret: 'sk-live' } as AuditEvent];
    const out = await buildExport([], [], leaky);
    const json = JSON.stringify(out.piiAudit.records);
    expect(json).not.toContain(AADHAAR);
    expect(json).not.toContain('sk-live');
    expect(Object.keys(out.piiAudit.records[0]).sort()).toEqual([
      'category',
      'count',
      'element',
      'event',
      'reason',
      'seq',
      'timestamp',
    ]);
  });

  it('does not change the digest, which still covers only the records array', async () => {
    const withAudit = await buildExport([], [], AUDIT);
    const without = await buildExport([], []);
    expect(withAudit.integrity.digest).toBe(without.integrity.digest);
  });
});
