## Task: Request Validation Middleware

**Assignee:** TBD (Laavannya)  
**Priority:** Medium  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `server/middleware/validators.py`
- [ ] JSON schema validation (Pydantic models)
- [ ] Input sanitization
- [ ] Rate limiting
- [ ] Payload size limits (50KB max)

### Pydantic Models
```python
from pydantic import BaseModel, Field, validator
from typing import Optional, List

class ElementMeta(BaseModel):
    id: int
    role: str
    label: str
    x: float
    y: float
    width: float
    height: float
    type: Optional[str] = None
    value: Optional[str] = None
    
    @validator('role')
    def validate_role(cls, v):
        allowed = ['button', 'input', 'text', 'select', 'checkbox', 'radio']
        if v not in allowed:
            raise ValueError(f'Invalid role: {v}')
        return v.lower()

class PlanRequest(BaseModel):
    elements: List[ElementMeta]
    task: str
    step: int
    history: Optional[List[dict]] = None
    thumbnail: Optional[str] = None
    
    @validator('task')
    def validate_task(cls, v):
        if len(v) > 500:
            raise ValueError('Task too long (max 500 chars)')
        return v.strip()
```

### Deliverables
- Validator middleware
- Rate limiter (100 req/min)
- Size limit enforcement
- Error response formatting
