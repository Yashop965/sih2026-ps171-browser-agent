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
import { resolveProfileValue, type UserProfile } from './userProfile';
import type { SessionManager, SessionContext } from './sessionManager';
import { ScrollGuard, calculateMaxSteps, isRepeatedAction } from './loopDetection';
import { goalBackstop, quotedSpans, contentTokens, normalize } from './goalBackstop';
import type { TabHandoff, OpenTabInfo } from './tabHandoff';
import { handoffForPlanner, resolveHandoffValue } from './tabHandoff';
import { classifyOutboundSend, stageOutbound, type ElementLike } from './outboundGate';

// ── Per-event timeout (stall guard) ─────────────────────────────────────────
//
// Every event the planner issues (a /plan round-trip, or an on-device VLM
// confirm) is bounded by a deadline. An event that outlasts it is logged +
// skipped as a no-op; 3 consecutive timeouts stop the run as stalled, so a
// hung event can never make the agent "look stuck" after performing one.

/** Default per-event deadline (ms) - headroom over the ~14s planner calls. */
export const DEFAULT_EVENT_TIMEOUT_MS = 90_000;

/** Thrown by withTimeout() when a bounded event outlasts its deadline. */
export class EventTimeoutError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`event "${label}" timed out after ${ms}ms`);
    this.name = 'EventTimeoutError';
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Race `promise` against a deadline: resolves with the value when the event
 * settles first, rejects with EventTimeoutError(label, ms) otherwise. The
 * timer is cleared on settle, so a fast event leaves no dangling handle.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EventTimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ── Task state (shared + persisted so the SW can resume/report) ──────────────

export interface PlanHistoryEntry {
  targetId: string;
  result: 'OK' | 'FAILED';
  error?: string;
}

/**
 * One item of the planner-authored task checklist (cross-page memory).
 * Mirrors the server's `ChecklistItem` pydantic model. The runner tracks it
 * across pages and flips items `done` as they are genuinely reached; the task
 * only completes when the whole list is satisfied (or the list is empty).
 */
export interface ChecklistItem {
  id: string;
  description?: string;
  done: boolean;
}

export interface AgentTaskState {
  running: boolean;
  step: number;
  maxSteps: number;
  status:
    'idle' | 'running' | 'stopped' | 'complete' | 'failed' | 'degraded' | 'awaiting-confirmation';
  logs: string[];
  degraded: boolean;
  sessionId: string | null;
  lastUpdate: number;
  // #143: the staged outbound send the run is paused on (display-only value;
  // the popup shows it and the user confirms/dismisses). Absent otherwise.
  awaiting?: import('./outboundGate').StagedOutbound;
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
  failedErrors: Map<string, string>
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

/**
 * Merge the planner's returned checklist into the runner's authoritative one.
 *
 * The runner owns the checklist across pages (cross-page memory). Each step
 * the planner echoes its view back; we union by `id`:
 *   - unknown ids are appended (new sub-goals the planner just decomposed),
 *   - known ids keep their first-seen position,
 *   - `done` is STICKY: an item flips false->true but never back (a weaker
 *     response that forgets to re-assert done can't resurrect it),
 *   - a non-empty incoming `description` fills in a missing one.
 *
 * Malformed incoming entries (no usable id) are dropped, not fatal.
 */
export function mergeChecklist(
  existing: ChecklistItem[],
  incoming: Array<Partial<ChecklistItem> | string | null | undefined>
): ChecklistItem[] {
  const byId = new Map<string, ChecklistItem>();
  for (const item of existing) byId.set(item.id, { ...item });

  for (const raw of incoming) {
    let id = '';
    let description: string | undefined;
    let done = false;
    if (typeof raw === 'string') {
      id = raw.trim();
      description = raw.trim();
    } else if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      id = String(r.id ?? r.step ?? '').trim();
      const desc = r.description ?? r.label ?? r.text;
      if (typeof desc === 'string' && desc.trim()) description = desc.trim();
      done = Boolean(r.done ?? r.completed ?? r.complete);
    }
    if (!id) continue; // no usable key - skip this entry

    const prev = byId.get(id);
    if (prev) {
      if (!prev.description && description) prev.description = description;
      prev.done = prev.done || done; // sticky
      byId.set(id, prev);
    } else {
      byId.set(id, { id, description, done });
    }
  }

  return Array.from(byId.values());
}

// ── Completion evidence gate (planner over-claim defense) ────────────────────

/** A completion gate that trusts the planner's DONE only when the FINAL sub-goal
 *  has independent on-page evidence.
 *
 * Why this exists: rule 16 of the planner prompt tells the LLM to echo the
 * checklist and flip `done` on the live page, and `mergeChecklist` ORs those
 * flags in (sticky). A flaky model can assert "all items done" while sitting on
 * the WRONG page (e.g. `Special:Search`) and the completion check then sees
 * `undone.length === 0` and finishes with no evidence the terminal goal was
 * ever reached. The per-step backstop only visits OPEN items, so a terminal
 * item the planner just wrongly closed never gets re-checked.
 *
 * This gate re-checks the terminal item against the CURRENT page with the same
 * deterministic backstop used per-step. It is deliberately conservative so it
 * can only ADD a "keep going" verdict, never a false completion:
 *   - A DESTINATION item (its quoted target / content tokens must appear on the
 *     page) is only trusted when the backstop proves it is actually here.
 *   - An ACTION item (no checkable target — e.g. "fill the form and submit",
 *     a goal the URL/title can't express) is passed through, so form/completion
 *     tasks that legitimately end on the same page are not blocked.
 *
 * Pure + exported: unit-testable with no live browser.
 */
export interface TerminalGateInput {
  /** The checklist item that the planner marked done last (the goal to reach). */
  terminalItem: { id: string; description?: string };
  url: string;
  title: string;
}

export interface TerminalGateVerdict {
  /** true = keep going (terminal goal not provably on this page); false = let the task complete. */
  block: boolean;
  /** How we decided. */
  reason:
    'destination-not-on-page' | 'action-goal-passed' | 'no-checkable-target' | 'terminal-on-page';
  score: number;
}

/** Quoted spans the backstop treats as an exact target name. */
export function terminalTargetSpans(description: string): string[] {
  return quotedSpans(description ?? '');
}

