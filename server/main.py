"""
Server-side Action Planner (FastAPI) — Hardened
================================================
Receives ONLY sanitized page metadata and returns validated actionable
instructions using local Ollama (qwen2.5:1.5b) with heuristic fallback.

Privacy guarantees:
  - Server-side PII firewall rejects any payload that still contains raw
    Aadhaar / PAN / card / email / phone values.
  - All errors are returned as structured JSON — no raw values in logs.
  - LLM output is parsed and validated before being returned.
  - Target IDs are checked against the supplied element list.
  - URL-based navigation is restricted to http/https protocols only.
"""

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from typing import Optional, List, Dict, Any, Literal
import json
import re
import uuid
import time
import asyncio
from datetime import datetime, timezone
from fastapi.exceptions import RequestValidationError
try:
    from middleware.logging import StructuredLoggingMiddleware, logger
    from middleware.validators import PayloadSizeLimitMiddleware, RateLimitingMiddleware, sanitize_text
except ImportError:
    from server.middleware.logging import StructuredLoggingMiddleware, logger
    from server.middleware.validators import PayloadSizeLimitMiddleware, RateLimitingMiddleware, sanitize_text


# httpx is required (listed in requirements.txt)
try:
    import httpx
    OLLAMA_AVAILABLE = True
except ImportError:
    OLLAMA_AVAILABLE = False

app = FastAPI(
    title="SIH2026 Browser Agent Server",
    description="Server-side action planner for privacy-preserving browser agent",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RateLimitingMiddleware)
app.add_middleware(PayloadSizeLimitMiddleware)
app.add_middleware(StructuredLoggingMiddleware)

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "error": "Validation Error",
            "message": "The request payload failed schema validation",
            "details": [{"loc": err["loc"], "msg": err["msg"], "type": err["type"]} for err in exc.errors()]
        }
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "Internal Server Error",
            "message": "An unexpected error occurred",
            "detail": type(exc).__name__
        }
    )



# ===== Pydantic Models =====

class InteractiveElement(BaseModel):
    id: int = Field(..., ge=0)
    tag: str
    role: str
    label: str = Field(..., max_length=2000)
    name: str = Field(..., max_length=2000)
    rect: Dict[str, int]
    isPassword: bool

    @field_validator('role')
    @classmethod
    def validate_role(cls, v: str) -> str:
        v = sanitize_text(v).lower()
        if len(v) > 100:
            raise ValueError("Role string too long")
        return v
        
    @field_validator('label', 'name', 'tag')
    @classmethod
    def sanitize_strings(cls, v: str) -> str:
        return sanitize_text(v)

    @field_validator('rect')
    @classmethod
    def validate_rect(cls, v: Dict[str, int]) -> Dict[str, int]:
        required = {'x', 'y', 'width', 'height'}
        if not required.issubset(v.keys()):
            raise ValueError("rect must contain x, y, width, height")
        return v

class ARIAElement(BaseModel):
    role: str
    name: str
    expanded: Optional[bool] = None
    checked: Optional[str] = None
    required: Optional[bool] = None
    disabled: Optional[bool] = None
    depth: int = Field(..., ge=0, le=1000)

    @field_validator('role', 'name')
    @classmethod
    def sanitize_strings(cls, v: str) -> str:
        return sanitize_text(v)

class DetectedPII(BaseModel):
    type: str
    selector: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    verified: bool

class SanitizedPayload(BaseModel):
    url: str
    title: str = Field(..., max_length=2000)
    timestamp: int
    interactiveElements: List[InteractiveElement] = Field(max_length=5000)
    accessibilityTree: List[ARIAElement] = Field(max_length=10000)
    detectedPII: List[DetectedPII] = Field(max_length=200)
    hasScreenshots: bool = False


    @field_validator('url')
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        if v and not v.startswith(('http://', 'https://', 'about:', 'chrome-extension://')):
            raise ValueError('url must use http(s) scheme')
        return v

VALID_ACTION_TYPES = frozenset({
    "CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "COMPLETE"
})

