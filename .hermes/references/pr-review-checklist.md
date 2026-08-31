# SIH2026 PS171 — PR Review Checklist

## Pre-Merge Checklist

### 1. WXT Entrypoint Structure (CRITICAL)
- [ ] Files are flat in `src/entrypoints/` (NOT nested `src/entrypoints/*/main.ts`)
- [ ] `src/entrypoints/background.ts` exports `defineBackground({...})`
- [ ] `src/entrypoints/content.ts` exports `defineContentScript({...})`
- [ ] `src/entrypoints/popup/index.html` + `src/entrypoints/popup/main.tsx`
- [ ] `src/entrypoints/popup/index.html` references `./main.tsx` via `<script type="module">`
- [ ] **No stale copies**: `src/background/` and `src/popup/` directories should NOT coexist with `src/entrypoints/` — WXT only reads `src/entrypoints/`
- [ ] Build passes: `npm run build`

### 2. Browser API Compatibility
- [ ] NO `chrome.*` APIs used anywhere in `src/` (use `browser.*` from `wxt/browser`)
- [ ] Storage: `browser.storage.sync` / `browser.storage.local` (not `chrome.storage`)
- [ ] Runtime: `browser.runtime.onMessage`, `browser.tabs.sendMessage`
- [ ] Tabs: `browser.tabs.executeScript`, `browser.tabs.captureVisibleTab`
- [ ] Import paths use `'wxt/browser'` for `browser` namespace and `'wxt/sandbox'` for decorators

### 3. Firefox Compatibility
- [ ] Firefox build succeeds: `npx wxt build -b firefox`
- [ ] WebGPU fallback implemented (WASM path) for Firefox
- [ ] Manifest compatible with Firefox's MV2 requirements
- [ ] No Chrome-unique APIs (e.g., `chrome.alarms`, `chrome.devtools`)
- [ ] `__SERVER_URL__` compile-time constant is resolved correctly in Firefox build

### 4. PII Safety (CRITICAL — Regulatory)
- [ ] **NO** `element.value` reading on text/password inputs outside of `password`-type guard checks
- [ ] Only attributes (`name`, `id`, `type`, `role`, `aria-*`) and `textContent` read from DOM
- [ ] Text scrubbing uses global regex flags (`/g`) so all occurrences are replaced
- [ ] Raw HTML is never transmitted to the server
- [ ] Screen reader / a11y tree sent instead of raw DOM
- [ ] Detected PII values are masked before inclusion in any payload
- [ ] Password fields: overlay/redact, never expose content
- [ ] Selector generation does not leak PII (uses id/class/XPath, not value)

### 5. Duplicate / Stale Code
- [ ] No duplicate logic between `src/background/index.ts` and `src/entrypoints/background.ts`
- [ ] No orphaned directories (`src/background/`, `src/popup/`) that shadow or duplicate `src/entrypoints/`
- [ ] Git: confirm stale files are removed from `.gitignore` or deleted, not just ignored

### 6. TypeScript Quality
- [ ] No bare `any` types in new code (use proper interfaces — e.g., `PIIDetection`, `InteractiveElement`)
- [ ] All imports have corresponding type declarations (check `@types/chrome` vs custom types)
- [ ] Build has zero TypeScript errors: `npx tsc --noEmit`
- [ ] `Record<string, any>` — prefer specific key types where possible
- [ ] `useRef<any>` — type the ref with the correct element/model type

### 7. Security — Message Passing & Script Injection
- [ ] Content script validates message shape (`isAgentRequest`-style guards)
- [ ] Background script validates `sender.tab?.id` before acting
- [ ] Injected script code uses `JSON.stringify()` for embedding user-provided text (not string interpolation)
- [ ] `browser.tabs.executeScript` code strings do not concatenate untrusted input directly
- [ ] No `javascript:` URLs accepted in navigation actions
- [ ] `fetch` to server uses `__SERVER_URL__` compile-time constant, not runtime user input

### 8. Performance
- [ ] Lazy model loading — vision model (Florence-2) not loaded on extension startup
- [ ] Memory pool for tensors within budget (~200 MB)
- [ ] DOM extraction budget: profiler warns if > 10 ms (see `dom.ts:171`)
- [ ] Vision processing budget: profiler warns if > 1000 ms
- [ ] No blocking operations in content script `main()` (use async/return Promise)
- [ ] `setTimeout` timers cleaned up in `finally` blocks (see `actions.ts:205`)

### 9. Testing
- [ ] New PII patterns include unit tests for edge cases (partial matches, mixed content)
- [ ] Action execution tests cover stale element scenario (`isConnected` check)
- [ ] Content script message handler tests for unknown/invalid message types
- [ ] Background script tests for failed server responses and tab validation

### 10. Documentation
- [ ] Public APIs (lib functions) have JSDoc comments
- [ ] Non-obvious logic has "why" comments (e.g., `actions.ts:60` — React native setter bypass)
- [ ] README updated if behaviour changed (build commands, dev workflow)
- [ ] `.hermes/references/pr-review-checklist.md` updated if new checklist categories are needed

---

## Common Mistakes to Avoid

1. **Nested entrypoints**: `src/entrypoints/background/main.ts` ❌ → `src/entrypoints/background.ts` ✅
2. **Stale duplicate dirs**: `src/background/` or `src/popup/` shadowing `src/entrypoints/` — WXT only reads `entrypoints/`
3. **Chrome-specific APIs**: Always use `browser.*` not `chrome.*` (checked via grep)
4. **Single PII match**: Use `/pattern/g` not `/pattern/` for text scrubbing
5. **Hardcoded true/false**: Return actual values from injected scripts, not literals
6. **Top-level await in content scripts**: Move delays to service worker, not content scripts
7. **String interpolation in executeScript**: Always use `JSON.stringify()` for text content
8. **Leaving `any` types**: Replace with proper interfaces from `src/types/index.ts`

---

## Build Commands

```bash
# Chrome build
npm run build

# Firefox build (must pass before merge)
npx wxt build -b firefox

# Dev mode (runs server + extension)
npm run dev

# TypeScript check without emitting
npx tsc --noEmit

# Verify no chrome.* usage
grep -rn "chrome\." src/ --include="*.ts" --include="*.tsx"
```

---

## Severity Reference

| Icon | Level | Blocks merge? |
|------|-------|--------------|
| 🔴 | Critical | Yes — security, data loss, crashes |
| ⚠️ | Warning | Yes — bugs, missing error handling |
| 💡 | Suggestion | No — style, refactoring, docs |
| ✅ | Good | N/A — call out clean patterns |
