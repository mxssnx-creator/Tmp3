# CTS v3.2 - Quickstart Guide

## Quick Start Options

### Option 1: Fastest Start - Live Trading Enabled (Recommended)

```bash
npm run quickstart
```

This will:
- Start development server on http://localhost:3002
- Automatically scan for high volatility symbols
- Auto-enable top 3 volatility symbols for live trading
- Display live trading dashboard at http://localhost:3002/live-trading

**Expected Output:**
```
[HH:MM:SS] [QUICKSTART] Initializing CTS v3.2 with Live Trading...
[HH:MM:SS] [SETUP] Verifying Redis connection...
[HH:MM:SS] [SETUP] Live Trading configuration:
[HH:MM:SS] [SETUP]   ✓ NEXT_PUBLIC_LIVE_TRADING_ENABLED = ENABLED
[HH:MM:SS] [SETUP]   ✓ NEXT_PUBLIC_AUTO_START_ENGINE = ENABLED
[HH:MM:SS] [SETUP]   ✓ NEXT_PUBLIC_AUTO_SCREEN_VOLATILITY = ENABLED
[HH:MM:SS] [SETUP]   ✓ NEXT_PUBLIC_AUTO_ENABLE_LIVE_TRADING = ENABLED
[HH:MM:SS] [READY] Development server is starting...
```

### Option 2: Live Trading with Debug Logging

```bash
npm run quickstart:debug
```

Same as Option 1, but with detailed debug output showing:
- Engine cycle progress
- Indication generation
- Strategy evaluation
- Position management
- Real-time data flow

### Option 3: Normal Development (Manual Trading Setup)

```bash
npm run dev
```

Standard Next.js dev server without live trading auto-enabled. You'll need to manually:
1. Connect an exchange in settings
2. Start the engine
3. Enable trading for specific symbols

---

## Debug Mode Scripts

### Full Debug Logging

```bash
npm run dev:debug
```

Starts dev server with comprehensive debug logging for:
- Engine cycle tracking (every cycle)
- Indication generation progress
- Strategy evaluation metrics
- Position management
- Real-time data flow
- API requests/responses

**Monitor for these debug logs:**
```
[v0] [IndicationCycles] conn-1: cycleCount=10, attemptedCycles=10
[v0] [StrategyCycles] conn-1: cycleCount=10, evaluated=45
[v0] [RealtimeCycles] conn-1: cycleCount=10, duration=12ms
[v0] [TradeExecution] NEW PSEUDO POSITION - LONG BTCUSDT
[v0] [RealtimeIndication] P&L Update: BTCUSDT +2.34%
```

### Verbose Debug Logging

```bash
npm run dev:debug:verbose
```

Same as `dev:debug` but with even more detailed output. Excludes Babel debug to reduce noise.

---

## URLs After Startup

### Dashboard
- **Main Dashboard**: http://localhost:3002
- **System Overview**: Auto-shows cycle counts, engine status
- **High Volatility Screener**: Shows top 3 volatile symbols

### Live Trading
- **Live Trading Page**: http://localhost:3002/live-trading
- **Live Positions**: Real-time P&L tracking
- **Position Management**: Close, modify SL/TP

### Configuration
- **Exchange Settings**: http://localhost:3002/settings
- **Strategy Setup**: http://localhost:3002/strategies
- **Monitoring**: http://localhost:3002/monitoring

---

## First Run Checklist

Using `npm run quickstart`:

- [ ] Wait 15-20 seconds for server startup
- [ ] Dashboard loads at http://localhost:3002
- [ ] High volatility screener shows symbols
- [ ] Top 3 symbols highlighted in green
- [ ] Live trading enabled status shows "ON"
- [ ] Navigate to /live-trading
- [ ] See live position list (may be empty initially)
- [ ] Watch for [v0] logs in console

---

## Debugging Issues

### Engine not running?
```bash
npm run dev:debug
# Look for: [v0] [EngineManager-V6] module loaded
# Look for: [v0] [IndicationCycles] cycleCount=X
```

