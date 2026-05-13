# BingX API Skills Implementation

**Date**: May 13, 2026
**Source**: https://github.com/BingX-API/api-ai-skills
**Status**: ✅ Implemented & Integrated

---

## Overview

This document describes the implementation of three official BingX API skills in the trading bot connector. These skills provide comprehensive access to perpetual futures market data, trading operations, and account information.

---

## Implemented Skills

### 1. bingx-swap-market
**Query perpetual futures market data**

#### Method
```typescript
async getSwapMarketData(symbol: string): Promise<any>
```

#### Purpose
- Retrieve real-time market data for USDT-M perpetual futures
- No authentication required (public endpoint)
- Used for price validation and market analysis

#### Data Returned
```typescript
{
  success: boolean
  symbol: string                    // BingX format (e.g., "BTC-USDT")
  lastPrice: number                 // Current market price
  bidPrice: number                  // Best bid price
  askPrice: number                  // Best ask price
  high24h: number                   // 24h high price
  low24h: number                    // 24h low price
  volume24h: number                 // 24h trading volume (base asset)
  quoteVolume24h: number            // 24h quote volume (USDT)
  priceChangePercent: number        // 24h price change percentage
  fundingRate: number               // Current funding rate
  openInterest: number              // Open interest in contracts
  timestamp: number                 // Data timestamp
  error?: string                    // Error message if failed
}
```

#### Usage Example
```typescript
const market = await connector.getSwapMarketData("BTC-USDT")
console.log(`BTC price: $${market.lastPrice}`)
console.log(`Funding rate: ${market.fundingRate}%`)
```

#### API Endpoint
- **Public**: `/openApi/swap/v3/public/ticker`
- **Authentication**: Not required
- **Rate Limit**: Standard exchange limits

---

### 2. bingx-swap-trade
**Perpetual futures trading operations**

#### Method
```typescript
async executeSwapTrade(
  operation: string,
  params: Record<string, any>
): Promise<any>
```

#### Supported Operations

##### place_order
Place a new trading order on perpetual futures

```typescript
await connector.executeSwapTrade("placeOrder", {
  symbol: "BTC-USDT",
  side: "buy",           // "buy" or "sell"
  quantity: 0.1,
  price: 45000,          // For limit orders
  type: "limit",         // "limit" or "market"
  options: {
    reduceOnly: false,
    positionSide: "LONG", // "LONG" or "SHORT" (hedge mode)
    hedgeMode: true
  }
})
```

##### cancel_order
Cancel an open order

```typescript
await connector.executeSwapTrade("cancelOrder", {
  symbol: "BTC-USDT",
  orderId: "123456789"
})
```

##### set_leverage
Set leverage for a trading pair

```typescript
await connector.executeSwapTrade("setLeverage", {
  symbol: "BTC-USDT",
  leverage: 10  // 1x to 150x
})
```

##### set_margin_type
Set margin mode (isolated or cross)

```typescript
await connector.executeSwapTrade("setMarginType", {
  symbol: "BTC-USDT",
  marginType: "cross"  // "cross" or "isolated"
})
```

##### set_position_mode
Set position mode (one-way or hedge)

```typescript
await connector.executeSwapTrade("setPositionMode", {
  hedgeMode: true  // true for hedge, false for one-way
})
```

#### API Endpoints
- **Place Order**: `/openApi/swap/v2/trade/order` (POST)
- **Cancel Order**: `/openApi/swap/v2/trade/order` (DELETE)
- **Set Leverage**: `/openApi/swap/v2/trade/leverage` (POST)
- **Set Margin Type**: `/openApi/swap/v2/trade/marginType` (POST)
- **Set Position Mode**: `/openApi/swap/v2/trade/positionSide/dual` (POST)

#### Authentication
- All operations require API key and secret
- HMAC SHA256 signature required
- Timestamp synchronization required

#### Rate Limiting
- Standard exchange rate limits apply
- Order placement: 50 orders/10 seconds
- Configuration changes: Lower rate limits

---

### 3. bingx-swap-account
**Query perpetual futures account information**

#### Method
```typescript
async getSwapAccountInfo(dataType: string = "all"): Promise<any>
```

#### Data Types

##### balance
Account balance and asset information

