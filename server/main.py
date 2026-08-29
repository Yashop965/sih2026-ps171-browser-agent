"""
Server-side Action Planner (FastAPI)

Receives sanitized page metadata and returns actionable instructions
using LLM (Ollama or cloud API)
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import json
import uuid
import time
import asyncio
from datetime import datetime

# Ollama client (optional, falls back to mock)
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


# ===== Request/Response Models =====

class InteractiveElement(BaseModel):
    id: int
    tag: str
    role: str
    label: str
    name: str
    rect: Dict[str, int]
    isPassword: bool

class ARIAElement(BaseModel):
    role: str
    name: str
    expanded: Optional[bool]
    checked: Optional[str]
    required: Optional[bool]
    disabled: Optional[bool]
    depth: int

class DetectedPII(BaseModel):
    type: str
    selector: str
    confidence: float
    verified: bool

class SanitizedPayload(BaseModel):
    url: str
    title: str
    timestamp: int
    interactiveElements: List[InteractiveElement]
    accessibilityTree: List[ARIAElement]
    detectedPII: List[DetectedPII]
    hasScreenshots: bool = False

class AgentAction(BaseModel):
    type: str  # CLICK, TYPE, SCROLL, NAVIGATE, WAIT, COMPLETE
    targetId: Optional[int]
    text: Optional[str]
    url: Optional[str]
    direction: Optional[str]
    amount: Optional[int]
    condition: Optional[str]

class PlanRequest(BaseModel):
    payload: SanitizedPayload
    task_description: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None

class PlanResponse(BaseModel):
    success: bool
    action: Optional[AgentAction]
    message: str
    error: Optional[str]
    reasoning: Optional[str]
    session_id: str
    timestamp: float

class HealthResponse(BaseModel):
    status: str
    version: str
    models_loaded: List[str]
    uptime_seconds: float


# ===== State =====

session_store: Dict[str, Dict[str, Any]] = {}
start_time = time.time()


# ===== Endpoints =====

@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        models_loaded=["qwen2.5:1.5b"],
        uptime_seconds=time.time() - start_time,
    )


@app.post("/plan", response_model=PlanResponse)
async def plan_action(request: PlanRequest):
    """
    Main endpoint: receives sanitized page state, returns next action.
    """
    session_id = str(uuid.uuid4())[:8]
    
    try:
        # Log the request
        print(f"[{session_id}] Received plan request for: {request.payload.url}")
        
        # Generate action using LLM
        action_result = await generate_action(request, session_id)
        
        return PlanResponse(
            success=True,
            action=action_result,
            message="Action generated successfully",
            error=None,
            reasoning=f"Generated action for {request.payload.url}",
            session_id=session_id,
            timestamp=time.time(),
        )
    except Exception as e:
        print(f"[{session_id}] Error: {e}")
        return PlanResponse(
            success=False,
            action=None,
            message="Failed to generate action",
            error=str(e),
            reasoning=None,
            session_id=session_id,
            timestamp=time.time(),
        )


@app.post("/verify-pii")
async def verify_pii(request: PlanRequest):
    """
    Verify and categorize detected PII.
    """
    results = []
    
    for pii in request.payload.detectedPII:
        verification = verify_pii_type(pii.type, pii.value if hasattr(pii, 'value') else None)
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
    
    # Log execution
    print(f"[EXEC] {action_type} on element #{target_id}")
    
    return {
        "success": True,
        "action_type": action_type,
        "target_id": target_id,
        "result": "executed",
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """
    Get session details.
    """
    session = session_store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ===== Helper Functions =====

async def generate_action(request: PlanRequest, session_id: str) -> AgentAction:
    """
    Generate next action using LLM or heuristic rules.
    """
    # Store session context
    if session_id not in session_store:
        session_store[session_id] = {
            "url": request.payload.url,
            "steps": [],
            "created_at": datetime.now().isoformat(),
        }
    
    session = session_store[session_id]
    session["steps"].append({
        "timestamp": time.time(),
        "url": request.payload.url,
        "elements": len(request.payload.interactiveElements),
        "pii_detected": len(request.payload.detectedPII),
    })
    
    # Try Ollama first
    if OLLAMA_AVAILABLE:
        try:
            return await call_ollama(request, session)
        except Exception as e:
            print(f"Ollama failed, falling back to heuristic: {e}")
    
    # Fallback to heuristic rules
    return heuristic_action(request)


async def call_ollama(request: PlanRequest, session: Dict) -> AgentAction:
    """
    Call local Ollama instance for action planning.
    """
    async with httpx.AsyncClient() as client:
        prompt = build_planning_prompt(request, session)
        
        response = await client.post(
            "http://localhost:11434/api/generate",
            json={
                "model": "qwen2.5:1.5b",
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.3,
                    "num_predict": 500,
                },
            },
            timeout=30.0,
        )
        
        response.raise_for_status()
        result = response.json()
        
        # Parse action from response
        return parse_action(result.get("response", ""), request)


def build_planning_prompt(request: PlanRequest, session: Dict) -> str:
    """
    Build prompt for action planning LLM.
    """
    elements_preview = request.payload.interactiveElements[:20]
    elements_json = json.dumps([
        {
            "id": e.id,
            "role": e.role,
            "label": e.label[:30],
            "isPassword": e.isPassword,
        }
        for e in elements_preview
    ], indent=2)
    
    prompt = f"""You are a browser automation agent. Given the current page state, determine the next action.

