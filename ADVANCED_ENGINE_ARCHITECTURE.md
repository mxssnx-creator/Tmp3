# Advanced High-Frequency Trading Engine Architecture

## System Overview

This document describes the complete advanced trading engine implementation with multi-layered position management, sophisticated configuration sets, and real-time exchange integration.

---

## Core Architecture Layers

### Layer 1: Prehistoric Data Processor
**Timeframe**: 1 second per symbol
**Data Length**: 250 OHLCV candles per symbol (standard DB length)
**Rearrangement**: At 80% capacity (200 candles), removes oldest 50 and reloads next 250

**Symbols**: BTCUSDT, ETHUSDT, SOLUSDT, WIFUSDT, SIRENUSDT (5 symbols)
**Total Data**: 1,250 candles loaded per cycle

**Storage**: Redis hash sets per symbol
- Key: `prehistoric_data:{symbol}:{exchange}`
- Format: OHLCV array with timestamp

**Performance**: Non-blocking, parallel symbol loading

---

### Layer 2: Indication Processor - Advanced Configuration Sets

**Base Configuration**: Position-Cost 0.1% = 1 basis point

#### 2.1 Indication Parameter Ranges

**All indications use 6 parameters** (except "active" which uses 4):

1. **Steps** (3-30, default 15)
   - Number of step-based indicator windows to analyze
   - Step 1 = 1 unit increment

2. **Drawdown Ratio** (0.1-0.5, default 0.3, step 0.1)
   - Defines acceptable drawdown from entry point
   - Applied: All indication types

3. **Market Activity** (0.01-0.1, default 0.05, step 0.01)
   - Average market move per second (ratio to position-cost)
   - Measures volatility in real-time

4. **Range Ratio** (0.1-0.4, default 0.25, step 0.1)
   - Ratio of true range for directional bias
   - 1.0 = 100% range expansion

5. **Activity Ratio** (0.7-1.7, default 1.2, step 0.1)
   - Multiplier applied to market activity baseline
   - Adjusts sensitivity to current volatility

6. **Market Distance Ratio** (0.7-1.7, default 1.0, step 0.1)
   - Distance from average price direction multiplier
   - Accounts for deviation from mean reversion

#### 2.2 Indication Types and Parameter Usage

| Type | Parameters | Purpose |
|------|-----------|---------|
| **direction** | All 6 | Primary trend detection |
| **move** | All 6 | Momentum and price movement |
| **active** | Steps, Drawdown, Activity, Activity Ratio | Market activity detection |
| **optimal** | All 6 | Optimal entry/exit points |
| **auto** | All 6 | Auto-tuned adaptive signals |

#### 2.3 Configuration Set Structure

Each indication type creates **independent DB sets** for each parameter combination:
- **ID Format**: `indication_{type}_{param_hash}`
- **Database Length**: 250 positions per set
- **Rearrange Threshold**: 200 positions (80%)
- **Storage**: Redis hash per set

**Indications Generated Per Cycle**:
- 5 symbols × 12 indicators per symbol = **60 total indications**
- Each symbol: 1 direction + 1 move + 1 active + 1 optimal + 2 auto-adjustments

---

### Layer 3: Strategy Processor - Pseudo Position Management

#### 3.1 Pseudo Position Lifecycle

```
Indication Signal (Evaluated)
    ↓
Create Pseudo Position (Main)
    ├─ Configuration: (1-6)
    ├─ Position Count: (1,2,3,4,5,6,8,10,12,15,20,30)
    ├─ Entry: Current Market Price
    └─ TP/SL: Calculated from parameters
    ↓
Track Through Market Cycles
    ├─ Update TP/SL on each price update
    ├─ Handle trailing stops
    └─ Check evaluation criteria
    ↓
Close Position
    ├─ TP Hit → Evaluate for Real
    ├─ SL Hit → Discard
    └─ Trailing Stop Hit → Evaluate/Discard
    ↓
Evaluation (PF >= 0.7)
    ↓
Mirror to Real Exchange (if enabled)
```

#### 3.2 Configuration Combinations

**Independent Sets Created**:
- Configurations: 1-6 (6 possible)
- Position Counts: [1,2,3,4,5,6,8,10,12,15,20,30] (12 counts)
- TP Steps: 2-20 (18 variations)
- SL Ratios: 0.1-2.5 (24 variations)
- Trailing Configs: 4 variations (enabled/disabled × 2 ranges)

