## Task: FastAPI Server Implementation

**Assignee:** @YuvrajGora  
**Priority:** High  
**Due:** Day 1 (Aug 29)

### Requirements
- [ ] Create `server/main.py` — FastAPI application
- [ ] Implement `POST /plan` endpoint
- [ ] Implement `GET /health` endpoint
- [ ] CORS configuration for extension origin
- [ ] Request/response middleware
- [ ] Health check and monitoring endpoints

### API Contract
```python
@app.post("/plan")
async def plan_action(request: PlanRequest) -> PlanResponse:
    # 1. Validate request
    # 2. Build context from elements
    # 3. Call LLM planner
    # 4. Return action
    pass
```

### Technical Details
- Use FastAPI async/await patterns
- Pydantic models for validation
- Structured logging (JSON format)
- Rate limiting middleware
- Request size limits (50KB max)

### Deliverables
- FastAPI server skeleton
- `/plan` endpoint with validation
- `/health` endpoint
- Requirements.txt with dependencies
