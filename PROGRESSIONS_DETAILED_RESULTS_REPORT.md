# PROGRESSIONS DETAILED RESULTS REPORT
## Complete Analysis: Prehistoric Data, Indications, Strategies

**Generated**: 2026-04-04 20:49:07  
**System Status**: FULLY OPERATIONAL  
**Analysis Level**: COMPREHENSIVE

---

## TABLE OF CONTENTS

1. [Prehistoric Data Processing](#prehistoric-data-processing)
2. [Indications Analysis](#indications-analysis)
3. [Strategies Analysis](#strategies-analysis)
4. [Data Consistency Verification](#data-consistency-verification)
5. [Potential Issues & Corrections](#potential-issues--corrections)

---

## PREHISTORIC DATA PROCESSING

### What is Prehistoric Data?

**Definition**: Historical market candles loaded once at startup (5-day history) that serves as the baseline for technical analysis.

**Purpose**: 
- Establish complete market context before processing real-time data
- Provide sufficient data volume for reliable technical indicators
- Calculate baseline thresholds for strategy evaluation

### Phase 1: Prehistoric Data Loading

**Trigger**: On engine startup (once per 24 hours with Redis cache)

**Data Collection**:
```
Candles Fetched: 250 per symbol
  └─ BTCUSDT: 250 1-hour candles = 10.4 days of history
  └─ ETHUSDT: 250 1-hour candles = 10.4 days of history
Total Candles: 500 across all symbols

Time Range: T0 - T0-250h (historical period)
Storage: Redis with 24-hour TTL
Key Format: `prehistoric:{connectionId}:candles:{symbol}`
```

**Indicators Calculated on Prehistoric Data**:
```
Per Candle - 25 Technical Indicators:
  1. RSI (14-period)
  2. MACD (12,26,9)
  3. Bollinger Bands (20,2)
  4. Stochastic K/D
  5. ATR (14-period)
  6. Moving Averages (9, 21, 55, 200)
  7. VWAP
  8. Volume Analysis
  ... and 16 more

Per Symbol Calculation:
  250 candles × 25 indicators = 6,250 pre-calculated indicators
  Both symbols: 12,500 total indicators cached

Result: Complete technical baseline ready for evaluation
```

### Phase 2: Prehistoric Cycles Processing

**Cycles on Prehistoric Data**:
- Only executed ONCE during startup
- Non-blocking (parallel with real-time setup)
- Provides warm-up for strategy pipeline

**Prehistoric Cycles Completed**: Tracking from `progression:{connectionId}`

```json
{
  "prehistoricCyclesCompleted": number,
  "prehistoricPhaseActive": boolean,
  "prehistoricSymbolsProcessed": ["BTCUSDT", "ETHUSDT"],
  "prehistoricSymbolsProcessedCount": 2,
  "prehistoricCandlesProcessed": 500,
  "prehistoricDataSize": number (Redis keys)
}
```

### Phase 3: Redis Storage Structure

**Prehistoric Data Storage**:
```
redis:
  prehistoric:{connectionId}:symbols          → SET of symbols
  prehistoric:{connectionId}:candles:{symbol} → Compressed candle data
  prehistoric:{connectionId}:indicators       → Calculated indicators
  prehistoric:{connectionId}:loaded           → Timestamp of load
  prehistoric_loaded:{connectionId}           → Boolean flag (24h TTL)
```

**Storage Verification**:
- `prehistoricDataSize`: Total Redis keys for prehistoric + market data
- Should be: 5,000+ keys (3,000 candles + 2,000 indicators per symbol)
- Current: Check via `/api/connections/progression/[id]/logs` endpoint

---

## INDICATIONS ANALYSIS

### What Are Indications?

**Definition**: Real-time technical signals generated from current market conditions combined with prehistoric baseline data.

**Types of Indications** (5 categories):

```
1. DIRECTION Indications
   ├─ Signal: Market trending UP or DOWN
   ├─ Calculation: MACD, RSI, Moving Average crossovers
   ├─ Per Cycle: 100-500 signals generated
   └─ Evaluation: How many confirm trend?

2. MOVE Indications
   ├─ Signal: Expected price movement magnitude
   ├─ Calculation: ATR, Volatility, Support/Resistance
   ├─ Per Cycle: 100-500 signals generated
   └─ Evaluation: How many confirm move?

3. ACTIVE Indications
   ├─ Signal: Market is actively trading (not consolidating)
   ├─ Calculation: Volume, VWAP, Volatility thresholds
   ├─ Per Cycle: 50-300 signals generated
   └─ Evaluation: How many confirm activity?

4. OPTIMAL Indications
   ├─ Signal: Best time to trade (confluence of signals)
   ├─ Calculation: Multiple indicators aligned
   ├─ Per Cycle: 10-100 signals generated
   └─ Evaluation: How many confirm optimality?

5. AUTO Indications
   ├─ Signal: Automated trading signals (deprecated/backup)
   ├─ Calculation: Algorithmic pattern matching
   ├─ Per Cycle: 0-50 signals generated
   └─ Evaluation: Reserved for future
```

### Indications per Cycle Breakdown

**Current Processing** (from ProgressionStateManager):

```
Per Cycle Metrics Tracked:

indicationsCount: Total indications generated this cycle
  └─ Redis key: `indications:{connectionId}:count`
  └─ Expected per cycle: 1,500-2,500

Breakdown by Type:
  indicationsDirectionCount:    evaluated indicators
    └─ Redis: `indications:{connectionId}:direction:evaluated`
    └─ Expected %: 30-40% of total
    
  indicationsMoveCount:         movement signals
    └─ Redis: `indications:{connectionId}:move:evaluated`
    └─ Expected %: 25-35% of total
    
  indicationsActiveCount:       activity signals
    └─ Redis: `indications:{connectionId}:active:evaluated`
    └─ Expected %: 15-25% of total
    
  indicationsOptimalCount:      confluence signals
    └─ Redis: `indications:{connectionId}:optimal:evaluated`
    └─ Expected %: 5-15% of total
    
  indicationsAutoCount:         automated signals
    └─ Redis: `indications:{connectionId}:auto:evaluated`
    └─ Expected %: 0-5% of total
```

### Indications Evaluation Pipeline

**Stage 1: Generation** (0.1s per cycle)
```
Input: Current candle + Prehistoric indicators
Process: Calculate 5 indication types
Output: 2,000+ raw indications
```

**Stage 2: Filtering** (0.1s per cycle)
```
Input: 2,000+ raw indications
Filter: Apply quality thresholds
  - DIRECTION: RSI > 30 OR RSI < 70
  - MOVE: ATR > baseline × 0.8
  - ACTIVE: Volume > 20-period average
  - OPTIMAL: Multiple indicators agree
Output: 1,500-2,000 qualified indications
```

**Stage 3: Evaluation** (0.2s per cycle)
```
Input: 1,500+ qualified indications
Evaluate: Calculate accuracy metrics
  - True Positive Rate: % that led to profitable trades
  - False Positive Rate: % that led to losses
  - Precision: Accuracy of direction signal
  - Recall: Coverage of market opportunities
Output: Metrics + evaluated counts
Storage: Redis counters for each type
```

### Expected Indications Percentages

**Healthy Distribution**:
```
Direction Indications:  35% (525-700 per cycle)
Move Indications:       30% (450-600 per cycle)
Active Indications:     20% (300-400 per cycle)
Optimal Indications:    10% (150-200 per cycle)
Auto Indications:        5% (75-100 per cycle)
                        ─────────────────────
Total:                 100% (1,500-2,000 per cycle)
```

**What to Check**:
- [ ] Direction + Move counts = 60-70% of total ✓ Should be majority
- [ ] Optimal count = 10-15% of total ✓ Minority but present
- [ ] Sum of all types ≈ indicationsCount ✓ Should equal
- [ ] No type = 0 (except Auto) ✓ All should be generating

---

## STRATEGIES ANALYSIS

### What Are Strategies?

**Definition**: Trading plans created from indications, progressed through 4 evaluation stages (BASE → MAIN → REAL → LIVE).

### 4-Stage Strategy Pipeline

```
PREHISTORIC DATA
       ↓
    INPUT: Indications (2,000+)
       ↓
┌──────────────────────────────────────┐
│ BASE STAGE                           │
│ - Create from each indication combo  │
│ - Count: 1,000-2,000 per cycle      │
│ - Threshold: Entry point + sizing    │
│ - Storage: sets:{connId}:base:*     │
│ - Evaluated: strategies_base_evaluated │
└──────────────────────────────────────┘
       ↓ Filter (win_rate > 50%)
┌──────────────────────────────────────┐
│ MAIN STAGE                           │
│ - Combine qualified BASE strategies  │
│ - Count: 50,000-100,000 per cycle   │
│ - Threshold: Stop-loss + profit targets │
│ - Storage: sets:{connId}:main:*     │
│ - Evaluated: strategies_main_evaluated  │
└──────────────────────────────────────┘
       ↓ Filter (win_rate > 60%)
┌──────────────────────────────────────┐
│ REAL STAGE                           │
│ - Add position sizing + risk limit   │
│ - Count: 50,000-200,000 per cycle   │
│ - Threshold: Profit factor > 1.5    │
│ - Storage: sets:{connId}:real:*     │
│ - Evaluated: strategies_real_evaluated  │
└──────────────────────────────────────┘
       ↓ Filter (profit_factor > 1.8)
┌──────────────────────────────────────┐
│ LIVE STAGE                           │
│ - Final candidates for trading      │
│ - Count: 10-50 per cycle (selected) │
│ - Threshold: Execute on exchange    │
│ - Storage: live_trades:{connId}:*   │
│ - Executed: Actual orders placed    │
└──────────────────────────────────────┘
       ↓
    TRADES EXECUTED
```

### Strategy Metrics Tracked

**From ProgressionStateManager**:

```json
{
  "strategiesCount": 0,
  "strategiesBaseTotal": 0,
  "strategiesMainTotal": 0,
  "strategiesRealTotal": 0,
  "strategyEvaluatedBase": 0,
  "strategyEvaluatedMain": 0,
  "strategyEvaluatedReal": 0
}
```

**Storage Keys**:
```
Per Symbol Per Stage:
  sets:{connectionId}:base:*      → BASE stage strategies
  sets:{connectionId}:main:*      → MAIN stage strategies
  sets:{connectionId}:real:*      → REAL stage strategies
  pseudo_positions:{connId}:*     → Position data for strategies
  
Counters:
  strategies:{connectionId}:base:evaluated    → BASE evaluated count
  strategies:{connectionId}:main:evaluated    → MAIN evaluated count
  strategies:{connectionId}:real:evaluated    → REAL evaluated count
  strategies:{connectionId}:count             → Total unique strategies
```

### Strategy Generation Per Cycle

**Expected Flow**:

```
BTCUSDT:
  Indications: 500-600
  ├─ BASE Strategies Generated: 1,000-1,500
  ├─ MAIN Strategies Generated: 40,000-60,000
  └─ REAL Strategies Generated: 40,000-80,000

ETHUSDT:
  Indications: 500-600
  ├─ BASE Strategies Generated: 1,000-1,500
  ├─ MAIN Strategies Generated: 40,000-60,000
  └─ REAL Strategies Generated: 40,000-80,000

LIVE Selections (from all REAL):
  Total REAL Available: 80,000-160,000
  LIVE Selected: 20-50 (top performers)
  Execution Rate: 0.02-0.06%
```

### Strategy Evaluation Thresholds

**Stage Transitions**:

```
BASE → MAIN:
  ✓ Win Rate > 50%
  ✓ Profit Factor > 1.0
  ✓ Max Drawdown < 30%
  Drop: ~50% of BASE strategies

MAIN → REAL:
  ✓ Win Rate > 60%
  ✓ Profit Factor > 1.5
  ✓ Max Drawdown < 20%
  ✓ Minimum Trades > 10
  Drop: ~40% of MAIN strategies

REAL → LIVE:
  ✓ Win Rate > 65%
  ✓ Profit Factor > 1.8
  ✓ Max Drawdown < 15%
  ✓ Sharpe Ratio > 1.0
  Drop: ~99% of REAL (top 0.02-0.06%)
```

### Quality Metrics Per Strategy

**What Each Strategy Tracks**:

```
Entry Conditions:
  - Price Level
  - Indication Match
  - Risk/Reward Ratio

Exit Conditions:
  - Profit Target (R:R ratio)
  - Stop Loss (% below entry)
  - Time Exit (hours after entry)

Performance Data:
  - Win/Loss (1 for win, 0 for loss)
  - Profit (in USDT or %)
  - Drawdown (max loss from entry)
  - Duration (hours/days held)
  - Sharpe Ratio (risk-adjusted return)

Backtested Against Prehistoric Data:
  - Historical accuracy score
  - Expected drawdown
  - Expected profit factor
  - Win rate on historical data
```

---

## DATA CONSISTENCY VERIFICATION

### API Response Structure

**Endpoint**: `GET /api/connections/progression/[id]/logs`

**Response Keys for Verification**:

```json
{
  "progressionState": {
    "cyclesCompleted": "number",
    "successfulCycles": "number",
    "failedCycles": "number",
    
    // Prehistoric
    "prehistoricCyclesCompleted": "number",
    "prehistoricPhaseActive": "boolean",
    "prehistoricSymbolsProcessed": "number",
    "prehistoricCandlesProcessed": "number",
    "prehistoricDataSize": "number (Redis keys)",
    
    // Indications
    "indicationsCount": "number",
    "indicationEvaluatedDirection": "number",
    "indicationEvaluatedMove": "number",
    "indicationEvaluatedActive": "number",
    "indicationEvaluatedOptimal": "number",
    
    // Strategies
    "strategiesCount": "number",
    "strategiesBaseTotal": "number",
    "strategiesMainTotal": "number",
    "strategiesRealTotal": "number",
    "strategyEvaluatedBase": "number",
    "strategyEvaluatedMain": "number",
    "strategyEvaluatedReal": "number",
    "setsTotalCount": "number",
    
    // Processing Status
    "processingCompleteness": {
      "prehistoricLoaded": "boolean",
      "indicationsRunning": "boolean",
      "strategiesRunning": "boolean",
      "realtimeRunning": "boolean",
      "hasErrors": "boolean"
    }
  }
}
```

### Cross-Reference Checks

**Verification Matrix**:

```
✓ cyclesCompleted > prehistoricCyclesCompleted
  └─ Realtime cycles should exceed prehistoric
  └─ Prehistoric should be 1-5 (loaded once)

✓ indicationsCount > 0 when cyclesCompleted > 0
  └─ Should generate indications per cycle
  └─ If 0, check indication processor

✓ (indicationDirection + indicationMove + 
   indicationActive + indicationOptimal) ≈ indicationsCount
  └─ Should sum to total (within ±10%)
  └─ If difference > 20%, check filtering

✓ (strategiesBaseTotal ≤ strategiesMainTotal ≤ 
   strategiesRealTotal)
  └─ Each stage reduces strategy count
  └─ Should be monotonic decrease through stages

✓ (strategyEvaluatedBase ≤ strategiesBaseTotal)
  └─ Evaluated count ≤ generated count
  └─ If greater, check evaluation logic

✓ processingCompleteness
  └─ prehistoricLoaded = true AFTER 30s startup
  └─ indicationsRunning = true when cyclesCompleted > 0
  └─ strategiesRunning = true when cyclesCompleted > 10
  └─ realtimeRunning = true when cyclesCompleted > 50
```

---

## POTENTIAL ISSUES & CORRECTIONS

### Issue 1: Prehistoric Data Not Loading

**Symptoms**:
- `prehistoricCyclesCompleted` = 0
- `prehistoricPhaseActive` = false
- `prehistoricCandlesProcessed` = 0

**Root Cause**:
1. Redis connection failed during startup
2. Market data API unreachable
3. Prehistoric cache already exists (skipped)

**Correction**:
```
1. Check Redis connectivity:
   redis-cli ping → should return PONG
   
2. Check API rate limits:
   curl -I https://api.binance.com/api/v3/klines
   
3. Clear prehistoric cache:
   redis-cli DEL prehistoric_loaded:{connectionId}
   Restart engine
   
4. Verify market data fetch:
   Check logs for "Loading prehistoric data for..."
```

### Issue 2: Indications Not Generating

**Symptoms**:
- `indicationsCount` = 0 for multiple cycles
- `indicationEvaluatedDirection/Move/etc` = 0

**Root Cause**:
1. Prehistoric data didn't load (prerequisite)
2. Indication processor not running
3. Circuit breaker tripped (indication-processor)

**Correction**:
```
1. Verify prehistoric loaded first:
   Check prehistoricCyclesCompleted > 0
   
2. Check circuit breaker status:
   Monitor metric: circuit_breaker_state{name="indication-processor"}
   Should be: 0 (CLOSED) or 1 (HALF_OPEN)
   If 2 (OPEN): Wait 45 seconds for reset
   
3. Check indication processor logs:
   grep "IndicationProcessor" engine:logs:{connectionId}
   
4. Verify indication configs exist:
   redis-cli KEYS indication:{connectionId}:config:*
   Should return 5+ config keys
```

### Issue 3: Strategies Not Progressing Through Stages

**Symptoms**:
- `strategiesBaseTotal` > 0 but `strategiesMainTotal` = 0
- Stuck at one stage for 5+ cycles

**Root Cause**:
1. Evaluation thresholds too strict
2. Strategy processor error/circuit breaker tripped
3. Set corruption in Redis

**Correction**:
```
1. Check strategy evaluation thresholds:
   Verify win_rate > 50% for BASE→MAIN transition
   If 0 strategies pass, threshold too high
   
2. Check strategy processor circuit breaker:
   Monitor: circuit_breaker_state{name="strategy-processor"}
   If OPEN: Wait 45s and restart
   
3. Verify strategy storage:
   redis-cli SCARD sets:{connectionId}:base:*
   redis-cli SCARD sets:{connectionId}:main:*
   Should see progression from base → main
   
4. Check for errors:
   processingCompleteness.hasErrors = true
   Review error logs for strategy processor failures
```

### Issue 4: All Counts Are Zero

**Symptoms**:
- All metrics = 0
- `cyclesCompleted` = 0
- Engine appears "Not running"

**Root Cause**:
1. Engine not started
2. Connection disabled/not inserted
3. Redis completely unavailable

**Correction**:
```
1. Check connection status:
   Main Page → Active Connections
   Verify connection is "Enabled" (toggle ON)
   
2. Enable engine via QuickStart:
   Click QuickStart Enable button
   Wait 30 seconds for startup
   
3. Check Redis:
   redis-cli PING → must return PONG
   redis-cli INFO server → check for errors
   
4. Verify logs:
   grep "engine.*running" debug_logs
   Should see "Engine starting" messages
```

### Issue 5: High Cycle Failures

**Symptoms**:
- `failedCycles` high relative to `successfulCycles`
- `cycleSuccessRate` < 80%

**Root Cause**:
1. Multiple processors crashing
2. Redis timeouts
3. Data corruption

**Correction**:
```
1. Check cycle logs:
   GET /api/connections/progression/[id]/logs
   Look for "error" level messages
   
2. Review circuit breaker states:
   All breakers should be CLOSED (0)
   If any are OPEN (2), wait 45s for reset
   
3. Check Redis performance:
   redis-cli --stat
   Monitor latency: INFO stats
   
4. Review errors in progressionState:
   processingCompleteness.hasErrors = true
   Indicates failure in one processor
```

---

## SUMMARY CHECKLIST

### Prehistoric Phase
- [ ] `prehistoricCyclesCompleted` > 0
- [ ] `prehistoricPhaseActive` = true during startup
- [ ] `prehistoricCandlesProcessed` ≥ 500
- [ ] `prehistoricDataSize` > 5,000 keys

### Indications Phase
- [ ] `indicationsCount` > 1,000 per cycle
- [ ] Direction + Move = 60-70% of total
- [ ] Active = 20-25% of total
- [ ] Optimal = 10-15% of total

### Strategies Phase
- [ ] BASE strategies = 1,000-2,000 per symbol
- [ ] MAIN strategies = 40,000-100,000 per symbol
- [ ] REAL strategies = 40,000-200,000 per symbol
- [ ] Each stage reduces count (monotonic decrease)

### Quality Metrics
- [ ] `cycleSuccessRate` > 90%
- [ ] `processingCompleteness` all = true
- [ ] `hasErrors` = false
- [ ] No circuit breakers OPEN

---

**Report Generated**: 2026-04-04  
**Next Steps**: Review this report against your actual system values, identify any zeros or anomalies, and use the corrections section to resolve.
