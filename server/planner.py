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
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
import json
import re
import logging

from server.llm_clients import create_llm_client, BaseLLMClient

logger = logging.getLogger("sih_agent_planner")


# ===== Protocol Schema (Matches src/lib/actions.ts) =====

class ActionSchema(BaseModel):
    type: str  # CLICK, TYPE, SCROLL, SELECT, NAVIGATE, DONE
    targetId: Optional[int] = None
    value: Optional[str] = None
    scrollDirection: Optional[str] = None  # up, down, left, right
    scrollAmount: Optional[int] = None
    url: Optional[str] = None


class PlannerResult(BaseModel):
    success: bool
    action: Optional[ActionSchema] = None
    confidence: float = 0.0
    reasoning: str = ""
    error: Optional[str] = None


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

    def build_context_prompt(
        self,
        url: str,
        title: str,
        interactive_elements: List[Dict[str, Any]],
        accessibility_tree: List[Dict[str, Any]],
        task_description: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """
        Builds a structured prompt for the LLM based on sanitized page metadata.
        """
        # Filter and preview elements safely (ensuring zero password leaks)
        sanitized_elements = []
        for el in interactive_elements[:30]:
            element_id = el.get("id")
            role = el.get("role", el.get("tag", "element"))
            label = str(el.get("label", ""))[:40]
            is_password = el.get("isPassword", False)

            if is_password:
                label = "[REDACTED PASSWORD FIELD]"

            sanitized_elements.append({
                "targetId": element_id,
                "role": role,
                "label": label,
                "interactive": el.get("interactive", True),
            })

        history_summary = []
        if history:
            for step in history[-5:]:
                history_summary.append(
                    f"- Action: {step.get('action')}, TargetId: {step.get('targetId')}, Result: {step.get('result', 'OK')}"
                )

        history_str = "\n".join(history_summary) if history_summary else "None"
        task_str = task_description or "Interact with the page to assist the user."

        prompt = f"""URL: {url}
PAGE TITLE: {title}

TASK: {task_str}

RECENT ACTION HISTORY:
{history_str}

AVAILABLE INTERACTIVE ELEMENTS:
{json.dumps(sanitized_elements, indent=2)}

CRITICAL INSTRUCTIONS - FOLLOW EXACTLY:
You are filling a FORM. The FIRST action must be to TYPE into the FIRST input field.

STEP-BY-STEP:
1. If there are INPUT fields (role=textbox): TYPE test data into the FIRST input
   - Use: "TYPE" action with targetId and value
   - Example value: "Test User" for name fields
2. Continue TYPEing into each input field one by one
3. When ALL inputs are filled, CLICK the SUBMIT button
4. Only use SCROLL if there are NO visible input fields

YOUR NEXT ACTION MUST BE:
- TYPE into an input field (if inputs exist)
- CLICK a button (if no inputs remain)
- SCROLL (ONLY if absolutely necessary)

Return ONLY this JSON (no markdown, no explanation):
{{"type": "TYPE", "targetId": <first_input_id>, "value": "Test User", "reasoning": "filling first name field"}}"""
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
        valid_types = {"CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "DONE"}
        
        if raw_type not in valid_types:
            logger.warning(f"Invalid action type: {raw_type}")
            return self._fallback_action(interactive_elements, f"Invalid action type '{raw_type}'")

        target_id = data.get("targetId")
        if target_id is not None:
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

        if raw_type == "DONE":
            confidence = 1.0

        action = ActionSchema(
            type=raw_type,
            targetId=target_id,
            value=value,
            scrollDirection=scroll_direction,
            scrollAmount=scroll_amount,
            url=url,
        )

        return PlannerResult(
            success=True,
            action=action,
            confidence=confidence,
            reasoning=reasoning,
        )

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

    def _fallback_action(self, interactive_elements: List[Dict[str, Any]], error_msg: str) -> PlannerResult:
        """
        Generates a safe fallback action when planning fails.
        Uses heuristic rules to fill forms intelligently.
        """
        # Find first non-password input field for TYPE
        for el in interactive_elements:
            element_id = el.get("id")
            role = str(el.get("role", "")).lower()
            tag = str(el.get("tag", "")).lower()
            label = str(el.get("label", "")).lower()
            is_pass = el.get("isPassword", False)
            interactive = el.get("interactive", True)

            if element_id is None or not interactive or is_pass:
                continue

            # TYPE into text inputs
            if role in ["textbox", "input"] or tag == "input":
                # Generate appropriate test data based on label
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

                return PlannerResult(
                    success=True,
                    action=ActionSchema(type="TYPE", targetId=element_id, value=value),
                    confidence=0.9,
                    reasoning=f"Heuristic: typing into {role} field #{element_id}",
                )

        # Find button for CLICK
        for el in interactive_elements:
            element_id = el.get("id")
            role = str(el.get("role", "")).lower()
            tag = str(el.get("tag", "")).lower()
            is_pass = el.get("isPassword", False)
            interactive = el.get("interactive", True)

            if element_id is None or not interactive or is_pass:
                continue

            if role in ["button", "submit"] or tag == "button":
                return PlannerResult(
                    success=True,
                    action=ActionSchema(type="CLICK", targetId=element_id),
                    confidence=0.9,
                    reasoning=f"Heuristic: clicking button #{element_id}",
                )

        # Default fallback to scroll or done
        return PlannerResult(
            success=True,
            action=ActionSchema(type="SCROLL", scrollDirection="down", scrollAmount=400),
            confidence=0.3,
            reasoning="Fallback heuristic scroll down",
            error=error_msg,
        )

    async def plan(
        self,
        url: str,
        title: str,
        interactive_elements: List[Dict[str, Any]],
        accessibility_tree: List[Dict[str, Any]],
        task_description: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> PlannerResult:
        """
        Main entry point for generating an action plan.
        """
        system_prompt = (
            "You are a browser automation assistant. Given sanitized webpage metadata, "
            "determine the single next action to execute in JSON format."
        )
        prompt = self.build_context_prompt(
            url=url,
            title=title,
            interactive_elements=interactive_elements,
            accessibility_tree=accessibility_tree,
            task_description=task_description,
            history=history,
        )

        try:
            # Log which provider we're using
            logger.info(f"Using LLM provider: {self.llm_client.name} / {self.llm_client.model_name}")
            
            llm_response = await self.llm_client.generate(prompt, system_prompt)
            return self.parse_llm_output(llm_response, interactive_elements)
        except Exception as e:
            logger.error(f"Planner LLM execution error: {e}")
            return self._fallback_action(interactive_elements, f"LLM execution error: {e}")

    async def health_check(self) -> Dict[str, Any]:
        """Check if LLM provider is healthy."""
        return await self.llm_client.health_check()
