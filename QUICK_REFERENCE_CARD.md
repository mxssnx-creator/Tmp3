# Quick Command Reference

## Start Development

```bash
# Normal development (no debug)
npm run dev

# Development with debug logging
npm run dev:debug

# Development with maximum debug verbosity
npm run dev:debug:verbose

# Quickstart - Live trading ready in 15 seconds
npm run quickstart

# Quickstart with debug logging
npm run quickstart:debug
```

## Common URLs

| URL | Purpose |
|-----|---------|
| http://localhost:3002 | Dashboard & Volatility Screener |
| http://localhost:3002/live-trading | Live Position Monitoring |
| http://localhost:3002/settings | Exchange & Strategy Setup |
| http://localhost:3002/api/trade-engine/status | Engine Status API |

## Debug Output Indicators

Watch console for these [v0] logs:

```
[IndicationCycles]    → Indication generation cycles
[StrategyCycles]      → Strategy processing cycles
[RealtimeCycles]      → Live position update cycles
[TradeExecution]      → Position opens/closes
[RealtimeIndication]  → Indication generation
[StrategyEngine]      → Strategy evaluation
[VolatilityScreen]    → Symbol screening
```

## Performance Metrics

When running `npm run dev:debug`, logs show every 10 cycles:

```
Engine Cycle: ~860ms (target: 1000ms ±100ms) ✓
Indications:  ~380ms (target: <400ms)        ✓
Strategies:   ~290ms (target: <300ms)        ✓
```

## Live Trading Flow

1. **Start**: `npm run quickstart`
2. **Wait**: ~15 seconds for initialization
3. **Dashboard**: Opens http://localhost:3002
4. **Auto-Screen**: Finds top 3 volatile symbols
5. **Auto-Enable**: Enables live trading for those 3
6. **Monitor**: Open http://localhost:3002/live-trading
7. **Watch**: Console shows [v0] debug logs of live trades

## Cycle Counts (Should Increment)

In `/api/trade-engine/status` response, look for:
- `cycles_completed` - Should keep increasing
- `indication_cycle_count` - Should keep increasing  
- `strategy_cycle_count` - Should keep increasing
- `realtime_cycle_count` - Should keep increasing

If stuck at 0, engine may need restart via dashboard.

## Kill Development Server

```bash
# Ctrl+C in terminal

# Or kill the port:
fuser -k 3002/tcp
```

## Environment Setup

Scripts automatically set:
- `DEBUG=engine:*,trade:*,...` for dev:debug
- `NEXT_PUBLIC_LIVE_TRADING_ENABLED=true` for quickstart
- `FORCE_COLOR=1` for colored output
- `NODE_ENV=development`

## Documentation Files

- `DEBUG_AND_QUICKSTART_GUIDE.md` - Detailed guide
- `IMPLEMENTATION_COMPLETE.md` - Full implementation summary
- `QUICKSTART_GUIDE.md` - Quick start instructions
- `README.md` - Project overview
- `QUICK_REFERENCE.md` - This file!

---

**TL;DR**: Run `npm run quickstart` and go to http://localhost:3002/live-trading

All systems ready! 🚀
