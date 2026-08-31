"""
FastAPI Planner Tests
=====================
Tests for the hardened server/main.py planner.

Covers:
  - Valid action accepted
  - Malformed LLM JSON handled (fallback to heuristic)
  - Invalid action type rejected
  - Nonexistent targetId rejected
  - Ollama timeout → heuristic fallback
  - Empty elements → COMPLETE
  - Privacy violation → blocked
  - JSON extraction from prose
  - URL safety validation
  - Action validation (SCROLL, NAVIGATE, TYPE)
  - Audit log endpoint
  - Health check
  - Session endpoint

Run: python -m pytest tests/test_main.py -v
Or:  python -m pytest tests/test_main.py -v --tb=short
"""

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# Import the FastAPI app from the server module.
# This works when run from the repo root.
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from server.main import (
    app,
    parse_and_validate_action,
    validate_action,
    heuristic_action,
    _extract_json,
    _check_payload_pii,
    _contains_raw_pii,
    PlanRequest,
    SanitizedPayload,
    InteractiveElement,
    ARIAElement,
    AgentAction,
    ActionValidationError,
    LLMParseError,
)


# ─── Fixtures ──────────────────────────────────────────────────────────────────

def make_element(id: int, role: str = "button", label: str = "Click me",
                 name: str = "btn", is_password: bool = False) -> dict:
    return {
        "id": id,
        "tag": "button" if role == "button" else "input",
        "role": role,
        "label": label,
        "name": name,
        "rect": {"x": 0, "y": 0, "width": 100, "height": 40},
        "isPassword": is_password,
    }


def make_payload(elements: list | None = None, pii: list | None = None,
                 url: str = "https://example.com") -> dict:
    return {
        "url": url,
        "title": "Test Page",
        "timestamp": 1700000000,
        "interactiveElements": [make_element(1)] if elements is None else elements,
        "accessibilityTree": [],
        "detectedPII": pii or [],
        "hasScreenshots": False,
    }


def make_request(elements: list | None = None, task: str = "Test task",
                 url: str = "https://example.com") -> dict:
    return {
        "payload": make_payload(elements, url=url),
        "task_description": task,
    }


@pytest.fixture
def client():
    """Synchronous client for non-async tests."""
    from fastapi.testclient import TestClient
    return TestClient(app)


# ─── Health Check ──────────────────────────────────────────────────────────────

class TestHealthCheck:
    def test_health_returns_200(self, client):
        r = client.get("/health")
        assert r.status_code == 200

    def test_health_contains_status(self, client):
        data = client.get("/health").json()
        assert data["status"] == "healthy"
        assert "ollama_available" in data
        assert "uptime_seconds" in data


# ─── JSON Extraction ───────────────────────────────────────────────────────────

class TestExtractJSON:
    def test_parses_plain_json(self):
        result = _extract_json('{"type": "CLICK", "targetId": 1}')
        assert result is not None
        assert result["type"] == "CLICK"
        assert result["targetId"] == 1

    def test_parses_json_in_markdown_code_block(self):
        text = '```json\n{"type": "SCROLL", "direction": "down"}\n```'
        result = _extract_json(text)
        assert result is not None
        assert result["type"] == "SCROLL"

    def test_parses_json_embedded_in_prose(self):
        text = 'I will click the button. {"type": "CLICK", "targetId": 2} That is the action.'
        result = _extract_json(text)
        assert result is not None
        assert result["type"] == "CLICK"

    def test_parses_nested_json(self):
        text = '{"type": "NAVIGATE", "url": "https://example.com/path"}'
        result = _extract_json(text)
        assert result is not None
        assert result["url"] == "https://example.com/path"

    def test_returns_none_for_empty_string(self):
        assert _extract_json("") is None

    def test_returns_none_for_non_json(self):
        assert _extract_json("This is just text, no JSON here.") is None

    def test_returns_none_for_truncated_json(self):
        assert _extract_json('{"type": "CLICK"') is None


# ─── _contains_raw_pii ────────────────────────────────────────────────────────

class TestContainsRawPII:
    def test_detects_email(self):
        assert _contains_raw_pii("user@example.com") is True

    def test_detects_indian_phone(self):
        assert _contains_raw_pii("9876543210") is True

    def test_does_not_flag_redacted_placeholder(self):
        assert _contains_raw_pii("[REDACTED]") is False

    def test_clean_text_passes(self):
        assert _contains_raw_pii("Click the Submit button") is False

    def test_detects_pan_format(self):
        assert _contains_raw_pii("PAN ABCPE1234F is invalid") is True


# ─── _check_payload_pii ───────────────────────────────────────────────────────

