# Set Status Tracking Architecture - Performance Optimization

## Overview

Instead of creating duplicate sets at each pipeline stage, we now track evaluation state on a single set object using `status` and `rejectionReason` fields. This is more performant, maintains set uniqueness, and provides pipeline visibility.

## Problem Statement

**Old Approach**: Create separate set copies for each stage
- BASE sets created from indications
- MAIN creates new sets from BASE sets (duplicates with variants)
- REAL filters MAIN sets, creates new filtered copies
- Result: Multiple versions of same logical set in memory

**Issues**:
- Memory bloat (3-4× duplication per set)
- Complex lineage tracking (parentSetKey becomes fragile)
- Unclear which version is "current"
- Hard to track why a set was rejected

## New Approach: Status Variables

Same set object flows through pipeline with status flag indicating current state:

```typescript
// Single set object
set = {
  setKey: "direction:long",
  status: "invalid",  // ← Tracks current evaluation state
  rejectionReason: "insufficient_history: 8/15",
  // ... other fields unchanged
}

// Same set, next cycle
set.status = "valid_base"
set.rejectionReason = undefined  // Now passes BASE evaluation

// Later in pipeline
set.status = "valid_real"
```

## Status Values

### Undefined
- Set has not been evaluated yet at this stage
- Initial state for newly created sets
- Means: "needs evaluation"

### "valid_base"
- Passes BASE→MAIN evaluation
- Criteria: avgProfitFactor >= minProfitFactor AND sufficient history
- Meaning: Qualified to be considered in MAIN stage
- History requirement: prevPos.count >= mainEvalPosCount (default 15)

### "valid_main"
- Passes MAIN→REAL evaluation
- Criteria: Came from valid_base + expanded with variants
- Meaning: Qualified to be considered in REAL stage
- Note: Currently set during MAIN variant expansion

### "valid_real"
- Passes REAL→LIVE evaluation
- Criteria: avgProfitFactor >= 1.4 AND avgDrawdownTime acceptable
- Meaning: Qualified for live trading consideration
- Next: Live stage ranks these by PF and selects top 500

### "invalid"
- Failed some evaluation gate
- rejectionReason field explains why
- Meaning: Will be skipped in this cycle but re-evaluated next cycle
- Key: Set is NOT deleted, just marked invalid

## Rejection Reasons

When status="invalid", rejectionReason explains why:

### In BASE→MAIN Stage
- `"insufficient_history: 8/15"` - Only 8 positions, need 15
- `"low_profitfactor: 1.1 < 1.2"` - PF below threshold
- `"high_drawdowntime: 1200 > 1000"` - Drawdown exceeds limit

### In REAL-Stage
- `"insufficient_pos_count: 5/10"` - Entry count below threshold
- `"real_low_pf: 1.3 < 1.4"` - Real-stage higher PF threshold not met
- `"real_high_ddt: 1500 > 1000"` - DDT threshold exceeded

## Settings Configuration

Both position-count thresholds are configurable via Connection Settings:

```typescript
coordination settings {
  // Strategy Main stage - ENGINE TYPE
  mainEvalPosCount: number  // Default 15
  
  // Base - STAGE TYPE  
  realEvalPosCount: number  // Default 10
}
```

Operator can adjust via:
1. Connection Settings dialog (UI)
2. Redis key: `connection_settings:{connectionId}:mainEvalPosCount`
3. Direct coordinator config override

## Pipeline Flow with Status

```
INPUT: Indications + Position Context
  ↓
CREATE BASE SETS
  status = undefined
  ↓
EVALUATE BASE→MAIN
  ├─ Check: prevPos.count >= mainEvalPosCount (15)?
  │  YES → status = "valid_base"
  │  NO  → status = "invalid", rejectionReason = "insufficient_history"
  │
  ├─ Check: avgProfitFactor >= minProfitFactor?
  │  YES → status = "valid_base"
  │  NO  → status = "invalid", rejectionReason = "low_profitfactor"
  │
  └─ Only "valid_base" sets proceed to variant expansion
  ↓
EXPAND TO MAIN VARIANTS
  Status = "valid_main" (inherited from parent valid_base)
  ↓
EVALUATE MAIN→REAL
  ├─ Check: entryCount >= realEvalPosCount (10)?
  │  YES → proceed
  │  NO  → status = "invalid", rejectionReason = "insufficient_pos_count"
  │
  ├─ Check: avgProfitFactor >= 1.4?
  │  YES → status = "valid_real"
  │  NO  → status = "invalid", rejectionReason = "real_low_pf"
  │
  └─ Apply Hedge Netting (removes some from active)
  ↓
LIVE STAGE
  Selects top 500 "valid_real" sets
  Ranks by avgProfitFactor
  Executes on exchange
  ↓
NEXT CYCLE
  Sets with "invalid" status re-evaluated
  (May become "valid" if history now sufficient)
```

