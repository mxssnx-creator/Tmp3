#!/bin/bash
set -e

echo ""
echo "=========================================="
echo "QUICKSTART: FULL PROGRESSION & LIVE TRADING"
echo "=========================================="
echo ""

# Check if dev server is running
echo "[1/5] Checking dev server..."
if ! curl -s http://localhost:3002 > /dev/null 2>&1; then
  echo "Error: Dev server not running at http://localhost:3002"
  echo "Please run 'npm run dev' first"
  exit 1
fi
echo "✓ Dev server running"

# Get active connections
echo ""
echo "[2/5] Fetching active connections..."
CONNECTIONS=$(curl -s http://localhost:3002/api/settings/connections?enabled=true)
CONN_COUNT=$(echo "$CONNECTIONS" | grep -o '"id"' | wc -l)
if [ "$CONN_COUNT" -eq 0 ]; then
  echo "Error: No active connections found"
  exit 1
fi
echo "✓ Found $CONN_COUNT active connections"

# Get first connection ID
CONN_ID=$(echo "$CONNECTIONS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Using connection: $CONN_ID"

# Check engine status
echo ""
echo "[3/5] Checking engine status..."
ENGINE_STATUS=$(curl -s http://localhost:3002/api/trade-engine/status)
echo "  Status: $(echo "$ENGINE_STATUS" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)"

# Enable live trading for connection
echo ""
echo "[4/5] Enabling live trading..."
curl -s -X POST http://localhost:3002/api/settings/connections/$CONN_ID/live-trade \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' > /dev/null
echo "✓ Live trading enabled"

# Start engine with full progression
echo ""
echo "[5/5] Starting engine with full progression..."
START_RESULT=$(curl -s -X POST http://localhost:3002/api/trade-engine/start \
  -H "Content-Type: application/json" \
  -d "{\"connectionId\": \"$CONN_ID\", \"autoScaleLeverage\": true}")

echo "✓ Engine started"
echo ""
echo "=========================================="
echo "QUICKSTART COMPLETE"
echo "=========================================="
echo ""
echo "Dashboard: http://localhost:3002"
echo "Connection: $CONN_ID"
echo ""
echo "Monitor in real-time:"
echo "- Engine Progression: 6-phase cycle"
echo "- Market Data: Loading & analyzing"
echo "- Indicators: MA/RSI/MACD/BB calculating"
echo "- Strategies: Evaluating all 4 base strategies"
echo "- Live Trading: Positions being created"
echo ""
echo "Watch for:"
echo "- Entry signals (LONG/SHORT)"
echo "- Position creation at market price"
echo "- P&L tracking in real-time"
echo "- TP/SL management"
echo ""
echo "The engine runs 1000ms cycles, continuously updating"
echo "Press Ctrl+C to stop monitoring"
