# Complete Data Semantics Verification - System-Wide

## Dashboard Display Requirements (What Should Be Shown)

### BASE Stage Display
**What it shows**: "Base" row in the dashboard
- **Sets**: Number of base sets created from indications
  - Semantic: One set per (indication_type × direction) combination
  - Should equal: Number of distinct indication signals received
  - Source Redis: `strategies:{connId}:base:count` or `strategies_active:{connId}:{symbol}:base`
  
- **Eval (evaluated)**: How many base sets were evaluated/assessed
  - Semantic: All base sets created (100% of base sets are evaluated)
  - Should equal: Base sets count
  - Source Redis: `strategies:{connId}:base:evaluated`

- **PF (Profit Factor)**: Average profit factor of base sets
- **DDT (Drawdown Time)**: Average drawdown time

### MAIN Stage Display  
**What it shows**: "Main" row in the dashboard
- **Sets**: Total sets in Main stage
  - Semantic: All base sets + additional variants/axis sets created
  - Flow: Base sets → Main filter (PF/DDT) → [output = Main sets]
  - Additional: Each base set can spawn axis sets (for each position count)
  - Should equal: Base sets that survived Main filter + new axis/variant sets created
  - Source Redis: `strategies:{connId}:main:count` or `strategies_active:{connId}:{symbol}:main`

- **Eval (evaluated)**: Sets evaluated in Main stage
  - Semantic: "How many sets did Main evaluate?" = Input count
  - Should equal: Base sets (all base sets are evaluated by Main)
  - Should be: <= Base sets (only if filtering happened)
  - Source Redis: `strategies:{connId}:main:evaluated`

- **Created**: New sets created in Main beyond base
  - Semantic: Axis sets, variant sets, additional configurations
  - Should equal: Main sets - Base sets (approximately)

### REAL Stage Display
**What it shows**: "Real" row in the dashboard  
- **Sets**: Total sets in Real stage after filtering and netting
  - Semantic: Main sets that survived Real filter (PF >= 1.4, hedge-netted)
  - Flow: Main sets → Real filter (PF >= 1.4) → [hedge-net long/short] → Real sets
  - Should equal: Main sets that passed PF threshold minus hedge-netted pairs
  - Source Redis: `strategies:{connId}:real:count`

- **Eval (evaluated)**: Sets evaluated by Real stage  
  - Semantic: "How many sets did Real evaluate?" = Input count
  - Should equal: Main sets (all main sets fed to Real filter)
  - Should be: >= Real sets (evaluation count >= passed count)
  - Source Redis: `strategies:{connId}:real:evaluated`

- **Accumulated**: Sets removed via hedge netting
  - Semantic: Long/short pairs that cancelled each other
  - Should equal: Main sets - Real sets (approximately)

### PosEval Display
**What it shows**: "PosEval" row in the dashboard
- **avg**: Average position evaluation score
  - Semantic: Average confidence/validity of positions
  - Should be: >= 1.4 threshold (if sets passed Real filter)
  - If shown as 0.600: WRONG - indicates positions don't meet threshold
  - Should show: 0 (no position data) OR >= 1.4 (valid positions)

## Current System State Issues

### Issue 1: BASE eval showing as 1 instead of actual base count
- Dashboard shows: eval=1
- Should show: eval=5 (if 5 base sets created)
- Cause: Standalone key writes might be from previous cycle

### Issue 2: MAIN eval showing as 4 instead of actual input count
- Dashboard shows: eval=4
- Should show: eval=base_sets_count (typically 5-10 for 2 symbols)
- Cause: Standalone key writes are being overwritten by each symbol sequentially

### Issue 3: REAL eval showing as 4,800 (IMPOSSIBLE, exceeds set count)
- Dashboard shows: eval=4,800
- Real sets: 2,400
- Should be: eval <= 2,400 always
- Cause: Was writing mainSets.length instead of realSets.length (FIXED)

### Issue 4: PosEval showing 0.600 (below threshold)
- Should be: >= 1.4 for valid positions OR 0 if no positions
- Cause: Averaging invalid position data or wrong metric

## Fix Applied (Already Completed)

Line 1647 (MAIN): Now correctly writes `mainSets.length`
Line 2345 (REAL): Now correctly writes `realSets.length`

## Remaining Issues to Verify

1. **Standalone keys vs active keys** - When multiple symbols run in parallel:
   - Each symbol overwrites `strategies:{connId}:{type}:count`
   - This gives last-symbol-wins, not cross-symbol total
   - Should use `strategies_active:{connId}` hash (already implemented in stats API)

2. **Dashboard logic for displaying eval vs created**:
   - eval = how many sets were evaluated (input to stage)
   - created = additional sets created in this stage
   - Should show eval and created separately, not confused

3. **Hedge netting accuracy**:
   - Per-Base isolation: bucketKey must include parentSetKey
   - Long/short pairing: only cancel same configuration sets
   - Accumulated count: main sets - real sets

## Verification Checklist

- [ ] BASE stage: eval count = number of base sets created
- [ ] MAIN stage: eval count = base sets fed to Main (should equal base count)
- [ ] REAL stage: eval count = main sets fed to Real (should equal main count)  
- [ ] All eval counts logical: eval <= input_stage_count
- [ ] Real eval <= Main sets (no more eval than input)
- [ ] PosEval avg >= 1.4 or shows 0
- [ ] Accumulated sets = Main sets - Real sets (hedge netting)
- [ ] Created sets = Main sets - Base sets (variants + axis)
- [ ] Cross-symbol totals working (using strategies_active hash)
- [ ] Cumulative counters not used as current count

## Expected Output After All Fixes

```
Base:     sets=5    eval=5    
Main:     sets=2400 eval=5    created=2395
Real:     sets=2400 eval=2400 accumulated=0
PosEval:  avg=1.42
```

This shows:
- 5 base sets created and all evaluated
- 2,400 main sets (5 base + 2,395 new axis/variants)
- All 5 base fed to Main → 2,400 Main sets created/evaluated
- All 2,400 Main fed to Real → 2,400 Real sets survived filter (no netting)
- PosEval avg of 1.42 passes the >= 1.4 threshold
- All counts are logical and non-contradictory
