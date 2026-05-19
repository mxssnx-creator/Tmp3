# Prehistoric-Realtime Coordination Verification & Fixes

## User Requirements

Ensure that:
1. **Prehistoric progress** completes FULLY using historical data
2. **Realtime progress** starts ONLY AFTER prehistoric is complete
3. **BASE→MAIN evaluation** uses profitFactor average of last X positions (default 15)
4. **Evaluation skips** if insufficient positions exist
5. All logic is **calculative, coordinated, and logically correct**

## Current System Verification

### Phase 1: Prehistoric Data Loading

**Location**: `lib/trade-engine/engine-manager.ts` lines 512-568

**Implementation**:
```
Phase 2: Load prehistoric data (NON-BLOCKING)
- Check if prehistoric data cached: prehistoricCacheKey = `prehistoric_loaded:${connectionId}`
- If cached: Use cached data, set prehistoric_data_loaded = true
- If not cached: Load historical data in background via loadPrehistoricDataInBackground()
```

**Issue Identified**: Line 566 says "Non-blocking prehistoric loading" - this means it loads in BACKGROUND!
- `this.loadPrehistoricDataInBackground(prehistoricCacheKey, redisClient)` is non-blocking
- Realtime cycle could start WHILE prehistoric is still loading

**Root Cause**: Prehistoric is loaded in background, realtime starts immediately.

### Phase 2: Realtime Cycle Execution

**Location**: `lib/strategy-coordinator.ts` lines 792-863 (executeStrategyFlow)

**Function Signature** (line 792):
```typescript
async executeStrategyFlow(
  symbol: string,
  indications: any[],
  isPrehistoric: boolean = false,  // ← Flag distinguishes phases
  sharedContext?: PositionContext,
)
```

When `isPrehistoric = true`:
- Uses neutral position context (line 818)
- Skips LIVE stage (line 851)
- Returns BASE → MAIN → REAL only

When `isPrehistoric = false`:
- Uses actual position context from exchange (line 819)
- Runs full BASE → MAIN → REAL → LIVE pipeline

### Phase 3: BASE→MAIN Evaluation Logic

**Location**: `lib/strategy-coordinator.ts` lines 1290-1383

**Min-Position Gate** (lines 1366-1383):
```typescript
const liveCount    = baseSet.entryCount ?? baseSet.entries?.length ?? 0
const histCount    = baseSet.prevPos?.count ?? 0
const setPosCount  = Math.max(liveCount, histCount)

// CRITICAL GATE: Skip evaluation if insufficient positions
const inHistoricOrBacktest = histCount > 0 || liveCount > 0
if (!inHistoricOrBacktest && setPosCount < mainMinPos) {
  skippedLowPos++
  continue  // Skip this Set
}
```

**Meaning**:
- Line 1379: `inHistoricOrBacktest = histCount > 0 || liveCount > 0`
  - TRUE if we have historic data (backtest/prehistoric) OR live data (realtime)
- Line 1380: `if (!inHistoricOrBacktest && setPosCount < mainMinPos)`
  - Only applies gate when NEITHER historic NOR live data exists
  - This is WRONG during prehistoric! Should NOT use historic data exception

**Issue Identified**: The gate logic is inverted!
- During prehistoric with historic data: gate is SKIPPED (line 1379-1380 bypass)
- During realtime: gate applies properly
- **But the comprehensive plan says**: "NOT evaluate if too few positions exist"
- **Current code says**: "Skip gate if ANY historic OR live data exists"

### Phase 4: Profitfactor Average Logic

**Location**: `lib/strategy-coordinator.ts` line 1067-1081

**Current Implementation**:
```typescript
const rawAvgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
```

**Issue**: Uses ALL entries, not "last X positions"

**Required**: Should use last 15 (or configured) positions

**Fix Needed**: Use `meanPFOfLastN(entries, mainEvalPosCount)` instead

### Phase 5: Meanpfofstastn Function

**Location**: `lib/strategy-coordinator.ts` lines 3312-3326

