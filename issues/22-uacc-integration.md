## Task: UACC Integration

**Assignee:** @Yashop965  
**Priority:** Medium  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Install UACC on server: `pip install uacc`
- [ ] Create `server/action_executor.py` with UACC client
- [ ] Implement smart_click with retry logic
- [ ] Implement smart_type with verification
- [ ] Add verify_action after each operation
- [ ] Handle CDP connection management

### Integration Code
```python
# server/action_executor.py
from uacc import UACCClient

class ActionExecutor:
    def __init__(self, cdp_port: int = 9222):
        self.client = UACCClient(f"http://localhost:{cdp_port}")
    
    async def execute(self, action: Action) -> ActionResult:
        if action.type == "CLICK":
            return await self.client.smart_click(
                x=action.x, y=action.y,
                max_retries=3,
                verify=True
            )
        elif action.type == "TYPE":
            return await self.client.smart_type(
                x=action.x, y=action.y,
                text=action.value,
                clear=True
            )
```

### Requirements
- UACC installed on server
- CDP port 9222 accessible
- Chrome running with --remote-debugging-port

### Deliverables
- UACC integration module
- Retry logic with exponential backoff
- Verification after each action
- Error handling for CDP disconnection
