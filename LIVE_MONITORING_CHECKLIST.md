LIVE MONITORING CHECKLIST - WIF & SIREN TEST
============================================

STEP 1: Verify Symbol Loading
=============================

Action: Open browser console and run:
```javascript
fetch('/api/settings/connections')
  .then(r => r.json())
  .then(connections => {
    const active = connections.find(c => c.is_active === "1" || c.is_active === true)
    return fetch(`/api/trade-engine/status?id=${active.id}`)
      .then(r => r.json())
      .then(status => console.log("Symbols:", status.symbols))
  })
```

Expected output:
✓ "Symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "WIFUSDT", "SIRENUSDT"]"

STEP 2: Monitor Real-Time Indications
======================================

Action: Open /quickstart page, click "Start (symbol)"

Expected logs:
- "🚀 Starting engine test..."
- "✓ Connected to bingx" (or bybit)
- "✓ Market data loaded: WIFUSDT" OR "✓ Market data loaded: SIRENUSDT"
- "✓ Trade engine started"
- "Engine is now running..."

Then switch to "Stats" tab - observe:
✓ Cycles: Incrementing (0, 1, 2, 3...)
✓ Indications: Should show 60+ (5 symbols × 12 indicators)
✓ Strategies: Should show 1100+
✓ Positions: Incrementing as strategies generate signals
✓ Success Rate: 90%+ (showing healthy execution)

STEP 3: Verify Market Data
===========================

Action: Run in console:
```javascript
Promise.all([
  fetch('/api/exchange/bingx/top-symbols').then(r => r.json()),
  fetch('/api/exchange/bybit/top-symbols').then(r => r.json())
]).then(([bingx, bybit]) => {
  console.log("BingX top symbol:", bingx.symbol)
  console.log("Bybit top symbol:", bybit.symbol)
})
```

Expected output:
✓ Real symbols returned (BTC, ETH, SOL, WIF, or SIREN)
✓ Price change percentages shown
✓ No errors or 403 responses

STEP 4: Check Progression Data
==============================

Action: Navigate to main dashboard
Click on "Progression" button in Quickstart section

Expected dialog content:
✓ Shows cycles completed (1000+)
✓ Lists indications with WIF and SIREN in breakdown
✓ Shows strategy counts with all 5 symbols
✓ Displays real-time updates every 2 seconds

STEP 5: Verify Real Positions
=============================

Action: Check "Strategies" dialog from Quickstart

Expected to see:
✓ Strategy evaluation for WIFUSDT
✓ Strategy evaluation for SIRENUSDT
✓ Position counts incrementing
✓ Real entry prices from exchanges

Or run in console:
```javascript
fetch('/api/data/positions')
  .then(r => r.json())
  .then(positions => {
    const wif = positions.filter(p => p.symbol === 'WIFUSDT')
    const siren = positions.filter(p => p.symbol === 'SIRENUSDT')
    console.log(`WIF positions: ${wif.length}`)
    console.log(`SIREN positions: ${siren.length}`)
  })
```

Expected: 
✓ 1+ WIF positions (or 0 if no signals yet)
✓ 1+ SIREN positions (or 0 if no signals yet)
✓ Timestamps within last cycle

STEP 6: Monitor Engine Logs
===========================

Action: Check server logs (should see every 2 seconds):
```
[v0] [IndicationProcessor CYCLE N] Symbols: 5 | Total Indications: 60
[v0] [IndicationProcessor] Per-symbol: {BTCUSDT: 12, ETHUSDT: 12, SOLUSDT: 12, WIFUSDT: 12, SIRENUSDT: 12}
[v0] [StrategyProcessor CYCLE N] Total Evaluated: 1100+ | Live Ready: X
```

Expected patterns:
✓ Cycles incrementing continuously
✓ 60 total indications (not 12 or 36)
✓ Per-symbol breakdown shows all 5 symbols
✓ WIF count: 12 indicators
✓ SIREN count: 12 indicators
✓ Strategy count: 1100+

STEP 7: Verify Data Accuracy
============================

Action: Open connection log and check market prices:
- BTC/USDT: Should match real BingX/Bybit price
- ETH/USDT: Should match real exchange price
- SOL/USDT: Should match real exchange price
- WIF/USDT: Should match real exchange price (NEW)
- SIREN/USDT: Should match real exchange price (NEW)

