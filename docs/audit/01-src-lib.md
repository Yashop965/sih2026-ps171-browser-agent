# src/lib audit + module reference
Repo: ps171-browser-agent · 2026-09-22 · scope: `src/lib/**` (29 files)
No source files were modified; this doc is the only artifact.

## 1. AUDIT

Findings are most-severe-first. ~25 total (3 critical, 10 major, 12 minor).

### [C1] critical · PII in activity logs — raw post-resolution TYPE/SELECT values
- `src/lib/agentRunner.ts:801` (TYPE), `844` (SELECT)
- `executeAction` resolves the profile token on-device (lines 767–773), *then* logs the
  resolved raw value: `Typing: "${action.value}" into element #...`. The module's own
  contract (comment 760–766: "Log the TOKEN, not the resolved value") is violated: the
  user's real email/phone/address land in `state.logs` (5000-entry cap, surfaced via
  the popup Copy button, Bug D). Fix: log the pre-resolution token or a masked form.

### [C2] critical · Egress gap — non-16-digit cards pass the last line of defence
- `src/lib/pii/sanitizer.ts:58`, `src/lib/pii/firewall.ts:67`, `src/lib/pii/outboundGuard.ts:138`
- The live redactor (`PATTERNS.CREDIT_CARD`) and the firewall both hard-code the
  4-4-4-4 16-digit form. A 13/14/15/18/19-digit card (dom.ts `LABEL_PII` card rule
  covers 13–19 for labels, but task strings and element `value` do not get that range)
  is neither redacted nor firewall-blocked. Worse, `payload.history` enters the body
  un-redacted (outboundGuard.ts:138 — firewall-only, never redacted), so a raw
  15-digit card inside a history error string is POSTed to /plan.

### [C3] critical · Detection objects carry partial raw PII
- `src/lib/pii/detector.ts:232`, `275`
- Non-card detections store `value: match.slice(0,4) + '***'` — the first four *real*
  characters of an Aadhaar/phone/PAN. `fetchDetections` (ledgerClient.ts:96–102) drops
  the field, but `PIIDetection.value` remains reachable from any consumer of
  `piiManager.getDetections()` / the capturePage `detectedPII` snapshot; four real
  digits inside a "no raw PII" audit trail defeats its own guarantee.

### [M1] major · No error boundary around runner deps — run() blows out, task stuck "running"
- `src/lib/agentRunner.ts:542` (fetchPlan); also `391`/`429` (extract), `345`/`891` (navigate)
- `await d.fetchPlan(...)` (and extract/navigate) is unguarded: any rejecting dep
  (non-abort fetch failure, content-port crash) propagates out of `run()`;
  `state.running` stays true and no terminal `finishSession` (line 941) is reached,
  so the popup reports an eternally-running task.

### [M2] major · Unknown action logs full JSON including the raw value
- `src/lib/agentRunner.ts:904`
- `this.log('Unknown action: ${JSON.stringify(action)}')` dumps the whole action —
  including `value` (post profile resolution, potentially PII) and `url` — into the
  activity log.

### [M3] major · Executor errors echo the planner's value → PII-tainted history → hard firewall block
- `src/lib/actions.ts:269`, `src/lib/agentRunner.ts:808/836/851`, `src/lib/pii/outboundGuard.ts:138`
- `doSelect` throws `no option matching "${action.value}"`; the runner stores that
  string in `failedErrors` (808/836/851) → `buildPlanHistory` (511) →
  `payload.history` (un-redacted). A PII value (or a 15-digit card, see C2) in
  history then blocks the entire /plan request ("outbound firewall blocked",
  agentRunner.ts:532–539) — the task dies on a value the agent itself produced.

### [M4] major · Timeout race does not cancel the in-flight action
- `src/lib/actions.ts:560–584`
- `Promise.race([run(), timeout])`: when the 5 s bound wins, `run()` (e.g. the
  combobox settle poll, a late input dispatch) keeps running and may still land the
  action after the failure was reported; a post-race rejection of `run()` has no
  `.catch` → unhandled promise rejection.

### [M5] major · EXTRACT_CAP slices document-order *before* the visibility filter
- `src/lib/dom.ts:321–327`, `336–338`
- The 250-cap slices `allNodes` in document order, *then* the loop skips
  non-visible elements. A hidden top-of-page subtree (closed drawer/modal holding
  many controls) consumes the cap, so *on-screen* controls past node #250 are absent
  from the planner table while `omittedCount` tells it to scroll (scrolling won't
  recover them — they were cut by document order, not the fold).