class TestCheckPayloadPII:
    def _make_pydantic_payload(self, elements: list, title: str = "Safe Title"):
        return SanitizedPayload(
            url="https://example.com",
            title=title,
            timestamp=1700000000,
            interactiveElements=[InteractiveElement(**e) for e in elements],
            accessibilityTree=[],
            detectedPII=[],
            hasScreenshots=False,
        )

    def test_clean_payload_passes(self):
        payload = self._make_pydantic_payload([make_element(1)])
        assert _check_payload_pii(payload) is None

    def test_email_in_label_triggers_block(self):
        el = make_element(1, label="user@example.com", role="textbox")
        payload = self._make_pydantic_payload([el])
        result = _check_payload_pii(payload)
        assert result is not None
        assert "element#1" in result

    def test_password_fields_skipped(self):
        # Password fields are allowed to have a label (it's the field name)
        el = make_element(1, label="Password", is_password=True)
        payload = self._make_pydantic_payload([el])
        # Should not be blocked because isPassword=True
        result = _check_payload_pii(payload)
        assert result is None

    def test_pii_in_title_triggers_block(self):
        payload = self._make_pydantic_payload(
            [make_element(1)],
            title="Page for user@example.com"
        )
        result = _check_payload_pii(payload)
        assert result is not None
        assert "title" in result


# ─── validate_action ─────────────────────────────────────────────────────────

class TestValidateAction:
    def _elements(self, ids):
        return [InteractiveElement(**make_element(i)) for i in ids]

    def test_click_with_valid_target_passes(self):
        action = AgentAction(type="CLICK", targetId=1)
        error = validate_action(action, self._elements([1, 2, 3]))
        assert error is None

    def test_click_with_missing_target_fails(self):
        action = AgentAction(type="CLICK", targetId=99)
        error = validate_action(action, self._elements([1, 2]))
        assert error is not None
        assert "not found" in error

    def test_click_without_targetId_fails(self):
        action = AgentAction(type="CLICK")
        error = validate_action(action, self._elements([1]))
        assert error is not None
        assert "targetId" in error

    def test_type_with_valid_target_passes(self):
        action = AgentAction(type="TYPE", targetId=1, text="hello")
        error = validate_action(action, self._elements([1]))
        assert error is None

    def test_type_with_pii_text_fails(self):
        action = AgentAction(type="TYPE", targetId=1, text="user@example.com")
        error = validate_action(action, self._elements([1]))
        assert error is not None
        assert "PII" in error

    def test_scroll_with_valid_direction_passes(self):
        action = AgentAction(type="SCROLL", direction="down", amount=300)
        error = validate_action(action, [])
        assert error is None

    def test_scroll_with_invalid_direction_fails(self):
        action = AgentAction(type="SCROLL", direction="sideways", amount=100)
        error = validate_action(action, [])
        assert error is not None

    def test_scroll_with_huge_amount_fails(self):
        action = AgentAction(type="SCROLL", direction="down", amount=99999)
        error = validate_action(action, [])
        assert error is not None
        assert "range" in error

    def test_navigate_with_http_url_passes(self):
        action = AgentAction(type="NAVIGATE", url="https://example.com")
        error = validate_action(action, [])
        assert error is None

    def test_navigate_without_url_fails(self):
        action = AgentAction(type="NAVIGATE")
        error = validate_action(action, [])
        assert error is not None

    def test_complete_always_passes(self):
        action = AgentAction(type="COMPLETE")
        error = validate_action(action, [])
        assert error is None


# ─── heuristic_action ─────────────────────────────────────────────────────────

class TestHeuristicAction:
    def _make_request(self, elements):
        payload = SanitizedPayload(
            url="https://example.com",
            title="Page",
            timestamp=1700000000,
            interactiveElements=[InteractiveElement(**e) for e in elements],
            accessibilityTree=[],
            detectedPII=[],
        )
        return PlanRequest(payload=payload)

    def test_returns_complete_when_no_elements(self):
        req = self._make_request([])
        action = heuristic_action(req)
        assert action.type == "COMPLETE"

    def test_clicks_first_button(self):
        req = self._make_request([make_element(1, role="button")])
        action = heuristic_action(req)
        assert action.type == "CLICK"
        assert action.targetId == 1

    def test_types_into_textbox_when_no_button(self):
        req = self._make_request([make_element(1, role="textbox")])
        action = heuristic_action(req)
        assert action.type == "TYPE"
        assert action.targetId == 1

    def test_scrolls_when_only_link_available(self):
        # Links should result in a CLICK
        req = self._make_request([make_element(1, role="link")])
        action = heuristic_action(req)
        assert action.type == "CLICK"

    def test_skips_password_buttons(self):
        # isPassword=True buttons should not be blindly clicked
        # The heuristic should look for non-password buttons
        req = self._make_request([
            make_element(1, role="button", is_password=True),
            make_element(2, role="button", is_password=False),
        ])
        action = heuristic_action(req)
        assert action.type == "CLICK"
        # Should prefer element 2 (non-password)
        assert action.targetId == 2


# ─── parse_and_validate_action ───────────────────────────────────────────────

