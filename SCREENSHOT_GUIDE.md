# Screenshot Capture Guide for SIH2026 PS171 Video

## Quick Method: Use Browser Tool

1. Open Chrome and navigate to each page
2. Use the browser tool to take screenshots
3. Save to `video_screenshots/` folder

## Pages to Capture:

### 1. Mock Form (Aadhaar Enrollment)
- URL: `file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/mock-form.html`
- Save as: `video_screenshots/mock_form.png`

### 2. PII Test Page
- URL: `file:///C:/Users/yashs/SIH2026/ps171-browser-agent/public/pii-test-page.html`
- Save as: `video_screenshots/pii_test_page.png`

### 3. Extension Popup (Optional)
- Load extension: `chrome://extensions` → Load unpacked `.wxt`
- Click extension icon
- Take screenshot of popup
- Save as: `video_screenshots/extension_popup.png`

### 4. Privacy Ledger (Optional)
- Navigate to a page with PII
- Click extension to see ledger
- Take screenshot
- Save as: `video_screenshots/privacy_ledger.png`

## Manual Screenshot Methods:

### Windows Built-in:
1. Press `Win + Shift + S` for snipping tool
2. Or `PrtScn` key for full screenshot
3. Paste into image editor and save

### Chrome DevTools:
1. Press `F12` to open DevTools
2. Right-click on page → "Save screenshot"

### Browser Extension:
Use extensions like "Full Page Screen Capture" for complete pages

## After Capturing Screenshots:

Run the video generation script:
```bash
python generate_video_with_screenshots.py
```

This will create: `SIH2026_PS171_With_Screenshots.mp4`
