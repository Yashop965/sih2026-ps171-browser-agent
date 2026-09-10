# SIH2026 PS171 — Judging Criteria Gap Analysis

**Date:** 2026-09-10  
**Project:** On-device Visual Perception for Light-weight Browser Agents  
**Scope:** Audit against 5 SIH judging criteria with weighted scoring  

---

## Executive Summary

| Criterion | Weight | Status | Gap Severity | Key Risk |
|-----------|--------|--------|-------------|----------|
| Visual Perception Accuracy | 25% | ⚠️ Partial | **HIGH** | Vision pipeline code exists but is NOT INTEGRATED |
| PII Detection Recall/Precision | 20% + 20% = 40% | ⚠️ Moderate | **MEDIUM** | Duplicated code paths, no measured recall/precision metrics |
| Redaction Precision | 20% | ✅ Good | **LOW** | Solid implementation but no automated redaction tests |
| Client-side Resource Usage | 20% | ⚠️ Moderate | **MEDIUM** | Estimates only — no measured peak RAM or CPU data |
| End-to-End Latency | 15% | ⚠️ Moderate | **MEDIUM** | Thresholds defined but no benchmark evidence |

**Overall:** Privacy pipeline (PII + redaction) is the strongest area (~40% combined). The critical gap is the **vision pipeline not being wired into the content script**, which directly undermines the 25% visual accuracy score and any vision-dependent latency claims.

---

## 1. Visual Perception Accuracy (25%)

### Current State

**What exists:**
- `src/lib/vision/florence2.ts` — Florence-2 pipeline class (325 lines)
- `src/lib/vision/som.ts` — Set-of-Marks overlay rendering
- `src/lib/vision/memory.ts` — Vision memory management
- `src/hooks/useVisionModel.ts` — React hook for model lifecycle
- `src/components/SoMOverlay.tsx` — Canvas-based numbered bounding boxes

**What is MISSING:**
- `src/content.ts` does NOT import or call `visionPipeline`
- `src/background.ts` does NOT trigger vision fallback
- Popup does NOT use `useVisionModel`
- No accuracy benchmarks against ground-truth test sets
- No confusion matrix (TP/FP/FN) for element grounding

### Gap Analysis

| Gap | Severity | Evidence |
|-----|----------|----------|
| Vision pipeline not integrated | 🔴 HIGH | Final session notes confirm: "Florence-2 vision pipeline code EXISTS but is NOT INTEGRATED" |
| No accuracy benchmarks | 🟡 MEDIUM | Zero test coverage for vision grounding accuracy |
| No SoM-to-DOM coordinate mapping tests | 🟡 MEDIUM | No tests verify vision bounding boxes align with DOM elements |
| Hybrid consensus logic absent | 🟡 MEDIUM | PRD describes "Both paths available → merge results" but no merge/consensus code found |

### Recommended Fix
```
Priority: P0 (blocking for 25% score)
Action: Wire visionPipeline into content.ts fallback path:
  if (DOM elements < 3) → trigger vision fallback
  → capture screenshot → run Florence-2 OCR + grounding
  → merge with DOM results via consensus
```

---

## 2. PII Detection Recall/Precision (40% combined)

### Current State

**Two parallel PII detection paths exist:**

1. **`src/lib/pii/detector.ts`** (`PIIManager` class)
   - Sync `scanDocument()` and async `scanDocumentAsync()`
   - Supports: Aadhaar (Verhoeff), PAN, Credit Card (Luhn), IFSC, Email, Phone, API Key, Face (native API + heuristic fallback), Password fields
   - **BUG:** Methods `scanDocument()` and `scanDocumentAsync()` are **duplicated** (lines 73-78 and 93-97)

2. **`src/lib/pii/sanitizer.ts`** (standalone functions)
   - `scanString()`, `redactString()`, `sanitizeSnapshot()`
   - Separate pattern definitions (slightly different regexes from detector.ts)
   - Supports: Aadhaar, PAN, Credit Card, IFSC, Email, Phone, UPI, API Key, SSN

### Gap Analysis

| Metric | Current State | Target | Gap |
|--------|--------------|--------|-----|
| **Recall** (detect all PII) | Unknown — no test suite with ground truth | >90% on Indian PII types | 🔴 No recall measurement exists |
| **Precision** (no false positives) | Regex-only for some types (PHONE: 0.6 base confidence) | >85% | 🟡 Low-confidence detections on phone/email without validators |
| **Verified rate** | Checksum-validated: Aadhaar✓, PAN✓, Card✓ | All critical types verified | 🟡 UPI, Phone, API Key lack strong validators |
| **Coverage** | 11 PII types supported | Comprehensive Indian PII | 🟢 Good coverage list |

