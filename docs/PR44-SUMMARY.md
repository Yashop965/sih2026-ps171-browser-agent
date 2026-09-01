# PR #44 - Loop Detection & Dynamic Steps Summary

## Changes Merged to Main (Commits: f5596c9, f084214, 3e2927d)

### 1. Loop Detection (Popup.tsx)
- Added `recentActionHistory` array to track recent actions
- Detect when planner targets same element twice in a row
- Skip element and mark as filled to prevent infinite loops
- Logs warning when skipping repeated actions

### 2. Dynamic maxSteps (Popup.tsx)
- Calculate max steps based on found elements: `max(10, min(50, (inputs+selects)*3 + buttons + 5))`
- Prevents premature stopping on large forms
- Logs calculated steps for debugging

### 3. SELECT Action for Dropdowns (planner.py)
- Added `tag` and `type` fields to elements sent to planner
- Stronger instructions to use SELECT for dropdowns
- Added action examples (TYPE/SELECT/CLICK)
- Never TYPE into select/button/a elements

## Testing Results
- Build: 284KB
- Tests: 122/122 passing
- Manual testing on demo form shows improved behavior

## Related Issues
- Fixes infinite loop on element retry
- Improves form filling for pages with dropdowns
