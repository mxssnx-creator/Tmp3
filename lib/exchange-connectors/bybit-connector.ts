import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult } from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

/**
 * Bybit Exchange Connector (V5 Unified API)
 * 
 * Supported API Types (Contract Types):
 * - "unified": Unified Trading Account (default) - all contract types in one wallet
 * - "contract": Contract Trading Account - derivatives/futures only
 * - "spot": Spot Trading Account - spot trading only
 * - "inverse": Inverse perpetual contracts (deprecated in V5, use unified)
 * 
 * Documentation: https://bybit-exchange.github.io/docs/v5/intro
 * 
 * IMPORTANT: API Types are mapped to Bybit's accountType parameter:
 * - "unified" → accountType: UNIFIED (all trading in one account)
 * - "perpetual_futures"/"futures" → accountType: CONTRACT (derivatives only)
 * - "spot" → accountType: SPOT (spot trading only)
 * 
 * Balance Fields (all types use same structure):
 * - walletBalance: Total balance
 * - availableToWithdraw: Available balance
 * - locked: Frozen balance
 * 
 * Error Handling:
 * - Validates credentials (API key and secret required)
 * - Checks HTTP response status and retCode
 * - Catches JSON parsing errors
 * - Logs detailed error messages for debugging
 * 
 * Features:
 * - Unified trading account support
 * - Perpetual futures (up to 125x leverage)
 * - Spot trading
 * - Cross and isolated margin
 * - Hedge and one-way position modes
 * - Testnet support
 */