**Total Independent Sets**: 6 × 12 × 18 × 24 × 4 = **41,472 sets**

**Optimized for HFT**: 
- Uses defaults for high-frequency performance
- Can activate hot-config variations for A/B testing
- Each set maintains 250-position database with 80% rearrange threshold

#### 3.3 Pseudo Position Parameters

```typescript
interface PseudoPosition {
  // Identification
  id: string
  symbol: string
  connectionId: string
  
  // Configuration
  configurationId: 1-6
  positionCount: 1|2|3|4|5|6|8|10|12|15|20|30
  parameterSetId: string
  
  // Pricing
  entryPrice: number
  currentPrice: number
  takeProfitPrice: number
  stopLossPrice: number
  trailingEnabled: boolean
  highestPrice: number (for trailing)
  
  // Status & Performance
  status: "active" | "closed" | "evaluated"
  profitFactor: number (>= 0.7 = real candidate)
  drawdownTime: seconds
  
  // Volume & Cost
  quantity: number (from VolumeCalculator)
  positionCost: number
}
```

#### 3.4 Strategy Evaluation Thresholds

**Main Strategy**:
- Minimum Profit Factor: **0.5** (configurable 0.1-3.0)
- Tracks: All positions regardless of PF

**Real Strategy**:
- Minimum Profit Factor: **0.7** (fixed)
- Max Drawdown Time: **12 hours** (43200 seconds)
- Selection: Only positions meeting both criteria
- Result: Evaluated positions marked for real trading

**Position Count Analysis**:
- Evaluate by last: 1, 2, 3, 4 positions (min PF: 0.6)
- Long positions: 1-8 max concurrent
- Short positions: 1-8 max concurrent
- Per configuration: Tracked independently

---

### Layer 4: Real Position Execution

#### 4.1 Mirror Process

**Triggered When**:
1. Pseudo position closes with PF >= 0.7
2. Live Trading enabled on connection
3. Exchange connection active

**Mirror Operation**:
```
Evaluated Pseudo Position
    ↓
Extract Configuration
    ├─ Entry Price
    ├─ TP Price (from pseudo calculation)
    ├─ SL Price (from pseudo calculation)
    └─ Trailing Settings
    ↓
Create Live Exchange Position
    ├─ Symbol: Same
    ├─ Direction: Same
    ├─ Volume: From VolumeCalculator (real)
    ├─ TP: Set as Position TP (not order)
    ├─ SL: Set as Position SL (not order)
    └─ Leverage: From connection settings
    ↓
Track Real Position
    ├─ Monitor PnL
    ├─ Update TP/SL dynamically
    └─ Close on hit
```

#### 4.2 Real Position Settings (Key Difference)

**Position TP/SL** (Recommended for HFT):
```
Exchange Position Settings:
{
  symbol: "BTCUSDT"
  side: "long"
  quantity: 0.1
  leverage: 10
  takeProfit: { price: 68500 }  // POSITION level
  stopLoss: { price: 67500 }    // POSITION level
}
```

**NOT Order Commands**:
- TP/SL applied at position level (better performance)
- Exchange automatically closes on hit
- No order management overhead
- Supports trailing stops natively

#### 4.3 Live Exchange Connection

**Connection Configuration**:
- Exchange: BingX, Bybit (tested)
- API Type: REST + WebSocket
- Position Mode: One-Way (long only or short only per symbol)
- Volume: Calculated per symbol/leverage

---

### Layer 5: Real-Time Tracking & Statistics

#### 5.1 Connection Progression State

**Stored in Redis**: `progression:{connectionId}`

```
State Fields:
- cyclesCompleted: number
- cycleSuccessRate: percentage
- indicationEvaluatedDirection: count
- indicationEvaluatedMove: count
- indicationEvaluatedActive: count
- indicationsCount: total generated
- strategiesCount: evaluated
- strategyEvaluatedBase: count
- strategyEvaluatedMain: count
- strategyEvaluatedReal: count
- prehistoricSymbolsProcessed: count
- prehistoricCandlesProcessed: count
- intervalsProcessed: count
```

