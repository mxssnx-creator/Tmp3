#!/usr/bin/env node

/**
 * System Progression Test Guide
 * Tests the entire trading system through the 6-phase progression in order
 */

# System Progression Test Guide

## Overview

This guide explains how to run the **complete system progression test** which validates your trading system through all 6 phases:

1. **Initializing** (5%) - Engine components setup
2. **Market Data** (8%) - Load market data for trading symbols
3. **Prehistoric Data** (15%) - Load historical data in background
4. **Indications** (60%) - Calculate technical indicators
5. **Strategies** (75%) - Evaluate trading strategies
6. **Live/Real Stage** (100%) - Execute live orders on BingX

---

## Quick Start

### Option 1: Complete System Test (Recommended)
```bash
npx ts-node scripts/test-system-complete.ts
```

This runs the **full progression + live trading test** in one command:
- Verifies API server
- Checks BingX connection credentials
- Starts engine and monitors all 6 phases
- Enables live trading
- Checks active positions
- Displays final system status

**Duration**: ~60 seconds
**Output**: Real-time progress through each phase

### Option 2: Detailed Progression Test
```bash
npx ts-node scripts/test-system-progression.ts
```

Runs detailed testing for each phase individually with:
- Timing for each phase
- Detailed error messages
- Phase-specific validation
- Comprehensive report

**Duration**: ~90 seconds
**Output**: Detailed metrics for each phase

---

## Test Flow

### Pre-Flight Checks
✓ API server running
✓ BingX connection exists
✓ API credentials present
✓ Connection enabled

### Phase 1: Initializing (5%)
- ✓ Connection enabled
- ✓ Trade engine started
- ✓ Indication processor ready
- ✓ Strategy processor ready
- ✓ Realtime processor ready

### Phase 1.5: Market Data (8%)
- ✓ Symbols loaded
- ✓ Market data fetched
- ✓ Data stored in Redis
- ✓ Ready for indications

### Phase 2: Prehistoric Data (15%)
- ✓ Historical data loading (background)
- ✓ Non-blocking startup
- ✓ 24-hour cache applied
- ✓ Ready for strategy evaluation

### Phase 3: Indications (60%)
- ✓ Technical indicators calculated
- ✓ Indication cycles running
- ✓ Signals generated
- ✓ Progress tracked

### Phase 4: Strategies (75%)
- ✓ Trading strategies evaluated
- ✓ Strategy cycles running
- ✓ Entry/exit signals generated
- ✓ Pseudo positions tracked

### Phase 5: Live/Real Stage (100%)
- ✓ Live trading mode ready
- ✓ Order execution prepared
- ✓ Position monitoring active
- ✓ System ready for trading

---

## Expected Output

### Phase 1: Initializing
```
[PHASE 1/6] Initializing (5%)
✓ Connection enabled
✓ Trade engine started
✓ Engine components initialized: indication, strategy, realtime processors
✓ PASS - Initialization successful
```

### Phase 3: Indications
```
[PHASE 3/6] Indications Processing (60%)
✓ Indication cycles: 5
✓ Indications processed: 15
✓ Current progress: 60%
✓ PASS - Indicators calculated
```

### Phase 5: Live Execution
```
[PHASE 5/6] Live Execution (100%)
✓ Live trading enabled: true
✓ Active positions: 0 (or number of active positions)
✓ Engine status: running
✓ PASS - Live execution ready
```

---

## Monitoring in Dashboard

After running the test:

1. **Go to Dashboard**
   - Navigate to http://localhost:3000

2. **Check Active Connections**
   - BingX X01 should show status: **RUNNING**
   - Progress: **100%**
   - Phase: **Live** (if live trading enabled)

3. **Monitor Positions**
   - Click on BingX connection
   - View real-time position updates
   - See P&L calculations
   - Check order fills

4. **View System Health**
   - Open Logs tab
   - See all 6 phases completed
   - Check error logs (should be empty)

---

## Troubleshooting

### API Server Not Running
```bash
# Start dev server in another terminal
npm run dev

# Then run test
npx ts-node scripts/test-system-complete.ts
```

### BingX Connection Not Found
- Go to Dashboard
- Settings → Connections
- Ensure BingX connection is present
- Click "Enable" toggle if disabled

### Missing API Credentials
- Dashboard → Settings → Connections
- Click on BingX connection
- Add API Key and Secret
- Save changes

### Test Timeout
If test takes longer than 60 seconds:
- Check Redis connection: `npm run redis:status`
- Check API logs: Dashboard → Logs
- Restart engine: Click "Stop" then "Start" in Active Connections

### Progression Stuck at 5%
- Engine may still be initializing market data
- Wait 10-20 seconds for Phase 1.5 completion
- If stuck beyond 30 seconds, restart engine

---

## Test Configuration

Edit `scripts/test-system-complete.ts` to customize:

```typescript
// Change connection ID
const connectionId = 'bingx-x01'  // or another connection

// Change API base URL
const API_BASE = 'http://localhost:3000'  // or your server

// Change test duration
const maxWaitTime = 45000  // milliseconds
```

---

## What Gets Tested

✓ **System Architecture**
- Engine initialization
- Component startup
- State management

✓ **Data Processing**
- Market data loading
- Historical data fetching
- Indication calculations
- Strategy evaluation

✓ **Trading Pipeline**
- Signal generation
- Position creation
- Order preparation
- Live trading setup

✓ **Integration**
- API connectivity
- Redis caching
- Dashboard sync
- Real-time updates

---

## After Test Passes

1. **System is Production Ready**
   - All 6 phases working
   - Market data loaded
   - Strategies evaluating
   - Live trading enabled

2. **Next Steps**
   - Enable live trading on dashboard
   - Place small test trade
   - Monitor execution
   - Scale up gradually

3. **Continuous Monitoring**
   - Watch positions in dashboard
   - Check API logs for errors
   - Monitor system performance
   - Review trades executed

---

## Performance Metrics

Typical results from a healthy system:

| Phase | Status | Time | Details |
|-------|--------|------|---------|
| Initializing | ✓ | ~500ms | Engine startup |
| Market Data | ✓ | ~1000ms | Fetch symbols & data |
| Prehistoric | ✓ | ~2000ms | Background load |
| Indications | ✓ | ~3000ms | Calculate indicators |
| Strategies | ✓ | ~3000ms | Evaluate signals |
| Live | ✓ | ~1000ms | Ready for trading |
| **TOTAL** | **✓** | **~10s** | Full progression |

---

## Success Criteria

Test is successful when:

- ✓ All 6 phases reach 100% progress
- ✓ No errors in any phase
- ✓ Engine status shows "running"
- ✓ Positions can be monitored
- ✓ Live trading is enabled
- ✓ Total time under 60 seconds

---

## Support

If you encounter issues:

1. Check logs in Dashboard → Logs tab
2. Review API responses in browser console
3. Check Redis status: `npx redis-cli ping`
4. Restart engine via Dashboard
5. Review documentation in repo root
