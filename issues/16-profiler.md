## Task: Latency Profiling System

**Assignee:** @Yashop965  
**Priority:** Medium  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Create `src/lib/profiler.ts`
- [ ] Performance mark/measure API usage
- [ ] Inference timing breakdown
- [ ] Bottleneck identification
- [ ] Optimization reporting

### Profiler API
```typescript
interface PerfMetrics {
  dom_extract_ms: number;
  vision_inference_ms: number;
  plan_response_ms: number;
  action_execution_ms: number;
  total_step_ms: number;
  memory_usage_mb: number;
}

class Profiler {
  start(mark: string): void;
  end(mark: string): PerfMetrics;
  report(): string;  // Human-readable summary
}
```

### Targets
- DOM extraction: < 10ms
- Vision inference: < 1000ms
- Plan response: < 500ms
- Action execution: < 100ms
- Total step: < 2000ms

### Deliverables
- Profiler module with mark/measure
- Performance dashboard (HUD integration)
- Bottleneck detection alerts
- Optimization recommendations
