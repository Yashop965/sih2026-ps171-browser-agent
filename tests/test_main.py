"""
FastAPI Planner Tests (rewritten 2026-09-21 against the post-split server API)
==============================================================================
This file was originally written against the monolithic pre-refactor
``server/main.py`` (parse_and_validate_action, validate_action, heuristic_action,
_extract_json, _check_payload_pii, _contains_raw_pii, AgentAction,
ActionValidationError, LLMParseError). That surface was split into
``server/planner.py`` + ``server/action_executor.py`` and the PII payload-gate
moved CLIENT-side (src/lib/pii/firewall.ts, outboundGuard.ts, redactor.ts —
covered by the vitest pii-* suites), so those names no longer exist in
server/. Every still-valid edge case is ported to the current API below:

  - JSON extraction        -> ActionPlanner._extract_json_substring
  - LLM-output parsing     -> ActionPlanner.parse_llm_output
  - heuristic_action       -> ActionPlanner._fallback_action (conservative,
                              issue #85 - only task-referenced fields)
  - action validation      -> the type/target gates inside parse_llm_output
  - AgentAction schema     -> valid action-type set + string/stableId
                               targetId resolution in parse_llm_output
  - /plan endpoint         -> current PlanRequest flat payload (no more
                              nested ``payload`` key, no /audit endpoint)

Dropped sections (coverage now lives elsewhere):
  - TestContainsRawPII / TestCheckPayloadPII / audit-log PII assertions ->
    the server-side PII gate was moved to the client firewall (issue #61):
    src/lib/pii/firewall.ts + outboundGuard.ts, tested by the vitest
    pii-* suites.
  - TestAgentActionSchema javascript: URL 422 -> the server no longer
    validates URL schemes; scheme safety is enforced client-side
    (planner prompt + executor).

Run: server/.venv/Scripts/python -m pytest tests/test_main.py -v
"""

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

# Import the FastAPI app from the server module (repo-root layout).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server.main import app
from server.planner import ActionPlanner, ActionSchema, MockLLMClient


# ─── Fixtures ──────────────────────────────────────────────────────────────────

def make_element(id, role="button", label="Click me", name="btn",
                 is_password=False, tag=None):
    """Plain dict element in the shape planner.parse_llm_output consumes
    (the raw_elements produced by InteractiveElement.model_dump())."""
    return {
        "id": id,
        "tag": tag or ("button" if role in ("button", "submit") else "input"),
        "role": role,
        "label": label,
        "name": name,
        "rect": {"x": 0, "y": 0, "width": 100, "height": 40},
        "isPassword": is_password,
        "interactive": True,
    }


@pytest.fixture
def planner():
    return ActionPlanner(llm_client=MockLLMClient())


@pytest.fixture
def client():
    """Synchronous client for endpoint tests."""
    return TestClient(app)


# ─── Health Check ──────────────────────────────────────────────────────────────

class TestHealthCheck:
    def test_health_returns_200(self, client):
        r = client.get("/health")
        assert r.status_code == 200

    def test_health_contains_status(self, client):
        data = client.get("/health").json()
        assert data["status"] == "healthy"
        assert "uptime_seconds" in data
        assert "version" in data


# ─── _extract_json_substring (was _extract_json) ──────────────────────────────

class TestExtractJsonSubstring:
    """ActionPlanner._extract_json_substring returns the raw JSON *string*
    (parse_llm_output json.loads it) - not a parsed dict like the old
    _extract_json did."""

    def test_parses_plain_json(self, planner):
        raw = planner._extract_json_substring('{"type": "CLICK", "targetId": 1}')
        assert raw is not None
        assert json.loads(raw) == {"type": "CLICK", "targetId": 1}

    def test_parses_json_in_markdown_code_block(self, planner):
        text = '```json\n{"type": "SCROLL", "direction": "down"}\n```'
        raw = planner._extract_json_substring(text)
        assert raw is not None
        assert json.loads(raw)["type"] == "SCROLL"

    def test_parses_json_embedded_in_prose(self, planner):
        text = 'I will click the button. {"type": "CLICK", "targetId": 2} That is the action.'
        raw = planner._extract_json_substring(text)
        assert raw is not None
        assert json.loads(raw)["type"] == "CLICK"

    def test_parses_nested_json(self, planner):
        text = '{"type": "NAVIGATE", "url": "https://example.com/path"}'
        raw = planner._extract_json_substring(text)
        assert raw is not None
        assert json.loads(raw)["url"] == "https://example.com/path"

    def test_returns_none_for_empty_string(self, planner):
        assert planner._extract_json_substring("") is None

    def test_returns_none_for_non_json(self, planner):
        assert planner._extract_json_substring("This is just text, no JSON here.") is None

    def test_returns_none_for_truncated_json(self, planner):
        # Unbalanced brace -> no \{.*\} match -> None.
        assert planner._extract_json_substring('{"type": "CLICK"') is None


