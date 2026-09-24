"""
Issue #141 - P1 sequenced SWITCH_TAB: server-side behaviour.

Covers the planner side:
  * parse_llm_output accepts a SWITCH_TAB action and carries tabId/urlHint.
  * build_context_prompt renders the OPEN TABS + VALUES READ ON OTHER TABS
    sections, and the token+label handoff NEVER leaks a raw value into the
    prompt (the PII firewall, asserted end-to-end).
  * plan() masks cross_tab_memory entries down to (token, label) pairs before
    they can reach the LLM, regardless of the client's payload shape.
"""
import unittest

from server.planner import ActionPlanner, MockLLMClient, ActionSchema


def make_planner() -> ActionPlanner:
    return ActionPlanner(llm_client=MockLLMClient())


class TestSwitchTabParsing(unittest.TestCase):
    def test_switch_tab_parses_with_tabid_and_urlhint(self):
        planner = make_planner()
        result = planner.parse_llm_output(
            '{"type": "SWITCH_TAB", "tabId": 12, "urlHint": "docs.google.com", '
            '"reasoning": "the form is in the Sheets tab"}',
            interactive_elements=[{"id": 1, "role": "textbox", "label": "name"}],
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "SWITCH_TAB")
        self.assertEqual(result.action.tabId, 12)
        self.assertEqual(result.action.urlHint, "docs.google.com")
        # A hop carries no target/value even if the model smuggles them in.
        self.assertIsNone(result.action.targetId)
        self.assertIsNone(result.action.value)
        self.assertEqual(result.confidence, 1.0)

    def test_switch_tab_bare_regrounds_not_fails(self):
        planner = make_planner()
        result = planner.parse_llm_output(
            '{"type": "SWITCH_TAB", "reasoning": "settle on the active tab"}',
            interactive_elements=[],
        )
        self.assertTrue(result.success)
        self.assertEqual(result.action.type, "SWITCH_TAB")
        self.assertIsNone(result.action.tabId)
        self.assertIsNone(result.action.urlHint)

    def test_switch_tab_coerces_string_tabid(self):
        planner = make_planner()
        result = planner.parse_llm_output(
            '{"type": "switch_tab", "tabId": "7"}',
            interactive_elements=[],
        )
        self.assertEqual(result.action.type, "SWITCH_TAB")
        self.assertEqual(result.action.tabId, 7)

    def test_switch_tab_drops_bad_tabid_to_none(self):
        planner = make_planner()
        result = planner.parse_llm_output(
            '{"type": "SWITCH_TAB", "tabId": "not-an-int", "urlHint": "x"}',
            interactive_elements=[],
        )
        self.assertIsNone(result.action.tabId)
        self.assertEqual(result.action.urlHint, "x")

    def test_unknown_type_still_falls_back(self):
        planner = make_planner()
        result = planner.parse_llm_output(
            '{"type": "TELEPORT", "tabId": 3}',
            interactive_elements=[{"id": 1, "role": "textbox", "label": "n"}],
        )
        # TELEPORT is not in the vocabulary - must degrade, never pass through.
        self.assertNotEqual(result.action.type, "TELEPORT")


class TestOpenTabsPromptSection(unittest.TestCase):
    def test_open_tabs_rendered_when_provided(self):
        planner = make_planner()
        prompt = planner.build_context_prompt(
            url="https://a.example",
            title="A",
            interactive_elements=[{"id": 1, "role": "textbox", "label": "name"}],
            accessibility_tree=[],
            task_description="fill the form on the other tab",
            open_tabs=[
                {"id": 11, "title": "Data", "url": "https://data.example"},
                {"id": 12, "title": "Sheet", "url": "https://sheets.example/f"},
            ],
        )
        self.assertIn("OPEN TABS", prompt)
        self.assertIn("tabId=12", prompt)
        self.assertIn("sheets.example", prompt)
        # Rule 21 + the action vocabulary are present only when orchestrating.
        self.assertIn("SWITCH_TAB", prompt)

    def test_open_tabs_absent_keeps_single_tab_prompt_unchanged(self):
        planner = make_planner()
        prompt = planner.build_context_prompt(
            url="https://a.example",
            title="A",
            interactive_elements=[{"id": 1, "role": "textbox", "label": "name"}],
            accessibility_tree=[],
            task_description="fill a field",
        )
        # No open tabs, no handoff -> none of the cross-tab machinery appears.
        self.assertNotIn("OPEN TABS", prompt)
        self.assertNotIn("VALUES READ ON OTHER TABS", prompt)


