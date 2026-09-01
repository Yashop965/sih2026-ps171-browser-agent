## Task: Latency HUD Component

**Assignee:** @Himanshi-256  
**Priority:** Medium  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Create `src/components/LatencyHUD.tsx`
- [ ] Per-step timing breakdown (DOM, Vision, Plan, Execute)
- [ ] Cumulative task timer
- [ ] RAM usage bar graph
- [ ] WebGPU utilization indicator
- [ ] Target thresholds:
  - DOM path: < 10ms
  - Vision path: < 1000ms
  - Total step: < 2s

### Visual Design
- Compact overlay (can minimize)
- Color-coded performance:
  - Green: Under target
  - Yellow: Approaching limit
  - Red: Exceeded target
- Real-time updates (60fps)

### Deliverables
- LatencyHUD component
- Performance tracking hook (`src/hooks/usePerfTracker.ts`)
- Integration with extension state
