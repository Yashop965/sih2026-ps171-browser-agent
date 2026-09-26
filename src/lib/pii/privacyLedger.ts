/**
 * Privacy Ledger (legacy)
 *
 * In-memory privacy log for PII detections / redactions / executions, kept
 * alongside the audit ledger. Entries carry no raw PII value — only safe
 * metadata (selector, confidence, action).
 *
 * Issue #72: this ledger used to live as an in-service-worker singleton that
 * was recreated empty on every SW idle-termination / reload, so the
 * "tamper-proof" audit trail only held within one SW lifetime. It now takes
 * an optional durability hook (a change-callback that mirrors the in-memory
 * entries to browser.storage.local) plus a hydrate() to restore the last
 * snapshot at SW start. The pure path (no hook) is unchanged and testable.
 */

export interface PrivacyLogEntry {
  timestamp: number;
  tabId: number;
  url: string;
  type: string;
  selector: string;
  confidence: number;
  verified: boolean;
  action: string;
  payloadSize?: number;
  actionType?: string;
  error?: string;
}

const MAX_ENTRIES = 1000;

export class PrivacyLedger {
  private entries: PrivacyLogEntry[] = [];
  // Issue #72: persistence hook - mirrors in-memory entries to durable
  // storage (browser.storage.local) so the ledger survives an SW restart.
  // Absent in the pure/tested path.
  private readonly onChange?: (entries: PrivacyLogEntry[]) => void;

  constructor(
    initialEntries: PrivacyLogEntry[] = [],
    onChange?: (entries: PrivacyLogEntry[]) => void
  ) {
    this.entries = [...initialEntries].slice(0, MAX_ENTRIES);
    this.onChange = onChange;
  }

  log(entry: Omit<PrivacyLogEntry, 'timestamp'> & Partial<PrivacyLogEntry>): void {
    this.entries.unshift({
      timestamp: Date.now(),
      ...entry,
    });

    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    this.onChange?.(this.entries);
  }

  getEntries(): PrivacyLogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.onChange?.(this.entries);
  }

  // Issue #72: load a previously-persisted snapshot at SW start. Only fills
  // an EMPTY ledger, so an async hydrate that lands after the live loop
  // already logged entries does not clobber the fresher in-memory state.
  hydrate(entries: PrivacyLogEntry[]): void {
    if (this.entries.length === 0) {
      this.entries = (entries || []).slice(0, MAX_ENTRIES);
    }
  }

  getSummary(): {
    total: number;
    byType: Record<string, number>;
    byAction: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    const byAction: Record<string, number> = {};

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    }

    return {
      total: this.entries.length,
      byType,
      byAction,
    };
  }
}
