import { describe, it, expect } from 'vitest';
import {
  emptyHandoff,
  harvestToHandoff,
  rePerceiveHandoff,
  refreshHandoffInPlace,
  rePerceptionChanged,
  labelKey,
  resolveHandoffValue,
  type TabHandoff,
  type HarvestedField,
} from '../src/lib/tabHandoff';
import {
  TabOrchestrator,
  watchTickFires,
  clampWatchTrigger,
  hostOfUrl,
  MIN_WATCH_POLL_MS,
  MAX_WATCHED_TABS,
  type TaskGraph,
  type SubTask,
  type TabRef,
  type TabOrchestratorDeps,
} from '../src/lib/tabOrchestrator';

const src = { tabId: 1, windowId: 9, role: 'source' as const };
const sink = { tabId: 2, windowId: 9, role: 'sink' as const };
const outbound = { tabId: 3, windowId: 9, role: 'outbound' as const };

function handoffWith(pairs: Array<[string, string]>): TabHandoff {
  return harvestToHandoff(pairs.map(([label, value]) => ({ label, value })), 'https://src.example/a');
}

// ─── rePerceiveHandoff: label-keyed value refresh ───────────────────────────

describe('#144 rePerceiveHandoff — passive re-perception', () => {
  it('a changed value under a stable label updates the existing token (no new token)', () => {
    const base = handoffWith([['Name', 'Acme'], ['Region', 'North']]);
    // The user edited the compliance "Name" field while the agent works elsewhere.
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: 'Acme Corp' }, { label: 'Region', value: 'North' }], 'https://src.example/a');
    expect(fresh.values['<FIELD_1>']).toBe('Acme Corp');
    expect(fresh.values['<FIELD_2>']).toBe('North');
    expect(Object.keys(fresh.values)).toHaveLength(2); // no new token minted
  });

  it('a new label mints the next token, continuing numbering', () => {
    const base = handoffWith([['Name', 'Acme']]);
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: 'Acme' }, { label: 'Zone', value: 'Z9' }], 'u');
    expect(fresh.values['<FIELD_1>']).toBe('Acme');
    expect(fresh.values['<FIELD_2>']).toBe('Z9');
    expect(fresh.labels['<FIELD_2>']).toBe('Zone');
  });

  it('a label no longer on the page keeps its token (sink may still reference it)', () => {
    const base = handoffWith([['Name', 'Acme'], ['Region', 'North']]);
    // Re-perception now only sees "Name" — "Region" must survive.
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: 'Acme' }], 'u');
    expect(fresh.values['<FIELD_2>']).toBe('North');
  });

  it('empty-value fields are skipped', () => {
    const base = handoffWith([['Name', 'Acme']]);
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: '' }, { label: '', value: 'x' }], 'u');
    // ''-label field with a value mints a new token; the empty "Name" value is a no-op.
    expect(fresh.values['<FIELD_1>']).toBe('Acme');
    expect(fresh.values['<FIELD_2>']).toBe('x');
  });

  it('a no-op re-perception is detectable (extractedAt unchanged)', () => {
    const base = handoffWith([['Name', 'Acme']]);
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: 'Acme' }], 'u');
    expect(rePerceptionChanged(base, fresh)).toBe(false);
    expect(fresh.extractedAt).toBe(base.extractedAt);
  });

  it('a real change is detected by rePerceptionChanged', () => {
    const base = handoffWith([['Name', 'Acme']]);
    const fresh = rePerceiveHandoff(base, [{ label: 'Name', value: 'New' }], 'u');
    expect(rePerceptionChanged(base, fresh)).toBe(true);
    expect(fresh.extractedAt).toBeGreaterThanOrEqual(base.extractedAt);
  });

  it('label matching is case-insensitive', () => {
    expect(labelKey('  Name ')).toBe('name');
    const base = handoffWith([['Name', 'Acme']]);
    const fresh = rePerceiveHandoff(base, [{ label: 'name', value: 'Changed' }], 'u');
    expect(fresh.values['<FIELD_1>']).toBe('Changed');
    expect(Object.keys(fresh.values)).toHaveLength(1);
  });
});