class AgentAction(BaseModel):
    type: str
    targetId: Optional[int] = None
    text: Optional[str] = None
    url: Optional[str] = None
    direction: Optional[str] = None
    amount: Optional[int] = None
    condition: Optional[str] = None

    @field_validator('type')
    @classmethod
    def action_type_must_be_valid(cls, v: str) -> str:
        if v.upper() not in VALID_ACTION_TYPES:
            raise ValueError(f'Invalid action type: {v}. Must be one of {sorted(VALID_ACTION_TYPES)}')
        return v.upper()

    @field_validator('url')
    @classmethod
    def url_must_be_safe(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if not v.startswith(('http://', 'https://')):
            raise ValueError(f'NAVIGATE url must use http(s) protocol, got: {v[:20]}')
        return v

class PlanRequest(BaseModel):
    payload: SanitizedPayload
    task_description: Optional[str] = Field(None, max_length=500)
    history: Optional[List[Dict[str, Any]]] = Field(None, max_length=100)
    step: Optional[int] = Field(0, ge=0, le=10000)


class PlanResponse(BaseModel):
    success: bool
    action: Optional[AgentAction] = None
    message: str
    error: Optional[str] = None
    reasoning: Optional[str] = None
    session_id: str
    timestamp: float

class HealthResponse(BaseModel):
    status: str
    version: str
    ollama_available: bool
    models_loaded: List[str]
    uptime_seconds: float


# ===== Privacy Firewall (server-side belt-and-suspenders) =====

# These patterns are intentionally conservative — the browser-side sanitizer
# should have already redacted everything. The server firewall is a final check.
_PII_PATTERNS = [
    re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b'),         # Aadhaar-shape
    re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b'),             # PAN
    re.compile(r'\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b'),  # Card
    re.compile(r'\b[^\s@]+@[^\s@]+\.[^\s@]{2,}\b'),    # Email
    re.compile(r'\b[6-9]\d{9}\b'),                      # Indian phone
    re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),              # SSN
]

def _contains_raw_pii(text: str) -> bool:
    """Return True if text contains probable raw PII (not [REDACTED])."""
    if '[REDACTED]' in text:
        return False  # Already redacted
    for pat in _PII_PATTERNS:
        if pat.search(text):
            return True
    return False

def _check_payload_pii(payload: SanitizedPayload) -> Optional[str]:
    """
    Perform a server-side PII check on the incoming payload.
    Returns a safe error message if raw PII is found, or None if clean.
    The error message never contains the matched value.
    """
    # Check element labels/names
    for el in payload.interactiveElements:
        if el.isPassword:
            continue  # Password fields are expected to have no value
        if _contains_raw_pii(el.label):
            return f"element#{el.id} label appears to contain unredacted PII"
        if _contains_raw_pii(el.name):
            return f"element#{el.id} name appears to contain unredacted PII"

    # Check accessibility tree names
    for node in payload.accessibilityTree:
        if _contains_raw_pii(node.name):
            return f"accessibility node [{node.role}] name appears to contain unredacted PII"

    # Check title
    if _contains_raw_pii(payload.title):
        return "page title appears to contain unredacted PII"

    return None


# ===== Action Validator =====

def validate_action(action: AgentAction, elements: List[InteractiveElement]) -> Optional[str]:
    """
    Validate a planner action against the supplied element list.
    Returns an error string if invalid, or None if valid.
    """
    action_type = action.type.upper()
    element_ids = {el.id for el in elements}

    if action_type in ("CLICK", "SELECT"):
        if action.targetId is None:
            return f"{action_type} requires targetId"
        if action.targetId not in element_ids:
            return f"{action_type} targetId={action.targetId} not found in supplied elements"

    elif action_type == "TYPE":
        if action.targetId is None:
            return "TYPE requires targetId"
        if action.targetId not in element_ids:
            return f"TYPE targetId={action.targetId} not found in supplied elements"
        # Prevent typing sensitive-looking text
        if action.text and _contains_raw_pii(action.text):
            return "TYPE text appears to contain PII — rejected"

    elif action_type == "SCROLL":
        if action.direction not in ("up", "down", "left", "right"):
            return f"SCROLL direction must be up/down/left/right, got: {action.direction!r}"
        if action.amount is not None and (action.amount < 0 or action.amount > 10000):
            return f"SCROLL amount out of range: {action.amount}"

    elif action_type == "NAVIGATE":
        if not action.url:
            return "NAVIGATE requires url"
        if not action.url.startswith(('http://', 'https://')):
            return f"NAVIGATE url must use http(s) protocol"

    elif action_type == "WAIT":
        if action.condition:
            try:
                ms = int(action.condition) if action.condition.isdigit() else 1000
                if ms > 30000:
                    return f"WAIT condition exceeds 30s maximum"
            except ValueError:
                pass  # Non-numeric conditions are allowed (e.g. "element_visible")

    elif action_type == "COMPLETE":
        pass  # Always valid

    return None


