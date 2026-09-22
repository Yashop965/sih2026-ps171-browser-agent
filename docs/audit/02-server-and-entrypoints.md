# 02 — Server & Entrypoints: Audit + Module Reference

Scope: `server/*.py` (FastAPI planner on :8000), `src/entrypoints/**` (background SW, content script,
popup), `public/*.html`, `wxt.config.ts`. Read-only audit; no source modified.

---

## PART 1 — AUDIT

### 1.1 API contracts

**`GET /health`** — `server/main.py:222`
Request: none. Response `HealthResponse` (main.py:203–207):
```json
{"status":"healthy","version":"1.0.0","models_loaded":["action_planner"],"uptime_seconds":12.34}
```
`models_loaded` is hardcoded (main.py:227) regardless of which LLM client is actually active (the
real client is printed at startup, main.py:52).
- [MEDIUM] `/health` never reflects LLM availability — `planner.health_check()`
  (planner.py:912–914) exists but is not wired to any endpoint. The popup's "Live/Dead" dot
  (Popup.tsx:48–63) only proves TCP reachability of the planner, not of the LLM.

**`POST /plan`** — `server/main.py:232`
Request `PlanRequest` (main.py:125–145): flat or nested shape, all optional:
`task | task_description`, `elements | interactiveElements[]` (InteractiveElement, main.py:78–86),
`url`, `title`, `timestamp`, `accessibilityTree[]` (ARIAElement, main.py:89–96),
`detectedPII[]` (DetectedPII, main.py:99–104), `history[]`, `step`, `inputCount`, `buttonCount`,
`context` (page geometry: scrollY/scrollHeight/viewport/moreContentBelow/omitted), `checklist[]`.
Response `PlanResponse` (main.py:184–200):
```json
{"success":true,"action":{"type":"TYPE","targetId":3,"value":"x"},"message":"...","error":null,
 "reasoning":"...","confidence":0.85,"session_id":"abc12345","timestamp":1753…,
 "checklist":[{"id":"1","description":"...","done":true}],
 "degraded":false,"degraded_reason":null}
```
`action` follows `ActionSchema` (planner.py:27–40): `type ∈ {CLICK,TYPE,SCROLL,SELECT,NAVIGATE,
WAIT,KEY,DONE}` + `targetId, value, scrollDirection, scrollAmount, url, waitMs, key`.
Errors are returned as `200` with `success:false` (main.py:291–301), never as HTTP errors.
- [LOW] `error=str(e)` leaks raw server exception text into responses (main.py:296).
- [MEDIUM] `session_id` is generated but `session_store` is never populated, so
  `GET /sessions/{id}` (main.py:340–345) can only ever 404 — dead endpoint; the in-memory
  store is also the shape of an unbounded-write hazard if it were wired.

**`POST /verify-pii`** — `server/main.py:304`
Request: reuses `PlanRequest` (shape above). Response (main.py:321):
`{"session_id":"…","verifications":[{"type":"EMAIL","verified":false,"confidence":0.7,"category":"Contact Information"}]}`.
Verification logic: only `PASSWORD_FIELD`/`FACE` count as verified @0.99; everything else 0.7
(main.py:365–368) — i.e. "verified" is a category table, not an actual re-check.
- [LOW] No dedicated request model; sends the whole PlanRequest schema where only
  `detectedPII[]` is read (main.py:312).

**`POST /execute`** — `server/main.py:324`
Request: free `Dict[str,Any]`, reads `type` + `targetId`. Response:
`{"success":true,"action_type":…,"target_id":…,"result":"executed"}`.
- [MEDIUM] Pure stub — always claims `success:true` without executing anything (main.py:332–337).
  Not called by the extension (execution happens in the content script), but any external caller
  gets a false "executed" receipt. Misleading API surface for a judge demo.

**`GET /sessions/{session_id}`** — `server/main.py:340` (see above).

Middleware chain (order matters; outermost last added — main.py:62–73):
`StructuredLoggingMiddleware` (JSON logs to `logs/agent.log`, 7-day rotation,
middleware/logging.py:48–64), `RateLimitingMiddleware` (100 req/min/IP sliding window,
middleware/validators.py:43–65), `PayloadSizeLimitMiddleware` (50 KB, validators.py:9–33),
then CORS.
- [MEDIUM] Rate-limit store `rate_limit_store` (validators.py:41) is a plain dict keyed by
  client IP, never evicted → unbounded memory growth over a long-running judge session.
