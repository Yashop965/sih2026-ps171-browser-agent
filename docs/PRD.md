# Product Requirements Document (PRD) — SIH2026 PS171

**Project:** On-device Visual Perception for Light-weight Browser Agents  
**Institution:** ISRO  
**Problem Statement:** SIH26171 — On-device Visual Perception for Light-weight Browser Agents  
**Team:** B.Tech CSE — 6 members  
**Deadline:** September 2, 2026 (4 days)  
**Repository:** https://github.com/Yashop965/sih2026-ps171-browser-agent  

---

## 1. PS Overview

ISRO Problem Statement 171 challenges teams to build a **local browser agent** that perceives and acts on web pages without sending sensitive data to external servers. Most AI agents today operate server-side, requiring users to upload full screenshots or DOM data to third-party clouds — a critical privacy violation for government portals, banking applications, and citizen-facing services containing Aadhaar, PAN, passwords, and medical records.

India's **Digital Personal Data Protection (DPDP) Act 2023** mandates strict data handling practices. ISRO specifically requires a Chrome/Firefox extension that processes visual perception **entirely on-device** using WebGPU-accelerated inference, redacts PII before any network transmission, and sends only anonymized UI metadata to a planner component. The solution must demonstrate real autonomy: completing a multi-step task (e.g., form filling) while providing provable privacy guarantees through a live audit ledger.

This is fundamentally a **privacy-first agent architecture** problem. The judging criteria weight privacy (PII recall + precision + redaction = 40%) higher than raw agent accuracy (25%), signaling that ISRO prioritizes data protection over feature completeness. Teams must prove their pipeline never transmits identifiable information — a requirement that eliminates naive screenshot-based approaches used by most competitors.

**Key Requirements (from official PS):**
1. Client-side extension running in **Chrome AND Firefox**
2. Local vision model (ViT or equivalent) via **WebGPU** evaluating current screen state
3. **Privacy-preserving filter**: detect & redact sensitive elements locally — blurring faces, blacking out passwords, masking PII — before ANY network request
4. Server-side component receives **only anonymized context**
5. End-to-end task demonstration

---

## 2. Full System Architecture

### 2.1 Client-Side Architecture (Browser Extension)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      EXTENSION ARCHITECTURE (WXT MV3)               │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │  Content Script │    │  Background     │    │  Popup         │  │
│  │                 │    │  Service Worker │    │  (React UI)    │  │
│  │ • DOM Extractor │    │                 │    │                │  │
│  │ • Vision Worker │    │ • Lifecycle mgr │    │ • TaskPanel    │  │
│  │ • Privacy Engine│    │ • Message bus   │    │ • SoM Overlay  │  │
│  │ • Action Executor│   │ • Storage mgr   │    │ • PrivacyLedger│  │
│  │ • Latency HUD   │    │ • Network relay │    │ • ResourceHUD  │  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬───────┘  │
│           │                      │                      │          │
│           └──────────────────────┼──────────────────────┘          │
│                                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    VISION PIPELINE                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ Screenshot   │  │ Florence-2   │  │ Set-of-Marks     │   │  │
│  │  │ Capture      │──│ ONNX (WebGPU)│──│ Overlay Renderer │   │  │
│  │  │ ~50ms        │  │ ~300-1000ms  │  │ ~10ms            │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │  │
│  │       │                  │                                    │  │
│  │       └──────────────────┘                                    │  │
│  │              ▼                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  DOM Extraction (Parallel Path)                       │    │  │
│  │  │  • Accessibility tree (~5ms)                          │    │  │
│  │  │  • Element bounding boxes (~5ms)                      │    │  │
│  │  │  • Text content extraction (~5ms)                     │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                  │                                 │
│                                  ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    PRIVACY ENGINE                            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ PII Detector │  │  Redactor    │  │ Privacy Ledger   │   │  │
│  │  │              │  │              │  │                  │   │  │
│  │  │ • Aadhaar    │  │ • Canvas blur│  │ • Detection log  │   │  │
│  │  │   Verhoeff   │  │ • Text mask  │  │ • Redaction log  │   │  │
│  │  │ • PAN format │  │ • Field block│  │ • Egress log     │   │  │
│  │  │ • Card Luhn  │  │ • Face blur  │  │ • Payload hash   │   │  │
│  │  │ • Passwords  │  │ • Selective  │  │ • Tamper-proof   │   │  │
│  │  │ • UPI/IFSC   │  │   redaction  │  │   counter        │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                  │                                 │
│                                  ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              SANITIZED METADATA PAYLOAD                       │  │
│  │  {                                                            │  │
│  │    elements: [{id, role, label, x, y, w, h, type}],          │  │
│  │    task: "string",                                            │  │
│  │    step: number,                                              │  │
│  │    checksum: "sha256..."                                      │  │
│  │  }                                                            │  │
│  │  → Zero pixels, zero raw DOM, zero PII                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP POST /plan (sanitized only)
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SERVER-SIDE ARCHITECTURE (FastAPI)              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    API LAYER                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ Request      │  │ Response     │  │ Validation       │   │  │
│  │  │ Parser       │  │ Formatter    │  │ Middleware       │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
│                                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    PLANNER SERVICE                           │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ Context      │  │ Action       │  │ State            │   │  │
│  │  │ Builder      │  │ Planner      │  │ Manager          │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
│                                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    LLM INFERENCE                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ Ollama       │  │ Cloud API    │  │ Fallback         │   │  │
│  │  │ (Local)      │  │ (OpenAI-comp)│  │ Strategy         │   │  │
│  │  │ qwen2.5:1.5b │  │              │  │                  │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
│                                  ▼ JSON Action                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Returns: {                                                  │  │
│  │    action: "CLICK" | "TYPE" | "SCROLL" | "SELECT",           │  │
│  │    targetId: number,                                         │  │
│  │    value?: string,                                           │  │
│  │    confidence: 0.0-1.0,                                      │  │
│  │    reasoning: "string"                                       │  │
│  │  }                                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Tiered Inference Pipeline

