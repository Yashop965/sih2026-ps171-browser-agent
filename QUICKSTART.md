# Quick Start Guide — SIH2026 PS171 Browser Agent

## For Competition Demo (5 minutes)

### 1. Start Ollama (if not running)
```bash
ollama serve
```

### 2. Start Server (Terminal 1)
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python server/main.py
```

### 3. Load Extension (Chrome)
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select: `dist/chrome-mv3/`

### 4. Open Mock Portal
```
file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/mock-form.html
```

### 5. Test the Agent
1. Type task in popup: "Fill the form with test data"
2. Click "Start Agent"
3. Watch actions execute
4. Check Privacy Ledger

---

## Troubleshooting

### "Could not establish connection"
- Server not running → Start `python server/main.py`
- Wrong port → Check manifest has `http://localhost:8000`

### "No response from planner"
- Ollama not running → Start `ollama serve`
- Model not pulled → Run `ollama pull qwen2.5:1.5b`

### Extension not detecting PII
- Refresh page (Ctrl+Shift+R)
- Check console for `[PII]` logs
- Make sure you're on an HTML page, not chrome://

---

## Files Needed for Competition

| File | Location |
|------|----------|
| Extension package | `sih2026-ps171-extension.zip` |
| Mock portal | `public/mock-form.html` |
| Server | `server/main.py` |
| Documentation | `docs/` folder |

Copy all to USB drive as backup!