- [LOW] Payload cap is enforced via the `Content-Length` header only (validators.py:13–15);
  chunked encodings escape it (acknowledged in the comment at validators.py:30–31).
  Browser fetches always send Content-Length, so impact is low.

### 1.2 LLM call path

Factory: `create_llm_client(provider, api_url, api_key, model)` (llm_clients/__init__.py:13–58).
`provider="auto"` (default, main.py:30) → `CustomEndpointClient` wrapped in `OllamaFallbackClient`
(__init__.py:50–52). If config is missing, `ActionPlanner.__init__` degrades to `MockLLMClient`
(planner.py:108–123) and flags every result `degraded=true` (planner.py:891–896) — documented in
the response contract (main.py:195–200).

`CustomEndpointClient.generate` (llm_clients/custom_endpoint.py:51–96):
- POST `{LLM_API_URL}/chat/completions`, OpenAI-compatible, Bearer auth.
- `temperature: 0.1` (custom_endpoint.py:75), `max_tokens: 2000` (custom_endpoint.py:81 — raised
  from 500 after reasoning models truncated JSON mid-object, see comment custom_endpoint.py:76–80).
- Retried via `with_retry(post, attempts=4, timeout=30.0)` (custom_endpoint.py:90–92):
  exponential backoff 1s/2s/4s… capped 30s + 0.5s jitter; honors `Retry-After` capped at 60s
  (retry.py:50–64); retries only 429 + 5xx (`RETRYABLE_STATUS`, retry.py:23); permanent 4xx
  (bad key/model) propagates immediately (retry.py:134–137). All-exhausted → `LLMRateLimitError`
  (retry.py:26–36) → planner degrades to the conservative fallback (planner.py:899–910).
- Worst-case wall time per `/plan`: ~4 × 30s timeouts + backoff ≈ 2 min; `/plan` has no
  global per-request timeout.
- [MEDIUM] No server-side timeout wrapper on the `/plan` handler (main.py:256) — a client that
  waits through the full retry ladder blocks a uvicorn worker for up to ~2 minutes per call.

`OllamaClient.generate` (llm_clients/ollama_client.py:40–73): POST `/api/generate`,
`num_predict: 500` (line 57), 60s per-attempt timeout (line 68), same retry ladder.
- [LOW] Ollama fallback is capped at 500 tokens vs 2000 for custom — a reasoning model on
  Ollama will truncate more often; not a bug, but the fallback is strictly weaker.
- `MultiProviderRouter` (custom_endpoint.py:116–176) exists but is **not used** by the factory —
  dead code; the only active multi-provider path is `OllamaFallbackClient`
  (ollama_client.py:101–136), which probes health before routing.

Action validation in `parse_llm_output` (planner.py:335–516): JSON substring extraction
(marked fence or first balanced `{...}`, planner.py:556–571); type normalized to the 8 valid
verbs (planner.py:351–356); string/stableId `targetId` resolved against the element registry
(planner.py:358–386); `WAIT.waitMs` clamped to 0–30000 (planner.py:440–444); `NAVIGATE` without
url and `KEY` with an unknown target degrade to the conservative fallback (planner.py:473–489).
Post-processing: a `SCROLL` is overridden to `TYPE` the first **unfilled** input when one is
visible (planner.py:865–886); `degraded` is force-set for mock results (planner.py:894–896).
Planner rules 1–19 live in `build_context_prompt` (planner.py:258–280), incl. rule 19
(empty-looking page after NAVIGATE → `WAIT` ~1000 ms, planner.py:280).
- [LOW] `parse_llm_output` accepts `targetId` strings that map to no element and *silently
  drops the target* (planner.py:377–381) producing a target-less CLICK/TYPE that the
  fallback then converts — only logged, not surfaced in `degraded_reason`.

### 1.3 Security boundaries

**CORS / egress.**
- [MEDIUM] `CORSMiddleware(allow_origins=["*"], allow_credentials=True)` (main.py:67–73):
  the combination is spec-invalid (browsers drop `*` with credentials) and signals intent
  without effect; there is no auth anywhere, and uvicorn binds `0.0.0.0` (main.py:374,
  server/__main__.py:13) — any web page on the LAN can POST `/plan` and burn LLM quota.
  Acceptable for the judged local-only demo; document the bind.
