## Task: Popup UI Development

**Assignee:** @Himanshi-256  
**Priority:** High  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `src/popup/Popup.tsx` with React UI
- [ ] Task input field with placeholder examples ("Fill form", "Submit application")
- [ ] Start/Stop automation controls
- [ ] Step counter and progress indicator
- [ ] Resource usage mini-display (RAM, latency)
- [ ] Link to privacy ledger panel
- [ ] Set-of-Marks overlay toggle button

### Design Notes
- Use TailwindCSS for styling
- Keep it lightweight (< 2MB bundle)
- Mobile-responsive (popup can be expanded)

### Deliverables
- Popup component with all UI elements
- State management hook (`useExtensionState.ts`)
- Integration with content script via messaging

### References
- PRD Section 4.1: https://github.com/Yashop965/sih2026-ps171-browser-agent/blob/main/docs/PRD.md#41-himanshi-frontend
- WXT docs: https://wxt.dev/guide/essentials/popups.html
