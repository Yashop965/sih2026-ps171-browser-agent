"""
Action Planner Module (server/planner.py)

Responsible for:
1. Building LLM prompt context from sanitized page elements and task history.
2. Interfacing with LLM models via flexible client system (Custom API + Ollama fallback).
3. Parsing, validating, and scoring actions against the browser action protocol:
   Action Types: CLICK, TYPE, SCROLL, SELECT, NAVIGATE, DONE
   Parameters: targetId, value, scrollDirection, scrollAmount, url
4. Ensuring output compatibility with src/lib/actions.ts.
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any, Tuple
from pydantic import BaseModel, Field
import json
import re
import logging

from server.llm_clients import create_llm_client, BaseLLMClient

logger = logging.getLogger("sih_agent_planner")


# ===== Protocol Schema (Matches src/lib/actions.ts) =====

class ActionSchema(BaseModel):
    type: str  # CLICK, TYPE, SCROLL, SELECT, NAVIGATE, WAIT, KEY, DONE, SWITCH_TAB
    targetId: Optional[int] = None
    value: Optional[str] = None
    scrollDirection: Optional[str] = None  # up, down, left, right
    scrollAmount: Optional[int] = None
    url: Optional[str] = None
    # WAIT: how long to let the page settle before re-planning (ms). Autonomy
    # primitive - lets the agent operate on pages that change over time.
    waitMs: Optional[int] = None
    # KEY: which key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown",
    # or a single printable character). Issue #84: lets the agent submit a
    # filled search box instead of being stuck after TYPE-ing into it.
    key: Optional[str] = None
    # SWITCH_TAB (#141): hop to another OPEN tab. tabId is exact; urlHint is
    # fuzzy (matched against the open tabs' URLs + titles). Both absent = a
    # harmless re-ground on the current tab. Carries no PII by construction.
    tabId: Optional[int] = None
    urlHint: Optional[str] = None


class ChecklistItem(BaseModel):
    """One step of the planner-authored task checklist (issue: cross-page
    memory). A stable, ordered list of sub-goals the planner decomposes the
    task into; it flips ``done`` on items as they are achieved so the runner
    can track progress across pages and only treat the task as complete when
    the whole list is satisfied - instead of trusting a bare "DONE"."""

    id: str
    description: str = ""
    done: bool = False


class PlannerResult(BaseModel):
    success: bool
    action: Optional[ActionSchema] = None
    confidence: float = 0.0
    reasoning: str = ""
    error: Optional[str] = None
    # Cross-page task checklist the planner authored + maintains (issue:
    # statelessness). May be empty - the runner treats completion as a
    # "genuine DONE" when the list is empty or absent.
    checklist: List[ChecklistItem] = []
    # Issue #68: True when this result was produced by a degraded path -
    # the mock fallback (no LLM reachable at init) or a heuristic fallback
    # (an unreachable / LLM errored at runtime). Callers MUST NOT treat a
    # DONE emitted while degraded as a real task completion.
    degraded: bool = False
    degraded_reason: Optional[str] = None


# ===== LLM Client Interface Boundary =====

class BaseLLMClient(ABC):
    """
    Abstract interface boundary for LLM interaction.
    Ollama integration (Issue #2) or cloud LLM clients implement this interface.
    """
    @abstractmethod
    async def generate(self, prompt: str, system_prompt: str) -> str:
        pass


class MockLLMClient(BaseLLMClient):
    """
    Fallback mock LLM client used when no live LLM client is injected.
    """
    async def generate(self, prompt: str, system_prompt: str) -> str:
        return '{"type": "DONE", "reasoning": "Mock fallback planner execution"}'


# ===== Action Planner Engine =====

class ActionPlanner:
    def __init__(
        self,
        llm_client: Optional[BaseLLMClient] = None,
        provider: str = "auto",
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ):
        # Use provided client or create from config
        if llm_client:
            self.llm_client = llm_client
        else:
            try:
                self.llm_client = create_llm_client(
                    provider=provider,
                    api_url=api_url,
                    api_key=api_key,
                    model=model,
                )
            except Exception as e:
                logger.warning(f"Failed to create LLM client: {e}, using mock")
                self.llm_client = MockLLMClient()

        # Issue #68: record whether the planner is running on the no-op mock
        # (used when no LLM was configured or the client factory raised). A
        # DONE emitted by the mock is NOT a real task completion and must be
        # surfaced as degraded to the caller.
        self._using_mock_fallback = isinstance(self.llm_client, MockLLMClient)

    def build_context_prompt(
        self,
        url: str,
        title: str,
        interactive_elements: List[Dict[str, Any]],
        accessibility_tree: List[Dict[str, Any]],
        task_description: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
        context: Optional[Dict[str, Any]] = None,
        checklist: Optional[List[Dict[str, Any]]] = None,
        loop_warning: Optional[str] = None,
        open_tabs: Optional[List[Dict[str, Any]]] = None,
        cross_tab_memory: Optional[List[Tuple[str, str]]] = None,
    ) -> str:
        """
        Builds a structured prompt for the LLM based on sanitized page metadata.

        ``checklist`` is the runner's cross-page task memory (an ordered list of
        sub-goals with a ``done`` flag). It is echoed into the prompt so the LLM
        remembers what it already finished and does not re-do completed steps.

        ``loop_warning`` (NPTEL "post-verify" signal) is a PII-safe alert from
        the runner that the model is re-issuing the same no-op action with no
        page change. Rendered as a prominent block so the model breaks the loop
        (e.g. submit a filled search box instead of re-typing it).
        """
        # Parse task description into key-value pairs (shared with the
        # conservative fallback in _fallback_action - issue #85).
        task_kv = self._task_kv(task_description)

        # Filter and preview elements safely (ensuring zero password leaks)
        sanitized_elements = []
        for el in interactive_elements[:30]:
            element_id = el.get("id")
            # Use stableId if available for persistent tracking
            element_stable_id = el.get("stableId", str(element_id))
            role = el.get("role", el.get("tag", "element"))
            tag = el.get("tag", "input")  # Get HTML tag
            label = str(el.get("label", "")).lower()[:50]
            is_password = el.get("isPassword", False)
            el_type = el.get("type", "")  # Get input type (text, select-one, etc.)

            if is_password:
                label = "[redacted password field]"

            # Check if this element was already filled in history
            # Try both numeric ID and stableId for compatibility
            already_filled = False
            if history:
                for step in history:
                    step_target = step.get("targetId")
                    # Check if it matches either numeric ID or stableId
                    if (str(step_target) == str(element_id) or step_target == element_stable_id) and step.get("result") == "OK":
                        already_filled = True
                        break

            sanitized_elements.append({
                "targetId": element_id,
                "stableId": element_stable_id,
                "tag": tag,  # HTML tag: input, select, button, a, etc.
                "type": el_type,  # Input type: text, email, select-one, checkbox, etc.
                "role": role,
                "label": label,
                "interactive": el.get("interactive", True),
                "filled": already_filled,
            })

        history_summary = []
        if history:
            for step in history[-5:]:
                result = step.get('result', 'OK')
                line = (
                    f"- Action: {step.get('action')}, "
                    f"TargetId: {step.get('targetId')}, Result: {result}"
                )
                # Surface the failure reason so the model can re-plan (#63).
                if result == "FAILED":
                    err = step.get("error")
                    line += f" (reason: {err})" if err else " (reason: unknown)"
                history_summary.append(line)

        history_str = "\n".join(history_summary) if history_summary else "None"
        task_str = task_description or "Interact with the page to assist the user."

        # Build key-value map for the LLM
        kv_str = json.dumps(task_kv, indent=2) if task_kv else "None"

        # Cross-page task checklist (the "what's already done / what's left"
        # memory). The runner feeds its own checklist back here; the LLM
        # echoes it forward with updated ``done`` flags and new items when it
        # realizes it has finished a sub-goal.
        checklist_str = "None"
        if checklist:
            lines = []
            for item in checklist[-12:]:
                mark = "x" if item.get("done") else " "
                desc = str(item.get("description") or item.get("id") or "").strip()
                lines.append(f"- [{mark}] {desc} (id: {item.get('id')})")
            checklist_str = "\n".join(lines) if lines else "None"

        # Filter out already-filled elements for cleaner context
        available_elements = [el for el in sanitized_elements if not el.get("filled", False)]

        # Page geometry + scroll affordance (issue #59). The model can only
        # scroll if it is told the form continues below the fold; without this
        # it fills the first screen and stops.
        context_str = "None"
        if context:
            more_below = "true" if context.get("moreContentBelow") else "false"
            # #120: the element table is capped on-device; omitted counts the
            # controls that exist on this page but were NOT sent (0 = complete).
            omitted = int(context.get("omitted") or 0)
            context_str = (
                f"scrollY={context.get('scrollY', 0)}, "
                f"scrollHeight={context.get('scrollHeight', 0)}, "
                f"viewport={json.dumps(context.get('viewport', {}))}, "
                f"moreContentBelow={more_below}, "
                f"omittedElements={omitted}"
            )

        # Cross-tab orchestrator sections (#141). Only rendered when the
        # extension actually provides them - a single-tab task pays nothing.
        # The open-tab list carries URL + title + id only (no content, no PII);
        # a SWITCH_TAB action references one of those ids. The handoff carries
        # TOKEN + LABEL only - the live value never reaches the planner, so the
        # model can reference a harvested value but can never see or retype it.
        open_tabs_block = ""
        if open_tabs:
            lines = [
                "OPEN TABS (the user has these tabs open in this window; "
                "use SWITCH_TAB to move the task to one of them):"
            ]
            for t in open_tabs:
                # The client (OpenTabInfo in src/lib/tabHandoff.ts) sends the
                # key as "tabId"; older/test payloads may use "id". Render the
                # exact id the model must reference in a SWITCH_TAB action -
                # without it the flow silently degrades to urlHint-only.
                tab_id = t.get("tabId", t.get("id"))
                lines.append(
                    f"- tabId={tab_id}  \"{t.get('title', '')}\"  {t.get('url', '')}"
                )
            open_tabs_block = "\n".join(lines) + "\n"

        handoff_block = ""
        if cross_tab_memory:
            lines = [
                "VALUES READ ON OTHER TABS (handoff - reference by TOKEN; "
                "the raw value never crosses to the planner, so to use one, "
                "set it as a TYPE/SELECT value):"
            ]
            for token, label in cross_tab_memory:
                lines.append(f"- {token} — {label or '(field)'}")
            handoff_block = "\n".join(lines) + "\n"

        switch_tab_instruction = (
            "21. SWITCH_TAB: when the task needs a value or action on a DIFFERENT "
            "open tab (listed under OPEN TABS), issue "
            '{"type": "SWITCH_TAB", "tabId": <id from OPEN TABS>} '
            "(or add \"urlHint\": \"<part of that tab's URL/title>\" if unsure). "
            "The agent hops there and re-observes. To use a value already read on "
            "another tab, set it as the value BY ITS TOKEN from VALUES READ ON OTHER "
            "TABS, e.g. {\"type\": \"TYPE\", \"targetId\": 4, \"value\": \"<FIELD_1>\"} - "
            "never retype the raw value. Do not repeat a SWITCH_TAB within two steps."
        ) if open_tabs else ""

        switch_tab_example = (
            '- To move to the tab whose urlHint matches: {{"type": "SWITCH_TAB", "tabId": 7, "urlHint": "docs.google.com", "reasoning": "the form is in the Google Sheets tab"}}\n'
            '- To type a harvested value by token: {{"type": "TYPE", "targetId": 4, "value": "<FIELD_1>", "reasoning": "fill name with the value read on the other tab"}}\n'
        ) if cross_tab_memory else ""

        prompt = f"""URL: {url}
