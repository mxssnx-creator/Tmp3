# Live Trading Quick Start

## What's Ready

✅ **Live Exchange Trading System** - Fully functional and integrated
✅ **Position Tracking** - Real-time monitoring of open positions  
✅ **Order Execution** - Real orders placed on exchange when enabled
✅ **Dashboard UI** - Live Trade toggle with visual indicators
✅ **API Endpoints** - Complete REST API for live trading control

## 3-Step Activation

### 1️⃣ Start Engine
```
Dashboard → Control Panel → Click "Start"
Wait for "Engine Running" status
```

### 2️⃣ Enable Connection
```
Dashboard → Active Connections
Find your connection card
Click "Enable" toggle → Status changes from "Off" to "Ready"
```

### 3️⃣ Enable Live Trading
```
Dashboard → Active Connections
Same connection card → Click "Live Trade" toggle
Status badge turns green → "Live" indicator appears
```

✅ **DONE** - Live trading is now active!

## See Positions Going Live

### Real-time on Dashboard
- Status badge shows: **"Live"** (green)
- Progress bar shows: **"Live Trading Active"**
- Positions appearing in real-time as trades execute

### Via API
```bash
# Get active positions
curl "http://localhost:3000/api/exchange-positions?connection_id=[CONNECTION_ID]"

# Get live trading status across all connections
curl "http://localhost:3000/api/settings/connections/live-trade-status"

# Get position details with P&L
curl "http://localhost:3000/api/positions?connection_id=[CONNECTION_ID]"
```

### Sample Response
```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC/USDT",
      "direction": "long",
      "quantity": 0.001,
      "entryPrice": 42500.5,
      "status": "open",
      "orderId": "exchange-order-12345",
      "exchangeData": {
        "markPrice": 42600.0,
        "unrealizedPnl": 99.5
      }
    }
  ]
}
```

## Key Components

| Component | Purpose |
|-----------|---------|
| **Live-Stage Engine** | Executes real orders on exchange |
| **Position Tracker** | Monitors fills and P&L |
| **Exchange Connector** | Communicates with exchange API |
| **Dashboard UI** | Visual toggle and monitoring |

## Verification Script

Run anytime to check system status:
```bash
node scripts/verify-live-trading.js
```

Shows:
- Engine running status
- Connections available  
- Live trades active
- Open positions
- Next steps if needed

## Requirements Met ✅

- ✅ `is_enabled=1` - Connection enabled
- ✅ `is_enabled_dashboard=1` - Connection active on dashboard
- ✅ `is_live_trade=1` - Live trading flag enabled
- ✅ Engine running - Global trade engine active
- ✅ API credentials - Valid exchange credentials

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Live Trade toggle disabled" | Start engine first (Control Panel → Start) |
| "No positions appearing" | Enable live trade + wait for strategy signals |
| "Orders not executing" | Check exchange API credentials in Settings |
| "Engine won't start" | Check server logs for errors |

## Full Documentation

See: **LIVE_TRADING_GUIDE.md** for:
- Detailed architecture
- API reference
- Advanced configuration
- Performance tuning
- Best practices

---

**Status**: ✅ Production Ready
**All systems**: ✅ Verified and Operational
**Ready to trade**: ✅ YES
