# Automated Live Trading Test Guide

## Overview

This guide walks you through running an automated live trading test on BingX. The test will:

1. **Check Active Connections** - Find and use your BingX connection
2. **Enable Live Trading** - Activate live trading mode for the connection
3. **Generate Test Signal** - Create a buy signal for testing
4. **Execute Trade** - Place a small market order on BingX (0.0001 BTC)
5. **Monitor Position** - Track the order through fills and position updates
6. **Display Results** - Show execution price, fills, and P&L

## Prerequisites

### 1. Active BingX Connection

You must have a BingX connection configured with:
- Valid API Key
- Valid API Secret
- Contract Type: `usdt-perpetual` (USDT Futures) or `spot`
- Network: Mainnet (not testnet for real trading)

To check your connections:
```
Dashboard → Settings → Connections
```

### 2. Live Trading Enabled

The connection must have:
- `is_enabled = true` (connection active)
- `is_live_trade = true` (live trading mode on)

### 3. Running Dev Server

The API server must be running:
```bash
npm run dev
```

This starts the Next.js server on `http://localhost:3000`

## Running the Test

### Option 1: Using Shell Script (Easiest)

```bash
bash scripts/run-live-trading-test.sh
```

This will:
- Check if the API server is running
- Run the TypeScript test script
- Display real-time updates
- Show results

### Option 2: Direct TypeScript Execution

```bash
npx tsx scripts/test-live-trading-auto.ts
```

### Option 3: Build and Run

```bash
npm run build
node dist/scripts/test-live-trading-auto.js
```

## Test Configuration

Edit `scripts/test-live-trading-auto.ts` to customize:

```typescript
const TEST_CONFIG = {
  testSymbol: "BTC-USDT",      // BingX symbol (use - separator)
  testQuantity: 0.0001,        // Amount to trade (0.0001 BTC ≈ $3)
  testLeverage: 1,             // Leverage multiplier (1 = no leverage)
  timeoutMs: 60000,            // Max wait time for fills (ms)
}
```

### Test Amounts

- **0.0001 BTC** - ~$3 USD (Very safe, minimal cost)
- **0.001 BTC** - ~$30 USD (Safe test)
- **0.01 BTC** - ~$300 USD (Larger test)

**DO NOT** use large amounts for your first test!

## Expected Output

When running the test, you'll see output like:

```
[2026-04-04T21:30:45.123Z] ℹ️ ============================================================
[2026-04-04T21:30:45.124Z] ℹ️ AUTOMATED LIVE TRADING TEST - BingX
[2026-04-04T21:30:45.125Z] ℹ️ ============================================================
[2026-04-04T21:30:45.126Z] ℹ️ Fetching active connections...
[2026-04-04T21:30:45.500Z] ℹ️ Found 1 BingX connection(s)
[2026-04-04T21:30:45.501Z] ℹ️   - My Trading Account (conn_xyz): enabled=true, live_trade=true
[2026-04-04T21:30:45.502Z] ℹ️ Using connection: My Trading Account (conn_xyz)
[2026-04-04T21:30:45.503Z] ℹ️ Enabling live trading for connection conn_xyz...
[2026-04-04T21:30:46.000Z] ✓ Live trading enabled successfully
[2026-04-04T21:30:46.100Z] ℹ️ Executing test trade on BingX: BTC-USDT
[2026-04-04T21:30:46.101Z] ℹ️   - Quantity: 0.0001
[2026-04-04T21:30:46.102Z] ℹ️   - Leverage: 1x
[2026-04-04T21:30:46.500Z] ✓ Trade executed successfully!
[2026-04-04T21:30:46.501Z] ✓   - Position ID: live:conn_xyz:BTC-USDT:long:1712282446500
[2026-04-04T21:30:46.502Z] ✓   - Status: pending
[2026-04-04T21:30:46.503Z] ✓   - Entry Price: $43250.50
[2026-04-04T21:30:46.504Z] ℹ️ Monitoring position: live:conn_xyz:BTC-USDT:long:1712282446500...
[2026-04-04T21:30:48.000Z] ℹ️ Position status updated: open (filled: 0.00010000)
[2026-04-04T21:30:50.000Z] ℹ️ Position status updated: filled (filled: 0.00010000)
[2026-04-04T21:30:50.001Z] ✓ Position fully filled at $43250.75
[2026-04-04T21:30:50.002Z] ============================================================
[2026-04-04T21:30:50.003Z] ✓ TEST COMPLETED SUCCESSFULLY!
[2026-04-04T21:30:50.004Z] ✓ Final P&L: 0.0001 @ $43250.75
[2026-04-04T21:30:50.005Z] ============================================================
```

## Understanding the Test Flow

### 1. Fetch Connections
- Retrieves all active BingX connections
- Shows connection status and live trading mode

### 2. Enable Live Trading
- Activates live trading on the selected connection
- Sets `is_live_trade = true`

### 3. Create Signal (Optional)
- Generates a test trading signal
- Signal data includes symbol, action, confidence, indicators

### 4. Execute Trade
- Places a real market order on BingX
- Order type: IOC (Immediate or Cancel)
- Amount: 0.0001 BTC (configurable)
- Leverage: 1x (no leverage for safety)

### 5. Monitor Position
- Polls position updates every 2 seconds
- Tracks status transitions: pending → open → filled
- Waits up to 60 seconds for order fills
- Shows execution price and fees

### 6. Results
- Displays final position state
- Shows average execution price
- Confirms successful test or timeout

## Troubleshooting

### Error: "No active BingX connections found"
- **Solution**: Create a BingX connection in Settings first
- Go to: Settings → Connections → Add Connection

### Error: "API server not running on port 3000"
- **Solution**: Start the dev server
- Run: `npm run dev`

### Error: "Failed to enable live trading"
- **Solution**: Check connection is properly configured
- Verify API credentials are correct
- Check that connection status is "enabled"

### Position Not Filling
- **Causes**:
  - Market conditions (no liquidity at that price)
  - Network latency
  - Order too small for market
- **Solution**: 
  - Check BingX exchange directly for order status
  - Increase test quantity slightly
  - Check market spread on BingX

### Test Timeout After 60 Seconds
- Position may still be pending on exchange
- Check BingX account directly for order status
- You can manually cancel unfilled orders in BingX

## Production Use

After verifying the test works:

1. **Real Trading**: Modify test config to use real amounts
2. **Multiple Pairs**: Test with different trading pairs
3. **Automated**: Integrate into your trading strategy
4. **Monitoring**: Set up alerts for fills and position changes

## Safety Measures

The test script includes safety features:

- **Minimal Amount**: 0.0001 BTC (very small)
- **No Leverage**: 1x leverage only
- **Immediate Cancel**: IOC order type prevents stuck orders
- **Timeout**: Gives up after 60 seconds
- **Logging**: Complete audit trail of all actions

## Next Steps

1. Run the test: `bash scripts/run-live-trading-test.sh`
2. Verify order appears on BingX
3. Check position update in dashboard
4. Monitor P&L tracking
5. Scale up with confidence

## Support

For issues, check:
- `/vercel/share/v0-project/LIVE_TRADING_GUIDE.md` - Full trading guide
- `/vercel/share/v0-project/LIVE_TRADING_STATUS_REPORT.md` - System status
- API logs: `npm run dev` console output
- Dashboard: Real-time position monitoring

---

**Remember**: Always test with small amounts first!
