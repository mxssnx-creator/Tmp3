#!/bin/bash

# Verify that everything needed for automated live trading test is in place

echo "=========================================="
echo "Live Trading Test Setup Verification"
echo "=========================================="
echo ""

# Check files exist
echo "Checking required files..."
files=(
  "scripts/test-live-trading-auto.ts"
  "scripts/run-live-trading-test.sh"
  "LIVE_TRADING_AUTO_TEST_GUIDE.md"
  "START_LIVE_TRADING_TEST_HERE.md"
)

for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    echo "✓ $file"
  else
    echo "✗ $file (MISSING)"
  fi
done

echo ""
echo "Checking system status..."

# Check if dev server is running
if curl -s http://localhost:3000/api/main/system-stats-v3 > /dev/null 2>&1; then
  echo "✓ Dev server running on port 3000"
else
  echo "✗ Dev server not running (run 'npm run dev')"
fi

echo ""
echo "=========================================="
echo "Ready to run automated test:"
echo "=========================================="
echo ""
echo "  bash scripts/run-live-trading-test.sh"
echo ""
echo "Or manually:"
echo ""
echo "  npx tsx scripts/test-live-trading-auto.ts"
echo ""
echo "See START_LIVE_TRADING_TEST_HERE.md for details"
echo ""
