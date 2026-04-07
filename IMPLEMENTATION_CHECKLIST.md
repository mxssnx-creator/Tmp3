# Advanced Engine Implementation Checklist

## Phase 1: Core Configuration System ✅ (In Progress)

- [x] **Settings Storage Expansion**
  - Expanded `/lib/settings-storage.ts` with all parameter ranges
  - Added prehistoric data config
  - Added indication parameter configs
  - Added strategy evaluation configs

- [x] **Advanced Configuration Schema**
  - Created `/lib/trade-engine/advanced-config.ts`
  - Defined all configuration interfaces
  - Created parameter range definitions
  - Implemented DEFAULT_ADVANCED_CONFIG

- [x] **Pseudo Position Manager Enhancement**
  - Updated `/lib/trade-engine/pseudo-position-manager.ts`
  - Added configuration set tracking
  - Added parameter support (TP steps, SL ratios, trailing)
  - Added evaluated position detection
  - Added configuration set statistics

- [ ] **Settings Coordinator Updates**
  - Add HOT_RELOAD_FIELDS for indication parameters
  - Add settings validation for ranges
  - Implement settings propagation to running engines

---

## Phase 2: Indication Processor Integration

- [ ] **Engine Manager Updates**
  - Import advanced-config system
  - Apply indication parameter configs in processor
  - Create independent DB sets for each indication type
  - Implement parameter-based indication generation

- [ ] **Indication Generator Enhancement**
  - Add steps parameter application
  - Add drawdown ratio calculation
  - Add market activity measurement
  - Add range ratio calculation
  - Add activity ratio multipliers
  - Add market distance ratio application

- [ ] **Indication Evaluation**
  - Timeout for "Evaluated" state: 0-5 seconds (default 1, step 0.2)
  - Apply per-type parameter configurations
  - Track evaluation statistics per configuration

---

## Phase 3: Strategy Processor Enhancements

- [ ] **Configuration Set Management**
  - Create sets for all configuration combinations
  - Initialize 6 independent pseudo position configurations
  - For each: [1,2,3,4,5,6,8,10,12,15,20,30] position counts
  - Database: 250 positions per set, rearrange at 200

- [ ] **Pseudo Position Creation from Indications**
  - Link indication signals to pseudo positions
  - Apply TP/SL calculation from parameters
  - Set trailing stop configuration
  - Store in appropriate configuration set

- [ ] **Pseudo Position Evaluation**
  - Track profit factor calculation
  - Identify evaluated positions (PF >= 0.7)
  - Calculate drawdown time
  - Apply recent position count analysis (1,2,3,4)

- [ ] **Configuration Set Statistics**
  - Total positions created per set
  - Evaluation rate (%)
  - Cumulative profit factor
  - Average drawdown time
  - Update every cycle

---

## Phase 4: Real Position Execution

- [ ] **Real Position Mirror System**
  - Monitor evaluated pseudo positions
  - Extract configuration on close
  - Create real exchange positions (if enabled)
  - Use position TP/SL (not order commands)

- [ ] **Exchange Integration**
  - BingX: Set position TP/SL via API
  - Bybit: Set position TP/SL via API
  - Validate position creation
  - Track position ID mapping (pseudo ↔ real)

- [ ] **Real Position Tracking**
  - Monitor price updates
  - Track TP/SL hits
  - Update statistics
  - Broadcast position updates

---

## Phase 5: Database Management & Performance

- [ ] **Set Rearrangement**
  - Monitor 250-position DB length per set
  - Trigger rearrange at 200 (80% threshold)
  - Keep most recent 250, remove oldest 50
  - Preserve statistics

- [ ] **Volume Calculation Updates**
  - Apply to pseudo positions
  - Use position-cost ratios
  - Cache by symbol/exchange
  - Support real position scaling

- [ ] **Redis Optimization**
  - Parallel set operations
  - Pipeline commands for batch updates
  - Implement efficient scanning
  - TTL management (7 days for closed)

---

## Phase 6: UI & Dashboarding

