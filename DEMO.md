# Demo Guide — SIH2026 PS171 Browser Agent

## Quick Start (2 minutes)

### Prerequisites
- Chrome or Firefox browser
- Extension loaded in dev mode
- Server running (optional for basic demo)

### Load Extension
1. Open `chrome://extensions` (or `about:debugging` in Firefox)
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select `C:/Users/yashs/SIH2026/ps171-browser-agent/.wxt`

### Test PII Detection
1. Navigate to any form page (e.g., `https://example.com`)
2. Open DevTools → Console
3. Type test data in input fields:
   - Aadhaar: `1234 5678 9012`
   - PAN: `ABCDE1234F`
   - Credit Card: `4111 1111 1111 1111`
4. Watch console for PII detection logs
5. Check Privacy Ledger in extension popup

### Test Actions
1. Open extension popup
2. Enter task: "Click the submit button"
3. Watch action execution in console
4. Verify Privacy Ledger updates

---

## Full Demo Flow (5 minutes)

### Setup
```bash
# Terminal 1: Start server
python server/main.py

# Terminal 2: Start extension dev mode
npm run dev:client
```

### Demo Script
1. **Introduction** (30 seconds)
   - Show the problem: AI agents send sensitive data to clouds
   - Our solution: On-device processing, zero data leaves the machine

2. **Show Extension** (30 seconds)
   - Click extension icon
   - Show Privacy Ledger panel
   - Explain each section

3. **PII Detection** (60 seconds)
   - Navigate to form page
   - Type Aadhaar number in input
   - Show real-time detection in console
   - Highlight: "This never left your machine"

4. **Vision Pipeline** (60 seconds)
   - Trigger SoM overlay
   - Show numbered bounding boxes
   - Explain WebGPU inference

5. **Action Execution** (60 seconds)
   - Enter task: "Fill form with test data"
   - Show action plan generated
   - Watch autonomous filling
   - Verify each step in Privacy Ledger

6. **Privacy Guarantees** (30 seconds)
   - Show split view: original vs sanitized
   - Demonstrate what was blocked
   - Highlight DPDP Act compliance

7. **Cross-Browser** (30 seconds)
   - Show Firefox build passing
   - Mention WASM fallback

---

## Adversarial Testing (Judge Interaction)

### Test 1: PII Injection
**Ask judges:** "Type any Aadhaar number or credit card"
**Expected:** Detection logs appear, value redacted before any transmission

### Test 2: Offline Mode
**Action:** Turn off WiFi mid-demo
**Expected:** Extension still works, uses local DOM path

### Test 3: Password Fields
**Action:** Type in password field
**Expected:** No value extracted, only field type detected

---

## Technical Verification

### Run Tests
```bash
npm test
# Expected: 50/50 passing
```

### Check Builds
```bash
npm run build
# Expected: 251.97KB Chrome, 251.96KB Firefox
```

### View Logs
```bash
# Server logs
tail -f server/logs/*.log

# Browser console
# Look for [PII], [ACTION], [LEDGER] prefixes
```

---

## Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| Extension not loading | Check `chrome://extensions`, reload |
| PII not detected | Open DevTools, check console errors |
| Server connection refused | Start server first: `python server/main.py` |
| SoM overlay not appearing | Check WebGPU support: `chrome://gpu` |
| Firefox build failing | Use `npx wxt build -b firefox` |

---

## Performance Metrics

| Metric | Target | Current |
|--------|--------|---------|
| DOM extraction | <10ms | ~5ms |
| PII detection | <5ms | ~2ms |
| Vision inference | <500ms | ~200ms (WebGPU) |
| Action execution | <100ms | ~50ms |
| Total pipeline | <1s | ~300ms |

---

## What Judges Will See

1. **Privacy-First Design**
   - No raw DOM sent to server
   - No PII values transmitted
   - Live audit log of all operations

2. **On-Device Processing**
   - Vision runs in browser via WebGPU
   - Models loaded locally (ONNX)
   - Works offline after initial load

3. **Cross-Browser Support**
   - Chrome MV3 build
   - Firefox MV2 build
   - Same codebase, dual targets

4. **Production Ready**
   - 50 unit tests passing
   - TypeScript strict mode
   - Clean build (<252KB)