### Specific Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| Duplicate method definitions in detector.ts | 🔴 HIGH | `scanDocument()` and `scanDocumentAsync()` defined twice — causes TS errors or last-one-wins behavior |
| Two separate PII implementations (detector + sanitizer) | 🟡 MEDIUM | Divergent regex patterns between `detector.ts` and `sanitizer.ts` PATTERNS array — risk of inconsistent detection |
| No recall/precision test suite | 🔴 HIGH | `tests/pii-detector.test.ts` only tests regex matching, not end-to-end detection on realistic pages |
| Face detection fallback confidence too low | 🟡 MEDIUM | Heuristic face detection uses 0.65 confidence vs 0.9 for native API — may cause false positives/negatives |
| No adversarial PII test data | 🟡 MEDIUM | No test cases for obfuscated PII (e.g., "1234••••5678", spaced PAN "ABCDE 1234 F") |

### UPI Detection Gap
The sanitizer's `PATTERNS` array includes UPI with `validateUPI`, but `detector.ts` does NOT include UPI in its `scanDOM()` method. This means UPI VPA addresses (e.g., `9876543210@upi`) will be detected by the sanitizer but NOT by the detector — creating an inconsistency.

---

## 3. Redaction Precision (20%)

### Current State

**`src/lib/pii/redactor.ts`** (`RedactionEngine` class):
- Password/API key fields → black overlay (`#000` at z-index 2147483647)
- Faces → backdrop-blur overlay (`blur(20px)`)
- Text PII (Aadhaar, PAN, etc.) → red badge overlay (`🔒 REDACTED PII`)
- Canvas redaction utility for screenshot-level redaction
- `clearRedactions()` removes all overlays

**`src/lib/pii/firewall.ts`** (`inspectPayload`):
- Recursive JSON payload inspection before network transmission
- Blockswell: blocks if validated PII found in outbound payload
- Records audit event without exposing raw value

### Gap Analysis

| Gap | Severity | Detail |
|-----|----------|--------|
| No redaction coverage test | 🟡 MEDIUM | No test verifies that every detected PII type produces a visual overlay |
| No automated redaction precision metric | 🟡 MEDIUM | Cannot prove "X% of PII regions are properly obscured" |
| Canvas redaction not used in vision pipeline | 🟡 MEDIUM | `redactCanvasRegion()` exists but is never called (vision pipeline not integrated) |
| Selector-based redaction fragile | 🟢 LOW | Uses CSS/XPath selectors from detector — if selector fails, redaction silently skipped |
| Defense-in-depth via firewall | 🟢 GOOD | Even if DOM redaction fails, outbound payload firewall catches leaked PII |

---

## 4. Memory/CPU Utilization (20%)

### Current State

**PRD claimed budgets:**
| Component | Est. Peak RAM | Status |
|-----------|--------------|--------|
| Florence-2-base-ft ONNX | ~200MB | Lazy-loaded, not yet loaded in practice |
| Transformers.js runtime | ~50MB | Singleton worker |
| DOM extraction cache | 10-30MB | GC after action |
| PII detection engine | <5MB | Stateless |
| SoM overlay canvas | 5-10MB | Recycled per frame |
| Privacy ledger | 5MB (500 entry cap) | Circular buffer |
| **Client total** | **~270-300MB** | Within 500MB budget |

**What's actually measured:**
- `ResourceMonitor.tsx` — displays `jsHeapUsedMB`, `jsHeapTotalMB`, CPU cores, GPU adapter
- `LatencyHUD.tsx` — displays `metrics.memory_mb` from `Profiler.getMemoryEstimate()`
- `Profiler.getMemoryEstimate()` — uses `performance.memory.usedJSHeapSize` (returns **0** in non-Chromium browsers)

### Gap Analysis

| Gap | Severity | Detail |
|-----|----------|--------|
| No measured peak RAM during operation | 🔴 HIGH | All memory numbers are PRD estimates, never profiled with Chrome DevTools |
| `performance.memory` returns 0 in Firefox | 🟡 MEDIUM | ResourceMonitor shows 0 MB RAM in Firefox — no fallback metric |
| No memory leak detection | 🟡 MEDIUM | `docs/gap-analysis.md` identifies this as a P0 gap but unimplemented |
| No CPU usage measurement | 🟡 MEDIUM | `cpuCores` is static hardware info, not actual CPU utilization % |
| Model memory not tracked post-load | 🟢 LOW | Florence-2 model loading not yet triggered, so 200MB never realized |

