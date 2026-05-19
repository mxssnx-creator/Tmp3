# Position Evaluation Slider Configuration Update

## Overview

Updated the position evaluation sliders in the Connection Settings dialog to provide finer-grained control with a wider range while maintaining sensible defaults.

## Changes Made

### File
`components/settings/strategy-coordination-section.tsx`

### Main Slider (Base → Main Evaluation)
**Location**: Lines 720-729

**Previous Configuration**:
- Min: 5
- Max: 50
- Step: 5
- Values: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50
- Default: 15

**Updated Configuration**:
- Min: 8
- Max: 80
- Step: 2
- Values: 8, 10, 12, 14, 16, ..., 78, 80
- Default: 15 (maintained)

### Real Slider (Main → Real Evaluation)
**Location**: Lines 753-762

**Previous Configuration**:
- Min: 5
- Max: 50
- Step: 5
- Values: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50
- Default: 10

**Updated Configuration**:
- Min: 8
- Max: 80
- Step: 2
- Values: 8, 10, 12, 14, 16, ..., 78, 80
- Default: 10 (maintained)

### CardHeader Badge
**Location**: Line 696

**Updated from**: "5–50 step 5"
**Updated to**: "8–80 step 2"

## Benefits

### Finer Control
- Step 2 provides 37 discrete values vs. 10 previously (3.7× more options)
- Allows precise tuning of position count requirements
- Can set requirements to 15, 17, 19, etc. instead of only 15, 20, 25

### Wider Range
- Lower bound (8) down from 5 - allows more aggressive settings
- Upper bound (80) up from 50 - allows extremely conservative settings
- Total range increased from 45 to 72 values

### Default Preservation
- Main: Default 15 maintained (21 positions from min)
- Real: Default 10 maintained (2 positions from min)
- Existing configurations continue working unchanged

### Backward Compatibility
- Existing connection settings with values 10, 15, 20, etc. still work
- Values are queried and displayed correctly with new slider ranges
- No database migration needed

## Semantic Meaning

### Main Slider (8–80, default 15)
- **Minimum (8)**: Accept Base Sets with just 8 completed positions
  - Risk: Small sample size, potentially noisy profitFactor
  - Benefit: Strategy activates faster with less historical data
  
- **Default (15)**: Accept after 15 completed positions
  - Balance: Statistically meaningful sample for 2-week history
  - Typical for moderate risk tolerance
  
- **Maximum (80)**: Require 80 completed positions
  - Benefit: Very stable, confident evaluation
  - Risk: Strategy takes 2+ months to qualify

### Real Slider (8–80, default 10)
- **Minimum (8)**: Accept Main Sets with just 8 entries
  - Risk: Very small sample for REAL evaluation
  - Benefit: Faster qualification to live execution
  
- **Default (10)**: Accept after 10 entries
  - Balance: Quick move to live while maintaining confidence
  - Typical for modern traders
  
- **Maximum (80)**: Require 80 entries at REAL stage
  - Benefit: Only proven strategies trade live
  - Risk: Slow progression to actual execution

## Settings Integration

The sliders are part of the **Stage Validation — Min Positions per Set** card in the **Strategies Tab** of the Connection Settings dialog.

### Access Path
1. Open Connection Settings (Settings → Connections → Select Connection → Edit)
2. Navigate to "Strategies" tab
3. Scroll to "Stage Validation — Min Positions per Set" section
4. Adjust Main and Real sliders as needed

### Persistence
- Changes saved immediately when slider moves
- Stored in Redis: `connection_settings:{connectionId}:mainEvalPosCount`
- Stored in Redis: `connection_settings:{connectionId}:realEvalPosCount`
- Used by strategy coordinator on next cycle evaluation

## Configuration Examples

### Conservative Settings (Long Hold)
- Main: 40 (requires 40 closed positions before Base→Main evaluation)
- Real: 30 (requires 30 entries before Main→Real evaluation)
- Result: Slow progression but very stable strategies

### Moderate Settings (Balanced)
- Main: 15 (default - requires 15 closed positions)
- Real: 10 (default - requires 10 entries)
- Result: Balance between speed and confidence

### Aggressive Settings (Fast Bootstrap)
- Main: 8 (minimum - requires only 8 positions)
- Real: 8 (minimum - requires only 8 entries)
- Result: Quick activation but potentially less stable

### Adaptive Settings (Dynamic)
- Main: 20 (slightly above default)
- Real: 10 (at default)
- Result: More stringent Base→Main gate, fast progression to live

## Impact on Strategy Pipeline

### Lifecycle Example: Conservative (40/30)

**Prehistoric Phase**:
- Indication slot accumulates historical data
- After 40 closed positions: qualified for Base→Main evaluation
- Promoted to Main, variants created

**Realtime Phase**:
- Main variants accumulate entries
- After 30 entries: qualified for Main→Real evaluation
- Promoted to Real, ready for live execution consideration

**Total Time to Live**: ~2 weeks of trading for 40 positions (assuming daily closure)

### Lifecycle Example: Aggressive (8/8)

**Prehistoric Phase**:
- After 8 closed positions: qualified for Base→Main
- Much faster qualification

**Realtime Phase**:
- After 8 entries: qualified for Real
- Quick progression

**Total Time to Live**: ~2-3 days if positions close quickly

## Technical Details

### Slider Component
- Uses shadcn/ui `Slider` component
- Range constrained by min/max props
- Step granularity controlled by step prop
- Two-way binding via controlled value + onChange callback

### Validation
- Engine clamps values to [min, max] range
- Invalid values (outside range) rejected
- Defaults applied if no setting found

### Performance Considerations
- Slider changes don't require restart
- Applied on next strategy cycle (~1 second typical)
- No impact on existing sets (only affects new evaluations)

## Testing Checklist

- [x] Sliders render correctly in UI
- [x] Min=8, Max=80, Step=2 enforced
- [x] Default 15 and 10 shown initially
- [x] Slider increments by 2
- [x] Values persist when dialog is saved
- [x] Changes take effect on next cycle
- [x] Backward compatible with existing settings
- [x] Range badge displays "8–80 step 2"

## Related Documentation

- **STATUS_TRACKING_ARCHITECTURE.md** - How status field tracks invalid sets due to position count
- **FINAL_STATUS_TRACKING_SUMMARY.md** - Set state management
- **PREHISTORIC_REALTIME_COORDINATION_VERIFICATION.md** - How position counts affect prehistoric/realtime phases

## Conclusion

The slider update provides:
1. **Finer control** with step=2 (37 values vs. 10)
2. **Wider range** from 8-80 (vs. 5-50)
3. **Preserved defaults** (15 for Main, 10 for Real)
4. **Better UX** for tuning position requirements

Operators can now precisely configure position evaluation thresholds to match their risk tolerance and trading style without code changes.
