# Competition Day Checklist — SIH2026 PS171

## Pre-Competition (Night Before)

- [ ] Copy project to USB drive
- [ ] Test extension loads in Chrome
- [ ] Test server starts correctly
- [ ] Test Ollama model runs
- [ ] Record backup demo video
- [ ] Print documentation

---

## Competition Day Setup (5 minutes)

### Step 1: Start Ollama
```bash
ollama serve
```
Keep this terminal open!

### Step 2: Start Server
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```
Keep this terminal open!

### Step 3: Load Extension
1. Open Chrome
2. Go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select: `dist/chrome-mv3/`

### Step 4: Open Mock Portal
```
file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/mock-form.html
```

---

## Demo Flow (5 minutes)

### 1. Introduction (30 seconds)
"Most AI agents send your data to the cloud. Ours doesn't. Let me show you."

### 2. Show Extension (30 seconds)
- Click extension icon
- Show Privacy Ledger (empty initially)
- Point out: "This logs everything we redact"

### 3. PII Detection Demo (60 seconds)
1. Navigate to mock portal
2. Type in Aadhaar field: `1234 5678 9012`
3. Show console: `[PII] Detected: AADHAAR`
4. Show Privacy Ledger: "1 redacted"
5. Type PAN: `ABCDE1234F`
6. Show detection and redaction

### 4. Autonomous Action (60 seconds)
1. Open extension popup
2. Enter task: "Fill all fields with test data"
3. Click "Start Agent"
4. Watch actions execute
5. Show Privacy Ledger updating in real-time

### 5. Privacy Proof (60 seconds)
1. Click "Export Ledger" in extension
2. Show JSON file downloaded
3. Point out: "No raw values, only structural metadata"
4. Mention SHA-256 integrity hash

### 6. Offline Capability (30 seconds)
1. Turn off WiFi
2. Show extension still works
3. "All processing happens on-device"

### 7. Code Quality (30 seconds)
1. Open terminal
2. Run: `npm test`
3. Show: "59/59 tests passing"
4. Run: `npx tsc --noEmit`
5. Show: "0 errors"

---

## Potential Judge Questions

### Q: How is this different from other browser agents?
**A:** Three things:
1. **Privacy-first**: No PII leaves the machine
2. **On-device**: Works offline, no cloud dependency
3. **Provable**: SHA-256 signed ledger proves what was redacted

### Q: What if the LLM fails?
**A:** We have multiple fallbacks:
1. Custom API (Groq, Together AI)
2. Local Ollama
3. Mock planner (deterministic actions)

### Q: How do you handle passwords?
**A:** Three layers:
1. Content script never reads `element.value` for password fields
2. Outbound payload scanner blocks any raw passwords
3. Privacy ledger shows "PASSWORD_FIELD detected" without value

### Q: Is this production-ready?
**A:** Yes:
- 59 unit tests passing
- TypeScript strict mode (0 errors)
- Cross-browser (Chrome + Firefox)
- Modular architecture (easy to extend)

---

## Backup Plans

### If Ollama Fails
- Use MockLLMClient (built-in fallback)
- Actions become deterministic but still demonstrate privacy

### If Server Fails
- Extension still works locally
- PII detection happens in browser
- Just no autonomous planning

### If Extension Doesn't Load
- Have zip file ready: `sih2026-ps171-extension.zip`
- Extract and reload
- Or use Firefox (more reliable for dev mode)

---

## Files to Have Ready

| File | Purpose |
|------|---------|
| `sih2026-ps171-extension.zip` | Backup extension package |
| `docs/DEMO.md` | Full demo script |
| `docs/TEAM.md` | Team contributions |
| `README.md` | Project overview |
| `QUICKSTART.md` | Setup instructions |

---

## Quick Commands Reference

```bash
# Start Ollama
ollama serve

# Start server
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000

# Run tests
npm test

# Build extension
npm run build

# Check TypeScript
npx tsc --noEmit

# Verify server
curl http://localhost:8000/health

# List Ollama models
ollama list
```

---

## Success Metrics

✅ Extension loads without errors  
✅ PII detection works (console logs visible)  
✅ Privacy Ledger shows entries  
✅ Actions execute (click/type)  
✅ Export generates JSON file  
✅ Tests pass (59/59)  
✅ Build clean (0 TypeScript errors)

---

*Good luck! You've built something impressive.*
