# API Engine Updates Required

**Date**: May 13, 2026
**Status**: Planning comprehensive engine updates to use new API methods
**Goal**: Integrate new closeAllPositions, batchPlaceOrders, and query endpoints

---

## New API Methods Available

### Position Closure Methods
- `closeAllPositions(symbol?)` - Close all open positions at once
- `closePositionById(positionId)` - Efficient 1-call close by position ID
- `cancelAllOrders(symbol?, type?)` - Cancel all open orders

### Batch Operations
- `batchPlaceOrders(orders)` - Place up to 5 orders in one call (max 5)
- `batchCancelOrders(symbol, orderIds)` - Cancel up to 10 orders in one call

### Query Operations (now exposed via executeSwapTrade)
- `getOpenOrder(symbol, orderId?, clientOrderId?)` - Single open order
- `getOrder(symbol, orderId?, clientOrderId?)` - Any order status
- `getOpenOrders(symbol, type?)` - All open orders
- `getOrderHistory(symbol, currency?, orderId?, startTime?, endTime?, limit?)` - Order history
- `getForceOrders(symbol?, currency?, autoCloseType?, startTime?, endTime?, limit?)` - Liquidation orders
- `getTradeHistory(tradingUnit, startTs, endTs, orderId?, currency?)` - Fill history

### Safety Features
- `setKillSwitch(type, timeOut?)` - Auto-cancel timeout (10-120 seconds)

### Margin Management
- `adjustIsolatedMargin(symbol, amount, type, positionSide?, positionId?)` - Adjust margin
- `getMarginMode(symbol)` - Query margin type (ISOLATED/CROSSED)

---

## Files That Need Updates

### 1. Trade Execution Orchestrator (`/lib/trade-execution-orchestrator.ts`)
**Current Issues**:
- Uses basic `placeOrder()` one at a time
- No batch order support
- No closeAllPositions support
- Limited order cancellation

**Updates Needed**:
- Add `executeBatchBuySignals()` - Place multiple orders with batchPlaceOrders
- Add `executeCloseAllSignal()` - Close all positions with closeAllPositions
- Add `executeBulkCancelSignal()` - Cancel multiple orders with batchCancelOrders
- Use new query methods for order status verification
- Use setKillSwitch for emergency exit

### 2. Engine Progress Manager (`/lib/engine-progress-manager.ts`)
**Current Issues**:
- Only tracks prehistoric loading and general metrics
- Missing order execution metrics
- No tracking of batch operations

**Updates Needed**:
- Add `batchOperationMetrics` field (placed, failed, pending)
- Add `closeOperationMetrics` field (total closed, automated, manual)
- Add `orderQueryMetrics` field (queries executed, cache hits)
- Track batch operation success rates

### 3. Engine Progress Panel Component (`/components/engine-progress-panel.tsx`)
**Current Issues**:
- Displays generic engine stats
- No order execution details
- Missing batch operation status

**Updates Needed**:
- Add batch operations status card
- Add close operations status card
- Display kill switch status
- Show order query statistics

### 4. Trade Engine (`/lib/trade-engine.ts`)
**Current Issues**:
- Only supports single position operations
- No batch position opening/closing
- Limited order management

**Updates Needed**:
- Add `openBatchPositions()` using batchPlaceOrders
- Add `closeAllPositions()` using new API method
- Add `closePositionsByIds()` for bulk closing
- Implement order query caching

### 5. Realtime Processor (`/lib/trade-engine/realtime-processor.ts`)
**Current Issues**:
- Only processes single position updates
- No batch operation support

**Updates Needed**:
- Add batch update handling
- Support bulk close operations
- Track order query execution

### 6. Pseudo Position Manager (`/lib/trade-engine/pseudo-position-manager.ts`)
**Current Issues**:
- Manages positions individually
- No bulk position closing

**Updates Needed**:
- Add `closeAllPositions()` method
- Add `closeBatchPositions(positionIds)` method
- Integrate with new closePositionById API

---

## Implementation Priority

### Phase 1: Critical (Must Have)
1. Update TradeExecutionOrchestrator to use closeAllPositions()
2. Update pseudo-position-manager to support bulk closes
3. Add batch operation metrics to progress manager
4. Verify all close operations work correctly

### Phase 2: High Priority (Should Have)
1. Add batchPlaceOrders support to TradeExecutionOrchestrator
2. Add batch metrics to progress panel UI
3. Add kill switch support
4. Cache order query results

### Phase 3: Medium Priority (Nice to Have)
1. Add margin adjustment support
2. Add liquidation order tracking
3. Add trade history analytics
4. Add query optimization

### Phase 4: Low Priority (Future)
1. Advanced batch operation strategies
2. Predictive margin calculations
3. Liquidation price monitoring
4. Advanced position hedging

---

## API Usage Examples

### Closing All Positions
```typescript
// Old way (multiple API calls)
const positions = await connector.getSwapAccountInfo("positions")
for (const pos of positions) {
  await connector.closePosition(pos.symbol, pos.positionSide)
}

// New way (1 API call)
const result = await connector.executeSwapTrade("closeAllPositions", { symbol: "BTC/USDT" })
```

### Batch Placing Orders
```typescript
// Old way (5 API calls)
const orders = [...array of orders...]
for (const order of orders) {
  await connector.placeOrder(...)
}

// New way (1 API call)
const result = await connector.executeSwapTrade("batchPlaceOrders", {
  orders: [...array of orders...]
})
```

### Querying Orders
```typescript
// Now accessible via executeSwapTrade
const openOrders = await connector.executeSwapTrade("getOpenOrders", {
  symbol: "BTC/USDT"
})

const history = await connector.executeSwapTrade("getOrderHistory", {
  symbol: "BTC/USDT",
  startTime: Date.now() - 86400000,
  limit: 100
})
```

---

## Testing Strategy

### Unit Tests
- Test closeAllPositions closes all positions
- Test batchPlaceOrders places all orders
- Test batchCancelOrders cancels all orders
- Test query methods return correct data

### Integration Tests
- Test full lifecycle: open batch → query → close all
- Test batch operations with error handling
- Test kill switch timeout
- Test margin adjustments

### Performance Tests
- Measure batch operation timing (1 call vs N calls)
- Measure query cache performance
- Measure bulk close latency
- Compare with old single-operation approach

---

## Backwards Compatibility

All existing methods remain functional:
- `placeOrder()` - still works for single orders
- `closePosition()` - still works for single positions
- `cancelOrder()` - still works for single cancellations
- All query methods work both directly and via executeSwapTrade

---

## Success Criteria

- All new methods implemented in trade orchestrator
- All new metrics tracked in progress manager
- All new UI elements displayed in progress panel
- All tests passing
- Build error-free
- 100% backwards compatible
- No performance degradation

---

**Status**: Ready for implementation
**Estimated Time**: 2-3 hours
**Complexity**: Medium (integration primarily, no new algorithms)

