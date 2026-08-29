## Task: PII Detection Engine

**Assignee:** TBD (Laavannya)  
**Priority:** Critical (40% of evaluation)  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `src/lib/pii/detector.ts`
- [ ] Aadhaar detection with Verhoeff checksum
- [ ] PAN format validation (AAAPM#####R)
- [ ] Credit card detection with Luhn algorithm
- [ ] IFSC code validation
- [ ] Phone number detection (Indian format)
- [ ] Email detection
- [ ] Password field identification

### Detection Logic
```typescript
interface PIICheck {
  pattern: RegExp;
  validator?: (value: string) => boolean;
  category: PII_CATEGORY;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

const CHECKS: PIICheck[] = [
  {
    pattern: /^\d{4}\s?\d{4}\s?\d{4}$/,
    validator: verifyAadhaar, // Verhoeff
    category: 'AADHAAR',
    severity: 'HIGH'
  },
  {
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/,
    validator: verifyPAN,
    category: 'PAN',
    severity: 'HIGH'
  },
  // ... more checks
];
```

### Deliverables
- PII detector module with all validators
- Unit tests for each detector
- Performance benchmarks (< 5ms detection)
