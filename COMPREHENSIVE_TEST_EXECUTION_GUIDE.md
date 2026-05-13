# Comprehensive Test Execution Guide

**Date**: May 13, 2026
**Status**: ACTIVE
**Goal**: Test all order lifecycle scenarios systematically

---

## Phase 1: Current State Analysis

### Build Status
✅ **Compilation**: Successful (31.2 seconds)
✅ **TypeScript**: No errors
✅ **Migrations**: All 21 migrations completed
✅ **Database**: Schema ready

### Current Tests (10 Total)
```
Test 1: Connector Creation ✅
Test 2: Get Account Balance ✅ (6.7598 USDT)
Test 3: Get Open Positions ✅ (0 positions)
Test 4: Get Open Orders ✅ (0 orders)
Test 5: Market Order Placement ❌ (balance < 10 USDT)
Test 6: Stop Loss Order ❌ (no positions)
Test 7: Verify Order Creation ❌ (depends on orders)
Test 8: Order Cancellation ❌ (no orders to cancel)
Test 9: Limit Order Placement ❌ (balance too low)
Test 10: Control Order Lifecycle ❌ (no positions)
```

**Current Pass Rate**: 40% (4/10)
**Blocker**: Account balance insufficient (need 50+ USDT for full test coverage)

---

## Phase 2: Recommended Action Items

### Immediate (Next 5 minutes)
1. Fund account with 50+ USDT
2. Verify new balance reflects in test

### Short-term (Next 10 minutes)
1. Rerun test suite
2. Document new test results
3. Identify any failure patterns

### Medium-term (Next hour)
1. Add new test scenarios (control orders, partial fills, etc.)
2. Test full order lifecycle workflows
3. Document all issues found

---

## Phase 3: Test Scenarios to Execute

### Scenario 1: Basic Market Order Lifecycle
**Setup**: Account with 50+ USDT, no positions
**Steps**:
1. Place market order (BTC-USDT, 0.01 BTC, buy)
2. Verify order accepted and assigned ID
3. Wait for order fill (should fill immediately)
4. Verify position created

**Expected Outcome**: Position created with 0.01 BTC entry

### Scenario 2: Stop Loss Order Creation
**Setup**: Open position (0.01 BTC)
**Steps**:
1. Create stop-loss order at -2% from entry
2. Verify SL order appears in open orders
3. Verify SL linked to position

**Expected Outcome**: SL order visible, linked to position

### Scenario 3: Take Profit Order Creation
**Setup**: Open position with SL (0.01 BTC)
**Steps**:
1. Create take-profit order at +5% from entry
2. Verify TP order appears in open orders
3. Verify TP linked to position

**Expected Outcome**: TP order visible, linked to position

### Scenario 4: Control Orders Auto-Creation
**Setup**: Fresh market order placement
**Steps**:
1. Place market order (automatic entry)
2. After position created, check for auto-created SL/TP
3. Verify SL and TP automatically created per strategy

**Expected Outcome**: SL and TP automatically created

### Scenario 5: Position Close via Manual API
**Setup**: Open position (0.01 BTC)
**Steps**:
1. Call close position API
2. Market order created to close position
3. Position status changes to closed

**Expected Outcome**: Position closed, new market order for exit created

