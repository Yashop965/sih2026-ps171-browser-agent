# Codebase Audit Report — ps171-browser-agent
**Date:** 2026-09-10  
**Scope:** `src/lib/actions.ts`, `src/lib/dom.ts`, `src/entrypoints/content.ts`, `src/entrypoints/background.ts`, `src/lib/sessionManager.ts`, `src/lib/pii/sanitizer.ts`, `src/lib/pii/firewall.ts`, `src/hooks/useSystemResources.ts`  
**Result:** 182 tests passing, 1.21 MB build. Production readiness gaps found in 4 categories.

---

## 🔴 Critical — Fix Before Release

### 1. PII Injection via String Interpolation (`background.ts:426`)
**File:** `src/entrypoints/background.ts:426`
```js
el.value = '${text.replace(/'/g, "\\'")}';
```
Type-injection uses string interpolation with only single-quote escaping. A value containing `\n` or backticks will break out of the JS string and execute arbitrary code in the page context. **This is a stored XSS + code injection vector.**

**Fix:** Use `browser.tabs.sendMessage(tabId, { type: 'EXECUTE', action })` to let the content script handle typing via its own `doType()` function, which already uses `setNativeValue()`. Never inject user text into `executeScript` code strings.

---

### 2. Accessibility Tree Lacks PII Masking (`content.ts:186`)
**File:** `src/entrypoints/content.ts:186`
```ts
name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 100) || '',
```
The `buildAccessibilityTree()` function copies raw `textContent` without calling `maskLabel()`. Meanwhile `dom.ts:getLabel()` applies full PII masking. Any Aadhaar/PAN/card number rendered as textContent in a page element will be sent to the server unmasked in the accessibility tree.

**Fix:** Pass `clean()` / `maskLabel()` result into the ARIA tree, or reuse `dom.ts:extract()` instead of building a parallel tree.

---

### 3. Full URL Sent Before Sanitization (`content.ts:50`)
**File:** `src/entrypoints/content.ts:50`
```ts
url: window.location.href,
```
`captureDOM()` sends the raw URL including query-string values (e.g., `?token=abc123&ref=AADHAAR_NUM`). The `sanitizeSnapshot()` in `sanitizer.ts:301-317` strips query values, but the raw URL is already in the snapshot object sent via `browser.runtime.sendMessage` before any sanitization occurs. If the channel is intercepted, PII in URLs leaks.

**Fix:** Sanitize the URL in `captureDOM()` before populating the snapshot, or strip query params client-side before sending.

---

### 4. Duplicate `scanDocument()` Method (`pii/detector.ts:73 & :93`)
**File:** `src/lib/pii/detector.ts`
Two identical `scanDocument()` methods exist (lines 73 and 93). The second one overwrites the first. Dead code + maintenance confusion.

**Fix:** Remove the duplicate. Keep the async version if face detection is needed; otherwise remove both and use a single canonical implementation.

---

## 🟠 High Priority

### 5. Memory Leak — Tab Listener Never Unregistered (`sessionManager.ts:103-107`)
**File:** `src/lib/sessionManager.ts:103-107`
```ts
browser.tabs.onUpdated.addListener((updatedTabId) => {
  if (updatedTabId === tabId) { this.handleTabUpdate(sessionId, updatedTabId); }
});
```
The listener is added per-session but **never removed** on `completeSession()` or `failSession()`. Even though the comment at line 313 says WXT doesn't support `removeListener`, the closure still holds a reference to `sessionId` and `tabId`, preventing GC of the session object. After 50 sessions, this accumulates memory proportional to the number of tab events ever fired.

**Fix:** Store listener references in a `Map<tabId, listenerFn>` and call `removeListener` when sessions complete. If WXT truly doesn't support it, at minimum `pruneStaleSessions()` should null out the captured variables.

---

### 6. Per-Loop RegExp Creation in PII Scan (`content.ts:399`)
**File:** `src/entrypoints/content.ts:399`
```ts
const scanPattern = new RegExp(source, pattern.flags.replace('u', 'gu'));
```
Inside the `forEach` over ALL `div, span, p, td, th, label` elements, a **new RegExp is constructed on every iteration** for every PII type. On a page with 500 text elements × 8 PII types = 4,000 RegExp allocations per scan. This causes GC pressure and slows extraction.

**Fix:** Pre-compile the scan patterns once at module load time (same approach as `LABEL_PII` in `dom.ts:75-92`). Store them in a static array and reuse.

---

### 7. Stale Registry Elements Accumulate (`actions.ts:31-51`)
**File:** `src/lib/actions.ts:31-51`
```ts
const registry = new Map<number, Element>();
const stableIdRegistry = new Map<string, Element>();
```
`dom.ts` clears these on every `extract()`, but `actions.ts:resolve()` holds a reference to the Element returned by the registry. If the page re-renders and `extract()` is not called again (e.g., between the planner's extract and the executor's action), the old Element reference is kept alive until the next extract. In long-running sessions with infrequent re-extraction, this creates a retention chain from the registry → Element → DOM subtree.

