# Troubleshooting Guide — Extension Not Working

## Error: "Could not establish connection. Receiving end does not exist"

This means the content script is not running on the page. The popup can't send messages to it.

### Quick Fix (Do These Steps)

1. **Reload the extension:**
   - Go to `chrome://extensions/`
   - Find "SIH2026 PS171 Browser Agent"
   - Click the **"Reload"** button (circular arrow icon)

2. **Refresh the page:**
   - Go back to the mock portal tab
   - Press `Ctrl+Shift+R` (hard refresh)
   - OR close and reopen the tab

3. **Try again:**
   - Click extension icon
   - Enter task and click "Start Agent"

---

## If Still Not Working

### Check Content Script is Loaded
1. Right-click on the mock portal page
2. Select "Inspect" to open DevTools
3. Go to "Console" tab
4. Look for: `[agent] content script loaded on ...`
5. If you don't see it, the content script didn't inject

### Manual Content Script Injection (Debug)
In DevTools Console, type:
```javascript
// Check if content script is running
console.log('Content script running:', typeof browser !== 'undefined');

// Try sending a test message
browser.runtime.sendMessage({type: 'PING'}).then(r => console.log('Response:', r));
```

### Check Extension Permissions
1. Go to `chrome://extensions/`
2. Click "Details" on the extension
3. Make sure "Allowed on file://" is enabled (if testing local files)
4. Or use a local server instead

---

## Better: Use Local Server

Instead of `file:///` protocol, run a local server:

```bash
# From project root
python -m http.server 8080
```

Then open: `http://localhost:8080/public/mock-form.html`

Content scripts work better with `http://` than `file:///`

---

## Verify Server is Running

```bash
# Check if server responds
curl http://localhost:8000/health

# Should return:
# {"status":"healthy","version":"1.0.0",...}
```

If not running:
```bash
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```

---

## Check Ollama

```bash
# Is Ollama running?
ollama list

# Test model
ollama run qwen2.5:1.5b "Hello"
```

If not running:
```bash
ollama serve
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Didn't reload extension after build | Go to chrome://extensions/ and click Reload |
| Testing with file:/// protocol | Use localhost server instead |
| Server not running | Start with `python -m uvicorn server.main:app` |
| Ollama not running | Start with `ollama serve` |
| Wrong tab selected | Make sure mock portal tab is active |

---

## Step-by-Step Working Flow

1. **Terminal 1:** Start Ollama
   ```bash
   ollama serve
   ```

2. **Terminal 2:** Start server
   ```bash
   python -m uvicorn server.main:app --host 0.0.0.0 --port 8000
   ```

3. **Terminal 3:** Start local server (optional but recommended)
   ```bash
   python -m http.server 8080
   ```

4. **Chrome:** Load extension
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select: `dist/chrome-mv3/`

5. **Chrome:** Open mock portal
   - Go to: `http://localhost:8080/public/mock-form.html`

6. **Test:**
   - Click extension icon
   - Enter task: "fill the form with test data"
   - Click "Start Agent"
   - Watch logs in popup

---

## Still Having Issues?

Check these files:
- `dist/chrome-mv3/manifest.json` — should have content_scripts
- `dist/chrome-mv3/content-scripts/content.js` — should exist
- Browser console — look for errors
- Network tab — check if /plan endpoint is called
