## Task: Action Executor Implementation

**Assignee:** @anirudh657  
**Priority:** High  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Implement click simulation (mouse events)
- [ ] Implement type simulation (input events)
- [ ] Implement scroll execution
- [ ] Implement select/dropdown interaction
- [ ] Form submission handling
- [ ] Error recovery (retry logic)

### Action Types
```typescript
interface Action {
  type: 'CLICK' | 'TYPE' | 'SCROLL' | 'SELECT' | 'NAVIGATE' | 'DONE';
  targetId?: number;
  value?: string;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  url?: string;
}
```

### Technical Details
- Use `element.click()` for clicks
- Use `element.value = 'text'` + `dispatchEvent(new Event('input'))` for typing
- Use `window.scrollBy()` for scrolling
- Handle shadow DOM and iframe boundaries
- Timeout handling (5s per action)

### Deliverables
- Action executor module (`src/lib/actions.ts`)
- Event simulation utilities
- Integration with server responses