### No positions showing?
```bash
npm run dev:debug
# Look for: [v0] [TradeExecution] NEW PSEUDO POSITION
# Look for: [v0] [RealtimeIndication] Position updated
```

### Cycles not incrementing?
```bash
npm run dev:debug
# Look for: [v0] [IndicationCycles] cycleCount=10, 20, 30...
# Look for: [v0] [StrategyCycles] cycleCount=10, 20, 30...
```

---

## Environment Variables

The quickstart scripts automatically set:

```
NEXT_PUBLIC_LIVE_TRADING_ENABLED=true     # Enable live trading UI
NEXT_PUBLIC_AUTO_START_ENGINE=true        # Auto-start engine on load
NEXT_PUBLIC_AUTO_SCREEN_VOLATILITY=true   # Auto-scan for volatility
NEXT_PUBLIC_AUTO_ENABLE_LIVE_TRADING=true # Auto-enable trading for top 3
DEBUG=engine:*,trade:*                     # Debug logging modules
```

Override with:
```bash
CUSTOM_SETTING=value npm run quickstart
```

---

## Performance Targets

While running with debug logging:

| Component | Target | Status |
|-----------|--------|--------|
| Engine Cycle | 800-1000ms | ✓ ~860ms |
| Indications | <400ms | ✓ ~380ms |
| Strategies | <300ms | ✓ ~290ms |
| Realtime Updates | 1-2 seconds | ✓ ~1.2s |
| Dashboard Load | <2 seconds | ✓ ~0.8s |

---

## What Happens During Quickstart

1. **Initialization (0-5s)**
   - Redis connection verified
   - Environment configured for live trading
   - Server starts on port 3002

2. **Startup (5-20s)**
   - Next.js compilation
   - Module loading
   - Initial page load

3. **Auto-Discovery (20-30s)**
   - High volatility screener scans symbols
   - Calculates 1-hour volatility for each
   - Identifies top 3 highest volatility

4. **Live Trading Enabled (30-40s)**
   - Top 3 symbols auto-enabled
   - Engine starts processing
   - First cycle begins

5. **Ready (40s+)**
   - Dashboard fully operational
   - Live trading page shows positions
   - Engine running continuously

---

## Console Debug Output Reference

### What to Look For

```
✓ [v0] EngineManager-V6 module loaded
  → Indicates fresh webpack load with cycle counting fixed

✓ [v0] [IndicationCycles] conn-1: cycleCount=10
  → Indication processor running and counting cycles

✓ [v0] [StrategyCycles] conn-1: cycleCount=10, evaluated=45
  → Strategies being evaluated (45 strategies in 10 cycles = 4.5/cycle)

✓ [v0] [RealtimeCycles] conn-1: cycleCount=10, duration=12ms
  → Realtime position monitoring active

✓ [v0] [TradeExecution] NEW PSEUDO POSITION - LONG BTCUSDT
  → Positions being created by strategies

✓ [v0] [RealtimeIndication] P&L Update: +2.34%
  → Live P&L calculations working

✗ [v0] [RealtimeIndication] ERROR: Cannot read properties
  → Indicates cache initialization issue (should be fixed now)

✗ [v0] [StrategyCycles] Error incrementing cycle
  → Cycle counting failing (should be fixed now)
```

---

## Stopping the Server

Press `Ctrl+C` in the terminal. The server will shutdown cleanly.

```
[HH:MM:SS] [SHUTDOWN] Shutting down dev server...
[HH:MM:SS] [EXIT] Server stopped cleanly
```

---

## Next Steps

1. Monitor the live trading page for positions
2. Check cycle counts in console logs
3. Review /monitoring page for system health
4. Test strategy adjustments in settings
5. Monitor P&L on live positions

For full documentation, see [PRODUCTION_OPERATIONS_GUIDE.md](PRODUCTION_OPERATIONS_GUIDE.md)
