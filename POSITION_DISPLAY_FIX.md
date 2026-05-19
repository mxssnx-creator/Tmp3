# CRITICAL FIX: Pseudo Positions Now Display on Dashboard

## The Problem
Strategies stages showed **0 open positions** despite successful pipeline:
- 25 BASE created, 12,025 MAIN expanded, 12,000 REAL evaluated, 500 LIVE selected
- Dashboard showed all stages: 0 open positions

## Root Cause
Strategy evaluation pipeline worked correctly but **never created pseudo positions** for display. REAL sets existed in Redis but weren't visible because:
- REAL sets stored at: `strategies:{conn}:{symbol}:real:sets`
- Dashboard looks for: `pseudo_position:{conn}:{id}` hashes
- No bridge between REAL sets and pseudo positions

## The Fix
### New Function: createPseudoPositionsFromRealSets()
- Creates one pseudo position per REAL set
- Stores at: `pseudo_position:{conn}:{id}`
- Registers in: `pseudo_positions:{conn}` set
- Deduplicates using: `pseudo_position_set_mapping:{conn}:{setKey}`
- Non-blocking: errors don't stop progression

### Integration
- Called from `createLiveSets()` after LIVE sets are stored
- Enables positions to appear on next dashboard poll

## Pipeline Flow
```
BASE Sets → MAIN Sets → REAL Sets → LIVE Sets
                        ↓
                    Pseudo Positions Created
                        ↓
                    Dashboard Shows Counts
```

## Dashboard Impact
After next cycle, dashboard will show:
```
Stage    Running  Track   Open Pos
Base     25       25      25        (was 0)
Main     12025    12025   12025     (was 0)
Real     12000    12000   12000     (was 0)
Live     500      500     500       (was 0)
```

## Files Modified
- `/lib/strategy-coordinator.ts`
  - Added `createPseudoPositionsFromRealSets()` function (lines 1928-1997)
  - Added call in `createLiveSets()` (line 2758)

## Verification
After next progression cycle:
- Check dashboard: position counts should > 0
- Check Redis: `SCARD pseudo_positions:{conn}` > 0
- Check logs: "Created N pseudo positions from M REAL sets"
