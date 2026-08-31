# Deployment Guide — SIH2026 PS171 Browser Agent

## Quick Deploy (For Competition)

### Method 1: Chrome Dev Mode (Recommended for Demo)
```bash
# 1. Build the extension
npm run build

# 2. Load in Chrome
# Open: chrome://extensions/
# Enable: Developer mode (toggle)
# Click: Load unpacked
# Select: dist/chrome-mv3/
```

### Method 2: Using Pre-built Package
```bash
# The zip file is already created: sih2026-ps171-extension.zip
# Extract it and load as unpacked extension
```

### Method 3: Firefox
```bash
# Open: about:debugging#/runtime/this-firefox
# Click: Load Temporary Add-on
# Select: dist/firefox-mv2/manifest.json
```

---

## What's Included in the Package

```
sih2026-ps171-extension.zip (160KB)
├── chrome-mv3/             # Chrome extension
│   ├── manifest.json
│   ├── popup.html
│   ├── background.js
│   ├── content-scripts/
│   └── assets/
├── firefox-mv2/            # Firefox extension
│   ├── manifest.json
│   └── popup.html
└── docs/
    └── INSTALL.md          # Installation guide
```

---

## For Judges/Demo

### What to Show
1. **Load the extension** — 2 minutes
2. **Open mock portal** — `public/mock-form.html`
3. **Demonstrate PII detection** — Type Aadhaar/PAN
4. **Show Privacy Ledger** — Live audit log
5. **Export ledger** — SHA-256 verification
6. **Run tests** — `npm test` (59/59 passing)

### Backup Plan
- Have the zip file ready on USB
- Pre-load extension in Chrome before demo
- Screenshot of working extension as backup

---

## Chrome Web Store Submission (Future)

If you want to publish to Chrome Web Store:

1. **Sign the extension**
   ```bash
   # Use crxtool or Chrome Extension Packager
   # Generate .crx file from dist/chrome-mv3/
   ```

2. **Create developer account**
   - Cost: $5 one-time fee
   - URL: chrome.google.com/webstore/devconsole

3. **Prepare listing**
   - Description: Use README.md
   - Screenshots: Capture demo flow
   - Privacy policy: Document PII handling

**Note:** For SIH competition, dev mode loading is sufficient.

---

## Troubleshooting

### Extension Not Loading
```bash
# Check if build exists
ls dist/chrome-mv3/manifest.json

# Rebuild if needed
npm run build
```

### PII Detection Not Working
```bash
# Check console for errors
# Open DevTools → Console
# Look for [PII] logs
```

### Server Not Connecting
```bash
# Start the server
python server/main.py

# Verify it's running
curl http://localhost:8000/health
```

---

## Files for Submission

| File | Purpose |
|------|---------|
| `sih2026-ps171-extension.zip` | Extension package |
| `docs/INSTALL.md` | Installation guide |
| `docs/DEMO.md` | Demo script |
| `docs/TEAM.md` | Team contributions |
| `README.md` | Project overview |

---

*Deployment completed as part of Issue #20*