PAGE TITLE: {title}
PAGE GEOMETRY: {context_str}
{open_tabs_block}
{handoff_block}

TASK: {task_str}

KEY-VALUE PAIRS FROM TASK:
{kv_str}

RECENT ACTION HISTORY (results so far — OK = filled, FAILED = not yet done, retryable):
{history_str}

TASK CHECKLIST (your running "what's done / what's left" memory across pages — DO NOT re-do completed items):
{checklist_str}

{"LOOP WARNING: " + loop_warning if loop_warning else ""}

AVAILABLE INTERACTIVE ELEMENTS (NOT yet filled):
{json.dumps(available_elements, indent=2)}

ALL ELEMENTS (for reference - do NOT use filled ones):
{json.dumps(sanitized_elements, indent=2)}

CRITICAL INSTRUCTIONS:
You are completing the TASK as a GOAL, not just filling the form on the current page.
The task may span multiple pages. The current page is the URL shown at the top.
Use your full action vocabulary to act on whatever page you land on:
1. Match KEY names from the task to LABEL names on elements
2. TYPE the matching VALUE into elements that are NOT already filled
3. SKIP elements marked as "filled": true - they are already done
4. When all inputs on the CURRENT page are filled, CLICK the SUBMIT / continue button (or the next-step button if the task continues on another page)
5. USE SCROLL when moreContentBelow is true AND there are no UNFILLED fields visible in the current viewport - this reveals the next fields below the fold. Scroll down, then re-plan against the newly-revealed elements.
6. USE WAIT when the page is still loading, a spinner/skeleton is present, or expected content has not appeared yet. Pause 1-3 seconds, then re-plan. A short WAIT is safer than acting on a half-rendered page.
7. USE NAVIGATE to go to a specific URL when the task names a destination different from the current page. After navigating, re-plan against the new page.
8. CLICK links / buttons that move the task forward (e.g. "Next", "Continue", "Go to profile", a result link) when that is what the task requires.
9. USE KEY to press a key after filling a search box or text field that submits on keyboard. For search boxes (Wikipedia, Google, or any field with an autocomplete/suggest dropdown), TYPE the query FIRST, then issue KEY "Enter" to submit. Pressing Enter is what a real user does - a CLICK on a non-existent submit button will not work. You may also press "ArrowDown" to move into an autocomplete suggestion then "Enter", or "Tab" to advance focus. Set key to the key name (e.g. "Enter"). Optionally set targetId to the field you just filled; if omitted the key lands on the focused element.
10. ALWAYS check the "tag" and "type" fields before choosing action
11. Only choose from the AVAILABLE ELEMENTS list above - do NOT use filled ones
12. Do NOT signal DONE while moreContentBelow is true and there are still unfilled fields - scroll to reveal them first
13. A history entry with Result: FAILED means that action was attempted but did NOT succeed - the element is NOT filled. Retry it: re-issue the same or a revised action for that targetId. Do NOT skip a FAILED field.
14. Signal DONE ONLY when the overall TASK goal is achieved (the required fields are filled/submitted, or the requested page state is reached) - NOT merely because the current form is complete. If the task requires a different page or a further step, keep going.
15. COMPLETION CHECK (do this BEFORE scrolling): if the task is a "look up / open / go to X" style goal and the current PAGE TITLE or URL already contains X (or the page clearly shows the target), the goal is REACHED - signal DONE. Do NOT keep scrolling a content/article page that already displays the target; SCROLL is only for revealing UNFILLED form fields or the next control, never to "hunt" for a target the page title/URL already confirms is present.
16. MAINTAIN THE TASK CHECKLIST. On your FIRST step, decompose the task into a small ordered checklist of sub-goals (e.g. for "search Web browser, then search PWA, land on the PWA article": [search Web browser, open the Web browser article, search PWA, open the PWA article]). Every step afterwards, echo the FULL checklist back in the output's "checklist" field, flipping an item to "done": true ONLY when you have genuinely reached it on the live page (confirmed by the URL/title/elements, not by assumption). NEVER mark an item done just because you typed/pressed a key - only when the resulting page state proves it. An item already "[x]" is COMPLETE - do not act on it again. Only signal DONE when every checklist item is done (or the list is empty and the goal is otherwise met).
17. CAP TABLE AWARENESS: the element table above is capped for context size. PAGE GEOMETRY reports omittedElements = how many more interactive controls exist on this page but were NOT sent to you (0 = complete). If omittedElements > 0 and the field/control you need is not in the list, DO NOT guess an id and DO NOT signal DONE on a capped table: issue SCROLL down (or re-plan) so the next extraction reveals the remaining controls, and re-check. A "not found in the table" on a capped page is "not visible yet", not "does not exist".
18. COLLAPSED SEARCH BOX: if the task needs a search box but there is NO visible text input (the extractor reports 0 inputs), the site likely keeps its search field collapsed behind a visible "Search" toggle/link/button. Do NOT WAIT or SCROLL looking for a box - instead CLICK the visible element whose label is "Search" (or contains "search") to expand it, then TYPE the query and press Enter. On Wikipedia specifically, article pages collapse the header search to a small "Search" link; clicking it reveals the input. A page title/URL already containing the target does NOT need a search - apply rule 15 instead.
19. EMPTY-LOOKING PAGE AFTER NAVIGATION: if the element table has 0-2 elements and the previous step was a NAVIGATE or CLICK that changed the page, the page is likely still rendering. Issue WAIT (~1000ms) instead of DONE or re-typing the last query, then re-check. The runner re-extracts automatically - it will recover the elements on the next step.
20. SUBMIT A FILLED SEARCH / FORM, THEN VERIFY THE PAGE CHANGED: if your last action was TYPE into a search box or form field and you have NOT yet submitted it, your NEXT action MUST be the submit - press KEY "Enter" (or CLICK the form's Search/Go button), do NOT re-type the same value. Typing fills the field but does NOT advance the task. A search/submit is proven COMPLETE only by a DISTINCTIVE page-state change - the URL/title moving to the target article or a results page (e.g. "…/wiki/World_Wide_Web"), not by "I pressed Enter." If the history shows the same target re-typed with the page still on the same URL, STOP re-typing and issue the submit control a different way (press Enter on the focused field, or click the visible submit button). Repeated no-op fills on one element mean the SUBMIT is what's missing, not the fill.
{switch_tab_instruction}

ELEMENT TYPE RULES (MOST IMPORTANT - FOLLOW EXACTLY):
- If tag == "input" AND type in ["text", "email", "password", "number"]: → TYPE the value
- If tag == "textarea": → TYPE the value
- If tag == "select" OR type == "select-one": → SELECT the value (NEVER TYPE into select!)
- If tag == "button" OR role == "button" OR tag == "a" OR role == "link": → CLICK
- If type == "checkbox" OR type == "radio": → CLICK to toggle
- NEVER TYPE into a <select>, <button>, <a>, or <span>

ACTION EXAMPLES:
- For text input: {{"type": "TYPE", "targetId": 1, "value": "John", "reasoning": "filling first name"}}
- For dropdown: {{"type": "SELECT", "targetId": 9, "value": "Option A", "reasoning": "selecting from dropdown"}}
- For button: {{"type": "CLICK", "targetId": 4, "reasoning": "clicking submit button"}}
- To submit a filled search box (press Enter): {{"type": "KEY", "key": "Enter", "reasoning": "submitting the search I just typed"}}
- To move into an autocomplete suggestion then submit: {{"type": "KEY", "key": "ArrowDown", "reasoning": "select the highlighted suggestion"}}
- To go to another page: {{"type": "NAVIGATE", "url": "https://site.example/profile", "reasoning": "task continues on the profile page"}}
- To let content load: {{"type": "WAIT", "waitMs": 2000, "reasoning": "page still loading, settle before next step"}}
{switch_tab_example}

YOUR NEXT ACTION MUST BE THE ONE THAT ADVANCES THE TASK:
- TYPE into an UNFILLED text input field using the matching value from the task
- SELECT from an unfilled dropdown (if any exist)
- CLICK a link / button / SUBMIT that moves the task forward
- KEY "Enter" to submit a search box you just filled (prefer this over hunting for a submit button)
- NAVIGATE to the target URL when the task requires a different page
- WAIT when the page has not finished loading
- DONE only when the TASK goal is met OR no further useful action exists

SYSTEMATIC APPROACH (for form-like pages):
1. Fill all text input fields first (one per step)
2. Then fill all dropdown/select fields
3. Then click any checkboxes/radios if needed
4. Finally click SUBMIT / continue, or NAVIGATE / CLICK to the next step
5. Do NOT skip any unfilled fields

MATCHING RULES:
- "first name" → type the value for "First Name" key
- "last name" → type the value for "Last Name" key  
- "email" → type the value for "Email" key
- "phone" → type the value for "Phone" key
- Match keywords loosely: "name" matches "Full Name", "First Name", etc.
- For dropdowns: use sensible values like "Option 1", "Male", "Female", etc.
- For passwords: use "password123" or "Test@123"
- For emails: use "test@example.com"
- For phones: use "9876543210"

IMPORTANT: The TASK is the source of truth. Complete the task end-to-end across pages as needed; do not stop just because one form is filled if the task has more steps. Signal DONE only when the task is genuinely complete.

RETURN ONLY this JSON (no markdown, no explanation):
{{"type": "TYPE", "targetId": <input_id>, "value": "<matching_value>", "reasoning": "filling the field", "checklist": [{{"id": "1", "description": "search Web browser", "done": true}}, {{"id": "2", "description": "open the PWA article", "done": false}}]}}

ALWAYS include the "checklist" array in your output (rule 16). It is your cross-page memory: keep it stable, only flip items to done when the live page proves it, and only signal "type":"DONE" once every checklist item is done. If you have no checklist yet, start it on this step.
"""
        return prompt

    def parse_llm_output(self, llm_response: str, interactive_elements: List[Dict[str, Any]]) -> PlannerResult:
        """
        Extracts, validates, and calculates confidence for an action from LLM text output.
        """
        raw_json = self._extract_json_substring(llm_response)
        if not raw_json:
            logger.warning(f"Failed to extract JSON from LLM output: {llm_response[:100]}")
            return self._fallback_action(interactive_elements, "Failed to parse LLM response JSON")

        try:
            data = json.loads(raw_json)
        except Exception as e:
            logger.warning(f"JSON decode error: {e}")
            return self._fallback_action(interactive_elements, f"Malformed JSON: {e}")

        # Normalize action type
        raw_type = str(data.get("type", "")).upper().strip()
        valid_types = {"CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "WAIT", "KEY", "DONE", "SWITCH_TAB"}
        
        if raw_type not in valid_types:
            logger.warning(f"Invalid action type: {raw_type}")
            return self._fallback_action(interactive_elements, f"Invalid action type '{raw_type}'")

        target_id = data.get("targetId")
        if target_id is not None:
            # The model sometimes returns targetId as a string - either a
            # numeric id ("3") or, per the prompt's "numeric ID or stableId"
            # contract, a stableId ("searchInput"). int("searchInput") used to
            # throw and drop the target entirely (target-less actions -> the
            # agent drifting into WAIT loops). Resolve strings explicitly:
            # numeric strings -> int, stableIds -> the element's numeric id.
            if isinstance(target_id, str):
                s = target_id.strip()
                if s.isdigit():
                    target_id = int(s)
                else:
                    stable_to_id = {
                        str(el.get("stableId")): el.get("id")
                        for el in interactive_elements
                        if el.get("stableId")
                    }
                    target_id = stable_to_id.get(s)
                    if target_id is None:
                        logger.warning(
                            f"targetId '{s}' is not a numeric id nor a known "
                            f"stableId; dropping the target"
                        )
            else:
                try:
                    target_id = int(target_id)
                except (ValueError, TypeError):
                    target_id = None

        value = data.get("value")
        if value is not None:
            value = str(value)

        scroll_direction = data.get("scrollDirection")
        if scroll_direction and str(scroll_direction).lower() in {"up", "down", "left", "right"}:
            scroll_direction = str(scroll_direction).lower()
        else:
            scroll_direction = "down" if raw_type == "SCROLL" else None

        scroll_amount = data.get("scrollAmount")
        if scroll_amount is not None:
            try:
                scroll_amount = int(scroll_amount)
            except (ValueError, TypeError):
                scroll_amount = 400

        url = data.get("url")

        # KEY: which key to press. Normalize the name to a known key so the
        # executor's KEY_MAP can look it up; single printable characters pass
        # through as-is (the executor synthesizes their code/keyCode). Issue
        # #84: this is what lets the planner submit a filled search box.
        key_name = data.get("key")
        if key_name is not None:
            key_name = str(key_name).strip()
            if key_name.upper() in {
                "ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE", "SPACE",
                "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT",
                "HOME", "END",
            }:
                key_name = {
                    "ENTER": "Enter", "TAB": "Tab", "ESCAPE": "Escape",
                    "BACKSPACE": "Backspace", "DELETE": "Delete", "SPACE": "Space",
                    "ARROWUP": "ArrowUp", "ARROWDOWN": "ArrowDown",
                    "ARROWLEFT": "ArrowLeft", "ARROWRIGHT": "ArrowRight",
                    "HOME": "Home", "END": "End",
                }[key_name.upper()]
            # else: leave as the raw (possibly single-char) value the model sent.

        # WAIT duration. Accept the canonical key plus the aliases an LLM might
        # reach for, and default to a sensible 1s when a WAIT is issued with no
        # duration so the primitive still settles the page.
        wait_ms = None
        for key in ("waitMs", "wait_ms", "durationMs", "duration", "ms"):
            candidate = data.get(key)
            if candidate is not None:
                try:
                    wait_ms = int(float(candidate))
                    break
                except (ValueError, TypeError):
                    continue
        if raw_type == "WAIT" and wait_ms is None:
            wait_ms = 1000
        # Clamp so a runaway model value can't wedge the run.
        if wait_ms is not None:
            wait_ms = max(0, min(wait_ms, 30_000))

        # Validate target element existence if targetId is required
        valid_element_ids = {
            el.get("id") for el in interactive_elements if el.get("id") is not None
        }

        confidence = 0.85
        reasoning = str(data.get("reasoning", f"Executing {raw_type} action"))

        if raw_type in {"CLICK", "TYPE", "SELECT"}:
            if target_id is None or target_id not in valid_element_ids:
                logger.warning(f"Target ID {target_id} not found in page element registry")
                return self._fallback_action(
                    interactive_elements,
                    f"Target element #{target_id} not found on page"
                )

            # Check if target element is a blacklisted password field
            for el in interactive_elements:
                if el.get("id") == target_id and el.get("isPassword"):
                    logger.warning(f"Attempted action on password field #{target_id}")
                    # Reduce confidence and ensure value is cleared or handled safely
                    confidence = 0.5
                    reasoning += " (Targeting password field)"

        # NAVIGATE must carry a URL - a navigation with no destination is a
        # no-op the executor would reject. Guard it here so it degrades to a
        # safe fallback instead of a wasted step.
        if raw_type == "NAVIGATE" and not url:
            logger.warning("NAVIGATE action without url - falling back")
            return self._fallback_action(
                interactive_elements,
                "NAVIGATE action missing url"
            )

        # KEY: optional. If a targetId is present it must be a real element
        # (the executor's resolve() would throw on a stale/unknown id); if it
        # is absent the key lands on the focused element / body, which is a
        # valid "press Enter on the search box I just filled" case.
        if raw_type == "KEY" and target_id is not None and target_id not in valid_element_ids:
            logger.warning(f"KEY target #{target_id} not found in page element registry")
            return self._fallback_action(
                interactive_elements,
                f"KEY target element #{target_id} not found on page"
            )

        # SWITCH_TAB (#141): hop to another open tab. Neither target nor value
        # makes sense - the tab is identified by exact tabId or a fuzzy
        # urlHint (both optional). Drop targets/values so a confused model can't
        # smuggle them through. A hop with no destination is a harmless
        # re-ground, NOT a failure - so no NAVIGATE-style fallback.
        switch_tab_id: Optional[int] = None
        url_hint: Optional[str] = None
        if raw_type == "SWITCH_TAB":
            target_id = None
            value = None
            tab_id_raw = data.get("tabId")
            if tab_id_raw is not None:
                try:
                    switch_tab_id = int(tab_id_raw)
                except (ValueError, TypeError):
                    switch_tab_id = None
            hint_raw = data.get("urlHint")
            if hint_raw is not None:
                url_hint = str(hint_raw).strip() or None

        if raw_type in {"DONE", "WAIT", "KEY", "SWITCH_TAB"}:
            confidence = 1.0

        # Cross-page task checklist: the LLM echoes its "what's done / what's
        # left" list forward. Normalize to a stable shape (id/description/done)
        # so the runner can diff it against its own memory and gate completion.
        checklist = self._parse_checklist(data.get("checklist"))

        action = ActionSchema(
            type=raw_type,
            targetId=target_id,
            value=value,
            scrollDirection=scroll_direction,
            scrollAmount=scroll_amount,
            url=url,
            waitMs=wait_ms,
            key=key_name,
            tabId=switch_tab_id,
            urlHint=url_hint,
        )

        return PlannerResult(
            success=True,
            action=action,
            confidence=confidence,
            reasoning=reasoning,
            checklist=checklist,
        )

    def _parse_checklist(self, raw: Any) -> List[ChecklistItem]:
        """Normalize the LLM's "checklist" output into ChecklistItem[].

        Accepts the documented shape (a list of {id, description, done}) plus
        reasonable variants a weaker model might emit (strings, {label/text,
        completed/complete}, missing id). Degrades to [] rather than raising -
        an empty checklist means "no task decomposition," which the runner
        treats as the pre-checklist behaviour (genuine-DONE gating off)."""
        if not isinstance(raw, (list, tuple)):
            return []
        items: List[ChecklistItem] = []
        for i, entry in enumerate(raw):
            if isinstance(entry, ChecklistItem):
                items.append(entry)
                continue
            if isinstance(entry, str):
                desc = entry.strip()
                if not desc:
                    continue
                items.append(ChecklistItem(id=str(i), description=desc, done=False))
                continue
            if not isinstance(entry, dict):
                continue
            desc = ""
            for k in ("description", "label", "text", "step", "task"):
                if entry.get(k):
                    desc = str(entry.get(k)).strip()
                    break
            done = entry.get("done")
            if done is None:
                done = entry.get("completed") or entry.get("complete") or entry.get("finished")
            done = bool(done)
            cid = entry.get("id")
            if cid is None:
                cid = str(i)
            items.append(ChecklistItem(id=str(cid), description=desc, done=done))
        return items

    def _extract_json_substring(self, text: str) -> Optional[str]:
        """Extracts JSON object string from raw LLM output text."""
        if not text:
            return None

        # Look for markdown JSON block
        json_block_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if json_block_match:
            return json_block_match.group(1).strip()

        # Look for first balanced JSON object
        json_obj_match = re.search(r"\{.*\}", text, re.DOTALL)
        if json_obj_match:
            return json_obj_match.group(0).strip()

        return None

    def _unfilled_inputs(
        self,
        interactive_elements: List[Dict[str, Any]],
        history: Optional[List[Dict[str, Any]]],
    ) -> List[Dict[str, Any]]:
        """
        Visible, non-password inputs that have NOT been filled yet (issue #59).

        An element counts as filled if it appears in `history` with result OK,
        matched by numeric id or stableId - the same matching the prompt's
        "filled" flag uses. This is what lets the SCROLL->TYPE override stop
        clobbering the scroll once every visible field is done.
        """
        filled_targets = set()
        for step in history or []:
            if step.get("result") == "OK" and step.get("targetId") is not None:
                filled_targets.add(str(step.get("targetId")))

        def is_filled(el: Dict[str, Any]) -> bool:
            ids = [str(el.get("id"))]
            if el.get("stableId"):
                ids.append(str(el.get("stableId")))
            return any(i in filled_targets for i in ids)

        return [
            el for el in interactive_elements
            if el.get("role") in ["textbox", "input"]
            and not el.get("isPassword", False)
            and not is_filled(el)
            and el.get("interactive", True)
        ]

    @staticmethod
    def _task_kv(task_description: Optional[str]) -> Dict[str, str]:
        """
        Parse "Label: Value, Label: Value" task text into lowercase
        {label-keyword: value} pairs. The same pattern build_context_prompt
        uses to feed the LLM (kept here, not just in the prompt, so the
        conservative fallback below can reuse it - issue #85).
        """
        task_kv: Dict[str, str] = {}
        if not task_description:
            return task_kv
        # Pattern: "Label: Value" separated by commas
        # e.g. "First Name: John, Last Name: Doe, Email: john@example.com"
        pairs = re.split(r',\s*(?=[A-Za-z][A-Za-z ]+\s*:)', task_description)
        for pair in pairs:
            if ':' in pair:
                key, val = pair.split(':', 1)
                task_kv[key.strip().lower()] = val.strip()
        return task_kv

    @staticmethod
    def _task_value_for_label(label: str, task_kv: Dict[str, str]) -> Optional[str]:
        """
        Issue #85: pick the task value that belongs to a page field, or None
        if the task does not reference this field. Fills only the fields the
        task names - that is the whole point of the conservative fallback.
        Matching: longest task-key whose every word occurs in the label wins
        (so "first name" beats "name" for a "First Name" field when both
        keys exist in the task).
        """
        lbl = label.lower()
        best_key: Optional[str] = None
        for key in task_kv:
            words = [w for w in key.split() if len(w) > 2]
            if not words:
                continue
            if all(w in lbl for w in words) and (best_key is None or len(key) > len(best_key)):
                best_key = key
        return task_kv[best_key] if best_key is not None else None

    def _fallback_action(
        self,
        interactive_elements: List[Dict[str, Any]],
        error_msg: str,
        task_description: Optional[str] = None,
    ) -> PlannerResult:
        """
        Generates a safe, CONSERVATIVE fallback action when planning fails
        (issue #85).

        The old behaviour typed "Test Data" into the first live input and
        clicked the first button it found - which, mid-run, clobbered the
        agent's own search query and made the stall unrecoverable. Now the
        fallback only ever touches fields the TASK references:

        1. A field whose label matches a task key-value pair  -> TYPE the
           task's own value into it (values come from task_kv, i.e. what the
           user already typed into the task box - redacted before egress).
        2. A "search"-style task with no labelled fields -> TYPE the task's
           first word into an element that looks like a search box.
        3. A button whose label matches a task keyword (submit / continue /
           search / next / go) -> CLICK it.
        4. Nothing task-referenced is actionable -> WAIT a short beat and
           let the next EXTRACT re-plan (instead of a destructive SCROLL).

        Every result stays flagged degraded=True so the UI never shows it as
        a genuine LLM decision.
        """
        task_kv = self._task_kv(task_description)
        reason = f"Conservative fallback ({error_msg}) - only task-referenced fields"

        # Pass 1: task-referenced inputs.
        for el in interactive_elements:
            element_id = el.get("id")
            role = str(el.get("role", "")).lower()
            tag = str(el.get("tag", "")).lower()
            label = str(el.get("label", "")).lower()
            is_pass = el.get("isPassword", False)
            interactive = el.get("interactive", True)

            if element_id is None or not interactive or is_pass:
                continue
            if not (role in ["textbox", "input"] or tag == "input"):
                continue
            value = self._task_value_for_label(label, task_kv)
            if value:
                return PlannerResult(
                    success=True,
                    action=ActionSchema(type="TYPE", targetId=element_id, value=value),
                    confidence=0.5,
                    reasoning=reason,
                    degraded=True,
                    degraded_reason=reason,
                )

        # Pass 2: "search ..."/"find ..." task, no labelled value fields -
        # type the task's first word into a search-looking input (the
        # Wikipedia case from #85: "search Web browser" types "search" into
        # the box named/labelled search, not into a random field).
        task_words = [w for w in re.split(r"[\s,:;]+", (task_description or "")) if w]
        if any(w.lower().startswith(("search", "find", "look")) for w in task_words):
            first_word = task_words[0] if task_words else ""
            if first_word:
                for el in interactive_elements:
                    element_id = el.get("id")
                    role = str(el.get("role", "")).lower()
                    tag = str(el.get("tag", "")).lower()
                    label = str(el.get("label", "")).lower()
                    name = str(el.get("name") or "").lower()
                    ident = str(el.get("id") or "").lower()
                    if element_id is None or el.get("isPassword", False) or not el.get("interactive", True):
                        continue
                    is_input = role in ["textbox", "input"] or tag in ("input", "textarea")
                    el_type = str(el.get("type", "")).lower()
                    # A "search-looking" input: the word "search" appears in
                    # its label / name / id, OR it is literally a search
                    # input. This is what distinguishes THE search box from
                    # some other text field on the page - we never type the
                    # query into a random field (the #85 failure mode).
                    is_search_like = (
                        "search" in label
                        or "search" in name
                        or "search" in ident
                        or (tag == "input" and el_type in ("search", "text"))
                    )
                    if is_input and is_search_like:
                        return PlannerResult(
                            success=True,
                            action=ActionSchema(type="TYPE", targetId=element_id, value=first_word),
                            confidence=0.5,
                            reasoning=reason,
                            degraded=True,
                            degraded_reason=reason,
                        )

        # Pass 3: task-keyword buttons only (never a blind "first button").
        button_kw = ("submit", "continue", "search", "next", "go")
        task_text = (task_description or "").lower()
        for el in interactive_elements:
            element_id = el.get("id")
            role = str(el.get("role", "")).lower()
            tag = str(el.get("tag", "")).lower()
            label = str(el.get("label", "")).lower()
            if element_id is None or el.get("isPassword", False) or not el.get("interactive", True):
                continue
            if not (role in ["button", "submit"] or tag == "button"):
                continue
            if any(k in label or k in task_text for k in button_kw):
                return PlannerResult(
                    success=True,
                    action=ActionSchema(type="CLICK", targetId=element_id),
                    confidence=0.5,
                    reasoning=reason,
                    degraded=True,
                    degraded_reason=reason,
                )

        # Pass 3b: collapsed search box (live diagnosis 2026-09-18). On
        # Wikipedia article pages the #searchInput is genuinely 0x0 - it sits
        # collapsed behind a visible "Search" <a> link (44x44, label "Search").
        # The old fallback had no way to reach it (Pass 1/2 want a visible
        # textbox; Pass 3 only clicks <button>s), so it WAIT-looped for ~12
        # steps hunting for a box that only exists after the toggle is
        # clicked. For a search-type task with NO visible textbox but a
        # visible "Search"-labelled link/button, click the toggle: the next
        # EXTRACT will then see the expanded input and Pass 2 types into it.
        has_visible_textbox = any(
            (str(el.get("role", "")).lower() in ("textbox", "input") or str(el.get("tag", "")).lower() in ("input", "textarea"))
            and el.get("interactive", True)
            and not el.get("isPassword", False)
            and int(el.get("width") or 0) >= 2
            for el in interactive_elements
        )
        task_words = [w for w in re.split(r"[\s,:;]+", (task_description or "")) if w]
        is_search_task = any(w.lower().startswith(("search", "find", "look")) for w in task_words)
        if is_search_task and not has_visible_textbox:
            for el in interactive_elements:
                element_id = el.get("id")
                role = str(el.get("role", "")).lower()
                tag = str(el.get("tag", "")).lower()
                label = str(el.get("label", "")).lower()
                if element_id is None or el.get("isPassword", False) or not el.get("interactive", True):
                    continue
                clickable = role in ("button", "link") or tag in ("button", "a")
                if not clickable:
                    continue
                if int(el.get("width") or 0) >= 2 and "search" in label:
                    return PlannerResult(
                        success=True,
                        action=ActionSchema(type="CLICK", targetId=element_id),
                        confidence=0.5,
                        reasoning=reason + " - clicking the visible Search toggle to expand the collapsed search box",
                        degraded=True,
                        degraded_reason=reason,
                    )

        # Pass 4: nothing task-referenced is actionable. Do NOT clobber the
        # page - wait a beat so the next EXTRACT re-plans against fresh state.
        return PlannerResult(
            success=True,
            action=ActionSchema(type="WAIT", waitMs=1000),
            confidence=0.3,
            reasoning=reason,
            error=error_msg,
            degraded=True,
            degraded_reason=reason,
        )

    async def plan(
        self,
        url: str,
        title: str,
        interactive_elements: List[Dict[str, Any]],
        accessibility_tree: List[Dict[str, Any]],
        task_description: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
        context: Optional[Dict[str, Any]] = None,
        checklist: Optional[List[Dict[str, Any]]] = None,
        loop_warning: Optional[str] = None,
        open_tabs: Optional[List[Dict[str, Any]]] = None,
        cross_tab_memory: Optional[List[Tuple[str, str]]] = None,
    ) -> PlannerResult:
        """
        Main entry point for generating an action plan.

        ``context`` carries on-device page geometry (scrollY, scrollHeight,
        viewport, moreContentBelow). It is the signal that tells the model the
        form continues below the fold so it can SCROLL to reveal the next
        fields instead of stopping after the first screen (issue #59).

        ``checklist`` is the runner's cross-page task memory: the planner
        authors + maintains an ordered list of sub-goals, flipping items
        ``done`` as they are reached. It is fed back into the prompt so the
        model can't re-do a step it already completed (the thrashing bug).

        ``open_tabs`` / ``cross_tab_memory`` (#141) let a single task span the
        user's open tabs: the model sees the tab list (url/title/id only) and
        can SWITCH_TAB to one of them, and reference harvested values by
        TOKEN. Values are masked server-side before prompt building, so a raw
        value can never reach the LLM even if the client ever sent one.
        """
        system_prompt = (
            "You are a browser automation assistant. Given sanitized webpage metadata, "
            "determine the single next action to execute in JSON format."
        )
        # #141 PII mask: cross-tab memory crosses as (token, label) pairs ONLY.
        # The runner already strips values on-device (handoffForPlanner), and
        # this is defence-in-depth: anything that sneaks through in a "value"
        # key is dropped here, before it can reach the LLM prompt.
        masked_handoff: Optional[List[Tuple[str, str]]] = None
        if cross_tab_memory:
            masked_handoff = []
            for entry in cross_tab_memory:
                try:
                    if isinstance(entry, dict):
                        # The runner's payload shape: [{token, label}] — values
                        # are stripped on-device; drop any stray "value" key so
                        # it can never leak into the prompt.
                        token = entry.get("token")
                        label = entry.get("label")
                    else:
                        token, label = entry[0], entry[1]
                    if not token:
                        continue
                    masked_handoff.append((str(token), str(label or "")))
                except (TypeError, IndexError, AttributeError):
                    # Malformed entry (not a dict / 2-tuple) - skip it, never
                    # crash the plan over one bad handoff row.
                    continue
        prompt = self.build_context_prompt(
            url=url,
            title=title,
            interactive_elements=interactive_elements,
            accessibility_tree=accessibility_tree,
            task_description=task_description,
            history=history,
            context=context,
            checklist=checklist,
            loop_warning=loop_warning,
            open_tabs=open_tabs,
            cross_tab_memory=masked_handoff,
        )

        try:
            # Log which provider we're using
            logger.info(f"Using LLM provider: {self.llm_client.name} / {self.llm_client.model_name}")

            llm_response = await self.llm_client.generate(prompt, system_prompt)
            result = self.parse_llm_output(llm_response, interactive_elements)

            # POST-PROCESSING: Override SCROLL with TYPE when an UNFILLED input
            # is visible (issue #59). The old version overrode SCROLL whenever
            # ANY textbox existed - including already-filled ones - so once a
            # screen of fields was done the agent could never scroll to reveal
            # the next section. Now: only override while there is work to do
            # on this screen; otherwise the scroll proceeds.
            if result.success and result.action and result.action.type == "SCROLL":
                unfilled_inputs = self._unfilled_inputs(interactive_elements, history)

                if unfilled_inputs:
                    first_input = unfilled_inputs[0]
                    element_id = first_input.get("id")
                    label = str(first_input.get("label", "")).lower()

                    if "name" in label:
                        value = "Test User"
                    elif "email" in label or "mail" in label:
                        value = "test@example.com"
                    elif "phone" in label or "mobile" in label or "aadhaar" in label:
                        value = "+91 9876543210"
                    elif "address" in label:
                        value = "123 Test Street, City"
                    else:
                        value = "Test Data"

                    result.action = ActionSchema(type="TYPE", targetId=element_id, value=value)
                    result.reasoning = f"Override: unfilled input #{element_id} visible - fill before scrolling"
                    logger.info(result.reasoning)
                elif context and context.get("moreContentBelow"):
                    result.reasoning = "Keeping SCROLL: visible inputs are filled, more content below the fold"
                    logger.info(result.reasoning)

            # Issue #68: if this result came from the no-op mock (no LLM
            # reachable at init), mark it degraded so the caller does NOT
            # treat a DONE as a real completion.
            if getattr(self, "_using_mock_fallback", False) and not result.degraded:
                result.degraded = True
                result.degraded_reason = "No LLM client reachable - planner running on mock fallback"

            return result
        except Exception as e:
            logger.error(f"Planner LLM execution error: {e}")
            # Issue #85: a 429/5xx that survived the client-side retry (or a
            # parse failure) degrades to the CONSERVATIVE fallback - which
            # only touches fields the task references - instead of the old
            # "type Test Data into the first live input" behaviour that
            # clobbered the agent's own state mid-run.
            return self._fallback_action(
                interactive_elements,
                f"LLM execution error: {e}",
                task_description=task_description,
            )

    async def health_check(self) -> Dict[str, Any]:
        """Check if LLM provider is healthy."""
        return await self.llm_client.health_check()