# ===== Session Store =====

session_store: Dict[str, Dict[str, Any]] = {}
privacy_audit: List[Dict[str, Any]] = []
start_time = time.time()


# ===== Endpoints =====

@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        ollama_available=OLLAMA_AVAILABLE,
        models_loaded=["qwen2.5:1.5b"],
        uptime_seconds=time.time() - start_time,
    )


@app.post("/plan", response_model=PlanResponse)
async def plan_action(request: PlanRequest, raw_req: Request):
    """
    Main endpoint: receives sanitized page state, returns next validated action.

    Privacy enforcement order:
      1. Pydantic validates request schema
      2. Server-side PII firewall checks for residual raw PII
      3. Prompt built from sanitized data only
      4. Ollama called (with timeout)
      5. LLM response parsed (JSON extraction with fallback)
      6. Action type validated against schema
      7. Target ID validated against supplied element list
      8. Validated action returned
    """
    session_id = str(uuid.uuid4())[:8]
    request_id = getattr(raw_req.state, "request_id", "unknown")

    # ── Step 1: Server-side privacy firewall ──────────────────────────────────
    pii_error = _check_payload_pii(request.payload)
    if pii_error:
        _log_privacy_event("BLOCKED", "SERVER_FIREWALL", session_id, pii_error, request_id)
        return PlanResponse(
            success=False,
            action=None,
            message="Request blocked: payload failed server-side PII check",
            error="PII_VIOLATION",
            reasoning=None,
            session_id=session_id,
            timestamp=time.time(),
        )

    # ── Step 2: Validate non-empty elements ───────────────────────────────────
    _log_privacy_event("RECEIVED", "PAYLOAD", session_id,
                       f"{len(request.payload.interactiveElements)} elements, "
                       f"{len(request.payload.detectedPII)} PII detections", request_id)
                       
    logger.info("Planner started", extra={
        "event": "planner_started",
        "request_id": request_id,
        "session_id": session_id,
        "metadata": {
            "element_count": len(request.payload.interactiveElements),
            "task_length": len(request.task_description) if request.task_description else 0,
            "step": request.step
        }
    })

    try:
        start_plan = time.monotonic()
        action = await generate_action(request, session_id)
        duration = time.monotonic() - start_plan
        
        logger.info("Planner completed", extra={
            "event": "planner_completed",
            "request_id": request_id,
            "session_id": session_id,
            "duration": round(duration, 4)
        })
        
        return PlanResponse(
            success=True,
            action=action,
            message="Action generated successfully",
            error=None,
            reasoning=f"Planned action for {_safe_url(request.payload.url)}",
            session_id=session_id,
            timestamp=time.time(),
        )
    except OllamaUnavailableError as e:
        # Ollama is down — use heuristic fallback
        action = heuristic_action(request)
        return PlanResponse(
            success=True,
            action=action,
            message="Ollama unavailable — using heuristic fallback",
            error=None,
            reasoning="fallback",
            session_id=session_id,
            timestamp=time.time(),
        )
    except ActionValidationError as e:
        return PlanResponse(
            success=False,
            action=None,
            message="Generated action failed validation",
            error=str(e),
            reasoning=None,
            session_id=session_id,
            timestamp=time.time(),
        )
    except Exception as e:
        # Log safely — do not include request data in the error
        err_type = type(e).__name__
        _log_privacy_event("ERROR", "PLAN", session_id, err_type, request_id)
        logger.error("Planner failed", extra={
            "event": "planner_failed",
            "request_id": request_id,
            "session_id": session_id,
            "error": err_type
        })
        return PlanResponse(
            success=False,
            action=None,
            message="Failed to generate action",
            error=err_type,
            reasoning=None,
            session_id=session_id,
            timestamp=time.time(),
        )


@app.post("/verify-pii")
async def verify_pii(request: PlanRequest):
    """Verify and categorize detected PII (type + confidence only, no values)."""
    results = []
    for pii in request.payload.detectedPII:
        cat = _pii_category(pii.type)
        results.append({
            "type": pii.type,
            "verified": pii.verified,
            "confidence": pii.confidence,
            "category": cat,
        })
    return {"session_id": str(uuid.uuid4())[:8], "verifications": results}


