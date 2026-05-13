# Pause State Coordination Fixes

## Problem
Progressions and engines were automatically restarting from various intervals even when the global coordinator was paused. This caused an inconsistent state where the dashboard showed the system as paused, but in the background engines/progressions continued running.

## Root Causes Identified & Fixed

### 1. Auto-Start Monitor Ignoring Pause State
**File**: `lib/trade-engine-auto-start.ts`

**Issue**: The healing sweep ran every 30 seconds and would auto-resurrect engines to "running" status without checking if the coordinator was paused.

**Fix**: Added pause state check before the healing sweep:
```typescript
// Skip healing sweep if paused
if (currentStatus === "paused") {
  if (isStartup) {
    console.log("[v0] [AutoStart] Startup sweep skipped: global coordinator is paused...")
  }
  return  // Skip entire sweep
}
```

This ensures engines remain stopped when coordinator is paused.

### 2. Interval Progression Manager Running During Pause
**File**: `lib/interval-progression-manager.ts`

**Issue**: Interval callbacks were executing on their schedule without checking pause state, causing progressions to continue running.

**Fix**: Added pause state check at the beginning of each interval iteration:
```typescript
// Check if coordinator is paused
try {
  await initRedis()
  const client = getRedisClient()
  const globalState = await client.hgetall("trade_engine:global")
  if ((globalState as any).status === "paused") {
    return  // Skip iteration silently
  }
} catch (err) {
  console.warn("[v0] Failed to check pause state, skipping for safety")
  return
}
```

This stops progressions from advancing during pause without disrupting the interval itself.

### 3. Start Missing Engines Ignoring Pause
**File**: `lib/trade-engine.ts` - `startMissingEngines()` method

**Issue**: The coordinator would start any missing engines without checking pause state, re-starting engines that were paused.

**Fix**: Added pause check at method entry:
```typescript
// Check if coordinator is paused
const { getRedisClient, initRedis } = await import("@/lib/redis-db")
try {
  await initRedis()
  const client = getRedisClient()
  const globalState = await client.hgetall("trade_engine:global")
  if ((globalState as any)?.status === "paused") {
    console.log("[v0] Skipping startMissingEngines - coordinator is paused")
    return 0
  }
} catch (err) {
  console.warn("[v0] Could not check pause state:", ...)
  // Continue anyway - non-critical
}
```

## State Coordination Flow

### When Pausing Global Coordinator
1. `/api/trade-engine/pause` sets `trade_engine:global.status = "paused"`
2. Auto-start monitor detects pause on next 30-second sweep and skips healing
3. Interval progressions detect pause and skip callbacks
4. `startMissingEngines()` returns 0 immediately on next call

### When Resuming Global Coordinator
1. `/api/trade-engine/resume` restores `trade_engine:global.status` from `previous_status`
2. Auto-start monitor detects running status on next sweep and can start engines
3. Interval progressions detect running status and resume callbacks
4. `startMissingEngines()` can start engines again on next call

## Testing Checklist
- [ ] Pause coordinator → verify engines stop progressing
- [ ] Check system-stats API shows "paused" status
- [ ] Wait 30+ seconds → verify auto-start monitor didn't restart engines
- [ ] Resume coordinator → verify engines resume progressions
- [ ] Verify progressions counter increases after resume

## Related Changes
- `app/api/trade-engine/pause/route.ts` - Sets pause state with previous_status tracking
- `app/api/trade-engine/resume/route.ts` - Restores previous status on resume
- `app/api/main/system-stats-v3/route.ts` - Overrides all statuses to "paused" when coordinator paused
- `components/dashboard/system-overview.tsx` - Shows "paused" status with amber color