- [INFO] Single intended egress for page data is `localhost:8000` → LLM provider. The
  extension's only network origin in the manifest is `http://localhost:8000/*`
  (wxt.config.ts:15–17); Florence-2 OCR/screenshots stay on-device (content.ts:140–148,
  background.ts:233–237).

**PII in planner payloads.**
- Labels: `maskLabel` is the only egress path for element labels
  (`src/lib/dom.ts:122–131`, "every label leaves through here" dom.ts:133–136; the runner's
  outbound guard reports `Masked N PII field(s) before /plan egress`, agentRunner.ts:540).
- [MEDIUM] **Page title is unmasked** — `build_context_prompt` injects `PAGE TITLE: {title}`
  (planner.py:238) straight into the LLM prompt; `document.title` (content.ts:57) commonly
  carries PII (Gmail subject lines, account names). No masking on the server side.
- [LOW] **URL path** egresses verbatim after query stripping (content.ts:52–53, planner.py:237);
  paths like `/users/12345` are identifiers, not redacted.
- [LOW] Password field labels are redacted to `[redacted password field]`
  (planner.py:159–160) and password targets only get confidence 0.5 + annotation
  (planner.py:462–468) — the value, not the field, is what is protected; the prompt itself
  still ships the label shape.
- [INFO] PII detection records never store the matched value — "there is deliberately no
  `value` field" (content.ts:668–678; `record()` drops raw, content.ts:483–492). Good.
- [LOW] `history[].error` strings are pasted into the prompt unmasked (planner.py:195) —
  currently executor-generated, low risk, but an unvetted channel.
- [MEDIUM] Popup persists the LLM `apiKey` in plaintext `browser.storage.local`
  (Popup.tsx:193) on a shared machine; the key never leaves the machine, but at-rest
  unencrypted in extension storage.

**host_permissions footprint.**
- [MEDIUM] Session notes claim the manifest "now declares `<all_urls>` host_permissions for
  `captureVisibleTab`", but `wxt.config.ts:15–17` and the built
  `dist/chrome-mv3/manifest.json` both show only `["http://localhost:8000/*"]`.
  `captureVisibleTab` (background.ts:595) is legally covered by `activeTab` (manifest
  permissions, wxt.config.ts:9) when granted by user gesture; the SW-driven `confirmGoal`
  capture path (background.ts:244–250) reuses that grant. Verify which behavior was intended —
  the note and the code disagree, and the dist manifest is stale (rebuild needed to match).

### 1.4 Message-passing contracts

**popup ⇄ background** (`browser.runtime.sendMessage`; background listener at background.ts:340–559):
| msg | dir | payload → result | where |
|---|---|---|---|
| `START_TASK` | P→B | `{task, startUrl}` → `{ok:true, running:true}` (immediate; runner is fire-and-forget) | background.ts:538–543; Popup.tsx:122–126 |
| `STOP_TASK` | P→B | `{}` → `{ok:true}`; sets stopFlag + aborts in-flight `/plan` | background.ts:545–549; Popup.tsx:138 |
| `GET_TASK_STATE` | P→B | `{}` → `AgentTaskState` | background.ts:551–553; Popup.tsx:107 |
| `TASK_PROGRESS` | B→P (broadcast) | `{type, state}`; persisted to `storage.local` first | background.ts:101–108; Popup.tsx:101–113 |
| `EXTRACT` | P→B | `{}` → `{ok, elements[], context, url, title}` | background.ts:364–406 |
| `EXECUTE` | P→B | `{action}` → executor result | background.ts:408–459 |
| `NAVIGATE_TAB` | P→B | `{url}` → `{ok, url}`; http(s)-only guard | background.ts:461–507 |
| `VISION_EXTRACT` / `VISION_OCR` | B→C relay | `{}` → `{ok, elements?, context?, vision?}` / `{ok, text?}` | background.ts:344–362; content.ts:351–363 |
| `CAPTURE_SCREENSHOT` | C→B | `{}` → `{dataUrl}` | content.ts:94,155; background.ts:523,590–600 |
| `GET_PRIVACY_LEDGER` / `GET_AUDIT_LOG` / `CLEAR_LEDGER` | P→B | ledger entries / `{success}` | background.ts:509–521 |
| `START/UPDATE/COMPLETE/GET_SESSION` | C/P→B | session ops, maxSteps default 50 | background.ts:526–536, 699–761 |

