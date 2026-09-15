"""
Regression tests for issue #59 — "agent is blind below the fold".

Two behaviors are locked in here so they cannot silently regress:

1. The planner must NOT force SCROLL->TYPE when every visible input is
   already filled (the old post-processing override clobbered the scroll
   whenever ANY textbox existed, so the agent could never scroll to reveal
   the next form section — the exact "doesn't scroll when all placeholders
   are filled" symptom).
2. The scroll affordance (moreContentBelow + geometry) must actually reach
   the model prompt, so it can decide to scroll.
"""

import json
import unittest

from server.planner import ActionPlanner, BaseLLMClient


class _StubClient(BaseLLMClient):
    """Deterministic LLM stub: emits whatever scripted JSON we give it."""

    def __init__(self, response: str):
        self._response = response
        self.last_prompt = None

    async def generate(self, prompt: str, system_prompt: str) -> str:
        self.last_prompt = prompt
        return self._response

    @property
    def name(self) -> str:
        return "stub"

    @property
    def model_name(self) -> str:
        return "stub"


def _planner_with_response(response: str):
    client = _StubClient(response)
    planner = ActionPlanner(llm_client=client)
    return planner, client


def _run(plan_kwargs):
    import asyncio
    planner = plan_kwargs.pop("planner")
    client = plan_kwargs.pop("client")
    result = asyncio.run(planner.plan(**plan_kwargs))
    return result, client


# One visible input, already filled (appears in history with result OK).
FILLED_ELEMENT = {
    "id": 1,
    "stableId": "input|name|textbox|First_Name",
    "tag": "input",
    "type": "text",
    "role": "textbox",
    "label": "First Name",
    "interactive": True,
    "isPassword": False,
}

HISTORY = [{"targetId": 1, "result": "OK"}]

# Page has more content below the fold.
CONTEXT = {
    "url": "https://example.com/checkout",
    "title": "Checkout",
    "scrollY": 0,
    "scrollHeight": 1800,
    "viewport": {"width": 800, "height": 800},
    "moreContentBelow": True,
}


class TestScrollBlindness59(unittest.TestCase):
    def test_scroll_kept_when_visible_inputs_all_filled(self):
        """Root-cause fix: with every visible input filled, a SCROLL from the
        model is NOT overridden to TYPE. (Pre-fix it was clobbered into a
        TYPE on the filled field, so the agent could never scroll.)"""
        planner, client = _planner_with_response('{"type": "SCROLL"}')
        result, _ = _run(
            dict(
                planner=planner,
                client=client,
                url=CONTEXT["url"],
                title=CONTEXT["title"],
                interactive_elements=[FILLED_ELEMENT],
                accessibility_tree=[],
                task_description="Fill the form",
                history=HISTORY,
                context=CONTEXT,
            )
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "SCROLL",
                         "SCROLL must survive when all visible inputs are filled")

    def test_type_override_still_fires_on_unfilled_visible_input(self):
        """Guard: the override still converts SCROLL->TYPE while an UNFILLED
        input is visible (fill before scrolling)."""
        planner, client = _planner_with_response('{"type": "SCROLL"}')
        # Same element but NOT in history -> unfilled.
        unfilled = dict(FILLED_ELEMENT)
        result, _ = _run(
            dict(
                planner=planner,
                client=client,
                url=CONTEXT["url"],
                title=CONTEXT["title"],
                interactive_elements=[unfilled],
                accessibility_tree=[],
                task_description="Fill the form",
                history=[],
                context=CONTEXT,
            )
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "TYPE",
                         "Unfilled visible input should be filled before scrolling")

    def test_page_geometry_reaches_the_model_prompt(self):
        """Affordance: moreContentBelow + geometry must be in the prompt,
        so the model can decide to scroll to reveal the next fields."""
        planner, client = _planner_with_response('{"type": "DONE"}')
        _result, _client = _run(
            dict(
                planner=planner,
                client=client,
                url=CONTEXT["url"],
                title=CONTEXT["title"],
                interactive_elements=[FILLED_ELEMENT],
                accessibility_tree=[],
                task_description="Fill the form",
                history=HISTORY,
                context=CONTEXT,
            )
        )
        prompt = client.last_prompt
        self.assertIsNotNone(prompt, "planner must build a prompt")
        self.assertIn("moreContentBelow=true", prompt,
                      "scroll affordance must be visible to the model")
        self.assertIn("PAGE GEOMETRY", prompt)
        self.assertIn("1800", prompt, "scrollHeight should be present")

    def test_unfilled_inputs_helper_counts_filled_correctly(self):
        planner, _ = _planner_with_response("{}")
        filled = [
            {"id": 1, "role": "textbox", "label": "a", "isPassword": False,
             "interactive": True, "stableId": "s1"},
            {"id": 2, "role": "textbox", "label": "b", "isPassword": False,
             "interactive": True, "stableId": "s2"},
            {"id": 3, "role": "textbox", "label": "pw", "isPassword": True,
             "interactive": True},
        ]
        history = [{"targetId": 1, "result": "OK"}]
        unfilled = planner._unfilled_inputs(filled, history)
        self.assertEqual([el["id"] for el in unfilled], [2],
                         "only element 2 is unfilled; password + filled excluded")


if __name__ == "__main__":
    unittest.main()
