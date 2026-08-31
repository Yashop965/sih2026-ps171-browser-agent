# SIH2026 PS171 — LIVE DEMO

## 🎯 Live Mock Portal

**URL:** https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html

---

## Quick Start for Competition

### 1. Open the Live Demo
Click here: https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html

This is a **live, publicly accessible** mock portal that simulates an Indian government Aadhaar enrollment form.

### 2. Load Extension
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select: `dist/chrome-mv3/`

### 3. Start Local Server
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```

### 4. Test the Agent
1. Open the live demo link above
2. Click the extension icon
3. Enter task: "fill the form with test data"
4. Click "Start Agent"
5. Watch it execute actions!

---

## Why This Works

| Before (file://) | After (GitHub Pages) |
|-----------------|---------------------|
| ❌ Content scripts blocked | ✅ Content scripts work |
| ❌ Chrome security restriction | ✅ HTTPS works properly |
| ❌ Local file protocol issues | ✅ Public URL accessible |

---

## What's On the Live Portal

The mock portal includes:
- ✅ Personal Information section (Name fields)
- ✅ Aadhaar Number input (with auto-formatting)
- ✅ PAN Number input
- ✅ Mobile Number input
- ✅ Email input
- ✅ Address fields
- ✅ Password fields (for PII detection testing)
- ✅ Form validation
- ✅ Privacy notice

---

## For Judges

You can share this URL with judges:
```
https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html
```

They can:
1. Open it in any browser
2. See the realistic government portal simulation
3. Watch your extension work in real-time
4. Verify PII detection on actual form fields

---

## Backup Options

If GitHub Pages is slow or unavailable:

### Option 1: Local Server
```bash
python -m http.server 8080
# Then open: http://localhost:8080/docs/mock-form.html
```

### Option 2: Use Original File
```
file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/mock-form.html
```
(Note: Content scripts may not inject on file://)

---

## Files Deployed

- `docs/mock-form.html` — Live mock portal
- `docs/GITHUB-PAGES.md` — Deployment documentation
- `docs/` folder contents

---

*Live demo updated: September 1, 2026*
