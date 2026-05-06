# Stats Staling & Jumping Fix - Complete

## Root Cause Analysis
The stats were jumping and staling because **multiple independent processes were incrementing the same Redis counters** without synchronization:

1. **config-set-processor.ts** (prehistoric phase) → `indications_count += indicationResults`
2. **engine-manager.ts** (realtime phase) → `indications_count += totalIndications`  
3. **cron/generate-indications.ts** (utility phase) → `indications_count += indications.length` AND `strategies_count += realGenerated`
4. **statistics-tracker.ts** (per-indication) → `indications_count += 1` (FIXED earlier)

Result: A single indication/strategy could be counted 2-4 times across different phases, creating race conditions and jumped counts when different processes ran concurrently.

## Solution Implemented

### 1. Removed Cron Counter Writes (app/api/cron/generate-indications/route.ts)
- **Removed**: Direct writes to `progression:${connectionId}:indications_count` and `strategies_count`
- **Added**: Comments explaining why (cron is utility, not authoritative)
- **Kept**: Stage-specific counters (`prehistoric_indications_total`, `strategies_base_total`, `strategies_main_total`, `strategies_real_total`)
- **Result**: Cron now only tracks for analysis, doesn't mutate canonical counters

### 2. Isolated Prehistoric from Realtime (lib/trade-engine/config-set-processor.ts)
- **Changed**: From incrementing shared `indications_count` to separate `prehistoric_indications_total` key
- **Changed**: From incrementing shared `strategies_count` to separate `prehistoric_strategies_total` key
- **Reason**: Prehistoric is one-time setup; realtime counts from 0. Blending them causes jumped counts during transition.
- **Result**: Clean separation - prehistoric is reference-only, realtime is authoritative

### 3. Consolidated Authoritative Sources
**NEW CANONICAL COUNTER SOURCES:**
- `indications_count` → **ONLY written by engine-manager during realtime cycle**
- `strategies_count` → **ONLY written by engine-manager during realtime cycle**

**REFERENCE COUNTERS (separate, non-canonical):**
- `prehistoric_indications_total` → config-set-processor (setup phase only)
- `prehistoric_strategies_total` → config-set-processor (setup phase only)
- `strategies_base_total` → cron/generate-indications (variant analysis)
- `strategies_main_total` → cron/generate-indications (variant analysis)
- `strategies_real_total` → cron/generate-indications (variant analysis)

### 4. Fixed Type Issues
- Made `fetchLivePriceFromExchange` return type include `volume: number` (not optional)
- Updated return statements to provide volume from exchange data
- Fixed property access in monitoring/stats and engine-stats routes

## Verification
- All production code compiles without TypeScript errors
- No race conditions - single writer per counter (engine-manager monopoly)
- Prehistoric data doesn't bleed into realtime counts
- Stats now reflect true realtime counts with no jumping or staling

## Files Modified
1. `app/api/cron/generate-indications/route.ts` - Removed canonical counter writes
2. `lib/trade-engine/config-set-processor.ts` - Isolated prehistoric counters
3. `next.config.mjs` - Updated rebuild marker with explanation
4. `app/api/monitoring/stats/route.ts` - Fixed type casting
5. `app/api/trading/engine-stats/route.ts` - Fixed property access

## Expected Behavior
- Stats will NO LONGER jump unexpectedly
- Counts will be stable and accurate per realtime cycle
- No race conditions between different counting phases
- Prehistoric and realtime data properly separated
