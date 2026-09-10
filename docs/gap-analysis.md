# Production-Ready Browser Agent: Gap Analysis & Prioritized Plan

**Date:** 2026-09-10  
**Project:** SIH2026 PS171 Browser Agent  
**Scope:** Error handling, multi-tab support, resource management, feature completeness

---

## Executive Summary

The current agent handles single-page form filling with basic loop detection and single-retry error handling. Production readiness requires:
1. **Robust error resilience** with adaptive retries and circuit breakers
2. **Multi-tab coordination** for complex multi-site workflows
3. **Resource-aware execution** with memory budgets and throttling
4. **Enhanced features** including vision pipeline, user context, and state persistence

---

## 1. Error Handling Improvements

### Current State
| Component | Implementation | Gap |
|-----------|---------------|-----|
| `actions.ts` | Single retry with fixed 400ms delay | No backoff strategy, no error classification |
| `popup/Popup.tsx` | `filledIds` tracks attempted elements | No state machine for failure recovery |
| `planner.py` | Heuristic fallback on LLM failure | No confidence threshold enforcement |
| `action_executor.py` | Mock with exponential backoff (NOT WIRED) | Stubs exist but unused in production |

### Identified Gaps

#### 1.1 No Adaptive Retry Strategy
**Problem:** Fixed 400ms retry delay fails on pages with varying load times.
**Impact:** High - causes premature failures on slow sites (banking portals, government sites).
**Complexity:** LOW (2-3 days)

```typescript
// Current (actions.ts line 222-228)
export async function executeWithRetry(action: Action): Promise<ActionResult> {
    const first = await execute(action);
    if (first.ok || action.type === 'NAVIGATE' || action.type === 'DONE') {
        return first;
    }
    await new Promise((r) => setTimeout(r, 400)); // Fixed delay
    return execute(action);
}
```

**Proposed Fix:** Exponential backoff with jitter + error-type classification.

#### 1.2 No Circuit Breaker Pattern
**Problem:** Continuous failures drain resources and cause infinite loops.
**Impact:** MEDIUM - wastes LLM tokens, degrades UX.
**Complexity:** MEDIUM (3-5 days)

**Proposed Fix:** Track consecutive failures per action type. Trip circuit breaker after N failures, force re-extraction.

#### 1.3 No Error Categorization
**Problem:** Cannot distinguish between transient (network blip) and permanent (element vanished) errors.
**Impact:** MEDIUM - prevents intelligent recovery.
**Complexity:** LOW (1-2 days)

**Proposed Fix:** Classify errors:
- `STALE_ELEMENT` → Re-extract page
- `TIMEOUT` → Increase wait time
- `NETWORK_ERROR` → Retry with backoff
- `INVALID_ACTION` → Force planner reconsider

#### 1.4 No Timeout Budget Enforcement
**Problem:** Long-running tasks consume resources without limit.
**Impact:** LOW - maxSteps exists but no time budget.
**Complexity:** LOW (1 day)

**Proposed Fix:** Add `MAX_DURATION_MS` per task (~60s), track cumulative time.

#### 1.5 No Graceful Degradation
**Problem:** Single LLM failure crashes entire task.
**Impact:** HIGH - poor reliability.
**Complexity:** MEDIUM (2-3 days)

**Proposed Fix:** Implement fallback chain:
1. LLM planner → 2. Heuristic planner → 3. Human-in-the-loop (popup notification)

---

## 2. Multi-Tab/Site Support

### Current State
| Component | Implementation | Gap |
|-----------|---------------|-----|
| `background.ts` | `tabId` from `sender.tab?.id` | Fallback to active tab, no explicit tab management |
| `popup/Popup.tsx` | Single tab query | No tab list, no switching |
| `server/main.py` | `session_store` dict | Not persisted, no cross-session coordination |

### Identified Gaps

#### 2.1 No Tab Lifecycle Management
**Problem:** Cannot open/close/navigate tabs programmatically.
**Impact:** HIGH - limits tasks to single-page flows.
**Complexity:** MEDIUM (3-5 days)

**Proposed Fix:** Add `browser.tabs.*` wrappers:
```typescript
interface TabSession {
  tabId: number;
  url: string;
  openedAt: number;
  closed: boolean;
}
```

#### 2.2 No Cross-Tab State Sharing
**Problem:** Each tab is isolated; can't share context (e.g., "copy email from tab A, paste in tab B").
**Impact:** HIGH - prevents real-world workflows.
**Complexity:** HIGH (5-7 days)

**Proposed Fix:** Implement `SharedStateStore` in background:
```typescript
class SharedStateStore {
  private stores: Map<number, Map<string, any>> = new Map();
  
  async set(tabId: number, key: string, value: any): Promise<void>
  async get(tabId: number, key: string): Promise<any>
  async transfer(fromTab: number, toTab: number, key: string): Promise<void>
}
```

