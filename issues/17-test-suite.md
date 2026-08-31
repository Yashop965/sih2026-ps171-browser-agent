## Task: PII Detector Test Suite

**Assignee:** @Vedant-Singhal  
**Priority:** Medium  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `tests/test_pii_detector.ts`
- [ ] Unit tests for Aadhaar validation
- [ ] Unit tests for PAN validation
- [ ] Unit tests for Credit card Luhn check
- [ ] Unit tests for IFSC validation
- [ ] Unit tests for Phone/Email patterns
- [ ] Performance tests (< 5ms per check)

### Test Cases
```typescript
describe('Aadhaar Validator', () => {
  test('valid Aadhaar with Verhoeff', () => {
    expect(validateAadhaar('1234 5678 9012')).toBe(true);
  });
  
  test('invalid Aadhaar (wrong checksum)', () => {
    expect(validateAadhaar('1234 5678 9013')).toBe(false);
  });
});

describe('PAN Validator', () => {
  test('valid PAN format', () => {
    expect(validatePAN('ABCDE1234F')).toBe(true);
  });
  
  test('invalid PAN (wrong length)', () => {
    expect(validatePAN('ABCDE1234')).toBe(false);
  });
});
```

### Deliverables
- Test suite with 95%+ coverage
- Performance benchmarks
- CI integration (GitHub Actions)
