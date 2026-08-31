# Content Script Troubleshooting

## Problem: "Could not establish connection. Receiving end does not exist"

This means the content script is NOT running on the page. Here's how to fix it:

---

## Solution 1: Use HTTPS (Recommended for GitHub Pages)

**Problem:** Content scripts don't work on `file://` protocol in Chrome.

**Fix:** Use the live GitHub Pages URL:
```
https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html
```

NOT:
```
file:///C:/Users/yashs/.../mock-form.html  ❌ WRONG
```

---

## Solution 2: Reload Extension Properly

1. Go to `chrome://extensions/`
2. Find "SIH2026 PS171 Browser Agent"
3. Click the **Reload** button (circular arrow) ⏎
4. Go back to the mock portal tab
5. **Hard refresh:** Press `Ctrl+Shift+R`
6. Try again

---

## Solution 3: Check Content Script is Loaded

1. Right-click on the mock portal page
2. Select **"Inspect"** to open DevTools
3. Go to **Console** tab
4. Look for this message:
   ```
   [agent] content script loaded on https://...
   ```
5. If you DON'T see it, the content script didn't inject

---

## Solution 4: Verify Extension Permissions

1. Go to `chrome://extensions/`
2. Click **"Details"** on the extension
3. Scroll to **"Site access"**
4. Make sure it's set to **"On all sites"** (not "On click" or "On specific sites")

---

## Solution 5: Use Local HTTP Server (Alternative)

If GitHub Pages doesn't work:

```bash
# Terminal 1: Start mock portal server
cd C:/Users/yashs/SIH2026/ps171-browser-agent
python -m http.server 8080

# Then open in Chrome:
http://localhost:8080/docs/mock-form.html
```

Content scripts work on `http://localhost` but NOT on `file://`.

---

## Quick Checklist

- [ ] Using `https://` or `http://` (NOT `file://`)
- [ ] Extension reloaded in chrome://extensions/
- [ ] Page hard refreshed (Ctrl+Shift+R)
- [ ] Console shows "[agent] content script loaded"
- [ ] Site access set to "On all sites"

---

## Test Content Script Manually

Open DevTools Console on the mock portal page and type:

```javascript
// Test if content script is running
browser.runtime.sendMessage({type: 'PING'}).then(r => console.log('Content script responding:', r));
```

If you get a response, the content script is working!

If you get an error, the content script is NOT loaded on the page.

---

## Most Common Fix

**Just use the HTTPS URL:**
```
https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html
```

Then reload the extension and hard-refresh the page.

This should fix the "Receiving end does not exist" error.
