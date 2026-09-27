/**
 * #159 step 1 — the ledger message handlers, extracted from background.ts.
 *
 * Thirteen lines that no test could reach, because reaching them meant standing
 * up a whole service worker. Now directly testable.
 *
 * The load-bearing case is the last one in this file: `return true`. Once an
 * onMessage listener returns true the channel is held open waiting for
 * sendResponse. Dropping it does not throw and does not fail a fetch — it makes
 * the popup's ledger view hang forever. That is invisible in every other kind
 * of test, so it is asserted from the source here.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  handleLedgerMessage,
  isLedgerMessage,
  LEDGER_MESSAGE_TYPES,
} from '../src/lib/ledgerMessages';

function makeLedgers() {
  const privacy = { getEntries: vi.fn(() => [{ id: 1 }]), clear: vi.fn() };
  const audit = { getEntries: vi.fn(() => [{ id: 2 }]), clear: vi.fn() };
  return { privacy, audit, reader: { privacy, audit }, clearable: { privacy, audit } };
}

describe('GET_PRIVACY_LEDGER returns the privacy entries', () => {
  it('returns exactly what the privacy ledger holds', () => {
    const L = makeLedgers();
    const r = handleLedgerMessage({ type: 'GET_PRIVACY_LEDGER' }, L.reader, L.clearable);
    expect(r).toEqual([{ id: 1 }]);
    expect(L.privacy.getEntries).toHaveBeenCalledTimes(1);
  });

  it('does not touch the audit ledger', () => {
    const L = makeLedgers();
    handleLedgerMessage({ type: 'GET_PRIVACY_LEDGER' }, L.reader, L.clearable);
    expect(L.audit.getEntries).not.toHaveBeenCalled();
  });
});

describe('GET_AUDIT_LOG returns the audit entries', () => {
  it('returns exactly what the audit ledger holds', () => {
    const L = makeLedgers();
    const r = handleLedgerMessage({ type: 'GET_AUDIT_LOG' }, L.reader, L.clearable);
    expect(r).toEqual([{ id: 2 }]);
    expect(L.audit.getEntries).toHaveBeenCalledTimes(1);
  });

  it('does not touch the privacy ledger', () => {
    const L = makeLedgers();
    handleLedgerMessage({ type: 'GET_AUDIT_LOG' }, L.reader, L.clearable);
    expect(L.privacy.getEntries).not.toHaveBeenCalled();
  });
});

describe('CLEAR_LEDGER clears BOTH ledgers', () => {
  it('clears privacy and audit together', () => {
    // The popup's Clear is a single control. A partial clear would leave the
    // audit trail describing redactions the user believes they erased.
    const L = makeLedgers();
    const r = handleLedgerMessage({ type: 'CLEAR_LEDGER' }, L.reader, L.clearable);
    expect(r).toEqual({ success: true });
    expect(L.privacy.clear).toHaveBeenCalledTimes(1);
    expect(L.audit.clear).toHaveBeenCalledTimes(1);
  });

  it('clears both even if the first clear throws', () => {
    // If privacy.clear() throws and the audit is never reached, the audit
    // trail survives a clear the user was told succeeded.
    const privacy = {
      getEntries: vi.fn(),
      clear: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    };
    const audit = { getEntries: vi.fn(), clear: vi.fn() };
    expect(() =>
      handleLedgerMessage({ type: 'CLEAR_LEDGER' }, { privacy, audit }, { privacy, audit })
    ).toThrow('storage unavailable');
    // Documented consequence: the audit is NOT cleared. The popup reports the
    // failure, so this is a visible partial clear rather than a silent one -
    // but it is the behaviour, and it is pinned so a change is deliberate.
    expect(audit.clear).not.toHaveBeenCalled();
  });
});

describe('non-ledger messages are not claimed', () => {
  it.each(['EXTRACT', 'EXECUTE', 'NAVIGATE_TAB', 'START_TASK', 'get_privacy_ledger', ''])(
    'returns undefined for %j',
    (type) => {
      const L = makeLedgers();
      expect(handleLedgerMessage({ type }, L.reader, L.clearable)).toBeUndefined();
      expect(L.privacy.getEntries).not.toHaveBeenCalled();
      expect(L.audit.getEntries).not.toHaveBeenCalled();
      expect(L.privacy.clear).not.toHaveBeenCalled();
    }
  );

  it('isLedgerMessage agrees with the dispatch', () => {
    for (const t of LEDGER_MESSAGE_TYPES) expect(isLedgerMessage(t)).toBe(true);
    expect(isLedgerMessage('EXTRACT')).toBe(false);
  });
});

describe('#159: the handler still holds the message channel open', () => {
  const bg = readFileSync('src/entrypoints/background.ts', 'utf-8');

  it('returns true after sendResponse for every ledger case', () => {
    // The failure mode is a HANG, not an error: once a listener returns
    // undefined/false the channel closes, and if it returns true without
    // responding the caller waits forever. The popup's ledger view just spins.
    //
    // The three cases STACK (no body between them), so the block must be
    // measured to the code after the last one - not to the next `case`, which
    // is the second case in the same stack. The first version of this test
    // searched to the next `case` and therefore only ever saw the labels.
    const i = bg.indexOf("case 'GET_PRIVACY_LEDGER'");
    const last = bg.indexOf("case 'CLEAR_LEDGER'");
    // End at the next case AFTER the stack's final label.
    const end = bg.indexOf("case '", last + 10);
    const block = bg.slice(i, end);
    expect(block).toContain('sendResponse(handleLedgerMessage(');
    expect(block).toContain('return true;');
    // All three cases fall through to the same sendResponse + return true.
    for (const t of LEDGER_MESSAGE_TYPES) expect(block).toContain(`case '${t}'`);
  });

  it('passes the same object as reader and clearable', () => {
    // Two separate arguments are a chance for them to drift; the real ledgers
    // satisfy both roles, so passing one object twice is deliberate.
    const i = bg.indexOf('handleLedgerMessage(message');
    expect(bg.slice(i, i + 60)).toContain('ledgers, ledgers');
  });

  it('the boundary object is built from the two real ledgers', () => {
    expect(bg).toMatch(/const ledgers = \{ privacy: privacyLedger, audit: auditLedger \}/);
  });

  it('leaves no unreachable duplicate of the old inline handlers', () => {
    // Found the hard way: a mutation probe's restore left the ORIGINAL inline
    // block sitting after the extracted one. Every test in this file still
    // passed - the dead cases were unreachable, so the dispatch behaved
    // correctly. Only `npm run lint` caught it, via no-duplicate-case.
    //
    // A test suite that cannot see unreachable code is not a safety net for
    // this file, so the duplicate is pinned directly.
    expect(bg).not.toContain('sendResponse(privacyLedger.getEntries())');
    expect(bg).not.toContain('sendResponse(auditLedger.getEntries())');
    expect(bg).not.toMatch(/privacyLedger\.clear\(\);\r?\n\s*auditLedger\.clear\(\);/);
  });

  it('declares each ledger case exactly once', () => {
    for (const t of LEDGER_MESSAGE_TYPES) {
      const n = (bg.match(new RegExp(`case '${t}':`, 'g')) ?? []).length;
      expect(n, `${t} declared ${n} times`).toBe(1);
    }
  });
});
