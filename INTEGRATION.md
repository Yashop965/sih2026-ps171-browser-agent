# Integration Guide — External Tools & Agent Skills

**Project:** SIH2026 PS171 — On-device Visual Perception for Light-weight Browser Agents  
**Created:** August 29, 2026  
**Repository:** https://github.com/Yashop965/sih2026-ps171-browser-agent

---

## Overview

This project leverages three external open-source tools to accelerate development and strengthen the demo. Rather than building everything from scratch, we integrate proven tools where applicable — saving time during the 4-day hackathon while demonstrating awareness of the ecosystem.

---

## 1. UACC (Universal Agent Control & Coordination)

**Repo:** https://github.com/chrisjaron03/UACC  
**Stars:** ~36 | **Language:** Python | **License:** MIT

### What it does
UACC is a desktop automation MCP server with pixel-precise clicking, self-healing retries, and Set-of-Marks overlay support. It bridges CDP (Chrome DevTools Protocol) to execute actions reliably.

### How we use it
**Integration point:** `server/action_executor.py` — replace hand-rolled click/type logic with UACC's `smart_click`, `smart_type`, and `verify_action` functions.

**Why:** 
- Self-healing clicks reduce failure rate during demo
- Set-of-Marks (SoM) support aligns with our vision pipeline
- Verify action feature lets us confirm each step before proceeding

**Implementation plan:**
```python
# server/action_executor.py
from uacc import UACCClient

async def execute_action(action: ActionRequest) -> ActionResult:
    client = UACCClient(cdp_url="http://localhost:9222")
    
    if action.type == "CLICK":
        result = await client.smart_click(
            x=action.x, y=action.y,
            max_retries=3,
            verify=True
        )
    elif action.type == "TYPE":
        result = await client.smart_type(
            x=action.x, y=action.y,
            text=action.value,
            clear=True
        )
    
    return result
```

**Memory impact:** Minimal — runs server-side, not in browser extension. Adds ~50MB RAM on server.

---

## 2. OpenCLI Browser Bridge

**Repo:** https://github.com/laizhepai/opencli-browser-bridge  
**Stars:** ~1 | **Type:** Chrome Extension + CLI

### What it does
Bridges OpenCLI CLI commands to a live Chrome browser via CDP. Allows programmatic control of an existing Chrome session (with real cookies/logins).

### How we use it
**Integration point:** Testing and demo environment setup.

**Why:**
- We need a real logged-in browser session for the demo (not a blank page)
- Our extension works in dev mode, but UACC + OpenCLI bridge gives us a stable CDP endpoint
- Useful for creating the mock government portal with realistic page state

**Implementation plan:**
```bash
# During hackathon demo prep
opencli browser --cdp-port 9222
# Opens Chrome with CDP enabled at port 9222
# UACC connects to this same port
```

**Usage in demo flow:**
1. Start Chrome with CDP: `chrome --remote-debugging-port=9222`
2. Run OpenCLI bridge to expose CDP endpoints
3. UACC connects to same CDP port
4. Our extension sends actions through FastAPI → UACC → Chrome

**Limitations:**
- Only works with Chromium-based browsers
- Requires manual Chrome startup with debugging enabled
- Not suitable for Firefox (use WASM fallback path instead)

---

## 3. Agent Reach

**Repo:** https://github.com/Panniantong/agent-reach  
**Stars:** ~76,514 | **Language:** Python | **License:** MIT

### What it does
AI-powered internet research CLI. Searches Reddit, Twitter/X, YouTube, and other platforms using LLMs to summarize and extract insights.

### How we use it
**Integration point:** Research and content creation only — NOT part of the core product.

**Why:**
- Helps research competitor solutions and similar projects
- Can generate demo content (fake form data, sample PII for testing)
- Useful for creating realistic test scenarios

**Implementation plan:**
```python
# scripts/research.py — for demo preparation only
from agent_reach import search_platforms

# Generate realistic test data for demo
test_data = await search_platforms(
    queries=["sample Aadhaar number format", "Indian PAN card examples"],
    platform="reddit",
    count=5
)

# Use extracted patterns to create mock form data
mock_form_data = {
    "aadhaar": "1234 5678 9012",  # Validated format
    "pan": "ABCDE1234F",           # Validated format
    "name": "Test User",
    "email": "test@example.com"
}
```