```
Step Start
    │
    ▼
DOM Extraction (~10ms) ──→ Has actionable info? ──→ Yes ──→ Execute directly
    │                                                    │
    No                                                    │
    │                                                     │
    ▼                                                     │
Vision Grounding (WebGPU, ~300-1000ms) ──→ SoM Overlay
    │
    ▼
Send sanitized metadata to planner
    │
    ▼
Execute returned action
    │
    ▼
Capture new screenshot → Loop until done or max steps
```

**Tier Strategy:**
1. **DOM Path (Fast):** ~10ms, handles 80%+ of structured forms
2. **Vision Path (Accurate):** ~300-1000ms, handles canvas/image elements
3. **Hybrid Consensus:** Both paths available → merge results

### 2.3 Component Memory Budgets

| Component | Model/Size | Peak RAM | Strategy |
|-----------|-----------|----------|----------|
| Florence-2-base-ft ONNX | 231M params (~180MB weights) | 200MB | Lazy-load on first vision request |
| Transformers.js runtime | WebGPU backend | 50MB | Singleton, persistent worker |
| DOM extraction cache | Full page DOM | 10-30MB | GC after action execution |
| PII detection engine | Regex patterns | <5MB | Stateless, no persistence |
| SoM overlay canvas | WebGL context | 5-10MB | Recycled per frame |
| Privacy ledger | In-memory log | 5MB (capped at 500 entries) | Circular buffer |
| **Client total** | | **~270-300MB** | Well within 500MB budget |
| FastAPI server | Python runtime | 50MB | Containerized, restartable |
| Ollama (qwen2.5:1.5b) | GGUF Q4_K_M | 1.2GB (hosted) | Runs on server, not client |
| **Server total** | | **~1.25GB** | Isolated from client |

> **Note:** The 500MB RAM constraint applies to the **client-side extension only**. Server-side resources are unbounded in the SIH evaluation context.

---

## 3. Memory Constraint Analysis

### 3.1 Hard Constraint: 500MB Total Client RAM

The problem statement explicitly requires demonstrating efficient client-side resource utilization (20% of evaluation). Our target is to maintain the extension within **500MB peak RAM** during full operation.

### 3.2 Model Size Breakdown

