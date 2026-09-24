import { describe, it, expect, vi } from 'vitest';
import {
  emptyHandoff,
  harvestToHandoff,
  mergeHandoff,
  handoffForPlanner,
  resolveHandoffValue,
  isHandoffToken,
  fieldToken,
  MAX_HANDOFF_FIELDS,
  type TabHandoff,
} from '../src/lib/tabHandoff';
import { AgentRunner, type AgentRunnerDeps } from '../src/lib/agentRunner';

// ─── tabHandoff: the pure PII-safe core ────────────────────────────────────
describe('#141 tabHandoff core', () => {
  it('fieldToken is 1-based and isHandoffToken is strict', () => {
    expect(fieldToken(0)).toBe('<FIELD_1>');
    expect(fieldToken(4)).toBe('<FIELD_5>');
    expect(isHandoffToken('<FIELD_1>')).toBe(true);
    expect(isHandoffToken(' <FIELD_3> ')).toBe(true); // trims
    expect(isHandoffToken('<FIELD_>')).toBe(false);
    expect(isHandoffToken('<FIELD_1> ')).toBe(true); // trailing ws is trimmed
    expect(isHandoffToken('<FIELD_1>x')).toBe(false); // embedded junk
    expect(isHandoffToken('<FIELD_1_1>')).toBe(false);
    expect(isHandoffToken('$tok_x9f3')).toBe(false);
    expect(isHandoffToken(undefined)).toBe(false);
    expect(isHandoffToken(null)).toBe(false);
  });

  it('harvestToHandoff dedupes by value, skips empty, keeps order + labels', () => {
    const h = harvestToHandoff(
      [
        { label: 'Name', value: 'Acme Ltd' },
        { label: 'Name (2)', value: 'Acme Ltd' }, // duplicate value -> same token
        { label: '', value: '   ' }, // empty -> skipped
        { label: 'City', value: 'Pune' },
      ],
      'https://source.example/form',
    );
    expect(Object.keys(h.values)).toEqual(['<FIELD_1>', '<FIELD_2>']);
    expect(h.values['<FIELD_1>']).toBe('Acme Ltd');
    expect(h.values['<FIELD_2>']).toBe('Pune');
    expect(h.labels['<FIELD_1>']).toBe('Name'); // first label wins
    expect(h.labels['<FIELD_2>']).toBe('City');
    expect(h.sourceUrl).toBe('https://source.example/form');
    expect(h.extractedAt).toBeGreaterThan(0);
  });

  it('harvestToHandoff caps at MAX_HANDOFF_FIELDS', () => {
    const fields = Array.from({ length: MAX_HANDOFF_FIELDS + 10 }, (_, i) => ({
      label: `f${i}`,
      value: `v${i}`,
    }));
    const h = harvestToHandoff(fields, 'x');
    expect(Object.keys(h.values).length).toBe(MAX_HANDOFF_FIELDS);
  });

  it('handoffForPlanner returns token+label ONLY (never values)', () => {
    const h = harvestToHandoff([{ label: 'Phone', value: '+91-9876543210' }], 'https://s.example');
    const plannerView = handoffForPlanner(h);
    expect(plannerView).toEqual([{ token: '<FIELD_1>', label: 'Phone' }]);
    expect(JSON.stringify(plannerView)).not.toContain('9876543210'); // PII firewall
  });

  it('handoffForPlanner is undefined for an empty/absent handoff (zero single-tab change)', () => {
    expect(handoffForPlanner(emptyHandoff())).toBeUndefined();
    expect(handoffForPlanner(null)).toBeUndefined();
    expect(handoffForPlanner(undefined)).toBeUndefined();
  });

  it('resolveHandoffValue maps a known token to its value; unknowns pass through', () => {
    const h = harvestToHandoff(
      [{ label: 'City', value: 'Pune' }, { label: 'Zip', value: '411001' }],
      's',
    );
    expect(resolveHandoffValue('<FIELD_1>', h)).toBe('Pune');
    expect(resolveHandoffValue('<FIELD_2>', h)).toBe('411001');
    expect(resolveHandoffValue('<FIELD_9>', h)).toBeUndefined(); // hallucinated
    expect(resolveHandoffValue('plain text', h)).toBeUndefined(); // not a token
    expect(resolveHandoffValue(undefined, h)).toBeUndefined();
    expect(resolveHandoffValue('<FIELD_1>', null)).toBeUndefined();
  });

  it('mergeHandoff keeps BOTH source tabs values (multi-source task)', () => {
    const a = harvestToHandoff(
      [{ label: 'Name', value: 'Acme Ltd' }],
      'https://tabA.example',
    );
    const b = harvestToHandoff(
      [{ label: 'City', value: 'Pune' }],
      'https://tabB.example',
    );
    const m = mergeHandoff(a, b);
    expect(m.values).toEqual({ '<FIELD_1>': 'Acme Ltd', '<FIELD_2>': 'Pune' });
    expect(m.labels['<FIELD_1>']).toBe('Name');
    expect(m.labels['<FIELD_2>']).toBe('City');
    expect(m.sourceUrl).toContain('→');
    // Both tokens resolvable after the merge.
    expect(resolveHandoffValue('<FIELD_1>', m)).toBe('Acme Ltd');
    expect(resolveHandoffValue('<FIELD_2>', m)).toBe('Pune');
  });

  it('mergeHandoff dedupes globally by value across the two sources', () => {
    const a = harvestToHandoff([{ label: 'A', value: 'Acme' }], 'a');
    const b = harvestToHandoff([{ label: 'B', value: 'Acme' }], 'b');
    const m = mergeHandoff(a, b);
    expect(Object.values(m.values)).toEqual(['Acme']); // one token, not two
  });

  it('mergeHandoff keeps the base when the incoming harvest is empty', () => {
    const a = harvestToHandoff([{ label: 'A', value: 'Acme' }], 'a');
    const m = mergeHandoff(a, emptyHandoff());
    expect(m).toBe(a); // same reference, unchanged
  });
});

