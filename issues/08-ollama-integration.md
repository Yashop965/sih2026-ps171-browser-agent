## Task: Ollama Integration

**Assignee:** @YuvrajGora  
**Priority:** High  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `server/ollama_client.py`
- [ ] Local model client (qwen2.5:1.5b)
- [ ] Streaming response support
- [ ] Timeout and retry logic
- [ ] Model warm-up and caching

### Model Selection
- Primary: `qwen2.5:1.5b` (fast, ~1.2GB RAM)
- Fallback: `phi3:mini` (smaller, ~2GB VRAM)
- Cloud fallback: OpenAI-compatible endpoint

### Technical Details
```python
import requests

async def generate_action(context: str, task: str) -> dict:
    response = requests.post(
        "http://localhost:11434/api/generate",
        json={
            "model": "qwen2.5:1.5b",
            "prompt": build_prompt(context, task),
            "stream": False
        },
        timeout=10
    )
    return parse_response(response.json())
```

### Deliverables
- Ollama client module
- Prompt builder for action planning
- Timeout/retry handling
- Cloud fallback implementation