| Model | Format | Parameters | Weight Size | Runtime Overhead | Total |
|-------|--------|-----------|-------------|------------------|-------|
| Florence-2-base-ft | ONNX | 231M | ~180MB | ~20MB (Transformers.js) | **~200MB** ✅ |
| Florence-2-large | ONNX | 768M | ~600MB | ~40MB | **~640MB** ❌ |
| Moondream2 | GGUF (WASM) | 1.93B | ~1.2GB | ~100MB | **~1.3GB** ❌ |
| ShowUI-2B | GGUF Q4_K_M | 2B | ~1.1GB | ~80MB | **~1.18GB** ❌ |

**Decision:** Florence-2-base-ft is the only viable option for strict 500MB constraint. The large variant exceeds the budget by 30%.

### 3.3 Lazy Loading Strategy

```
Extension Install
    │
    ▼
Load content script (~2MB)
    │
    ▼
Load React popup (~15MB)
    │
    ▼
DOM extraction ready (immediate, ~5MB)
    │
    ▼
User initiates task
    │
    ├─→ DOM path: Use immediately (no model load)
    │
    └─→ Vision path needed?
            │
            ├─ No → Return DOM-only results
            │
            └─ Yes → Trigger Florence-2 download (~180MB)
                         │
                         ▼
                    Warm up WebGPU context (~50ms)
                         │
                         ▼
                    Run inference (~300-1000ms)
                         │
                         ▼
                    Cache model in IndexedDB for reuse
```

**Key optimizations:**
- Models cached in `IndexedDB` (not re-downloaded on reload)
- WebGPU context initialized lazily (first vision request)
- Worker threads recycled, not recreated
- Canvas contexts reused across frames

### 3.4 WebGPU vs WASM Tradeoffs

| Aspect | WebGPU | WASM (Fallback) |
|--------|--------|-----------------|
| **Performance** | 3-5× faster inference | Baseline |
| **RAM usage** | Lower (GPU memory) | Higher (CPU RAM) |
| **Browser support** | Chrome 113+, Firefox 117+ (flagged) | Universal |
| **Firefox** | Requires flag enable | Works out-of-box |
| **Model compatibility** | ONNX models optimized | ONNX Runtime Web |
| **Fallback strategy** | Detect support, degrade gracefully | Same codebase, different backend |

**Implementation:** Automatic feature detection with graceful degradation:

```typescript
const useWebGPU = 
  typeof navigator.gpu !== 'undefined' && 
  location.protocol.startsWith('http'); // Secure context required
```

This ensures Firefox compatibility (WASM) while maximizing performance on Chromium (WebGPU).

---

## 4. Feature Breakdown by Team Role

### 4.1 Himanshi (Frontend) — Popup UI, SoM Overlay, TaskPanel, Browser Communication

**GitHub:** @Himanshi-256

**Primary Responsibilities:**
- [ ] **Extension Popup** (`src/popup/Popup.tsx`)
  - Task input field with placeholder examples
  - Start/Stop automation controls
  - Step counter and progress indicator
  - Resource usage mini-display (RAM, latency)
  
- [ ] **Set-of-Marks Overlay** (`src/components/SoMOverlay.tsx`)
  - Canvas-based numbered bounding boxes
  - Click-to-select interaction
  - Visual feedback on hover/click
  - Toggle visibility controls
  
- [ ] **Privacy Ledger Panel** (`src/components/PrivacyLedger.tsx`)
  - Scrollable log of detections/redactions
  - Color-coded entries (red=blocked, green=allowed)
  - Export capability (JSON dump for judges)
  - Real-time ticker animation
  
- [ ] **Latency HUD** (`src/components/LatencyHUD.tsx`)
  - Per-step timing breakdown
  - Cumulative task timer
  - Resource gauge (RAM usage bar)
  
- [ ] **Browser Communication**
  - Message passing to content script
  - Popup ↔ background service worker sync
  - State persistence across reloads

**Deliverables:** All React components, WXT popup configuration, canvas overlay system, HUD visualizations

---

### 4.2 Anirudh (Frontend) — Content Script, DOM Extraction, Extension Lifecycle, Action Executor

**GitHub:** @anirudh657

**Primary Responsibilities:**
- [ ] **DOM Extraction Engine** (`src/lib/dom.ts`)
  - Accessibility tree traversal
  - Element bounding box calculation
  - Text content extraction
  - Form field identification
  
