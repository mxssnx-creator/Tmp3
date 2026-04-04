# Live Exchange Trading Guide

## Overview

This system includes a **fully independent live trading engine** that mirrors pseudo positions to actual exchange positions and executes trades on the exchange in real-time. The system is designed to work autonomously while the main trade engine processes indications and strategies.

## Architecture

### Key Components

1. **Live-Stage Engine** (`lib/trade-engine/stages/live-stage.ts`)
   - Executes real positions on the exchange when `is_live_trade` is enabled
   - Tracks fills and order status from the exchange
   - Maintains separate live position objects with status tracking

2. **Trade Execution Orchestrator** (`lib/trade-execution-orchestrator.ts`)
   - Manages complete order flow from signal to execution
   - Handles buy/sell signals with retry logic
   - Validates progression limits and risk parameters

3. **API Endpoints**
   - `POST /api/settings/connections/[id]/live-trade` - Toggle live trading for a connection
   - `GET /api/settings/connections/live-trade-status` - Check live trading status across all connections
   - `GET /api/exchange-positions` - Get active positions on exchange
   - `GET /api/positions` - Get positions with filtering

4. **Dashboard UI** (`components/dashboard/active-connection-card.tsx`)
   - Live Trade toggle switch (requires Enable and Global Engine running)
   - Real-time progression tracking
   - Visual status indicators

## How to Enable Live Trading

### Step 1: Start the Global Trade Engine

The Global Trade Engine must be running first. This initializes the system and processes market data.

```
On Dashboard:
→ Click the "Start" button in the control panel
→ Wait for "Engine Running" status
```

### Step 2: Enable a Connection

Each connection must be enabled on the dashboard before trading.

```
On Dashboard → Active Connections Card:
→ Click the "Enable" toggle next to the connection name
→ Wait for status to change from "Off" to "Ready"
```

### Step 3: Enable Live Trading

Once the connection is enabled and the engine is running, enable live trading:

```
On Dashboard → Active Connections Card:
→ Click the "Live Trade" toggle
→ The toggle will turn green when active
→ Status badge will change to "Live"
```

### API Method (Alternative)

```bash
curl -X POST http://localhost:3000/api/settings/connections/[CONNECTION_ID]/live-trade \
  -H "Content-Type: application/json" \
  -d '{"is_live_trade": true}'
```

Response:
```json
{
  "success": true,
  "is_live_trade": true,
  "engineStatus": "running",
  "message": "Live Trading enabled (starting real exchange trading...)",
  "connectionName": "BingX Testnet",
  "exchange": "bingx"
}
```

## Verification

### Check Live Trading Status

```bash
curl http://localhost:3000/api/settings/connections/live-trade-status
```

Response shows all connections with live trading status:
```json
{
  "success": true,
  "total": 5,
  "live_trading_active": 2,
  "active_live_trading": [
    {
      "connectionId": "bingx-1",
      "name": "BingX Live",
      "exchange": "bingx",
      "is_live_trade": true,
      "is_enabled": true,
      "is_enabled_dashboard": true
    }
  ]
}
```

### Get Current Positions

```bash
curl "http://localhost:3000/api/exchange-positions?connection_id=bingx-1"
```

Response shows live positions on the exchange:
```json
{
  "success": true,
  "data": [
    {
      "id": "live:bingx-1:BTC/USDT:long:1712275200000",
      "connectionId": "bingx-1",
      "symbol": "BTC/USDT",
      "direction": "long",
      "quantity": 0.001,
      "executedQuantity": 0.001,
      "entryPrice": 42500.5,
      "averageExecutionPrice": 42500.5,
      "status": "open",
      "leverage": 5,
      "orderId": "bingx-order-12345",
      "exchangeData": {
        "marginType": "cross",
        "markPrice": 42600.0,
        "unrealizedPnl": 99.5
      }
    }
  ]
}
```

## System Flow

### Signal Generation to Live Execution

```
1. Indication Processor
   ↓ (Calculate technical indicators)
   
2. Strategy Processor
   ↓ (Generate buy/sell signals)
   
3. Real Position Manager
   ↓ (Create pseudo positions with entry prices)
   
4. Live Stage Engine
   ├─ Check: is_live_trade enabled? 
   │  ├─ YES: Execute on exchange
   │  └─ NO: Track as simulated
   ↓
5. Order Placement
   ├─ Place market order
   ├─ Get order ID from exchange
   └─ Track fills
   ↓
6. Position Tracking
   ├─ Monitor entry price vs market price
   ├─ Track unrealized P&L
   └─ Monitor stop loss / take profit
```

## Critical Flags

### Connection Flags

| Flag | Type | Purpose |
|------|------|---------|
| `is_enabled` | boolean | Connection enabled in Settings |
| `is_enabled_dashboard` | boolean | Connection active on Dashboard |
| `is_live_trade` | boolean | Live trading enabled (REAL EXCHANGE TRADING) |
| `is_preset_trade` | boolean | Preset mode enabled |

### Requirements for Live Trading

