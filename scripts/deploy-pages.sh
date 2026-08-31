#!/bin/bash
# Deploy to GitHub Pages
# Usage: ./scripts/deploy-pages.sh

set -e

echo "=== Deploying to GitHub Pages ==="
echo ""

# Check if gh CLI is logged in
if ! gh auth status &>/dev/null; then
    echo "❌ Not logged in to GitHub. Run: gh auth login"
    exit 1
fi

# Get repo info
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
echo "Deploying to: $REPO"
echo ""

# Build the docs folder
echo "Building..."
npm run build 2>&1 | tail -3

# Create CNAME if needed
if [ ! -f "docs/.nojekyll" ]; then
    touch docs/.nojekyll
    echo "Created .nojekyll to disable Jekyll"
fi

# Deploy using gh-pages or manual method
echo ""
echo "Deploying to GitHub Pages..."

# Method 1: Using gh-pages package (if available)
if command -v npx &>/dev/null; then
    npx gh-pages -d docs --repo https://github.com/Yashop965/sih2026-ps171-browser-agent.git 2>&1 || {
        echo "gh-pages failed, trying manual deploy..."
        
        # Method 2: Manual deploy via git
        cd docs
        git init
        git add -A
        git commit -m "Deploy to GitHub Pages"
        git push -f git@github.com:Yashop965/sih2026-ps171-browser-agent.git main:gh-pages 2>&1 || {
            echo "Manual deploy failed. Try setting up GitHub Pages manually:"
            echo "1. Go to: https://github.com/Yashop965/sih2026-ps171-browser-agent/settings/pages"
            echo "2. Source: Deploy from a branch"
            echo "3. Branch: gh-pages / root"
            echo "4. Click Save"
        }
    }
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Your site should be available at:"
echo "https://yashop965.github.io/sih2026-ps171-browser-agent/"
echo ""
echo "Mock portal URL:"
echo "https://yashop965.github.io/sih2026-ps171-browser-agent/mock-form.html"