# ─── parse_llm_output (was parse_and_validate_action) ────────────────────────

class TestParseLLMOutput:
    """The current planner never RAISES on bad LLM output - it degrades to a
    conservative fallback (issues #85/#68: success=True, degraded=True)."""

    def test_parses_valid_click_action(self, planner):
        res = planner.parse_llm_output(
            '{"type": "CLICK", "targetId": 1}',
            [make_element(1), make_element(2)],
        )
        assert res.success
        assert res.degraded is False
        assert res.action.type == "CLICK"
        assert res.action.targetId == 1

    def test_parses_valid_scroll_action(self, planner):
        res = planner.parse_llm_output(
            '{"type": "SCROLL", "scrollDirection": "down", "scrollAmount": 400}', [])
        assert res.success
        assert res.action.type == "SCROLL"
        assert res.action.scrollDirection == "down"

    def test_parses_done_action(self, planner):
        # Ported from the old test_parses_complete_action: COMPLETE is now DONE.
        res = planner.parse_llm_output('{"type": "DONE"}', [])
        assert res.success
        assert res.action.type == "DONE"
        assert res.confidence == 1.0

    def test_degrades_on_empty_response(self, planner):
        res = planner.parse_llm_output("", [make_element(1)])
        # No JSON -> fallback. Nothing task-referenced (no task text) -> WAIT,
        # and every fallback is flagged degraded.
        assert res.success
        assert res.degraded is True
        assert res.action.type == "WAIT"

    def test_degrades_on_non_json_response(self, planner):
        res = planner.parse_llm_output("I cannot determine the action", [make_element(1)])
        assert res.degraded is True
        assert res.action.type == "WAIT"

    def test_degrades_on_invalid_action_type(self, planner):
        res = planner.parse_llm_output('{"type": "HACK", "targetId": 1}', [make_element(1)])
        assert res.degraded is True

    def test_degrades_when_targetid_not_in_elements(self, planner):
        res = planner.parse_llm_output(
            '{"type": "CLICK", "targetId": 99}',
            [make_element(1), make_element(2)],
        )
        assert res.degraded is True
        assert "not found" in (res.error or res.reasoning)

    def test_resolves_numeric_string_targetid(self, planner):
        # The model sometimes emits targetId as a string - it must resolve.
        res = planner.parse_llm_output(
            '{"type": "CLICK", "targetId": "2"}',
            [make_element(1), make_element(2)],
        )
        assert res.success and res.degraded is False
        assert res.action.targetId == 2

    def test_resolves_stableid_targetid(self, planner):
        els = [
            make_element(1),
            {"id": 2, "tag": "input", "role": "textbox", "label": "Search",
             "name": "", "isPassword": False, "stableId": "searchInput"},
        ]
        res = planner.parse_llm_output('{"type": "CLICK", "targetId": "searchInput"}', els)
        assert res.success
        assert res.action.targetId == 2

    def test_wait_defaults_waitms(self, planner):
        res = planner.parse_llm_output('{"type": "WAIT"}', [])
        assert res.success
        assert res.action.waitMs == 1000


# ─── Conservative fallback (was heuristic_action) ────────────────────────────

