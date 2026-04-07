# Debug Preview and Quickstart Setup

## Quick Start Commands

### Option 1: Quickstart with Live Trading Enabled
```bash
npm run quickstart
```
This initializes CTS v3.2 with:
- Auto-connects to Redis/database
- Screens high volatility symbols automatically
- Pre-enables live trading for top 3 symbols
- Starts the dev server with normal logging
- Perfect for immediate live trading

### Option 2: Debug Quickstart (Verbose Logging)
```bash
npm run quickstart:debug
```
Same as quickstart but with full debug output showing:
- [v0] engine cycle tracking
- [v0] indication generation
- [v0] strategy processing
- [v0] live trade execution
- Performance metrics

### Option 3: Dev Preview with Debug Logging
```bash
npm run dev:debug
```
Starts normal development mode with comprehensive debug output:
- All engine cycle counters
- Indication processing logs
- Strategy evaluation metrics
- Real-time position tracking
- Market data flow

### Option 4: Verbose Debug (Most Detailed)
```bash
npm run dev:debug:verbose
```
Maximum verbosity - shows everything including:
- Full engine internals
- All debug modules active
- Performance measurements
- No Babel output to reduce noise

### Normal Development (No Debug)
```bash
npm run dev
```
Standard Next.js development server on port 3002.

## What Each Script Does

### quickstart-live-trading.js
- Starts Next.js dev server
- Sets live trading environment variables
- Waits for server to be ready (10-15 seconds)
- Screens for high volatility symbols
- Auto-enables live trading for top 3
- Provides startup instructions
- Prints direct links to dashboard and live trading

### dev-debug.js
- Starts Next.js with 15+ debug modules active
- Adds timestamps to all output
- Color-codes different log types
- Provides logging instructions
- Shows what to watch for in console
- Includes performance targets

## Debug Output Examples

When running `npm run dev:debug`, you'll see logs like:

```
[HH:MM:SS] [IndicationCycles] conn-1: cycleCount=10, attemptedCycles=10
[HH:MM:SS] [StrategyCycles] conn-1: cycleCount=10, evaluated=45
[HH:MM:SS] [RealtimeCycles] conn-1: cycleCount=10, duration=12ms
[HH:MM:SS] [v0] [RealtimeIndication] Generated 88 indications for 11 connections
[HH:MM:SS] [v0] [TradeExecution] Position opened: BTCUSDT LONG 0.001
```

## Live Trading URLs

After running quickstart or dev:debug, access:

- **Dashboard**: http://localhost:3002
  - Main system overview
  - Volatility screener with top 3 symbols
  - Live trading toggle buttons

- **Live Trading**: http://localhost:3002/live-trading
  - Real-time position list
  - P&L tracking
  - Position management controls

- **Settings**: http://localhost:3002/settings
  - Exchange connections
  - Strategy configuration
  - API settings

- **API Status**: http://localhost:3002/api/trade-engine/status
  - Engine metrics
  - Cycle counts
  - Performance stats

## Environment Variables Set by Scripts

### quickstart-live-trading.js
```
NEXT_PUBLIC_LIVE_TRADING_ENABLED=true
NEXT_PUBLIC_AUTO_START_ENGINE=true
NEXT_PUBLIC_AUTO_SCREEN_VOLATILITY=true
NEXT_PUBLIC_AUTO_ENABLE_LIVE_TRADING=true
DEBUG=engine:*,trade:*
```

### dev-debug.js
```
DEBUG=engine:*,trade-engine:*,engine-manager:*,indication:*,...
FORCE_COLOR=1
NODE_ENV=development
```

## Performance Targets

The system is optimized for these performance ranges:

- **Engine Cycle**: 800-1000ms (currently ~860ms)
- **Indication Generation**: <400ms
- **Strategy Processing**: <300ms
- **Realtime Updates**: <50ms
- **Dashboard Load**: <2s

When running `npm run dev:debug`, watch for these in the logs every 10 cycles.

## Troubleshooting Debug Output

### No [v0] logs appearing?
1. Make sure you're using `npm run dev:debug` not `npm run dev`
2. Open browser console (F12)
3. Look for console logs with [v0] prefix
4. Refresh the page

### Engine cycles stuck?
- Check `/api/trade-engine/status` endpoint
- Should show `cycleCount` incrementing
- If stuck at 0, engine may need restart

### Live trading not starting?
- Run `npm run quickstart` instead of `npm run dev`
- It will auto-enable top 3 volatile symbols
- Check `/live-trading` page

## Production Deployment

These scripts are development-only. For production:

```bash
npm run build        # Build production bundle
npm run start        # Run production server (no debug)
```

The production build strips all debug code and optimizes for performance.