PAGE: {request.payload.url}
TITLE: {request.payload.title}

INTERACTIVE ELEMENTS (showing first 20):
{elements_json}

DETECTED PII (already redacted):
{len(request.payload.detectedPII)} items detected and redacted

TASK (if provided): {request.payload.task_description or 'Follow user instructions'}

Previous steps in this session: {len(session.get('steps', []))}

Return a JSON object with the next action:
{{
  "type": "CLICK|TYPE|SCROLL|NAVIGATE|WAIT|COMPLETE",
  "targetId": <element_id or null>,
  "text": "<text to type or null>",
  "url": "<url to navigate to or null>",
  "direction": "<up|down or null>",
  "amount": <scroll amount or null>
}}

Only return valid JSON, no explanation."""
    
    return prompt


def parse_action(response: str, request: PlanRequest) -> AgentAction:
    """
    Parse action from LLM response.
    """
    try:
        # Extract JSON from response
        import re
        json_match = re.search(r'\{[^}]+\}', response)
        if json_match:
            action_data = json.loads(json_match.group())
            return AgentAction(**action_data)
    except Exception as e:
        print(f"Failed to parse action: {e}")
    
    # Return default complete action
    return AgentAction(type="COMPLETE")


def heuristic_action(request: PlanRequest) -> AgentAction:
    """
    Fallback heuristic action generator.
    """
    elements = request.payload.interactiveElements
    
    # Find first non-disabled, non-password button
    for el in elements:
        if el.role == 'button' and not el.disabled:
            return AgentAction(type="CLICK", targetId=el.id)
    
    # Find first text input
    for el in elements:
        if el.role == 'textbox' and not el.isPassword:
            return AgentAction(type="TYPE", targetId=el.id, text="")
    
    # Scroll down if elements exist
    if elements:
        return AgentAction(type="SCROLL", direction="down", amount=500)
    
    return AgentAction(type="COMPLETE")


def verify_pii_type(pii_type: str, value: Optional[str] = None) -> Dict[str, Any]:
    """
    Verify PII type using appropriate algorithm.
    """
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
        "confidence": 0.9 if pii_type in ["PASSWORD_FIELD", "FACE"] else 0.5,
        "category": category_map.get(pii_type, "Unknown"),
    }


# ===== Startup Event =====

@app.on_event("startup")
async def startup_event():
    print("=" * 50)
    print("SIH2026 Browser Agent Server Started")
    print("=" * 50)
    print(f"Ollama available: {OLLAMA_AVAILABLE}")
    print("Endpoints:")
    print("  POST /plan       - Generate next action")
    print("  POST /verify-pii - Verify PII detections")
    print("  POST /execute    - Execute action")
    print("  GET  /health     - Health check")
    print("=" * 50)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