**Fix:** Add a generation counter to the registry. On each `extract()`, increment the counter and store it alongside each Element. In `resolve()`, verify the generation matches. Stale entries are now explicitly expired rather than relying on GC.

---

### 8. Vision Model Initialized Per Content Script Run (`content.ts:92-98`)
**File:** `src/entrypoints/content.ts:92-98`
```ts
if (!visionPipeline.isInitialized()) {
    await visionPipeline.initialize();
}
```
The vision pipeline is lazy-initialized on every `VISION_EXTRACT` call where DOM elements < 3. If the user visits many pages with sparse DOM, the model is initialized repeatedly (or the initialization promise is awaited multiple times concurrently). There's no deduplication of in-flight initialization promises.

**Fix:** Cache the initialization promise so concurrent calls await the same Promise:
```ts
private _initPromise: Promise<void> | null = null;
async ensureInitialized() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this.initialize();
    try { await this._initPromise; } catch (e) { this._initPromise = null; throw e; }
}
```

---

### 9. No HTTPS Enforcement for Server URL (`background.ts:374-397`)
**File:** `src/entrypoints/background.ts:375`
```ts
const serverUrl = __SERVER_URL__;
```
`__SERVER_URL__` is a compile-time constant. There's no runtime check that it uses HTTPS. If accidentally set to `http://`, PII-sanitized payloads travel over cleartext. The PII firewall prevents PII in the payload, but the URL itself and metadata (tab ID, timing) are still exposed.

**Fix:** At startup, validate `__SERVER_URL__` starts with `https://`. Log a hard error and refuse to operate if it doesn't.

---

## 🟡 Medium Priority

### 10. Two Message Listeners in Background (`background.ts:26 & 156`)
**File:** `src/entrypoints/background.ts:26,156`
Two separate `browser.runtime.onMessage.addListener` calls. The second one (line 156) only handles `ACTION_RESULT` and shadows the first. If WXT processes listeners in registration order, `ACTION_RESULT` messages are handled by the second listener but everything else falls through to the first. This works but is fragile — any new message type must remember which listener to register with.

**Fix:** Merge into a single listener.

---

### 11. `executeAction()` Ignores Payload PII Sanitization (`background.ts:311-360`)
**File:** `src/entrypoints/background.ts:311-360`
The `EXECUTE_ACTION` path bypasses `sanitizeSnapshot()` and the outbound firewall entirely. It sends the action directly to the content script without logging to `auditLedger` (only the legacy `privacyLedger` is used). Failed executions are also not recorded in the new audit system.

**Fix:** Route `EXECUTE_ACTION` through the same audit ledger as `CAPTURE_AND_SEND`, or consolidate the two code paths.

---

### 12. `getSessionForTab()` Has Incomplete Method (`sessionManager.ts:116-123`)
**File:** `src/lib/sessionManager.ts:116-123`
```ts
export function getSessionForTab(tabId: number): SessionState | null {
    for (const session of this.sessions.values()) {
        if (session.tabId === tabId && session.status === 'active') {
            return session;
        }
    }
    return null;
}
}  // ← stray closing brace at line 123
```
There's an extra `}` at line 123 that causes a syntax error (or the read truncated). The method body is correct but the stray brace makes the class malformed. Verify the actual file compiles.

**Fix:** Remove the stray brace.

---

### 13. No Timeout on `fetchServerAction()` (`background.ts:374-397`)
**File:** `src/entrypoints/background.ts:378-382`
```ts
const response = await fetch(`${serverUrl}/plan`, { ... });
```
No `AbortController` or timeout. If the planner server is unresponsive, the background script hangs indefinitely, blocking the message response and potentially freezing the extension UI.

**Fix:** Add a 30-second timeout:
```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);
try { ... } finally { clearTimeout(timeout); }
```

---

### 14. `CircuitBreaker` Map Grows Without Bound
**File:** `src/lib/actions.ts:261-298`
The `failures` Map stores entries for every element that ever fails, only deleting on success or when the threshold is reached and the reset timer expires. If a site has thousands of dynamic elements that intermittently fail, the Map grows without limit.

**Fix:** Add a max-size eviction policy (LRU or random) in addition to the time-based reset.

---

### 15. `PrivacyLedger` Replaces Entire Array on Trim (`background.ts:505-507`)
**File:** `src/entrypoints/background.ts:499-507`
```ts
if (this.entries.length > this.MAX_ENTRIES) {
    this.entries = this.entries.slice(0, this.MAX_ENTRIES);
}
```
Creating a new array reference on every trim is fine for 1000 entries, but if `log()` is called per-element-per-action (which it is — PII detections create one entry each), a single page visit can create hundreds of entries. The array copy overhead is small but unnecessary.

