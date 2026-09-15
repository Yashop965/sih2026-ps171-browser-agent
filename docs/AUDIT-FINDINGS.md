# SIH2026 PS171 — Code / UI-UX / Agent-Logic Audit

Full read-only audit of the live agent (extension `src/` + planner `server/`),
UI (`src/popup`, `src/components`), and security/robustness. Every finding is
sourced to a real file + line. Severities: **P0** = breaks the agent / a
privacy promise, **P1** = degrades reliability, **P2** = polish / test / dead-code.

> Note: three parallel audit subagents (agnes-3.0-flash) were dispatched but all
> stalled on the model API with zero artifacts written; this audit was completed
> directly against source. Nothing below is asserted without a file+line.

---

## 1. Agent functional logic (the "decide & act" loop)

### P0-A1 — The agent is blind below the fold; it cannot scroll to reveal off-screen form fields
This is the exact behaviour Yash reported ("fill a form with mock data and it
does not scroll"). Three compounding causes:

- `src/lib/dom.ts:203` — `if (!isVisible(el, rect)) continue;` → `extract()`
  returns **only viewport-visible** elements. A long form's lower fields are
  simply not in the planner's element list.
- `src/popup/Popup.tsx:91-99` — the loop reads `snapshot.elements` only. The
  content script **does** compute `getPageContext()` (`dom.ts:235` →
  `scrollY`, `document.body.scrollHeight`, `viewport`) but the popup **drops
  `snapshot.context`**, so the planner never learns the page is taller than the
  viewport.
- `server/planner.py` (prompt rule 5): *"Only use SCROLL if there are NO
  visible input fields"* and a post-processing override (planner.py:438-445)
  that **rewrites SCROLL→TYPE whenever any input field is visible**. So even
  if the planner wanted to scroll, the model is told not to while fields are
  visible.

Net effect: agent fills the first screenful, sees no *visible* inputs left, and
stops — it has no "more content below" signal. Model choice (agnes / qwen /
cloud) cannot fix this; it is an observation-gap, not a reasoning-gap.

**Repro:** any multi-section form; ask "fill with mock data"; fields past the
fold are never filled; no scroll issued.

**Fix (model-independent):**
1. Send `moreContentBelow = (scrollY + viewport.height) < scrollHeight` +
   `visibleUnfilled` into the `/plan` payload (one line in `getPageContext`
   consumers, two in Popup.tsx).
2. For form-fill, walk the form's input set **in DOM order** rather than
   viewport order; auto-scroll to reveal the next field.
3. Make form-filling a **deterministic sub-strategy** (fill → auto-scroll →
   submit); the LLM only does label→value matching, not the navigation.

---

### P1-A2 — `stableId` is coordinate-based, so it is *not* stable across the scroll the agent needs
`src/lib/dom.ts:207` — `stableId = ${label}_${rect.left.toFixed(0)}_${rect.top.toFixed(0)}`.
The x/y are the element's **current** screen position. After any scroll, the same
element's `rect.top` changes → it gets a *different* stableId. That breaks the
popup's `filledIds` / `recentActionHistory` tracking (`Popup.tsx:78,124,191`)
across re-extractions following a scroll, so the agent can re-fill or
mis-track fields it just filled.

**Fix:** derive stableId from a content invariant (tag + name/id + nearest
heading/order index), not from live pixel coordinates.

---

### P1-A3 — Popup reports *failed* types to the planner as "OK"
`src/popup/Popup.tsx:124` — `history = filledIds.map(id => ({ targetId: id, result: 'OK' }))`.
But `filledIds` is added on **both** the success and failure branches
(`Popup.tsx:191` and `:196`). A field the agent failed to type into is sent to
the planner as "OK / already filled" → the planner skips it → it stays
permanently wrong, with no retry.

**Fix:** track success vs failure separately; send `result:'FAILED'` (and the
error) for failed types so the planner can re-plan or escalate.

---

### P1-A4 — `executeWithRetry` / `executeWithResilience` blind-retry a stale element
`src/lib/actions.ts:220-258`. If the first `execute()` fails because the element
is stale/gone (`resolve` throws "element not found / stale", `actions.ts:40,48`),
the retry loop re-runs the *same* targetId 3× — which just throws the same error
again. Nothing triggers a **re-extract** to re-register the element; the element
is simply gone. Wastes ~1.4 s of backoff per failure and then opens the breaker
on a dead element.

**Fix:** on "not found / stale" errors, break the retry and signal the planner to
re-extract, instead of re-acting on the same id.

---

### P1-A5 — `waitForCondition` is a no-op
`src/entrypoints/background.ts:472-480` — ignores the `condition` string entirely;
always a blind 1 s `setTimeout` then returns `true`. Any planner WAIT therefore
becomes an unconditional 1 s wait, never actually waiting for the condition.

**Fix:** implement the condition (DOM predicate / selector) or drop WAIT and map
the planner to a real poll.

---

### P1-A6 — The background `EXECUTE_ACTION` path is dead (and carries a latent injection)
`src/entrypoints/background.ts:413-451` — `clickElement` / `typeInElement` run
`document.querySelector('[data-agent-id="${elementId}"]')`. **Nothing in the
repo writes a `data-agent-id` attribute** (grep: zero writers), so this whole
background execution path can never find an element. The **live** execution path
is the content-script `EXECUTE` → `executeWithResilience` using the element
registry (`actions.ts:33-37`). Two parallel execution paths exist and the
background one is dormant.

Secondary: `elementId` is string-interpolated into the injected `executeScript`
code (`background.ts:416,437`). `typeInElement` JSON-stringifies the text, but
the `elementId` is raw — if it ever came from the LLM it is a script-injection
vector into the page context.

**Fix:** delete the dead path (or unify on the registry), and if it must stay,
inject elementId as a data argument, never interpolated into the script string.

---

### P1-A7 — `__SERVER_URL__` is referenced but never defined → the CAPTURE_AND_SEND fetch fails
`src/entrypoints/background.ts:389` — `const serverUrl = __SERVER_URL__;`.
No `define` for `__SERVER_URL__` exists in `wxt.config.ts` / Vite /
`package.json`, and `src/env.d.ts` declares only `SERVER_URL` and
`VITE_SERVER_URL` (not `__SERVER_URL__`). At build time the identifier is
`undefined`, so `fetch("undefined/plan")` (the `CAPTURE_AND_SEND` egress) fails
silently into the "Server unavailable" catch. AUDIT_REPORT/PRD note the
"no HTTPS enforcement" gap, but the more fundamental problem is that the symbol
isn't a valid constant at all.

**Fix:** define it via Vite `define`/env (e.g. `import.meta.env.VITE_SERVER_URL`),
add the `https:` startup check, and remove the undefined-symbol reference.

---

### P1-A8 — LLM-init failure silently degrades to a mock "DONE"
`server/main.py:44-46` — if the real LLM client fails to init, the planner is
swapped for `MockLLMClient`, which always returns
`{"type":"DONE","reasoning":"Mock fallback planner execution"}`
(`server/llm_clients` `MockLLMClient`, planner.py:61). The agent then reports
the task "complete" instantly with no error surfaced to the user. A broken
planner looks like a successful no-op.

**Fix:** don't silently substitute DONE; surface the fallback state (and the
reason) to the UI so "server offline / planner degraded" is visible.

