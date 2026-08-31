# SIH2026 PS171 Browser Agent — GitHub Pages Deployment

## Live Demo

**Mock Portal:** https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html

---

## How to Use for Competition

### 1. Open the Live Mock Portal
```
https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html
```

This works because GitHub Pages serves via `https://`, which allows content scripts to inject properly.

### 2. Load Extension in Chrome
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select: `dist/chrome-mv3/`

### 3. Start Local Server
Open a terminal and run:
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```

### 4. Test the Agent
1. Open the mock portal link above
2. Click extension icon
3. Enter task: "fill the form with test data"
4. Click "Start Agent"

---

## Why GitHub Pages?

| Method | Content Script Works? | Notes |
|--------|----------------------|-------|
| `file:///` | ❌ NO | Chrome blocks content scripts on local files |
| `http://localhost` | ✅ YES | Works, but need local server running |
| `https://github.io` | ✅ YES | Works, no local server needed for portal |

**Recommendation:** Use GitHub Pages for the demo portal, but still run the FastAPI server locally for the planning logic.

---

## Alternative: Local Server

If you prefer not to use GitHub Pages:

```bash
# Start local HTTP server
python -m http.server 8080

# Open in Chrome
http://localhost:8080/public/mock-form.html
```

---

## Files for Deployment

The following files are deployed to GitHub Pages:
- `docs/mock-form.html` — Mock enrollment form
- `docs/` — All documentation

---

## Troubleshooting

### Content Script Not Loading
- Make sure you're on HTTPS (not file://)
- Check Chrome DevTools → Console for errors
- Try hard refresh: Ctrl+Shift+R

### Server Connection Failed
- Verify server is running: `curl http://localhost:8000/health`
- Check manifest has correct host_permissions

### Extension Not Appearing
- Go to chrome://extensions/
- Click "Reload" on the extension
- Refresh the page

---

*Last updated: September 1, 2026*