### [M6] major · stableId lacks the ordinal its comment promises
- `src/lib/dom.ts:342–357`
- Comment (346–348) says the id includes "its ordinal among same-kind siblings", but
  the join (352–357) is `tag|name/for|role|label` only. Repeated form rows
  ("add another item" lists) get identical stableIds → `getElementByStableId` (49)
  returns the *last* row, and cross-scroll "already filled" tracking keyed on
  stableId collides between rows.

### [M7] major · Phone "validator" accepts any 10–15 digit number → false /plan blocks
- `src/lib/pii/validators.ts:148`, `src/lib/pii/firewall.ts:88`
- `validatePhone` ends `|| stripped.length >= 10`, so *any* 10–15 digit string is a
  "verified phone". With the firewall's unanchored `[6-9]\d{9}` pattern, benign ids
  (order numbers, batch codes, timestamps) starting 6–9 block the whole /plan
  payload (agentRunner.ts:532) — a plausible, repeatable task death.

### [M8] major · model.ts points at a repo with no ONNX weights
- `src/lib/model.ts:60/70/79` vs `src/lib/vision/florence2.ts:25–29`
- `selectModelConfig` returns `microsoft/Florence-2-base-ft`, which florence2.ts
  documents as PyTorch-only (no ONNX, verified issue #100) and instead hardcodes
  `onnx-community/Florence-2-base-ft`. Any consumer feeding `modelConfig` into the
  pipeline will fail to load; two sources of truth disagree.

### [M9] major · SessionManager tab-listener leak + same-tab crosstalk
- `src/lib/sessionManager.ts:105–111`, `191`, `322–328`
- Each `startSession` adds a *new* `browser.tabs.onUpdated` listener, but the
  `tabListeners` map is keyed by tabId, so a previous session's listener on the same
  tab is overwritten and never removed (leak). `completeSession`/`failSession` then
  call `removeTabListener(tabId)`, removing the shared listener and silently killing
  tracking for the second session too.

### [M10] major · Vision error logs are written into the null sink
- `src/lib/vision/florence2.ts:158–163`, `196–199`
- `processImage` silences `console.error` *before* the try block; the catch's
  `console.error('[Vision] Processing failed:', error)` (197) lands on the silenced
  no-op — model failures are invisible in the console (restoration happens only in
  the `finally`).

### [m1] minor · `isWebGPU()` is always false
- `src/lib/vision/florence2.ts:65`, `349–351`
- `usingWebGPU` is declared but never assigned in `initialize()` → `isWebGPU()`
  reports false even when running on WebGPU.

### [m2] minor · `VisionOptions.maxNewTokens` / `temperature` ignored
- `src/lib/vision/florence2.ts:224`
- `runTask` hardcodes `max_new_tokens: 128`; the option fields (40–45) are accepted
  but unused.

### [m3] minor · `runTask` mutates the caller's image object
- `src/lib/vision/florence2.ts:219–221`
- `img.size = [img.height, img.width]` writes a custom property onto the passed
  canvas/img element — a side effect on shared input.

### [m4] minor · `pruneStaleSessions` deletes with the wrong key
- `src/lib/sessionManager.ts:314`
- `this.tabListeners.delete(id)` uses the *session* id on a map keyed by *tab* id →
  a no-op; pruned sessions' listeners are never removed.

### [m5] minor · Unbounded session history + `''` in visitedUrls
- `src/lib/sessionManager.ts:344–353`
- `handleTabUpdate` fires on every `onUpdated` event (status/title/url) and pushes to
  `session.history` with no cap; `visitedUrls.add(tab.url || '')` pollutes the set
  with empty strings when the url is momentarily unavailable.

### [m6] minor · Over-redaction in the redact pass
- `src/lib/pii/sanitizer.ts:163–167`
- `redactString` re-runs every pattern without the scan's confidence/validation
  filter → benign 12-digit ids (Aadhaar pattern) and 16-digit runs that fail Luhn
  still become `[REDACTED]`; the planner loses benign context.

### [m7] minor · "pincode" mis-classified as a password field
- `src/lib/pii/sanitizer.ts:175`, `180–181`
- `PASSWORD_ATTRS` includes `'pin'` → any field whose name contains "pincode" is
  treated as a password field (wrong `hadPII` flag, value never considered).

### [m8] minor · Select values scanned twice
- `src/lib/pii/detector.ts:131–145`
- The interactive-elements loop (131–137, reads `el.value` = selected option value)
  and the separate select loop (140–145) scan the same value → duplicate
  detections; `dedupeAncestorDuplicates` (160–192) only collapses *ancestor*
  pairs (needs `metadata.el`, absent here), so the dupes survive.

### [m9] minor · Legacy `privacy.ts` masking can return the raw value
- `src/lib/privacy.ts:153–174`, `141`
- `maskValue`'s PHONE case only matches the grouped `+91 12345 67890` shape; any
  other phone shape the PHONE regex (33–35) matches is returned *unmasked* in a
  "masked" event. `redactPII` also replaces only the first occurrence per matched
  string (141). Legacy — CAPTURE_AND_SEND has no live callers (outboundGuard.ts:4–8)
  — latent only.

### [m10] minor · User-stop during the 0-element retry is stamped "failed"
- `src/lib/agentRunner.ts:423–427`, `442–461`
- The retry loop breaks on `d.isStopped()` (427); the subsequent `!recovered`
  branch (442) unconditionally stamps status `'failed'` + `finishSession('stalled…')`
  even when the exit was a user stop.

### [m11] minor · `revokeConsent` leaves autofill PII in storage
- `src/lib/context.ts:171–173`, `197–198`
- Revoking consent deletes only the `'profile'` storage key; `autoFillPatterns`
  (KNOWN_KEYS include raw aadhaar/pan values) survives the revocation.

### [m12] minor · Planner key names are case-sensitive
- `src/lib/actions.ts:326`, `343`, `365`
- `KEY_MAP` keys are exact (`'Enter'`, `'Tab'`); a planner emitting `'enter'` misses
  the map, falls into the single-char branch, and throws `unknown key` (365).
  The type/value gates (#122) are strict, but key-name normalization is missing.

## 2. MODULE REFERENCE

### Core agent

**dom.ts** — DOM extraction engine: finds every interactive element and returns
clean metadata (never reads `element.value`); owns the element registries, the
250-cap (`EXTRACT_CAP`), and the #118 semantic freshness guards. Key exports:
`extract()`, `getPageContext()`, `maskLabel`, `getElementById`,
`getElementByStableId`, `getGuardForId`, `getGuardForStableId`,
`captureElementGuard`, `verifyElementFreshness`, `getOmittedCount`. Depends on: nothing
(browser DOM + `CSS.escape` fallback only).

**actions.ts** — Executor for planner actions (CLICK/TYPE/SELECT/SCROLL/NAVIGATE/
WAIT/KEY/DONE) with freshness-checked `resolve()`, occlusion hit-test (#116),
the #122 TYPE value gate, the #114 Enter→`requestSubmit` fix, event-aware settle
(#119), retry wrappers, and a circuit breaker. Key exports: `Action`, `ActionResult`,
`execute`, `executeWithRetry`, `executeWithResilience`, `CircuitBreaker`,
`circuitBreaker`. Depends on: `./dom`, `./agentCursor`.

**agentRunner.ts** — The task loop, owned by the service worker (#69/#71):
per-page memory clearing on URL *and* same-URL re-render (#128 content
signature), 0-element retry + stalled status (#114), skip-repeated-action,
cross-page checklist with sticky `done` (#100), profile-token resolution at
execution time (#102), outbound guard gate, and optional on-device VLM
goal-confirmation. Key exports: `AgentRunner`, `AgentTaskState`,
`emptyTaskState`, `buildPlanHistory`, `mergeChecklist`, `pageContentSignature`,
`ChecklistItem`, re-exports from `./loopDetection`. Depends on:
`./pii/outboundGuard`, `./userProfile`, `./sessionManager`, `./loopDetection`,
`./goalBackstop`.

**agentCursor.ts** — Presentation-only computer-use cursor overlay (#101):
positions a colored arrow/ring/label over the target before each action; never
logs values, never throws. Key exports: `CursorActionKind`, `showCursor`,
`hideCursor`, `removeCursor`, `cursorLabel`, `cursorStyles`. Depends on: nothing
(document DOM only).

### PII pipeline (`src/lib/pii/`)

**outboundGuard.ts** — Live /plan egress pipeline (#61): profile-token masking →
`redactString` on task + element PII fields → whole-payload firewall; callers must
check `blocked`. Key exports: `guardOutboundPlan`, `OutboundPlanInput`,
`OutboundPlanResult`. Depends on: `./sanitizer`, `./firewall`, `../userProfile`,
`../types`.

**sanitizer.ts** — Regex + checksum PII scanning/redaction for strings, DOM
snapshots, URLs, and ARIA names; confidence-gated detection, `[REDACTED]`
replacement. Key exports: `scanString`, `redactString`, `sanitizeSnapshot`,
`isPasswordField`, `RawElement`/`RawSnapshot` types. Depends on: `./validators`,
`./types`, `../../types`.

**firewall.ts** — Last line of defence: recursive JSON walker that blocks (never
redacts) payloads containing validated/high-precision PII; capped depth (10) and
string length (10 k). Key exports: `inspectPayload`, `checkOutboundPayload`.
Depends on: `./validators`, `./types`, `../../types`.

**validators.ts** — Canonical checksum/format validators shared by the whole
privacy pipeline: Verhoeff (Aadhaar), PAN entity check, Luhn (cards), IFSC,
email/phone/UPI heuristics, plus mask helpers (`maskValue`, `maskCard`).
Depends on: nothing.

**detector.ts** — `PIIManager`: DOM scan for password fields, password-like
values, text patterns (hardened #104), select values, and faces (FaceDetector
API + heuristic fallback), with checksum verification and ancestor-dedupe. Key
exports: `PIIManager`, `piiManager` singleton, `PIIDetection`. Depends on:
`./validators`.

**audit.ts** — `PrivacyAuditLedger`: in-memory DETECTED/REDACTED/BLOCKED/SENT
event ledger (2000 cap) with an optional durability hook for
`browser.storage.local` mirking and `hydrate()` on SW restart (#72). Key exports:
`PrivacyAuditLedger`, `privacyAuditLedger`. Depends on: `./types`.

**privacyLedger.ts** — Legacy `PrivacyLogEntry` ledger (per-action rows, 1000
cap, same #72 durability/hydrate pattern) kept for the background worker's
history. Key exports: `PrivacyLedger`, `PrivacyLogEntry`. Depends on: nothing.

**redactor.ts** — `RedactionEngine`: visual redaction overlays (blackout for
passwords/API keys, backdrop-blur for faces, red "REDACTED PII" badge) on the
live DOM and on canvas regions. Key exports: `RedactionEngine`,
`redactionEngine`. Depends on: DOM only.

**types.ts** — Internal PII types: `PIIMatch`, `SanitizedElement`,
`SanitizationResult`, `AuditEvent`/`AuditEventType`, `FirewallResult`. Depends on:
`../../types` (`PIIType`).

### Vision

**vision/florence2.ts** — On-device Florence-2-base-ft pipeline via
`@huggingface/transformers` (dynamic import; WebGPU → WASM fallback): object
detection, OCR, captioning, VQA, with box/text parsing of raw model output.
Key exports: `visionPipeline` (singleton), `canvasToBlob`, `captureTabAsImage`
(always throws by design — capture belongs to the background),
`BoundingBox`/`VisionResult`/`VisionOptions` types. Depends on: nothing static
(transformers.js is lazy-imported).

**visionConfirm.ts** — Pure decision layer for the #100 on-device proof: given
OCR text of the visible screen and the open checklist items, decides whether the
goal text is actually rendered (quoted-span exact match, else order-free token
match with one-word tolerance). Key exports: `visionConfirm`, `itemTargets`,
`targetInOcr`. Depends on: `./goalBackstop` (normalize/tokens/quotedSpans).

**vision/som.ts** — Set-of-Marks renderer: fixed full-viewport canvas drawing
numbered boxes + labels for grounding/human review; re-renders on resize. Key
exports: `SomRenderer`, `somRenderer`. Depends on: DOM only.

**vision/memory.ts** — `VisionMemoryPool`: 200 MB tensor budget manager with
Float32/Uint8 buffer reuse and oldest-first pruning. Key exports:
`VisionMemoryPool`, `visionMemoryPool`. Not currently wired into florence2.ts
(dead code, accounting bugs noted in [m-series] of the audit's neighbor list —
see findings m-series above). Depends on: nothing.

**vision.ts** — Canvas/box utilities: WebGPU detection, canvas→dataURL, image→
canvas, resize-to-fit, percentage-box normalization, IoU, and NMS. Key exports:
`isWebGPUSupported`, `getAvailableBackends`, `canvasToDataURL`, `imageToCanvas`,
`resizeCanvas`, `normalizeBoxes`, `calculateIoU`, `nonMaxSuppression`. Depends
on: DOM only.

### Supporting modules

**loopDetection.ts** — Single source of truth for loop control (#76):
value-blind-safe repeat detection, field-count-based step budget, and the
consecutive-scroll guard. Key exports: `isRepeatedAction`, `calculateMaxSteps`,
`ScrollGuard`, `RecentAction`. Depends on: nothing.

**goalBackstop.ts** — Deterministic URL/title goal confirmation (#100 fast
path, no LLM): quoted-span matches first, then ≥0.8 content-token overlap; a
miss is always "not done". Key exports: `goalBackstop`, `normalize`, `tokens`,
`quotedSpans`, `contentTokens`. Depends on: nothing.

**sessionManager.ts** — Multi-tab session lifecycle (#69): start/complete/fail/
pause/resume, 30-min timeout + shared step budget (`isTaskViable`), failed-
element memory, tab-update listeners, capacity pruning. Key exports:
`SessionManager`, `sessionManager` singleton, `PageSnapshot`, `SessionState`,
`SessionContext`. Depends on: `wxt/browser`, type-only imports from `./dom` and
`./vision/florence2`.

**userProfile.ts** — #102 on-device user profile: personal constants stored in
`browser.storage.local`, egressed only as stable `<TOKEN>`s; real values resolve
on-device at execution time. Key exports: `UserProfile`, `PROFILE_TOKENS`,
`maskProfileValues`, `profileHintsForPayload`, `resolveProfileValue`,
`keyForToken`, `isProfileToken`, `loadProfile`, `saveProfile`. Depends on:
`wxt/browser` (lazy import only).

**providerConfig.ts** — LLM provider registry (custom Agnes / Ollama / Groq /
OpenRouter) with default + lookup helpers. Key exports: `PROVIDERS`,
`getDefaultProvider`, `getProvider`, `ProviderKey`. Depends on: nothing.

**profiler.ts** — Stage-latency profiler: `start`/`end` marks for
dom_extract / vision_inference / plan_response / action_execution, threshold
alerts, heap-size estimate. Key exports: `Profiler`. Depends on:
`../types` (PerfMark/Stage/PerformanceMetrics).

**portRetry.ts** — `withPortRetry`: retry wrapper for SW→content
`tabs.sendMessage` during the post-navigation port re-attach window; retries
only transient "Receiving end does not exist"-class errors, injectable clock
for tests. Key exports: `withPortRetry`, `isPortNotReady`, `PORT_NOT_READY`.
Depends on: nothing (all deps injected).

**ledgerClient.ts** — Panel-side read of the background privacy ledger:
fetch/clear, live PII detections for the active tab (value field deliberately
dropped on arrival), element highlighting, and a SHA-256-digested, URL-scrubbed
export. Key exports: `fetchEntries`, `clearLedger`, `fetchDetections`,
`highlightElement`, `summariseDetections`, `buildExport`, `downloadLedger`.
Depends on: `wxt/browser`, `../types`.

**model.ts** — Hardware detection + model/quantization selection for on-device
vision (WebGPU limits, Firefox→WASM, q4 default, 500 MB budget check). Key
exports: `detectHardware`, `selectModelConfig`, `getModelSizeEstimate`,
`isWithinMemoryBudget`, `modelConfig`. Depends on: nothing.

**context.ts** — Storage-backed context/memory system: consent-gated user
profile, recurring autofill patterns (includes aadhaar/pan keys), and multi-tab
session records, all in `browser.storage.local`. Key exports: `ProfileManager`,
`AutofillManager`, `SessionTracker`, `initContextSystem`. Depends on:
`wxt/browser`.

**privacy.ts** — *Legacy* outbound payload scanner + PII detect/redact/mask
helpers, predecessor of the `pii/` pipeline; its CAPTURE_AND_SEND path has no
live callers (see outboundGuard.ts:4–8), so treat as reference/latent. Key
exports: `scanOutboundPayload`, `detectPII`, `redactPII`, `isPasswordField`,
`createPrivacyEvent`. Depends on: `../types`.