- [MEDIUM] `START_TASK` acks `{running:true}` before the runner can fail (background.ts:541–543);
  a load-error only surfaces later via a `TASK_PROGRESS` `failed` broadcast — the popup's
  start handler treats the ack as success (Popup.tsx:127–131).
- [LOW] The second listener (`ACTION_RESULT`, background.ts:582–586) maintains a vestigial
  `AgentState` — nobody sends `ACTION_RESULT` in the current flow.

**background → content** (tab messaging via `resolveWebTab`, background.ts:613–634 — never
targets the extension's own pages):
| msg | dir | payload → result | where |
|---|---|---|---|
| `capturePage` | B→C | `{}` → `SanitizedDOMSnapshot{url(title),title,timestamp,accessibilityTree,interactiveElements,detectedPII,context}` | content.ts:347–349; shape content.ts:635–646 |
| `EXTRACT` | B→C | `{}` → `{ok, elements, context}` (DOM-only fast path) | content.ts:324–329 |
| `EXECUTE` | B→C | `{action:Action}` → `{ok, error?, note?}`; navigation-disconnects are classified as success | content.ts:332–341; background.ts:170–186,440–453 |
| `VISION_EXTRACT` | B→C | `{}` → `{ok, elements, context, vision{used,boxes?}}` — screenshot only when DOM < 3 elements | content.ts:351–353; threshold content.ts:88 |
| `VISION_OCR` | B→C | `{}` → `{ok, text?}` — OCR text only, pixels never leave the SW/C pair | content.ts:355–363 |
| `HIGHLIGHT` | P/C→C | `{selector}` → `{ok}`; outline div excludes itself from extraction | content.ts:281–316 |
| `SCRUB_PII` | window.postMessage | `{type, html}` → `{type:'SCRUBBED', html}` | content.ts:373–378 |

Content script injects on `<all_urls>` (content.ts:39; manifest content_scripts,
dist manifest.json) with **no host_permissions** — allowed for MV3 content scripts; it cannot
fetch cross-origin without a declared host, which keeps egress to localhost-only.

### 1.5 Manifest / permission justification

`wxt.config.ts:6–18` (built: `dist/chrome-mv3/manifest.json`):
| permission | used by | justification / gap |
|---|---|---|
| `activeTab` | `captureVisibleTab` on gesture (background.ts:595) | Grants host access to the active tab on user action — covers the screenshot capture without `<all_urls>` |
| `tabs` | `tabs.query/update/onUpdated` (background.ts:124, 203, 562–579) | Needed: the runner resolves the active web tab and waits for load (`waitForTabLoad`, background.ts:647–683). `tabs` (not just `tabStrip`) is required for `url` in query results — `resolveWebTab` filters on `tab.url` (background.ts:626–632), which demands the `tabs` permission |
| `storage` | ledgers, task state, popup prefs (background.ts:35, 96, 25–30 Popup) | MV3 local storage for write-through persistence |
| `scripting` | declared but **unused** — content scripts are manifest-injected (`matches:[<all_urls>]`); no `executeScript` call found in src/ | [LOW] Remove `scripting` from the manifest to shrink the permission footprint |
| `alarms` | SW keepalive for long ops (#75) (background.ts:60–79) | 30 s recurring keepalive while a vision op is in flight; `periodInMinutes: 0.5` is the minimum Chrome allows |
| `host: localhost:8000/*` | `fetch('/plan')` (background.ts:215–231; Popup.tsx:52–62 health) | Only network origin the extension talks to |
- [LOW] Dev hook `window.__agent` is stripped in production builds (content.ts:383–394) — no
  prod exposure.
- `public/*.html` (mock-form, pii-test-page, e2e-test-page, mock/government-portal) are
  local test fixtures loaded via `chrome-extension://` or file://; they exercise the
  `<all_urls>` content injection but ship no logic — judge-facing demo pages only.

### 1.6 Findings index (severity-tagged, file:line)

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | HIGH | CORS `*`+credentials on an unauthenticated 0.0.0.0:8000 bind — any LAN page can POST /plan and consume LLM quota | main.py:67–73, 374 |
| 2 | MEDIUM | `/health` never reflects the active LLM client; `planner.health_check()` unwired; "Live" dot proves only TCP reachability | main.py:222–229; planner.py:912 |
| 3 | MEDIUM | Page **title** egresses unmasked into the LLM prompt; URL query stripped but path kept | planner.py:238; content.ts:52–57 |
| 4 | MEDIUM | `/execute` stub always reports `success:true` without executing; `/sessions` can only 404 (store never written) | main.py:324–345 |
| 5 | MEDIUM | No server-side timeout on `/plan`; full retry ladder (~4×30 s + backoff) blocks a worker up to ~2 min | custom_endpoint.py:90–92; retry.py:50–64 |
| 6 | MEDIUM | Rate-limit dict keyed by IP is never evicted → unbounded growth | validators.py:41 |
| 7 | MEDIUM | LLM API key persisted plaintext in `browser.storage.local` | Popup.tsx:193 |
| 8 | MEDIUM | Manifest/note mismatch: session context claims `<all_urls>` host_permissions; source + dist have only `localhost:8000` (capture relies on `activeTab`); dist manifest stale | wxt.config.ts:15–17; dist/chrome-mv3/manifest.json |
| 9 | MEDIUM | `START_TASK` acks `running:true` before the runner is proven alive; failures only surface via later broadcast | background.ts:538–543 |
| 10 | MEDIUM | `degraded` flag hides the failure reason in some paths: unknown stableId target dropped silently, CLICK still emitted target-less | planner.py:377–381 |
| 11 | LOW | `error=str(e)` leaks raw exception text in `/plan` responses | main.py:296 |
| 12 | LOW | `session_store` dead; `/verify-pii` reuses `PlanRequest` schema; `verified` is a lookup table, not a re-check | main.py:212, 304–321, 365–368 |
| 13 | LOW | 50 KB cap is Content-Length-only; chunked bodies bypass | validators.py:13–31 |
| 14 | LOW | Ollama fallback (num_predict 500) is strictly weaker than custom (2000); `MultiProviderRouter` unused | ollama_client.py:57; custom_endpoint.py:116 |
| 15 | LOW | `scripting` permission declared, unused in src/ | wxt.config.ts:12 |
| 16 | LOW | `VISION_OCR` returns on-screen OCR text to the SW (may contain PII); kept in SW memory only — never egressed, but not in any ledger | background.ts:238–264; content.ts:149–175 |
| 17 | LOW | Vestigial `ACTION_RESULT` listener + `AgentState` | background.ts:582–586 |
| 18 | LOW | Dev `__agent` console hook (dead-code-eliminated in prod) | content.ts:383–394 |
| 19 | LOW | URL path egresses as-is (post-query-strip) — path segments can be identifiers | content.ts:52–53 |
| 20 | LOW | `history[].error` pasted into prompt unmasked | planner.py:195 |
| 21 | INFO | Password labels redacted in-prompt; password targets down-weighted to 0.5 confidence | planner.py:159–160, 462–468 |
| 22 | INFO | PII detection records intentionally omit matched values; checksums run before discard | content.ts:471–501, 668–678 |
| 23 | INFO | `activeTab` covers `captureVisibleTab` on gesture; SW-driven captures reuse the grant | background.ts:590–600; wxt.config.ts:9 |
| 24 | INFO | Keepalive alarm bounded to in-flight ops; cleared on drain | background.ts:59–79 |

---

## PART 2 — MODULE REFERENCE

### Entrypoints

| Module | Role | Key responsibilities |
|---|---|---|
| `src/entrypoints/background.ts` | MV3 service worker; **single source of truth for the agent loop** | Message routing (30+ types, background.ts:340–559); SW-owned `AgentRunner` (#71) with extract/execute/navigate/fetchPlan channels (background.ts:123–231); `captureVisibleTab` screenshot capture (background.ts:590–600); on-device `confirmGoal` OCR backstop (#100, background.ts:238–264); keepalive alarms (#75, background.ts:59–79); privacy + audit ledgers persisted to `storage.local` (#72, background.ts:30–49); `resolveWebTab` guard so the agent never acts on extension pages (background.ts:613–634); session management (background.ts:699–761) |
| `src/entrypoints/content.ts` | Page-injected extractor + executor (`<all_urls>`) | DOM/a11y capture with URL query-stripping (content.ts:47–68); PII detector with Verhoeff/Luhn/PAN checksums, no value storage (content.ts:399–632); resilient action execution w/ circuit breaker (content.ts:332–341); Florence-2 vision: `extractWithVision` fallback when DOM < 3 elements (content.ts:74–137) and `ocrVisibleScreen` on-device OCR (#100, content.ts:149–175 — pixels never leave the device); `maskLabel` boundary (content.ts:233); PII scrub bridge via `window.postMessage` (content.ts:373–378) |
| `src/entrypoints/popup/main.tsx` | React popup mount | Thin `ReactDOM` mount of `src/popup/Popup.tsx` (main.tsx:5–8) |
| `src/popup/Popup.tsx` | User-facing control panel | Start/stop task via `START_TASK`/`STOP_TASK`; mirrors `TASK_PROGRESS` state (Popup.tsx:77–113); `/health` poll every 10 s with latency readout (Popup.tsx:48–70); provider/key settings stored locally (Popup.tsx:160–198, 25–30); full-log copy (Popup.tsx:88–97); embedded PrivacyLedger + ResourceMonitor views |
| `public/*.html` | Demo/test fixtures | `mock-form.html`, `pii-test-page.html`, `e2e-test-page.html`, `mock/government-portal.html`, `index.html` — judge-side test targets for extraction/PII demos; no logic shipped |

### Server endpoints (API reference)

| Endpoint | Method | Request | Response | Notes |
|---|---|---|---|---|
| `/health` | GET | — | `{status, version, models_loaded[], uptime_seconds}` (main.py:203–229) | Static; does not probe the LLM |
| `/plan` | POST | `PlanRequest` (flat/nested; `task`, `interactiveElements[]`, `accessibilityTree[]`, `detectedPII[]`, `history[]`, `context`, `checklist[]`, main.py:125–145) | `PlanResponse{success, action(ActionSchema), message, error, reasoning, confidence, session_id, timestamp, checklist[], degraded, degraded_reason}` (main.py:184–301) | Errors as 200+`success:false`; ≤50 KB; 100 req/min/IP; drives the whole agent step |
| `/verify-pii` | POST | `PlanRequest` (only `detectedPII[]` read, main.py:304–321) | `{session_id, verifications[{type, verified, confidence, category}]}` | Category lookup; no re-detection |
| `/execute` | POST | `{type, targetId}` (main.py:324–337) | `{success:true, action_type, target_id, result:"executed"}` | **Stub** — always succeeds |
| `/sessions/{id}` | GET | path `session_id` (main.py:340–345) | session dict or 404 | Store never populated — always 404 |
| `POST {LLM_API_URL}/chat/completions` | (outbound) | OpenAI chat: system + user prompt, `temperature:0.1`, `max_tokens:2000` (custom_endpoint.py:69–82) | `choices[0].message.content` (JSON action) | 4 attempts, 30 s/try, exponential backoff w/ Retry-After (retry.py:50–137) |
| `POST {OLLAMA_HOST}/api/generate` | (outbound) | `{model, prompt, stream:false, options:{temperature:0.1, num_predict:500}}` (ollama_client.py:51–59) | `{response}` | Fallback client, 60 s/try |

### Config / env

| Variable | Default | Used by |
|---|---|---|
| `LLM_PROVIDER` | `auto` | `create_llm_client` (main.py:30; __init__.py:42–58) |
| `LLM_API_URL` / `LLM_API_KEY` | — (missing → mock or Ollama) | `CustomEndpointClient` (custom_endpoint.py:32–41) |
| `LLM_MODEL` | `llama-3.1-8b-instant` | `CustomEndpointClient` (custom_endpoint.py:34) |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `http://localhost:11434` / `qwen2.5:1.5b` | `OllamaClient` (ollama_client.py:29–30) |
| `SIH_LLM_RETRY_BASE_DELAY` | unset (exponential) | retry override (retry.py:91–109) |
| `SIH_LLM_RETRY_VERBOSE` | `1` | retry logging (retry.py:110) |
| `VITE_SERVER_URL` (extension) | `http://localhost:8000` | fetch targets (background.ts:216; Popup.tsx:52) |
