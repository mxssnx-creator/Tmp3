# Production Operations Guide - CTS v3.2

## System Overview

The Crypto Trading System (CTS v3.2) is a production-ready, multi-exchange trading platform with real-time market analysis, automated strategy evaluation, and live position management.

### Key Components
- **9 Supported Exchanges**: BingX, Bybit, Binance, OKX, Gate.io, Kraken, Huobi, Kucoin, PionEx
- **4 Core Strategies**: MA_Cross, RSI_Band, MACD_Signal, Bollinger_Bounce
- **Real-time Engine**: 1000ms cycle with 6-phase processing
- **Live Trading**: Market orders with proper risk management
- **High-Volatility Screening**: Automated selection of top 3 symbols

## Dashboard Features

### 1. High Volatility Screener (Priority Feature)
**Location**: Main Dashboard, below System Overview
**Function**: Identifies and auto-selects top 3 highest volatility symbols for live trading

#### How It Works:
1. Scans all available symbols from connected exchanges
2. Calculates 1-hour volatility: (high - low) / close × 100
3. Filters for high volatility (>2% price range)
4. **Auto-selects top 3 highest volatility symbols**
5. **Auto-enables live trading for top 3**
6. Provides manual toggle buttons for fine-grained control

#### Key Metrics:
- **Volatility %**: 1-hour price range as percentage
- **Volatility Score**: 0-100 scale (100 = 5%+ range)
- **Status Badges**: Shows which symbols are actively trading

#### User Actions:
- **Rescan**: Forces immediate re-screening
- **Toggle Trading**: Enable/disable live trading per symbol
- **Auto-refresh**: System rescans every 30 seconds

### 2. System Overview
Real-time status of all components:
- Exchange connection status (Active, Idle, Failed)
- Trade engine state (Initializing, Market Data, Prehistoric, Indications, Strategies, Live)
- Active connections count
- Total positions and profit/loss

### 3. Trade Engine Controls
- **Start/Stop**: Enable/disable the trade engine
- **Quick Start**: Start with default configuration
- **Engine Status**: Shows current phase and cycle count

### 4. Active Connections Manager
- Connect new exchange accounts
- View connection details (API keys, symbols, leverage)
- Monitor real-time connection health
- Manage active symbol selection per connection

### 5. Statistics Overview
- Win/loss rates per strategy set
- PnL tracking (total, daily, monthly)
- Trade counts (total, winners, losers)
- Risk metrics (max drawdown, Sharpe ratio)

### 6. System Monitoring Panel
- CPU and memory usage
- Network latency
- Redis operational status
- Error and warning logs

## Live Trading Page

**Location**: `/live-trading` route
**Purpose**: Real-time position management and P&L tracking

### Features:
- Real-time position list with live price updates
- Position details: entry price, current price, P&L, stop loss, take profit
- Sorting options: by P&L, entry price, creation time
- Filtering: all trades, longs only, shorts only
- One-click position management (close, modify SL/TP)
- Position status tracking (open, closing, closed)

### Position Information:
- **Symbol & Side**: BTCUSDT LONG (for example)
- **Entry Price**: Price at position creation
- **Current Price**: Live market price
- **Quantity**: Position size
- **Leverage**: Applied leverage (1-150x)
- **Unrealized P&L**: Current profit/loss
- **P&L %**: Percentage return
- **TP/SL Prices**: Take profit and stop loss levels

## Configuration & Strategy Setup

### Creating Strategy Configuration Sets

A configuration set defines:
- **Strategy Type**: Which strategy to use
- **TP Min/Max**: Take profit percentage range (0.1% - 50%)
- **SL Ratio**: Stop loss ratio relative to TP (0.25x - 1.0x)
- **Position Cost**: % of portfolio per position (2% - 20%)
- **Max Positions**: Up to 250 per set
- **Adjust Strategy**: Optional block or DCA adjustment

### Example Configuration:
```
Strategy: MA_Cross
TP Min: 1.5%, TP Max: 3%
SL Ratio: 0.5x (so 0.75% - 1.5% SL)
Position Cost: 5%
Max Positions: 50
Adjust Strategy: DCA (dollar-cost averaging)
```

### Strategy Behavior:
1. **Entry**: When signal matches strategy conditions
2. **Position Creation**: Entry price locked at signal confirmation
3. **TP/SL Calculation**: Based on configuration percentages
4. **Adjustment**: Block or DCA modifies subsequent positions
5. **Exit**: When TP or SL is hit

## Monitoring & Operations

### Daily Checklist:
1. **Morning Check**:
   - Verify all exchange connections are active
   - Check system resource usage (CPU <70%, Memory <80%)
   - Review overnight positions and P&L

2. **During Trading**:
   - Monitor active positions in real-time
   - Watch volatility screener for symbol changes
   - Track win rates and P&L trends

3. **Evening Check**:
   - Review daily statistics and performance
   - Check for any warnings or errors in logs
   - Prepare strategy adjustments if needed

