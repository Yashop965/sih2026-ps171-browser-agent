"""
Server-side Action Planner (FastAPI)

Receives sanitized page metadata and returns actionable instructions using LLM or fallback planner.
Includes 50KB request limit, sliding window rate limiting, and structured JSON logging.
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, root_validator
from typing import Optional, List, Dict, Any
import json
import uuid
import time
import asyncio
from datetime import datetime

from server.middleware.logging import JSONLoggingMiddleware
from server.middleware.validators import PayloadSizeLimitMiddleware, RateLimiterMiddleware
from server.planner import ActionPlanner, ActionSchema, PlannerResult

app = FastAPI(
    title="SIH2026 Browser Agent Server",
    description="Server-side action planner for privacy-preserving browser agent",
    version="1.0.0",
)

# Attach Middlewares (Logging, Rate Limiter, Payload Size Limiter)
app.add_middleware(JSONLoggingMiddleware)
app.add_middleware(RateLimiterMiddleware, max_requests=60, window_seconds=60)
app.add_middleware(PayloadSizeLimitMiddleware, max_bytes=50 * 1024)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== Request/Response Models =====

class InteractiveElement(BaseModel):
    id: Optional[int] = None
    tag: Optional[str] = None
    role: Optional[str] = None
    label: Optional[str] = ""
    name: Optional[str] = ""
    rect: Optional[Dict[str, Any]] = None
    isPassword: Optional[bool] = False
    interactive: Optional[bool] = True


class ARIAElement(BaseModel):
    role: Optional[str] = ""
    name: Optional[str] = ""
    expanded: Optional[bool] = None
    checked: Optional[str] = None
    required: Optional[bool] = None
    disabled: Optional[bool] = None
    depth: Optional[int] = 0


class DetectedPII(BaseModel):
    type: str
    selector: Optional[str] = ""
    confidence: Optional[float] = 1.0
    verified: Optional[bool] = False
    redacted: Optional[bool] = True


class SanitizedPayload(BaseModel):
    url: str
    title: Optional[str] = ""
    timestamp: Optional[int] = None
    interactiveElements: List[InteractiveElement] = Field(default_factory=list)
    accessibilityTree: List[ARIAElement] = Field(default_factory=list)
    detectedPII: List[DetectedPII] = Field(default_factory=list)
    hasScreenshots: Optional[bool] = False
    task_description: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None


class PlanRequest(BaseModel):
    payload: Optional[SanitizedPayload] = None
    url: Optional[str] = None
    title: Optional[str] = ""
    timestamp: Optional[int] = None
    interactiveElements: Optional[List[InteractiveElement]] = None
    accessibilityTree: Optional[List[ARIAElement]] = None
    detectedPII: Optional[List[DetectedPII]] = None
    task_description: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None

    def get_sanitized_payload(self) -> SanitizedPayload:
        """Flexible parser supporting both nested payload and flat root payloads."""
        if self.payload:
            return self.payload
        return SanitizedPayload(
            url=self.url or "http://localhost",
            title=self.title or "",
            timestamp=self.timestamp,
            interactiveElements=self.interactiveElements or [],
            accessibilityTree=self.accessibilityTree or [],
            detectedPII=self.detectedPII or [],
            task_description=self.task_description,
            history=self.history,
        )


class PlanResponse(BaseModel):
    success: bool
    action: Optional[ActionSchema]
    message: str
    error: Optional[str] = None
    reasoning: Optional[str] = None
    confidence: Optional[float] = 0.0
    session_id: str
    timestamp: float


class HealthResponse(BaseModel):
    status: str
    version: str
    models_loaded: List[str]
    uptime_seconds: float


# ===== State & Planner Initialization =====

session_store: Dict[str, Dict[str, Any]] = {}
start_time = time.time()
planner = ActionPlanner()


# ===== Endpoints =====

@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        models_loaded=["action_planner"],
        uptime_seconds=round(time.time() - start_time, 2),
    )


@app.post("/plan", response_model=PlanResponse)
async def plan_action(request: PlanRequest):
    """
    Main endpoint: receives sanitized page state, returns next action.
    Supports both nested PlanRequest and flat extension payloads.
    """
    session_id = str(uuid.uuid4())[:8]
    payload = request.get_sanitized_payload()

    try:
        # Convert elements & history to dictionary representations
        raw_elements = [el.model_dump() for el in payload.interactiveElements]
        raw_a11y = [el.model_dump() for el in payload.accessibilityTree]
        task_desc = payload.task_description or request.task_description
        history_list = payload.history or request.history

        # Delegate planning to planner module
        planner_result: PlannerResult = await planner.plan(
            url=payload.url,
            title=payload.title,
            interactive_elements=raw_elements,
            accessibility_tree=raw_a11y,
            task_description=task_desc,
            history=history_list,
        )

        return PlanResponse(
            success=planner_result.success,
            action=planner_result.action,
            message="Action generated successfully" if planner_result.success else "Action generation degraded",
            error=planner_result.error,
            reasoning=planner_result.reasoning,
            confidence=planner_result.confidence,
            session_id=session_id,
            timestamp=time.time(),
        )
    except Exception as e:
        return PlanResponse(
            success=False,
            action=None,
            message="Failed to generate action",
            error=str(e),
            reasoning=None,
            confidence=0.0,
            session_id=session_id,
            timestamp=time.time(),
        )


@app.post("/verify-pii")
async def verify_pii(request: PlanRequest):
    """
    Verify and categorize detected PII.
    """
    payload = request.get_sanitized_payload()
    results = []
    
    for pii in payload.detectedPII:
        verification = verify_pii_type(pii.type)
        results.append({
            "type": pii.type,
            "verified": verification["verified"],
            "confidence": verification["confidence"],
            "category": verification["category"],
        })
    
    return {"session_id": str(uuid.uuid4())[:8], "verifications": results}


@app.post("/execute")
async def execute_action(request: Dict[str, Any]):
    """
    Execute an action and return result.
    """
    action_type = request.get("type")
    target_id = request.get("targetId")
    
    return {
        "success": True,
        "action_type": action_type,
        "target_id": target_id,
        "result": "executed",
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ===== Helpers =====

def verify_pii_type(pii_type: str) -> Dict[str, Any]:
    category_map = {
        "AADHAAR": "Indian Government ID",
        "PAN": "Indian Tax ID",
        "CREDIT_CARD": "Payment Instrument",
        "DEBIT_CARD": "Payment Instrument",
        "IFSC": "Banking Code",
        "PHONE": "Contact Information",
        "EMAIL": "Contact Information",
        "PASSWORD_FIELD": "Authentication Credential",
        "API_KEY": "Authentication Credential",
        "FACE": "Biometric Data",
        "SSN": "Government ID",
    }
    
    return {
        "verified": pii_type in ["PASSWORD_FIELD", "FACE"],
        "confidence": 0.99 if pii_type in ["PASSWORD_FIELD", "FACE"] else 0.7,
        "category": category_map.get(pii_type, "Unknown"),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
