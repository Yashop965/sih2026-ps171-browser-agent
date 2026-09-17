# API Documentation — SIH2026 PS171 Browser Agent

## Server Endpoints

Base URL: `http://localhost:8000`

---

### POST `/plan`

Generate next action based on current page state. The planner accepts both a
flat root payload (popup direct calls) and a nested `payload` object. A
`checklist` of sub-goals may be fed back so the planner cannot re-do
completed steps (cross-page memory, PR #99).

**Request Body:**
```json
{
  "task": "Fill the form with test data",
  "url": "https://example.com/form",
  "title": "Enrollment Form",
  "interactiveElements": [
    {
      "id": 1,
      "tag": "input",
      "role": "textbox",
      "label": "Full Name",
      "name": "name",
      "rect": {"x": 100, "y": 200, "width": 300, "height": 40},
      "isPassword": false
    }
  ],
  "accessibilityTree": [],
  "detectedPII": [],
  "history": [],
  "context": {"scrollY": 0, "scrollHeight": 800, "moreContentBelow": false},
  "checklist": [
    {"id": "1", "description": "fill name", "done": true},
    {"id": "2", "description": "submit", "done": false}
  ]
}
```

**Response:**
```json
{
  "success": true,
  "action": {
    "type": "TYPE",
    "targetId": 1,
    "value": "John Doe"
  },
  "message": "Typed into Full Name",
  "reasoning": "Text input field detected, populating from task key-value pairs",
  "confidence": 0.95,
  "session_id": "a1b2c3",
  "timestamp": 1758158400.123,
  "checklist": [
    {"id": "1", "description": "fill name", "done": true},
    {"id": "2", "description": "submit", "done": false}
  ],
  "degraded": false,
  "degraded_reason": null
}
```

> **Contract notes:**
> - `action.type` is one of `CLICK | TYPE | SCROLL | SELECT | NAVIGATE | WAIT | KEY | DONE`.
>   `WAIT` carries `waitMs`; `KEY` carries `key`; `NAVIGATE` carries `url`;
>   `SCROLL` carries `scrollDirection`/`scrollAmount`.
> - `checklist` echoes the planner-maintained task checklist (may be empty).
>   The runner gates `DONE` on it (sticky-`done`, first-seen order).
> - `degraded: true` means this step was produced by a heuristic/mock fallback
>   (no LLM reachable at init, or a runtime LLM error). A `DONE` emitted while
>   degraded is **not** a genuine completion — the runner ignores it
>   (3-strike cap, then best-effort).
> - Smoke-test a healthy planner: `POST /plan` → assert `degraded: false`
>   **and** that `checklist` echoes back.

---

### POST `/verify-pii`

Verify + categorize each detected PII value. Takes a full `PlanRequest`; the
server validates each `detectedPII` entry locally (Verhoeff for Aadhaar, Luhn
for cards, format checks otherwise) — no LLM.

**Request Body:**
```json
{
  "task": "",
  "detectedPII": [
    {"type": "AADHAAR", "value": "123456789012", "verified": true},
    {"type": "CREDIT_CARD", "value": "4111111111111111"}
  ]
}
```

**Response:**
```json
{
  "session_id": "a1b2c3d4",
  "verifications": [
    {"type": "AADHAAR", "verified": true, "confidence": 0.98, "category": "Indian Government ID"},
    {"type": "CREDIT_CARD", "verified": true, "confidence": 0.99, "category": "Payment Instrument"}
  ]
}
```

Known PII `type` values: `AADHAAR`, `PAN`, `CREDIT_CARD`, `DEBIT_CARD`, `IFSC`,
`PHONE`, `EMAIL`, `PASSWORD_FIELD`, `API_KEY`, `FACE`, `SSN`.

---

### POST `/execute`

Execute an action via the fallback executor (UACC when available).

**Request Body:**
```json
{
  "type": "CLICK",
  "targetId": 1
}
```

**Response:**
```json
{
  "success": true,
  "action_type": "CLICK",
  "target_id": 1,
  "result": "executed"
}
```

---

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "models_loaded": ["action_planner"],
  "uptime_seconds": 1234.56
}
```

---

### GET `/sessions/{session_id}`

Retrieve a planner session's recorded state (404 if unknown).

**Response:** the stored session record for that `session_id`.

---

## Extension Content Script API

The content script communicates with the background service worker via browser messaging.

### Messages from Content Script to Background

**Type: `DOM_EXTRACT`**
```typescript
interface DomExtractMessage {
  type: 'DOM_EXTRACT';
  payload: {
    tabId: number;
    timestamp: number;
    elements: SanitizedElement[];
    screenshot?: string; // base64
  };
}
```

**Type: `PII_DETECTED`**
```typescript
interface PiiDetectedMessage {
  type: 'PII_DETECTED';
  payload: {
    tabId: number;
    timestamp: number;
    detections: DetectedPII[];
    redactedHtml: string;
  };
}
```

**Type: `ACTION_RESULT`**
```typescript
interface ActionResultMessage {
  type: 'ACTION_RESULT';
  payload: {
    tabId: number;
    actionType: string;
    targetId: number;
    success: boolean;
    message: string;
  };
}
```

### Messages from Background to Content Script

**Type: `EXECUTE_ACTION`**
```typescript
interface ExecuteActionMessage {
  type: 'EXECUTE_ACTION';
  payload: {
    action: AgentAction;
    verify: boolean;
  };
}
```

**Type: `UPDATE_LEDGER`**
```typescript
interface UpdateLedgerMessage {
  type: 'UPDATE_LEDGER';
  payload: {
    entries: PrivacyEntry[];
  };
}
```

---

## Types

### SanitizedElement
```typescript
interface SanitizedElement {
  id: number;
  tag: string;           // 'input', 'button', 'select', etc.
  role: string;          // 'textbox', 'button', 'combobox', etc.
  label: string;         // Accessible name (redacted if PII)
  name: string;          // Element name attribute
  rect: {                // Bounding rectangle
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPassword: boolean;
  isEmpty: boolean;
}
```

### AgentAction

Matches `Action` in `src/lib/actions.ts` and `ActionSchema` in
`server/planner.py`.

```typescript
interface AgentAction {
  type: 'CLICK' | 'TYPE' | 'SCROLL' | 'SELECT' | 'NAVIGATE' | 'WAIT' | 'KEY' | 'DONE';
  // Numeric registry id or stableId string
  targetId?: number | string;
  // TYPE / SELECT / KEY value
  value?: string;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  // NAVIGATE destination
  url?: string;
  // WAIT: settle time in ms (executor cap 30s)
  waitMs?: number;
  // KEY: "Enter", "Tab", "Escape", "ArrowDown", or a printable char
  key?: string;
}
```

### DetectedPII

Matches `DetectedPII` in `src/types/index.ts`.

```typescript
type PIIType =
  | 'AADHAAR' | 'PAN' | 'CREDIT_CARD' | 'IFSC' | 'PHONE' | 'EMAIL'
  | 'PASSWORD_FIELD' | 'API_KEY' | 'FACE_DETECTED' | 'TEXT_PASSWORD';

interface DetectedPII {
  type: PIIType;
  value?: string;      // never transmitted — presence + confidence only
  selector: string;
  confidence: number;
  isVerified?: boolean;
  redacted: boolean;
}
```

### PrivacyEntry
```typescript
interface PrivacyEntry {
  id: string;
  timestamp: string;
  tabId: number;
  action: 'DETECTED' | 'REDACTED' | 'BLOCKED' | 'SENT';
  piiType: string;
  valueMasked: string;  // e.g., "XXXX-XXXX-1234"
  context: string;
}
```

---

## Error Responses

All endpoints return standard HTTP error codes:

| Code | Meaning |
|------|---------|
| 400 | Bad Request — invalid input format (Pydantic validation) |
| 404 | Not Found — endpoint or session doesn't exist |
| 422 | Unprocessable Entity — payload validation failure |
| 429 | Too Many Requests — global per-IP rate limit hit (100/min) |
| 413 | Payload too large — exceeds the 50 KB request cap |
| 500 | Internal Server Error — unhandled exception |

**Error Response Format:**
```json
{
  "detail": "Error message describing what went wrong"
}
```

> A transient LLM failure does **not** surface as a 5xx — the planner degrades
> to a conservative heuristic fallback and returns `degraded: true` in the body
> (see `/plan` contract notes), so the agent keeps moving without typing blind
> test data.

---

## Rate Limits & Payload Cap

- **Rate limit (global, per client IP):** 100 requests / 60 s sliding window →
  HTTP 429 on exceed. Applies to every endpoint.
- **Payload size cap:** 50 KB per request (enforced in
  `PayloadSizeLimitMiddleware`).
- The extension's PII values are never in the payload — only type, presence,
  confidence, and a CSS selector — so the cap is generous for a full page.

---

## Authentication

No authentication for local development (single trust boundary: your machine).
For a deployed planner, add API-key auth and restrict CORS origins
(currently `allow_origins=["*"]`) — the LLM key itself is read from
`server/.env` (`LLM_API_KEY`), never baked into the client.
