# API Documentation — SIH2026 PS171 Browser Agent

## Server Endpoints

Base URL: `http://localhost:8000`

---

### POST `/plan`

Generate next action based on current page state.

**Request Body:**
```json
{
  "task": "Fill the form with test data",
  "payload": {
    "url": "https://example.com/form",
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
    "detectedPII": [],
    "screenCapture": null
  }
}
```

**Response:**
```json
{
  "action": {
    "type": "TYPE",
    "targetId": 1,
    "text": "John Doe",
    "verified": true
  },
  "confidence": 0.95,
  "reasoning": "Text input field detected, populating with test data"
}
```

---

### POST `/verify-pii`

Verify detected PII using appropriate validation algorithms.

**Request Body:**
```json
{
  "piiType": "AADHAAR",
  "value": "123456789012"
}
```

**Response:**
```json
{
  "verified": true,
  "confidence": 0.98,
  "category": "Indian Government ID",
  "validationMethod": "Verhoeff checksum"
}
```

---

### POST `/execute`

Execute an action via UACC or fallback executor.

**Request Body:**
```json
{
  "action": {
    "type": "CLICK",
    "targetId": 1
  }
}
```

**Response:**
```json
{
  "success": true,
  "actionType": "CLICK",
  "targetId": 1,
  "message": "Clicked element #1",
  "retries": 0,
  "verified": true
}
```

---

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-08-30T15:30:00Z",
  "ollamaAvailable": true,
  "uaccAvailable": true
}
```

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
```typescript
interface AgentAction {
  type: 'CLICK' | 'TYPE' | 'SCROLL' | 'NAVIGATE' | 'WAIT' | 'COMPLETE';
  targetId?: number;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  amount?: number;
}
```

### DetectedPII
```typescript
interface DetectedPII {
  type: PiiType;  // 'AADHAAR' | 'PAN' | 'CREDIT_CARD' | 'PHONE' | 'EMAIL' | 'PASSWORD_FIELD' | 'FACE'
  value: string;
  confidence: number;
  location: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  verification?: {
    verified: boolean;
    method: string;
  };
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
| 400 | Bad Request - Invalid input format |
| 404 | Not Found - Endpoint doesn't exist |
| 500 | Internal Server Error - Server crash or unhandled exception |
| 503 | Service Unavailable - Ollama/UACC not connected |

**Error Response Format:**
```json
{
  "detail": "Error message describing what went wrong"
}
```

---

## Rate Limits

- `/plan`: 10 requests per second
- `/execute`: 5 requests per second
- `/verify-pii`: Unlimited (local computation)

---

## Authentication

No authentication required for local development. For production deployment, implement API key authentication.