### Alert Conditions:
- Exchange connection lost
- Trade engine cycle time exceeds 2000ms
- P&L drawdown exceeds 25%
- Position cost allocation reaches 90%+
- Redis connection errors
- API rate limiting triggered

### Troubleshooting:

**Issue**: Positions not opening
- **Check**: Engine status (must be in "Live" phase)
- **Check**: Exchange connection active
- **Check**: Volatility screener shows selected symbols
- **Check**: Strategy conditions are being met

**Issue**: High P&L but low win rate
- **Check**: TP/SL configuration (verify reasonable levels)
- **Check**: Position size (ensure proper risk per trade)
- **Check**: Strategy settings (adjust thresholds)

**Issue**: Slow position updates
- **Check**: Network latency to exchanges
- **Check**: Redis operational status
- **Check**: Server CPU/memory usage

## Performance Targets

### System Targets:
- **Cycle Time**: 1000ms (±100ms acceptable)
- **Indication Generation**: <400ms
- **Strategy Evaluation**: <300ms
- **Realtime Processing**: <200ms

### Reliability Targets:
- **Uptime**: 99.5%+ target
- **Exchange Connectivity**: 99%+ availability
- **Trade Execution**: 99.8%+ success rate
- **Data Consistency**: 100% (immediate persistence)

### Scaling Limits:
- **Max Positions**: 250 per configuration set
- **Max Configuration Sets**: Unlimited independent sets
- **Max Exchange Connections**: 9 (one per exchange)
- **Max Symbols Per Connection**: Unlimited (filtered by exchange)

## API Reference

### Market Data Endpoints:
- `GET /api/trade-engine/status` - Engine status and cycle info
- `GET /api/data/positions?connectionId=X` - Active positions
- `GET /api/data/market-data?symbol=BTCUSDT` - Current price data

### Configuration Endpoints:
- `POST /api/config/strategy-sets` - Create strategy set
- `PUT /api/config/strategy-sets/:id` - Update set
- `DELETE /api/config/strategy-sets/:id` - Delete set

### Control Endpoints:
- `POST /api/trade-engine/start` - Start engine
- `POST /api/trade-engine/stop` - Stop engine
- `GET /api/symbols/screen-volatility` - Screen for high volatility
- `POST /api/trade-engine/enable-symbols` - Enable symbols for trading
- `POST /api/trade-engine/toggle-symbol` - Toggle trading on/off

### Position Endpoints:
- `POST /api/positions/close` - Close position
- `PUT /api/positions/:id/sl-tp` - Modify SL/TP
- `GET /api/positions/evaluate-readiness` - Evaluate position readiness

## Security Considerations

### API Keys:
- Never expose API keys in logs or error messages
- Store API keys in environment variables only
- Rotate API keys quarterly
- Use IP whitelist on exchange API keys when available

### Data Protection:
- All positions data encrypted in transit (HTTPS)
- Redis data persisted to disk with daily backups
- No sensitive data logged to console
- Audit trail maintained for all trades

### Risk Management:
- Position cost limits prevent over-allocation
- Leverage limits enforced (1-150x per exchange)
- Stop loss enforced on all positions
- Daily drawdown monitoring with alerts

## Support & Escalation

### Issue Categories:

**Critical** (Immediate Action):
- Exchange connection lost for >5 minutes
- Engine not processing cycles
- Positions not closing on SL/TP hits
- Data corruption detected

**High** (Within 1 hour):
- Single exchange temporarily unavailable
- Slow cycle times (>2000ms)
- Alert flood/spam
- Incorrect position calculations

**Medium** (Within 4 hours):
- Strategy not generating signals
- Minor UI issues
- Performance degradation (<20%)

**Low** (Next business day):
- Feature requests
- UI improvements
- Documentation updates

### Escalation Contacts:
1. **System Admin**: Platform infrastructure
2. **Trading Lead**: Strategy and risk decisions
3. **Exchange Support**: Exchange API issues
4. **Development Team**: Bug fixes and updates

## Compliance & Record Keeping

### Required Records:
- Daily position activity logs (30-day retention)
- P&L statements (1-year retention)
- Configuration change history (permanent)
- API usage logs (90-day retention)
- Error and warning events (90-day retention)

### Regulatory Requirements:
- KYC/AML verified for all exchange accounts
- Position limits compliant with exchange requirements
- Tax documentation prepared for all PnL
- Risk assessment documented per strategy

## Maintenance Schedule

### Daily:
- Monitor system health
- Review alerts and logs
- Update market data caches
- Backup active position data

### Weekly:
- Performance analysis and optimization
- Configuration review and tuning
- Exchange API rate limit reset
- Redis memory optimization

### Monthly:
- Full system audit
- Strategy performance analysis
- Risk assessment review
- Documentation updates

### Quarterly:
- API key rotation
- Security audit
- Disaster recovery test
- Strategy review and adjustment

---

**Last Updated**: 2026-04-05
**System Version**: v3.2
**Status**: Production Ready ✓
