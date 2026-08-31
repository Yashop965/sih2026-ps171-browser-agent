## Task: Logging System

**Assignee:** TBD (Laavannya)  
**Priority:** Medium  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `server/middleware/logging.py`
- [ ] Structured JSON logging
- [ ] Request/response tracing
- [ ] Performance metrics collection
- [ ] Privacy-safe audit trail

### Log Format
```json
{
  "timestamp": "2026-08-29T10:30:00Z",
  "level": "INFO",
  "event": "request_received",
  "request_id": "abc123",
  "endpoint": "/plan",
  "method": "POST",
  "client_ip": "127.0.0.1",
  "user_agent": "Chrome/118.0",
  "metadata": {
    "element_count": 15,
    "task_length": 25,
    "step": 1
  }
}
```

### Privacy Safeguards
- Never log raw PII values
- Log only counts, sizes, types
- Hash sensitive fields if needed for debugging
- Implement log rotation (keep 7 days)

### Deliverables
- Logging middleware
- Request tracing decorator
- Performance metric collection
- Log rotation config
