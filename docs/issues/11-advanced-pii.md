## Task: Advanced PII Handling

**Assignee:** TBD (Laavannya)  
**Priority:** High  
**Due:** Day 3 (Aug 31)

### Requirements
- [ ] Password field auto-blacklisting
- [ ] Selective redaction logic
- [ ] Face detection fallback (Shape Detection API)
- [ ] Canvas-based blur/redaction
- [ ] Outbound payload scanner

### Password Detection
```typescript
// Check input types that should never leave the browser
const SENSITIVE_TYPES = [
  'password',
  'hidden',
  'tel',  // Phone numbers
  'email' // Handled separately
];

// Also check label patterns
const PASSWORD_PATTERNS = [
  /password/i,
  /pin/i,
  /secret/i,
  /passwd/i
];
```

### Face Detection
```typescript
// Use Shape Detection API if available
if ('FaceDetector' in window) {
  const detector = new FaceDetector();
  const faces = await detector.detect(image);
  // Mark face regions for blurring
}
```

### Deliverables
- Password blacklisting module
- Face detection fallback
- Canvas redaction utilities
- Payload scanner middleware
