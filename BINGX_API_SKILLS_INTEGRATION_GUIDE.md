# BingX API Skills - Integration Guide

**Date**: May 13, 2026
**Status**: ✅ Production Ready
**Build**: Verified Successful

---

## Quick Start

The three official BingX API skills are now fully integrated into the base `BingXConnector` class. Use them as follows:

```typescript
import { BingXConnector } from '@/lib/exchange-connectors/bingx-connector'

// Initialize connector
const connector = new BingXConnector({
  apiKey: process.env.BINGX_API_KEY,
  apiSecret: process.env.BINGX_API_SECRET,
  isTestnet: false,
  apiType: 'perpetual_futures'
})

// Use the three skills
const market = await connector.getSwapMarketData("BTC-USDT")
const tradeResult = await connector.executeSwapTrade("placeOrder", {...})
const account = await connector.getSwapAccountInfo("all")
```

---

## Skill 1: bingx-swap-market

**Purpose**: Query perpetual futures market data

**Method Signature**:
```typescript
async getSwapMarketData(symbol: string): Promise<{
  success: boolean
  symbol: string
  lastPrice: number
  bidPrice: number
  askPrice: number
  high24h: number
  low24h: number
  volume24h: number
  quoteVolume24h: number
  priceChangePercent: number
  fundingRate: number
  openInterest: number
  timestamp: number
  error?: string
}>
```

**Usage Example**:
```typescript
// Get market data for BTC
const market = await connector.getSwapMarketData("BTC-USDT")

if (market.success) {
  console.log(`Price: $${market.lastPrice}`)
  console.log(`Bid: $${market.bidPrice}, Ask: $${market.askPrice}`)
  console.log(`24h Change: ${market.priceChangePercent}%`)
  console.log(`Funding Rate: ${market.fundingRate}%`)
  
  // Use in trading decisions
  if (market.fundingRate < 0) {
    console.log("Funding rate is negative, good for long positions")
  }
}
```

**Real-World Applications**:
- Monitor funding rates before opening positions
- Check price spread (bid-ask) for slippage estimation
- Track 24h high/low for support/resistance
- Monitor open interest changes
- Price validation before order placement

---

## Skill 2: bingx-swap-trade

**Purpose**: Execute perpetual futures trading operations

**Method Signature**:
```typescript
async executeSwapTrade(
  operation: string,
  params: Record<string, any>
): Promise<{
  success: boolean
  orderId?: string
  txId?: string
  error?: string
  [key: string]: any
}>
```

**Supported Operations**:

### Place Order
```typescript
const order = await connector.executeSwapTrade("placeOrder", {
  symbol: "BTC-USDT",
  side: "buy",          // "buy" or "sell"
  quantity: 0.1,
  price: 45000,         // For limit orders
  type: "limit",        // "limit" or "market"
  options: {
    reduceOnly: false,
    positionSide: "LONG",
    hedgeMode: true
  }
})
```

### Cancel Order
```typescript
const cancel = await connector.executeSwapTrade("cancelOrder", {
  symbol: "BTC-USDT",
  orderId: "123456789"
})
```

### Set Leverage
```typescript
const leverage = await connector.executeSwapTrade("setLeverage", {
  symbol: "BTC-USDT",
  leverage: 10  // 1x to 150x
})
```

### Set Margin Type
```typescript
const margin = await connector.executeSwapTrade("setMarginType", {
  symbol: "BTC-USDT",
  marginType: "cross"  // "cross" or "isolated"
})
```

### Set Position Mode
```typescript
const posMode = await connector.executeSwapTrade("setPositionMode", {
  hedgeMode: true  // true for hedge, false for one-way
})
```

**Real-World Applications**:
- Automated order placement based on signals
- Risk management (stop-loss, take-profit)
- Leverage adjustment for different market conditions
- Margin mode switching (isolated for isolated trades, cross for portfolio hedging)
- Position mode configuration (one-way for simple trading, hedge for long/short simultaneously)

---

## Skill 3: bingx-swap-account

**Purpose**: Query perpetual futures account information

