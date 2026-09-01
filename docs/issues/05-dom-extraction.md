## Task: Content Script & DOM Extraction

**Assignee:** @anirudh657  
**Priority:** High  
**Due:** Day 1 (Aug 29)

### Requirements
- [ ] Create `src/content/index.ts` — main content script
- [ ] Implement `src/lib/dom.ts` — DOM extraction engine
- [ ] Accessibility tree traversal
- [ ] Element bounding box calculation
- [ ] Text content extraction
- [ ] Form field identification (input, select, textarea, button)

### Data Flow
```
Page Load → Extract Acc Tree → Identify Form Fields → Store in Memory
                                                  ↓
                                          Send to Background
```

### Technical Details
- Use `document.querySelectorAll` for selectors
- Use `getBoundingClientRect()` for coordinates
- Use `element.getAttribute('aria-label')` for labels
- Handle dynamic content (mutation observers)
- Throttle events to < 10ms processing time

### Deliverables
- Content script with DOM extraction
- DOM utilities module
- Test coverage for edge cases
