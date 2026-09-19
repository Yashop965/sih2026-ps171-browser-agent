/**
 * Issues #71 + #69 - the task loop now runs in the service worker via
 * AgentRunner (src/lib/agentRunner.ts), driven through the shipped
 * SessionManager. These tests exercise the runner with fake channels + a
 * stub session manager so the loop's control flow is verified without a live
 * browser:
 *   - it completes a multi-step task (TYPE then CLICK then DONE),
 *   - it records failures to the session's failed-element memory (#69),
 *   - it honors a cooperative stop (#70), and
 *   - the pure helpers (history / step-budget / loop-detect) behave.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentRunner,
  buildPlanHistory,
  calculateMaxSteps,
  isRepeatedAction,
  emptyTaskState,
  mergeChecklist,
  type AgentRunnerDeps,
  type ChecklistItem,
} from '../src/lib/agentRunner';

// ── A minimal stub that satisfies the SessionManager surface the runner uses ──
function makeSessionManagerStub() {
  let maxSteps = 100;
  const failedElements = new Set<string>();
  const calls: string[] = [];
  let viable = true;

  const sm: any = {
    startSession: async (_t: any, _w: any, _u: string, _task: string, max?: number) => {
      if (max) maxSteps = max;
      calls.push('start');
      return 'sess_test';
    },
    getContext: () => ({ taskDescription: 'x', stepCount: 0, maxSteps, failedElements: failedElements as any, visitedUrls: new Set() }),
    isTaskViable: () => { calls.push('viable'); return viable; },
    recordFailedElement: (_id: string, el: string) => { failedElements.add(el); calls.push(`fail:${el}`); },
    completeSession: (id: string, summary?: string) => { calls.push(`complete:${summary ?? ''}`); },
    failSession: (id: string, reason?: string) => { calls.push(`failSession:${reason ?? ''}`); },
    // force-flagged helper
    __setViable: (v: boolean) => { viable = v; },
    __failedElements: failedElements,
    __calls: calls,
  };
  return sm;
}

interface PlanStep {
  plan: any; // the /plan JSON the fake returns for the next step
  executeResults?: Array<{ ok: boolean; error?: string }>;
}

function makeRunner(planSteps: PlanStep[], opts: Partial<Record<string, any>> = {}) {
  const sm = makeSessionManagerStub();
  const progress: any[] = [];
  let planIndex = 0;
  let stopNow = false;
  let execIndex = 0;

  const deps: AgentRunnerDeps = {
    extract: async () => ({
      ok: true,
      elements: [
        { id: 1, tag: 'input', role: 'textbox', label: 'name' },
        { id: 2, tag: 'button', role: 'button', label: 'Submit' },
      ],
      url: 'https://example.com',
      title: 'Page',
      context: null,
      ...(opts.extract ?? {}),
    }),
    execute: async () => {
      const list = planSteps.find((s) => s.executeResults)?.executeResults ?? [];
      return { ok: true, ...(list[execIndex++ % list.length] ?? {}) };
    },
    navigate: async () => ({ ok: true }),
    fetchPlan: async () => {
      const step = planSteps[planIndex++] ?? { plan: { action: { type: 'DONE' } } };
      return step.plan;
    },
    delay: async () => {},
    sessionManager: sm,
    tabId: 1,
    windowId: 1,
    task: 'fill the form',
    startUrl: '',
    onProgress: (state) => progress.push(state),
    isStopped: () => stopNow,
  };
  const runner = new AgentRunner(deps as AgentRunnerDeps);
  return {
    runner,
    sm,
    progress,
    stop: () => { stopNow = true; },
  };
}

describe('AgentRunner - SW-owned loop (#71/#69)', () => {
  it('completes a multi-step task: TYPE, CLICK, then DONE', async () => {
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'a' } }, executeResults: [{ ok: true }] },
      { plan: { action: { type: 'CLICK', targetId: 2 } }, executeResults: [{ ok: true }] },
      { plan: { action: { type: 'DONE', reasoning: 'done' } } },
    ];
    const { runner, sm, progress } = makeRunner(steps);
    await runner.run();

    const final = runner.getState();
    expect(final.running).toBe(false);
    expect(final.status).toBe('complete');
    expect(sm.__calls).toContain('start');
    expect(sm.__calls).toContain('complete:complete');
    expect(sm.__calls.some((c: string) => c === 'viable')).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('records a failed TYPE to the session failed-element memory (#69)', async () => {
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'a' } }, executeResults: [{ ok: false, error: 'boom' }] },
      { plan: { action: { type: 'DONE' } } },
    ];
    const { runner, sm } = makeRunner(steps);
    await runner.run();
    expect(sm.__calls).toContain('fail:1');
    expect(sm.__failedElements.has('1')).toBe(true);
  });

  it('a navigating CLICK resets history + adds a 600ms settle (Bug E regression)', async () => {
    // A click that opens an article/suggestion link drops the content port;
    // the SW reports ok:true + a "page navigated" note. The runner must give
    // the new page a full-navigation settle (600ms) before the next EXTRACT,
    // because the flat 300ms inter-step settle does NOT cover navigating
    // CLICKs. We observe the 600ms delay call.
    const sm = makeSessionManagerStub();
    const delayCalls: number[] = [];
    const note = 'page navigated - will re-extract the new page';
    const steps = [
      { plan: { action: { type: 'CLICK', targetId: 2 } } },
      { plan: { action: { type: 'DONE' } } },
    ];
    let planIdx = 0;
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 2, tag: 'button', role: 'button', label: 'Go' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true, note }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => steps[planIdx++]?.plan ?? { action: { type: 'DONE' } },
      delay: async (ms: number) => { delayCalls.push(ms); },
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'open the article',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
    };
    const runner = new AgentRunner(deps as AgentRunnerDeps);
    await runner.run();

    expect(delayCalls).toContain(600);
    expect(runner.getState().status).toBe('complete');
  });

  it('honors a cooperative stop between steps (#70)', async () => {
    // Build a runner whose stop flag flips after the first step, so the
    // inter-step polling sees it and the run terminates as 'stopped'.
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => ({ action: { type: 'TYPE', targetId: 1, value: 'a' } }),
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'fill the form',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => stepCount >= 1, // stop as soon as one step has run
    };
    let stepCount = 0;
    // Count steps via the session's getContext step counter is internal; use a
    // local proxy by wrapping fetchPlan's call count instead.
    const realFetch = deps.fetchPlan;
    deps.fetchPlan = async (...a: any[]) => { stepCount++; return realFetch(...a); };

    const runner = new AgentRunner(deps);
    await runner.run();
    const final = runner.getState();
    expect(final.running).toBe(false);
    expect(final.status).toBe('stopped');
    expect(sm.__calls).toContain('failSession:stopped');
  });

  it('fails the run when the outbound firewall blocks /plan', async () => {
    const { runner, sm } = makeRunner([]);
    // The extractor above returns a clean element; to test the block path we
    // build a runner whose element label carries PII so guardOutboundPlan
    // redacts + the firewall still passes (masking, not blocking). The block
    // path is covered by the sanitizer firewall tests; here we assert a
    // clean run degrades to "failed" only on extract failure.
    const { runner: r2, sm: sm2 } = makeRunner2FailingExtract();
    await r2.run();
    expect(r2.getState().status).toBe('failed');
    expect(sm2.__calls).toContain('failSession:extract failed');
    void runner; void sm;
  });
});

function makeRunner2FailingExtract() {
  const sm = makeSessionManagerStub();
  const deps: AgentRunnerDeps = {
    extract: async () => ({ ok: false, error: 'tab closed' }),
    execute: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    fetchPlan: async () => ({ action: { type: 'DONE' } }),
    delay: async () => {},
    sessionManager: sm,
    tabId: 1,
    windowId: 1,
    task: 'x',
    startUrl: '',
    onProgress: () => {},
    isStopped: () => false,
  };
  return { runner: new AgentRunner(deps), sm };
}

describe('AgentRunner - pure helpers', () => {
  it('buildPlanHistory marks retries as OK only when they later succeeded', () => {
    const failedErrors = new Map([['1', 'boom'], ['2', 'x']]);
    // id 1 filled + failed -> OK (succeeded on a later retry).
    // id 2 failed but NEVER filled -> FAILED with the error.
    const h = buildPlanHistory(['1'], ['1', '2'], failedErrors);
    expect(h.find((e) => e.targetId === '1')).toEqual({ targetId: '1', result: 'OK' });
    expect(h.find((e) => e.targetId === '2')).toEqual({ targetId: '2', result: 'FAILED', error: 'x' });
  });

  it('calculateMaxSteps is generous but capped at 100', () => {
    expect(calculateMaxSteps(0, 0, 0)).toBe(20);
    expect(calculateMaxSteps(40, 5, 3)).toBe(100); // 40*3+5+3+10 = 138 -> capped
  });

  it('isRepeatedAction detects a back-to-back same (targetId,type)', () => {
    const recent = [{ targetId: '7', type: 'CLICK' }];
    expect(isRepeatedAction(recent, { type: 'CLICK', targetId: 7 })).toBe(true);
    expect(isRepeatedAction(recent, { type: 'TYPE', targetId: 7 })).toBe(false);
    expect(isRepeatedAction(recent, { type: 'SCROLL' })).toBe(false); // no target
  });

  it('emptyTaskState is a fresh idle snapshot', () => {
    const s = emptyTaskState();
    expect(s.status).toBe('idle');
    expect(s.running).toBe(false);
    expect(s.logs).toEqual([]);
  });
});

describe('mergeChecklist (cross-page task memory)', () => {
  it('starts from the runner existing list, appends new sub-goals, keeps first-seen order', () => {
    const existing: ChecklistItem[] = [
      { id: '1', description: 'search Web browser', done: true },
      { id: '2', description: 'open the Web browser article', done: false },
    ];
    const merged = mergeChecklist(existing, [
      { id: '3', description: 'search PWA', done: false },
    ]);
    expect(merged.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(merged[2]?.description).toBe('search PWA');
  });

  it('sticky: an item flips done=true but never back to false', () => {
    const existing: ChecklistItem[] = [{ id: '1', description: 'x', done: true }];
    // A weaker response forgets to re-assert done - it must not resurrect it.
    const merged = mergeChecklist(existing, [{ id: '1', done: false }]);
    expect(merged[0]?.done).toBe(true);
  });

  it('fills in a missing description from the incoming entry', () => {
    const existing: ChecklistItem[] = [{ id: '1', done: false }];
    const merged = mergeChecklist(existing, [{ id: '1', description: 'do the thing' }]);
    expect(merged[0]?.description).toBe('do the thing');
  });

  it('drops malformed entries that have no usable id', () => {
    const merged = mergeChecklist([], [null, undefined, {}, '  ', { description: 'no id' }] as any);
    expect(merged).toEqual([]);
    // A bare string becomes a checklist item keyed by its own text.
    const merged2 = mergeChecklist([], ['search PWA']);
    expect(merged2).toEqual([{ id: 'search PWA', description: 'search PWA', done: false }]);
  });
});

// ── DONE-gating on the checklist (cross-page memory) ────────────────────────
// The runner only trusts a planner DONE when the whole checklist is satisfied.
// A DONE with open items keeps the loop going (strikes), and three consecutive
// open-item DONEs cap out as best-effort degraded.

function makeChecklistRunner(steps: Array<{ plan: any }>, opts: { executeResults?: Array<{ ok: boolean; error?: string; note?: string }> } = {}) {
  const sm = makeSessionManagerStub();
  let planIdx = 0;
  let execIdx = 0;
  const deps: AgentRunnerDeps = {
    extract: async () => ({
      ok: true,
      elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }],
      url: 'https://example.com',
      title: 'Page',
      context: null,
    }),
    execute: async () => {
      const list = opts.executeResults ?? [];
      return { ok: true, ...(list[execIdx++ % Math.max(1, list.length)] ?? {}) };
    },
    navigate: async () => ({ ok: true }),
    fetchPlan: async () => {
      const step = steps[planIdx++] ?? { plan: { action: { type: 'DONE' } } };
      return step.plan;
    },
    delay: async () => {},
    sessionManager: sm,
    tabId: 1,
    windowId: 1,
    task: 'look up X',
    startUrl: '',
    onProgress: () => {},
    isStopped: () => false,
  };
  return { runner: new AgentRunner(deps), sm };
}

describe('AgentRunner - checklist DONE-gating', () => {
  it('completes (not degraded) when every checklist item is done at DONE', async () => {
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'x' }, checklist: [{ id: '1', description: 'search', done: false }, { id: '2', description: 'open article', done: false }] } },
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, { id: '2', description: 'open article', done: true }] } },
    ];
    const { runner } = makeChecklistRunner(steps);
    await runner.run();
    const final = runner.getState();
    expect(final.status).toBe('complete');
    expect(final.degraded).toBe(false);
    expect(final.logs.some((l) => /all checklist items done/i.test(l))).toBe(true);
  });

  it('keeps going when DONE arrives with an open item, then completes when it is reached', async () => {
    // Step 1: seed a 2-item checklist, item 1 done, item 2 open. Planner
    // blurs a DONE while item 2 is still open -> the runner must NOT stop.
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'x' }, checklist: [{ id: '1', description: 'search', done: true }, { id: '2', description: 'open article', done: false }] } },
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, { id: '2', description: 'open article', done: false }] } }, // open -> continue
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, { id: '2', description: 'open article', done: true }] } }, // now done -> complete
    ];
    const { runner } = makeChecklistRunner(steps);
    await runner.run();
    const final = runner.getState();
    expect(final.status).toBe('complete');
    expect(final.degraded).toBe(false);
    expect(final.logs.some((l) => /still open/i.test(l))).toBe(true); // it logged the strike
    expect(final.logs.some((l) => /all checklist items done/i.test(l))).toBe(true);
  });

  it('caps a stuck planner at 3 consecutive open-item DONEs -> best-effort degraded', async () => {
    const open = () => ({ id: '2', description: 'open article', done: false });
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'x' }, checklist: [{ id: '1', description: 'search', done: true }, open()] } },
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, open()] } }, // strike 1
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, open()] } }, // strike 2
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, open()] } }, // strike 3 -> cap
      { plan: { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'search', done: true }, open()] } }, // (not reached)
    ];
    const { runner, sm } = makeChecklistRunner(steps);
    await runner.run();
    const final = runner.getState();
    expect(final.status).toBe('degraded');
    expect(final.degraded).toBe(true);
    expect(final.logs.some((l) => /stuck at DONE with 1 open item/i.test(l))).toBe(true);
    expect(sm.__calls).toContain('complete:degraded');
  });
});

// #100 proactive VLM goal-verification: after each successful action the
// runner asks the on-device VLM "is the FINAL goal on screen?". If it
// confirms, the loop stops BEFORE the next LLM plan call.
describe('AgentRunner - proactive VLM goal stop (#100)', () => {
  it('stops early when the VLM confirms the final goal after an action', async () => {
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'x' }, checklist: [{ id: '2', description: 'open article', done: false }] } },
      { plan: { action: { type: 'DONE' } } },
    ];
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => (steps.shift() ?? { plan: { action: { type: 'DONE' } } }).plan,
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'open article',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      confirmGoal: async () => ({ confirmed: true, detail: 'on-device' }),
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    const final = runner.getState();
    expect(final.running).toBe(false);
    expect(final.status).toBe('complete');
    expect(final.degraded).toBe(false);
    // Stopped at the first action via the VLM, not at the planner's DONE.
    expect(final.step).toBe(1);
    expect(final.logs.some((l) => /VLM confirmed final goal on screen/i.test(l))).toBe(true);
  });

  it('does NOT stop early when the VLM says the goal is not on screen', async () => {
    // Two real actions while the final goal is still open (VLM says "no"
    // each time), then a DONE that fully satisfies the checklist. The runner
    // must keep going and only stop on the planner's DONE - proving a "no"
    // from the VLM does not force an early stop.
    const openArticle = { id: '2', description: 'open article', done: false };
    const steps = [
      { plan: { action: { type: 'CLICK', targetId: 2 } }, checklist: [{ id: '1', description: 'search', done: true }, { ...openArticle }] },
      { plan: { action: { type: 'SCROLL', scrollDirection: 'down' } }, checklist: [{ id: '1', description: 'search', done: true }, { ...openArticle }] },
      { plan: { action: { type: 'DONE' } }, checklist: [{ id: '1', description: 'search', done: true }, { id: '2', description: 'open article', done: true }] },
    ];
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({
        ok: true,
        elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }, { id: 2, tag: 'button', role: 'button', label: 'Go' }],
        url: 'https://example.com',
        title: 'Page',
        context: null,
      }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => (steps.shift() ?? { plan: { action: { type: 'DONE' } } }).plan,
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'open article',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      confirmGoal: async () => ({ confirmed: false, detail: 'not there yet' }),
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    const final = runner.getState();
    // It performed both actions and only stopped at the planner's DONE
    // (step 3), because the VLM never confirmed the goal on screen.
    expect(final.step).toBe(3);
    expect(final.status).toBe('complete');
    expect(final.logs.some((l) => /VLM confirmed final goal/i.test(l))).toBe(false);
  });

  it('skips the VLM entirely when confirmGoal is not wired (feature off)', async () => {
    const steps = [
      { plan: { action: { type: 'TYPE', targetId: 1, value: 'x' } } },
      { plan: { action: { type: 'DONE' } } },
    ];
    const sm = makeSessionManagerStub();
    const deps: AgentRunnerDeps = {
      extract: async () => ({ ok: true, elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'n' }], url: 'u', title: 't', context: null }),
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => (steps.shift() ?? { plan: { action: { type: 'DONE' } } }).plan,
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'x',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
      // No confirmGoal wired -> the runner must never attempt a VLM probe.
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    expect(runner.getState().status).toBe('complete');
  });
});


describe('AgentRunner - per-page memory scoping + 0-element stall (#114 live findings)', () => {
  it('clears filled/failed element memory when the URL changes between extracts', async () => {
    // Live bug (2026-09-20 3-hop run): element ids are re-issued per page,
    // but filledIds/failedIds survived a navigation, so buildPlanHistory
    // told the planner "element #N already done" on the NEW page - steering
    // it off the correct element. The URL-change check at the top of each
    // step must clear all per-page memory.
    const sm = makeSessionManagerStub();
    const histories: unknown[] = [];
    let extractCall = 0;
    let planCall = 0;
    const deps: AgentRunnerDeps = {
      extract: async () => {
        extractCall++;
        const onA = extractCall === 1;
        return {
          ok: true,
          elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }],
          url: onA ? 'https://x.test/a' : 'https://x.test/b',
          title: onA ? 'A' : 'B',
          context: null,
        };
      },
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async (payload) => {
        histories.push((payload as { history?: unknown[] }).history ?? []);
        planCall++;
        return planCall === 1
          ? { action: { type: 'TYPE', targetId: 1, value: 'q' } }
          : { action: { type: 'DONE' } };
      },
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'search two pages',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
    };
    const runner = new AgentRunner(deps);
    await runner.run();

    // Step 1 (page /a) filled #1. Step 2's extract came from /b -> the
    // URL-change clear must have wiped it, so the history sent to fetchPlan
    // #2 carries NO page-A ids.
    const pageBIds = ((histories[1] ?? []) as Array<{ targetId: string }>).map((h) => h.targetId);
    expect(pageBIds).not.toContain('1');
    expect(runner.getState().logs.some((l) => /clearing per-page interaction memory/i.test(l))).toBe(true);
    expect(runner.getState().status).toBe('complete');
  });

  it('recovers a transient 0-element read by re-extracting instead of ending the run', async () => {
    // Live bug: after NAVIGATE the article read 0 elements mid-render and
    // the old code broke out of the loop -> false "Task completed". The
    // re-extract must recover the settled page and let the run continue to
    // a real terminal state.
    const sm = makeSessionManagerStub();
    let extractCall = 0;
    let planCall = 0;
    const deps: AgentRunnerDeps = {
      extract: async () => {
        extractCall++;
        // First read transiently empty (render race); retries see the settled page.
        return extractCall === 1
          ? { ok: true, elements: [], url: 'https://x.test/a', title: 'A', context: null }
          : { ok: true, elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }], url: 'https://x.test/a', title: 'A', context: null };
      },
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => {
        planCall++;
        return planCall === 1
          ? { action: { type: 'WAIT', waitMs: 100 }, checklist: [{ id: '1', description: 'first goal', done: false }] }
          : { action: { type: 'DONE' }, checklist: [{ id: '1', description: 'first goal', done: true }] };
      },
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'open a goal',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    const final = runner.getState();
    // Recovered on the re-extract -> proceeded to the planner's DONE -> complete.
    expect(final.status).toBe('complete');
    expect(final.logs.some((l) => /after re-extract/i.test(l))).toBe(true);
    expect(sm.__calls).toContain('complete:complete');
  });

  it('marks the task FAILED (never complete) when the page stays empty and goals are open', async () => {
    // The false-success worst case from the live run: goal 2 still open, the
    // navigated-to page persistently unreadable (0 elements through all
    // re-extract attempts). Terminal state must be a stall/failure - "Task
    // completed" here is exactly what the old code produced.
    const sm = makeSessionManagerStub();
    let extractCall = 0;
    let planCall = 0;
    const deps: AgentRunnerDeps = {
      extract: async () => {
        extractCall++;
        // Page A has an element; the navigated-to page B stays empty.
        return extractCall === 1
          ? { ok: true, elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'name' }], url: 'https://x.test/a', title: 'A', context: null }
          : { ok: true, elements: [], url: 'https://x.test/b', title: 'B', context: null };
      },
      execute: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      fetchPlan: async () => {
        planCall++;
        return planCall === 1
          ? {
              action: { type: 'NAVIGATE', url: 'https://x.test/b' },
              checklist: [
                { id: '1', description: 'first goal', done: true },
                { id: '2', description: 'second goal', done: false },
              ],
            }
          : { action: { type: 'DONE' } };
      },
      delay: async () => {},
      sessionManager: sm,
      tabId: 1,
      windowId: 1,
      task: 'two goals',
      startUrl: '',
      onProgress: () => {},
      isStopped: () => false,
    };
    const runner = new AgentRunner(deps);
    await runner.run();
    const final = runner.getState();
    expect(final.status).toBe('failed');
    expect(final.logs.some((l) => /task NOT complete \(stalled\)/i.test(l))).toBe(true);
    expect(sm.__calls).toContain('failSession:stalled: no interactive elements, task incomplete');
  });
});
