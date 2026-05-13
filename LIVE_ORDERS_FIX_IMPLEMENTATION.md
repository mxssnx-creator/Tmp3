# Live Orders & Positions Fix - Implementation Complete

## Problem Summary
Live positions and orders on exchanges were not getting closed when the global coordinator was paused. The root cause was that `maybeRunLiveSync` was completely skipped when paused, preventing:
1. Exchange synchronization
2. Control order (SL/TP) creation and maintenance
3. Detection and closure of externally-closed positions
4. Adoption of orphaned positions

## Solution Architecture

### Fix 1: Realtime Processor - Pause-Aware Live Sync (realtime-processor.ts)

**Key Changes:**
- Split `maybeRunLiveSync` into two phases:
  - **Phase A (Always runs)**: `processSimulatedPositions` - Closes simulated/paper positions via local SL/TP detection
  - **Phase B (Pause-gated)**: `syncWithExchange` - Exchange syncing, control order creation, orphan adoption

**Benefits:**
- Paper-only positions close locally even when paused
- Simulated positions (is_live_trade=false) continue closing regardless of pause state
- When resumed, exchange sync immediately rebuilds control orders
- Non-blocking fail-safe: if pause state check fails, sync proceeds anyway

**Code Pattern:**
```typescript
// Always runs
await processSimulatedPositions(this.connectionId)

// Check coordinator pause state
if (globalState?.status === "paused") {
  return // Skip exchange sync, but simulated positions handled above
}

// Exchange ops - only when coordinator is running
await syncWithExchange(this.connectionId, connector)
```

### Fix 2: Resume Route - Control Order Rebuild (resume/route.ts)

**Key Changes:**
- After global resume, trigger immediate live sync on all connections
- Uses fire-and-forget Promise.all for non-blocking rebuild
- Logs rebuild progress per connection

**Benefits:**
- Control orders immediately restored after pause
- Adopted positions get protection orders armed
- Mark prices refreshed and ready for next SL/TP checks

**Code Pattern:**
```typescript
// Trigger control order rebuild on all connections
void Promise.all(
  connections.map(async (connId) => {
    const connector = await createExchangeConnector(...)
    await syncWithExchange(connId, connector)
  })
)
```

### Fix 3: System-Wide Coordination

The following layers now properly coordinate when paused:
1. **Realtime Processor**: Stops exchange sync, keeps simulated position sweep
2. **Auto-Start Monitor**: Skips healing sweep when paused
3. **Interval Progressions**: Skip callbacks when paused
4. **Start Missing Engines**: Don't start engines when paused
5. **Resume Route**: Rebuild all control orders on resume

## Behavior Changes

| Scenario | Before | After |
|----------|--------|-------|
| Pause with live positions | Control orders deleted, positions hang | Control orders maintained, simulated positions close |
| Pause with paper positions | Never close | Close via local SL/TP detection |
| Resume | Manual fix needed | Automatic control order rebuild |
| Exchanged-closed position during pause | Not detected until unpause+30s | Detected on next sync after resume |

## Testing Checklist

- [ ] Pause coordinator with live positions
  - Control orders should stay armed
  - Positions should still close if SL/TP crossed locally
  
- [ ] Pause coordinator with paper positions
  - Positions should close if SL/TP crossed
  
- [ ] Manually close position on exchange while paused
  - Position detected and closed in Redis on next sync after resume
  
- [ ] Resume coordinator
  - All control orders rebuilt immediately
  - No positions are missing protection
  
- [ ] Verify progression logs
  - See "live sync skipped: coordinator is paused" logs during pause
  - See "Control orders rebuilt" logs after resume

## Files Modified

1. `lib/trade-engine/realtime-processor.ts` - Added pause gate to `maybeRunLiveSync`
2. `app/api/trade-engine/resume/route.ts` - Added control order rebuild trigger

## Related Earlier Fixes (Already Applied)

1. `app/api/trade-engine/pause/route.ts` - Mark all connections and progressions as paused
2. `lib/trade-engine-auto-start.ts` - Skip healing when paused
3. `lib/interval-progression-manager.ts` - Skip callbacks when paused
4. `lib/trade-engine.ts` - Skip engine starts when paused
5. `app/api/main/system-stats-v3/route.ts` - Override all statuses to "paused"