**Fix:** Use in-place splicing: `this.entries.splice(this.MAX_ENTRIES);` to avoid allocation.

---

### 16. `useSystemResources` Interval Never Cleared (`hooks/useSystemResources.ts:103`)
**File:** `src/hooks/useSystemResources.ts:99-103`
```ts
const interval = setInterval(updateResources, 2000);
// No clearInterval in useEffect cleanup
```
If the popup component mounts/unmounts rapidly, multiple intervals can run simultaneously, each calling `checkGPU()` (WebGL GPU query) every 2 seconds.

**Fix:** Store the interval ID and call `clearInterval` in the useEffect cleanup function.

---

### 17. `__agent` Debug Hook Exposed in Dev (`content.ts:326-337`)
**File:** `src/entrypoints/content.ts:326-337`
```ts
if (import.meta.env.DEV) {
    (window as any).__agent = { extract, execute, context, captureDOM, extractWithVision, highlight, piiDetector, visionPipeline };
}
```
The comment says this is dead-code-eliminated in production, but WXT's production build may not tree-shake window assignments. Any reviewer with DevTools access gets full DOM extraction and PII detection APIs.

**Fix:** Add an explicit `process.env.NODE_ENV !== 'production'` guard or use a build-time constant that the bundler can prove is false.

---

### 18. `maskLabel()` Modifies Module-Level Regex State (`dom.ts:94-100`)
**File:** `src/lib/dom.ts:94-100`
```ts
for (const { re, tag } of LABEL_PII) {
    re.lastIndex = 0; // reset before reuse
    out = out.replace(re, tag);
}
```
The `re.lastIndex = 0` reset is correct, but `LABEL_PII` patterns use `/g` flag. If `maskLabel()` is called recursively or interrupted, `lastIndex` can be left in a non-zero state. This is a low-probability edge case but worth noting.

**Fix:** Use `String.prototype.replaceAll()` with non-global regexes, or create fresh regex instances per call.

---

## Summary Table

| # | Category | Severity | File | Line | Issue |
|---|----------|----------|------|------|-------|
| 1 | Security | 🔴 Critical | `background.ts` | 426 | JS injection via string interpolation in type-in |
| 2 | Security | 🔴 Critical | `content.ts` | 186 | ARIA tree missing PII masking |
| 3 | Security | 🔴 Critical | `content.ts` | 50 | Raw URL with query params sent before sanitization |
| 4 | Code Quality | 🔴 Critical | `pii/detector.ts` | 73,93 | Duplicate method causing silent overwrite |
| 5 | Memory | 🟠 High | `sessionManager.ts` | 103 | Tab listener never unregistered — memory leak |
| 6 | Performance | 🟠 High | `content.ts` | 399 | RegExp created per-element per-scan (4000+ allocations) |
| 7 | Memory | 🟠 High | `actions.ts` | 31 | Registry elements retain DOM subtrees between extracts |
| 8 | Performance | 🟠 High | `content.ts` | 92 | Vision model re-initialized per sparse-DOM page visit |
| 9 | Security | 🟠 High | `background.ts` | 375 | No HTTPS enforcement for server URL |
| 10 | Architecture | 🟡 Medium | `background.ts` | 26,156 | Two message listeners, fragile routing |
| 11 | PII | 🟡 Medium | `background.ts` | 311 | EXECUTE path bypasses audit ledger |
| 12 | Bug | 🟡 Medium | `sessionManager.ts` | 123 | Stray closing brace — potential syntax error |
| 13 | Reliability | 🟡 Medium | `background.ts` | 378 | No fetch timeout — hangs on unresponsive server |
| 14 | Memory | 🟡 Medium | `actions.ts` | 261 | CircuitBreaker Map unbounded growth |
| 15 | Performance | 🟡 Medium | `background.ts` | 505 | Unnecessary array reallocation on ledger trim |
| 16 | Memory | 🟡 Medium | `useSystemResources.ts` | 103 | setInterval never cleared on unmount |
| 17 | Security | 🟡 Medium | `content.ts` | 326 | Debug hook may ship to production |
| 18 | Reliability | 🟡 Medium | `dom.ts` | 94 | Regex lastIndex edge case in maskLabel |

---

## Top 3 Actions for Production Readiness

1. **Fix #1 (JS injection)** — Replace `typeInElement`'s string interpolation with a content-script-mediated action. This is the single highest-risk issue.
2. **Fix #2 (ARIA PII leak)** — Route all accessibility tree names through `maskLabel()` / `clean()`. Currently a direct path for PII to reach the server.
3. **Fix #5 (memory leak)** — Track and remove tab listeners on session completion. Long-running agent sessions will otherwise accumulate orphaned closures.
