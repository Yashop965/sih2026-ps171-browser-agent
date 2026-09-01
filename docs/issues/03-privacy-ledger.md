## Task: Privacy Ledger Component

**Assignee:** @Himanshi-256  
**Priority:** High (Critical for 40% scoring)  
**Due:** Day 2 (Aug 30)

### Requirements
- [ ] Create `src/components/PrivacyLedger.tsx`
- [ ] Scrollable log of detections/redactions
- [ ] Color-coded entries:
  - Red = Blocked/Redacted PII
  - Green = Allowed/Clean data
  - Yellow = Warning
- [ ] Export capability (JSON dump for judges)
- [ ] Real-time ticker animation
- [ ] Tamper-proof counter (incrementing nonce)

### Data Structure
```typescript
interface LedgerEntry {
  id: string;
  timestamp: Date;
  type: 'PII_DETECTED' | 'PII_REDACTED' | 'CLEAN_DATA' | 'EGRESS_BLOCKED';
  category: 'AADHAAR' | 'PAN' | 'CARD' | 'PASSWORD' | 'FACE' | 'PHONE' | 'EMAIL';
  original?: string;  // Hash only, never raw value
  action: string;     // What was done
  confidence: number; // 0-1
}
```

### Deliverables
- PrivacyLedger component
- Integration with `src/lib/privacy.ts`
- Export functionality