// ─── refreshHandoffInPlace: identity-stable live refresh ─────────────────────

describe('#144 refreshHandoffInPlace — live in-flight subtask sees updates', () => {
  it('mutates the shared object in place; a live reference sees the new value', () => {
    const base = handoffWith([['Name', 'Acme']]);
    const shared = base; // the reference an in-flight subtask holds
    const fresh = rePerceiveHandoff(shared, [{ label: 'Name', value: 'Fresh' }], 'u');
    refreshHandoffInPlace(shared, fresh);
    // The SAME object the subtask holds now resolves the token to the new value.
    expect(shared).toBe(base); // identity preserved
    expect(resolveHandoffValue('<FIELD_1>', shared)).toBe('Fresh');
  });
});

// ─── Watch trigger policy ────────────────────────────────────────────────────

describe('#144 watchTickFires — trigger policy', () => {
  it('urlChange trigger: a moved url fires, an unchanged url does not', () => {
    expect(watchTickFires({ urlChange: true }, { url: 'a' }, { url: 'b' })).toBe(true);
    expect(watchTickFires({ urlChange: true }, { url: 'a' }, { url: 'a' })).toBe(false);
  });

  it('pollMs trigger: a moved title fires, an unchanged title does not', () => {
    expect(watchTickFires({ pollMs: 30000 }, { title: 'x' }, { title: 'y' })).toBe(true);
    expect(watchTickFires({ pollMs: 30000 }, { title: 'x' }, { title: 'x' })).toBe(false);
  });

  it('no trigger set: never fires', () => {
    expect(watchTickFires({}, { url: 'a', title: 'x' }, { url: 'b', title: 'y' })).toBe(false);
  });

  it('clampWatchTrigger raises pollMs to the 15s floor', () => {
    expect(clampWatchTrigger({ pollMs: 1000 }).pollMs).toBe(MIN_WATCH_POLL_MS);
    expect(clampWatchTrigger({ pollMs: 60000 }).pollMs).toBe(60000);
    expect(clampWatchTrigger({ urlChange: true }).urlChange).toBe(true);
    expect(clampWatchTrigger({ urlChange: true, pollMs: 500 }).pollMs).toBe(MIN_WATCH_POLL_MS);
  });

  it('hostOfUrl extracts a lower-cased host; unparseable urls yield ""', () => {
    expect(hostOfUrl('https://WEB.WhatsApp.COM/chat/1')).toBe('web.whatsapp.com');
    expect(hostOfUrl('http://a.example:8080/x')).toBe('a.example');
    expect(hostOfUrl('chrome://extensions/')).toBe('extensions'); // WHATWG: non-special host part
    expect(hostOfUrl('')).toBe('');
    expect(hostOfUrl('not a url at all')).toBe('');
  });
});

// ─── TabOrchestrator: serial subtasks + passive watchers ─────────────────────

function makeDeps(overrides: Partial<TabOrchestratorDeps> = {}): {
  deps: TabOrchestratorDeps;
  calls: { order: string[]; switched: TabRef[]; watched: TabRef[]; disposed: number; runs: string[] };
} {
  const calls = { order: [] as string[], switched: [] as TabRef[], watched: [] as TabRef[], disposed: 0, runs: [] as string[] };
  let watchSeq = 0;
  const deps: TabOrchestratorDeps = {
    runSubTask: async (sub, _shared) => {
      calls.runs.push(sub.id);
      calls.order.push(sub.id);
      return { ok: true, produced: sub.exit.produced ?? [] };
    },
    switchTo: async (tab) => { calls.switched.push(tab); },
    perceiveSource: async () => null,
    watch: (tab, _trigger, _onFields) => {
      calls.watched.push(tab);
      const handle = { dispose: () => { calls.disposed += 1; } };
      watchSeq += 1;
      return handle;
    },
    ...overrides,
  };
  return { deps, calls };
}