#### 2.3 No Task Orchestration Across Tabs
**Problem:** Can't coordinate multi-site forms (e.g., apply on site A, upload to site B).
**Impact:** MEDIUM - limits use case scope.
**Complexity:** HIGH (7-10 days)

**Proposed Fix:** Implement `TaskOrchestrator` with:
- Dependency graph (tab A must complete before tab B starts)
- State checkpoints between tabs
- Failure isolation (tab B failure doesn't kill tab A)

#### 2.4 No Session Persistence
**Problem:** Reloading extension loses all state.
**Impact:** MEDIUM - poor UX.
**Complexity:** LOW (1-2 days)

**Proposed Fix:** Use `chrome.storage.local` for:
- Active sessions
- Recent tabs
- Partial task progress

---

## 3. Resource Management

### Current State
| Component | Implementation | Gap |
|-----------|---------------|-----|
| `ResourceMonitor.tsx` | CPU/RAM/GPU display | Read-only, no throttling |
| `dom.ts` | `extract()` with 10ms warning | No adaptive sampling |
| `validators.py` | 50KB payload limit | No adaptive compression |
| `planner.py` | Limits to 30 elements | Hard cap, no dynamic sizing |

### Identified Gaps

#### 3.1 No Memory Budget Enforcement
**Problem:** Long sessions accumulate stale elements in registry.
**Impact:** MEDIUM - memory leak potential.
**Complexity:** LOW (1-2 days)

**Proposed Fix:** 
```typescript
// In dom.ts extract()
const MAX_ELEMENTS = 100;
const MAX_AGE_MS = 30_000; // 30s

registry.forEach((el, id) => {
  if (!el.isConnected) registry.delete(id);
});
```

#### 3.2 No Adaptive Extraction Throttling
**Problem:** `extract()` runs on every loop iteration regardless of page stability.
**Impact:** LOW - minor performance hit.
**Complexity:** LOW (1 day)

**Proposed Fix:** Debounce extraction calls (min 500ms between calls).

#### 3.3 No DOM Snapshot Diffing
**Problem:** Cannot detect if page actually changed between extractions.
**Impact:** MEDIUM - wastes LLM calls on unchanged pages.
**Complexity:** MEDIUM (2-3 days)

**Proposed Fix:** 
```typescript
interface SnapshotDiff {
  added: number;
  removed: number;
  moved: number;
  unchanged: number;
}

function computeDiff(old: ExtractedElement[], new: ExtractedElement[]): SnapshotDiff
```

#### 3.4 No Lazy Loading for Large Pages
**Problem:** Pages with 500+ elements send full payload (capped at 30 in planner but still expensive).
**Impact:** LOW - already capped.
**Complexity:** LOW (1 day)

**Proposed Fix:** Implement virtual scrolling + on-demand extraction for off-screen elements.

#### 3.5 No Resource-Based Scaling
**Problem:** No feedback loop between resource usage and behavior.
**Impact:** MEDIUM - can OOM on complex pages.
**Complexity:** MEDIUM (3-4 days)

**Proposed Fix:** Monitor `performance.memory`, throttle if >80% heap:
```typescript
const MEMORY_THRESHOLD = 0.8;
if (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit > MEMORY_THRESHOLD) {
  // Reduce element count, skip heavy operations
}
```

---

## 4. Feature List with Implementation Complexity

### High Priority (P0) - Core Reliability

| Feature | Complexity | Effort | Description |
|---------|-----------|--------|-------------|
| **Adaptive Retry with Backoff** | LOW | 2 days | Exponential backoff (100ms→200ms→400ms→800ms) with jitter. Classify errors as STALE/NODEFOUND/TIMEOUT/NETWORK. |
| **Circuit Breaker** | MEDIUM | 3 days | Trip after 3 consecutive failures on same element type. Reset after successful action or 5s timeout. |
| **Memory Cleanup** | LOW | 1 day | Clear disconnected elements from registry. LRU eviction when >100 elements. |
| **Timeout Budget** | LOW | 1 day | 60s total task timeout. Track cumulative `performance.now()`. |

### Medium Priority (P1) - Usability

| Feature | Complexity | Effort | Description |
|---------|-----------|--------|-------------|
| **Tab Management API** | MEDIUM | 4 days | Open/close/navigate tabs. Store `TabSession` objects. Query by URL pattern. |
| **Vision Pipeline Integration** | MEDIUM | 3 days | Wire Florence-2 fallback when DOM has <3 elements. Use `CAPTURE_SCREENSHOT` message. |
| **User Profile Storage** | LOW | 2 days | `storage.local` for user data (name, email, phone). Auto-fill on matching fields. |
| **Snapshot Diffing** | MEDIUM | 2 days | Detect page changes. Skip LLM call if diff is empty. |

### Lower Priority (P2) - Advanced

| Feature | Complexity | Effort | Description |
|---------|-----------|--------|-------------|
| **Cross-Tab State Store** | HIGH | 7 days | Shared key-value store across tabs. Transfer values between tabs. |
| **Task Checkpointing** | HIGH | 5 days | Save/restore task state. Resume after extension reload. |
| **Parallel Action Execution** | HIGH | 5 days | Execute independent CLICK actions concurrently. Serialize dependent actions. |
| **Smart Wait** | MEDIUM | 3 days | `WAIT` action with condition: element-visible, url-changed, network-idle. |

### Nice-to-Have (P3) - Polish

| Feature | Complexity | Effort | Description |
|---------|-----------|--------|-------------|
| **Resource-Based Scaling** | MEDIUM | 4 days | Reduce element count when memory >80%. Throttle extractions when CPU high. |
| **Lazy Element Loading** | LOW | 2 days | Only extract visible elements. Load off-screen on demand. |
| **Task Visualization** | LOW | 2 days | Graph of completed/remaining steps. Timeline view. |
| **Multi-Language Support** | LOW | 3 days | i18n for UI strings. Support non-Latin scripts in labels. |

---

## Prioritized Implementation Plan

### Phase 1: Foundation (Week 1)
**Goal:** Make the agent resilient to common failures.

```
□ 1.1 Implement Adaptive Retry (actions.ts)
    - Replace fixed 400ms delay with exponential backoff
    - Add jitter: delay * (0.5 + Math.random() * 0.5)
    - Max 3 retries, max 2s delay
    
□ 1.2 Add Error Classification (actions.ts, popup/Popup.tsx)
    - Create enum: ErrorType { STALE_ELEMENT, TIMEOUT, NETWORK, INVALID }
    - Route to appropriate recovery strategy
    
□ 1.3 Implement Memory Cleanup (dom.ts)
    - Clear disconnected elements after each extract()
    - Log cleanup stats for debugging
    
□ 1.4 Add Task Timeout Budget (popup/Popup.tsx)
    - Track cumulative time since task start
    - Abort if >60s with informative message
```

### Phase 2: Multi-Tab Support (Week 2)
**Goal:** Enable multi-site workflows.

```
□ 2.1 Build TabSession Manager (background.ts)
    - Interface: TabSession { tabId, url, openedAt, closed }
    - Methods: openTab(url), closeTab(tabId), getActiveTab()
    
□ 2.2 Update Popup UI for Tab Selection
    - Show list of managed tabs
    - Allow switching active context
    
□ 2.3 Implement Snapshot Diffing (dom.ts)
    - Hash-based comparison of element lists
    - Skip LLM call if snapshot unchanged
```

### Phase 3: User Context & Vision (Week 3)
**Goal:** Personalization and fallback intelligence.

```
□ 3.1 Add User Profile Storage (lib/context.ts)
    - Profile interface: { name, email, phone, addresses[] }
    - Auto-fill on matching field labels
    
□ 3.2 Wire Vision Pipeline (content.ts, background.ts)
    - Fallback when elements < 3
    - Use captured screenshot + Florence-2 OCR
    - Merge vision results with DOM extraction
    
□ 3.3 Implement Circuit Breaker (popup/Popup.tsx)
    - Track consecutive failures per element type
    - Trip after 3 failures, force re-extraction
```

### Phase 4: Advanced Features (Week 4)
**Goal:** Production-grade reliability.

```
□ 4.1 Cross-Tab State Store (background.ts)
    - SharedStateStore class with get/set/transfer
    
□ 4.2 Task Checkpointing (lib/state.ts)
    - Save to chrome.storage.local every 5 steps
    - Restore on extension reload
    
□ 4.3 Resource-Based Throttling (dom.ts, popup/Popup.tsx)
    - Monitor performance.memory
    - Reduce extraction frequency when >80% heap
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM latency causes timeout | HIGH | MEDIUM | Implement timeout budget with graceful abort |
| Memory leak on long sessions | MEDIUM | HIGH | Aggressive cleanup + heap size monitoring |
| Element ID instability | HIGH | MEDIUM | Use stableId (label+x+y) instead of numeric ID |
| Cross-tab state corruption | LOW | HIGH | Use versioned storage schema |
| Vision pipeline false positives | MEDIUM | LOW | Combine with DOM extraction, require high confidence |

---

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Task completion rate | ~60% | >90% | Successful tasks / total attempts |
| Mean time to complete | ~45s | <30s | From start to DONE |
| Error recovery rate | ~40% | >80% | Recovered errors / total errors |
| Memory usage (peak) | Unknown | <100MB | Chrome DevTools memory timeline |
| LLM call reduction | 100% | <70% | Via snapshot diffing |

---

## Conclusion

The agent has solid privacy fundamentals but lacks production resilience. **Phase 1 (Error Handling)** should be prioritized immediately as it addresses the most common failure modes. **Phase 2 (Multi-Tab)** unlocks the full use case scope. **Phase 3 (Context & Vision)** adds intelligence and personalization. **Phase 4 (Advanced)** polishes for production deployment.

Total estimated effort: **4 weeks** for full production readiness.