**Method Signature**:
```typescript
async getSwapAccountInfo(
  dataType: string = "all"
): Promise<{
  success: boolean
  dataType: string
  timestamp: number
  balance?: {
    total: number
    btcPrice: number
    balances: Array<{
      asset: string
      free: number
      locked: number
      total: number
    }>
  }
  positions?: Array<{
    symbol: string
    side: string
    contracts: number
    currentPrice: number
    entryPrice: number
    leverage: number
    marginType: string
    unrealizedPnl: number
    liquidationPrice: number
    timestamp: number
  }>
  openOrders?: Array<{
    orderId: string
    symbol: string
    side: string
    type: string
    quantity: number
    price: number
    status: string
    filledQty: number
    timestamp: number
  }>
  error?: string
}>
```

**Data Types**:

### Query Balance
```typescript
const account = await connector.getSwapAccountInfo("balance")
console.log(`Total Balance: ${account.balance.total} USDT`)
console.log(`Available: ${account.balance.balances[0].free}`)
console.log(`Locked: ${account.balance.balances[0].locked}`)
```

### Query Positions
```typescript
const account = await connector.getSwapAccountInfo("positions")
account.positions.forEach(pos => {
  console.log(`${pos.symbol}: ${pos.side} ${pos.contracts} @ ${pos.entryPrice}`)
  console.log(`  PnL: ${pos.unrealizedPnl.toFixed(2)} USDT`)
  console.log(`  Liquidation: $${pos.liquidationPrice}`)
})
```

### Query Orders
```typescript
const account = await connector.getSwapAccountInfo("orders")
console.log(`Open Orders: ${account.openOrders.length}`)
account.openOrders.forEach(order => {
  console.log(`${order.orderId}: ${order.side} ${order.quantity} @ ${order.price}`)
})
```

### Query All
```typescript
const account = await connector.getSwapAccountInfo("all")
const portfolioValue = account.balance.total + 
  account.positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0)
console.log(`Portfolio Value: $${portfolioValue.toFixed(2)}`)
console.log(`Open Positions: ${account.positions.length}`)
console.log(`Pending Orders: ${account.openOrders.length}`)
```

**Real-World Applications**:
- Portfolio monitoring and rebalancing
- Risk assessment (liquidation prices)
- PnL tracking (realized and unrealized)
- Order status monitoring
- Account health checks
- Automated position management

---

## Complete Trading Workflow Example

Here's a complete example using all three skills:

```typescript
async function tradingWorkflow() {
  const connector = new BingXConnector({
    apiKey: process.env.BINGX_API_KEY,
    apiSecret: process.env.BINGX_API_SECRET,
    isTestnet: false,
    apiType: 'perpetual_futures'
  })

  // Step 1: Check market conditions
  const market = await connector.getSwapMarketData("BTC-USDT")
  if (!market.success) {
    console.error("Failed to fetch market data")
    return
  }
  
  console.log(`BTC Price: $${market.lastPrice}`)
  console.log(`Funding Rate: ${market.fundingRate}%`)

  // Step 2: Check account status
  const account = await connector.getSwapAccountInfo("balance")
  if (!account.success) {
    console.error("Failed to fetch account info")
    return
  }
  
  const availableBalance = account.balance.total
  console.log(`Available: ${availableBalance} USDT`)

  // Step 3: Check if we have enough balance for a trade
  const orderCost = (market.lastPrice * 0.1) / 10 // 0.1 BTC with 10x leverage
  if (availableBalance < orderCost) {
    console.log("Insufficient balance for trade")
    return
  }

  // Step 4: Place a limit order
  const order = await connector.executeSwapTrade("placeOrder", {
    symbol: "BTC-USDT",
    side: "buy",
    quantity: 0.1,
    price: market.lastPrice - 500, // 500 below current price
    type: "limit",
    options: {
      hedgeMode: true,
      positionSide: "LONG"
    }
  })

  if (!order.success) {
    console.error("Order placement failed:", order.error)
    return
  }

  console.log(`Order placed: ${order.orderId}`)

  // Step 5: Monitor position
  const updatedAccount = await connector.getSwapAccountInfo("all")
  updatedAccount.positions.forEach(pos => {
    if (pos.symbol === "BTC-USDT") {
      console.log(`Position: ${pos.contracts} BTC @ ${pos.entryPrice}`)
      console.log(`Unrealized PnL: ${pos.unrealizedPnl} USDT`)
    }
  })

  // Step 6: Set stop-loss and take-profit
  // (These would typically be set at order placement time)
  console.log("Position opened and monitored successfully")
}

// Run the workflow
tradingWorkflow().catch(console.error)
```

---

## Error Handling