// ─── AgentRunner: SWITCH_TAB execution + token resolution + /plan payload ───
function smStub() {
  const sm: any = {
    startSession: async () => 's',
    getSessionForTab: () => undefined,
    updateSession: async () => {},
    recordAction: () => {},
    recordFailedElement: () => {},
    getActiveSession: () => undefined,
    getContext: () => null,
    isTaskViable: () => true,
    failSession: () => {},
    completeSession: () => {},
    viable: () => true,
    remainingBudget: () => 100,
  };
  return sm;
}

type PlanStep = { plan: { action: any }; executeResults?: Array<Record<string, any>> };

function makeRunner(
  steps: PlanStep[],
  opts: { openTabs?: () => Promise<any[]>; handoff?: () => TabHandoff | null } = {},
) {
  const executed: Array<Record<string, any>> = [];
  const planPayloads: Array<Record<string, any>> = [];
  let execIndex = 0; // position WITHIN the current step's executeResults list
  let planIndex = 0;
  const deps = {
    extract: async () => ({
      ok: true,
      elements: [{ id: 1, tag: 'input', role: 'textbox', label: 'x' }],
      url: 'https://example.com',
      title: 'T',
      context: null,
    }),
    execute: async (a: any) => {
      executed.push(a);
      // Global cursor over the first step that carries executeResults. A step
      // reports ok:false by putting { ok:false } in its list; the run stops
      // after that call so the cursor never advances past it.
      const list = steps.find((s) => s.executeResults)?.executeResults ?? [];
      const result = list[execIndex++ % list.length] ?? {};
      return { ok: true, ...result };
    },
    navigate: async () => ({ ok: true }),
    fetchPlan: async (payload: any) => {
      planPayloads.push(payload ?? {});
      const step = steps[planIndex++] ?? { plan: { action: { type: 'DONE' } } };
      return step.plan;
    },
    delay: async () => {},
    sessionManager: smStub(),
    tabId: -1,
    windowId: 1,
    task: 'multi-tab task',
    startUrl: '',
    onProgress: () => {},
    isStopped: () => false,
    ...(opts.openTabs ? { openTabs: opts.openTabs } : {}),
    ...(opts.handoff ? { crossTabMemory: opts.handoff } : {}),
  };
  const runner = new AgentRunner(deps as unknown as AgentRunnerDeps);
  return { runner, executed, planPayloads };
}

