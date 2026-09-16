/**
 * Issue #72 - the privacy ledgers were in-memory service-worker singletons,
 * wiped empty on every SW restart. Now they write-through to a durable store
 * (injected via an onChange callback) and hydrate at SW start. These tests
 * exercise the pure (no-browser) parts of both durable classes:
 *   - write-through fires on every log / clear,
 *   - hydrate only fills an EMPTY ledger (so a late async hydrate never
 *     clobbers fresher in-memory entries).
 */
import { describe, it, expect } from 'vitest';
import { PrivacyAuditLedger } from '../src/lib/pii/audit';
import { PrivacyLedger, type PrivacyLogEntry } from '../src/lib/pii/privacyLedger';

describe('Issue #72 - ledger durability (write-through + hydrate)', () => {
  it('PrivacyAuditLedger: detected() write-through carries the full snapshot', () => {
    const writes: any[][] = [];
    const ledger = new PrivacyAuditLedger([], (entries) => writes.push([...entries]));

    ledger.detected('AADHAAR', 'element#3', 0.98, true);

    expect(writes.length).toBe(1);
    expect(writes[0][0].event).toBe('DETECTED');
    expect(writes[0][0].category).toBe('AADHAAR');
    expect(ledger.getEntries().length).toBe(writes[0].length);
  });

  it('PrivacyAuditLedger: clear() write-through mirrors an empty store', () => {
    const writes: any[][] = [];
    const ledger = new PrivacyAuditLedger([], (entries) => writes.push([...entries]));
    ledger.redacted('PAN', 'input#1', 0.5);
    const before = writes.length;
    ledger.clear();
    expect(writes.length).toBe(before + 1);
    expect(writes[writes.length - 1]).toHaveLength(0);
  });

  it('PrivacyAuditLedger: hydrate fills an empty ledger with the snapshot', () => {
    const restored = [
      { timestamp: 't0', event: 'DETECTED' as const, category: 'EMAIL', element: 'a', confidence: 0.9, reason: 'r', count: 1 },
    ];
    const ledger = new PrivacyAuditLedger([], undefined);
    ledger.hydrate(restored);
    expect(ledger.getEntries().map((e) => e.category)).toEqual(['EMAIL']);
  });

  it('PrivacyAuditLedger: hydrate does NOT clobber newer in-memory entries', () => {
    const ledger = new PrivacyAuditLedger([], undefined);
    ledger.blocked('AADHAAR', 'task_description', 'residual PII');
    expect(ledger.getEntries().length).toBe(1);
    ledger.hydrate([
      { timestamp: 't0', event: 'SENT' as const, category: 'PAYLOAD', element: 'x', confidence: 1, reason: 'old', count: 1 },
    ]);
    expect(ledger.getEntries().length).toBe(1);
    expect(ledger.getEntries()[0].event).toBe('BLOCKED'); // still the live one
  });

  it('PrivacyLedger: log() write-through + empty-only hydrate', () => {
    const writes: PrivacyLogEntry[][] = [];
    const ledger = new PrivacyLedger([], (entries) => writes.push(entries.map((e) => ({ ...e }))));

    ledger.log({ tabId: 1, url: 'https://x', type: 'AADHAAR', selector: 'i', confidence: 0.9, verified: true, action: 'REDACTED' });
    expect(writes.length).toBe(1);
    expect(writes[0][0].type).toBe('AADHAAR');

    // A live entry exists -> hydrate must NOT overwrite it with the stale one.
    ledger.hydrate([{ tabId: 9, url: 'u', type: 'EMAIL', selector: 's', confidence: 0.1, verified: false, action: 'LOGGED', timestamp: 0 }]);
    expect(ledger.getEntries().length).toBe(1);
    expect(ledger.getEntries()[0].type).toBe('AADHAAR'); // kept the live REDACTED entry

    // ...but hydrate DOES populate an empty ledger.
    const empty = new PrivacyLedger([], undefined);
    empty.hydrate([{ tabId: 9, url: 'u', type: 'EMAIL', selector: 's', confidence: 0.1, verified: false, action: 'LOGGED', timestamp: 0 }]);
    expect(empty.getEntries().length).toBe(1);
  });

  it('PrivacyLedger: MAX_ENTRIES cap still applies (1000)', () => {
    const ledger = new PrivacyLedger([], undefined);
    for (let i = 0; i < 1005; i++) {
      ledger.log({ tabId: i, url: 'u', type: 'T', selector: 's', confidence: 1, verified: true, action: 'A' });
    }
    expect(ledger.getEntries().length).toBe(1000);
  });
});
