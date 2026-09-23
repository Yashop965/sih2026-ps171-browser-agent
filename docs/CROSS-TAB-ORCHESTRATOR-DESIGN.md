# Design — Cross-Tab Orchestrator (one task across N tabs)

**Status:** design (2026-09-24). Not started in code.
**Motivating scenario:** open a compliance sheet on tab A (watch the values it needs), fill a
Google Sheet on tab B from those values, then send that sheet to a group on WhatsApp Web on
tab C — "multiple sites at once".
**Guardrail:** anything that copies compliance/PII values across tabs stays on the existing
token/PII firewall (values cross as tokens, resolved on-device at write time; the outbound
send is a human-confirmation gate, never fire-and-forget).

---

## 1. What exists today (grounded)

| fact | where |
|---|---|
| Runner channels are **single-active-tab**: every channel does `tabs.query({active:true, currentWindow:true})` and targets *the* active tab of the current window. No tab ID is ever chosen. | `src/entrypoints/background.ts` — `extractChannel` (L123), `executeChannel` (L156), `navigateChannel` (L189), `setCursorThinking` (L219) |
| One `AgentRunner` instance = one task = one tab (`deps.tabId/windowId`), one session, one checklist. | `src/lib/agentRunner.ts` `AgentRunnerDeps` (L372), `run()` opens exactly one session (L543) |
| **Per-tab session tracking already exists** but is barely used: `SessionManager` maps tab→session, listens on `tabs.onUpdated` per tab, prunes stale, and can pause/resume. The runner only ever creates one session per run. | `src/lib/sessionManager.ts` (`getSessionForTab` L120, `handleTabUpdate` L333, `pauseSession`/`resumeSession` L217/L228) |
| Planner protocol: `/plan` with element table + checklist; actions are `NAVIGATE / CLICK / TYPE / KEY / DONE`. All act on "the current page". | `agentRunner.ts` (`AgentActionLike` L343), planner server `/plan` |
| Goal confirmation is on-device OCR of the *active* visible tab (SW `captureVisibleTab` → content OCR → text back). | `background.ts` `confirmGoal` (L251), `CAPTURE_SCREENSHOT` (L549) |

**The single-tab assumption is the one structural limit** for the scenario above. Everything
else (perceive→plan→act loop, checklist, terminal gate, stall guard) is tab-agnostic and will
reuse as-is.

## 2. Two tiers (build in order)

### Tier 1 — sequenced cross-tab (small; unblocks 90% of the scenario)

The agent works through tabs **in order**, switching explicitly between them:
"read compliance tab → switch to Sheet tab → type the values → switch to WhatsApp tab → attach + send".
No true parallelism; the user's *watch* semantics are approximated by a fresh re-perception
whenever the agent returns to a tab (which it already does — re-extract per page).

Concrete changes:

1. **New planner action `SWITCH_TAB`** (`AgentActionLike` + planner prompt doc + server `/plan`
   schema): payload `{ target: { tabId?: number; urlHint?: string } }`. Planner sees the open
   tab list (url + title, no DOM) in the payload so it can pick by hint ("the compliance tab").
