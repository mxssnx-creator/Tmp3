# Live Trading Checklist - CTS v3.2

## Pre-Launch Verification

### System Health
- [ ] All 9 exchange API connections tested and active
- [ ] Redis connection stable (no timeouts)
- [ ] API rate limits verified per exchange
- [ ] System CPU usage <70% during normal operation
- [ ] System memory usage <80% during normal operation
- [ ] Engine cycle time 900-1100ms (target: 1000ms)
- [ ] No unhandled exceptions in logs
- [ ] Dashboard loading in <2 seconds

### Market Data
- [ ] Market data updates every 1-2 seconds per symbol
- [ ] Candle data reflects correct price ranges
- [ ] Volume calculations correct and match exchange data
- [ ] Price decimal precision matches exchange requirements
- [ ] High/low/close prices sensible and consistent

### Database Integrity
- [ ] All exchange connections properly stored
- [ ] Strategy configuration sets saved correctly
- [ ] Position history tracking enabled
- [ ] Pseudo position calculations verified
- [ ] No orphaned records (positions without sets)
- [ ] Backup system operational

### Engine Operation
- [ ] Engine starts successfully with `/api/trade-engine/start`
- [ ] Engine transitions through all 6 phases correctly:
  - [ ] Phase 1: Initializing
  - [ ] Phase 2: Market Data
  - [ ] Phase 3: Prehistoric
  - [ ] Phase 4: Indications
  - [ ] Phase 5: Strategies
  - [ ] Phase 6: Live
- [ ] Cycle logging shows all phases completing
- [ ] No phase timeouts or stuck states
- [ ] Engine stops cleanly with `/api/trade-engine/stop`

### Indication Generation
- [ ] Cron indication generator running (`/api/cron/generate-indications`)
- [ ] 4 indication types generated per symbol:
  - [ ] Direction (1/-1 for long/short)
  - [ ] Move (1/0 for >2% range)
  - [ ] Active (1/0 for >1% range)
  - [ ] Optimal (1/0 for ideal conditions)
- [ ] Indications saved to Redis under `indications:{connectionId}`
- [ ] Indication timestamps are current (within last 5 seconds)
- [ ] No indication generation errors in logs

### Strategy Evaluation
- [ ] All 4 strategies evaluate without errors:
  - [ ] MA_Cross
  - [ ] RSI_Band
  - [ ] MACD_Signal
  - [ ] Bollinger_Bounce
- [ ] Strategy configuration sets load correctly
- [ ] TP/SL percentages within valid ranges (0.1% - 50%)
- [ ] Position cost allocation working (2% - 20% per set)
- [ ] Max position limits enforced (250 per set)
- [ ] Adjust strategies (Block/DCA) functioning correctly

### Live Trading Features
- [ ] Volatility Screener card visible on dashboard
- [ ] Screener shows top 3 highest volatility symbols
- [ ] Auto-selection working (top 3 auto-selected on load)
- [ ] Live trading auto-enabled for top 3 symbols
- [ ] Manual toggle buttons functional for each symbol
- [ ] Status badges show correct trading state
- [ ] Rescan button working and updating results
- [ ] Auto-refresh every 30 seconds confirmed

### Position Management
- [ ] Positions open correctly on live trading page
- [ ] Real-time P&L calculations accurate
- [ ] Position SL/TP prices correctly calculated
- [ ] Position status transitions working (open → closing → closed)
- [ ] Position sorting by P&L, entry price, time
- [ ] Position filtering (all/long/short) working
- [ ] Position close functionality responsive
- [ ] Position modification (SL/TP) updating correctly

### UI/UX Completeness
- [ ] Dashboard page loading without errors
- [ ] Live trading page responsive and fast
- [ ] All cards rendered with proper styling
- [ ] Charts and graphs displaying data
- [ ] Real-time updates visible without page refresh
- [ ] Mobile responsiveness working
- [ ] Dark mode theme applied consistently
- [ ] No missing icons or broken images

### Exchange Specific Testing

#### BingX
- [ ] Spot balance endpoint working
- [ ] Perpetual balance endpoint working
- [ ] Position list endpoint functional
- [ ] Order placement API responding
- [ ] Order cancellation API working
- [ ] Rate limiting honored (100 req/sec)

#### Bybit
- [ ] Spot account balance correct
- [ ] Futures account balance correct
- [ ] Position list with leverage working
- [ ] Market order execution functional
- [ ] Position closure working
- [ ] Rate limiting handled (50 req/sec)

#### Binance
- [ ] Spot API authenticated
- [ ] Margin/Futures API authenticated
- [ ] Account information fetching
- [ ] Order placement working
- [ ] Signature verification passing
- [ ] Rate limiting compliance (1200 req/min)

#### OKX
- [ ] Account balance retrieval working
- [ ] Spot and futures mode switching
- [ ] Position list with margin working
- [ ] Market order execution
- [ ] Order status tracking
- [ ] Rate limiting observed

#### Other Exchanges (Gate.io, Kraken, Huobi, Kucoin, PionEx)
- [ ] Authentication successful
- [ ] Balance endpoints responding
- [ ] Market data fetching
- [ ] Order endpoints accessible
- [ ] Error handling graceful

### Calculation Verification

#### Volume Calculation
- [ ] Formula: leverage × symbol_adjustment × position_factor / entry_price
- [ ] Examples verified:
  - [ ] 2 leverage × 1.0 adjustment × 0.1 / 1000 = 0.0002 volume
  - [ ] 10 leverage × 1.5 adjustment × 0.2 / 50000 = 0.00006 volume