#### 5.2 Metrics Tracking

**Per Configuration Set**:
- Total positions created
- Evaluated positions (PF >= 0.7)
- Evaluation rate (%)
- Cumulative profit factor
- Average drawdown time

**Per Symbol**:
- Indication count
- Strategy evaluation count
- Open/closed pseudo positions
- Real positions mirror status

---

## Database Organization

### Redis Structure

```
Prehistoric Data:
  prehistoric_data:{symbol}:{exchange} → [OHLCV...]
  prehistoric_metadata:{connectionId} → stats

Indications:
  indication_set:{type}_{param_hash} → {positions}
  indication_stats:{connectionId} → {metrics}

Pseudo Positions:
  pseudo_positions:{connectionId} → {id_set}
  pseudo_position:{connectionId}:{id} → {data}
  config_set:{connectionId}:config{n}_{type} → {positions}

Real Positions:
  real_positions:{connectionId} → {id_set}
  real_position:{connectionId}:{id} → {data}

Engine State:
  trade_engine_state:{connectionId} → {stats}
  progression:{connectionId} → {metrics}
```

### Database Limits

- **Per Set**: 250 positions
- **Rearrange Threshold**: 200 (80%)
- **Rearrange Action**: Remove oldest 50, reload next 250
- **TTL**: 7 days (auto-cleanup)

---

## Configuration System

### Settings Storage

**File**: `/lib/settings-storage.ts`

**Categories**:
1. Prehistoric Data Config
2. Indication Parameter Ranges
3. Indication Evaluation Timeouts
4. Pseudo Position Configurations
5. Strategy Evaluation Thresholds
6. Real Position Execution

**Per-Connection Override**:
- Settings can be overridden per exchange/connection
- UI: "Settings" panel shows active connection settings
- Propagation: Via SettingsCoordinator

---

## Performance Optimization

### High-Frequency Considerations

1. **Independent Sets**:
   - Each configuration = separate Redis hash
   - No lock contention
   - Parallel evaluation

2. **Caching**:
   - 1-second cache for active positions
   - Prevents repeated Redis reads
   - Invalidate on write

3. **Batch Operations**:
   - Symbol data prefetched
   - Parallel indication calculation
   - Pipeline Redis commands

4. **Volume Calculation**:
   - Cached by symbol/exchange
   - Reused across positions
   - Updated every 100 cycles

5. **Trailing Stops**:
   - Calculated only if enabled
   - Update only on new high/low
   - Reduced math operations

---

## Real Exchange Trading Flow

### Quickstart to Live Trading

1. **User Starts Quickstart**: Navigate to `/quickstart`
2. **Engine Initializes**:
   - Loads prehistoric data (5 symbols)
   - Starts indication processor (60 indications/cycle)
   - Starts strategy processor (1100+ strategies/cycle)

3. **Pseudo Positions Generated**:
   - Main: All evaluated indications
   - Real: PF >= 0.7, drawdown < 12h

4. **Real Positions Mirrored**:
   - Check: Live Trading enabled?
   - Yes: Create real exchange position
   - No: Track as pseudo only

5. **Live Position Tracking**:
   - Monitor TP/SL hits
   - Update statistics
   - Emit to dashboard

---

## Integration Points

### UI Components
- QuickstartSection: Trigger engine start
- Connection-detailed-log-dialog: Show configuration stats
- Progressive-logs-dialog: Show real-time metrics
- Dashboard: Display pseudo and real positions

### API Endpoints
- `/api/trade-engine/quick-start` - Start engine
- `/api/connections/progression/{id}` - Get stats
- `/api/exchange/{exchange}/top-symbols` - Get symbols
- `/api/settings/connections/{id}/log` - Get logs

### Event System
- `open-logs-dialog` - Show logs
- `open-progression-logs` - Show progression
- `position-update` - Broadcast position changes

---

## Summary

This architecture provides:
- ✅ Sophisticated multi-layer position management
- ✅ Independent configuration sets for optimal performance
- ✅ Real pseudo position evaluation with strict criteria
- ✅ Seamless mirroring to live exchanges
- ✅ High-frequency optimized data structures
- ✅ Comprehensive tracking and statistics
- ✅ Configurable thresholds and parameters

All systems are designed for production high-frequency trading with real exchange integration.
