/**
 * #171 — the privacy events the outbound guard already produces must reach the
 * audit ledger, instead of being discarded at the runner.
 *
 * `guardOutboundPlan` returns an `events` array ({ type, selector } per
 * redaction — never a value) plus a blocked/redactedCount verdict. The runner
 * used to drop all of it on the floor, so `PrivacyAuditLedger.detected()`,
 * `.redacted()`, `.blocked()` and `.sent()` had ZERO call sites in the whole
 * repository: a 190-line richer audit ledger persisted to storage and was never
 * written to. That is the "blank tamper-proof audit trail" problem.
 *
 * These tests drive a real AgentRunner and assert the callback fires with the
 * right shape — including on a blocked egress, which is the single most
 * important event in the trail and the easiest to lose because the runner
 * returns immediately after blocking.
 */

import { describe, it, expect } from 'vitest';
import { AgentRunner, type AgentRunnerDeps } from '../src/lib/agentRunner';
import { PrivacyAuditLedger } from '../src/lib/pii/audit';

/**
 * Mirrors the stub in tests/agent-runner.test.ts. The runner calls
 * startSession (for an id), getContext, isTaskViable, completeSession and
 * failSession - a partial stub fails with
 * `d.sessionManager.isTaskViable is not a function` before reaching the guard.
 */
function makeSessionManagerStub() {
  const calls: string[] = [];
  const sm: any = {
    startSession: async () => {
      calls.push('start');
      return 'sess_test';
    },
    getContext: () => ({
      taskDescription: 'x',
      stepCount: 0,
      maxSteps: 100,
      failedElements: new Set<string>(),
      visitedUrls: new Set<string>(),
    }),
    isTaskViable: () => {
      calls.push('viable');
      return true;
    },
    recordFailedElement: (_id: string, el: string) => calls.push(`fail:${el}`),
    completeSession: (_id: string, summary?: string) => calls.push(`complete:${summary ?? ''}`),
    failSession: (_id: string, reason?: string) => calls.push(`failSession:${reason ?? ''}`),
    __calls: calls,
  };
  return sm;
}

interface Report {
  step: number;
  blocked: boolean;
  redactedCount: number;
  category?: string;
  reason?: string;
  events: ReadonlyArray<{ type: string; selector: string }>;
}

/**
 * Build a runner whose extract returns `label`, and collect every privacy
 * report it emits. The label is the PII carrier: a real Aadhaar in it makes
 * the guard redact (and, with a bad one left in a field the redactor cannot
 * reach, block).
 */
function runWithLabel(label: string, task = 'fill the form') {
  const reports: Report[] = [];
  const sm = makeSessionManagerStub();
  const deps: AgentRunnerDeps = {
    extract: async () => ({
      ok: true,
      elements: [{ id: 1, tag: 'input', role: 'textbox', label }],
      url: 'https://example.com',
      title: 'Page',
      context: null,
    }),
    execute: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    fetchPlan: async () => ({ action: { type: 'DONE' } }),
    delay: async () => {},
    sessionManager: sm,
    tabId: 1,
    windowId: 1,
    task,
    startUrl: '',
    onProgress: () => {},
    isStopped: () => false,
    onPrivacyEvents: (r) => reports.push(r as Report),
  };
  const runner = new AgentRunner(deps);
  return { runner, reports, sm };
}

// A canonically-valid Aadhaar (passes the Verhoeff check digit) so the redactor
// treats it as a real detection rather than an unverified pattern match.
const VALID_AADHAAR = '100000000004';