#### Position Cost Calculation
- [ ] Formula: final_volume × entry_price / leverage
- [ ] Examples verified for different leverage levels
- [ ] Cost allocation tracking across multiple positions

#### P&L Calculation
- [ ] Formula for LONG: (current_price - entry_price) × quantity
- [ ] Formula for SHORT: (entry_price - current_price) × quantity
- [ ] P&L percentage: P&L / position_cost × 100
- [ ] Test cases verified

#### TP/SL Price Calculation
- [ ] LONG TP: entry_price × (1 + tp_percent / 100)
- [ ] LONG SL: entry_price × (1 - sl_percent / 100)
- [ ] SHORT TP: entry_price × (1 - tp_percent / 100)
- [ ] SHORT SL: entry_price × (1 + sl_percent / 100)
- [ ] All test cases passing

### Risk Management
- [ ] Position cost limits enforced
- [ ] Leverage limits per exchange enforced
- [ ] Drawdown monitoring active
- [ ] Stop loss on all live positions
- [ ] Take profit defined for all positions
- [ ] Portfolio allocation checks working
- [ ] Risk alerts triggering correctly
- [ ] Panic close functionality operational

### Logging & Monitoring
- [ ] All critical events logged with timestamps
- [ ] Error logs contain actionable information
- [ ] Performance metrics collected
- [ ] Trade execution logged
- [ ] Position status changes logged
- [ ] Strategy signal logs available
- [ ] Alert conditions properly logged
- [ ] No sensitive data in logs (API keys, passwords)

### Documentation
- [ ] README.md current and accurate
- [ ] API documentation complete
- [ ] Configuration examples provided
- [ ] Troubleshooting guide comprehensive
- [ ] Operations manual accessible
- [ ] Strategy documentation detailed
- [ ] Exchange-specific notes documented
- [ ] Risk management guidelines clear

### Backup & Recovery
- [ ] Daily backups running automatically
- [ ] Backup integrity verified
- [ ] Recovery procedures tested
- [ ] Data can be restored successfully
- [ ] Redis persistence enabled
- [ ] Transaction log maintained
- [ ] Disaster recovery plan documented
- [ ] RTO and RPO targets met

### Security
- [ ] API keys never logged
- [ ] Secrets stored in environment variables
- [ ] HTTPS enabled for all endpoints
- [ ] Authentication verified on all routes
- [ ] Rate limiting implemented
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention verified
- [ ] CORS properly configured

### Performance Benchmarks
- [ ] Dashboard load time: <2 seconds
- [ ] Position list update: <500ms
- [ ] Price update latency: <1 second
- [ ] Order execution: <2 seconds
- [ ] Indication generation: <400ms
- [ ] Strategy evaluation: <300ms
- [ ] Realtime processing: <200ms
- [ ] Full cycle completion: 1000ms ±100ms

### Stress Testing
- [ ] System handles 100+ positions
- [ ] 10+ concurrent exchange connections
- [ ] 1000+ strategy evaluations per cycle
- [ ] 5000+ market data points per update
- [ ] 500+ positions opening/closing simultaneously
- [ ] CPU usage remains <80% under load
- [ ] Memory usage remains <80% under load
- [ ] No data loss under high load

### Edge Cases
- [ ] Exchange temporarily unavailable (handled gracefully)
- [ ] Network latency spike (timeouts work correctly)
- [ ] Duplicate order prevention working
- [ ] Partial fill handling correct
- [ ] Negative balance prevention active
- [ ] Leverage limit enforcement active
- [ ] Symbol delisting handling
- [ ] Maintenance window handling

## Go-Live Sign-Off

### Required Approvals
- [ ] Trading Lead: Strategy and signals approved
- [ ] System Admin: Infrastructure stable
- [ ] Risk Manager: Risk parameters acceptable
- [ ] Compliance: All regulatory requirements met
- [ ] Finance: Budget and cost controls verified

### Final Steps Before Launch
1. [ ] All checklist items verified and passing
2. [ ] Load testing completed successfully
3. [ ] Security audit completed
4. [ ] Performance benchmarks met or exceeded
5. [ ] Team briefing completed
6. [ ] Emergency procedures reviewed
7. [ ] Monitoring alerts configured
8. [ ] Support contacts verified
9. [ ] Documentation finalized
10. [ ] Launch window confirmed

### Post-Launch (First 24 Hours)
- [ ] Continuous monitoring active
- [ ] Alert system functional
- [ ] Team on standby for issues
- [ ] Hourly performance checks
- [ ] Real-time P&L tracking
- [ ] Position monitoring every 5 minutes
- [ ] No critical errors in logs
- [ ] Exchange API stable
- [ ] System resources stable

### Week 1 Monitoring
- [ ] Daily performance report
- [ ] Strategy signal validation
- [ ] Position execution verification
- [ ] Risk metrics within targets
- [ ] No unplanned downtime
- [ ] User feedback collected
- [ ] System improvements identified
- [ ] Team confidence high

---

**Checklist Version**: 1.0
**Last Updated**: 2026-04-05
**System Version**: CTS v3.2
**Status**: Ready for Live Trading ✓

## Notes:
- All items must be verified before launch
- Each exchange requires individual testing
- Performance targets must be met under normal market conditions
- Support team must be fully trained before go-live