```typescript
await connector.getSwapAccountInfo("balance")
// Returns:
{
  success: true,
  balance: {
    total: 6.7598,                 // Total USDT balance
    btcPrice: 45000,               // BTC/USDT price for reference
    balances: [
      {
        asset: "USDT",
        free: 6.7598,              // Available balance
        locked: 0,                 // Locked in orders
        total: 6.7598
      },
      // ... other assets
    ]
  }
}
```

##### positions
Open positions information

```typescript
await connector.getSwapAccountInfo("positions")
// Returns:
{
  success: true,
  positions: [
    {
      symbol: "BTC-USDT",
      side: "long",                // "long" or "short"
      contracts: 0.1,              // Position size
      contractSize: 1,
      currentPrice: 45000,
      entryPrice: 44500,
      leverage: 10,
      marginType: "cross",
      unrealizedPnl: 50,           // Unrealized profit/loss
      liquidationPrice: 40000,
      timestamp: 1234567890
    }
  ]
}
```

##### orders
Open orders information

```typescript
await connector.getSwapAccountInfo("orders")
// Returns:
{
  success: true,
  openOrders: [
    {
      orderId: "123456789",
      symbol: "BTC-USDT",
      side: "buy",
      type: "limit",
      quantity: 0.1,
      price: 44000,
      status: "pending",
      filledQty: 0,
      timestamp: 1234567890,
      updateTime: 1234567890
    }
  ]
}
```

##### all (default)
Combine all account data

```typescript
await connector.getSwapAccountInfo("all")
// Returns: { balance: {...}, positions: [...], openOrders: [...] }
```

#### Usage Example
```typescript
const accountInfo = await connector.getSwapAccountInfo("all")

console.log(`Balance: ${accountInfo.balance.total} USDT`)
console.log(`Open Positions: ${accountInfo.positions.length}`)
console.log(`Open Orders: ${accountInfo.openOrders.length}`)

// Calculate total portfolio value
const portfolioValue = accountInfo.balance.total +
  accountInfo.positions.reduce((sum: number, pos: any) => 
    sum + (pos.unrealizedPnl), 0)
console.log(`Portfolio Value: $${portfolioValue}`)
```

#### API Endpoints
- **Balance**: `/openApi/swap/v3/user/balance` (GET)
- **Positions**: `/openApi/swap/v3/user/positionRisk` (GET)
- **Orders**: `/openApi/swap/v3/user/openOrders` (GET)

#### Authentication
- All operations require API key and secret
- Signature required for all account queries
- Request-level rate limiting

---

## Integration with Base Connector

These skills are fully integrated into the `BingXConnector` class:

```typescript
import { BingXConnector } from '@/lib/exchange-connectors/bingx-connector'

// Initialize connector
const connector = new BingXConnector({
  apiKey: "...",
  apiSecret: "...",
  isTestnet: false,
  apiType: "perpetual_futures"
})

// Use the skills
const market = await connector.getSwapMarketData("BTC-USDT")
const tradeResult = await connector.executeSwapTrade("placeOrder", {...})
const accountInfo = await connector.getSwapAccountInfo("all")
```

---

## Error Handling

All three skills include comprehensive error handling:

```typescript
try {
  const result = await connector.getSwapMarketData("INVALID")
} catch (error) {
  console.error("Market data error:", error.message)
  // Returns: { success: false, error: "API Error: Invalid symbol" }
}
```

#### Common Errors

| Error | Cause | Resolution |
|-------|-------|-----------|
| "Invalid symbol" | Symbol not found or wrong format | Use correct BingX format (e.g., "BTC-USDT") |
| "Insufficient balance" | Account balance too low | Fund account with more USDT |
| "Position not found" | No position for the symbol | Create position first |
| "Authentication failed" | Invalid API key/secret | Verify credentials |
| "Signature verification failed" | Timestamp sync issue | Synchronize system time |

---

## Best Practices

### 1. Symbol Format
Always use BingX format for perpetual futures:
```typescript
// ✓ Correct
await connector.getSwapMarketData("BTC-USDT")

// ✗ Incorrect (will fail)
await connector.getSwapMarketData("BTCUSDT")
await connector.getSwapMarketData("BTC/USDT")
```