✅ **All must be true:**
- Global Trade Engine is running
- Connection is enabled (`is_enabled=1`)
- Connection is active on dashboard (`is_enabled_dashboard=1`)
- Live trade flag is enabled (`is_live_trade=1`)
- API credentials are valid (injected or stored)

❌ **If any fail:**
- Live trading automatically falls back to simulation mode
- Positions are tracked but NOT executed on exchange
- Check logs for error messages

## Simulation vs Live Mode

### Simulation Mode (is_live_trade = false)
- Pseudo positions are calculated based on strategy signals
- Entry/exit prices are simulated using last market price
- No actual orders placed on exchange
- No real fees deducted
- Status: `"simulated"`

### Live Mode (is_live_trade = true)
- Real orders placed on exchange
- Actual fills retrieved from exchange
- Real fees charged by exchange
- Real P&L tracking
- Status: `"pending"` → `"open"` → `"filled"` / `"closed"`

## Position Lifecycle

### Live Position States

```
pending
  ↓
open (Order filled, position active)
  ↓
partially_filled (Partially filled, waiting for more fills)
  ↓
filled (Fully filled, waiting for exit signal)
  ↓
closed (Position closed, P&L realized)

OR

error (Exception during execution)
simulated (Live trading disabled)
```

## Monitoring Live Trades

### Dashboard Display
- **Status Badge**: Shows "Live" when active, "Ready" when configured but not running
- **Progress Bar**: Shows system processing stages
- **Phase Info**: Displays current engine phase and message
- **Error Section**: Shows any errors in red

### API Monitoring

```bash
# Get engine logs with live trading events
curl "http://localhost:3000/api/engine-logs?connectionId=bingx-1"

# Get progression state
curl "http://localhost:3000/api/connections/progression/bingx-1"

# Get all active positions
curl "http://localhost:3000/api/exchange-positions?connection_id=bingx-1"
```

### Console Logging

Watch server logs for live trade execution:
```
[v0] [LivePositionStage] BTC/USDT: live_trade enabled=true
[v0] [LivePositionStage] EXECUTING REAL: BTC/USDT long qty=0.0010 on EXCHANGE
[v0] [LivePositionStage] Order placed on exchange: bingx-order-12345 for BTC/USDT
```

## Troubleshooting

### Live Trading Not Starting

**Problem**: Toggle is disabled or doesn't respond

**Checks**:
1. ✓ Global engine running? Check engine status in Dashboard
2. ✓ Connection enabled? Toggle "Enable" switch first
3. ✓ API credentials valid? Check in Connection Settings
4. ✓ No errors? Check server logs for API errors

### Positions Not Appearing

**Problem**: No positions showing in `/api/exchange-positions`

**Checks**:
1. ✓ Live trading enabled? Check toggle is ON
2. ✓ Strategies generating signals? Check indication processor
3. ✓ Real positions created? Check Real Stage logs
4. ✓ Exchange orders placed? Check exchange order history

### Orders Not Executing

**Problem**: Positions marked as "simulated" instead of "open"

**Likely**: `is_live_trade` flag is false or API credentials are invalid

**Solution**:
```bash
# Check current state
curl "http://localhost:3000/api/settings/connections/[id]"

# Re-enable if needed
curl -X POST "http://localhost:3000/api/settings/connections/[id]/live-trade" \
  -H "Content-Type: application/json" \
  -d '{"is_live_trade": true}'
```

### Engine Status Issues

**Problem**: "Engine not running" error

**Solution**: Start the engine from Dashboard or API:
```bash
curl -X POST "http://localhost:3000/api/engine/startup"
```

## Performance Considerations

### Order Execution Time
- Market orders typically execute within 100-500ms
- Limit orders depend on market liquidity

### Position Tracking
- Live positions updated every 0.2 seconds (default)
- Exchange position data fetched every 1-5 seconds
- P&L recalculated in real-time

### Resource Usage
- ~50MB Redis per 100 active positions
- Network requests: ~1-2 API calls per second per connection
- CPU: Minimal (event-driven architecture)

## Best Practices

1. **Test First**: Enable connection on dashboard first without live trading
2. **Monitor Closely**: Watch progression and P&L during initial trades
3. **Start Small**: Test with minimal position sizes before scaling
4. **Check Logs**: Review engine logs for any warnings or errors
5. **Backup Strategy**: Keep manual trading capability as fallback

## FAQ

**Q: Can I toggle live trading while engine is running?**
A: Yes, toggle can be changed at any time. Engine will restart with new setting.

**Q: What happens if API connection drops?**
A: Orders already placed remain active. New orders blocked until connection restored.

**Q: Are trades reversible if something goes wrong?**
A: Trades execute immediately. You must manually close positions on the exchange if needed.

**Q: Can I run multiple live connections?**
A: Yes, enable multiple connections independently. Each has its own live trading engine.

**Q: What's the minimum order size?**
A: Depends on exchange. BingX typically requires $10-100 USDT minimum.

---

**Status**: ✅ Live Trading System Complete and Ready
**Last Updated**: 2026-04-04
