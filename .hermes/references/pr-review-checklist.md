# SIH2026 PS171 — PR Review Checklist

## Pre-Merge Checklist

### 1. WXT Entrypoint Structure (CRITICAL)
- [ ] Files are flat in `src/entrypoints/` (NOT nested `src/entrypoints/*/main.ts`)
- [ ] `src/entrypoints/background.ts` exports `defineBackground({...})`
- [ ] `src/entrypoints/content.ts` exports `defineContentScript({...})`
- [ ] `src/entrypoints/popup/index.html` + `src/entrypoints/popup/main.tsx`
- [ ] Build passes: `npm run build`

### 2. Browser API Compatibility
- [ ] NO `chrome.*` APIs used (use `browser.*` from `wxt/browser`)
- [ ] Storage: `browser.storage.sync` / `browser.storage.local`
- [ ] Runtime: `browser.runtime.onMessage`, `browser.tabs.sendMessage`
- [ ] Tabs: `browser.tabs.executeScript`, `browser.tabs.captureVisibleTab`

### 3. Firefox Compatibility
- [ ] Test build: `npx wxt build -b firefox`
- [ ] WebGPU fallback implemented (WASM for Firefox)
- [ ] No Chrome-only APIs (e.g., `chrome.storage.sync` vs `browser.storage.sync`)
- [ ] Manifest V2 compatible (Firefox doesn't support MV3 fully)

### 4. PII Safety
- [ ] NO element.value reading (passwords, Aadhaar, PAN)
- [ ] Only attributes and textContent read
- [ ] Scrubbed HTML uses global regex flags (`/g`)
- [ ] Raw HTML never transmitted to server

### 5. TypeScript Quality
- [ ] No `any` types (use proper interfaces)
- [ ] All imports have types
- [ ] Build has zero TypeScript errors

### 6. Performance
- [ ] Lazy model loading (not on extension startup)
- [ ] Memory pool for tensors (200MB budget)
- [ ] Threshold checks in profiler (DOM < 10ms, Vision < 1000ms)

### 7. Message Passing
- [ ] Content script handles all expected message types
- [ ] Background script validates sender.tab.id
- [ ] Response sent via `sendResponse()` or returned Promise

---

## Common Mistakes to Avoid

1. **Nested entrypoints**: `src/entrypoints/background/main.ts` ❌ → `src/entrypoints/background.ts` ✅
2. **Chrome-specific APIs**: Always use `browser.*` not `chrome.*`
3. **Single PII match**: Use `/pattern/g` not `/pattern/` for text scrubbing
4. **Hardcoded true/false**: Return actual values from injected scripts
5. **Top-level await**: Move delays to service worker, not content scripts

---

## Build Commands

```bash
# Chrome build
npm run build

# Firefox build
npx wxt build -b firefox

# Dev mode
npm run dev
```