- [ ] **Extension Lifecycle Management** (`src/background.ts`)
  - Service worker initialization
  - Content script injection/removal
  - Tab change detection
  - Error recovery and reconnection
  
- [ ] **Action Executor** (`src/content.ts`)
  - Click simulation (mouse events)
  - Type simulation (input events)
  - Scroll execution
  - Select/dropdown interaction
  - Form submission handling
  
- [ ] **Vision Pipeline Integration**
  - Screenshot capture via `chrome.tabs.captureVisibleTab`
  - Coordinate transformation (screen → element space)
  - SoM data pipeline to overlay
  
- [ ] **Cross-Browser Compatibility**
  - Chrome API shims
  - Firefox polyfills (WXT `compatibility` field)
  - Feature detection guards

**Deliverables:** Content script implementation, DOM utilities, action executor, browser compatibility layer

---

### 4.3 Yuvraj (Backend) — FastAPI Server, Ollama Integration, Action Planner API

**GitHub:** @YuvrajGora

**Primary Responsibilities:**
- [ ] **FastAPI Application** (`server/main.py`)
  - Async endpoint implementation
  - CORS configuration for extension origin
  - Request/response middleware
  - Health check and monitoring endpoints
  
- [ ] **Ollama Integration** (`server/ollama_client.py`)
  - Local model client (`qwen2.5:1.5b`, `qwen2.5:3b`)
  - Streaming response support
  - Timeout and retry logic
  - Model warm-up and caching
  
- [ ] **Action Planner API** (`server/planner.py`)
  - Context builder (element metadata → prompt)
  - Action parser (LLM output → structured JSON)
  - Confidence scoring
  - Multi-step reasoning
  
- [ ] **Cloud API Fallback** (`server/fallback.py`)
  - OpenAI-compatible endpoint wrapper
  - Provider abstraction layer
  - Key management (env vars)
  
- [ ] **API Endpoints**
  ```
  POST /plan          # Main planning endpoint
  GET  /health        # Server health check
  GET  /models        # List available models
  POST /reset         # Reset agent state
  ```

**Deliverables:** FastAPI server, Ollama client, planner logic, cloud fallback

---

### 4.4 Laavannya (Backend) — Server Middleware, Request Validation, Logging, Error Handling

**GitHub:** (TBD - verify GitHub username)

**Primary Responsibilities:**
- [ ] **Request Validation** (`server/middleware/validators.py`)
  - JSON schema validation (Pydantic models)
  - Input sanitization
  - Rate limiting
  - Payload size limits
  
- [ ] **Logging System** (`server/middleware/logging.py`)
  - Structured JSON logging
  - Request/response tracing
  - Performance metrics collection
  - Privacy-safe audit trail
  
- [ ] **Error Handling** (`server/middleware/errors.py`)
  - Global exception handler
  - Graceful degradation
  - Error response formatting
  - Recovery procedures
  
- [ ] **Security Middleware**
  - Origin validation (extension origin only)
  - Request signing (optional)
  - PII scan on inbound payloads (defense in depth)
  - Rate limiting per client
  
- [ ] **Response Formatting**
  - Consistent error codes
  - Timing metadata
  - Confidence scores
  - Reasoning traces

**Deliverables:** Validation schemas, logging framework, error handlers, security middleware

---

### 4.5 Yash (Optimization) — Model Quantization, WebGPU Pipeline, Latency Profiling, Memory Management

**GitHub:** @Yashop965

**Primary Responsibilities:**
- [ ] **Model Quantization** (`src/lib/model.ts`)
  - INT8 quantization pipeline
  - ONNX optimization passes
  - Model pruning evaluation
  - Accuracy vs size tradeoff analysis
  
- [ ] **WebGPU Pipeline** (`src/workers/vision.worker.ts`)
  - GPU tensor allocation
  - Compute shader optimization
  - Batch processing
  - Memory pool management
  
- [ ] **Latency Profiling** (`src/lib/profiler.ts`)
  - Performance mark/measure API
  - Inference timing breakdown
  - Bottleneck identification
  - Optimization reporting
  
- [ ] **Memory Management**
  - Worker lifecycle control
  - Buffer pooling
  - Garbage collection hints
  - Memory leak detection
  
- [ ] **Performance Budgets**
  - Max inference time: 1000ms
  - Max RAM: 500MB
  - Max payload size: 50KB
  - Min FPS: 30 (overlay rendering)

