# Crash Prevention and Issue Fixes - Comprehensive Plan

## Critical Issues Identified

### 1. Axis Sets Missing Live Continuous Count
**Issue**: Axis Sets created with static `entryCount = baseEC + cont` ignoring actual live positions
**Impact**: Dashboard under-reports axis sets, Real-stage tuner can't mutate them
**Status**: NEEDS FIX

### 2. Hedge Netting Crosses Base Set Boundaries  
**Issue**: `bucketKey` doesn't include `parentSetKey`, conflates different Base configs
**Impact**: Long/short netting incorrectly cancels Sets from different Base indications
**Status**: NEEDS FIX

### 3. Missing Per-Axis Accumulation Ledger
**Issue**: No persistent tracking of continuous PI count per axis bucket
**Impact**: Dashboard can't show "how many Pis accumulated into axis bucket"
**Status**: NEEDS FIX

### 4. Live Continuous Count Not Pushed to Axis Sets
**Issue**: Existing axis Sets keep stale `entryCount` when new positions open mid-run
**Impact**: Count doesn't reflect current open positions
**Status**: NEEDS FIX

### 5. MainEvaluated Counter Exceeds Main Sets
**Issue**: Evaluated counters not reset between runs, may be cumulative
**Impact**: Stats show impossible constraint violation (eval > sets)
**Status**: NEEDS FIX

### 6. Stats Endpoint Data Validation Missing
**Issue**: No validation that `evaluated[stage] <= sets[stage]`
**Impact**: Invalid stats returned to dashboard
**Status**: NEEDS FIX

### 7. Error Handling in Pipeline Incomplete
**Issue**: Some pipeline stages lack try-catch blocks
**Impact**: Single error crashes entire flow
**Status**: NEEDS FIX

### 8. Redis Key Expiration Not Set Universally
**Issue**: Some keys persist indefinitely without TTL
**Impact**: Memory bloat, stale data accumulation
**Status**: NEEDS FIX

### 9. Division by Zero Risks
**Issue**: `sumPF / count`, `sumDDT / count` without zero checks
**Impact**: NaN values in stats
**Status**: NEEDS FIX

### 10. Type Safety Issues
**Issue**: Optional chaining not everywhere, missing null checks
**Impact**: Potential undefined reference crashes
**Status**: NEEDS FIX

## Fixes to Implement

### Fix 1: Reset Evaluated Counters on Engine Startup
- Clear `strategies:${connId}:*:evaluated` keys when engine starts
- Initialize to 0 instead of reading stale values
- Validate before returning in stats

### Fix 2: Implement Full Axis Set Fix (Per Plan)
- Add `liveCont` parameter to `expandAxisSets`
- Create synthetic entry for axis Sets
- Update `entryCount` to `baseEC + Math.min(cont, liveCont)`
- Call at line 1499 with `ctx.continuousCount`

### Fix 3: Fix Hedge Netting Bucket Key
- Include `parentSetKey` in bucket identification
- Ensure long/short netting stays within same Base

### Fix 4: Add Per-Axis Accumulation Ledger
- Create `bumpAxisPosAccumulation` in pi-history.ts
- Call from Real tuner for each axis Set
- Track continuous count per axis bucket

### Fix 5: Add Constraint Validation
- Validate `evaluated[stage] <= sets[stage]` in stats endpoint
- Return error if constraint violated
- Log warning and use safe defaults

### Fix 6: Enhance Error Handling
- Add try-catch blocks around all Redis operations
- Add try-catch around pipeline stages
- Proper error logging and recovery

### Fix 7: Add Universal TTL
- Set 7-day TTL on all tracking HASHes
- Use Redis `EXPIRE` command uniformly
- Prevent memory leaks

### Fix 8: Fix Division by Zero
- Replace `sumPF / count` with `count > 0 ? sumPF / count : 0`
- Same for `sumDDT / count`, `passedCount / totalCount`
- Add guard everywhere division is used

### Fix 9: Add Type Safety
- Use `??` for null coalescing everywhere
- Add explicit null checks for optional fields
- Use type guards for discriminated unions

### Fix 10: Add Stats Validation
- Validate all derived metrics
- Check for NaN, Infinity, negative values
- Sanitize before returning

## Implementation Order

1. Error Handling Enhancements (prevent crashes)
2. Constraint Validation (catch bad states)
3. Division by Zero Guards (prevent NaN)
4. Type Safety (prevent undefined crashes)
5. Evaluated Counter Reset (fix stats)
6. Axis Set Fixes (per comprehensive plan)
7. Per-Axis Ledger (per comprehensive plan)
8. TTL Universalization (prevent memory leaks)

## Files to Modify

1. `lib/strategy-coordinator.ts` - Main logic fixes
2. `lib/pi-history.ts` - New accumulation ledger
3. `app/api/connections/progression/[id]/stats/route.ts` - Stats validation
4. `app/api/trade-engine/start-all/route.ts` - Counter reset on startup

## Testing Strategy

1. Run engine with `continuousCount = 0` → no crash
2. Open 3 positions, run again → no crash, stats update
3. Multiple Base Sets with same axis → verify netting stays independent
4. Run for 1 hour → verify no memory leak, no stale data
5. Dashboard stats → verify no impossible values
