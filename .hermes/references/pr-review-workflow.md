# PR Review Workflow — SIH2026 PS171

## Critical: Verification Before Review

Always run these checks BEFORE reviewing PR code quality:

```bash
# 1. TypeScript compilation (BLOCKING)
npx tsc --noEmit

# 2. Run all tests
npm test

# 3. Build extension
npm run build

# 4. Check for duplicate source files
ls src/background/ 2>&1 || echo "No duplicate"
ls src/entrypoints/ 2>&1

# 5. Quick verification command
npx tsc --noEmit && npm test && npm run build && echo "ALL CHECKS PASSED"
```

## Common Blocking Issues

### TypeScript Errors (Priority 1)
- `Cannot find name 'browser'` → Check WXT entrypoint structure
- `Module has no exported member 'X'` → Type import path broken
- `Cannot find name '__SERVER_URL__'` → Missing env.d.ts or hardcoded URL

### Duplicate Source Files (Priority 1)
WXT only uses `src/entrypoints/`, NOT `src/background/`:
```
❌ WRONG: src/background/index.ts (ignored by WXT)
✅ RIGHT: src/entrypoints/background.ts
```

### Type Import Breaks
When renaming types (e.g., `PrivacyEvent` → `PrivacyLogEntry`):
1. Search ALL files for old name
2. Update imports in hooks/, lib/, components/
3. Run `npx tsc --noEmit` to verify

## PII Security Checklist

### UI Components (CRITICAL)
```typescript
// ❌ NEVER do this
detail: `${det.type}: ${det.value}`  // Leaks actual PII!

// ✅ ALWAYS do this  
detail: `${det.type} detected`  // Safe description only
```

### What to Check
1. Any `detail`, `message`, `text` fields showing raw values?
2. Console logs containing sensitive data?
3. Export functions including raw PII?
4. Error messages revealing PII?

### Privacy Ledger Requirements
- Show detection events WITHOUT raw values
- Provide SHA-256 signed export
- Strip query strings from URLs
- Never display password fields
- Show masked patterns only

## WXT Entrypoint Rules

### Correct Structure (Flat Only)
```
src/
└── entrypoints/
    ├── background.ts     # export default defineBackground({...})
    ├── content.ts        # export default defineContentScript({...})
    └── popup/
        ├── index.html
        └── main.tsx
```

### Wrong (Causes Build Failure)
```
src/
├── background/
│   └── index.ts          # ❌ WXT ignores this
├── entrypoints/
│   └── background.ts     # ✅ Only this is used
```

## Pydantic V2 Compatibility

FastAPI projects using Pydantic V2:
```python
# ❌ Deprecated
el.dict()

# ✅ Correct
el.model_dump()
```

## PR Size Guidelines

| PR Size | Review Time | Risk |
|---------|-------------|------|
| < 50 lines | 5 min | Low |
| 50-200 lines | 15 min | Medium |
| 200-500 lines | 30 min | High |
| > 500 lines | 60+ min | Very High |

**Recommendation:** Split large PRs into focused changes. PR #30 (19 lines) was reviewed in 5 minutes. PR #29 (1358 lines) required 45+ minutes.

## Review Command Reference

```bash
# View PR details
gh pr view 29 --json title,body,state,files

# Checkout PR locally
gh pr checkout 29

# View diff
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- <file>

# Request changes
gh pr review 29 --request-changes --body-file review.md

# Approve and merge
gh pr review 29 --approve
gh pr merge 29 --squash
```

## Lessons from August 31, 2026

1. **TypeScript first**: Build breaks are blocking — fix those before deep code review
2. **PII in UI is critical**: Even display-only leaks undermine the entire privacy proposition
3. **WXT structure is strict**: Don't create files outside `src/entrypoints/`
4. **Verify before merge**: Run full check suite, don't trust "tests pass" alone
5. **Small focused PRs are better**: Easier to review, merge, and revert if needed