**Deliverables:** Optimized models, WebGPU worker, profiler, memory management utilities

---

### 4.6 Vedant (Support — Co-Partner)

**GitHub:** @Vedant-Singhal

**Role:** Support partner — lighter workload, assists across tasks as needed.

**Primary Responsibilities:**
- [ ] **Testing support** — run existing test suites, report bugs
- [ ] **Demo prep** — help set up mock portal, generate test data
- [ ] **Firefox compatibility** — basic testing on Firefox, report issues
- [ ] **Ad-hoc support** — assist other team members when blocked

---

### 4.7 Yash (Optimization + Testing Lead)

**GitHub:** @Yashop965

**Primary Responsibilities:**
- [ ] **Model Quantization** (`src/lib/model.ts`)
  - INT8 quantization pipeline
  - ONNX optimization passes
  - Accuracy vs size tradeoff analysis
- [ ] **WebGPU Pipeline** (`src/workers/vision.worker.ts`)
  - GPU tensor allocation
  - Compute shader optimization
  - Memory pool management
- [ ] **Latency Profiling** (`src/lib/profiler.ts`)
  - Performance mark/measure API
  - Inference timing breakdown
  - Bottleneck identification
- [ ] **Memory Management**
  - Worker lifecycle control
  - Buffer pooling
  - GC hints, leak detection
- [ ] **Testing & E2E** (took over from Vedant)
  - Unit tests for PII detectors
  - Integration tests for vision pipeline
  - Performance benchmarks
  - Demo script and backup video
- [ ] **Deployment**
  - Extension packaging (`.zip`)
  - Installation guide

**Deliverables:** Optimized models, WebGPU worker, profiler, test suite, demo assets

---

## 5. Branching Strategy

### 5.1 Repository Structure

```
main (protected)
├── feature/himanshi-popup-ui
├── feature/anirudh-content-script
├── feature/yuvraj-planner-api
├── feature/laavannya-middleware
├── feature/yash-model-optimization
└── feature/vedant-support
```

### 5.2 Branch Naming Convention

|| Member | Branch Pattern | Protected? |
|--------|---------------|------------|
| Yash (Lead) | `main` | ✅ Yes |
| Himanshi | `feature/himanshi-{component}` | No |
| Anirudh | `feature/anirudh-{component}` | No |
| Yuvraj | `feature/yuvraj-{component}` | No |
| Laavannya | `feature/laavannya-{component}` | No |
| Yash | `feature/yash-{optimization}` | No |
| Vedant | `feature/vedant-support` | No |

### 5.3 Workflow Rules

1. **All work happens on feature branches** — never commit directly to `main`
2. **Daily sync** — merge `main` into feature branch each morning
3. **Pull requests required** — all merges to `main` require PR with review
4. **PR template** — include: what changed, testing done, known issues
5. **Atomic commits** — one logical change per commit, descriptive messages
6. **Backup branch** — `backup/YYYY-MM-DD` created before risky merges

### 5.4 Merge Schedule

| Day | Focus | Merge Target |
|-----|-------|-------------|
| Day 1-2 | Foundation + Core | Feature branches → staging |
| Day 3 | Integration | All feature branches → main |
| Day 4 | Polish | Final merge + release tag |

---

## 6. Evaluation Criteria Alignment

### 6.1 Metric Breakdown

| Metric | Weight | Component Owner | Implementation Strategy |
|--------|--------|-----------------|------------------------|
| **Visual context accuracy** | 25% | Yash + Anirudh | Hybrid DOM + vision; Florence-2 grounding; SoM overlay |
| **PII recall** | 20% | Laavannya + Yash | Layered regex + checksums; Verhoeff/PAN/Luhn; face detection |
| **PII precision** | 20% | Laavannya | Checksum validation eliminates false positives; conservative over-redaction |
| **Resource utilization** | 20% | Yash | Quantized models; lazy loading; WebGPU efficiency; <500MB target |
| **Latency** | 15% | Himanshi + Anirudh | Tiered pipeline; DOM fast path; HUD visualization; <2s per step target |

### 6.2 Scoring Strategy