describe('#141 AgentRunner SWITCH_TAB', () => {
  it('sends the SWITCH_TAB hop through the execute channel (tabId + urlHint)', async () => {
    const { runner, executed } = makeRunner([
      { plan: { action: { type: 'SWITCH_TAB', tabId: 12, urlHint: 'sheets' } }, executeResults: [{ ok: true }] },
      { plan: { action: { type: 'DONE' } } },
    ]);
    await runner.run();
    expect(executed[0]).toEqual({ type: 'SWITCH_TAB', tabId: 12, urlHint: 'sheets' });
  });

  it('a failed hop (channel ok:false) stops the run before any DONE', async () => {
    const { runner, executed } = makeRunner([
      {
        plan: { action: { type: 'SWITCH_TAB', tabId: 99 } },
        executeResults: [{ ok: false, error: 'tab closed' }],
      },
      { plan: { action: { type: 'DONE' } } },
    ]);
    await runner.run();
    expect(executed.some((a) => a.type === 'SWITCH_TAB')).toBe(true);
    expect(executed.filter((a) => a.type === 'DONE').length).toBe(0);
  });

  it('resolves a cross-tab token in a TYPE value on-device before the channel sees it', async () => {
    const handoff = harvestToHandoff([{ label: 'City', value: 'Pune' }], 'https://src.example');
    const { runner, executed } = makeRunner(
      [
        { plan: { action: { type: 'TYPE', targetId: 1, value: '<FIELD_1>' } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      { handoff: () => handoff },
    );
    await runner.run();
    const type = executed.find((a) => a.type === 'TYPE');
    expect(type).toBeDefined();
    expect(type?.value).toBe('Pune'); // resolved value reached the executor
    expect(JSON.stringify(type)).not.toContain('<FIELD_1>');
  });

  it('a hallucinated (unknown) token is typed literally - it already had that text', async () => {
    const handoff = harvestToHandoff([{ label: 'City', value: 'Pune' }], 'https://src.example');
    const { runner, executed } = makeRunner(
      [
        { plan: { action: { type: 'TYPE', targetId: 1, value: '<FIELD_42>' } }, executeResults: [{ ok: true }] },
        { plan: { action: { type: 'DONE' } } },
      ],
      { handoff: () => handoff },
    );
    await runner.run();
    expect(executed.find((a) => a.type === 'TYPE')?.value).toBe('<FIELD_42>');
  });

  it('sends openTabs + crossTabMemory (token+label only) in the /plan payload', async () => {
    const openTabs = async () => [{ tabId: 12, url: 'https://sheets.example/f', title: 'Sheet' }];
    const handoff = () => harvestToHandoff([{ label: 'City', value: 'Pune' }], 'https://src.example');
    const { runner, planPayloads } = makeRunner([{ plan: { action: { type: 'DONE' } } }], {
      openTabs,
      handoff,
    });
    await runner.run();
    expect(planPayloads.length).toBeGreaterThanOrEqual(1);
    const p = planPayloads[0];
    expect(p.openTabs?.[0]?.tabId).toBe(12);
    expect(p.crossTabMemory).toEqual([{ token: '<FIELD_1>', label: 'City' }]);
    expect(JSON.stringify(p.crossTabMemory)).not.toContain('Pune'); // no raw value
    expect(JSON.stringify(p.openTabs)).not.toContain('Pune');
  });

  it('omits the cross-tab keys entirely when the task is single-tab (zero-change)', async () => {
    const { runner, planPayloads } = makeRunner([{ plan: { action: { type: 'DONE' } } }]);
    await runner.run();
    const p = planPayloads[0];
    expect('openTabs' in p).toBe(false);
    expect('crossTabMemory' in p).toBe(false);
  });
});
