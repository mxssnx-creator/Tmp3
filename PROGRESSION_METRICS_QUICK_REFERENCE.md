# PROGRESSION METRICS - QUICK REFERENCE & EXPECTED VALUES

## Current Expected System State

### After 1 Cycle (T+2 seconds)
```
cyclesCompleted: 1
successfulCycles: 1 (100%)
failedCycles: 0

prehistoricCyclesCompleted: 0-1
prehistoricPhaseActive: true

indicationsCount: 500-1,000
indicationDirection: 200-300 (40%)
indicationMove: 150-200 (30%)
indicationActive: 100-150 (20%)
indicationOptimal: 50-100 (10%)

strategiesBaseTotal: 500-1,500
strategiesMainTotal: 0-5,000
strategiesRealTotal: 0-1,000
```

### After 10 Cycles (T+20 seconds)
```
cyclesCompleted: 10
successfulCycles: 10 (100%)
failedCycles: 0

prehistoricCyclesCompleted: 1 (completed)
prehistoricPhaseActive: false

indicationsCount: 5,000-10,000 (aggregate)
indicationDirection: 1,500-2,000
indicationMove: 1,000-1,500
indicationActive: 500-1,000
indicationOptimal: 250-500

strategiesBaseTotal: 10,000-15,000
strategiesMainTotal: 50,000-100,000
strategiesRealTotal: 40,000-80,000
```

### After 100 Cycles (T+200 seconds)
```
cyclesCompleted: 100
successfulCycles: 100 (100%)
failedCycles: 0

prehistoricCyclesCompleted: 1 (unchanged)

indicationsCount: 50,000-100,000 (aggregate)
indicationDirection: 15,000-20,000
indicationMove: 10,000-15,000
indicationActive: 5,000-10,000
indicationOptimal: 2,500-5,000

strategiesBaseTotal: 100,000-150,000
strategiesMainTotal: 500,000-1,000,000
strategiesRealTotal: 400,000-800,000

totalTrades: 100-500 (10-50 LIVE selected per cycle)
successfulTrades: 75-400 (win rate 75-80%)
totalProfit: $100-$5,000 (depends on pair)
```

## Critical Ratios to Verify

### Indication Distribution
```
Expected Range:
Direction:  35-40% of total ✓
Move:       25-35% of total ✓
Active:     15-25% of total ✓
Optimal:    5-15% of total  ✓
Auto:       0-5% of total   ✓

If ANY = 0%: Processor may have failed
If ratios inverted: Filtering logic incorrect
If one dominates >50%: Threshold too loose
```

### Strategy Stage Ratios
```
Expected Flow:
BASE → MAIN:  50-60% pass (40-50% filtered)
MAIN → REAL:  40-50% pass (50-60% filtered)
REAL → LIVE:  0.02-0.06% selected (99.94-99.98% filtered)

If MAIN < BASE:  Something filtered too aggressively
If REAL > MAIN:  Data corruption or error in stages
If LIVE = 0:     Quality thresholds too strict
If LIVE > 100:   Data structure error
```

### Success Rate Targets
```
cycleSuccessRate:  > 95%  (< 5% failures acceptable)
tradeSuccessRate:  > 70%  (70-80% win rate normal)
```

## Redis Key Patterns for Manual Verification

### Check Prehistoric Status
```bash
redis-cli EXISTS prehistoric_loaded:bingx-x01
redis-cli GET prehistoric:bingx-x01:symbols
redis-cli SCARD prehistoric:bingx-x01:candles:BTCUSDT
redis-cli KEYS prehistoric:bingx-x01:* | wc -l
```

### Check Indications
```bash
redis-cli GET indications:bingx-x01:count
redis-cli GET indications:bingx-x01:direction:evaluated
redis-cli GET indications:bingx-x01:move:evaluated
redis-cli GET indications:bingx-x01:active:evaluated
redis-cli GET indications:bingx-x01:optimal:evaluated
```

