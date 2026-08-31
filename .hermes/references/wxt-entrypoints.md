# WXT v0.19+ Entrypoint Structure

## Critical Rule
WXT v0.19+ REQUIRES flat entrypoint structure. Nested directories will FAIL.

## Correct Structure
```
src/
└── entrypoints/
    ├── background.ts          # Must export default defineBackground({...})
    ├── content.ts             # Must export default defineContentScript({...})
    └── popup/
        ├── index.html         # References ./main.tsx
        └── main.tsx           # React entrypoint
```

## Wrong Structures (Will Fail)

### Nested Entrypoints ❌
```
src/
└── entrypoints/
    └── background/
        └── main.ts            # ERROR: WXT won't find this
```

### Duplicate Source Files ❌
```
src/
├── background/
│   └── index.ts               # ERROR: Not used by WXT
└── entrypoints/
    └── background.ts          # Only this is used
```

## Common Errors and Fixes

### Error: "No entrypoints found"
**Cause**: Entrypoints in wrong location or nested structure
**Fix**: Move to `src/entrypoints/*.ts` (flat, not nested)

### Error: "Cannot find name 'browser'"
**Cause**: Missing WXT types or wrong entrypoint file
**Fix**: Ensure file is at `src/entrypoints/background.ts` with:
```typescript
import { defineBackground } from 'wxt/sandbox';
export default defineBackground({ main() { ... } });
```

### Error: "Duplicate export"
**Cause**: Same module exported from multiple files
**Fix**: Remove duplicates, keep only `src/entrypoints/` versions

## WXT Configuration
```typescript
// wxt.config.ts
export default defineConfig({
  browserify: {
    // Optional: configure browserify if needed
  },
  runner: {
    chromiumArgs: ['--enable-unsafe-webgpu'],
    firefoxArgs: [],
  },
  // No need to specify entrypoints — WXT auto-discovers src/entrypoints/*
});
```

## Build Commands
```bash
# Chrome MV3
npm run build

# Firefox MV2  
npx wxt build -b firefox

# Both
npm run build && npx wxt build -b firefox
```

## Verification
```bash
# Check entrypoint structure
ls src/entrypoints/

# Build and verify output
npm run build
ls dist/chrome-mv3/
```