export class BybitConnector extends BaseExchangeConnector {
  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"
  }

  getCapabilities(): string[] {
    return [
      "unified",
      "perpetual_futures",
      "spot",
      "leverage",
      "hedge_mode",
      "trailing",
      "cross_margin",
      "isolated_margin",
    ]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting Bybit connection test")
    this.log(`Testnet: ${this.credentials.isTestnet ? "Yes" : "No"}`)
    this.log(`Using endpoint: ${this.getBaseUrl()}`)

    try {
      return await this.getBalance()
    } catch (error) {
      this.logError(error instanceof Error ? error.message : "Unknown error")
      return {
        success: false,
        balance: 0,
        capabilities: this.getCapabilities(),
        error: error instanceof Error ? error.message : "Connection test failed",
        logs: this.logs,
      }
    }
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    const timestamp = Date.now()
    const baseUrl = this.getBaseUrl()

    this.log("Generating signature...")

    try {
      const recvWindow = "5000"
      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      this.log("Fetching account balance...")
      const accountType = this.getEffectiveAccountType()
      const configuredApiType = this.credentials.apiType || "not set"
      this.log(`Configured API Type: ${configuredApiType}`)
      this.log(`Using Bybit accountType: ${accountType}`)
      console.log(`[v0] [Bybit] API Type: ${configuredApiType} → accountType: ${accountType}`)

      // Bybit V5 API uses accountType parameter: UNIFIED, CONTRACT, SPOT
      // UNIFIED = all contracts in one account, CONTRACT = derivatives only, SPOT = spot only
      const apiType = this.credentials.apiType || "perpetual_futures"
      console.log(`[v0] [Bybit] API Type: ${apiType}, Account Type: ${accountType}`)
      this.log(`Using account type: ${accountType} for API type: ${apiType}`)
      
      const response = await this.rateLimitedFetch(`${baseUrl}/v5/account/wallet-balance?accountType=${accountType}`, {
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": this.credentials.apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp.toString(),
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
        signal: AbortSignal.timeout(this.timeout),
      })

      const data = await safeParseResponse(response)

      // Check for error responses or HTML error pages
      if (!response.ok || data.error) {
        const errorMsg = data.error || data.retMsg || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error: ${errorMsg}`)
        throw new Error(errorMsg)
      }

      if (data.retCode !== 0) {
        this.logError(`API Error: ${data.retMsg || "Unknown error"}`)
        throw new Error(data.retMsg || "Bybit API error")
      }

      this.log("Successfully retrieved account data")

      const coins = data.result?.list?.[0]?.coin || []
      const usdtCoin = coins.find((c: any) => c.coin === "USDT")
      const usdtBalance = Number.parseFloat(usdtCoin?.walletBalance || "0")

      const balances = coins.map((c: any) => ({
        asset: c.coin,
        free: Number.parseFloat(c.availableToWithdraw || "0"),
        locked: Number.parseFloat(c.locked || "0"),
        total: Number.parseFloat(c.walletBalance || "0"),
      }))

      this.log(`Account Balance: ${usdtBalance.toFixed(2)} USDT`)

      return {
        success: true,
        balance: usdtBalance,
        balances,
        capabilities: this.getCapabilities(),
        logs: this.logs,
      }
    } catch (error) {
      this.logError(`Connection error: ${error instanceof Error ? error.message : "Unknown"}`)
      throw error
    }
  }

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit"
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      this.log(`Placing ${orderType} ${side} order: ${quantity} ${symbol}`)

      const body = {
        category: this.credentials.apiType === "spot" ? "spot" : "linear",
        symbol,
        side: side.toUpperCase(),
        orderType: orderType === "market" ? "Market" : "Limit",
        qty: String(quantity),
        timeInForce: "GTC",
      } as any

      if (price && orderType === "limit") {
        body.price = String(price)
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/order/create?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      const orderId = data.result?.orderId
      this.log(`✓ Order placed successfully: ${orderId}`)

      return { success: true, orderId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)

      const body = {
        category: this.credentials.apiType === "spot" ? "spot" : "linear",
        symbol,
        orderId,
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/order/cancel?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      this.log(`✓ Order cancelled successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to cancel order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    try {
      this.log(`Fetching order ${orderId} for ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"
      const category = this.credentials.apiType === "spot" ? "spot" : "linear"

      const queryString = `api_key=${this.credentials.apiKey}&category=${category}&orderId=${orderId}&recv_window=${recvWindow}&symbol=${symbol}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/order/realtime?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        return null
      }

      return data.result?.list?.[0]
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order: ${errorMsg}`)
      return null
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"
      const category = this.credentials.apiType === "spot" ? "spot" : "linear"

      let queryString = `api_key=${this.credentials.apiKey}&category=${category}&openOnly=1&recv_window=${recvWindow}&timestamp=${timestamp}`
      if (symbol) {
        queryString += `&symbol=${symbol}`
      }

      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/order/realtime?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        return []
      }

      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch open orders: ${errorMsg}`)
      return []
    }
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"
      const category = this.credentials.apiType === "spot" ? "spot" : "linear"

      let queryString = `api_key=${this.credentials.apiKey}&category=${category}&limit=${limit}&recv_window=${recvWindow}&timestamp=${timestamp}`
      if (symbol) {
        queryString += `&symbol=${symbol}`
      }

      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/order/history?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        return []
      }

      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    if (this.credentials.apiType === "spot") {
      this.log("Positions not available for spot trading")
      return []
    }

    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"
      const accountType = this.getEffectiveAccountType()

      let queryString = `api_key=${this.credentials.apiKey}&accountType=${accountType}&recv_window=${recvWindow}&timestamp=${timestamp}`
      if (symbol) {
        queryString += `&symbol=${symbol}`
      }

      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/position/list?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        return []
      }

      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch positions: ${errorMsg}`)
      return []
    }
  }

  async getPosition(symbol: string): Promise<any> {
    const positions = await this.getPositions(symbol)
    return positions.length > 0 ? positions[0] : null
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Modifying position ${symbol}${leverage ? ` leverage=${leverage}` : ""}${marginType ? ` marginType=${marginType}` : ""}`)

      const body: any = {
        category: "linear",
        symbol,
      }

      if (leverage) {
        body.leverage = String(leverage)
      }

      if (marginType) {
        body.tradeMode = marginType === "cross" ? 0 : 1
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/position/set-leverage?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      this.log(`✓ Position modified successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to modify position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Closing position ${symbol}${positionSide ? ` (${positionSide})` : ""}`)

      const position = await this.getPosition(symbol)
      if (!position) {
        return { success: false, error: "Position not found" }
      }

      const side = position.side === "Buy" ? "Sell" : "Buy"
      const result = await this.placeOrder(symbol, side.toLowerCase() as "buy" | "sell", position.size, undefined, "market")

      if (!result.success) {
        return result
      }

      this.log(`✓ Position closed successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to close position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&coin=${coin}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/asset/deposit/query-address?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      const address = data.result?.address
      this.log(`✓ Deposit address retrieved: ${address?.slice(0, 10)}...`)

      return { address }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch deposit address: ${errorMsg}`)
      return { error: errorMsg }
    }
  }

  async withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      this.log(`Withdrawing ${amount} ${coin} to ${address.slice(0, 10)}...`)

      const body = {
        coin,
        address,
        amount: String(amount),
        chainType: "BTC", // Default to BTC chain - should be configurable
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/asset/withdraw/create?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      const txId = data.result?.id
      this.log(`✓ Withdrawal initiated: ${txId}`)

      return { success: true, txId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to withdraw: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTransferHistory(limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching transfer history (limit: ${limit})`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&limit=${limit}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/asset/transfer/query-inter-transfer-list?${queryString}&sign=${signature}`)

      const data = await response.json()

      if (data.retCode !== 0) {
        return []
      }

      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch transfer history: ${errorMsg}`)
      return []
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting leverage to ${leverage}x for ${symbol}`)

      const body = {
        category: "linear",
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/position/set-leverage?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      this.log(`✓ Leverage set to ${leverage}x`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set leverage: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting margin type to ${marginType} for ${symbol}`)

      const body = {
        category: "linear",
        symbol,
        tradeMode: marginType === "cross" ? 0 : 1,
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/position/switch-mode?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      this.log(`✓ Margin type set to ${marginType}`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set margin type: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting position mode to ${hedgeMode ? "hedge" : "one-way"}`)

      const body = {
        category: "linear",
        mode: hedgeMode ? 2 : 0,
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      const recvWindow = "5000"

      const queryString = `api_key=${this.credentials.apiKey}&recv_window=${recvWindow}&timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/v5/position/switch-mode?${queryString}&sign=${signature}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg || "Unknown error"}`)
      }

      this.log(`✓ Position mode set to ${hedgeMode ? "hedge" : "one-way"}`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set position mode: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    try {
      this.log(`Fetching ticker for ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const category = this.credentials.apiType === "spot" ? "spot" : "linear"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/tickers?category=${category}&symbol=${symbol}`
      )

      const data = await response.json()

      if (data.retCode !== 0 || !data.result?.list?.[0]) {
        return null
      }

      const ticker = data.result.list[0]
      const bid = Number.parseFloat(ticker.bid1Price || "0")
      const ask = Number.parseFloat(ticker.ask1Price || "0")
      const last = Number.parseFloat(ticker.lastPrice || "0")

      this.log(`✓ Ticker fetched: bid=${bid}, ask=${ask}, last=${last}`)
      return { bid, ask, last }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch ticker: ${errorMsg}`)
      return null
    }
  }

  async getOHLCV(symbol: string, timeframe = "1m", limit = 250): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null> {
    try {
      this.log(`Fetching OHLCV for ${symbol} (${timeframe}, ${limit} candles)`)

      const baseUrl = this.getBaseUrl()
      const category = this.credentials.apiType === "spot" ? "spot" : "linear"
      
      // Convert timeframe to Bybit interval format
      const intervalMap: Record<string, string> = {
        "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
        "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
        "1d": "D", "1w": "W", "1M": "M"
      }
      const interval = intervalMap[timeframe] || "1"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`
      )

      const data = await response.json()

      if (data.retCode !== 0 || !data.result?.list) {
        this.logError(`✗ Failed to fetch OHLCV: ${data.retMsg || "Unknown error"}`)
        return null
      }

      // Bybit returns: [timestamp, open, high, low, close, volume, turnover]
      const candles = data.result.list.map((c: string[]) => ({
        timestamp: Number.parseInt(c[0]),
        open: Number.parseFloat(c[1]),
        high: Number.parseFloat(c[2]),
        low: Number.parseFloat(c[3]),
        close: Number.parseFloat(c[4]),
        volume: Number.parseFloat(c[5])
      })).reverse() // Reverse to get chronological order

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch OHLCV: ${errorMsg}`)
      return null
    }
  }
}
