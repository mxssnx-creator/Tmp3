# Quick Start: Run Live Trading Test on BingX

## 30-Second Setup

### Prerequisites (One-Time Setup)
1. **Start Dev Server**
   ```bash
   npm run dev
   ```
   Keep this running in one terminal

2. **Configure BingX Connection** (if not done)
   - Open Dashboard
   - Go to Settings → Connections
   - Add BingX connection with API credentials
   - Enable connection
   - Enable live trading toggle

## Run the Test

### Single Command (Recommended)
```bash
bash scripts/run-live-trading-test.sh
```

### What Happens
- ✓ Finds your BingX connection
- ✓ Enables live trading mode
- ✓ Places 0.0001 BTC market order (≈$3)
- ✓ Monitors order fills
- ✓ Shows execution results

### Expected Duration
- **Total Time**: 5-30 seconds
- **Order Placement**: ~1 second
- **Fill Time**: 1-10 seconds (depends on market)

## Watch It Happen

### In Terminal
```
[2026-04-04T21:30:46.500Z] ✓ Trade executed successfully!
[2026-04-04T21:30:46.501Z] ✓   - Position ID: live:conn_xyz:BTC-USDT:long:1712282446500
[2026-04-04T21:30:46.503Z] ✓   - Entry Price: $43250.50
[2026-04-04T21:30:50.001Z] ✓ Position fully filled at $43250.75
```

### In Dashboard
- Dashboard → Active Connections
- Look for real-time position update
- See "Live Trading Active" badge turn green
- Watch position P&L calculate in real-time

## Test Results

After test completes, you'll see:
- ✓ Order ID from BingX
- ✓ Execution price
- ✓ Filled quantity
- ✓ Position status

## Next: View in Dashboard

1. Open Dashboard
2. Go to "Active Connections"
3. Look for the test position
4. See real-time P&L updates
5. Monitor fills in detail view

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "API server not running" | Run `npm run dev` first |
| "No active BingX connections" | Set up connection in Settings |
| "Trade execution failed" | Check API credentials |
| "Order doesn't fill" | Check market liquidity on BingX |

## Customize Test

Edit `scripts/test-live-trading-auto.ts`:
```typescript
testQuantity: 0.0001,  // Change amount here
testSymbol: "BTC-USDT", // Change pair here
timeoutMs: 60000,      // Change timeout here
```

## Full Documentation

- **Detailed Guide**: `LIVE_TRADING_AUTO_TEST_GUIDE.md`
- **System Status**: `LIVE_TRADING_STATUS_REPORT.md`
- **Trading Guide**: `LIVE_TRADING_GUIDE.md`

## Real Trade?

Yes! This places a REAL order on BingX with your account. The test uses:
- ✓ Your real API credentials
- ✓ Your real BingX account
- ✓ Real BTC amount (0.0001 = very small)
- ✓ Actual exchange execution

**Safety**: 0.0001 BTC is only ~$3, perfect for testing.

---

**Ready to test?** Run:
```bash
bash scripts/run-live-trading-test.sh
```
