#!/bin/bash

# Automated Live Trading Test Runner
# Runs the TypeScript test script to execute live trades on BingX

set -e

echo "=========================================="
echo "LIVE TRADING TEST - BingX"
echo "=========================================="

# Check if dev server is running
echo "Checking if API server is running on port 3000..."
if ! curl -s http://localhost:3000/api/main/system-stats-v3 > /dev/null 2>&1; then
  echo "ERROR: API server not running on http://localhost:3000"
  echo "Please start the dev server first: npm run dev"
  exit 1
fi

echo "✓ API server is running"

# Run the test script
echo ""
echo "Running live trading test..."
echo ""

cd "$(dirname "$0")/.."

# Run with tsx if available, otherwise node
if command -v tsx &> /dev/null; then
  tsx scripts/test-live-trading-auto.ts
elif command -v npx &> /dev/null; then
  npx tsx scripts/test-live-trading-auto.ts
else
  echo "ERROR: tsx not found. Please install it with: npm install -g tsx"
  exit 1
fi

echo ""
echo "=========================================="
echo "Test completed!"
echo "=========================================="