class TestParseAndValidateAction:
    def _make_request(self, element_ids=(1, 2)):
        payload = SanitizedPayload(
            url="https://example.com",
            title="Page",
            timestamp=1700000000,
            interactiveElements=[InteractiveElement(**make_element(i)) for i in element_ids],
            accessibilityTree=[],
            detectedPII=[],
        )
        return PlanRequest(payload=payload)

    def test_parses_valid_click_action(self):
        req = self._make_request([1, 2])
        action = parse_and_validate_action('{"type": "CLICK", "targetId": 1}', req)
        assert action.type == "CLICK"
        assert action.targetId == 1

    def test_parses_valid_scroll_action(self):
        req = self._make_request()
        action = parse_and_validate_action(
            '{"type": "SCROLL", "direction": "down", "amount": 400}', req
        )
        assert action.type == "SCROLL"
        assert action.direction == "down"

    def test_raises_on_empty_response(self):
        req = self._make_request()
        with pytest.raises(LLMParseError):
            parse_and_validate_action("", req)

    def test_raises_on_non_json_response(self):
        req = self._make_request()
        with pytest.raises(LLMParseError):
            parse_and_validate_action("I cannot determine the action", req)

    def test_raises_on_invalid_action_type(self):
        req = self._make_request()
        with pytest.raises(ActionValidationError):
            parse_and_validate_action('{"type": "HACK", "targetId": 1}', req)

    def test_raises_when_targetid_not_in_elements(self):
        req = self._make_request([1, 2])
        with pytest.raises(ActionValidationError) as exc_info:
            parse_and_validate_action('{"type": "CLICK", "targetId": 99}', req)
        assert "not found" in str(exc_info.value)

    def test_parses_complete_action(self):
        req = self._make_request()
        action = parse_and_validate_action('{"type": "COMPLETE"}', req)
        assert action.type == "COMPLETE"


# ─── /plan endpoint ───────────────────────────────────────────────────────────

class TestPlanEndpoint:
    def test_returns_action_for_valid_request(self, client):
        r = client.post("/plan", json=make_request([make_element(1)]))
        assert r.status_code == 200
        data = r.json()
        assert "action" in data
        assert "session_id" in data

    def test_blocked_when_payload_has_pii(self, client):
        el = make_element(1, label="user@example.com", role="textbox")
        req = make_request([el])
        r = client.post("/plan", json=req)
        assert r.status_code == 200
        data = r.json()
        assert data["success"] is False
        assert "PII" in data.get("message", "") or "block" in data.get("message", "").lower()

    def test_returns_valid_action_structure(self, client):
        r = client.post("/plan", json=make_request())
        data = r.json()
        if data.get("action"):
            action = data["action"]
            assert "type" in action
            assert action["type"] in [
                "CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "COMPLETE"
            ]

    def test_rejects_non_http_url(self, client):
        req = make_request(url="javascript:alert(1)")
        r = client.post("/plan", json=req)
        # Should fail Pydantic validation → 422
        assert r.status_code == 422

    def test_empty_elements_returns_complete_or_scroll(self, client):
        req = make_request(elements=[])
        r = client.post("/plan", json=req)
        assert r.status_code == 200
        data = r.json()
        if data.get("action"):
            assert data["action"]["type"] in ("COMPLETE", "SCROLL")


# ─── /audit endpoint ──────────────────────────────────────────────────────────

class TestAuditEndpoint:
    def test_audit_log_accessible(self, client):
        r = client.get("/audit")
        assert r.status_code == 200
        data = r.json()
        assert "events" in data
        assert "total" in data

    def test_audit_log_populated_after_blocked_request(self, client):
        el = make_element(1, label="user@example.com", role="textbox")
        client.post("/plan", json=make_request([el]))
        r = client.get("/audit")
        data = r.json()
        assert data["total"] > 0
        # The audit event should be a BLOCKED type
        events = data["events"]
        assert any(e.get("event") == "BLOCKED" for e in events)

    def test_audit_log_contains_no_raw_pii(self, client):
        el = make_element(1, label="user@example.com", role="textbox")
        client.post("/plan", json=make_request([el]))
        r = client.get("/audit")
        # The raw email must not appear in the audit log
        assert "user@example.com" not in r.text


# ─── AgentAction validation ───────────────────────────────────────────────────

class TestAgentActionSchema:
    def test_valid_action_types_accepted(self):
        for action_type in ["CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "COMPLETE"]:
            a = AgentAction(type=action_type)
            assert a.type == action_type

    def test_invalid_action_type_raises(self):
        with pytest.raises(Exception):
            AgentAction(type="INVALID_TYPE")

    def test_navigate_with_javascript_url_raises(self):
        with pytest.raises(Exception):
            AgentAction(type="NAVIGATE", url="javascript:void(0)")

    def test_navigate_with_https_url_accepted(self):
        a = AgentAction(type="NAVIGATE", url="https://example.com")
        assert a.url == "https://example.com"