---

### P0-A10 — The configured cloud planner is shadowed: `/plan` never calls the cloud model
`server/main.py:35-46` carefully builds the planner from env
(`LLM_PROVIDER`/`LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` → cloud Agnes endpoint),
but **line 186 reassigns the module global**: `planner = ActionPlanner()`.
That no-arg constructor defaults to `provider="auto"`, `api_url=None`,
`api_key=None`, `model=None` (`planner.py:67-88`), so with no custom config
`create_llm_client("auto")` falls back to `OllamaClient` — and if Ollama is
down, to `MockLLMClient` (always-DONE). **Result: whatever cloud model the
user configured (e.g. agnes-2.5-flash) is never used; every `/plan` call
silently goes to Ollama or the mock.** This is the concrete cause of "we used
the cloud model as planner but it still didn't behave / it wasn't called."
The `logger.info("Using LLM provider: ...")` line (planner.py ~438) would
confirm the active client on any run.

**Fix:** delete the second `planner = ActionPlanner()` (main.py:186); keep only
the configured one, and log the resolved provider/model at startup.

---

### P1-A9 — Session manager / `isTaskViable` / `maxSteps` gating is disconnected from the live loop
`src/lib/sessionManager.ts` is a full multi-site session system, but `grep`
finds **no live caller** of `START_SESSION` / `startSession` in the UI, and the
popup runs its own local `currentStep`/`maxSteps`/`filledIds`
(`Popup.tsx:76-118`) that ignores `SessionManager.isTaskViable`/`maxSteps`.
So the shipped "Multi-Site Session Manager" feature (closed issue #53) is
largely orphaned from the actual agent loop.

**Fix:** drive the loop through `SessionManager` (viability check per step,
shared step budget) or remove the dead wiring so it stops reading as a feature.

---

## 2. UI / UX

### P1-U1 — No way to cancel a running task
`src/popup/Popup.tsx` — `grep -c "cancel|abort|stopTask|Stop"` = 0. While
`isRunning` the Start button just disables; there is no Stop/Cancel control and
no abort signal on the `while (currentStep < maxSteps)` loop or its `fetch`.
A user who starts the wrong task (or a runaway scroll) cannot stop it.

**Fix:** add a Stop button that sets an `AbortController` / `stopRequested`
flag checked at the top of the loop and used by the fetch.

---

### P1-U2 — Agent task state is lost when the popup closes
The entire agent loop, `filledIds`, `recentActionHistory`, `maxSteps` live in
popup React state (`Popup.tsx:76-80`). Extension popups unmount on close, so
closing the tab-button mid-task silently aborts it — no completion, no abort,
nothing background-owned. (Related to P0: the loop should be background/SW-owned
with the popup as a view.)

**Fix:** move task state into the background service worker; popup renders state
and can safely close.

---

### P2-U3 — Orphaned UI components shipped in the build
`src/components/TaskPanel.tsx` and `src/components/LatencyHUD.tsx` have **no
importers** (grep). They reference `state.step`/`state.maxSteps`
(`TaskPanel.tsx:40,172`) but nothing renders them in the live popup. Dead UI
bloats the bundle and misrepresents what the product shows.

**Fix:** wire them in or remove them.

---

### P2-U4 — Resource monitor polls every 2 s while the popup is open
`src/hooks/useSystemResources.ts:103` — `setInterval(updateResources, 2000)`,
mounted at the top of the popup (`Popup.tsx:258`), so the popup CPU-polls the
whole session. It is cleared on unmount (`:105`, no leak) but it's constant work
in a tiny popup. Also verify `Heatmap`/`SoMOverlay` for overflow + z-index on a
60-detection page.

**Fix:** poll on-demand or use a coarse timer; gate the HUD behind an open
toggle.

---

## 3. Security / robustness

### P0-S1 — The live popup `/plan` egress bypasses the outbound PII firewall
The "last line of defence" firewall `checkOutboundPayload`
(`src/lib/pii/firewall.ts`) runs **only** in the background `CAPTURE_AND_SEND`
path (`src/entrypoints/background.ts:272`). The **live** loop instead runs
`src/popup/Popup.tsx:127` → `fetch(${serverUrl}/plan)` with the raw `elements`
(DOM labels / names from `capturePage`) — **no redaction, no firewall** on that
payload. So the two egress paths disagree on privacy guarantees; the one the
product actually uses does not scrub labels/placeholders/task-text that can
carry PII before leaving the device. This directly undercuts the "0 PII crosses
the line" claim.

**Fix:** route the popup egress through the same `redactString` +
`checkOutboundPayload` pipeline (or have the popup POST to background which
already does it). Verify this is the live path before shipping.

---

### P1-S2 — Privacy ledger is in-memory only; wiped on SW restart
`src/entrypoints/background.ts:20-22,511` — `privacyLedger` / `auditLedger`
are plain in-SW singletons (`PrivacyLedger.entries`, `audit.ts:151`
`this.entries=[]`). They live in the service-worker heap and are **recreated
empty on every SW start / reload**. The "tamper-proof SHA-256 ledger export"
(`src/lib/ledgerClient.ts`) is therefore only meaningful within one SW
lifetime; a judge who reloads the extension gets an empty ledger.

**Fix:** persist ledger entries to `chrome.storage.local` (the report's
"tamper-proof" only holds if the store is durable).

---

### P1-S3 — Latent script-injection via `elementId` in the background execute path
(Covered under P1-A6.) `elementId` is interpolated raw into
`browser.tabs.executeScript` code (`background.ts:416,437`). Dormant today
because `data-agent-id` is never written, but a real injection vector if that
path is ever activated with LLM-sourced ids.

**Fix:** pass elementId as an injected data argument; never splice it into the
script string.

---

### P2-S4 — MV3 SW idle-termination has no keepalive for long ops
`background.ts` `VISION_EXTRACT` / `CAPTURE_AND_SEND` async handlers run in the
SW and return `true`. A long Florence-2 init / capture could outlive the SW idle
timeout with **no `chrome.alarms` keepalive and no offscreen document**.

**Fix:** add an alarm-based keepalive (or an offscreen document) for in-flight
vision/capture work.

---

### P2-S5 — Loop-detection test is self-referential
`tests/loop-detection.test.ts` imports nothing from the app and tests a local
mock `actionHistory` array. The real loop detection is **inline in
`Popup.tsx:156-172`** (slice(-5) compare of last action). The "loop-detection
module" the filename implies does not exist; the test verifies a copy-paste
stub, not the shipping logic.

**Fix:** extract the loop logic into a testable module and point the test at it.

---

### P2-S6 — Test gaps for a security/robustness reviewer
- No negative test that the **popup egress path** fires the firewall (P0-S1).
- No test that survives an MV3 SW restart (ledger durability, P1-S2).
- No test that `waitForCondition` actually waits (P1-A5).
- No test that a failed TYPE is *not* reported as OK to the planner (P1-A3).

---

## Findings summary

| id | file | sev | one-line |
|----|------|-----|----------|
| A1 | dom.ts:203 / Popup.tsx:91 / planner.py | P0 | Agent blind below the fold; can't scroll to reveal off-screen form fields |
| S1 | Popup.tsx:127 vs background.ts:272 | P0 | Live popup `/plan` egress bypasses the outbound PII firewall (firewall sits in the dead CAPTURE_AND_SEND path) |
| A10 | main.py:186 | P0 | `planner = ActionPlanner()` shadows the configured cloud planner → /plan never calls the cloud model |
| A2 | dom.ts:207 | P1 | stableId is coordinate-based → not stable across the scroll the agent needs |
| A3 | Popup.tsx:124 | P1 | Failed TYPEs reported to planner as OK (no retry) |
| A4 | actions.ts:220 | P1 | Retries a stale element instead of re-extracting |
| A5 | background.ts:472 | P1 | waitForCondition is a no-op (blind 1 s) |
| A6 | background.ts:413 | P1 | Background EXECUTE_ACTION path is dead (data-agent-id never written) + latent injection |
| A7 | background.ts:389 | P1 | `__SERVER_URL__` undefined → CAPTURE_AND_SEND fetch fails at runtime |
| A8 | main.py:44 | P1 | LLM-init failure silently degrades to mock DONE |
| A9 | sessionManager.ts | P1 | Session manager / step gating disconnected from the live loop |
| U1 | Popup.tsx | P1 | No cancel/stop for a running task |
| U2 | Popup.tsx | P1 | Task state lost when the popup closes |
| S2 | background.ts:511 | P1 | Privacy ledger is in-memory only; wiped on SW restart |
| S3 | background.ts:416 | P1 | Latent elementId script-injection in background path |
| U3 | TaskPanel/LatencyHUD | P2 | Orphaned UI components shipped unused |
| U4 | useSystemResources:103 | P2 | 2 s resource poll while popup open; heatmap 60-detection overflow |
| S4 | background.ts | P2 | No SW keepalive for long vision/capture ops |
| S5 | tests/loop-detection | P2 | Loop-detection test is self-referential (no module) |
| S6 | tests/ | P2 | No negative firewall / SW-restart / wait / failed-type tests |
