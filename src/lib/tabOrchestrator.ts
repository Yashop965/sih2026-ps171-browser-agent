/**
 * Cross-tab orchestrator — issue #144 (P3 passive "watch" re-perception).
 *
 * P1 lets the agent HOP between tabs in order. P3 adds WATCHING: while
 * sub-task N runs on its tab, the source tabs are watched passively —
 * a trigger (url/status change, or a bounded title poll) re-perceives the
 * tab (DOM harvest only: no cursor, no click, no scroll, no LLM) and
 * refreshes the shared handoff IN PLACE, so the sub-task that's running
 * right now picks up the updated value on its next token write.
 *
 * Design: docs/CROSS-TAB-ORCHESTRATOR-DESIGN.md §2 Tier 2 / §3.
 *
 * Invariants (all unit-tested in tests/passive-watch-144.test.ts):
 * - ONE focus tab at a time: switchTo is awaited, subtasks run strictly
 *   in `graph.order`.
 * - The LLM loop is SERIAL: one planner at a time (per-subtask runner);
 *   watchers never drive a second planner.
 * - Watchers are READ-ONLY on the DOM; a watched tab is never scrolled,
 *   clicked or typed into, so "watching" can't corrupt the page the user
 *   is reading.
 * - The shared handoff object's identity is stable for the whole graph;
 *   re-perceptions copy values into it in place (refreshHandoffInPlace),
 *   so any in-flight subtask reading the same reference sees fresh
 *   values without re-seeding.
 * - Values stay on-device: re-perception is a SW-local harvest + merge.
 *   The planner only ever sees token+label (handoffForPlanner), never the
 *   value — the P1 firewall rule, unchanged.
 */
import type { HarvestedField, TabHandoff } from './tabHandoff';
import { refreshHandoffInPlace, rePerceiveHandoff } from './tabHandoff';

export interface TabRef {
  tabId: number;
  windowId: number;
  role: 'source' | 'sink' | 'outbound' | 'scratch';
  urlHint?: string;
}

/** Watcher config for a source tab (design §3 `trigger`). */
export interface WatchTrigger {
  /** Re-perceive when the tab's url changes (or it reloads). */
  urlChange?: boolean;
  /** Bounded title poll (ms). Absent => no poll, event-trigger only. */
  pollMs?: number;
}

export interface SubTask {
  id: string;
  tab: TabRef;
  /** Planner task text for this subtask. */
  description: string;
  /** Handoff tokens that must be present (current) before the subtask runs. */
  entry: { need: string[] };
  /** Tokens produced / terminal goal phrase (for the terminal gate). */
  exit: { produced?: string[]; terminal?: string };
  /** Watcher config — set on SOURCE tabs to watch them while others run. */
  trigger?: WatchTrigger;
}

export interface TaskGraph {
  id: string;
  subtasks: SubTask[];
  /** Topological order (entry dependencies). */
  order: string[];
  /** Shared, token-keyed handoff — mutated in place by re-perceptions. */
  handoff: TabHandoff;
  /** Subtask ids that pause for the P2 outbound-send confirmation gate. */
  outboundGates: string[];
}

export interface SubTaskReport {
  id: string;
  ok: boolean;
  produced: string[];
  /** Entry tokens missing when the subtask was about to run. */
  notReady?: string[];
  error?: string;
}

export interface GraphReport {
  id: string;
  ok: boolean;
  reports: SubTaskReport[];
  /** The subtask id where the graph stopped (undefined = ran to completion). */
  abortedAt?: string;
}

export interface WatchHandle {
  dispose(): void;
}

export interface TabOrchestratorDeps {
  /**
   * Run one subtask's AgentRunner bound to that subtask's tab, sharing the
   * graph's handoff + one task-level checklist. Must run to completion
   * before the orchestrator moves on (serial-LLM invariant).
   */
  runSubTask: (
    sub: SubTask,
    shared: { handoff: TabHandoff },
  ) => Promise<Pick<SubTaskReport, 'ok' | 'produced' | 'error'>>;
  /** Switch the focus tab (the P1 Tier-1 path). */
  switchTo: (tab: TabRef) => Promise<void>;
  /**
   * Passive re-perception of a source tab: DOM-only harvest, no cursor/
   * click/scroll/LLM. Returns null when the tab is gone / unreachable
   * (chrome:// pages, closed ports).
   */
  perceiveSource: (tab: TabRef) => Promise<{ fields: HarvestedField[]; url: string } | null>;
  /**
   * Start a passive watcher on a source tab. `onFields` fires with freshly
   * harvested fields whenever a trigger fires (url change / bounded title
   * poll). The orchestrator re-perceives them into the shared handoff in
   * place. The returned handle's dispose() tears the watcher down.
   */
  watch: (
    tab: TabRef,
    trigger: WatchTrigger,
    onFields: (fields: HarvestedField[], url: string) => void,
  ) => WatchHandle;
  /** Optional stop signal (user hit Stop / task ended). */
  isStopped?: () => boolean;
}

// ─── Watch trigger policy (pure, tested separately) ────────────────────────