describe('#171 runner reports privacy events', () => {
  it('emits a report on a clean egress', async () => {
    const { runner, reports } = runWithLabel('Search');
    await runner.run();

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].blocked).toBe(false);
    expect(typeof reports[0].step).toBe('number');
    expect(Array.isArray(reports[0].events)).toBe(true);
  });

  it('surfaces the redaction events the guard produced', async () => {
    const { runner, reports } = runWithLabel(`Aadhaar ${VALID_AADHAAR}`);
    await runner.run();

    const all = reports.flatMap((r) => r.events);
    expect(all.length).toBeGreaterThanOrEqual(1);
    // A REDACTED event, carrying category + selector and never a value.
    expect(all.some((e) => e.type === 'AADHAAR')).toBe(true);
    for (const e of all) {
      expect(typeof e.selector).toBe('string');
      // The single most important invariant: no raw PII in the event.
      expect(JSON.stringify(e)).not.toContain(VALID_AADHAAR);
    }
  });

  it('reports redactedCount consistent with the events', async () => {
    const { runner, reports } = runWithLabel(`Aadhaar ${VALID_AADHAAR}`);
    await runner.run();
    for (const r of reports) {
      expect(r.redactedCount).toBeGreaterThanOrEqual(r.events.length);
    }
  });

  it('still reports when the outbound firewall BLOCKS the egress', async () => {
    // A field the redactor cannot rewrite - the element `id`, which the guard
    // does not treat as PII-bearing - so the raw value survives redaction and
    // the last-line firewall blocks on it. This is the path that used to
    // return immediately and record nothing.
    const raw = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const sm = makeSessionManagerStub();
    const reports: Report[] = [];
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: raw, tag: 'input', role: 'textbox', label: 'Enter the code' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => ({ action: { type: 'DONE' } }),
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'fill the form',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      onPrivacyEvents: (r) => reports.push(r as Report),
    };
    const runner = new AgentRunner(deps);
    await runner.run();

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].blocked).toBe(true);
    expect(reports[0].category).toBeTruthy();
    // And the run genuinely failed — the block is not just reported, it acts.
    expect(runner.getState().status).toBe('failed');
  });
});

describe('#171 the callback is optional and must never break egress', () => {
  it('runs normally when onPrivacyEvents is omitted', async () => {
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 1, tag: 'input', role: 'textbox', label: `Aadhaar ${VALID_AADHAAR}` }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => ({ action: { type: 'DONE' } }),
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'fill the form',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      // no onPrivacyEvents
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    expect(runner.getState().status).toBe('complete');
  });

  it('a throwing callback does NOT fail the run', async () => {
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'Search' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => ({ action: { type: 'DONE' } }),
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'fill the form',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      onPrivacyEvents: () => {
        throw new Error('ledger exploded');
      },
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    // An audit write is observability, not a gate.
    expect(runner.getState().status).toBe('complete');
  });
});

describe('#171 the SW adapter drives the real audit ledger', () => {
  it('records REDACTED per event then a SENT outcome', () => {
    const ledger = new PrivacyAuditLedger();
    // Mirrors the adapter in background.ts.
    const report = {
      step: 1,
      blocked: false,
      redactedCount: 1,
      events: [{ type: 'AADHAAR', selector: 'elements[0].label' }],
    };
    for (const ev of report.events) ledger.redacted(ev.type, ev.selector, 1);
    ledger.sent(1, report.redactedCount); // 1 element in this egress

    const s = ledger.getSummary();
    expect(s.redacted).toBe(1);
    expect(s.sent).toBe(1);
    expect(ledger.getEntriesByType('REDACTED')[0].element).toBe('elements[0].label');
  });

  it('records BLOCKED (not SENT) when egress was refused', () => {
    const ledger = new PrivacyAuditLedger();
    ledger.blocked('API_KEY', 'step 1', 'residual secret');
    const s = ledger.getSummary();
    expect(s.blocked).toBe(1);
    expect(s.sent).toBe(0);
  });

  it('a ledger is empty until something writes to it', () => {
    // The #171 baseline: a freshly constructed ledger - exactly what the
    // service worker held before this change - has nothing in it.
    expect(new PrivacyAuditLedger().getSummary().total).toBe(0);
  });
});
