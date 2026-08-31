# SIH2026 PS171 — Browser Agent Installation Guide

## Quick Install (2 minutes)

### Step 1: Download Extension
The extension is already built and ready in the `dist/chrome-mv3/` folder.

### Step 2: Load in Chrome
1. Open Chrome browser
2. Navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select folder: `C:/Users/yashs/SIH2026/ps171-browser-agent/dist/chrome-mv3`
6. Extension should appear in toolbar

### Step 3: Verify Installation
1. Click the extension icon
2. You should see "SIH2026 PS171 Browser Agent" popup
3. Check console for: `[PII] Extension loaded successfully`

---

## Firefox Installation

1. Open Firefox
2. Navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select: `dist/firefox-mv2/manifest.json`
5. Extension loads for current session only

---

## Test with Mock Portal

### Option 1: Local File
1. Open: `file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/mock-form.html`
2. The extension should auto-inject
3. Fill form fields manually or use extension automation

### Option 2: Local Server (Recommended)
```bash
# From project root
python -m http.server 8080
```
Then open: `http://localhost:8080/public/mock-form.html`

---

## Expected Behavior

### When Extension Loads
- Console shows: `[PII] Privacy engine initialized`
- Privacy Ledger panel appears in popup
- Content script injects into pages

### When Filling Form
- Type Aadhaar number → see detection in console
- Type PAN → see format validation
- Type in password field → see "password field detected" (value NOT logged)
- Submit form → all actions logged in Privacy Ledger

### Privacy Ledger Entries
You should see entries like:
- `DETECTED: AADHAAR - 1234****` (masked)
- `DETECTED: PAN - ABCD****` (masked)
- `REDACTED: PASSWORD_FIELD`
- `SENT_TO_SERVER: sanitized metadata only`

---

## Troubleshooting

### Extension Not Appearing
```bash
# Check if loaded
chrome://extensions/

# If missing, reload:
- Toggle Developer mode off/on
- Click "Reload" on the extension card
```

### Content Script Not Injecting
1. Refresh the page (Ctrl+Shift+R)
2. Check console for injection errors
3. Verify `matches` field in manifest includes your URL

### Privacy Ledger Empty
- The ledger only populates when PII is detected
- Type test data: `1234 5678 9012` in Aadhaar field
- Check console for `[PII] Detected: AADHAAR`

### Build Issues
```bash
# Rebuild extension
npm run build

# Check build output
ls dist/chrome-mv3/
```

---

## Demo Checklist for Judges

1. [ ] Extension loaded in Chrome
2. [ ] Mock portal open
3. [ ] Fill Aadhaar field → show PII detection
4. [ ] Fill PAN field → show validation
5. [ ] Type in password → show it's blocked
6. [ ] Open Privacy Ledger → show live entries
7. [ ] Export ledger → show SHA-256 integrity
8. [ ] Turn off WiFi → show offline capability
9. [ ] Run tests → `npm test` (50/50 passing)

---

## Files Reference

| File | Purpose |
|------|---------|
| `dist/chrome-mv3/` | Chrome extension package |
| `dist/firefox-mv2/` | Firefox extension package |
| `public/mock-form.html` | Demo test portal |
| `docs/MOCK_PORTAL.md` | Mock portal documentation |
| `docs/DEMO.md` | Demo script |
| `docs/TEAM.md` | Team contributions |

---

## Version Info

- **Extension Version:** 1.0.0
- **Manifest Version:** 3 (Chrome), 2 (Firefox)
- **Build Size:** 258.43 KB
- **Tests:** 50/50 passing
- **Last Build:** August 31, 2026