2. **Channels stop hard-querying the active tab.** `background.ts` gains a `currentTargetTab`
   (starts as the active web tab — today's behavior). `SWITCH_TAB` (or a coordinator call)
   does `tabs.update(tabId, { active: true })` + wait-for-load, and `extractChannel` /
   `executeChannel` / `navigateChannel` / `confirmGoal` / `setCursorThinking` target it.
   The **invariant stays**: exactly one tab is driven at a time — Chrome foreground is one
   tab; multi-tab *driving* is never parallel.
3. **`sessionManager` gets used properly**: on each `SWITCH_TAB`, open/update a per-tab session
   (`startSession(tabId, …)` when none active for that tab). One task still spans
   N sessions; the task checklist stays on the runner (shared across its sessions) — the
   checklist is the cross-tab memory ("read the compliance values" done, "Sheet filled" open).
4. **Handoff state** (typed): `TabHandoff = { values: Record<token, string>, extractedAt, sourceTabId }`.
   Read step produces tokens (reusing the `userProfile` token convention — compliance fields
   are profile-style keys or generic `<FIELD_N>`); write/send steps resolve tokens on-device
   at `TYPE` time. Tokens are PII-safe in transit (LLM sees tokens, executor resolves).
5. **Outbound-send gate**: `WHATSAPP_SEND` (or any action classified *send-outbound*:
   submit-after-attach on a chat surface, `send` on a form) pauses the run: status
   `awaiting-confirmation`, popup shows the exact payload summary (tokens resolved for
   display only), user confirms → execute; dismiss → abort that sub-step. Never auto-send.

### Tier 2 — parallel "watch" (the real "multiple sites at once")

Layer **on top of** Tier 1. While sub-task N runs on its tab, other tabs are *watched*, not
driven:

- **Watchers**: `tabs.onUpdated` / `WebContents`-style change signals (MV3: `tabs.onUpdated`
  with `changeInfo.url/status` + optional lightweight poll of `tabs.get(tabId).title`) on the
  watched tab. A trigger (e.g. compliance tab shows a new row / URL changes) **queues a
  re-perception** of that tab.
- **Re-perception is passive**: `capturePage` on the watched tab (content script) — no cursor,
  no click, no scroll, no LLM. Extracted deltas update the handoff state.
- **Coordinator** (`TabOrchestrator`, new lib above `AgentRunner`): owns the task graph
  (ordered subtasks, each bound to a tab + entry/exit conditions), picks the next subtask whose
  preconditions are met (all watched inputs up-to-date), switches to that tab (Tier 1 path),
  runs one `AgentRunner` per subtask (they share the coordinator's handoff state + one
  task-level checklist). Invariant: **one focus tab at a time; watchers are passive; the LLM
  loop is serial** (one planner at a time — keeps the per-event timeout + terminal gate
  semantics per subtask unchanged).
- **Why not truly parallel LLM loops?** Each loop is LLM-rate-limited (~10 RPM) and
  action-conflicts on shared pages; serial subtasks with passive watchers give the UX of
  "watching everything, acting in order" without a concurrency-control rewrite.

## 3. Data model (Tier 2)

```ts
// new src/lib/tabOrchestrator.ts
interface TabRef { tabId: number; windowId: number; role: 'source' | 'sink' | 'outbound' | 'scratch'; urlHint?: string }
interface SubTask {
  id: string;
  tab: TabRef;
  description: string;           // planner task text for this subtask
  entry: { need: string[] };    // handoff tokens that must be current
  exit: { produced?: string[]; terminal?: string }; // tokens produced / goal phrase for the terminal gate
  trigger?: { urlChange?: boolean; pollMs?: number }; // watcher config (Tier 2)
}
interface TaskGraph {
  id: string; subtasks: SubTask[]; order: string[]; // topological order (entry deps)
  handoff: TabHandoff;          // shared, token-keyed
  outboundGates: string[];      // subtask ids that pause for user confirm
}
class TabOrchestrator {
  constructor(private deps: { /* channel makers per tabId, sessionManager, runSubTask(g: SubTask, sharedChecklist) */ });
  async run(graph: TaskGraph): Promise<GraphReport>; // runs subtasks in order, switches tabs, applies watchers, gates outbound
}
```

Runner reuse: `runSubTask` builds an `AgentRunner` whose channels target **that subtask's tab**
(Tier 1 change), seeded with the shared checklist + handoff. Per-subtask `terminalGate` +
`goalCheck` (on-device OCR of *that* tab via `captureVisibleTab(tabId)`) carry over unchanged.

## 4. PII / safety (non-negotiable, matches existing firewall)

- Handoff values are **tokens only** in planner payloads and cross-tab state; resolution
  happens in the executor (`TYPE`/attach step), same as the `userProfile` today (#102).
- `outbound` role tabs (WhatsApp) never auto-execute the final send: coordinator pauses with
  `awaiting-confirmation` (popup + optional notification); dismiss aborts just that step.
- Watchers are read-only on the DOM (`capturePage`); a watched tab is never scrolled/clicked
  by the agent, so "watching" can't corrupt the compliance page the user is reading.
- The 250-element table cap + PII scrubber run per watched-tab extraction too.

## 5. Phased delivery + acceptance

**P1 (sequenced, ~1 focused session):**
- `SWITCH_TAB` action + channels target `currentTargetTab` (defaults to active web tab →
  zero behavior change for today's single-tab tasks).
- Per-tab session open on switch.
- Handoff tokens read-once/write-once across two tabs.
- **Acceptance:** safe substitute 3-tab task (no real PII, no real send):
  tab A "data page" lists 3 values → agent reads + `SWITCH_TAB` → tab B form: fill 3 fields →
  `SWITCH_TAB` → tab C page: final "done" marker element. Verified: values land in B,
  single-active-tab invariant holds, sessions per tab in `sessionManager`, checklist
  cross-tab done.
- **P2 (outbound gate):** human-confirmation pause for a send-classified action on an
  `outbound`-role tab (test with a fake "send" button that logs).
- **P3 (Tier 2 watchers):** passive re-perception on URL change of a watched source tab;
  coordinator runs subtasks whose entry tokens are current; re-acceptance with P1 task plus a
  "source tab changes while working" case.

**Risks / open questions (next day):**
- Google Sheets: element table is dense (capped ~250) — cell targeting may need the on-device
  OCR fallback (issue #115) to be reliable; P1 should *not* be accepted on real Sheets until
  #115 lands. P1 acceptance uses plain forms.
- WhatsApp Web: ToS sensitivity — the outbound gate + "your explicit send" semantics are the
  minimum; consider a per-site allowlist of automation roles (user opts in per domain).
- Watcher polling cost: passive `capturePage` every N seconds per watched tab — bound to
  ≤3 watched tabs, poll ≥15s, reuse the 250-cap extraction.
- `captureVisibleTab` only captures the *focused* tab — Tier 2 "watch" of a non-focused tab
  needs DOM extraction (works) + OCR only when focused; acceptable for P3, document it.

## 6. Not in scope

- True parallel LLM loops (serial-by-design, see §2).
- Cross-*window* driving (Chrome foreground invariant: one window focused; multi-window is
  future work — note in P3).
- Multi-user / shared-orchestrator modes.