### Missing: Memory Pressure Response
No code throttles or degrades when memory exceeds thresholds. The PRD's "Resource-Based Scaling" feature is listed as P3 (low priority) in the gap analysis but is critical for the 20% resource utilization score.

---

## 5. Latency Budgets (15%)

### Current State

**Defined thresholds in `src/lib/profiler.ts`:**
| Stage | Threshold | Current Measured |
|-------|-----------|-----------------|
| DOM Extract | <10ms | Unknown — no baseline |
| Vision Inference | <1000ms | Unknown — pipeline not integrated |
| Plan Response | <500ms | Unknown — depends on server |
| Action Execution | <100ms | Unknown |
| Total Step | <2000ms | Unknown |

**Latency HUD** (`src/components/LatencyHUD.tsx`) displays live metrics with color-coded threshold warnings.

### Gap Analysis

| Gap | Severity | Detail |
|-----|----------|--------|
| No latency benchmark data | 🔴 HIGH | No recorded measurements for any pipeline stage |
| Vision inference time unknown | 🔴 HIGH | Pipeline not integrated — can't verify 300-1000ms claim |
| Server latency unmeasured | 🟡 MEDIUM | No client-side timer for `/plan` round-trip |
| DOM extract baseline absent | 🟡 MEDIUM | 10ms threshold is arbitrary — no measurement on real pages |
| Tiered pipeline not validated | 🟡 MEDIUM | DOM fast path (~10ms) vs Vision fallback (~500ms) split not tested |

---

## Summary of Gaps by Severity

### 🔴 HIGH (Must Fix Before Demo)
1. **Vision pipeline not integrated** — code exists but content.ts never calls it; blocks 25% visual accuracy score
2. **Duplicate methods in detector.ts** — `scanDocument()` and `scanDocumentAsync()` defined twice; TS compilation risk
3. **No PII recall/precision metrics** — zero benchmark data for the 40% combined privacy score
4. **No latency benchmark data** — all threshold claims are unverified
5. **No measured peak RAM** — 500MB budget claim is unproven

### 🟡 MEDIUM (Should Fix)
1. **Two divergent PII implementations** (detector.ts vs sanitizer.ts) — inconsistent regex patterns
2. **UPI detection missing from detector.ts** — sanitizer has it, detector doesn't
3. **No redaction coverage tests** — can't prove all PII types get visual redaction
4. **Firefox memory metric returns 0** — ResourceMonitor misleading in Firefox
5. **No memory leak detection** — identified as P0 in gap-analysis.md but unimplemented
6. **Face detection heuristic confidence (0.65) is low** — high false positive risk

### 🟢 LOW (Nice to Have)
1. **Selector-based redaction fragility** — silent failure if selector can't find element
2. **No adversarial PII test data** — obfuscated PII not tested
3. **Canvas redaction unused** — vision pipeline not integrated, so canvas utility is dead code

---

## Recommended Priority Order

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 1 | Wire vision pipeline into content.ts | +25% potential score | 2-3 days |
| 2 | Consolidate detector.ts + sanitizer.ts into single source | Eliminates inconsistency | 1 day |
| 3 | Fix duplicate method definitions in detector.ts | Fixes TS compilation | 1 hour |
| 4 | Add PII recall/precision test suite with ground truth | Proves 40% privacy score | 2 days |
| 5 | Add latency benchmarks on real pages | Proves 15% latency score | 1 day |
| 6 | Profile peak RAM with Chrome DevTools | Proves 20% resource score | 1 day |
| 7 | Add redaction coverage tests | Proves redaction precision | 0.5 days |
| 8 | Add memory leak detection + throttling | Prevents OOM on long sessions | 2 days |

---

## Files Referenced

| File | Relevance |
|------|-----------|
| `src/lib/pii/detector.ts` | Primary PII detector — has duplicate methods bug |
| `src/lib/pii/sanitizer.ts` | Secondary PII scanner — divergent patterns |
| `src/lib/pii/validators.ts` | Checksum validators (Verhoeff, Luhn, PAN format) |
| `src/lib/pii/redactor.ts` | Visual redaction overlays |
| `src/lib/pii/firewall.ts` | Outbound payload inspection (defense-in-depth) |
| `src/lib/pii/types.ts` | Internal PII types |
| `src/lib/vision/florence2.ts` | Vision pipeline — NOT INTEGRATED |
| `src/lib/profiler.ts` | Latency profiling with thresholds |
| `src/components/LatencyHUD.tsx` | Live latency + memory display |
| `src/components/ResourceMonitor.tsx` | CPU/RAM/GPU display |
| `tests/pii-detector.test.ts` | Regex-level tests only — no integration tests |
| `docs/gap-analysis.md` | Existing production readiness analysis (complements this audit) |