function graphOf(subs: SubTask[], handoff: TabHandoff = emptyHandoff()): TaskGraph {
  return { id: 'g', subtasks: subs, order: subs.map((s) => s.id), handoff, outboundGates: [] };
}

describe('#144 TabOrchestrator — serial run + passive watch', () => {
  it('runs subtasks in order, switching focus tab between them, and disposes watchers after', async () => {
    const base = handoffWith([['Name', 'Acme']]);
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'read', entry: { need: [] }, exit: { produced: ['<FIELD_1>'] }, trigger: { urlChange: true, pollMs: 30000 } },
      { id: 'B', tab: sink, description: 'fill', entry: { need: ['<FIELD_1>'] }, exit: {} },
      { id: 'C', tab: outbound, description: 'send', entry: { need: [] }, exit: { terminal: 'sent' } },
    ];
    const g = graphOf(subs, base);
    const { deps, calls } = makeDeps();
    const orch = new TabOrchestrator(deps);
    const rep = await orch.run(g);
    expect(rep.ok).toBe(true);
    expect(calls.order).toEqual(['A', 'B', 'C']);
    expect(calls.switched.map((t) => t.tabId)).toEqual([1, 2, 3]);
    expect(calls.disposed).toBe(1); // the one source watcher disposed after
  });

  it('aborts when an entry token is missing, reporting notReady + stopping downstream', async () => {
    const base = emptyHandoff(); // nothing harvested
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'read', entry: { need: [] }, exit: {} },
      { id: 'B', tab: sink, description: 'fill', entry: { need: ['<FIELD_9>'] }, exit: {} }, // token never produced
    ];
    const { deps, calls } = makeDeps();
    const rep = await new TabOrchestrator(deps).run(graphOf(subs, base));
    expect(rep.ok).toBe(false);
    expect(rep.abortedAt).toBe('B');
    expect(calls.order).toEqual(['A']); // B's runSubTask never called
    const bRep = rep.reports.find((r) => r.id === 'B');
    expect(bRep?.notReady).toEqual(['<FIELD_9>']);
  });

  it('a failed subtask aborts the graph', async () => {
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'x', entry: { need: [] }, exit: {} },
      { id: 'B', tab: sink, description: 'y', entry: { need: [] }, exit: {} },
    ];
    const { deps } = makeDeps({
      runSubTask: async (sub) => (sub.id === 'A' ? { ok: false, produced: [], error: 'boom' } : { ok: true, produced: [] }),
    });
    const rep = await new TabOrchestrator(deps).run(graphOf(subs));
    expect(rep.ok).toBe(false);
    expect(rep.abortedAt).toBe('A');
  });

  it('a stop signal aborts before the next subtask', async () => {
    let stopped = false;
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'x', entry: { need: [] }, exit: {} },
      { id: 'B', tab: sink, description: 'y', entry: { need: [] }, exit: {} },
    ];
    const { deps } = makeDeps({
      isStopped: () => stopped,
      runSubTask: async () => { stopped = true; return { ok: true, produced: [] }; },
    });
    const rep = await new TabOrchestrator(deps).run(graphOf(subs));
    expect(rep.ok).toBe(false);
    expect(rep.abortedAt).toBe('B'); // stop took effect before B ran
  });

  it('WATCHER: a source change mid-subtask refreshes the shared handoff; the running subtask sees the new value', async () => {
    const base = handoffWith([['Name', 'Acme']]);
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'read', entry: { need: [] }, exit: { produced: ['<FIELD_1>'] }, trigger: { urlChange: true, pollMs: 30000 } },
      { id: 'B', tab: sink, description: 'fill from <FIELD_1>', entry: { need: ['<FIELD_1>'] }, exit: {} },
    ];
    const g = graphOf(subs, base);
    // The watcher's onFields callback fires DURING subtask B's run (simulated
    // source change), re-perceiving into the shared handoff in place.
    let watchCallback: ((fields: HarvestedField[], url: string) => void) | null = null;
    let observedValue: string | undefined;
    const { deps } = makeDeps({
      watch: (_tab, _t, onFields) => { watchCallback = onFields; return { dispose: () => {} }; },
      runSubTask: async (sub, shared) => {
        if (sub.id === 'B') {
          // While B is running, the source tab changed "Acme" -> "Acme LLC".
          watchCallback?.([{ label: 'Name', value: 'Acme LLC' }], 'https://src.example/a');
          // B's next write resolves the token against the (now refreshed) shared handoff.
          observedValue = resolveHandoffValue('<FIELD_1>', shared.handoff);
        }
        return { ok: true, produced: [] };
      },
    });
    const rep = await new TabOrchestrator(deps).run(g);
    expect(rep.ok).toBe(true);
    expect(observedValue).toBe('Acme LLC'); // the updated value, not the stale 'Acme'
    expect(g.handoff.values['<FIELD_1>']).toBe('Acme LLC'); // shared handoff refreshed
  });

  it('rePerceive() updates the shared handoff in place when a source tab is reachable', async () => {
    const base = handoffWith([['Name', 'Acme']]);
    const g = graphOf([{ id: 'A', tab: src, description: 'r', entry: { need: [] }, exit: { produced: ['<FIELD_1>'] } }], base);
    const { deps } = makeDeps({
      perceiveSource: async () => ({ fields: [{ label: 'Name', value: 'Fresh' }], url: 'https://src.example/a' }),
    });
    const orch = new TabOrchestrator(deps);
    await orch.rePerceive(g, src);
    expect(g.handoff).toBe(base); // identity stable
    expect(g.handoff.values['<FIELD_1>']).toBe('Fresh');
  });

  it('rePerceive() is a no-op when the source tab is unreachable (null)', async () => {
    const base = handoffWith([['Name', 'Acme']]);
    const g = graphOf([{ id: 'A', tab: src, description: 'r', entry: { need: [] }, exit: {} }], base);
    const { deps } = makeDeps({ perceiveSource: async () => null });
    await new TabOrchestrator(deps).rePerceive(g, src);
    expect(g.handoff.values['<FIELD_1>']).toBe('Acme'); // unchanged
  });

  it('caps watchers at MAX_WATCHED_TABS', async () => {
    const many = [0, 1, 2, 3, 4].map((i) => ({
      id: `S${i}`,
      tab: { tabId: i, windowId: 9, role: 'source' as const },
      description: 'src',
      entry: { need: [] },
      exit: {},
      trigger: { urlChange: true },
    }));
    const { deps, calls } = makeDeps();
    await new TabOrchestrator(deps).run(graphOf(many));
    expect(calls.watched).toHaveLength(MAX_WATCHED_TABS); // 3, not 5
  });

  it('a source subtask re-perceives its own tab at entry (fresh at subtask boundaries)', async () => {
    const base = handoffWith([['Name', 'Acme']]);
    const subs: SubTask[] = [
      { id: 'A', tab: src, description: 'read', entry: { need: [] }, exit: { produced: ['<FIELD_1>'] } },
      { id: 'B', tab: src, description: 're-read', entry: { need: [] }, exit: {} }, // same source tab, 2nd visit
    ];
    let perceived = 0;
    const { deps } = makeDeps({
      perceiveSource: async () => { perceived += 1; return { fields: [{ label: 'Name', value: 'V2' }], url: 'u' }; },
    });
    const g = graphOf(subs, base);
    await new TabOrchestrator(deps).run(g);
    expect(perceived).toBe(2); // each source subtask re-perceives at entry
    expect(g.handoff.values['<FIELD_1>']).toBe('V2');
  });
});
