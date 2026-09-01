## Task: SoM Overlay Component

**Assignee:** @Himanshi-256  
**Priority:** High  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `src/components/SoMOverlay.tsx`
- [ ] Canvas-based numbered bounding boxes
- [ ] Click-to-select interaction (user clicks number → highlights element)
- [ ] Visual feedback on hover/click (scale, color change)
- [ ] Toggle visibility controls (show/hide overlay)
- [ ] Performance: < 10ms render time

### Technical Details
- Use HTML5 Canvas API for rendering
- Handle coordinate transformation (screen → element space)
- Support multiple detection layers (DOM + Vision)
- Animation: fade-in/out when elements detected

### Deliverables
- SoMOverlay component
- Coordinate transformation utility (`src/lib/vision/som.ts`)
- Integration with vision worker
