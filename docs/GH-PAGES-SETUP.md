# GitHub Pages Setup Guide

## Status
The gh-pages branch has been created and pushed. GitHub Pages may take 2-5 minutes to activate.

---

## How to Enable GitHub Pages (If Not Already Active)

### Method 1: Via GitHub Website (Recommended)

1. Go to: https://github.com/Yashop965/sih2026-ps171-browser-agent/settings/pages
2. Under "Source", select: **Deploy from a branch**
3. Select branch: **gh-pages**
4. Select folder: **/ (root)**
5. Click **Save**
6. Wait 1-2 minutes for deployment

### Method 2: Via GitHub CLI

```bash
# Enable GitHub Pages
gh repo view Yashop965/sih2026-ps171-browser-agent --json url
```

Then visit the URL above and enable Pages from settings.

---

## After Enabling

Your live demo will be available at:
```
https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html
```

---

## What's Deployed

The `gh-pages` branch contains:
- `docs/mock-form.html` — Live mock portal
- `docs/GITHUB-PAGES.md` — Documentation
- `docs/LIVE-DEMO.md` — Live demo guide
- `docs/DEPLOYMENT.md` — Deployment guide

---

## Troubleshooting

### Site Shows 404
- Wait 2-5 minutes for GitHub to process
- Check branch is set to `gh-pages` in settings
- Verify `docs/.nojekyll` exists (disables Jekyll processing)

### Content Scripts Still Not Working
- Make sure you're on `https://` not `http://`
- GitHub Pages defaults to HTTPS
- Clear browser cache if needed

---

## Alternative: Use Netlify (Faster)

If GitHub Pages is slow:

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Deploy
netlify deploy --prod --dir=docs
```

This gives you instant deployment with HTTPS.

---

## For Competition Day

Have both options ready:
1. **Primary:** GitHub Pages (if enabled)
2. **Backup:** Local server (`python -m http.server 8080`)

Both work for content script injection!