- [ ] **Settings Panel Updates**
  - Add "Settings" section to dashboard (top of connection selector)
  - Indication Parameters controls
  - Strategy Evaluation sliders
  - Pseudo Position Timeout controls
  - Real Position Criteria controls
  - Save/Apply per connection

- [ ] **Connection Detailed Log Dialog**
  - Fix data mapping (state/metrics extraction)
  - Add configuration set statistics display
  - Show evaluated position counts
  - Display evaluation rates

- [ ] **Progression Logs Dialog**
  - Extended info tab with all new metrics
  - indicationEvaluated* counts
  - strategyEvaluated* counts
  - Real position mirror status

- [ ] **Live Position Display**
  - Pseudo positions: symbol, entry, TP/SL, config
  - Real positions: symbol, entry, TP/SL, exchange status
  - Real position badges on dashboard

---

## Phase 7: Testing & Validation

- [ ] **Unit Tests**
  - Configuration parameter generation
  - Pseudo position creation/update
  - Real position mirroring logic
  - Database rearrangement

- [ ] **Integration Tests**
  - End-to-end: Indication → Pseudo → Real flow
  - Configuration set isolation
  - Statistics accuracy
  - Exchange API integration

- [ ] **Performance Tests**
  - 1,100+ strategies per cycle
  - 60 indications per cycle
  - 5 symbols parallel processing
  - Memory usage with 6 configurations × 30 sets

- [ ] **Exchange Tests**
  - BingX position creation
  - Bybit position creation
  - TP/SL execution
  - Real position closure tracking

---

## Phase 8: Logging & Monitoring

- [ ] **Engine Logs**
  - Configuration set creation
  - Pseudo position lifecycle (create, update, close, evaluate)
  - Real position mirroring events
  - Database rearrangement triggers

- [ ] **Statistics Logging**
  - Per cycle: indications, strategies, evaluation counts
  - Per connection: cumulative stats
  - Per configuration set: performance metrics
  - Real position status updates

- [ ] **Error Handling & Recovery**
  - Configuration validation
  - Volume calculation failures
  - Exchange API errors
  - Position tracking gaps

---

## Current Status

✅ **Completed**:
- Advanced configuration schema
- Settings storage expansion
- Pseudo position manager enhancement
- Comprehensive architecture documentation

🔄 **In Progress**:
- Engine integration of advanced configs
- Indication processor parameter application
- Strategy set initialization

⏳ **Next Steps**:
1. Update `engine-manager.ts` to use advanced-config
2. Enhance indication generation with all parameters
3. Implement strategy set creation and management
4. Add real position mirroring logic
5. Update UI components for new settings

---

## Key Files

| File | Purpose | Status |
|------|---------|--------|
| `/lib/settings-storage.ts` | Settings with all parameters | ✅ Updated |
| `/lib/trade-engine/advanced-config.ts` | Config schema & generation | ✅ Created |
| `/lib/trade-engine/pseudo-position-manager.ts` | Position management | ✅ Enhanced |
| `/lib/trade-engine/engine-manager.ts` | Main engine loop | ⏳ Needs update |
| `/lib/trade-engine/indication-processor.ts` | Indication generation | ⏳ Needs update |
| `/lib/trade-engine/strategy-processor.ts` | Strategy evaluation | ⏳ Needs update |
| `/components/dashboard/settings-panel.tsx` | Settings UI | ⏳ Needs creation |
| `/app/api/trade-engine/real-positions` | Real position API | ⏳ Needs creation |

---

## Performance Targets

- **Prehistoric Data Load**: 1,250 candles in <1 second
- **Indication Generation**: 60 indications per cycle
- **Strategy Evaluation**: 1,100+ strategies per cycle
- **Pseudo Position Management**: <500ms per cycle
- **Real Position Mirroring**: <100ms per evaluation
- **Database Operations**: All operations use Redis (no blocking SQL)

---

## Notes

- All configurations are **independent DB sets** for maximum performance
- **250 positions** per set is standard (rearrange at 200 = 80%)
- **Real position mirroring** only when explicitly enabled
- **TP/SL at position level** for optimal high-frequency execution
- **Statistics tracking** per configuration for comprehensive analysis
