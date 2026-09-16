/**
 * Agent Runner - the task loop, owned by the service worker (issues #71, #69)
 *
 * Before this, the entire agent loop lived in the popup's React state. Closing
 * the extension popup unmounted it and silently aborted the run - the task
 * state (step, filled ids, history, logs, maxSteps) did not survive.
 *
 * This module moves the loop into the service worker: the SW spawns a runner,
 * the popup becomes a thin view that subscribes to progress. The runner is
 * written against injected deps (extract / execute / navigate / fetch / delay /
 * the SessionManager / progress + stop hooks) so it is unit-testable with no
 * live browser, and so the SW wiring stays a few thin closures.
 *
 * #69: the loop is driven through the shipped SessionManager - viability check
 * each step (30-min timeout + shared step budget), failed-element memory, and
 * session completion - instead of the popup's orphaned local counters.
 */

import { guardOutboundPlan } from './pii/outboundGuard';
import type { SessionManager, SessionContext } from './sessionManager';
import { ScrollGuard, calculateMaxSteps, isRepeatedAction } from './loopDetection';

// ── Task state (shared + persisted so the SW can resume/report) ──────────────

export interface PlanHistoryEntry {
  targetId: string;
  result: 'OK' | 'FAILED';
  error?: string;
}

export interface AgentTaskState {
  running: boolean;
  step: number;
  maxSteps: number;
  status: 'idle' | 'running' | 'stopped' | 'complete' | 'failed' | 'degraded';
  logs: string[];
  degraded: boolean;
  sessionId: string | null;
  lastUpdate: number;
}

export function emptyTaskState(): AgentTaskState {
  return {
    running: false,
    step: 0,
    maxSteps: 0,
    status: 'idle',
    logs: [],
    degraded: false,
    sessionId: null,
    lastUpdate: Date.now(),
  };
}

// ── Pure helpers (unit-testable) ──────────────────────────────────────────────

export function buildPlanHistory(
  filledIds: Iterable<string>,
  failedIds: Iterable<string>,
  failedErrors: Map<string, string>,
): PlanHistoryEntry[] {
  const filled = new Set(filledIds);
  const history: PlanHistoryEntry[] = [];
  for (const id of filled) history.push({ targetId: id, result: 'OK' });
  for (const id of new Set(failedIds)) {
    if (filled.has(id)) continue; // succeeded on a later retry -> OK only
    history.push({ targetId: id, result: 'FAILED', error: failedErrors.get(id) ?? 'unknown' });
  }
  return history;
}

// Loop-detection + step-budget + scroll-guard now live in ./loopDetection so
// they have a single source of truth the tests can exercise directly (issue
// #76). Re-exported here for backward-compatible imports.
export {
  calculateMaxSteps,
  isRepeatedAction,
  ScrollGuard,
  type RecentAction,
} from './loopDetection';

export interface AgentActionLike {
  type: string;
  targetId?: number | string;
  value?: string;
  url?: string;
  waitMs?: number;
  key?: string;
  scrollDirection?: string;
  scrollAmount?: number;
  [k: string]: unknown;
}

// ── Narrow channel interfaces (the SW wires these to its handler bodies) ─────

export interface ExtractResult {
  ok: boolean;
  elements?: any[];
  url?: string;
  title?: string;
  context?: any;
  error?: string;
}

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  note?: string;
}

