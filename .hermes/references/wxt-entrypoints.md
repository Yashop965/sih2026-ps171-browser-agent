# WXT v0.19 Entrypoint Structure

## Correct Structure (Flat)

```
src/
├── entrypoints/
│   ├── background.ts      # export default defineBackground(...)
│   ├── content.ts         # export default defineContentScript(...)
│   └── popup/
│       ├── index.html     # Must reference ./main.tsx
│       └── main.tsx       # React entrypoint with ReactDOM.createRoot
```

## Common Mistake (Nested - WRONG)

```
src/
├── entrypoints/
│   ├── background/
│   │   └── main.ts        # WRONG - causes "No entrypoints found"
│   ├── content/
│   │   └── main.ts        # WRONG
│   └── popup/
│       └── main.tsx       # WRONG - HTML expects ./main.tsx relative
```

## Key Points

1. `background.ts` and `content.ts` must be direct children of `entrypoints/`
2. `popup/` needs both `index.html` AND `main.tsx` inside it
3. `index.html` must use `<script type="module" src="./main.tsx">`
4. All entrypoints must use `export default` with WXT decorators

## Build Verification

Always run `npm run build` after creating entrypoints to verify structure.

Example error if wrong:
```
ERROR  No entrypoints found in src/entrypoints
```

Example error if nested:
```
ERROR  [vite:build-html] Failed to resolve ./Popup.tsx from popup.html
```
