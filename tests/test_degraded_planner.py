"""
Regression tests for issue #68 - LLM-client init failure silently degrades
the planner to an always-DONE mock, making a broken planner look like a
successful no-op.

Fix: PlannerResult now carries `degraded` + `degraded_reason`, set on the two
degradation paths (the no-op mock fallback at init, and the heuristic
fallback after a runtime LLM error), so the popup can stop reporting a
degraded DONE as a genuine task completion.
"""

import asyncio
import unittest

from server.planner import ActionPlanner, MockLLMClient, BaseLLMClient


class _HealthyClient(BaseLLMClient):
    """A deterministic 'healthy' client that returns valid JSON - so a non-
    degraded planner path can be exercised without a live LLM."""

    async def generate(self, prompt: str, system_prompt: str) -> str:
        return '{"type": "CLICK", "targetId": 1, "reasoning": "healthy"}'

    @property
    def name(self) -> str:
        return "healthy-stub"

    @property
    def model_name(self) -> str:
        return "stub"

    async def health_check(self):
        return {"status": "healthy"}


ELS = [
    {"id": 1, "role": "button", "label": "Submit", "interactive": True},
    {"id": 2, "role": "textbox", "label": "First Name", "interactive": True, "isPassword": False},
]


class TestDegradedPlanner68(unittest.TestCase):
    def test_mock_fallback_plan_is_degraded(self):
        """plan() on the no-op mock must return degraded=True - this is the
        exact 'broken planner looks like success' case the issue describes."""
        planner = ActionPlanner(llm_client=MockLLMClient())
        self.assertTrue(planner._using_mock_fallback)

        result = asyncio.run(planner.plan(
            url="https://x", title="t",
            interactive_elements=ELS, accessibility_tree=[],
            task_description="do it", history=[], context=None,
        ))
        self.assertTrue(result.degraded, "a mock-backed result must be flagged degraded")
        self.assertTrue(result.degraded_reason)

    def test_heuristic_fallback_is_degraded(self):
        """_fallback_action (used when the live LLM errors / returns garbage)
        must be flagged degraded, even on a real client."""
        planner = ActionPlanner(llm_client=_HealthyClient())
        self.assertFalse(planner._using_mock_fallback)
        result = planner._fallback_action(ELS, "LLM execution error: boom")
        self.assertTrue(result.degraded, "a heuristic fallback is not LLM output")
        self.assertIn("boom", result.degraded_reason or "")
        self.assertTrue(result.success)  # success unchanged; only degraded is added

    def test_healthy_llm_result_is_not_degraded(self):
        """A real LLM response that parses cleanly must NOT be flagged
        degraded - otherwise the UI would warn on every normal run."""
        planner = ActionPlanner(llm_client=_HealthyClient())
        result = asyncio.run(planner.plan(
            url="https://x", title="t",
            interactive_elements=ELS, accessibility_tree=[],
            task_description="do it", history=[], context=None,
        ))
        self.assertFalse(result.degraded, "a healthy LLM result must not be degraded")
        self.assertEqual(result.action.type, "CLICK")

    def test_degraded_defaults_false_on_plain_result(self):
        # Backward compatibility: any PlannerResult built without the new args
        # (as the endpoint tests do) must default to degraded=False.
        from server.planner import PlannerResult
        r = PlannerResult(success=True, action=None, confidence=0.5, reasoning="")
        self.assertFalse(r.degraded)
        self.assertIsNone(r.degraded_reason)


if __name__ == "__main__":
    unittest.main()