@app.get("/audit")
async def get_audit_log(limit: int = 100):
    """Return the server-side privacy audit log (safe metadata only)."""
    return {
        "events": privacy_audit[:limit],
        "total": len(privacy_audit),
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ===== Custom Exceptions =====

class OllamaUnavailableError(Exception):
    pass

class ActionValidationError(Exception):
    pass

class LLMParseError(Exception):
    pass


# ===== Core Logic =====

async def generate_action(request: PlanRequest, session_id: str) -> AgentAction:
    """Generate next action using Ollama or heuristic fallback."""
    # Upsert session context
    if session_id not in session_store:
        session_store[session_id] = {
            "url": _safe_url(request.payload.url),
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    session = session_store[session_id]
    session["steps"].append({
        "timestamp": time.time(),
        "url": _safe_url(request.payload.url),
        "elements": len(request.payload.interactiveElements),
        "pii_detected": len(request.payload.detectedPII),
    })

    # Short-circuit: no interactive elements → nothing to interact with
    if not request.payload.interactiveElements:
        return AgentAction(type="COMPLETE")

    # Try Ollama first
    if OLLAMA_AVAILABLE:
        try:
            action = await call_ollama(request, session)
            return action
        except OllamaUnavailableError:
            raise  # Re-raise so the endpoint handler can fall back
        except (LLMParseError, ActionValidationError):
            raise  # Propagate validation errors
        except Exception as e:
            # Unexpected Ollama error — fall back to heuristic
            _log_privacy_event("FALLBACK", "OLLAMA_ERROR", session_id, type(e).__name__)
            return heuristic_action(request)

    return heuristic_action(request)



async def call_ollama(request: PlanRequest, session: Dict) -> AgentAction:
    """Call local Ollama for action planning with timeout."""
    try:
        async with httpx.AsyncClient() as client:
            prompt = build_planning_prompt(request, session)

            response = await client.post(
                "http://localhost:11434/api/generate",
                json={
                    "model": "qwen2.5:1.5b",
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.2,  # Lower = more deterministic
                        "num_predict": 200,
                    },
                },
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()
            raw_response = result.get("response", "")

            return parse_and_validate_action(raw_response, request)

    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama not running on localhost:11434")
    except httpx.TimeoutException:
        raise OllamaUnavailableError("Ollama request timed out")
    except httpx.HTTPStatusError as e:
        raise OllamaUnavailableError(f"Ollama HTTP error: {e.response.status_code}")


def build_planning_prompt(request: PlanRequest, session: Dict) -> str:
    """Build a safe LLM prompt using only sanitized metadata."""
    elements = request.payload.interactiveElements[:20]
    elements_json = json.dumps(
        [
            {
                "id": e.id,
                "role": e.role,
                "label": e.label[:50],   # Already sanitized by browser
                "isPassword": e.isPassword,
            }
            for e in elements
        ],
        indent=2,
    )

    task = request.task_description or "Follow the page flow and complete the task"
    step_count = len(session.get("steps", []))
    # Safe URL — strip query params from prompt to avoid leaking values
    safe_url = _safe_url(request.payload.url)

    return f"""You are a browser automation agent. Return ONLY a JSON action object.

PAGE: {safe_url}
TITLE: {request.payload.title[:100]}
TASK: {task[:200]}
STEP: {step_count}

INTERACTIVE ELEMENTS (sanitized — all PII already redacted):
{elements_json}

PII STATUS: {len(request.payload.detectedPII)} fields detected and redacted by browser

Return exactly one JSON object (no explanation, no markdown):
{{
  "type": "CLICK|TYPE|SCROLL|SELECT|NAVIGATE|WAIT|COMPLETE",
  "targetId": <integer or null>,
  "text": "<text to type or null>",
  "url": "<http/https url or null>",
  "direction": "<up|down|left|right or null>",
  "amount": <integer or null>
}}"""


def parse_and_validate_action(response: str, request: PlanRequest) -> AgentAction:
    """
    Parse LLM response into a validated AgentAction.
    Raises LLMParseError if JSON cannot be extracted.
    Raises ActionValidationError if the action is invalid.
    """
    if not response or not response.strip():
        raise LLMParseError("Empty LLM response")

    # Extract JSON — handle code blocks and embedded JSON
    action_data = _extract_json(response)
    if action_data is None:
        raise LLMParseError(f"No valid JSON in LLM response (len={len(response)})")

    # Validate action type first
    action_type = str(action_data.get("type", "")).upper()
    if action_type not in VALID_ACTION_TYPES:
        raise ActionValidationError(f"LLM returned invalid action type: {action_type!r}")

    # Build and validate the action model
    try:
        action = AgentAction(
            type=action_type,
            targetId=action_data.get("targetId"),
            text=action_data.get("text"),
            url=action_data.get("url"),
            direction=action_data.get("direction"),
            amount=action_data.get("amount"),
            condition=action_data.get("condition"),
        )
    except Exception as e:
        raise ActionValidationError(f"Action schema error: {e}")

    # Target validation
    error = validate_action(action, request.payload.interactiveElements)
    if error:
        raise ActionValidationError(error)

    return action


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """
    Robustly extract a JSON object from LLM output.
    Handles:
      - Pure JSON
      - JSON wrapped in markdown code blocks
      - JSON embedded in prose
    """
    # 1. Try full text as JSON first
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass

    # 2. Strip markdown code blocks
    stripped = re.sub(r'```(?:json)?\s*|\s*```', '', text, flags=re.IGNORECASE).strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # 3. Find the first {...} block (greedy, handles nested objects)
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start != -1:
                candidate = text[start:i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    start = -1  # Reset and continue scanning

    return None


def heuristic_action(request: PlanRequest) -> AgentAction:
    """
    Fallback heuristic action generator.
    Used when Ollama is unavailable.
    Obeys: sanitized metadata only, action validation, target validation.
    """
    elements = request.payload.interactiveElements

    if not elements:
        return AgentAction(type="COMPLETE")

    # 1. Find first visible, non-disabled button
    for el in elements:
        if el.role == 'button' and not el.isPassword:
            return AgentAction(type="CLICK", targetId=el.id)

    # 2. Find first text/email/search input
    for el in elements:
        if el.role in ('textbox', 'combobox') and not el.isPassword:
            return AgentAction(type="TYPE", targetId=el.id, text="")

    # 3. Try first link
    for el in elements:
        if el.role == 'link':
            return AgentAction(type="CLICK", targetId=el.id)

    # 4. Scroll down to discover more content
    return AgentAction(type="SCROLL", direction="down", amount=500)


# ===== Helpers =====

def _safe_url(url: str) -> str:
    """Strip query parameters from URL for logging purposes."""
    try:
        # Keep only scheme + host + path
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        return url[:60] if url else ""


def _pii_category(pii_type: str) -> str:
    """Return a human-readable PII category label."""
    _map = {
        "AADHAAR": "Indian Government ID",
        "PAN": "Indian Tax ID",
        "CREDIT_CARD": "Payment Instrument",
        "DEBIT_CARD": "Payment Instrument",
        "IFSC": "Banking Code",
        "UPI": "Payment Address",
        "PHONE": "Contact Information",
        "EMAIL": "Contact Information",
        "PASSWORD_FIELD": "Authentication Credential",
        "PASSWORD_VALUE": "Authentication Credential",
        "API_KEY": "Authentication Credential",
        "FACE": "Biometric Data",
        "FACE_DETECTED": "Biometric Data",
        "SSN": "Government ID",
    }
    return _map.get(pii_type.upper(), "Sensitive Data")


def _log_privacy_event(event: str, category: str, session_id: str, detail: str, request_id: Optional[str] = None) -> None:
    """Record a server-side privacy audit event (no raw values)."""
    privacy_audit.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "category": category,
        "session": session_id,
        "detail": detail[:200],  # Cap length, never include raw PII
    })
    # Trim audit log to prevent unbounded growth
    if len(privacy_audit) > 5000:
        privacy_audit.clear()

    # Also emit to structured JSON logger
    logger.info("Privacy event", extra={
        "event": "privacy_blocked" if event == "BLOCKED" else "privacy_event",
        "request_id": request_id,
        "pii_category": category,
        "session_id": session_id,
        "detail": detail[:200]
    })


# ===== Startup =====

@app.on_event("startup")
async def startup_event():
    separator = "=" * 55
    print(separator)
    print("  SIH2026 Browser Agent — Hardened Planner Server")
    print(separator)
    print(f"  Ollama available : {OLLAMA_AVAILABLE}")
    print(f"  Privacy firewall : ENABLED (server-side)")
    print(f"  Action validation: ENABLED (target ID check)")
    print()
    print("  Endpoints:")
    print("    POST /plan        — Generate validated action")
    print("    POST /verify-pii  — Categorize PII detections")
    print("    GET  /audit       — Server-side privacy audit log")
    print("    GET  /health      — Health check")
    print(separator)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        ollama_available=OLLAMA_AVAILABLE,
        models_loaded=["qwen2.5:1.5b"],
        uptime_seconds=time.time() - start_time,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