export interface AgentRunnerDeps {
  /** Extract the current page's elements + geometry + where-the-agent-is. */
  extract: () => Promise<ExtractResult>;
  /** Execute one planner action on the target tab. */
  execute: (action: AgentActionLike) => Promise<ExecuteResult>;
  /** Move the target tab to a URL (background tabs.update + wait-for-load). */
  navigate: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** POST the /plan request. Must return the parsed JSON (or null when aborted). */
  fetchPlan: (payload: unknown, signal?: AbortSignal) => Promise<any>;
  /** Injectable sleep (tests use a 0-delay stub). */
  delay: (ms: number) => Promise<void>;
  /** Drives the shipped SessionManager (#69). */
  sessionManager: SessionManager;
  /** The tab/window the task targets (for SessionManager bookkeeping). */
  tabId: number;
  windowId: number;
  /** The task + optional start URL. */
  task: string;
  startUrl?: string;
  /** Notify the view (popup) of a fresh state snapshot. */
  onProgress: (state: AgentTaskState) => void;
  /** Cooperative stop flag (issue #70, now SW-owned). */
  isStopped: () => boolean;
  /** Abort signal for an in-flight /plan fetch. */
  abortSignal?: AbortSignal;
}

// ── The runner ────────────────────────────────────────────────────────────────