## Benefits

### Performance
- Single set object, no duplication
- Reduced memory usage (no parallel copies)
- Faster lineage tracking (no parentSetKey chains)
- Easier to cache

### Clarity
- Status directly shows pipeline position
- rejectionReason explains pipeline logic
- Dashboard can show "why delayed"
- Logs can trace evaluation flow

### Correctness
- Set identity preserved through pipeline
- No risk of mixed versions
- Easier to test pipeline logic
- Status immutability enforced

### Extensibility
- Easy to add more status values later
- Simple to track per-stage metrics
- Can add timestamps to status changes
- Better audit trail

## Database Operations

### Persist Sets
```typescript
// Settings key
const key = `strategies:${conn}:${symbol}:main:sets`
// Value includes sets with all status values
await setSettings(key, { sets: baseSets.map(s => ({
  ...s,
  status,     // Save current status
  rejectionReason  // Save reason for debugging
}))})
```

### Query Sets by Status
```typescript
// Find all valid sets ready for REAL
const validForReal = sets.filter(s => s.status === "valid_real")

// Find all invalid sets (for logging/debugging)
const invalid = sets.filter(s => s.status === "invalid")

// Find sets delayed by specific reason
const noHistory = sets.filter(s => 
  s.rejectionReason?.includes("insufficient_history")
)
```

### Regenerate on Next Cycle
```typescript
// Sets from previous cycle still have old status
const oldSets = await loadMainSets()

// New cycle evaluation updates status
for (const set of oldSets) {
  const posCount = Math.max(set.entryCount, set.prevPos?.count ?? 0)
  if (posCount >= mainEvalPosCount) {
    set.status = "valid_base"  // Now qualifies!
    set.rejectionReason = undefined
  }
}
```

## Example: Insufficient History Flow

### Cycle 1: New Strategy
```
Set: {
  setKey: "direction:long",
  prevPos: { count: 5 },  // Only 5 closed positions
  status: "invalid",
  rejectionReason: "insufficient_history: 5/15"
}
// Skipped in MAIN evaluation
```

### Cycle 2: After 10 More Positions Close
```
Same Set (updated from previous cycle):
{
  setKey: "direction:long",
  prevPos: { count: 15 },  // Now has 15 positions!
  status: "valid_base",   // NOW QUALIFIES
  rejectionReason: undefined  // No longer rejected
}
// Now included in MAIN variant expansion
```

## Configuration Example

```typescript
// Connection Settings (UI)
Strategy Main (Engine Type):
  mainEvalPosCount: 15  // "Evaluate BASE→MAIN only with 15+ positions"
  Tooltip: "Minimum closed positions before BASE→MAIN evaluation"

Base (Stage Type):
  (mainEvalPosCount inherited from Strategy Main)

REAL Stage:
  realEvalPosCount: 10
  Tooltip: "Minimum entries before MAIN→REAL evaluation"
```

## Backward Compatibility

Existing code still works because:
- status field is optional (undefined is valid)
- Existing logic checks status implicitly
- Can be added without changing interfaces
- No database schema changes required

## Testing Strategy

1. **Status Progression**: Verify set moves through status correctly
2. **History Threshold**: New strategy with < 15 pos stays "invalid"
3. **History Recovery**: After 15 pos, becomes "valid_base"
4. **Reason Clarity**: rejectionReason matches actual rejection
5. **No Duplication**: Same set object throughout (via === comparison)

## Metrics & Dashboard

### New Dashboard Metrics

Per-symbol status breakdown:
```
Status Summary
├─ valid_base: 42 (ready for MAIN expansion)
├─ valid_main: 156 (in MAIN, ready for REAL eval)
├─ valid_real: 89 (ready for LIVE execution)
├─ invalid: 23
│  ├─ insufficient_history: 15
│  ├─ low_profitfactor: 5
│  └─ high_drawdowntime: 3
```

Rejection reason breakdown shows where sets are bottlenecked.

## Conclusion

Status tracking provides:
1. **Performance**: Single set object, no duplication
2. **Clarity**: Status directly shows pipeline position
3. **Visibility**: Dashboard can explain delays
4. **Correctness**: Immutable lineage, no version confusion
5. **Extensibility**: Easy to add new status values

This is the optimal approach for managing set lifecycle through the evaluation pipeline while maintaining efficiency and code clarity.
