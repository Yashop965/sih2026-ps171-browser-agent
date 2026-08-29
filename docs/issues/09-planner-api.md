## Task: Action Planner Implementation

**Assignee:** @YuvrajGora  
**Priority:** High  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Create `server/planner.py`
- [ ] Context builder (elements → prompt)
- [ ] Action parser (LLM output → structured JSON)
- [ ] Confidence scoring
- [ ] Multi-step reasoning

### Prompt Template
```python
SYSTEM_PROMPT = """You are a browser automation assistant.
Given a sanitized webpage structure and a user task,
return the next action to take.

Respond in JSON format:
{
  "action": "CLICK" | "TYPE" | "SCROLL" | "SELECT" | "DONE",
  "targetId": <number>,
  "value": "<text>" (if TYPE/SELECT),
  "confidence": <0-1>,
  "reasoning": "<explanation>"
}"""
```

### Technical Details
- Parse LLM output with JSON extraction
- Validate action against schema
- Add confidence scoring based on LLM certainty
- Track conversation history for multi-step tasks
- Handle edge cases (no action found, ambiguous task)

### Deliverables
- Planner module with context building
- Action parser with validation
- Multi-step reasoning support
- Error handling for malformed responses