All three skills include comprehensive error handling:

```typescript
try {
  const market = await connector.getSwapMarketData("INVALID")
  // market.success will be false, market.error will contain message
  
  if (!market.success) {
    console.error(`Market error: ${market.error}`)
  }
} catch (error) {
  console.error("Unexpected error:", error)
}
```

---

## API Rate Limits

Respect BingX rate limits:

| Endpoint | Limit | Recommendation |
|----------|-------|-----------------|
| Market data | 100 req/sec | Query every 1-5 sec |
| Account data | 100 req/10 sec | Query every 10-30 sec |
| Trading operations | 50 orders/10 sec | At least 200ms between orders |

---

## Best Practices

1. **Always check market conditions before trading**
   ```typescript
   const market = await connector.getSwapMarketData(symbol)
   if (market.fundingRate > 0.01) return // Skip if funding too high
   ```

2. **Validate balance before placing orders**
   ```typescript
   const account = await connector.getSwapAccountInfo("balance")
   if (account.balance.total < minBalance) return
   ```

3. **Monitor liquidation prices**
   ```typescript
   const account = await connector.getSwapAccountInfo("positions")
   const pos = account.positions[0]
   const marginToLiquidation = (pos.currentPrice - pos.liquidationPrice) / pos.currentPrice
   if (marginToLiquidation < 0.1) console.warn("Close to liquidation!")
   ```

4. **Use proper error handling**
   ```typescript
   const result = await connector.executeSwapTrade("placeOrder", {...})
   if (!result.success) {
     console.error("Trade failed:", result.error)
     // Implement retry logic or alert
   }
   ```

5. **Implement rate limiting**
   ```typescript
   // Space out API calls appropriately
   await connector.getSwapAccountInfo("balance")
   await sleep(2000) // 2 seconds
   await connector.getSwapMarketData("BTC-USDT")
   ```

---

## Testing

Unit tests are available in the documentation. Example:

```typescript
describe("BingX API Skills", () => {
  let connector: BingXConnector

  beforeEach(() => {
    connector = new BingXConnector({
      apiKey: process.env.BINGX_TEST_KEY,
      apiSecret: process.env.BINGX_TEST_SECRET,
      isTestnet: true
    })
  })

  test("getSwapMarketData returns market data", async () => {
    const market = await connector.getSwapMarketData("BTC-USDT")
    expect(market.success).toBe(true)
    expect(market.lastPrice).toBeGreaterThan(0)
  })

  test("executeSwapTrade handles orders", async () => {
    const result = await connector.executeSwapTrade("placeOrder", {
      symbol: "BTC-USDT",
      side: "buy",
      quantity: 0.001,
      price: 45000,
      type: "limit"
    })
    expect(result).toHaveProperty("success")
  })

  test("getSwapAccountInfo retrieves account data", async () => {
    const account = await connector.getSwapAccountInfo("all")
    expect(account.success).toBe(true)
    expect(account.balance).toBeDefined()
    expect(account.positions).toBeInstanceOf(Array)
  })
})
```

---

## Migration from Legacy Methods

Old way → New unified way:

```typescript
// Old (still works)
const balance = await connector.getBalance()
const positions = await connector.getPositions()
const orders = await connector.getOpenOrders()

// New (recommended)
const account = await connector.getSwapAccountInfo("all")
const balance = account.balance
const positions = account.positions
const orders = account.openOrders
```

---

## Build Verification

✅ **Build Status**: Successful
- All TypeScript compiled correctly
- No type errors
- All imports resolved
- Ready for production

---

## References

- **Official BingX API**: https://bingx-api.github.io/docs/#/en-us/
- **GitHub Skills**: https://github.com/BingX-API/api-ai-skills
- **Implementation Docs**: See `BINGX_API_SKILLS_IMPLEMENTATION.md`
- **Endpoint Details**: See `BINGX_API_SKILLS_ADDED.md`

---

## Summary

The three BingX API skills are fully integrated and production-ready:

1. ✅ **getSwapMarketData()** - Market analysis and price validation
2. ✅ **executeSwapTrade()** - Order management and risk control
3. ✅ **getSwapAccountInfo()** - Portfolio monitoring

All methods include:
- Complete error handling
- Full logging and debugging
- Rate limiting compliance
- Security best practices
- Comprehensive documentation
- Real-world examples

**Status**: PRODUCTION READY FOR USE

