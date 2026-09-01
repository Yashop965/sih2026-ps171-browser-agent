# Firefox Compatibility Guide

**Project:** SIH2026 PS171 Browser Agent
**Date:** 2026-08-30

## Build Commands

```bash
# Chrome (default)
npm run build

# Firefox
npx wxt build -b firefox

# Both
npm run build && npx wxt build -b firefox
```

## Key Differences from Chrome

| Aspect | Chrome MV3 | Firefox MV2 |
|--------|-----------|-------------|
| Manifest | V3 | V2 |
| Storage API | `chrome.storage` | `browser.storage` |
| WebExtensions | Limited | Full support |
| WebGPU | Native | Experimental |

## Fixes Applied

### 1. Storage API
```typescript
// BEFORE (Chrome-only)
await chrome.storage.sync.set({ key: value });

// AFTER (Cross-browser)
import { browser } from 'wxt/browser';
await browser.storage.sync.set({ key: value });
```

### 2. Config Updates
```typescript
// wxt.config.ts
export default defineConfig({
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
    firefoxArgs: [],  // Add this for Firefox
  },
});
```

### 3. Removed Chrome-specific APIs
- No `chrome://` URLs in content
- No Chrome DevTools Protocol usage
- Use `browser.*` from `wxt/browser`

## Testing

### Build Verification
```bash
ls dist/
# Should show:
# ├── chrome-mv3/
# └── firefox-mv2/
```

### Manual Testing
1. Load unpacked extension in Firefox
2. Navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `dist/firefox-mv2/manifest.json`

## Known Limitations

1. **WebGPU**: Firefox has WebGPU behind flags (`about:config` → `dom.webgpu.enabled`)
2. **WASM Fallback**: Ensure WASM path works when WebGPU unavailable
3. **Content Scripts**: Firefox may have different injection timing

## Size Comparison

| Browser | Size |
|---------|------|
| Chrome MV3 | 251.97KB |
| Firefox MV2 | 251.96KB |

Diff: Negligible (~10 bytes)
