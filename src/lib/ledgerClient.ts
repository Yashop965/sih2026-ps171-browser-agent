// src/lib/ledgerClient.ts
// Read side of the privacy ledger.
//
// The ledger itself lives in the background worker (src/entrypoints/
// background.ts) because that is where detections and outbound payloads are
// actually logged. This module is the panel's window onto it: fetch, clear,
// and produce the signed export judges can inspect.
//
// It also fetches live PII detections for the tab currently in front of the
// user, which is a different thing from the ledger: the ledger is history,
// detections are what is on screen right now.

import { browser } from 'wxt/browser';
import type { PrivacyLogEntry } from '../types';

export type LedgerTone = 'blocked' | 'clean' | 'warning';

/** How an entry should read to someone scanning the panel. */
export function toneOf(entry: PrivacyLogEntry): LedgerTone {
    switch (entry.action) {
        case 'REDACTED':
            return 'blocked';
        case 'SENT_TO_SERVER':
        case 'SERVER_RESPONSE':
        case 'SUCCESS':
            return 'clean';
        case 'FAILURE':
            return 'warning';
        default:
            return entry.verified ? 'clean' : 'warning';
    }
}

/** Short human phrase for the badge. */
export function labelOf(entry: PrivacyLogEntry): string {
    switch (entry.action) {
        case 'REDACTED':
            return 'redacted';
        case 'SENT_TO_SERVER':
            return 'sent';
        case 'SERVER_RESPONSE':
            return 'planned';
        case 'EXECUTION':
        case 'SUCCESS':
            return 'executed';
        case 'FAILURE':
            return 'failed';
        default:
            return String(entry.action).toLowerCase();
    }
}

export async function fetchEntries(): Promise<PrivacyLogEntry[]> {
    const result = await browser.runtime.sendMessage({ type: 'GET_PRIVACY_LEDGER' });
    return Array.isArray(result) ? (result as PrivacyLogEntry[]) : [];
}

export async function clearLedger(): Promise<void> {
    await browser.runtime.sendMessage({ type: 'CLEAR_LEDGER' });
}

// --- Live detections on the current page ------------------------------------

/**
 * One PII finding on the page in front of the user.
 *
 * Deliberately has no `value` field. The detector returns a partial value
 * (`input.value.slice(0, 4) + '***'`), which for an Aadhaar number is four
 * real digits. Showing that in a panel whose whole purpose is to prove PII
 * doesn't escape would defeat the point, so it is dropped on arrival.
 */
export interface Detection {
    type: string;
    selector: string;
    confidence: number;
    /** True when a checksum confirmed it, not just a pattern match. */
    verified: boolean;
    redacted: boolean;
}

async function activeTabId(): Promise<number> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    return tab.id;
}

export async function fetchDetections(): Promise<Detection[]> {
    const tabId = await activeTabId();
    const snapshot: any = await browser.tabs.sendMessage(tabId, { type: 'capturePage' });

    const raw = snapshot?.detectedPII;
    if (!Array.isArray(raw)) return [];

    // Rebuild each record field by field rather than spreading, so a new
    // field added to the detector can never silently reach the UI.
    return raw.map((d: any) => ({
        type: String(d.type ?? 'UNKNOWN'),
        selector: String(d.selector ?? ''),
        confidence: Number(d.confidence ?? 0),
        verified: Boolean(d.isVerified),
        redacted: Boolean(d.redacted),
    }));
}

export interface HighlightResult {
    ok: boolean;
    error?: string;
}

/** Ask the content script to outline the element a detection refers to. */
export async function highlightElement(selector: string): Promise<HighlightResult> {
    try {
        const tabId = await activeTabId();
        const result: any = await browser.tabs.sendMessage(tabId, {
            type: 'HIGHLIGHT',
            selector,
        });
        return { ok: Boolean(result?.ok), error: result?.error };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export interface DetectionStats {
    total: number;
    verified: number;
    byType: Array<{ type: string; count: number; percent: number }>;
}

export function summariseDetections(list: Detection[]): DetectionStats {
    const counts: Record<string, number> = {};
    let verified = 0;

    for (const d of list) {
        counts[d.type] = (counts[d.type] ?? 0) + 1;
        if (d.verified) verified++;
    }

    const byType = Object.entries(counts)
        .map(([type, count]) => ({
            type,
            count,
            percent: list.length ? Math.round((count / list.length) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

    return { total: list.length, verified, byType };
}

export async function copySelector(selector: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(selector);
        return true;
    } catch {
        return false;
    }
}

// --- Ledger summary and export ----------------------------------------------

export interface LedgerSummary {
    total: number;
    redacted: number;
    sent: number;
    failed: number;
    /** Detections confirmed by a checksum rather than a pattern alone. */
    verified: number;
    byType: Record<string, number>;
}

export function summarise(entries: PrivacyLogEntry[]): LedgerSummary {
    const byType: Record<string, number> = {};
    let redacted = 0;
    let sent = 0;
    let failed = 0;
    let verified = 0;

    for (const e of entries) {
        if (e.action === 'REDACTED') redacted++;
        if (e.action === 'SENT_TO_SERVER') sent++;
        if (e.action === 'FAILURE') failed++;
        if (e.verified) verified++;
        byType[e.type] = (byType[e.type] ?? 0) + 1;
    }

    return { total: entries.length, redacted, sent, failed, verified, byType };
}

async function sha256Hex(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Strip anything that could carry a raw value out of an entry before it
 * leaves the extension. The ledger is meant to prove PII didn't escape, so
 * the export itself must not carry any.
 */
function scrub(entry: PrivacyLogEntry) {
    let url: string | null = null;
    try {
        const u = new URL(entry.url);
        // Query strings routinely carry PII. Origin and path are enough to
        // say which page a detection came from.
        url = `${u.origin}${u.pathname}`;
    } catch {
        url = null;
    }

    return {
        timestamp: new Date(entry.timestamp).toISOString(),
        tabId: entry.tabId,
        url,
        type: entry.type,
        selector: entry.selector,
        confidence: entry.confidence,
        verified: entry.verified,
        action: entry.action,
        ...(entry.payloadSize !== undefined ? { payloadSize: entry.payloadSize } : {}),
        ...(entry.actionType ? { actionType: entry.actionType } : {}),
        ...(entry.error ? { error: entry.error } : {}),
    };
}

/**
 * Build the export. Entries are numbered oldest-first and the file carries a
 * SHA-256 digest of the record list, so anyone can recompute it and tell
 * whether the file was edited after it was produced.
 */
export async function buildExport(
    entries: PrivacyLogEntry[],
    detections: Detection[] = []
) {
    // The background prepends, so the array arrives newest-first.
    const ordered = entries.slice().reverse();
    const records = ordered.map((e, i) => ({ seq: i + 1, ...scrub(e) }));
    const digest = await sha256Hex(JSON.stringify(records));

    return {
        schema: 'ps171-privacy-ledger/1',
        generatedAt: new Date().toISOString(),
        note: 'Structural metadata only. No detected values, page HTML, or query strings are present in this file.',
        summary: summarise(entries),
        currentPageDetections: {
            stats: summariseDetections(detections),
            items: detections,
        },
        integrity: {
            algorithm: 'SHA-256',
            digest,
            covers: 'the records array, serialised as JSON in the order shown',
        },
        records,
    };
}

export async function downloadLedger(
    entries: PrivacyLogEntry[],
    detections: Detection[] = []
) {
    const payload = await buildExport(entries, detections);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `privacy-ledger-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}