export class AgentRunner {
  private state: AgentTaskState;
  private filledIds = new Set<string>();
  private failedIds = new Set<string>();
  private failedErrors = new Map<string, string>();
  private recentActionHistory: Array<{ targetId: string; type: string; value?: string }> = [];
  // Issue #76: the scroll-storm guard now lives in loopDetection.ScrollGuard
  // (single source of truth, unit-tested) instead of an inline counter.
  private scrollGuard = new ScrollGuard(3);
  private plannerDegraded = false;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.state = emptyTaskState();
  }

  getState(): AgentTaskState {
    return this.state;
  }

  private log(msg: string): void {
    this.state.logs.push(`${new Date().toLocaleTimeString()}: ${msg}`);
    // Keep the whole run's activity log (Bug D: the Copy button needs it all,
    // not just the last 200). 5000 short strings is still tiny.
    if (this.state.logs.length > 5000) this.state.logs = this.state.logs.slice(-5000);
    this.state.lastUpdate = Date.now();
  }

  private notify(): void {
    this.state.lastUpdate = Date.now();
    this.deps.onProgress(this.state);
  }

  /**
   * Run the task loop to completion / stop / failure. Fire-and-forget from
   * the SW's point of view; it reports progress via onProgress and lands in a
   * terminal state when it resolves.
   */
  async run(): Promise<void> {
    const d = this.deps;
    this.state.running = true;
    this.state.status = 'running';
    this.log(`Starting task: "${d.task}"`);
    this.notify();

    let currentStep = 0;
    let maxSteps = 15; // refined after the first extraction

    // #69: open the session through the shipped SessionManager. Its budget +
    // 30-min timeout now gate the loop instead of orphaned local counters.
    let sessionId: string | null = null;
    try {
      sessionId = await d.sessionManager.startSession(
        d.tabId,
        d.windowId,
        d.startUrl?.trim() || d.task,
        d.task,
        100, // generous hard cap; the dynamic calc refines it below
      );
      this.state.sessionId = sessionId;
      this.log(`Session ${sessionId} started`);
    } catch (e) {
      this.log(`Session start failed: ${e instanceof Error ? e.message : String(e)} - continuing locally`);
    }

    // Navigate to the start URL first, if one was given.
    if (d.startUrl?.trim()) {
      this.log(`Starting at ${d.startUrl}`);
      const nav = await d.navigate(d.startUrl.trim());
      if (nav.ok) {
        this.log('✅ Navigated to start URL');
        await d.delay(600);
      } else {
        this.log(`⚠️ Could not navigate to start URL (${nav.error ?? 'unknown'}) - running on current tab`);
      }
    }

    this.notify();

    while (true) {
      // #70: honor a Stop request at the top of every iteration.
      if (d.isStopped()) {
        this.log('⏹ Stopped by user');
        this.state.status = 'stopped';
        this.state.running = false;
        this.finishSession(sessionId, 'stopped');
        this.notify();
        return;
      }

      // #69: viability gate - 30-min session timeout + shared step budget.
      if (sessionId) {
        const ctx: SessionContext | null = d.sessionManager.getContext(sessionId);
        if (ctx) maxSteps = ctx.maxSteps;
        if (!d.sessionManager.isTaskViable(sessionId)) {
          this.log('Session no longer viable (timeout or step budget) - stopping');
          this.state.status = 'failed';
          this.state.running = false;
          d.sessionManager.failSession(sessionId, 'task not viable');
          this.notify();
          return;
        }
      }

      if (currentStep >= maxSteps) {
        this.log(`⚠️ Reached maximum steps (${maxSteps})`);
        break;
      }

      currentStep++;
      this.state.step = currentStep;
      this.log(`--- Step ${currentStep}/${maxSteps} ---`);
      this.log('Extracting page elements...');

      const snapshot = await d.extract();
      if (!snapshot?.ok) {
        this.log(`Failed to extract elements: ${snapshot?.error ?? 'no ok flag'}`);
        this.state.status = 'failed';
        this.state.running = false;
        this.finishSession(sessionId, 'extract failed');
        this.notify();
        return;
      }

      const elements: any[] = snapshot.elements ?? [];
      this.log(`Found ${elements.length} interactive elements`);
      const pageUrl: string = snapshot.url ?? '';
      const pageTitle: string = snapshot.title ?? '';
      const pageContext = snapshot.context ?? null;
      if (pageContext?.moreContentBelow) {
        this.log(`Page has more content below the fold (scrollY=${pageContext.scrollY}/${pageContext.scrollHeight})`);
      }

      if (elements.length === 0) {
        this.log('No interactive elements found');
        break;
      }

      const inputFields = elements.filter((e) => e.role === 'textbox' || e.tag === 'input');
      const buttons = elements.filter((e) => e.role === 'button' || e.tag === 'button');
      const selects = elements.filter((e) => e.tag === 'select' || e.type === 'select-one');
      this.log(`Elements: ${elements.length} total (${inputFields.length} inputs, ${selects.length} selects, ${buttons.length} buttons)`);

      // Dynamic step budget, clamped to the session's shared budget.
      if (currentStep === 1 || maxSteps === 15) {
        const calculated = calculateMaxSteps(inputFields.length, selects.length, buttons.length);
        const sessionMax = sessionId ? d.sessionManager.getContext(sessionId)?.maxSteps ?? calculated : calculated;
        maxSteps = Math.min(sessionMax, calculated, 100);
        this.state.maxSteps = maxSteps;
        this.log(`Calculated max steps: ${maxSteps} (need to fill ${inputFields.length + selects.length} fields)`);
      }

      const history = buildPlanHistory(this.filledIds, this.failedIds, this.failedErrors);
      const guard = guardOutboundPlan({
        task: d.task,
        elements: elements as Record<string, unknown>[],
        context: pageContext ?? undefined,
        history,
        passThrough: {
          step: currentStep,
          inputCount: inputFields.length,
          buttonCount: buttons.length,
          url: pageUrl,
          title: pageTitle,
        },
      });
      if (guard.blocked) {
        this.log(`⛔ Outbound firewall blocked /plan egress: ${guard.category ?? 'PII'} at ${guard.reason ?? '?'}`);
        this.state.status = 'failed';
        this.state.running = false;
        this.finishSession(sessionId, 'outbound firewall blocked');
        this.notify();
        return;
      }
      if (guard.redactedCount > 0) this.log(`Masked ${guard.redactedCount} PII field(s) before /plan egress`);

      const plan = await d.fetchPlan(guard.payload, d.abortSignal);
      if (plan == null) {
        this.log('Planner error: no response (server offline or aborted)');
        break;
      }
      const action: AgentActionLike | undefined = plan.action;

      if (plan.degraded) this.log(`⚠️ Planner degraded: ${plan.degraded_reason ?? 'no LLM reachable'}`);
      this.log(`Planner returned: ${action?.type ?? 'NONE'}`);

      if (!action || action.type === 'DONE') {
        if (plan.degraded) {
          this.log('⚠️ Stopping: planner signaled DONE while DEGRADED (no LLM / heuristic) — task NOT genuinely complete');
          this.plannerDegraded = true;
          this.state.degraded = true;
        } else {
          this.log('✅ Task complete (planner signaled DONE)');
        }
        break;
      }

      // Loop detection - a repeated action (same target+type, and same value
      // for value-bearing types) is skipped + marked done.
      if (isRepeatedAction(this.recentActionHistory, action)) {
        this.log(`⚠️ Skipping repeated action on element #${action.targetId}`);
        this.filledIds.add(String(action.targetId));
        this.recentActionHistory.push({ targetId: String(action.targetId), type: action.type, value: action.value });
        this.state.step = currentStep;
        this.notify();
        continue;
      }

      await this.executeAction(action, d, sessionId);
      this.state.step = currentStep;
      this.notify();

      // #70: a Stop pressed during the inter-step delay is honored in 100ms
      // slices. Bug E: the settle is 300ms (was 800) - the next EXTRACT is
      // what actually reads the page, so a long blind sleep only slows the
      // run without improving the planner's view.
      for (let w = 0; w < 300; w += 100) {
        await d.delay(100);
        if (d.isStopped()) {
          this.log('⏹ Stopped by user');
          this.state.status = 'stopped';
          this.state.running = false;
          this.finishSession(sessionId, 'stopped');
          this.notify();
          return;
        }
      }
    }

    // Loop finished without an explicit terminal branch above.
    if (this.state.status === 'running') {
      this.state.status = this.plannerDegraded ? 'degraded' : 'complete';
      if (this.plannerDegraded) {
        this.log('Task ended while planner was DEGRADED - verify results manually');
      } else {
        this.log('Task completed');
      }
    }
    this.state.running = false;
    this.finishSession(sessionId, this.plannerDegraded ? 'degraded' : 'complete');
    this.notify();
  }

  /**
   * Execute one planner action. #69: failures are recorded to the session's
   * failed-element memory via recordFailedElement.
   */
  private async executeAction(
    action: AgentActionLike,
    d: AgentRunnerDeps,
    sessionId: string | null,
  ): Promise<void> {
    const recordFailure = (id: string, err?: string) => {
      this.failedIds.add(id);
      this.failedErrors.set(id, err ?? 'unknown');
      if (sessionId) d.sessionManager.recordFailedElement(sessionId, id);
    };

    if (action.type === 'SCROLL') {
      const { allowed, consecutive } = this.scrollGuard.nextScroll();
      if (!allowed) {
        this.log('⚠️ Too many scrolls, stopping to prevent loop');
        this.state.status = 'failed';
        return;
      }
      this.log(`Scrolling page... (${consecutive}/3)`);
      const r = await d.execute({
        type: 'SCROLL',
        scrollDirection: action.scrollDirection || 'down',
        scrollAmount: action.scrollAmount || 500,
      });
      if (!r?.ok) this.log('Scroll failed');
      this.recentActionHistory.push({ targetId: 'scroll', type: 'SCROLL' });
      return;
    }

    if (action.type === 'TYPE' && action.targetId !== undefined && action.value !== undefined) {
      this.scrollGuard.noteOtherAction();
      this.log(`Typing: "${action.value}" into element #${action.targetId}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Typed successfully');
        this.filledIds.add(String(action.targetId));
      } else {
        this.log(`❌ Type failed: ${r?.error ?? 'unknown'}`);
        recordFailure(String(action.targetId), r?.error);
      }
      this.recentActionHistory.push({ targetId: String(action.targetId), type: 'TYPE', value: action.value });
      return;
    }

    if (action.type === 'CLICK' && action.targetId !== undefined) {
      this.scrollGuard.noteOtherAction();
      this.log(`Clicking element #${action.targetId}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Clicked successfully');
        this.filledIds.add(String(action.targetId));
        // A click that navigates (opening an article/suggestion link) drops the
        // content port; the SW reports ok:true with a "page navigated" note
        // (#86). Give the new page a full-navigation settle before the next
        // EXTRACT - a navigating CLICK is otherwise the one action the flat
        // 300ms inter-step settle does NOT cover (it would read a half-loaded
        // DOM). Mirrors the KEY/NAVIGATE navigation handling below.
        if (r.note && /navigat/i.test(r.note)) {
          this.log('🧭 Click triggered a navigation - re-planning on the new page');
          this.scrollGuard.noteOtherAction();
          this.recentActionHistory = [];
          await d.delay(600);
        }
      } else {
        this.log(`❌ Click failed: ${r?.error ?? 'unknown'}`);
        recordFailure(String(action.targetId), r?.error);
      }
      this.recentActionHistory.push({ targetId: String(action.targetId), type: 'CLICK' });
      return;
    }

    if (action.type === 'SELECT' && action.targetId !== undefined && action.value !== undefined) {
      this.scrollGuard.noteOtherAction();
      this.log(`Selecting "${action.value}" in element #${action.targetId}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Selected successfully');
        this.filledIds.add(String(action.targetId));
      } else {
        this.log(`❌ Select failed: ${r?.error ?? 'unknown'}`);
        recordFailure(String(action.targetId), r?.error);
      }
      this.recentActionHistory.push({ targetId: String(action.targetId), type: 'SELECT', value: action.value });
      return;
    }

    if (action.type === 'KEY') {
      this.scrollGuard.noteOtherAction();
      const key = action.key || 'Enter';
      this.log(`⌨️ Pressing key "${key}"${action.targetId !== undefined ? ` on element #${action.targetId}` : ''}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Key pressed successfully');
        // A key that navigates drops the content port; the SW reports that as
        // ok:true with a "page navigated" note (#86) - reset per-page state.
        if (r.note && /navigat/i.test(r.note)) {
          this.log('🧭 Key triggered a navigation - re-planning on the new page');
          this.scrollGuard.noteOtherAction();
          this.recentActionHistory = [];
          await d.delay(600);
        }
        this.recentActionHistory.push({ targetId: String(action.targetId ?? 'focus'), type: 'KEY' });
      } else {
        this.log(`❌ Key press failed: ${r?.error ?? 'unknown'}`);
        this.recentActionHistory.push({ targetId: String(action.targetId ?? 'focus'), type: 'KEY' });
      }
      return;
    }

    if (action.type === 'WAIT') {
      const waitMs = Number.isFinite(action.waitMs) ? (action.waitMs as number) : 1000;
      this.log(`⏳ Waiting ${waitMs}ms for page to settle...`);
      const r = await d.execute({ type: 'WAIT', waitMs });
      if (!r?.ok) this.log(`⚠️ Wait reported issue: ${r?.error ?? 'unknown'}`);
      return;
    }

    if (action.type === 'NAVIGATE' && action.url) {
      this.log(`🧭 Navigating to ${action.url}`);
      const r = await d.navigate(action.url);
      if (r.ok) {
        this.log('✅ Navigated (new page loaded)');
        this.scrollGuard.noteOtherAction();
        this.recentActionHistory = [];
        await d.delay(600);
      } else {
        this.log(`❌ Navigate failed: ${r.error ?? 'unknown'}`);
        this.state.status = 'failed';
      }
      return;
    }

    this.log(`Unknown action: ${JSON.stringify(action)}`);
  }

  /** Close out the session per its terminal status (#69). */
  private finishSession(sessionId: string | null, outcome: string): void {
    if (!sessionId) return;
    if (outcome === 'complete' || outcome === 'degraded') {
      this.deps.sessionManager.completeSession(sessionId, outcome);
    } else {
      this.deps.sessionManager.failSession(sessionId, outcome);
    }
  }
}
