# Soft Reset Guide - Database Reset with Coordination Framework Preservation

## Overview

The system supports a **soft reset** operation that clears all runtime data and strategy progression while preserving:
1. Exchange connection credentials
2. Operator settings and configuration
3. Strategy coordination framework
4. Migration history

This allows you to start fresh strategy runs without losing your infrastructure or credentials.

## Soft Reset vs Full Reset

### Soft Reset (Recommended for most use cases)
**Endpoint**: `POST /api/admin/clear-progressions`

**What it clears:**
- All strategy sets (BASE, MAIN, REAL, LIVE)
- Position data and open orders
- Trade history
- Progress tracking
- Live trading state

**What it preserves:**
- Exchange connection credentials (`connection:*`)
- Operator settings (`settings:*`, `app_settings:*`)
- Migration markers (`migration:*`, `_schema_version`)
- **Strategy coordination framework:**
  - `axis_pos_acc:*` - Axis position accumulation ledgers
  - `real_pi_acc:*` - Real PI accumulation structures
  - `progression:*` - Progression metadata
  - `strategy_count:*` - Strategy count tracking

**Use cases:**
- Starting a new backtesting run
- Testing strategy changes
- Clearing old positions while keeping system operational
- Quick reset without losing credentials

**Result:**
- ~95% of data cleared
- ~5% preserved (coordination infrastructure)
- Strategy engine ready for fresh start
- Credentials, settings, and framework intact

### Full Reset
**Endpoint**: `POST /api/install/database/reset`

**What it clears:**
- EVERYTHING - entire Redis keyspace flushed
- All keys deleted
- All migrations re-run from scratch

**What it preserves:**
- Nothing (complete wipe)

**Use cases:**
- Migrating to production
- Resolving corrupted database state
- Resetting to factory defaults

**Result:**
- Completely clean slate
- Must re-run all migrations
- Must re-enter all credentials
- Takes 2-3 minutes to rebuild

## Using Soft Reset

### API Call

```bash
# Clear all runtime data while preserving coordination framework
curl -X POST http://localhost:3002/api/admin/clear-progressions

# Response:
{
  "success": true,
  "message": "Cleared 15,847 runtime keys. 182 protected (credentials/settings/migrations) preserved.",
  "totalRemoved": 15847,
  "removed": {
    "strategies:*": 14430,
    "positions:*": 45,
    "trades:*": 892,
    "orders:*": 480
  },
  "protectedSkipped": 182,
  "startingKeyCount": 16029,
  "endingKeyCount": 182,
  "durationMs": 1247
}
```

### From Dashboard

The QuickStart panel includes a "Reset DB" button that calls this endpoint and displays the results.

## Data Structure After Soft Reset

### Preserved Coordination Framework

```
axis_pos_acc:{connId}
  ├─ {parentKey|axisKey}: continuous_count
  └─ [Multiple axis tuples with accumulation]

real_pi_acc:{connId}
  ├─ {parentKey}: accumulated_positions
  └─ [PI accumulation per parent base]

progression:{connId}:metadata
  ├─ created_at: ISO timestamp
  ├─ last_cycle: ISO timestamp
  ├─ total_base_created: 0 (reset)
  ├─ total_main_created: 0 (reset)
  ├─ total_real_created: 0 (reset)
  └─ total_live_created: 0 (reset)

strategy_count:{connId}
  └─ Current count marker (cleared)
```

### Cleared Strategy Data

All `strategies:*` keys are deleted:
- `strategies:{conn}:{symbol}:base:sets` - CLEARED
- `strategies:{conn}:{symbol}:main:sets` - CLEARED
- `strategies:{conn}:{symbol}:real:sets` - CLEARED
- `strategies:{conn}:{symbol}:live:sets` - CLEARED

### Preserved Connection Records

```
connection:{connId}
  ├─ api_key: [preserved]
  ├─ api_secret: [preserved]
  ├─ name: [preserved]
  └─ is_live_trade: 0 (reset)

settings:*
  └─ All operator settings preserved
```

## Expected Workflow After Soft Reset

1. **Reset triggered** → 15,000+ runtime keys deleted, coordination preserved
2. **Engine stopped** → Trade engine halted gracefully
3. **Settings preserved** → Operator configuration intact
4. **Connections ready** → Exchange credentials available
5. **Start fresh run** → Strategy coordinator can begin new cycle
   - Reads base definitions
   - Creates new axis sets with synthetic entries
   - Rebuilds position accumulation from scratch
   - Progression ladder starts at BASE → MAIN → REAL

## Important Notes

### The Coordination Framework
The preserved framework enables:
- Axis position accumulation tracking per axis tuple
- Real PI accumulation per parent base
- Progression metadata for cycle tracking
- All structures persist across reset

### Fresh Start Semantics
After soft reset:
1. `strategy_count` is cleared - safe
2. `strategies:*` sets are all deleted - clean
3. `pi_history:*` structure preserved but empty - safe
4. `axis_pos_acc:*` ledgers empty - ready for fresh accumulation
5. New progression run starts from BASE stage

### Position History Preservation
Position history structure is preserved (not deleted), enabling:
- Consistent position tracking across resets
- Per-axis continuous counting to persist
- No data loss in the coordination ledger

## API Reference

### POST /api/admin/clear-progressions

**Purpose**: Soft reset - clear runtime data while preserving coordination framework

**Query Parameters**: None

**Request Body**: Empty

**Response**:
```typescript
{
  success: boolean              // true if successful
  message: string               // Human-readable summary
  totalRemoved: number          // Total keys deleted
  removed: Record<string, number>  // Per-bucket breakdown
  protectedSkipped: number      // Keys preserved
  startingKeyCount: number      // Keys before reset
  endingKeyCount: number        // Keys after reset
  durationMs: number            // Operation duration
  engineStopError?: string      // If engine stop failed (non-fatal)
}
```

**Example Response**:
```json
{
  "success": true,
  "message": "Cleared 15,847 runtime keys. 182 protected preserved.",
  "totalRemoved": 15847,
  "removed": {
    "strategies:*": 14430,
    "positions:*": 45,
    "real_pi_acc:*": 0,
    "progression:*": 0
  },
  "protectedSkipped": 182,
  "startingKeyCount": 16029,
  "endingKeyCount": 182,
  "durationMs": 1247
}
```

### Utility Function: softResetWithCoordinationPreserved()

Located in `lib/redis-db.ts`

```typescript
export async function softResetWithCoordinationPreserved(): Promise<{
  deleted: number
  protected: number
  buckets: Record<string, number>
}>
```

Use this in custom scripts or operations that need soft reset functionality.

## Troubleshooting

### Reset appears to have no effect
- Check that the response shows `totalRemoved > 0`
- Verify dev server hot-reloaded (check console)
- Confirm Redis snapshot was saved (check logs for "persistNow")

### Engine doesn't restart after reset
- The engine is intentionally stopped after reset
- Use the Dashboard "Start" button to begin fresh run
- Check trade-engine logs if engine fails to start

### Position history shows old data
- Position history structure is preserved, only strategy sets are cleared
- Old positions aren't deleted, they persist in `pi_history:*`
- This is intentional for tracking continuity

### Need to reset everything including credentials
- Use `POST /api/install/database/reset` instead (full reset)
- Warning: This requires re-entering all connection credentials

## Summary

The soft reset endpoint provides:
- ✅ Quick runtime data clearing
- ✅ Preserved coordination framework
- ✅ Preserved credentials and settings
- ✅ Safe for development iteration
- ✅ No credentials to re-enter
- ✅ Engine ready for fresh start

Use soft reset for daily development work, and full reset only when you need a complete factory reset.
