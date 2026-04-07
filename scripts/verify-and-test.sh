#!/bin/bash
set -e

echo ""
echo "============================================================================"
echo "COMPREHENSIVE TRADING SYSTEM VERIFICATION & TESTING"
echo "============================================================================"
echo ""

# Check if dev server is running
echo "1. Checking if dev server is running..."
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
  echo "   ✗ Dev server not running"
  echo "   Start it with: npm run dev"
  exit 1
fi
echo "   ✓ Dev server is running"
echo ""

# Run audit script
echo "2. Running comprehensive system audit..."
node scripts/comprehensive-audit.js
echo ""

# Check database connectivity
echo "3. Verifying database connectivity..."
if curl -s http://localhost:3000/api/settings/connections > /dev/null 2>&1; then
  echo "   ✓ Database connection verified"
else
  echo "   ✗ Database connection failed"
fi
echo ""

# Check exchange connectivity
echo "4. Checking exchange connections..."
CONNECTIONS=$(curl -s http://localhost:3000/api/settings/connections | jq '.connections | length' 2>/dev/null || echo "0")
echo "   Found $CONNECTIONS configured exchanges"
if [ "$CONNECTIONS" -gt 0 ]; then
  echo "   ✓ At least one exchange configured"
else
  echo "   ⚠ No exchanges configured yet - configure in dashboard"
fi
echo ""

# Check engine status
echo "5. Verifying engine status..."
ENGINE_STATUS=$(curl -s http://localhost:3000/api/main/status | jq '.engine_state' 2>/dev/null || echo "unknown")
echo "   Engine state: $ENGINE_STATUS"
echo ""

# Show next steps
echo "============================================================================"
echo "VERIFICATION COMPLETE"
echo "============================================================================"
echo ""
echo "Next Steps:"
echo ""
echo "1. View full audit report:"
echo "   cat SYSTEM_VERIFICATION_COMPLETE.md"
echo ""
echo "2. Configure exchange (if not done):"
echo "   - Open http://localhost:3000"
echo "   - Settings → Add Connection"
echo "   - Enter BingX/Bybit credentials"
echo ""
echo "3. Run live trading test:"
echo "   bash scripts/run-live-trading-test.sh"
echo ""
echo "4. Monitor dashboard:"
echo "   - http://localhost:3000"
echo "   - Watch Active Connections & Trading Statistics"
echo ""
echo "============================================================================"
echo ""
