# gh CLI Commands Reference

## PR Comment (NOT review --comment)

WRONG (fails):
```bash
gh pr review 25 --repo owner/repo --comment "Fixed issues"
# Error: accepts at most 1 arg(s), received 2
```

CORRECT:
```bash
gh pr comment 25 --repo owner/repo --body "Fixed issues"
```

## Requesting Copilot Review

Copilot auto-reviews when PR is pushed. No manual command needed.

To check review status:
```bash
gh pr view 25 --repo owner/repo --json reviews
```

## Merge Command

```bash
gh pr merge 25 --repo owner/repo --squash --delete-branch
```

## Branch Operations

```bash
# Create from main
git checkout main && git pull origin main
git checkout -b feature/issue-description

# Push
git push -u origin feature/issue-description

# Check status
git status --short
```