**Current Implementation**:
```typescript
private meanPFOfLastN(entries: StrategySetEntry[], n: number): number | null {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const slice = entries.slice(-n) // Last N entries
  const sum = slice.reduce((a, e) => {
    const pf = Number(e.profitFactor)
    return Number.isFinite(pf) ? a + pf : a
  }, 0)
  return slice.length > 0 ? sum / slice.length : null
}
```

**Status**: ✓ Function exists and is correct
- Takes last N entries only
- Returns null if no entries
- Calculates average properly

**Usage**: Currently NOT USED in BASE→MAIN evaluation!

## Fixes Required

### Fix 1: Change Min-Position Gate Logic

**File**: `lib/strategy-coordinator.ts` line 1379-1380

**Current**:
```typescript
const inHistoricOrBacktest = histCount > 0 || liveCount > 0
if (!inHistoricOrBacktest && setPosCount < mainMinPos) {
```

**Fixed**:
```typescript
// Only skip gate if we have live counts (during realtime)
// During prehistoric, we should skip ONLY if not enough historic data
const skipGateForThisSet = isPrehistoric ? (histCount >= mainMinPos) : (liveCount > 0 || histCount >= mainMinPos)
if (!skipGateForThisSet && setPosCount < mainMinPos) {
```

Actually, simpler fix: During prehistoric, mainMinPos should be applied to historic data.

### Fix 2: Use meanPFOfLastN in BASE→MAIN Evaluation

**File**: `lib/strategy-coordinator.ts` line 1067-1081

**Current**:
```typescript
const rawAvgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
```

**Fixed**:
```typescript
const lastNMeanPF = this.meanPFOfLastN(entries, this._coordinationSettings.mainEvalPosCount)
const rawAvgPF = lastNMeanPF ?? (entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length)
```

Or simpler - always use meanPFOfLastN:
```typescript
const rawAvgPF = this.meanPFOfLastN(entries, this._coordinationSettings.mainEvalPosCount) 
  ?? (entries.length > 0 ? entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length : 0)
```

### Fix 3: Make Prehistoric Synchronous (Block Realtime)

**File**: `lib/trade-engine/engine-manager.ts` line 512-568

**Current**: 
```typescript
// Non-blocking prehistoric loading
await this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data (background)...")
this.loadPrehistoricDataInBackground(prehistoricCacheKey, redisClient)
```

**Issue**: Returns immediately, realtime starts while prehistoric is still loading

**Fixed**: 
```typescript
// BLOCKING prehistoric loading - wait for completion
await this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data...")
await this.loadPrehistoricData(prehistoricCacheKey, redisClient)  // Wait for completion
```

## Verification Checklist

- [ ] Prehistoric phase loads completely before realtime starts
- [ ] BASE→MAIN evaluation uses profitFactor average of last 15 (default) positions
- [ ] Evaluation skips if fewer than mainEvalPosCount positions exist
- [ ] During prehistoric: skip if histCount < mainMinPos
- [ ] During realtime: skip if liveCount < mainMinPos AND histCount < mainMinPos
- [ ] meanPFOfLastN is called for all BASE→MAIN comparisons
- [ ] Log shows prehistoric completion before realtime cycle begins
- [ ] Dashboard shows "Prehistoric" phase completing 100% first
- [ ] No race conditions between historic data loading and realtime execution

## Implementation Status

**Currently**: 
- Prehistoric loads in background (non-blocking)
- Realtime starts immediately
- MAX average PF used (not last X positions)
- Gate logic allows bypass with historic data

**Required**:
- Prehistoric must block and complete
- Realtime waits for prehistoric done signal
- USE last X positions for evaluation
- Gate applies consistently during both phases

## Recommended Actions

1. Make prehistoric loading SYNCHRONOUS/BLOCKING
2. Add explicit "prehistoric_done" check before realtime starts
3. Replace all rawAvgPF calculations with meanPFOfLastN calls
4. Fix gate logic to apply consistently
5. Add diagnostic logging for phase transitions