### Check Strategies
```bash
redis-cli SCARD sets:bingx-x01:base:BTCUSDT
redis-cli SCARD sets:bingx-x01:main:BTCUSDT
redis-cli SCARD sets:bingx-x01:real:BTCUSDT
redis-cli GET strategies:bingx-x01:base:evaluated
redis-cli GET strategies:bingx-x01:main:evaluated
redis-cli GET strategies:bingx-x01:real:evaluated
```

### Check Cycles
```bash
redis-cli HGET progression:bingx-x01 cycles_completed
redis-cli HGET progression:bingx-x01 successful_cycles
redis-cli HGET progression:bingx-x01 indications_count
redis-cli HGET progression:bingx-x01 strategies_count
```

## Common Issues & Quick Fixes

| Issue | Sign | Check | Fix |
|-------|------|-------|-----|
| Prehistoric not loading | `prehistoricCyclesCompleted=0` after 30s | Redis keys | `redis-cli DEL prehistoric_loaded:*` + restart |
| Indications stuck | `indicationsCount` flat for 5+ cycles | Processor logs | Wait 45s (circuit breaker reset) |
| Strategies bottleneck | `strategiesMain = 0` | Check threshold | Review filter: win_rate > 50% |
| All zeros | Everything = 0 | Engine status | Enable connection → Click QuickStart |
| High failures | `failedCycles` > 10% | Error logs | Check Redis + API connectivity |

## Data Structure Verification

### Should Exist After 30 Seconds
```
✓ progression:{connectionId}                    (hash with cycles data)
✓ prehistoric_{connectionId}:symbols            (set of symbols)
✓ prehistoric_{connectionId}:candles:BTCUSDT   (market data)
✓ indications:{connectionId}:count             (counter)
✓ sets:{connectionId}:base:*                   (strategy sets)
✓ engine_logs:{connectionId}                   (logs list)
```

### Should Exist After 5 Minutes
```
✓ cyclesCompleted > 100
✓ indicationsCount > 50,000
✓ strategiesBaseTotal > 50,000
✓ strategiesMainTotal > 500,000
✓ strategiesRealTotal > 400,000
✓ totalTrades > 100
```

## Diagnostics Script

```javascript
// Run in browser console at: http://localhost:3002
async function checkProgressions() {
  const connId = 'bingx-x01'
  const res = await fetch(`/api/connections/progression/${connId}/logs`)
  const data = await res.json()
  const ps = data.progressionState
  
  console.log('=== PREHISTORIC ===')
  console.log(`Cycles: ${ps.prehistoricCyclesCompleted}`)
  console.log(`Candles: ${ps.prehistoricCandlesProcessed}`)
  console.log(`Active: ${ps.prehistoricPhaseActive}`)
  
  console.log('=== INDICATIONS ===')
  console.log(`Total: ${ps.indicationsCount}`)
  console.log(`Direction: ${ps.indicationEvaluatedDirection}`)
  console.log(`Move: ${ps.indicationEvaluatedMove}`)
  console.log(`Active: ${ps.indicationEvaluatedActive}`)
  console.log(`Optimal: ${ps.indicationEvaluatedOptimal}`)
  
  console.log('=== STRATEGIES ===')
  console.log(`BASE: ${ps.strategiesBaseTotal}`)
  console.log(`MAIN: ${ps.strategiesMainTotal}`)
  console.log(`REAL: ${ps.strategiesRealTotal}`)
  console.log(`Total Sets: ${ps.setsTotalCount}`)
  
  console.log('=== CYCLES ===')
  console.log(`Completed: ${ps.cyclesCompleted}`)
  console.log(`Successful: ${ps.successfulCycles}`)
  console.log(`Success Rate: ${ps.cycleSuccessRate}%`)
}

checkProgressions()
```

---

**Use this guide to quickly identify what's working and what needs fixing!**
