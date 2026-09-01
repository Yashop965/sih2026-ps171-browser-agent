## Task: Demo Mock Portal Setup

**Assignee:** @Vedant-Singhal  
**Priority:** High  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Create `public/mock-form.html`
- [ ] Simulate Indian government portal (Aadhaar enrollment form)
- [ ] Include fields: Name, Aadhaar, PAN, Phone, Email, Address
- [ ] Add realistic styling (govt portal look)
- [ ] Include pre-filled PII for testing
- [ ] Add submit button with validation

### Form Fields
| Field | Type | Sample Data | Purpose |
|-------|------|-------------|---------|
| Full Name | text | "Test User" | Clean data |
| Aadhaar Number | text | "1234 5678 9012" | PII detection |
| PAN Number | text | "ABCDE1234F" | PII detection |
| Mobile | tel | "9876543210" | PII detection |
| Email | email | "test@example.com" | PII detection |
| Address | textarea | "123 Main St..." | Clean data |
| Password | password | "test123" | Blacklisting test |

### Technical Details
- Static HTML (no backend required)
- Use TailwindCSS for styling
- Include comment hints for each field
- Make it look authentic (govt portal aesthetic)

### Deliverables
- Mock portal HTML file
- CSS styling
- Test data documentation