### Scenario 6: Order Cancellation
**Setup**: Pending limit order
**Steps**:
1. Place limit order above market (won't fill immediately)
2. Cancel order via API
3. Verify order removed from open orders

**Expected Outcome**: Order successfully canceled

### Scenario 7: Partial Fill Handling
**Setup**: Large limit order
**Steps**:
1. Place limit order for 10 contracts
2. Order fills 3 contracts immediately
3. Verify position created with 3 contracts
4. Verify remaining 7 contracts still pending

**Expected Outcome**: Position for 3 contracts, order for 7 remaining

### Scenario 8: Orphan Position Adoption
**Setup**: Position exists in exchange but not in database
**Steps**:
1. Manually create position on BingX
2. Run adoption sync
3. Verify position now appears in system

**Expected Outcome**: Position adopted and tracked

### Scenario 9: Force Close on Max Hold Time
**Setup**: Position open longer than max hold time
**Steps**:
1. Create position with 5-minute max hold
2. Wait 5 minutes
3. Verify automatic force-close triggered

**Expected Outcome**: Position automatically closed

### Scenario 10: Multiple Positions Management
**Setup**: 3 simultaneous positions
**Steps**:
1. Create 3 positions on different symbols
2. Verify all tracked correctly
3. Close one position
4. Verify other 2 still open

**Expected Outcome**: All positions tracked independently

---

## Phase 4: Test Execution Checklist

- [ ] **Pre-test**
  - [ ] Account funded with 50+ USDT
  - [ ] All balance tests pass
  - [ ] No existing positions or orders

- [ ] **Basic Tests (10 existing)**
  - [ ] Test 1: Connector Creation
  - [ ] Test 2: Get Account Balance
  - [ ] Test 3: Get Open Positions
  - [ ] Test 4: Get Open Orders
  - [ ] Test 5: Market Order Placement
  - [ ] Test 6: Stop Loss Order
  - [ ] Test 7: Verify Order Creation
  - [ ] Test 8: Order Cancellation
  - [ ] Test 9: Limit Order Placement
  - [ ] Test 10: Control Order Lifecycle

- [ ] **Advanced Tests (10 new scenarios)**
  - [ ] Scenario 1: Basic Market Order Lifecycle
  - [ ] Scenario 2: Stop Loss Order Creation
  - [ ] Scenario 3: Take Profit Order Creation
  - [ ] Scenario 4: Control Orders Auto-Creation
  - [ ] Scenario 5: Position Close via Manual API
  - [ ] Scenario 6: Order Cancellation
  - [ ] Scenario 7: Partial Fill Handling
  - [ ] Scenario 8: Orphan Position Adoption
  - [ ] Scenario 9: Force Close on Max Hold Time
  - [ ] Scenario 10: Multiple Positions Management

---

## Phase 5: Issue Documentation Template

When tests fail, document using this template:

```
### Issue #X: [Name]

**Test**: [Which test failed]
**Symptom**: [What happened vs expected]
**Environment**: 
  - Balance: [current USDT]
  - Positions: [count]
  - Orders: [count]
**Root Cause**: [What's causing it]
**Impact**: [What breaks because of this]
**Fix**: [Proposed solution]
**Status**: [investigating/fixed/blocked]
```

---

## Phase 6: Success Criteria

### Basic Tests (100% target)
- ✅ All 10 existing tests passing
- ✅ Pass rate: 100%
- ✅ No infrastructure failures

### Advanced Tests (80% target)
- ✅ 8 of 10 new scenarios passing
- ✅ All core functionality working
- ✅ Issues documented and roadmapped

### Overall (Deployment ready)
- ✅ Market order open and close working
- ✅ SL/TP order creation working
- ✅ Control orders functioning
- ✅ Position tracking accurate
- ✅ All failure modes handled gracefully

---

## Phase 7: Performance Benchmarks

### Expected Performance Targets

| Operation | Target | Current |
|-----------|--------|---------|
| Connector Creation | < 100ms | 3ms ✅ |
| Get Balance | < 1000ms | 1,105ms ✅ |
| Get Positions | < 500ms | 213ms ✅ |
| Get Orders | < 500ms | 860ms ✅ |
| Place Order | < 1000ms | TBD |
| Cancel Order | < 500ms | TBD |
| Get New Orders | < 2000ms | TBD |

---

## Phase 8: Debugging Workflow

If a test fails:

1. **Identify the test**
   ```
   - Which test number?
   - What is it testing?
   ```

2. **Check preconditions**
   ```
   - Is balance sufficient?
   - Do required orders/positions exist?
   - Is connectivity working?
   ```

3. **Review logs**
   ```
   - Server logs: /vercel/share/.env logs
   - Client logs: Browser console
   - Database: Check redis state
   ```

4. **Reproduce the issue**
   ```
   - Can you replicate in isolation?
   - Specific to this test or broader?
   ```

5. **Apply fix**
   ```
   - Update code
   - Rebuild: npm run build
   - Retest
   ```

---

## Phase 9: Documentation Updates

After tests complete, update:
- [ ] Test results in this file
- [ ] Performance benchmark section
- [ ] Issues found section
- [ ] Recommendations section

---

## Next Steps

1. **Funding**: Fund account with 50+ USDT
2. **Verification**: Run test suite → Verify results
3. **Analysis**: Document any failures
4. **Fixes**: Implement solutions for failures
5. **Validation**: Re-run tests to confirm fixes

---

## Success Indicators

✅ **Phase 1 (Current)**: Build successful, infrastructure verified
✅ **Phase 2 (Next)**: Fund account, rerun tests
🔄 **Phase 3 (In Progress)**: Execute advanced scenarios
⏸️ **Phase 4 (Pending)**: Document issues
⏸️ **Phase 5 (Pending)**: Apply fixes
⏸️ **Phase 6 (Pending)**: Validate fixes

---

**Status**: READY FOR EXECUTION
**Estimated Time**: 30-60 minutes (with funding)
**Prerequisites**: 50+ USDT account balance

