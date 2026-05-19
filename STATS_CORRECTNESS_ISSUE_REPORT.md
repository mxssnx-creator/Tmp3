# Stats Correctness Issue - Live Preview Analysis

## Issue Identified

Dashboard stats show all zeros for the test connection, but real data exists in BingX connection with a constraint violation:

### BingX X01 Real Stats (from API):
```
base: 5                    (correct - 5 indications)
main: 2405                 (sets from base + variants)
real: 2410                 (after filtering)
live: 500                  (promoted to exchange)

baseEvaluated: 117         (ok, <= base)
mainEvaluated: 2461        (ISSUE: > main sets)  ← CONSTRAINT VIOLATION
realEvaluated: 2410        (ok, <= real)
```

### The Problem

**mainEvaluated (2461) should NEVER exceed main (2405)** because:
- `mainEvaluated` = count of base sets fed to main stage (input)
- `main` = count of sets that survived main filtering (output)
- Constraint: eval <= sets (always)

This indicates one of:
1. The evaluated counter is stale/not being reset
2. The counter is being incremented but not cleared on new runs
3. The counter is reading from cumulative data instead of current snapshot

## Root Cause Analysis

Looking at stats endpoint (`/api/connections/progression/[id]/stats`):

Line 918: `client.get(`strategies:${connectionId}:${type}:evaluated`)`

The evaluated values come from a standalone Redis key `strategies:${connectionId}:evaluated`. This key:
- Is written by strategy-coordinator.ts at lines 1647, 2345 (MAIN and REAL)
- Is NOT cleared between runs
- May accumulate data or persist across cycles

## Expected Behavior

For each stage, the evaluated counter should represent:
- **baseEvaluated**: Sets fed TO base (should = base when all base sets are created)
- **mainEvaluated**: Sets fed FROM base TO main (input count to main stage)
- **realEvaluated**: Sets fed FROM main TO real (input count to real stage)

All should satisfy: `evaluated[stage] <= sets[stage]`

## The Real Issue

The evaluated keys are **cumulative** or **not being reset**. They should be:
1. Reset when a new cycle/run begins
2. Updated to reflect CURRENT pipeline state
3. Never exceed their corresponding set counts

## Data from Live Dashboard

**Test Connection**: All zeros (no engine started yet)
**BingX X01 Connection**: Real data showing:
- 5 base indications → good
- 2405 main sets → good
- 2410 real sets → good (>main due to continuous counting)
- 500 live positions → good
- BUT: mainEvaluated=2461 is impossible (exceeds main=2405)

## Fix Required

The evaluated counters need to be:
1. Reset on engine startup or cycle restart
2. Written as CURRENT snapshot, not cumulative
3. Validated to never exceed their corresponding set counts
4. OR removed from stats if they're not reliable

## Dashboard Display Issue

The dashboard showing all zeros for test connection is expected (no engine running).
The dashboard showing BingX data but not test data suggests:
- Test connection has no data/engine running
- BingX connection is active and has data
- Stats endpoint is working correctly for both

This is NOT a bug - it's expected behavior when one connection is active and another isn't.

## Stats Correctness Verification

All other metrics look correct:
- base <= main ✓ (5 <= 2405)
- main <= real (okay, can be >=) ✓ (2405 ~ 2410)
- real >= live ✓ (2410 >= 500)
- realEvaluated <= real ✓ (2410 <= 2410)
- **mainEvaluated > main ✗** (2461 > 2405) ← ISSUE

## Recommendation

1. Fix the evaluated counter logic to reset properly
2. Ensure mainEvaluated is always <= main
3. Document that evaluated counters represent "inputs fed to stage"
4. Add validation to prevent impossible state

Status: One constraint violation detected. Requires investigation and fix.