**Privacy (40% combined) — Our Competitive Advantage:**
- Provable privacy ledger with tamper-proof counter
- Checksum-validated detection (not just pattern matching)
- Live audit showing zero PII egress
- Adversarial demonstration (judge-provided test data)

**Accuracy (25%) — Hybrid Approach:**
- DOM extraction handles 80%+ of structured forms (fast, precise)
- Vision fallback for canvas/image-based elements
- Consensus mechanism when both paths available
- Acknowledge limitations openly to judges

**Resources (20%) — Measurable & Demonstrable:**
- Live RAM counter in HUD
- Model quantization report (size vs accuracy)
- Lazy loading evidence (model only loads when needed)
- WebGPU vs WASM benchmark comparison

**Latency (15%) — Visible Performance:**
- Per-step timing breakdown
- Tiered pipeline explanation (DOM ~10ms vs Vision ~500ms)
- Optimization techniques documented
- Realistic expectations communicated

---

## 7. API Contract

### 7.1 POST /plan

**Request Schema:**

```typescript
interface PlanRequest {
  // Sanitized element metadata (zero PII)
  elements: Array<{
    id: number;
    role: string;           // 'button', 'input', 'text', etc.
    label: string;          // Visible text or aria-label
    x: number;              // Top-left X coordinate
    y: number;              // Top-left Y coordinate
    width: number;
    height: number;
    type?: string;          // Input type (text, password, email, etc.)
    value?: string;         // Current value (if non-sensitive)
  }>;
  
  // Natural language task description
  task: string;
  
  // Current step number (for multi-step tasks)
  step: number;
  
  // Previous actions taken (context)
  history?: Array<{
    action: string;
    targetId: number;
    result: string;
  }>;
  
  // Optional: screenshot thumbnail (base64, low-res)
  thumbnail?: string;
}
```

**Response Schema:**

```typescript
interface PlanResponse {
  // Action to execute
  action: 'CLICK' | 'TYPE' | 'SCROLL' | 'SELECT' | 'NAVIGATE' | 'DONE';
  
  // Target element ID (for CLICK, TYPE, SELECT)
  targetId?: number;
  
  // Value to type/select (for TYPE, SELECT)
  value?: string;
  
  // Scroll direction and amount
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  
  // Navigation URL (for NAVIGATE)
  url?: string;
  
  // Confidence score (0.0 - 1.0)
  confidence: number;
  
  // Human-readable reasoning
  reasoning: string;
  
  // Execution metadata
  metadata: {
    latency_ms: number;
    model: string;          // Which model handled this
    step: number;
    timestamp: string;      // ISO 8601
  };
}
```

**Example Request:**

```json
{
  "elements": [
    {"id": 1, "role": "input", "label": "Aadhaar Number", "x": 100, "y": 200, "width": 300, "height": 40, "type": "text"},
    {"id": 2, "role": "input", "label": "Name", "x": 100, "y": 260, "width": 300, "height": 40, "type": "text"},
    {"id": 3, "role": "button", "label": "Submit", "x": 100, "y": 350, "width": 100, "height": 40}
  ],
  "task": "Fill form with test data and submit",
  "step": 1,
  "history": []
}
```

**Example Response:**

```json
{
  "action": "TYPE",
  "targetId": 1,
  "value": "123456789012",
  "confidence": 0.95,
  "reasoning": "First field is Aadhaar input; filling with test 12-digit number",
  "metadata": {
    "latency_ms": 850,
    "model": "qwen2.5:1.5b",
    "step": 1,
    "timestamp": "2026-08-29T10:30:00Z"
  }
}
```

### 7.2 GET /health

**Response:**

```json
{
  "status": "healthy",
  "uptime_seconds": 1234,
  "model": "qwen2.5:1.5b",
  "ram_mb": 256,
  "requests_processed": 42
}
```

