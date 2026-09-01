#!/bin/bash
# SIH2026 PS171 — Demo Environment Setup Script
# Run this to prepare everything for the demo

set -e

echo "=========================================="
echo "SIH2026 PS171 Browser Agent - Demo Setup"
echo "=========================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "Error: Node.js not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Error: npm not found"; exit 1; }
echo "✓ Node.js and npm available"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install --silent
echo "✓ Dependencies installed"

# Build extension
echo ""
echo "Building extension..."
npm run build
echo "✓ Extension built successfully"

# Verify build
if [ -d "dist/chrome-mv3" ]; then
    echo "✓ Chrome MV3 build verified"
else
    echo "✗ Chrome build missing"
    exit 1
fi

if [ -d "dist/firefox-mv2" ]; then
    echo "✓ Firefox MV2 build verified"
else
    echo "⚠ Firefox build not found (run: npx wxt build -b firefox)"
fi

# Run tests
echo ""
echo "Running tests..."
npm test
echo "✓ All tests passing"

# Start local server for demo
echo ""
echo "Starting local server..."
echo "Open http://localhost:8080/public/mock-form.html in your browser"
echo ""
echo "To load extension:"
echo "  1. Open chrome://extensions/"
echo "  2. Enable Developer mode"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: dist/chrome-mv3"
echo ""
echo "=========================================="
echo "Demo environment ready!"
echo "=========================================="
