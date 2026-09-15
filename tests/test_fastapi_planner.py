"""
Unit Tests for FastAPI Server, Middlewares, and Action Planner (Issue #1 & Issue #3)
"""

import unittest
from fastapi.testclient import TestClient
from server.main import app
from server.planner import ActionPlanner, ActionSchema, MockLLMClient


class TestFastAPIPlanner(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    # ===== Issue #1 Server & Middleware Tests =====

    def test_health_endpoint(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "healthy")
        self.assertIn("uptime_seconds", data)
        self.assertIn("version", data)

    def test_plan_endpoint_flat_payload(self):
        payload = {
            "url": "https://example.com",
            "title": "Test Portal",
            "interactiveElements": [
                {"id": 1, "role": "button", "label": "Submit", "interactive": True},
                {"id": 2, "role": "textbox", "label": "Username", "isPassword": False}
            ]
        }
        response = self.client.post("/plan", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIn("action", data)
        self.assertIn("session_id", data)

    def test_plan_endpoint_nested_payload(self):
        payload = {
            "payload": {
                "url": "https://gov.in",
                "title": "Government Form",
                "interactiveElements": [
                    {"id": 1, "role": "button", "label": "Search"}
                ]
            },
            "task_description": "Search for records",
            "history": []
        }
        response = self.client.post("/plan", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        # Full LLM-planner action vocabulary. WAIT/NAVIGATE were added for
        # multi-page autonomy; a live LLM may legitimately return any of them
        # (e.g. WAIT "results will load after the search").
        self.assertIn(data["action"]["type"], ["CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "DONE"])

    def test_payload_50kb_rejection(self):
        large_label = "A" * (60 * 1024)
        payload = {
            "url": "https://example.com",
            "title": large_label,
            "interactiveElements": []
        }
        response = self.client.post("/plan", json=payload)
        self.assertEqual(response.status_code, 413)
        self.assertIn("50KB", response.json()["error"])

    # ===== Issue #3 Action Planner Unit Tests =====

    def test_planner_json_parsing_success(self):
        planner = ActionPlanner()
        elements = [{"id": 10, "role": "button", "label": "Login"}]
        llm_output = '```json\n{"type": "CLICK", "targetId": 10, "reasoning": "Clicking login button"}\n```'
        
        result = planner.parse_llm_output(llm_output, elements)
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "CLICK")
        self.assertEqual(result.action.targetId, 10)
        self.assertEqual(result.confidence, 0.85)

    def test_planner_invalid_target_id_fallback(self):
        planner = ActionPlanner()
        elements = [{"id": 1, "role": "button", "label": "Submit", "interactive": True}]
        llm_output = '{"type": "CLICK", "targetId": 999, "reasoning": "Click missing element"}'
        
        result = planner.parse_llm_output(llm_output, elements)
        self.assertTrue(result.success)
        self.assertEqual(result.action.targetId, 1)
        self.assertLess(result.confidence, 0.85)

    def test_planner_malformed_json_fallback(self):
        planner = ActionPlanner()
        elements = [{"id": 5, "role": "button", "label": "Proceed"}]
        llm_output = "I think you should click on button 5, but I won't give JSON"
        
        result = planner.parse_llm_output(llm_output, elements)
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "CLICK")
        self.assertEqual(result.action.targetId, 5)
        self.assertEqual(result.confidence, 0.4)

    def test_planner_history_prompt_building(self):
        planner = ActionPlanner()
        history = [
            {"action": "TYPE", "targetId": 1, "result": "OK"},
            {"action": "CLICK", "targetId": 2, "result": "OK"}
        ]
        prompt = planner.build_context_prompt(
            url="https://example.com",
            title="Form",
            interactive_elements=[{"id": 1, "role": "textbox"}, {"id": 2, "role": "button"}],
            accessibility_tree=[],
            task_description="Fill form",
            history=history
        )
        self.assertIn("RECENT ACTION HISTORY:", prompt)
        self.assertIn("Action: TYPE, TargetId: 1", prompt)


class TestAutonomousActionVocabulary(unittest.TestCase):
    """Regression tests: the planner now understands WAIT + NAVIGATE so the
    agent can act across pages and time, not just fill the current form."""

    def test_wait_action_parses_with_waitMs(self):
        planner = ActionPlanner(llm_client=MockLLMClient())
        result = planner.parse_llm_output(
            '{"type": "WAIT", "waitMs": 2500, "reasoning": "page loading"}',
            [{"id": 1, "role": "button", "label": "Submit"}],
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "WAIT")
        self.assertEqual(result.action.waitMs, 2500)
        self.assertEqual(result.confidence, 1.0)

    def test_wait_defaults_waitMs_when_missing(self):
        planner = ActionPlanner(llm_client=MockLLMClient())
        result = planner.parse_llm_output(
            '{"type": "WAIT", "reasoning": "settle"}',
            [{"id": 1, "role": "button", "label": "Submit"}],
        )
        self.assertEqual(result.action.type, "WAIT")
        self.assertEqual(result.action.waitMs, 1000)

    def test_navigate_with_url_parses(self):
        planner = ActionPlanner(llm_client=MockLLMClient())
        result = planner.parse_llm_output(
            '{"type": "NAVIGATE", "url": "https://example.com/profile"}',
            [{"id": 1, "role": "button", "label": "Submit"}],
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "NAVIGATE")
        self.assertEqual(result.action.url, "https://example.com/profile")

    def test_navigate_without_url_falls_back(self):
        planner = ActionPlanner(llm_client=MockLLMClient())
        result = planner.parse_llm_output(
            '{"type": "NAVIGATE", "reasoning": "no destination given"}',
            [{"id": 1, "role": "button", "label": "Submit", "interactive": True}],
        )
        # No url -> a navigation is a no-op, so it must degrade to a safe
        # heuristic action (which is flagged degraded), not an empty NAVIGATE.
        self.assertTrue(result.degraded)
        self.assertNotEqual(result.action.type, "NAVIGATE")

    def test_prompt_advertises_wait_and_navigate(self):
        planner = ActionPlanner(llm_client=MockLLMClient())
        prompt = planner.build_context_prompt(
            url="https://example.com",
            title="Form",
            interactive_elements=[{"id": 1, "role": "textbox"}],
            accessibility_tree=[],
            task_description="Fill and submit",
        )
        # The LLM must be told about the new primitives and that DONE is
        # goal-based, not "form filled".
        self.assertIn('"NAVIGATE"', prompt)
        self.assertIn('"WAIT"', prompt)
        self.assertIn("waitMs", prompt)
        self.assertIn("overall TASK goal", prompt)


if __name__ == "__main__":
    unittest.main()