/** Destination phrasings: the item names a PAGE/ARTICLE it should land on. */
const DESTINATION_SIGNALS = [
  'open',
  'opened',
  'navigate',
  'navigated',
  'visit',
  'visited',
  'find',
  'found',
  'look up',
  'lookup',
  'looked',
  'land',
  'reached',
  'reach',
  'arrive',
  'arrived',
  'view',
  'read',
  'go to',
];

/** Does the description read like "get to destination X" (vs an action)? */
export function isDestinationDescription(description: string): boolean {
  const n = normalize(description ?? '');
  if (!n) return false;
  return DESTINATION_SIGNALS.some((s) => n.includes(s));
}

/**
 * Decide whether a "planner said DONE" may be trusted on this page.
 * Blocks (return {block:true}) only when the terminal item is a DESTINATION
 * whose target is provably NOT on the current page. Never blocks action goals
 * ("submit the form", "fill the fields") — the URL/title can't express those,
 * so they pass through.
 */
export function gateTerminalCompletion(input: TerminalGateInput): TerminalGateVerdict {
  const { terminalItem, url, title } = input;
  const desc = (terminalItem.description ?? '').trim();

  // No description to check: nothing the URL/title can prove; don't block.
  if (!desc) return { block: false, reason: 'no-checkable-target', score: 0 };

  const backstop = goalBackstop({ item: terminalItem, url, title });
  if (backstop.done) {
    // Independent on-page evidence for the terminal goal — trust the DONE.
    return { block: false, reason: 'terminal-on-page', score: backstop.score };
  }

  // A quoted target the backstop failed to find on this page: hard signal
  // the planner over-claimed. Block.
  if (terminalTargetSpans(desc).length > 0) {
    return { block: true, reason: 'destination-not-on-page', score: backstop.score };
  }

  // No quoted target. Only a destination that NAMES a real thing is blockable:
  // "open the Hypertext article" (content token 'hypertext') can be checked
  // against the page; a phrased-but-targetless item ("open article", where
  // every word is a stopword) has nothing to match, so it passes through.
  const content = contentTokens(desc);
  if (content.length === 0) {
    return { block: false, reason: 'action-goal-passed', score: backstop.score };
  }
  // Block only when the item reads like a destination ("open / navigate /
  // …") AND its target words are largely absent from the current page. An
  // action goal (no destination wording) always passes, so form/completion
  // tasks that legitimately end on the same page are not blocked.
  if (!isDestinationDescription(desc)) {
    return { block: false, reason: 'action-goal-passed', score: backstop.score };
  }
  const overlap = tokenOverlapScore(desc, `${title} ${url}`);
  if (overlap < 0.5) {
    return { block: true, reason: 'destination-not-on-page', score: overlap };
  }
  // Target words are mostly present (0.5..0.8 — below the backstop's 0.8 bar
  // but not clearly a different page): don't second-guess, let it complete.
  return { block: false, reason: 'action-goal-passed', score: overlap };
}