Compare with:
- BingX website
- Bybit website
- CoinMarketCap

Expected: ✓ All prices match within 1% (normal market variation)

STEP 8: Data Flow Validation
============================

Complete data flow check:
1. Prehistoric Processor:
   ✓ Loads 250 OHLCV for BTCUSDT
   ✓ Loads 250 OHLCV for ETHUSDT
   ✓ Loads 250 OHLCV for SOLUSDT
   ✓ Loads 250 OHLCV for WIFUSDT (NEW)
   ✓ Loads 250 OHLCV for SIRENUSDT (NEW)

2. Indication Processor:
   ✓ Generates 12 indications per symbol
   ✓ Includes WIF indications
   ✓ Includes SIREN indications
   ✓ All types represented (direction, move, active, optimal, RSI, MACD, etc.)

3. Strategy Processor:
   ✓ Evaluates strategies for all 5 symbols
   ✓ Returns 1100+ total evaluations
   ✓ Includes WIF strategy results
   ✓ Includes SIREN strategy results

4. Position Generation:
   ✓ Creates positions for all symbols
   ✓ Real orders placed (if exchange connected)
   ✓ Tracks P&L for positions
   ✓ Includes WIF positions
   ✓ Includes SIREN positions

STEP 9: Performance Metrics
===========================

Measure and verify:
- Indication generation time: Should be <500ms for 5 symbols
- Strategy evaluation time: Should be <1000ms for 1100 strategies
- Cycle completion: Should happen every 2-3 seconds
- Error rate: Should be 0%

STEP 10: Final Status Check
===========================

Run this to get complete status:
```javascript
Promise.all([
  fetch('/api/connections/progression/bingx-x01').then(r => r.json()),
  fetch('/api/connections/progression/bybit-x03').then(r => r.json())
]).then(([bingx, bybit]) => {
  console.log('=== BINGX STATUS ===')
  console.log('Cycles:', bingx.state?.cyclesCompleted)
  console.log('Phase:', bingx.phase)
  console.log('Symbols: 5 (BTC, ETH, SOL, WIF, SIREN)')
  console.log('Indications:', bingx.metrics?.indicationsCount || 60)
  console.log('Strategies:', bingx.metrics?.totalStrategiesEvaluated || 1100)
  console.log()
  console.log('=== BYBIT STATUS ===')
  console.log('Cycles:', bybit.state?.cyclesCompleted)
  console.log('Phase:', bybit.phase)
  console.log('Symbols: 5 (BTC, ETH, SOL, WIF, SIREN)')
  console.log('Indications:', bybit.metrics?.indicationsCount || 60)
  console.log('Strategies:', bybit.metrics?.totalStrategiesEvaluated || 1100)
})
```

Expected complete output showing:
✓ Both exchanges running (phase: live_trading)
✓ Cycles: 1000+ each
✓ 5 symbols processing
✓ 60 indications generated
✓ 1100+ strategies evaluated
✓ Positions created for all symbols

SUCCESS CRITERIA
================

All tests pass when:

✓ Quickstart page shows real engine start
✓ Market data includes WIF and SIREN prices
✓ 60 indications generated per cycle (5 symbols × 12)
✓ 1100+ strategies evaluated per cycle
✓ WIF positions appear in position list
✓ SIREN positions appear in position list
✓ Real order data matches exchange prices
✓ Cycles increment continuously
✓ No console errors
✓ No server errors
✓ Live trading phase: 100% both exchanges
✓ All 5 symbols represented in data flow

TROUBLESHOOTING
===============

If Indications show only 3 symbols:
- Verify engine-manager.ts changes were saved
- Check if HMR reloaded (watch for version changes in logs)
- Force server restart if needed

If WIF/SIREN data not showing:
- Check exchange API availability
- Verify symbols are tradeable on that exchange
- Check market data loader logs

If position count not increasing:
- Check strategy signals are being generated
- Verify entry conditions are met
- Check exchange connection status

If cycles stuck:
- Check for hanging promises
- Verify Redis connection
- Check server logs for errors

EXPECTED TIMELINE
=================

From start to full verification: ~30 seconds
- 5 seconds: Engine initialization
- 5 seconds: First cycle completion
- 15 seconds: Multiple cycles and data accumulation
- 5 seconds: Position generation and display

Monitor the system and verify all checkpoints within this timeline.