### 2. Balance Checking
Always check balance before placing orders:
```typescript
const account = await connector.getSwapAccountInfo("balance")
if (account.balance.total >= orderCost) {
  // Place order
}
```

### 3. Risk Management
Use position queries before closing:
```typescript
const positions = await connector.getSwapAccountInfo("positions")
const btcPosition = positions.find(p => p.symbol === "BTC-USDT")
if (btcPosition && btcPosition.unrealizedPnl > targetProfit) {
  // Close position
}
```

### 4. Market Data Validation
Validate market conditions before trading:
```typescript
const market = await connector.getSwapMarketData("BTC-USDT")
if (market.fundingRate > 0.01) {
  // Funding rate too high, skip entry
} else {
  // Place order
}
```

---

## API Limits & Rate Limiting

### Public Endpoints (No Auth)
- `bingx-swap-market`: 100 requests/second
- No signature required
- Suitable for frequent polling

### Private Endpoints (Auth Required)
- `bingx-swap-trade`: 50 orders/10 seconds
- `bingx-swap-account`: 100 requests/10 seconds
- Signature and timestamp required
- Per-account rate limits

### Recommended Throttling
```typescript
// Market data: Query every 1-5 seconds
const marketUpdateInterval = 5000  // 5 seconds

// Account data: Query every 10-30 seconds
const accountUpdateInterval = 30000  // 30 seconds

// Trading: Manual, with order validation
// Place orders with at least 100ms between requests
```

---

## Testing

### Unit Test Example
```typescript
describe("BingX API Skills", () => {
  let connector: BingXConnector

  beforeEach(() => {
    connector = new BingXConnector({
      apiKey: process.env.BINGX_API_KEY,
      apiSecret: process.env.BINGX_API_SECRET,
      isTestnet: true  // Use testnet for testing
    })
  })

  test("getSwapMarketData returns market data", async () => {
    const market = await connector.getSwapMarketData("BTC-USDT")
    expect(market.success).toBe(true)
    expect(market.lastPrice).toBeGreaterThan(0)
    expect(market.fundingRate).toBeDefined()
  })

  test("executeSwapTrade place order works", async () => {
    const result = await connector.executeSwapTrade("placeOrder", {
      symbol: "BTC-USDT",
      side: "buy",
      quantity: 0.001,
      price: 45000,
      type: "limit"
    })
    expect(result.success).toBe(true)
    expect(result.orderId).toBeDefined()
  })

  test("getSwapAccountInfo returns account data", async () => {
    const account = await connector.getSwapAccountInfo("all")
    expect(account.success).toBe(true)
    expect(account.balance).toBeDefined()
    expect(account.positions).toBeInstanceOf(Array)
  })
})
```

---

## Migration Guide (From Old Implementation)

### Before
```typescript
// Old way - manual API calls
const balance = await getBalance()
const positions = await getPositions()
const orders = await getOpenOrders()
```

### After
```typescript
// New way - unified skill methods
const accountInfo = await connector.getSwapAccountInfo("all")
const { balance, positions, orders } = accountInfo
```

---

## Official References

- **BingX API Hub**: https://bingx-api.github.io/api-ai-skills/
- **GitHub Repository**: https://github.com/BingX-API/api-ai-skills
- **API Documentation**: https://bingx-api.github.io/docs/#/en-us/
- **WebSocket Documentation**: https://bingx-api.github.io/docs/#/en-us/wsapi

---

## Changelog

### Version 1.0 (May 13, 2026)
- Implemented bingx-swap-market skill
- Implemented bingx-swap-trade skill
- Implemented bingx-swap-account skill
- Full integration with BingXConnector
- Comprehensive error handling
- Rate limit support
- Documentation and examples

---

## Future Enhancements

### Planned Skills
1. **bingx-spot-market** — Spot market data queries
2. **bingx-spot-trade** — Spot trading operations
3. **bingx-spot-account** — Spot account information
4. **bingx-copytrade-swap** — Copy trading for futures
5. **bingx-sub-account** — Sub-account management

### Optimization Areas
1. WebSocket connections for real-time data
2. Batch request operations
3. Advanced order types (OCO, DCA)
4. Portfolio rebalancing tools

---

**Status**: Production Ready ✅
**Last Updated**: May 13, 2026

