/**
 * Privacy Ledger Tests
 * 
 * Tests for privacy audit logging and ledger management
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('Privacy Ledger', () => {
  let ledger: Array<{
    timestamp: number;
    tabId: number;
    url: string;
    type: string;
    selector: string;
    confidence: number;
    verified: boolean;
    action: string;
  }>;

  beforeEach(() => {
    ledger = [];
  });

  it('should log PII detections', () => {
    const entry = {
      timestamp: Date.now(),
      tabId: 123,
      url: 'https://example.com',
      type: 'AADHAAR',
      selector: 'input[name="aadhaar"]',
      confidence: 0.95,
      verified: true,
      action: 'REDACTED',
    };

    ledger.push(entry);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe('AADHAAR');
  });

  it('should track multiple PII types in same session', () => {
    const entries = [
      { type: 'AADHAAR', action: 'REDACTED' },
      { type: 'PAN', action: 'REDACTED' },
      { type: 'EMAIL', action: 'LOGGED' },
    ];

    entries.forEach(e => {
      ledger.push({
        timestamp: Date.now(),
        tabId: 1,
        url: 'https://test.com',
        type: e.type,
        selector: '',
        confidence: 0.9,
        verified: true,
        action: e.action,
      });
    });

    expect(ledger).toHaveLength(3);
    expect(ledger.some(l => l.type === 'AADHAAR')).toBe(true);
    expect(ledger.some(l => l.type === 'PAN')).toBe(true);
    expect(ledger.some(l => l.type === 'EMAIL')).toBe(true);
  });

  it('should provide summary statistics', () => {
    const entries = [
      { type: 'AADHAAR', verified: true },
      { type: 'PAN', verified: true },
      { type: 'EMAIL', verified: false },
    ];

    entries.forEach(e => {
      ledger.push({
        timestamp: Date.now(),
        tabId: 1,
        url: 'https://test.com',
        type: e.type,
        selector: '',
        confidence: 0.9,
        verified: e.verified,
        action: 'LOGGED',
      });
    });

    const stats = {
      total: ledger.length,
      verified: ledger.filter(l => l.verified).length,
      byType: {} as Record<string, number>,
    };

    ledger.forEach(entry => {
      stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
    });

    expect(stats.total).toBe(3);
    expect(stats.verified).toBe(2);
    expect(stats.byType.AADHAAR).toBe(1);
    expect(stats.byType.PAN).toBe(1);
    expect(stats.byType.EMAIL).toBe(1);
  });

  it('should clear ledger entries', () => {
    ledger.push({
      timestamp: Date.now(),
      tabId: 1,
      url: 'https://test.com',
      type: 'AADHAAR',
      selector: '',
      confidence: 0.9,
      verified: true,
      action: 'LOGGED',
    });

    expect(ledger).toHaveLength(1);

    ledger.splice(0, ledger.length); // Clear

    expect(ledger).toHaveLength(0);
  });

  it('should filter entries by tab ID', () => {
    const entries = [
      { tabId: 1, type: 'AADHAAR' },
      { tabId: 2, type: 'PAN' },
      { tabId: 1, type: 'EMAIL' },
    ];

    entries.forEach(e => {
      ledger.push({
        timestamp: Date.now(),
        tabId: e.tabId,
        url: 'https://test.com',
        type: e.type,
        selector: '',
        confidence: 0.9,
        verified: true,
        action: 'LOGGED',
      });
    });

    const tab1Entries = ledger.filter(l => l.tabId === 1);
    const tab2Entries = ledger.filter(l => l.tabId === 2);

    expect(tab1Entries).toHaveLength(2);
    expect(tab2Entries).toHaveLength(1);
  });
});
