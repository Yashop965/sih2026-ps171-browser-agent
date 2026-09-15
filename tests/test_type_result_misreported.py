"""
Regression tests for issue #63 — failed TYPEs/CLICKS were reported to the
planner as result:'OK', so a field the agent failed to fill was sent as
"already filled" and could never be retried (planner prompt rule 3 skips
filled elements).

Fix: the popup tracks failedIds separately and emits result:'FAILED' + error.
The planner must therefore treat a FAILED element as UNFILLED (retryable) and
surface the failure reason in the prompt so the model re-plans instead of
skipping. These tests pin that planner contract on build_context_prompt.
"""

import unittest

from server.planner import ActionPlanner, MockLLMClient


def _planner() -> ActionPlanner:
    # A concrete (mock) client so construction is deterministic and touches no
    # network. build_context_prompt itself is pure, but this keeps the test
    # hermetic regardless of .env provider config.
    return ActionPlanner(llm_client=MockLLMClient())


# One visible input, targetId 7.
EL = [
    {
        "id": 7,
        "stableId": "input|name|textbox|First_Name",
        "tag": "input",
        "type": "text",
        "role": "textbox",
        "label": "First Name",
        "interactive": True,
        "isPassword": False,
    },
]


class TestTypeResultMisreported63(unittest.TestCase):
    def test_failed_history_element_is_retryable_and_reason_surfaced(self):
        p = _planner()
        history = [
            {"action": "TYPE", "targetId": 7, "result": "FAILED", "error": "maxlength exceeded"}
        ]
        prompt = p.build_context_prompt(
            url="https://x",
            title="t",
            interactive_elements=EL,
            accessibility_tree=[],
            task_description="fill it",
            history=history,
            context=None,
        )

        # The element is NOT filled (result != OK), so it must be present in the
        # AVAILABLE section the model plans against.
        available = prompt.split("AVAILABLE INTERACTIVE ELEMENTS (NOT yet filled):", 1)[1].split("ALL ELEMENTS", 1)[0]
        self.assertIn('"targetId": 7', available,
                      "a FAILED element must remain available for retry")

        # The failure + its reason must be surfaced so the model re-plans.
        self.assertIn("FAILED", prompt)
        self.assertIn("maxlength exceeded", prompt)

    def test_ok_history_element_is_excluded_from_available(self):
        p = _planner()
        history = [{"action": "TYPE", "targetId": 7, "result": "OK"}]
        prompt = p.build_context_prompt(
            url="https://x",
            title="t",
            interactive_elements=EL,
            accessibility_tree=[],
            task_description="fill it",
            history=history,
            context=None,
        )

        # Filled -> must NOT be in the available section (only in the ALL
        # reference list). This is the pre-existing contract we must not break.
        available = prompt.split("AVAILABLE INTERACTIVE ELEMENTS (NOT yet filled):", 1)[1].split("ALL ELEMENTS", 1)[0]
        self.assertNotIn('"targetId": 7', available,
                         "an OK-filled element must not be re-planned")

    def test_unfilled_inputs_helper_ignores_failed_status(self):
        # _unfilled_inputs decides the SCROLL->TYPE override. A FAILED field is
        # still unfilled, so it must be returned (eligible to fill).
        p = _planner()
        history = [{"action": "TYPE", "targetId": 7, "result": "FAILED", "error": "x"}]
        unfilled = p._unfilled_inputs(EL, history)
        self.assertEqual([el["id"] for el in unfilled], [7],
                         "a FAILED field is unfilled and eligible for the fill-before-scroll override")


if __name__ == "__main__":
    unittest.main()