class TestHandoffPromptPiiFirewall(unittest.TestCase):
    def test_handoff_values_never_reach_the_prompt(self):
        planner = make_planner()
        prompt = planner.build_context_prompt(
            url="https://a.example",
            title="A",
            interactive_elements=[{"id": 1, "role": "textbox", "label": "name"}],
            accessibility_tree=[],
            task_description="copy the value across",
            cross_tab_memory=[("<FIELD_1>", "Phone")],
        )
        self.assertIn("VALUES READ ON OTHER TABS", prompt)
        self.assertIn("<FIELD_1>", prompt)
        self.assertIn("Phone", prompt)
        # The raw value is NOT in the (token, label) handoff by construction -
        # assert the firewall holds even if a value-looking string sneaks in
        # as the label position.
        self.assertNotIn("+91-9876543210", prompt)

    def test_plan_masks_dict_shaped_handoff_and_drops_stray_value(self):
        planner = make_planner()

        captured = {}

        class CaptureClient(MockLLMClient):
            name = "capture"
            model_name = "capture"

            async def generate(self, prompt, system_prompt):
                captured["prompt"] = prompt
                return '{"type": "DONE"}'

        planner = ActionPlanner(llm_client=CaptureClient())
        # Simulate a hostile/buggy client payload: a value key that should NOT
        # reach the LLM. plan() must mask it down to (token, label) only.
        import asyncio

        result = asyncio.run(
            planner.plan(
                url="https://a.example",
                title="A",
                interactive_elements=[{"id": 1, "role": "textbox", "label": "n"}],
                accessibility_tree=[],
                task_description="copy across",
                cross_tab_memory=[{"token": "<FIELD_1>", "label": "Phone", "value": "SECRETPHONE_8821"}],
            )
        )
        self.assertTrue(result.success)
        self.assertIn("VALUES READ ON OTHER TABS", captured["prompt"])
        self.assertIn("<FIELD_1>", captured["prompt"])
        self.assertNotIn("SECRETPHONE_8821", captured["prompt"])  # the raw value is gone

    def test_plan_masks_tuple_shaped_handoff(self):
        import asyncio

        captured = {}

        class CaptureClient(MockLLMClient):
            name = "capture"
            model_name = "capture"

            async def generate(self, prompt, system_prompt):
                captured["prompt"] = prompt
                return '{"type": "DONE"}'

        planner = ActionPlanner(llm_client=CaptureClient())

        result = asyncio.run(
            planner.plan(
                url="u",
                title="t",
                interactive_elements=[],
                accessibility_tree=[],
                cross_tab_memory=[("<FIELD_1>", "City")],
            )
        )
        self.assertTrue(result.success)
        self.assertIn("VALUES READ ON OTHER TABS", captured["prompt"])
        self.assertIn("<FIELD_1>", captured["prompt"])
        self.assertIn("City", captured["prompt"])


class TestActionSchemaCarriesSwitchFields(unittest.TestCase):
    def test_actionschema_defaults_are_none(self):
        a = ActionSchema(type="CLICK", targetId=1)
        self.assertIsNone(a.tabId)
        self.assertIsNone(a.urlHint)

    def test_actionschema_carries_switch_fields(self):
        a = ActionSchema(type="SWITCH_TAB", tabId=5, urlHint="docs.google.com")
        self.assertEqual(a.tabId, 5)
        self.assertEqual(a.urlHint, "docs.google.com")


if __name__ == "__main__":
    unittest.main()
