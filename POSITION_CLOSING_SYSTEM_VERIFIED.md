# COMPREHENSIVE POSITION CLOSING SYSTEM AUDIT

## System Architecture

The position closing system has **FIVE independent mechanisms**:

### 1. Local SL/TP Cross Detection (checkAndForceCloseOnSltpCross)
- **Location**: lib/trade-engine/stages/live-stage.ts line 2773
- **Mechanism**: Compares current markPrice against configured SL/TP levels
- **Trigger**: Every realtime tick and every reconcile cycle
- **Runs Even If**: Exchange connector unavailable, control orders missing
- **Guarantees**: Positions close immediately when price crosses SL/TP
- **Backup**: Uses Redis market_data when exchange markPrice unavailable

### 2. Simulated Positions Sweep (processSimulatedPositions)
- **Location**: lib/trade-engine/stages/live-stage.ts line 2780-2840
- **Mechanism**: Paper-trade positions close purely via local SL/TP detection
- **Runs**: Every realtime tick, every reconcile cycle
- **Independent Of**: Exchange connector, control orders, API connectivity
- **Handles**: All positions with is_live_trade=false or paper-only
- **Result**: Paper positions never orphaned even if exchange unreachable

### 3. Max Hold Time Enforcement (max_hold_time_exceeded)
- **Location**: lib/trade-engine/stages/live-stage.ts line 3166-3190
- **Mechanism**: Force-close any position held longer than MAX_HOLD_TIME_MS
- **Runs**: Every reconcile cycle
- **Safety**: Prevents positions from staying open indefinitely
- **Fallback**: Orphan-close path for positions with no connector

### 4. External Close Detection (position vanished from exchange)
- **Location**: lib/trade-engine/stages/live-stage.ts line 3194-3280
- **Mechanism**: Detects when exchange no longer returns a position
- **Indicates**: Position was closed externally (SL/TP fired, liquidated, manual)
- **Action**: Computes realized PnL, cleans orphan protection orders, archives
- **Safety**: Best-effort market-close on exchange for edge cases

### 5. Orphan Close on Connector Failure (orphanCloseExpiredPositions)
- **Location**: lib/trade-engine/stages/live-stage.ts line 2891-2945
- **Mechanism**: When exchange.getPositions() fails or connector unavailable
- **Action**: Force-closes all positions exceeding max hold time
- **Reason**: "orphan_no_connector" (audit trail)
- **Guarantees**: Positions never stranded open indefinitely if exchange unreachable

## Key Safety Features

### Always-Run Simulated Position Sweep
- Even if `maybeRunLiveSync` skips exchange sync during pause
- Even if exchange connector fails/unavailable
- Paper positions ALWAYS close properly on every tick

### Fallback Price Resolution (5-tier priority)
1. exchangeConnector.markPrice (current mark from exchange)
2. pos.averageExecutionPrice (confirmed fill price)
3. Redis market_data:{symbol} (most recent tick)
4. pos.entryPrice (last resort, pnl=0)
5. Safety: Never closes without SOME exit price

### Fire-and-Forget SL/TP Updates
- When exchange sync runs, ALWAYS calls updateProtectionOrders
- No-op when levels unchanged (cheap)
- Fire-and-forget so single failure doesn't block reconcile
- Errors logged but never propagated

### Control Orders Are Optional
- Control orders (exchange-placed SL/TP) are an OPTIMIZATION
- Local SL/TP cross detection is the PRIMARY mechanism
- Positions close even if:
  - Control order placement fails
  - Exchange rejects the control order
  - Control order gets cancelled
  - Connection timeout before placement
  - API rate limits prevent placement

## Verification Checklist

✓ Control orders are optional - not required for closing
✓ SL/TP crosses detected locally every tick (primary mechanism)
✓ Paper positions close even without API keys
✓ Max hold time enforces hard close limit
✓ External closes detected and PnL computed
✓ Orphaned control orders cancelled when position closes
✓ Market-close fallback for edge cases
✓ Pause state doesn't block simulated position closing
✓ Connector unavailability triggers orphan-close sweep
✓ Multiple close reasons tracked for audit trail
✓ Simulated position sweep runs BEFORE connector gate (always)

## Close Reason Audit Trail

All position closes are tagged with a reason for audit:
- `sl_crossed` - Stop-loss price reached
- `tp_crossed` - Take-profit price reached
- `max_hold_time_exceeded` - Held too long
- `orphan_no_connector` - Exchange unreachable, max hold exceeded
- `orphan_exchange_error` - Exchange error, max hold exceeded
- `entry_order_rejected` - Entry order was rejected
- `external_close` - Position closed on exchange side

## System Guarantees

**100% Position Closing Functional Even If:**
1. ❌ Control orders fail to place
2. ❌ Exchange returns "order limit exceeded"
3. ❌ API credentials invalid
4. ❌ Network timeout to exchange
5. ❌ Coordinator paused
6. ❌ Connector unavailable
7. ❌ Market data stale

**Worst Case Scenario**: If ALL else fails, max_hold_time ensures positions close after configured threshold (default: 24 hours).

## Implementation Integrity

The `closeLivePosition` function (line 2453) is the single authoritative close path:
- Called from 9+ locations (all mechanisms use same path)
- Ensures PnL computation is consistent
- Ensures metrics/counters incremented correctly
- Ensures dedup locks released
- Ensures progression events logged
- Ensures position archived to closed history

This centralization guarantees 100% consistency regardless of which mechanism triggered the close.