class TestConservativeFallback:
    """Issue #85: the fallback only ever touches fields the TASK references.
    The old blind "click first button / type into first textbox" behaviour is
    gone - so several old assertions are ported to their new (safer) form."""

    def test_no_elements_yields_wait(self, planner):
        res = planner._fallback_action([], "parse failed", task_description="do a thing")
        assert res.success
        assert res.action.type == "WAIT"
        assert res.degraded is True

    def test_types_task_value_into_task_referenced_field(self, planner):
        els = [make_element(1, role="textbox", label="First Name",
                           name="firstName", tag="input")]
        res = planner._fallback_action(els, "parse failed",
                                       task_description="First Name: Alice, Last Name: Bob")
        assert res.action.type == "TYPE"
        assert res.action.targetId == 1
        assert res.action.value == "Alice"  # value comes from the task, not invented

    def test_search_task_types_into_search_box(self, planner):
        els = [make_element(1, role="textbox", label="Search Wikipedia",
                           name="searchInput", tag="input")]
        res = planner._fallback_action(els, "llm error", task_description="search Web browser")
        assert res.action.type == "TYPE"
        assert res.action.targetId == 1
        assert res.action.value == "search"  # first word of the task

    def test_prefers_non_password_button_on_task_keyword(self, planner):
        # Ported from old test_skips_password_buttons: isPassword elements are
        # skipped in every fallback pass; the non-password twin is clicked.
        els = [
            make_element(1, role="button", label="Submit", is_password=True),
            make_element(2, role="button", label="Submit", is_password=False),
        ]
        res = planner._fallback_action(els, "llm error", task_description="submit the form")
        assert res.action.type == "CLICK"
        assert res.action.targetId == 2

    def test_clicks_task_keyword_button(self, planner):
        # Ported from old test_clicks_first_button: still CLICKs a button, but
        # only because label/task match a keyword - never the blind first one.
        els = [make_element(5, role="button", label="Search")]
        res = planner._fallback_action(els, "llm error", task_description="search for Web browser")
        assert res.action.type == "CLICK"
        assert res.action.targetId == 5

    def test_unreferenced_textbox_no_longer_blindly_typed(self, planner):
        # Ported from old test_types_into_textbox_when_no_button: the #85 fix
        # removed "type Test Data into the first live input". A textbox the
        # task does NOT reference now degrades to WAIT.
        els = [make_element(1, role="textbox", label="Comment", tag="input")]
        res = planner._fallback_action(els, "llm error", task_description="some unrelated task")
        assert res.action.type == "WAIT"
        assert res.degraded is True

    def test_search_task_clicks_collapsed_search_toggle(self, planner):
        # Ported from old test_scrolls_when_only_link_available: on a search
        # task with no visible textbox, a visible "Search"-labelled link is
        # clicked (pass 3b) instead of a blind scroll.
        els = [make_element(1, role="link", label="Search", tag="a")]
        els[0]["width"] = 44  # fallback gate checks top-level width >= 2
        res = planner._fallback_action(els, "llm error", task_description="search Web browser")
        assert res.action.type == "CLICK"
        assert res.action.targetId == 1


# ─── Checklist normalization (parse_llm_output side-output) ───────────────────

class TestChecklistNormalization:
    def test_list_of_strings(self, planner):
        res = planner.parse_llm_output(
            '{"type": "DONE", "checklist": ["fill form", "submit form"]}', [])
        assert [c.description for c in res.checklist] == ["fill form", "submit form"]
        assert all(c.done is False for c in res.checklist)

    def test_dict_variant_with_label_and_completed(self, planner):
        res = planner.parse_llm_output(
            '{"type": "DONE", "checklist": [{"label": "open page", "completed": true}]}', [])
        assert res.checklist[0].description == "open page"
        assert res.checklist[0].done is True

    def test_non_list_degrades_to_empty(self, planner):
        res = planner.parse_llm_output('{"type": "DONE", "checklist": "oops"}', [])
        assert res.checklist == []


# ─── /plan endpoint (current flat payload - no nested `payload` key) ──────────

def make_request(elements: list | None = None, task: str = "Test task",
                 url: str = "https://example.com") -> dict:
    return {
        "url": url,
        "title": "Test Page",
        "task": task,
        "task_description": task,
        "interactiveElements": elements if elements is not None else [make_element(1)],
    }


class TestPlanEndpoint:
    def test_returns_action_for_valid_request(self, client):
        r = client.post("/plan", json=make_request())
        assert r.status_code == 200
        data = r.json()
        assert "action" in data
        assert "session_id" in data
        assert data["success"] is True

    def test_returns_valid_action_structure(self, client):
        data = client.post("/plan", json=make_request()).json()
        if data.get("action"):
            assert "type" in data["action"]
            assert data["action"]["type"] in [
                "CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "KEY", "DONE"
            ]

    def test_empty_elements_still_returns_action(self, client):
        # The mock LLM answers DONE; the endpoint must not 500 on an empty page.
        r = client.post("/plan", json=make_request(elements=[]))
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_javascript_url_not_rejected_server_side(self, client):
        # Ported from old test_rejects_non_http_url (422): the server no longer
        # validates URL schemes - scheme safety is enforced client-side
        # (planner prompt + executor). The endpoint must still behave.
        r = client.post("/plan", json=make_request(url="javascript:alert(1)"))
        assert r.status_code == 200
        assert "action" in r.json()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