### 7.3 Error Responses

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid element schema",
    "details": [...],
    "timestamp": "2026-08-29T10:30:00Z"
  }
}
```

---

## 8. Milestone Checklist for September 2 Hackathon

### Phase 1: Foundation (Day 1 — Aug 29)

**Day 1 — Saturday**
- [x] Initialize WXT project structure
- [ ] Set up content script skeleton
- [ ] Implement DOM extraction (Anirudh)
- [ ] Create basic popup UI (Himanshi)
- [ ] Scaffold FastAPI server (Yuvraj)
- [ ] Set up request validation middleware (Laavannya)

### Phase 2: Core Features (Day 2 — Aug 30)

**Day 2 — Sunday**
- [ ] Load Florence-2 ONNX in-browser (Yash)
- [ ] Implement WebGPU inference pipeline (Yash)
- [ ] Create SoM overlay component (Himanshi)
- [ ] Set up background service worker (Anirudh)
- [ ] Implement `/plan` endpoint with Ollama (Yuvraj)
- [ ] Add PII detectors: Aadhaar, PAN, Luhn (Laavannya)
- [ ] Build privacy ledger UI (Himanshi)

### Phase 3: Integration (Day 3 — Aug 31)

**Day 3 — Monday**
- [ ] Build action executor (Anirudh)
- [ ] Connect full pipeline: DOM → vision → sanitize → plan → execute
- [ ] Create latency HUD (Himanshi)
- [ ] Add resource monitor (Yash)
- [ ] Integrate Ollama client with fallback (Yuvraj)
- [ ] Add error handling (Laavannya)
- [ ] Build mock government portal form
- [ ] Test end-to-end form filling

### Phase 4: Polish & Demo (Day 4 — Sep 1)

**Day 4 — Tuesday**
- [ ] Polish UI and fix bugs
- [ ] Create split-screen trust view
- [ ] Record backup demo video (60-90s)
- [ ] Prepare slide deck in official SIH template
- [ ] Rehearse judge Q&A responses
- [ ] Verify all evaluation criteria demonstrable
- [ ] Final code freeze

### Critical Path Items

🔴 **Must Have (Show to Judges):**
1. Working Chrome extension with DOM extraction
2. Florence-2 vision pipeline with SoM overlay
3. PII detection with privacy ledger
4. FastAPI planner returning actions
5. End-to-end form filling demo
6. Latency and resource HUD

🟡 **Should Have (Nice to Have):**
1. Firefox compatibility
2. Cloud API fallback
3. Offline mode demonstration
4. Adversarial PII test

🟢 **Could Have (Stretch Goals):**
1. Model fine-tuning results
2. Performance optimization report
3. Browser extension store packaging

---

## Appendix A: Technology Stack Summary

| Category | Technology | Purpose |
|----------|-----------|---------|
| Extension Framework | WXT | Cross-browser extension development |
| UI Library | React 19 + TypeScript | Component-based UI |
| Styling | TailwindCSS | Utility-first CSS |
| Inference | Transformers.js v3 | In-browser ML inference |
| Backend | FastAPI | Async Python API server |
| LLM | Ollama | Local model inference |
| Vision Model | Florence-2-base-ft ONNX | GUI grounding |
| GPU Acceleration | WebGPU | Hardware-accelerated inference |
| Fallback | WASM | Firefox/older browser support |

---

## Appendix B: Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| WebGPU unavailable | Medium | High | WASM fallback implemented |
| Model accuracy insufficient | Medium | Medium | Hybrid DOM+vision consensus |
| PII detector misses data | Low | High | Defense in depth, multiple detectors |
| Latency exceeds targets | Medium | Medium | Tiered pipeline, DOM fast path |
| Firefox compatibility issues | High | Medium | Early testing, WXT compatibility layer |
| Scope creep | High | High | Strict feature freeze on Day 5 |

---

## Appendix C: Team Contact Reference

| Member | Role | GitHub | Primary Focus |
|--------|------|--------|---------------|
| Himanshi | Frontend | @Himanshi-256 | Popup UI, SoM Overlay, Privacy Ledger, HUD |
| Anirudh | Frontend | @anirudh657 | Content Script, DOM Extraction, Action Executor |
| Yuvraj | Backend | @YuvrajGora | FastAPI Server, Ollama Integration, Planner API |
| Laavannya | Backend | TBD | Middleware, Validation, Logging, Error Handling |
| Yash | Optimization + Testing | @Yashop965 | Model Quantization, WebGPU, Profiling, Tests, Demo |
| Vedant | Support | @Vedant-Singhal | Bug reporting, Firefox testing, ad-hoc support |

---

*Document Version: 1.0*  
*Last Updated: August 29, 2026*  
*Author: SIH2026 PS171 Team*