**Not integrated into:** The browser extension or server. Used only in `scripts/` for demo preparation.

---

## Architecture Diagram — Where Each Tool Fits

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CLIENT (Browser Extension)                      │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐   │
│  │  DOM Extract │  │ Florence-2  │  │  PII Detection Engine   │   │
│  │  (Anirudh)   │  │  Vision     │  │  (Laavannya)             │   │
│  │             │  │  (Yash)     │  │                           │   │
│  │ • Acc tree   │  │ • WebGPU    │  │ • Aadhaar Verhoeff      │   │
│  │ • Bounding   │  │ • ~500ms    │  │ • PAN format            │   │
│  │ • Text       │  │             │  │ • Luhn cards            │   │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬──────────────┘   │
│         │                │                      │                  │
│         └────────────────┼──────────────────────┘                  │
│                          ▼                                         │
│              ┌─────────────────────┐                               │
│              │   Sanitized Payload │                               │
│              │   (Zero PII)        │                               │
│              └──────────┬──────────┘                               │
└─────────────────────────┼─────────────────────────────────────────┘
                          │ HTTP POST /plan
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SERVER (FastAPI)                                │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐   │
│  │   Request    │  │   Planner   │  │  Action Executor (UACC) │   │
│  │  Validator   │  │   (Yuvraj)  │  │                           │   │
│  │(Laavannya)   │  │             │  │ • smart_click            │   │
│  │             │  │ • Context   │  │ • smart_type             │   │
│  │ • Schema    │  │   building  │  │ • verify_action          │   │
│  │ • Rate limit│  │ • Reasoning │  │ • Self-healing retries   │   │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬──────────────┘   │
│         │                │                      │                  │
│         └────────────────┼──────────────────────┘                  │
│                          ▼                                         │
│              ┌─────────────────────┐                               │
│              │   Ollama (Local LLM)│                               │
│              │   qwen2.5:1.5b      │                               │
│              └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     DEMO ENVIRONMENT                                │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Chrome (CDP port 9222)                                      │   │
│  │  ├─ Mock government portal (test form)                       │   │
│  │  ├─ OpenCLI Browser Bridge (CDP access)                      │   │
│  │  └─ UACC connected to CDP (action execution)                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Agent Reach (Research only — not in demo)                   │   │
│  │  ├─ Generate test data                                       │   │
│  │  ├─ Research competitors                                     │   │
│  │  └─ Create demo content                                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Memory Budget Impact

| Component | Tool Used | RAM Impact | Notes |
|-----------|-----------|------------|-------|
| Client extension | None | ~270-300MB | Core product, within 500MB budget |
| Server process | UACC integration | +50MB | Runs on server, not client |
| Demo environment | OpenCLI bridge | N/A | External process, not counted |
| Research | Agent Reach | N/A | CLI tool, separate process |

**Total client RAM:** ~270-300MB (well within 500MB budget)  
**Total server RAM:** ~1.25GB (unbounded for SIH evaluation)

---

## Setup Instructions

### 1. Install UACC (server-side only)
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent/server
pip install -r requirements.txt
# UACC will be installed alongside
```

### 2. Configure CDP for demo
```bash
# Start Chrome with debugging enabled
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:/tmp/chrome-debug"

# In another terminal, verify CDP is accessible
curl http://localhost:9222/json
```

### 3. Use Agent Reach for research (optional)
```bash
# Install agent-reach
pip install agent-reach

# Generate test data
python scripts/research.py --query "sample Aadhaar format" --platform reddit
```

---

## When to Use Each Tool

| Scenario | Tool | Why |
|----------|------|-----|
| Clicking elements in demo | UACC | Self-healing, reliable |
| Filling forms in demo | UACC | Smart type with verification |
| Testing on real logged-in page | OpenCLI Bridge | Access to live Chrome session |
| Generating test data | Agent Reach | Realistic patterns from web |
| Researching competitors | Agent Reach | Fast insights from Reddit/Twitter |

---

## Files Modified/Added

- `server/action_executor.py` — UACC integration layer
- `server/requirements.txt` — Added UACC dependency
- `scripts/research.py` — Agent Reach wrapper for test data generation
- `docs/INTEGRATION.md` — This document

---

*Last updated: August 29, 2026*
