# CTS v3.2 - Crypto Trading System

*Professional automated cryptocurrency trading platform with high-volatility screening and live trading*

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com)
[![Built with Next.js](https://img.shields.io/badge/Built%20with-Next.js%2016-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=for-the-badge&logo=typescript)](https://typescriptlang.org)
[![Production Ready](https://img.shields.io/badge/Status-Production%20Ready-green?style=for-the-badge)](PRODUCTION_OPERATIONS_GUIDE.md)

## Overview

CTS v3.2 is a production-ready automated cryptocurrency trading system featuring:

- **9 Exchange Support**: BingX, Bybit, Binance, OKX, Gate.io, Kraken, Huobi, Kucoin, PionEx with unified API
- **High Volatility Screening**: Auto-selects top 3 highest volatility symbols for live trading
- **4 Core Strategies**: MA_Cross, RSI_Band, MACD_Signal, Bollinger_Bounce
- **Advanced Indication System**: Direction, Move, Active, Optimal + RSI, MACD, Bollinger, ParabolicSAR, ADX, ATR
- **Strategy Adjustment**: Block strategy and DCA (Dollar Cost Averaging) enhancement
- **Real-time Engine**: 1000ms cycle with 6-phase processing (Initializing → Market Data → Prehistoric → Indications → Strategies → Live)
- **Live Position Management**: Real-time P&L tracking, SL/TP management, position status
- **Production Monitoring**: Real-time alerts, performance metrics, comprehensive logging

## Key Features - Live Trading Edition

### High Volatility Screener
The dashboard now includes an automated high-volatility screener that:
- Scans all available symbols from connected exchanges
- Calculates 1-hour volatility (high - low) / close × 100
- **Auto-selects top 3 highest volatility symbols**
- **Auto-enables live trading for selected symbols**
- Updates every 30 seconds to catch new opportunities
- Provides manual toggle buttons for fine-grained control

**Volatility Metrics:**
- **Volatility %**: 1-hour price range as percentage
- **Volatility Score**: 0-100 scale (100 = 5%+ range)
- **High Volatility**: > 2% price range threshold
- **Status**: Live trading on/off indicator

### Live Trading Features
- Real-time position tracking with live price updates
- Unrealized P&L calculations and percentage returns
- Position management: close, modify SL/TP, adjust leverage
- Position sorting: by P&L, entry price, creation time
- Position filtering: all trades, long only, short only
- One-click position operations
- Real-time market data updates (1-2 second latency)

### Risk Management
- Position cost allocation (2% - 20% per set)
- Maximum positions per set (up to 250)
- Leverage limits per exchange (1-150x)
- Stop loss enforced on all positions
- Take profit defined for all trades
- Daily drawdown monitoring
- Portfolio allocation checks

## Deployment

### Quick Deploy to Vercel (Recommended)
```bash
# One-click deployment
vercel --prod

# Or use deployment script
./vercel-deploy.sh
```

### Environment Setup
```bash
NEXT_PUBLIC_APP_URL=https://your-app.com
KV_REST_API_URL=https://your-redis-endpoint.upstash.io
KV_REST_API_TOKEN=your-redis-token
JWT_SECRET=your-secure-jwt-secret-32-chars
```

See [PRODUCTION_OPERATIONS_GUIDE.md](PRODUCTION_OPERATIONS_GUIDE.md) for complete deployment and operations guide.

## Quick Start

### Installation
```bash
# Clone repository
git clone https://github.com/your-repo/cts-v3.2.git
cd cts-v3.2

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local

# Run development server
pnpm dev
```

### First Time Setup
1. Open http://localhost:3000
2. Register account
3. Connect exchange (Settings → Exchange Connections)
4. Start engine (Dashboard → Start Engine)
5. View volatility screener (Dashboard → High Volatility Screener)
6. Enable live trading for top 3 symbols
7. Monitor positions on Live Trading page (/live-trading)
curl -fsSL https://raw.githubusercontent.com/mxssnx-creator/v0-cts-v3-zw/main/scripts/download-and-install.sh | bash -s -- --name my-trading-bot

# Multiple instances
curl -fsSL https://raw.githubusercontent.com/mxssnx-creator/v0-cts-v3-zw/main/scripts/download-and-install.sh | bash -s -- --port 3000 --name cts-prod
curl -fsSL https://raw.githubusercontent.com/mxssnx-creator/v0-cts-v3-zw/main/scripts/download-and-install.sh | bash -s -- --port 3001 --name cts-test
\`\`\`

For detailed instructions, see [INSTALL.md](INSTALL.md).

## Manual Setup

\`\`\`bash
# 1. Clone and install
git clone https://github.com/your-repo/cts-v3.1.git
cd cts-v3.1
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local with your settings

# 3. Run database migrations
npm run db:migrate

# 4. Start development server
npm run dev

# Or start production server
npm run build
npm start
\`\`\`

## System Architecture

### Indication System

**Main Indications** (Step-based progression):
- Direction - Trend analysis (SMA crossovers)
- Move - Momentum detection (ROC)
- Active - Market activity (Volatility/Volume)
- Optimal - Combined scoring

**Common Indicators** (Technical analysis):
- RSI - Relative Strength Index
- MACD - Moving Average Convergence Divergence
- Bollinger Bands - Volatility bands
- Parabolic SAR - Trend following
- ADX - Trend strength
- ATR - Volatility measurement

### Strategy Categories

**Additional (Purple)** - Enhancement strategies:
- Trailing Stop - Dynamic stop-loss based on price movement

**Adjust (Blue)** - Position adjustment strategies:
- Block - Predefined position sizing blocks
- DCA - Dollar Cost Averaging for position building

### Trade Engine Flow

\`\`\`
Market Data → Indication Processing → Strategy Evaluation → Position Management → Exchange Execution
     ↓              ↓                       ↓                      ↓                    ↓
  WebSocket    Main/Common           Additional/Adjust       Pseudo Positions      Live Orders
\`\`\`

## Features

### Dashboard
- Real-time connection status
- Active positions overview
- Performance metrics
- Quick action controls

### Presets Management
- Preset Types with Sets
- Configuration filtering (Main/Common indicators)
- Strategy category organization
- Base settings synchronization

### Settings
- **Exchange**: Connection configuration, position limits
- **Indication**: Main and Common indicator settings
- **Strategy**: Trailing/Block/DCA configuration with categories
- **Install**: Database management, backup/restore, diagnostics

### Live Trading
- Real-time position monitoring
- Manual trade execution
- Risk management controls
- Performance analytics

## Documentation

- [INSTALL.md](INSTALL.md) - Installation guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment options
- [DATABASE_SETUP.md](DATABASE_SETUP.md) - Database configuration
- [docs/PROJECT_RECREATION_GUIDE.md](docs/PROJECT_RECREATION_GUIDE.md) - End-to-end rebuild/recreation guide (auth, exchanges, keys, migrations, menus/pages)
- [docs/MAIN_CONNECTION_ENABLEMENT_WORKFLOW.md](docs/MAIN_CONNECTION_ENABLEMENT_WORKFLOW.md) - Detailed post-enable processing flow, action sequence, and logistics coordination model
- [SETTINGS_DOCUMENTATION.md](SETTINGS_DOCUMENTATION.md) - Settings reference
- [VOLUME_CALCULATION_CORRECTIONS.md](VOLUME_CALCULATION_CORRECTIONS.md) - Volume architecture

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes, Node.js
- **Database**: PostgreSQL / SQLite
- **UI Components**: shadcn/ui, Radix UI
- **Charts**: Recharts
- **State**: SWR for data fetching

## Environment Variables

The setup script automatically generates secure secrets, but you can also configure manually:

\`\`\`bash
# Application
PROJECT_NAME=CTS-v3                          # Project name
PORT=3000                                     # Application port
NEXT_PUBLIC_APP_URL=http://localhost:3000    # Updated with port
NODE_ENV=production

# Database
DATABASE_URL=postgresql://user:password@host:5432/database
REMOTE_POSTGRES_URL=postgresql://user:password@host:5432/database

# Security (Auto-generated by setup script)
SESSION_SECRET=your-session-secret-32-bytes
JWT_SECRET=your-jwt-secret-32-bytes
ENCRYPTION_KEY=your-encryption-key-32-bytes
API_SIGNING_SECRET=your-api-signing-secret-32-bytes
\`\`\`

## Available Scripts

\`\`\`bash
# Development
npm run dev              # Start dev server (uses PORT env var)
npm run build            # Build for production
npm start                # Start production server (uses PORT env var)

# Setup & Installation
npm run setup            # Interactive setup wizard

# Database Management
npm run db:migrate       # Run database migrations
npm run db:status        # Check database status
npm run db:reset         # Reset database (caution!)
npm run db:backup        # Create database backup

# System Management
npm run system:check     # Comprehensive system health check
npm run system:health    # Quick health check

# Nginx & SSL (Ubuntu/Debian)
npm run nginx:setup      # Install and configure nginx
npm run nginx:restart    # Restart nginx service
npm run nginx:status     # Check nginx status
npm run nginx:logs       # View nginx error logs
npm run certbot:install  # Install SSL certificates

# Utilities
npm run type-check       # TypeScript type checking
npm run lint             # ESLint checking
\`\`\`

## Support

For issues or questions:
1. Check [Troubleshooting](INSTALL.md#troubleshooting)
2. Review system logs via Settings → Install → Diagnostics
3. Open a GitHub issue

## License

MIT License - See LICENSE file for details