// Small local mirror of goalBackstop's token-overlap (kept here so the gate is
// self-contained + testable without importing the private helper).
function tokenOverlapScore(a: string, b: string): number {
  const at = contentTokens(a);
  if (at.length === 0) return 0;
  const bt = new Set(normalize(b).split(' ').filter(Boolean));
  const hit = at.filter((t) => bt.has(t)).length;
  return hit / at.length;
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

/**
 * #128: content signature for per-page memory scoping.
 *
 * Element ids are re-issued on EVERY extract(). The old reset predicate was
 * URL-only (lastExtractUrl), so a same-URL re-render — a SPA wizard step, a
 * submit that stays on the URL, a framework re-mount that re-bakes the control
 * tree — re-issued ids and leaked the previous extract's filled/failed ids
 * into the new extract's /plan history as fake "already done" entries,
 * steering the planner off the field that actually needs filling. (Same failure
 * class as #114, which fixed the navigating-URL variant only.)
 *
 * The signature is a DOCUMENT-LEVEL invariant: full document height
 * (scrollHeight) + how many controls the 250-cap omitted. It is deliberately
 * NOT built from the visible element sample or labels, because a plain scroll
 * shifts the visible subset (and the numeric id↔stableId mapping) WITHOUT the
 * page changing - and clearing per-page memory on that would regress the #62
 * cross-scroll "already filled" persistence. A genuine re-render that adds /
 * removes content or crosses the cap changes scrollHeight and/or omitted, so
 * the same-URL case now fires the reset where the URL-only check did not.
 *
 * PII-safe by construction: two numbers, no labels, no raw page text.
 *
 * Pure + unit-tested. Limitation (documented, backstopped by the #118 per-node
 * semantic guard): an in-place re-render that preserves BOTH document height
 * and total control count is not detected here - it is caught action-by-action
 * by verifyElementFreshness instead.
 */
export function pageContentSignature(
  context: { scrollHeight?: number; omitted?: number } | null | undefined
): string {
  return `${context?.scrollHeight ?? 0}/${context?.omitted ?? 0}`;
}

export interface AgentActionLike {
  type: string;
  targetId?: number | string;
  value?: string;
  url?: string;
  waitMs?: number;
  key?: string;
  scrollDirection?: string;
  scrollAmount?: number;
  // #141: SWITCH_TAB target - the tab to drive next. tabId is exact;
  // urlHint is fuzzy (matched against open tabs' URLs + titles). Both absent
  // = "the active web tab" (a no-op switch, never a failure).
  tabId?: number;
  urlHint?: string;
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
  /**
   * #100 optional confirm: when the planner says DONE with checklist items
   * still open, ask the on-device vision model to confirm the goal is actually
   * visible on screen (OCR/grounding; screenshot never leaves the device).
   * Absent = not wired (fast path is the URL/title backstop only); a `null`
   * return means "model unavailable / inconclusive" - the loop just carries on.
   * When unavailable, implementations SHOULD explain why via
   * `unavailableReason` so the runner can say once why the VLM never ran
   * (e.g. "model load failed: 401 …") instead of a generic line every step.
   */
  confirmGoal?: (input: {
    url: string;
    title: string;
    openItems: ChecklistItem[];
  }) => Promise<{ confirmed: boolean; detail?: string; unavailableReason?: string } | null>;
  /**
   * #102 local user profile (on-device). When the planner returns an action
   * whose value is a profile token (<EMAIL>, <ADDRESS> ...), the runner
   * resolves it to the real stored constant HERE, on-device, right before
   * execution - so the LLM never saw the raw value (it only saw the token,
   * via the outbound guard's profileHints) and never does. Absent / empty =
   * profile feature off, behaviour unchanged.
   */
  profile?: UserProfile;
  /**
   * #100 proactive verify cadence: how often, in consecutive actions, to
   * poll the on-device VLM "is the goal on screen right now?". Default (omit
   * or 1) checks after EVERY successful action - the strongest early-stop.
   * Raise to throttle cost on chatty tasks. Checked after executeAction,
   * before the inter-step settle, so a confirmed goal breaks the loop
   * without one more LLM plan round-trip.
   */
  goalCheckEvery?: number;
  /**
   * Per-event timeout (ms): bounds a single planner event (fetchPlan) and
   * the optional VLM confirms (confirmGoal). An event that outlasts the
   * deadline is treated as TIMED OUT - the step is logged and skipped as a
   * no-op instead of hanging the run, and 3 consecutive timeouts stop the
   * run as stalled (so the agent never "looks stuck" after performing one
   * event). Omit = the generous 90s default, which leaves headroom for the
   * ~14s LLM planner calls.
   */
  eventTimeoutMs?: number;
  /**
   * #141 cross-tab orchestrator (P1). LIVE list of open web tabs for this
   * task's window (url + title only - no DOM, no PII), so the planner can
   * target a SWITCH_TAB by hint. Absent = the task is single-tab: the key
   * is omitted from /plan and behaviour is unchanged.
   */
  openTabs?: () => Promise<OpenTabInfo[]>;
  /**
   * #141 cross-tab handoff (P1): on-device token memory filled by
   * HARVEST_FIELDS on previously-visited tabs. The planner sees
   * tokens + labels ONLY (handoffForPlanner strips the values - the LLM
   * never reads harvested data); the runner resolves a token back to its
   * value at execution time, like #102 profile tokens. Absent = no
   * handoff wired, TYPE/SELECT behave as before.
   */
  crossTabMemory?: () => TabHandoff | null;
  /**
   * #143 cross-tab orchestrator (P2) — the outbound-send gate. When the
   * runner is about to execute a send-classified action on a user opt-in
   * outbound domain (e.g. web.whatsapp.com), it pauses the run with status
   * `awaiting-confirmation` and hands the staged payload to the view. The
   * promise RESOLVES when the user confirms (execute) or dismisses (skip
   * just this step; the run completes best-effort, not failed). Absent /
   * null allowlist = gate OFF: single-domain, non-send behaviour is
   * unchanged.
   */
  outboundGate?: {
    /** The user's outbound-domain allowlist (opt-in, per domain). */
    allowlist: () => Promise<string[]>;
    /** The current outbound tab's url/title, for the staged payload display. */
    destination: () => Promise<{ url: string; title: string }>;
    /** Pause the run; resolves { confirmed, dismissed } on the user's call. */
    awaitConfirmation: (staged: import('./outboundGate').StagedOutbound) => Promise<{
      confirmed: boolean;
      dismissed?: boolean;
      stopRequested?: boolean;
    }>;
  };
}

// ── The runner ────────────────────────────────────────────────────────────────

export class AgentRunner {
  private state: AgentTaskState;
  private filledIds = new Set<string>();
  private failedIds = new Set<string>();
  private failedErrors = new Map<string, string>();
  private recentActionHistory: Array<{ targetId: string; type: string; value?: string }> = [];
  // Streak of consecutive "skipped repeated action" no-ops. Surfaces as a
  // PII-safe loopWarning in the /plan payload so the planner SEES it is stuck
  // re-issuing the same action and can switch tactics (e.g. submit the filled
  // search box instead of re-typing it). Reset by any executed action and by
  // the per-page memory clear.
  private repeatedStreak = 0;
  // Cross-page task checklist (the "what's done / what's left" memory). Owned
  // by the runner; fed back to /plan each step and merged from the planner's
  // response. The task completes only when the whole list is satisfied (or it
  // is empty - pre-checklist behaviour).
  private checklist: ChecklistItem[] = [];
  // A planner that keeps signaling DONE while checklist items are still open
  // is stuck. We give it a short grace streak; past that we stop spinning the
  // budget and complete best-effort with a warning. Reset on any real action.
  private doneWithOpenStreak = 0;
  // Issue #76: the scroll-storm guard now lives in loopDetection.ScrollGuard
  // (single source of truth, unit-tested) instead of an inline counter.
  private scrollGuard = new ScrollGuard(3);
  private plannerDegraded = false;
  // #143 outbound gate: set when the user STOPS the run at the gate (⏹) or
  // DISMISSES the send (↩). The run loop honors this at the top of the next
  // iteration: stop -> session finished 'stopped'; dismiss -> the send step
  // was skipped (completed reads/fills preserved) and the loop exits
  // best-effort 'complete', NOT 'failed'.
  private outboundGateStopped = false;
  private outboundGateDismissed = false;
  // #100 proactive verify: how many successful actions since the last on-device
  // goal check. Compares against deps.goalCheckEvery (default 1 = every action).
  private actionsSinceGoalCheck = 0;
  // Streak of consecutive per-event timeouts (planner fetch / VLM confirm).
  // A timely plan or an executed action resets it; 3 in a row stops the run
  // as stalled instead of spinning the step budget on hung events.
  private consecutiveEventTimeouts = 0;
  // #136/D: the VLM-unavailable reason is said out loud ONCE per run so the
  // per-step backstop log stays quiet (reasons rarely change mid-run).
  private vlmUnavailableLogged = false;
  // Completion evidence gate: how many DONE signals we've had to REJECT because
  // the terminal sub-goal wasn't provably on the current page. Bounded so a
  // planner that keeps over-claiming eventually completes best-effort (with a
  // warning) instead of spinning the step budget forever.
  private terminalGateStreak = 0;
  private static readonly TERMINAL_GATE_MAX = 3;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.state = emptyTaskState();
  }

  getState(): AgentTaskState {
    return this.state;
  }

  /** Effective per-event deadline (ms): the dep when set, else the default. */
  private eventTimeoutMs(): number {
    return this.deps.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
  }

  private log(msg: string): void {
    this.state.logs.push(`${new Date().toLocaleTimeString()}: ${msg}`);
    // Keep the whole run's activity log (Bug D: the Copy button needs it all,
    // not just the last 200). 5000 short strings is still tiny.
    if (this.state.logs.length > 5000) this.state.logs = this.state.logs.slice(-5000);
    this.state.lastUpdate = Date.now();
  }

  /**
   * Say why the on-device VLM is unavailable, ONCE per run. Per-step backstop
   * logging otherwise repeats "model unavailable" on every action; the reason
   * (download failed, init error, …) rarely changes mid-run, so the first
   * occurrence carries the detail and later steps stay quiet.
   */
  private logVlmUnavailableOnce(reason: string): void {
    if (this.vlmUnavailableLogged) return;
    this.vlmUnavailableLogged = true;
    this.log(`🔎 VLM unavailable this run (${reason}) - continuing on the deterministic backstop`);
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
        100 // generous hard cap; the dynamic calc refines it below
      );
      this.state.sessionId = sessionId;
      this.log(`Session ${sessionId} started`);
    } catch (e) {
      this.log(
        `Session start failed: ${e instanceof Error ? e.message : String(e)} - continuing locally`
      );
    }

    // Navigate to the start URL first, if one was given.
    if (d.startUrl?.trim()) {
      this.log(`Starting at ${d.startUrl}`);
      const nav = await d.navigate(d.startUrl.trim());
      if (nav.ok) {
        this.log('✅ Navigated to start URL');
        await d.delay(600);
      } else {
        this.log(
          `⚠️ Could not navigate to start URL (${nav.error ?? 'unknown'}) - running on current tab`
        );
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

      // #143 outbound gate: the user stopped or dismissed the run at the
      // gate on the PREVIOUS step. executeAction already stamped the status
      // and broadcast it; finish the session and exit. A dismiss is NOT a
      // failure - it exits 'complete' so the preserved reads/fills stand.
      if (this.outboundGateStopped || this.outboundGateDismissed) {
        const outcome = this.outboundGateStopped ? 'stopped' : 'complete';
        this.log(`Outbound gate resolved as ${outcome} - ending the run`);
        this.finishSession(sessionId, outcome);
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
      let pageUrl: string = snapshot.url ?? '';
      let pageTitle: string = snapshot.title ?? '';
      let pageContext = snapshot.context ?? null;
      if (pageContext?.moreContentBelow) {
        this.log(
          `Page has more content below the fold (scrollY=${pageContext.scrollY}/${pageContext.scrollHeight})`
        );
      }
      if (pageContext?.omitted > 0) {
        this.log(
          `Element table capped: ${pageContext.omitted} more control(s) on this page were omitted from the planner table - scroll / re-extract to see them`
        );
      }

      if (elements.length === 0) {
        // #114: a 0-element read right after a NAVIGATE is usually transient -
        // the content-script extraction races the new page's render/hydrate
        // (observed live: Wikipedia article read 0 interactive elements with
        // 1627 off-fold controls reported, then had elements on the next
        // read). Re-extract with short delays instead of ending the run.
        // The OLD code broke here and the loop exit stamped "Task completed"
        // even with 2 of 3 goals still open - a false success the judge would
        // mark wrong.
        let recovered = false;
        for (let attempt = 0; attempt < 3 && !recovered; attempt++) {
          if (attempt > 0) {
            this.log(
              `No interactive elements found - re-extracting after ${attempt * 500}ms (${attempt + 1}/3)`
            );
            await d.delay(attempt * 500);
            if (d.isStopped()) break;
          }
          const retry = await d.extract();
          if (!retry?.ok) break; // snapshot error - handled at top next iteration
          const retryEls = retry.elements ?? [];
          if (retryEls.length > 0) {
            elements.length = 0;
            for (const e of retryEls) elements.push(e);
            pageUrl = retry.url ?? pageUrl;
            pageTitle = retry.title ?? pageTitle;
            pageContext = retry.context ?? null;
            this.log(`Found ${elements.length} interactive elements (after re-extract)`);
            recovered = true;
          }
        }
        if (!recovered) {
          this.log('No interactive elements found');
          const open = this.checklist.filter((c) => !c.done);
          // A 0-element exit is NEVER a success: the only complete paths are
          // an explicit planner DONE, the backstop proving all items, or a
          // VLM confirmation. Nothing was left to act on, so no completion
          // evidence exists.
          this.log(
            open.length > 0
              ? `⚠️ Page has no interactive elements with ${open.length} goal(s) still open - task NOT complete (stalled)`
              : '⚠️ Page has no interactive elements and no completed goals to verify - task NOT complete (stalled)'
          );
          this.state.status = 'failed';
          this.state.running = false;
          this.finishSession(
            sessionId,
            open.length > 0
              ? 'stalled: no interactive elements, task incomplete'
              : 'stalled: no interactive elements, no completion evidence'
          );
          this.notify();
          return;
        }
      }

      // Bulletproof per-page memory reset. Element ids are re-issued on every
      // extract(), so when the page CHANGED since the step before - either the
      // URL moved (#114: explicit NAVIGATE, a navigating key/click, or a
      // programmatic location change) OR a same-URL re-render rebuilt the
      // document (#128: SPA wizard step, submit that stays on the URL,
      // framework re-mount) - all per-page interaction memory (filled/failed
      // sets, the "skip repeated action" history, the scroll guard) is stale
      // and must not leak into the new page's plan.
      //
      // #128: this runs AFTER the 0-element recovery above, so it compares
      // the SETTLED read (or the recovered one), not a transient empty read.
      // A URL change always fires; a SAME-URL change fires when the
      // document-level content signature (scrollHeight + omitted-cap, see
      // pageContentSignature) differs. A plain scroll keeps both invariant,
      // so the #62 cross-scroll "already filled" persistence is preserved -
      // only a genuine re-render clears the memory.
      const signature = pageContentSignature(pageContext);
      const urlChanged = this.lastExtractUrl !== null && pageUrl !== this.lastExtractUrl;
      const contentChanged =
        this.lastExtractSignature !== null && signature !== this.lastExtractSignature;
      if (urlChanged || contentChanged) {
        const why =
          urlChanged && contentChanged
            ? `url ${this.lastExtractUrl?.split('/').pop()} -> ${pageUrl.split('/').pop()} + content`
            : urlChanged
              ? `url ${this.lastExtractUrl?.split('/').pop()} -> ${pageUrl.split('/').pop()}`
              : `content re-rendered (height ${this.lastExtractSignature} -> ${signature})`;
        this.log(`🧭 Page changed (${why}) - clearing per-page interaction memory`);
        this.clearPageScopedElementMemory();
      }
      this.lastExtractUrl = pageUrl;
      this.lastExtractSignature = signature;

      const inputFields = elements.filter((e) => e.role === 'textbox' || e.tag === 'input');
      const buttons = elements.filter((e) => e.role === 'button' || e.tag === 'button');
      const selects = elements.filter((e) => e.tag === 'select' || e.type === 'select-one');
      this.log(
        `Elements: ${elements.length} total (${inputFields.length} inputs, ${selects.length} selects, ${buttons.length} buttons)`
      );

      // Dynamic step budget, clamped to the session's shared budget.
      if (currentStep === 1 || maxSteps === 15) {
        const calculated = calculateMaxSteps(inputFields.length, selects.length, buttons.length);
        const sessionMax = sessionId
          ? (d.sessionManager.getContext(sessionId)?.maxSteps ?? calculated)
          : calculated;
        maxSteps = Math.min(sessionMax, calculated, 100);
        this.state.maxSteps = maxSteps;
        this.log(
          `Calculated max steps: ${maxSteps} (need to fill ${inputFields.length + selects.length} fields)`
        );
      }

      const history = buildPlanHistory(this.filledIds, this.failedIds, this.failedErrors);
      const guard = guardOutboundPlan({
        task: d.task,
        elements: elements as Record<string, unknown>[],
        context: pageContext ?? undefined,
        profile: d.profile,
        history,
        passThrough: {
          step: currentStep,
          inputCount: inputFields.length,
          buttonCount: buttons.length,
          url: pageUrl,
          title: pageTitle,
          // Cross-page task checklist - the planner's running "what's done /
          // what's left" memory. Feeding it back stops the thrashing bug where
          // it re-did already-completed sub-goals after every navigation.
          checklist: this.checklist.length
            ? this.checklist.map((c) => ({
                id: c.id,
                description: c.description ?? '',
                done: c.done,
              }))
            : undefined,
          // NPTEL "post-verify" signal: the runner has detected the planner
          // re-issuing the same no-op action with no page change. A PII-safe
          // warning (streak count + the action shape only, never values) so
          // the planner SEES the loop and switches tactics (e.g. submit the
          // filled search box instead of re-typing it). Absent when not looping.
          loopWarning:
            this.repeatedStreak >= 2
              ? `The same action has been skipped ${this.repeatedStreak} consecutive times with no page change. Repeating it will do nothing. Switch to a DIFFERENT action - e.g. submit a filled search box (KEY "Enter" or CLICK the submit button), or click a visible result link. Typing the same value again is not progress.`
              : undefined,
          // #141 cross-tab orchestrator (P1). Two optional sections, both
          // PII-safe: the live open-tab list (url + title so the planner can
          // target a SWITCH_TAB by hint) and the on-device handoff memory
          // (token + label ONLY - handoffForPlanner strips the values, so
          // harvested data never crosses to the LLM). Both are omitted when
          // the task is single-tab (no openTabs provider / empty handoff),
          // keeping the /plan payload byte-identical for existing runs.
          ...(d.openTabs ? { openTabs: await d.openTabs() } : {}),
          ...(d.crossTabMemory ? { crossTabMemory: handoffForPlanner(d.crossTabMemory()) } : {}),
        },
      });
      if (guard.blocked) {
        this.log(
          `⛔ Outbound firewall blocked /plan egress: ${guard.category ?? 'PII'} at ${guard.reason ?? '?'}`
        );
        this.state.status = 'failed';
        this.state.running = false;
        this.finishSession(sessionId, 'outbound firewall blocked');
        this.notify();
        return;
      }
      if (guard.redactedCount > 0)
        this.log(`Masked ${guard.redactedCount} PII field(s) before /plan egress`);

      let plan: any;
      try {
        plan = await withTimeout(
          d.fetchPlan(guard.payload, d.abortSignal),
          this.eventTimeoutMs(),
          'planner event'
        );
      } catch (e) {
        if (e instanceof EventTimeoutError) {
          this.consecutiveEventTimeouts += 1;
          this.log(
            `⏱ ${e.message} - treating step as no-op ` +
              `(consecutive timeouts ${this.consecutiveEventTimeouts}/3)`
          );
          if (this.consecutiveEventTimeouts >= 3) {
            this.log('⚠️ Stalled: 3 consecutive planner events timed out - stopping');
            this.state.status = 'failed';
            this.state.running = false;
            this.finishSession(sessionId, 'stalled: repeated per-event timeouts');
            this.notify();
            return;
          }
          this.state.step = currentStep;
          this.notify();
          continue;
        }
        throw e; // a non-timeout error propagates as before
      }
      // A timely plan is progress - the stall streak is reset.
      this.consecutiveEventTimeouts = 0;
      if (plan == null) {
        this.log('Planner error: no response (server offline or aborted)');
        break;
      }
      const action: AgentActionLike | undefined = plan.action;

      // Merge the planner's returned checklist into the runner's authoritative
      // one (cross-page memory). done is sticky, new sub-goals are appended.
      const incoming =
        plan && Array.isArray(plan.checklist)
          ? (plan.checklist as Array<Partial<ChecklistItem>>)
          : [];
      this.checklist = mergeChecklist(this.checklist, incoming);

      // #100 fast path: deterministic URL/title backstop. A flaky planner that
      // drops the checklist JSON on degraded steps leaves items open forever
      // even when the target page is already on screen. Confirm each open item
      // against the CURRENT page (no LLM, no model) so the DONE gate can
      // self-satisfy; a miss is always "not done" (we keep looping).
      if (this.checklist.length > 0 && (pageUrl || pageTitle)) {
        for (const item of this.checklist) {
          if (item.done) continue;
          const verdict = goalBackstop({ item, url: pageUrl, title: pageTitle });
          if (verdict.done) {
            item.done = true;
            this.log(`👁 Backstop confirmed item "${item.id}" (${verdict.reason}) - marked done`);
          }
        }
      }

      if (this.checklist.length > 0) {
        const doneCount = this.checklist.filter((c) => c.done).length;
        this.log(`Checklist: ${doneCount}/${this.checklist.length} done`);
      }

      if (plan.degraded)
        this.log(`⚠️ Planner degraded: ${plan.degraded_reason ?? 'no LLM reachable'}`);
      this.log(`Planner returned: ${action?.type ?? 'NONE'}`);

      if (!action || action.type === 'DONE') {
        const undone = this.checklist.filter((c) => !c.done);
        if (plan.degraded) {
          this.log(
            '⚠️ Stopping: planner signaled DONE while DEGRADED (no LLM / heuristic) — task NOT genuinely complete'
          );
          this.plannerDegraded = true;
          this.state.degraded = true;
          break;
        }
        // Checklist gate: a DONE is only trusted when the task decomposition
        // is fully satisfied. If the planner blurted DONE while sub-goals are
        // still open, do NOT break - keep looping so the remaining items get
        // reached. But cap the streak: if the planner keeps blurring DONE
        // without advancing the checklist, stop spinning the budget and
        // complete best-effort with a clear warning.
        if (this.checklist.length > 0 && undone.length > 0) {
          this.doneWithOpenStreak += 1;
          if (this.doneWithOpenStreak >= 3) {
            const open = undone.map((c) => c.description || c.id).join('; ');
            this.log(
              `⚠️ Planner stuck at DONE with ${undone.length} open item(s) (${open}) - completing best-effort`
            );
            this.plannerDegraded = true;
            this.state.degraded = true;
            break;
          }
          const open = undone.map((c) => c.description || c.id).join('; ');
          // #100 optional confirm: before we burn another strike, let the
          // on-device vision model verify the goal is actually on screen.
          // Only consulted once per DONE-burst (strike 1) - a confirmed or
          // unavailable result does not block the deterministic loop above.
          if (this.doneWithOpenStreak === 1 && d.confirmGoal) {
            this.log('🔎 Asking on-device vision to confirm open goal(s)...');
            try {
              const verdict = await withTimeout(
                d.confirmGoal({ url: pageUrl, title: pageTitle, openItems: undone }),
                this.eventTimeoutMs(),
                'VLM confirm event'
              );
              if (verdict?.confirmed) {
                // The on-device proof says the goal content IS on screen -
                // trust it for the open items (a screenshot-based check,
                // stronger than a URL/title string match).
                for (const item of undone) item.done = true;
                this.log(`✅ Vision confirmed goal on screen (${verdict.detail ?? 'on-device'})`);
                this.log('✅ Task complete (vision-confirmed all checklist items done)');
                this.doneWithOpenStreak = 0;
                break;
              } else if (verdict?.unavailableReason) {
                this.logVlmUnavailableOnce(verdict.unavailableReason);
              } else if (verdict) {
                this.log(
                  `🔎 Vision: goal not yet confirmed (${verdict.detail ?? 'inconclusive'}) - continuing`
                );
              } else {
                this.logVlmUnavailableOnce('model unavailable');
              }
            } catch (e) {
              this.log(
                `⚠️ Vision confirm failed (${e instanceof Error ? e.message : String(e)}) - continuing`
              );
            }
          }
          this.log(
            `⚠️ Planner said DONE but ${undone.length} checklist item(s) still open (${open}) - continuing (strike ${this.doneWithOpenStreak}/3)`
          );
          this.state.step = currentStep;
          this.notify();
          continue;
        }
        // Completion evidence gate: trust "all items done" only when the
        // TERMINAL sub-goal is provably on the current page (or is a
        // non-destination action goal the URL/title can't express). A planner
        // that over-claims DONE on the wrong page reopens the terminal item
        // and keeps the loop alive, so the next plan is nudged to actually
        // reach the goal. Bounded, so a stuck planner ends best-effort rather
        // than spinning the step budget forever.
        const terminalItem = this.checklist.length
          ? this.checklist[this.checklist.length - 1]
          : null;
        if (terminalItem && (pageUrl || pageTitle)) {
          const gate = gateTerminalCompletion({
            terminalItem,
            url: pageUrl,
            title: pageTitle,
          });
          if (gate.block) {
            if (this.terminalGateStreak >= AgentRunner.TERMINAL_GATE_MAX) {
              this.log(
                `⚠️ Terminal goal "${terminalItem.description ?? terminalItem.id}" not provably on this page after ${this.terminalGateStreak} rejections - completing best-effort (degraded)`
              );
              this.plannerDegraded = true;
              this.state.degraded = true;
              break;
            }
            this.terminalGateStreak += 1;
            terminalItem.done = false;
            this.log(
              `🚫 Terminal goal "${terminalItem.description ?? terminalItem.id}" not provably on this page (${gate.reason}) - reopened, keeping the loop alive`
            );
            this.state.step = currentStep;
            this.notify();
            continue;
          }
        }
        this.log('✅ Task complete (all checklist items done)');
        break;
      }

      // A real (non-DONE) action means the planner is progressing - clear the
      // stuck-streak so a flaky mid-run blur doesn't accumulate toward the cap.
      this.doneWithOpenStreak = 0;

      // Loop detection - a repeated action (same target+type, and same value
      // for value-bearing types) is skipped + marked done.
      if (isRepeatedAction(this.recentActionHistory, action)) {
        this.repeatedStreak += 1;
        this.log(
          `⚠️ Skipping repeated action on element #${action.targetId} (${this.repeatedStreak} in a row)`
        );
        this.filledIds.add(String(action.targetId));
        this.recentActionHistory.push({
          targetId: String(action.targetId),
          type: action.type,
          value: action.value,
        });
        this.state.step = currentStep;
        this.notify();
        continue;
      }

      // A real executed action is progress - the loop is broken.
      this.repeatedStreak = 0;
      this.consecutiveEventTimeouts = 0;
      this.terminalGateStreak = 0;
      await this.executeAction(action, d, sessionId, elements, pageUrl, pageTitle);
      this.state.step = currentStep;
      this.notify();

      // #100 PROACTIVE goal verification (user direction 2026-09-17): after
      // every successful action, ask the on-device VLM "is the FINAL goal on
      // screen RIGHT NOW?". If it confirms, stop HERE - before the next
      // (unnecessary) LLM plan call. It reads the LIVE visible screen
      // (captureVisibleTab -> Florence OCR, never leaves the device), so it
      // sees the page the action just landed on even though the loop's
      // pageUrl/title vars are still the pre-action ones. Throttled by
      // goalCheckEvery (default = every action).
      //
      // We test ONLY the final sub-goal - the last checklist entry - not every
      // open item: intermediate sub-goals are waypoints we pass THROUGH, not
      // places to stop. Only the ultimate destination ends the task.
      this.actionsSinceGoalCheck += 1;
      const every = Math.max(1, d.goalCheckEvery ?? 1);
      // Read as a plain string: executeAction above may set the status to
      // 'failed' (scroll-storm / navigate-fail), which TS's flow-narrowing on
      // `this.state.status` doesn't track here. The guard still applies at
      // runtime - we just can't let TS prove it away.
      const status: string = this.state.status;
      if (
        d.confirmGoal &&
        status !== 'failed' &&
        status !== 'stopped' &&
        this.actionsSinceGoalCheck >= every
      ) {
        this.actionsSinceGoalCheck = 0;
        // Shortcut: the deterministic backstop already proved every item is on
        // this page - no VLM call needed.
        if (this.checklist.length > 0 && this.checklist.every((c) => c.done)) {
          this.log('✅ All checklist items done (backstop) - stopping early');
          break;
        }
        const goalItem: ChecklistItem = this.checklist.length
          ? this.checklist[this.checklist.length - 1]
          : { id: 'task', description: d.task, done: false };
        if (!goalItem.done) {
          try {
            const v = await withTimeout(
              d.confirmGoal({ url: pageUrl, title: pageTitle, openItems: [goalItem] }),
              this.eventTimeoutMs(),
              'VLM confirm event'
            );
            if (v?.confirmed) {
              const g = this.checklist.find((c) => c.id === goalItem.id);
              if (g) g.done = true;
              this.log(
                `✅ VLM confirmed final goal on screen after ${action.type} - stopping early (${v.detail ?? 'on-device'})`
              );
              break;
            } else if (v?.unavailableReason) {
              // Model was unavailable - carry on on the deterministic
              // backstop, but say WHY once per run (not every step).
              this.logVlmUnavailableOnce(v.unavailableReason);
            } else if (v) {
              // Model ran and looked at the screen, but the goal is NOT there
              // yet - keep going. Logged so a human can see the VLM actively
              // checking (and saying no) rather than the loop just guessing.
              this.log(
                `🔎 VLM checked screen after ${action.type}: goal not on screen yet (${v.detail ?? 'not visible'}) - continuing`
              );
            } else {
              // null = the on-device model was unavailable. The loop carries
              // on on the deterministic backstop - say so once per run.
              this.logVlmUnavailableOnce('model unavailable');
            }
          } catch (e) {
            if (e instanceof EventTimeoutError) {
              this.log(
                `🔎 VLM confirm after ${action.type} timed out (${e.ms}ms) - continuing on backstop`
              );
            } else {
              this.log(`🔎 VLM check after ${action.type} threw - continuing on backstop`);
            }
          }
        }
      }

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
    elements?: ElementLike[],
    pageUrl?: string,
    _pageTitle?: string
  ): Promise<void> {
    // #102: profile-token resolution, ON-DEVICE and at execution time. The
    // planner saw only the token (the outbound guard masks raw values before
    // egress and advertises which field each token means via profileHints);
    // the real constant never crosses to the LLM. Resolve it here so the
    // executor types the user's actual value, not "Test Data". Log the
    // TOKEN, not the resolved value (the value is personal data - keep it
    // out of the activity log too).
    // #102 C1 fix: remember what the planner emitted BEFORE on-device profile
    // resolution. The activity log must show the TOKEN the planner saw, never
    // the resolved personal value (email/phone/address). For non-profile tasks
    // this is just the task-relevant value (already visible to the user in the
    // plan), so the log stays useful without leaking a resolved PII value.
    const emittedValue = action.value;
    if (d.profile && action.value !== undefined) {
      const resolved = resolveProfileValue(action.value, d.profile);
      if (resolved !== undefined && resolved !== '') {
        this.log(
          `🔑 Resolving profile token ${emittedValue?.trim() ?? ''} on-device for element #${action.targetId ?? '?'}`
        );
        action.value = resolved;
      }
    }

    // #141: cross-tab handoff tokens, resolved ON-DEVICE at execution time
    // (like #102 profile tokens). The planner saw only the token + label -
    // the /plan crossTabMemory section is values-free - so the harvested
    // value never crossed to the LLM; type the real value here. Log the
    // TOKEN, not the value (it can be personal data).
    if (d.crossTabMemory && action.value !== undefined) {
      const resolved = resolveHandoffValue(action.value, d.crossTabMemory());
      if (resolved !== undefined) {
        this.log(
          `🔗 Resolving cross-tab token ${emittedValue?.trim() ?? ''} on-device for element #${action.targetId ?? '?'}`
        );
        action.value = resolved;
      }
    }

    const recordFailure = (id: string, err?: string) => {
      this.failedIds.add(id);
      this.failedErrors.set(id, err ?? 'unknown');
      if (sessionId) d.sessionManager.recordFailedElement(sessionId, id);
    };

    // #143 outbound-send gate (P2): before executing a send-classified action
    // on a user opt-in outbound domain, PAUSE for a human. The allowlist is
    // user opt-in; absent/empty -> the gate is fully off (zero change). The
    // staged value shown to the user is the on-device-resolved value (display
    // only) - the planner LLM never saw it (the #102/#141 token firewall
    // holds through the gate).
    if (d.outboundGate) {
      const gate = d.outboundGate;
      const allowlist = await gate.allowlist();
      if (allowlist.length > 0) {
        const hit = classifyOutboundSend(action, pageUrl, elements, allowlist);
        if (hit.gated) {
          const dest = await gate.destination();
          const staged = stageOutbound(hit, action, dest.url, dest.title, action.value);
          this.log(
            `⏸ Awaiting your confirmation to send to ${staged.destinationTitle || staged.destinationUrl} (${hit.reason})`
          );
          this.state.status = 'awaiting-confirmation';
          this.state.awaiting = staged;
          this.notify();
          const decision = await gate.awaitConfirmation(staged);
          this.state.awaiting = undefined;
          if (decision.stopRequested) {
            // ⏹ Stop the whole run at the gate. The loop breaks next and
            // finishes the session 'stopped' (see run()'s flag check).
            this.log('⏹ Stopped at the outbound gate');
            this.state.status = 'stopped';
            this.state.running = false;
            this.outboundGateStopped = true;
            this.notify();
            return;
          }
          if (!decision.confirmed) {
            // ↔ Dismiss: abort JUST this send step. The completed reads/fills
            // are preserved; the run exits best-effort (complete, not failed)
            // so the rest of the task state is kept - see run()'s flag check.
            this.log('↩️ Outbound send dismissed - skipping this step (completed work preserved)');
            this.state.status = 'complete';
            this.state.running = false;
            this.outboundGateDismissed = true;
            this.notify();
            return;
          }
          // Confirmed: proceed to execute the single send step below.
          this.log('✅ Outbound send confirmed - executing');
          this.state.status = 'running';
        }
      }
    }

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
      // C1: log the planner-emitted value (a token for profile tasks), never
      // the on-device-resolved personal value.
      this.log(`Typing: "${emittedValue}" into element #${action.targetId}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Typed successfully');
        this.filledIds.add(String(action.targetId));
      } else {
        this.log(`❌ Type failed: ${r?.error ?? 'unknown'}`);
        recordFailure(String(action.targetId), r?.error);
      }
      this.recentActionHistory.push({
        targetId: String(action.targetId),
        type: 'TYPE',
        value: action.value,
      });
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
          this.clearPageScopedElementMemory();
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
      // C1: log the planner-emitted value, never the resolved personal value.
      this.log(`Selecting "${emittedValue}" in element #${action.targetId}`);
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Selected successfully');
        this.filledIds.add(String(action.targetId));
      } else {
        this.log(`❌ Select failed: ${r?.error ?? 'unknown'}`);
        recordFailure(String(action.targetId), r?.error);
      }
      this.recentActionHistory.push({
        targetId: String(action.targetId),
        type: 'SELECT',
        value: action.value,
      });
      return;
    }

    if (action.type === 'KEY') {
      this.scrollGuard.noteOtherAction();
      const key = action.key || 'Enter';
      this.log(
        `⌨️ Pressing key "${key}"${action.targetId !== undefined ? ` on element #${action.targetId}` : ''}`
      );
      const r = await d.execute(action);
      if (r?.ok) {
        this.log('✅ Key pressed successfully');
        // A key that navigates drops the content port; the SW reports that as
        // ok:true with a "page navigated" note (#86) - reset per-page state.
        if (r.note && /navigat/i.test(r.note)) {
          this.log('🧭 Key triggered a navigation - re-planning on the new page');
          this.scrollGuard.noteOtherAction();
          this.recentActionHistory = [];
          this.clearPageScopedElementMemory();
          await d.delay(600);
        }
        this.recentActionHistory.push({
          targetId: String(action.targetId ?? 'focus'),
          type: 'KEY',
        });
      } else {
        this.log(`❌ Key press failed: ${r?.error ?? 'unknown'}`);
        this.recentActionHistory.push({
          targetId: String(action.targetId ?? 'focus'),
          type: 'KEY',
        });
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

    if (action.type === 'SWITCH_TAB') {
      // #141 P1: hop to another OPEN tab (exact tabId, or urlHint matched by
      // the SW against open web tabs). The channel activates the tab, waits
      // for it to be usable, and re-perceives it next loop. A switch is a
      // page-change: clear every per-page element memory (the new tab issues
      // fresh ids) exactly like NAVIGATE does.
      const where =
        action.tabId !== undefined ? `tab ${action.tabId}` : (action.urlHint ?? 'active web tab');
      this.log(`⇄ Switching to ${where}`);
      const r = await d.execute({
        type: 'SWITCH_TAB',
        tabId: action.tabId,
        urlHint: action.urlHint,
      });
      if (r?.ok) {
        this.log('✅ Switched tab (re-perceiving the new tab)');
        this.scrollGuard.noteOtherAction();
        this.recentActionHistory = [];
        this.clearPageScopedElementMemory();
        await d.delay(600);
      } else {
        this.log(`❌ Tab switch failed: ${r?.error ?? 'unknown'}`);
        this.state.status = 'failed';
      }
      return;
    }

    // M2 (C1-adjacent): never dump the whole action JSON - it can carry the
    // (post-resolution) value and the target URL, both PII-bearing. Log only
    // the safe structural fields the operator needs to debug an unknown type.
    this.log(
      `Unknown action type "${String(action.type)}" (target #${action.targetId ?? '?'}) - ignoring`
    );
  }

  /**
   * Clear the element memories that are only valid WITHIN one page's
   * extraction. Numeric element ids are re-issued on every extract, so
   * "element #2 was filled / failed" is a lie the moment the URL changes -
   * and buildPlanHistory feeds those lies straight to the planner, steering
   * it away from the correct element on the new page (observed live 2026-09-20:
   * after navigating to an article, the planner was told old-page ids were
   * already done and re-typed stale sub-goals). recentActionHistory was
   * already cleared at the same sites; these sets were the leak.
   */
  private clearPageScopedElementMemory(): void {
    this.filledIds.clear();
    this.failedIds.clear();
    this.failedErrors.clear();
    this.recentActionHistory = [];
    this.repeatedStreak = 0;
    this.scrollGuard.noteOtherAction();
  }

  // URL the last extract() came from. Element ids are re-issued per page, so
  // a URL change invalidates every per-page memory (see clearPageScoped...).
  private lastExtractUrl: string | null = null;
  // #128: document-level content signature of the last extract() (see
  // pageContentSignature). Catches same-URL re-renders that re-issue element
  // ids - the URL-only check above misses them.
  private lastExtractSignature: string | null = null;

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