/** Bounded poll floor — watcher cost cap (design §5: poll ≥15s). */
export const MIN_WATCH_POLL_MS = 15_000;
/** Bounded watcher count cap (design §5: ≤3 watched tabs). */
export const MAX_WATCHED_TABS = 3;

export interface TabSnapshot {
  url?: string;
  title?: string;
  status?: string;
}

/**
 * Should this snapshot cause a re-perception? Pure so the SW event wiring
 * (tabs.onUpdated / poll timer) and tests share one policy:
 * - urlChange trigger: the tab's url moved (or it reloaded to the same url
 *   is NOT a change — only an actual url diff fires);
 * - poll trigger: the title moved since the last snapshot (SPA content
 *   updates usually move the title / a cell value shown in it);
 * - no trigger set: never fires.
 */
export function watchTickFires(
  trigger: WatchTrigger,
  prev: TabSnapshot,
  next: TabSnapshot,
): boolean {
  if (trigger.urlChange && (next.url ?? '') !== (prev.url ?? '')) return true;
  if (trigger.pollMs !== undefined && (next.title ?? '') !== (prev.title ?? '')) return true;
  return false;
}

/** Clamp a trigger to the cost caps (poll floor). */
export function clampWatchTrigger(trigger: WatchTrigger): WatchTrigger {
  return {
    urlChange: trigger.urlChange,
    pollMs: trigger.pollMs !== undefined ? Math.max(MIN_WATCH_POLL_MS, trigger.pollMs) : undefined,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class TabOrchestrator {
  constructor(private readonly deps: TabOrchestratorDeps) {}

  /**
   * Passive re-perception of a source tab into the graph's shared handoff,
   * IN PLACE (identity-stable for any in-flight subtask). No-op when the
   * tab is unreachable.
   */
  async rePerceive(graph: TaskGraph, tab: TabRef): Promise<void> {
    const snap = await this.deps.perceiveSource(tab);
    if (!snap) return;
    refreshHandoffInPlace(graph.handoff, rePerceiveHandoff(graph.handoff, snap.fields, snap.url));
  }

  /**
   * Run a task graph in topological order: one focus tab at a time, serial
   * subtask runners, passive watchers on source tabs for the whole run.
   */
  async run(graph: TaskGraph): Promise<GraphReport> {
    const reports: SubTaskReport[] = [];
    let abortedAt: string | undefined;
    const byId = new Map(graph.subtasks.map((s) => [s.id, s] as const));

    // Passive watchers on source tabs that declared a trigger (cost cap:
    // at most MAX_WATCHED_TABS — design §5). They live for the whole graph
    // run: a change on the source re-perceives the shared handoff in place,
    // so the subtask running RIGHT NOW sees the new value on its next
    // token write.
    const watchers: WatchHandle[] = graph.subtasks
      .filter((s) => s.trigger && s.tab.role === 'source')
      .slice(0, MAX_WATCHED_TABS)
      .map((s) =>
        this.deps.watch(
          s.tab,
          clampWatchTrigger(s.trigger as WatchTrigger),
          (fields, url) => {
            refreshHandoffInPlace(graph.handoff, rePerceiveHandoff(graph.handoff, fields, url));
          },
        ),
      );

    try {
      for (const id of graph.order) {
        if (this.deps.isStopped?.()) {
          abortedAt = id;
          break;
        }
        const sub = byId.get(id);
        if (!sub) {
          abortedAt = id; // order lists an unknown subtask — fail fast, don't guess
          break;
        }
        // A source subtask re-perceives its own tab at entry, so its entry
        // tokens are as fresh as the page (the P3 "source changes" case at
        // subtask boundaries, not just while another subtask runs).
        if (sub.tab.role === 'source') {
          await this.rePerceive(graph, sub.tab);
        }
        // Entry precondition: every needed token must be present (current)
        // in the shared handoff. Missing => downstream subtasks depend on
        // it, so the graph stops at this subtask (reported, not failed
        // silently).
        const missing = sub.entry.need.filter((t) => !(t in graph.handoff.values));
        if (missing.length > 0) {
          reports.push({ id, ok: false, produced: [], notReady: missing });
          abortedAt = id;
          break;
        }
        await this.deps.switchTo(sub.tab);
        if (this.deps.isStopped?.()) {
          abortedAt = id;
          break;
        }
        // The P2 outbound-send gate is enforced inside the subtask's runner
        // (outboundGates marks which subtasks carry it); the orchestrator
        // just awaits the runner, which includes the gate's pause.
        const rep = await this.deps.runSubTask(sub, { handoff: graph.handoff });
        reports.push({ id, ok: rep.ok, produced: rep.produced, error: rep.error });
        if (!rep.ok) {
          // A failed subtask aborts the graph (serial + user-driven: no
          // automatic retry of a step that just failed).
          abortedAt = id;
          break;
        }
      }
    } finally {
      for (const w of watchers) w.dispose();
    }

    return { id: graph.id, ok: !abortedAt, reports, abortedAt };
  }
}
