# Comprehensive System Audit - Issues Identification

## Areas to Check

1. Database Schema & Persistence
   - How sets are stored in DB
   - Status field persistence
   - Position count tracking
   
2. Set Counts Verification
   - BASE set counts vs reality
   - MAIN set counts (should = BASE × variants)
   - REAL set counts
   - LIVE set counts
   - Hedge netting accuracy
   
3. Position Accumulation
   - prevPos.count tracking
   - Synthetic entry accumulation
   - Continuous position tracking
   
4. Status Field Usage
   - Status being set correctly
   - Status being saved to DB
   - Status being loaded from DB
   
5. Stats Calculations
   - Set counts per stage
   - Position averages
   - profitFactor calculations
   - Drawdown time calculations
   
6. Pipeline Flow
   - BASE → MAIN progression
   - MAIN → REAL progression
   - Hedge netting logic
   - Axis set expansion

## Testing Strategy

1. End-to-end flow test with actual data
2. Database persistence verification
3. Set count accuracy across stages
4. Status field correctness
5. Position tracking through cycles
6. Stats accuracy

