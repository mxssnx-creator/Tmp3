import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult } from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

/**
 * BingX Exchange Connector
 * 
 * Supported API Types:
 * - "spot": Spot trading, uses /openApi/spot/v1/account/balance
 * - "perpetual_futures": Perpetual futures, uses /openApi/swap/v3/user/balance
 * - "standard": Standard futures (deprecated, treated as perpetual)
 * 
 * Documentation: https://bingx-api.github.io/docs/#/en-us/
 * 
 * IMPORTANT: BingX uses different balance field names for different contract types:
 * - SPOT: free (available), locked (in orders), balance (total)
 * - PERPETUAL: availableMargin (available), frozenMargin (locked), balance (total)
 * 
 * Error Handling:
 * - Validates credentials before API calls
 * - Catches and logs all connection errors with descriptive messages
 * - Returns detailed logs for debugging failed connections
 * 
 * Features:
 * - Futures trading (up to 150x leverage)
 * - Perpetual swap contracts
 * - Cross-margin trading
 * - Hedge position mode
 */
export class BingXConnector extends BaseExchangeConnector {
  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://testnet-open-api.bingx.com" : "https://open-api.bingx.com"
  }

  private getSignature(params: Record<string, any>): string {
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&')
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
  }

  private toStringParams(params: Record<string, any>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      result[key] = String(value)
    }
    return result
  }

  /**
   * Convert a plain symbol (e.g. "BTCUSDT") into the BingX-specific format
   * required by the perpetual-futures endpoints ("BTC-USDT").
   *
   * Spot endpoints historically accept both "BTCUSDT" and "BTC-USDT", but
   * perpetual-futures trade endpoints (/openApi/swap/v2/trade/*) will respond
   * with the generic "this api is not exist" error when the symbol lacks the
   * hyphen, which is the most common source of order-placement failures.
   *
   * This helper is idempotent (already-hyphenated input is returned as-is) and
   * only applied when the credentials describe a non-spot account.
   */
  private toBingXSymbol(symbol: string): string {
    if (!symbol) return symbol
    // Already hyphenated → nothing to do.
    if (symbol.includes("-")) return symbol
    // Spot still uses the plain BTCUSDT format on BingX.
    if (this.credentials.apiType === "spot") return symbol

    const upper = symbol.toUpperCase()
    // Handle common quote assets; insert a dash before the quote.
    const quotes = ["USDT", "USDC", "BTC", "ETH", "USD"]
    for (const quote of quotes) {
      if (upper.endsWith(quote) && upper.length > quote.length) {
        return `${upper.slice(0, upper.length - quote.length)}-${quote}`
      }
    }
    return upper
  }

  /** BingX returns `code` as a number on some endpoints and a string on others. */
  private isBingXSuccess(code: unknown): boolean {
    return code === 0 || code === "0"
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage", "hedge_mode", "cross_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting BingX connection test")
    this.log(`Using endpoint: ${this.getBaseUrl()}`)
    this.log(`Environment: ${this.credentials.isTestnet ? "testnet" : "mainnet"}`)

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
      // Validate credentials first
      if (!this.credentials.apiKey || !this.credentials.apiSecret) {
        throw new Error("API key and secret are required")
      }

      // Build query parameters - only timestamp for balance query
      const params: Record<string, string> = {
        timestamp: String(timestamp),
      }

      // Sort parameters alphabetically and build query string (BingX requirement)
      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&')

      // Generate HMAC-SHA256 signature from the query string
      const signature = crypto
        .createHmac("sha256", this.credentials.apiSecret)
        .update(queryString)
        .digest("hex")

      this.log(`Query string: ${queryString}`)
      this.log(`API Key prefix: ${this.credentials.apiKey.substring(0, 10)}...`)
      this.log(`Signature (first 16 chars): ${signature.substring(0, 16)}...`)

      this.log("Fetching account balance...")

      // Determine endpoint based on contract_type OR api_type from credentials
      // contract_type: "usdt-perpetual", "coin-perpetual", "spot"
      // api_type: "perpetual_futures", "spot", "standard"
      const contractType = this.credentials.contractType
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      // Use contract_type for endpoint determination (more specific)
      // Fall back to api_type if contract_type is not set
      let endpoint = "/openApi/swap/v3/user/balance" // Default: USDT perpetual futures
      let effectiveContractType = contractType || "usdt-perpetual"
      
      // If contract_type is set, use it; otherwise derive from api_type
      if (contractType) {
        effectiveContractType = contractType
      } else if (apiType === "spot") {
        effectiveContractType = "spot"
      }
      
      this.log(`[BingX] Contract Type: ${effectiveContractType}, API Type: ${apiType}`)
      
      if (effectiveContractType === "spot" || apiType === "spot") {
        endpoint = "/openApi/spot/v1/account/balance"
        this.log("Contract Type: SPOT → Using /openApi/spot/v1/account/balance")
        this.log("⚠️ WARNING: Spot API will return 0 balance if you have Perpetual Futures positions!")
        console.log("[v0] [BingX] Contract Type: SPOT → Endpoint: /openApi/spot/v1/account/balance")
      } else if (effectiveContractType === "coin-perpetual") {
        // Coin-M Perpetual Futures - different API path!
        endpoint = "/openApi/cswap/v1/user/balance"
        this.log("Contract Type: COIN-M PERPETUAL → Using /openApi/cswap/v1/user/balance")
        console.log("[v0] [BingX] Contract Type: COIN-M PERPETUAL → Endpoint: /openApi/cswap/v1/user/balance")
      } else {
        // USDT Perpetual Futures (default)
        endpoint = "/openApi/swap/v3/user/balance"
        this.log("Contract Type: USDT PERPETUAL → Using /openApi/swap/v3/user/balance")
        console.log("[v0] [BingX] Contract Type: USDT PERPETUAL → Endpoint: /openApi/swap/v3/user/balance")
      }

      const url = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`
      this.log(`Full URL: ${baseUrl}${endpoint}`)

      const response = await this.rateLimitedFetch(url, {
        method: "GET",
        headers: {
          "X-BX-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
      })

      const data = await safeParseResponse(response)

      this.log(`Response status: ${response.status}`)
      this.log(`Response code: ${data.code}`)

      // Check for error responses — BingX can return `code` as a number or string
      if (!response.ok || !this.isBingXSuccess(data.code)) {
        const errorMsg = data.msg || data.error || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error (code ${data.code}): ${errorMsg}`)
        throw new Error(errorMsg)
      }

      this.log("Successfully retrieved account data")

      // Parse balance data - BingX returns data.data as the array directly
      this.log(`[Debug] Full response data: ${JSON.stringify(data).substring(0, 500)}`)
      
      // data.data IS the balance array, not data.data.balance
      const balanceData = Array.isArray(data.data) ? data.data : []
      
      if (!Array.isArray(balanceData)) {
        this.logError(`Invalid balance data format: ${JSON.stringify(balanceData).substring(0, 200)}`)
        throw new Error("Invalid balance data format from API")
      }

      this.log(`[Debug] Received ${balanceData.length} balance entries`)
      if (balanceData.length > 0) {
        this.log(`[Debug] First balance entry: ${JSON.stringify(balanceData[0]).substring(0, 300)}`)
      }

      // Extract USDT balance - BingX returns balance as a string number
      // For SPOT: use 'balance' field (total = free + locked, already calculated)
      // For PERPETUAL: use 'balance' field (this is the total balance in wallet)
      const usdtEntry = balanceData.find((b: any) => b.asset === "USDT")
      const usdtBalance = usdtEntry ? Number.parseFloat(usdtEntry.balance || "0") : 0
      
      this.log(`[Debug] USDT entry found: ${!!usdtEntry}`)
      this.log(`[Debug] USDT balance value: ${usdtBalance}`)

      // Get BTC price from market data
      // BingX spot ticker returns: { code: 0, data: { symbol, lastPrice, priceChangePercent, ... } }
      let btcPrice = 0
      try {
        const priceResponse = await fetch("https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?symbol=BTC-USDT")
        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          // The 24hr ticker returns data as an array or object; lastPrice is the current price
          const ticker = Array.isArray(priceData.data) ? priceData.data[0] : priceData.data
          btcPrice = Number.parseFloat(ticker?.lastPrice || ticker?.closePrice || ticker?.price || "0")
          this.log(`[Debug] BTC/USDT price fetched: $${btcPrice.toFixed(2)}`)
        }
      } catch (e) {
        this.log(`[Debug] Could not fetch BTC price: ${e}`)
      }

      // Map all balances with proper field extraction
      // IMPORTANT: BingX uses different field names for SPOT vs PERPETUAL
      const isFutures = apiType === "perpetual_futures" || apiType === "futures"
      const balances = balanceData.map((b: any) => {
        // For SPOT: availableMargin/frozenMargin are futures-only fields
        // Use free/locked for spot, availableMargin/frozenMargin for perpetual
        
        if (isFutures) {
          // Perpetual Futures: availableMargin = available, frozenMargin = locked
          return {
            asset: b.asset || "UNKNOWN",
            free: Number.parseFloat(b.availableMargin || "0"),
            locked: Number.parseFloat(b.frozenMargin || "0"),
            total: Number.parseFloat(b.balance || "0"),
          }
        } else {
          // SPOT: free/locked are the correct fields
          return {
            asset: b.asset || "UNKNOWN",
            free: Number.parseFloat(b.free || "0"),
            locked: Number.parseFloat(b.locked || "0"),
            total: Number.parseFloat(b.balance || "0"),
          }
        }
      })

      this.log(`✓ Account balance: ${usdtBalance.toFixed(4)} USDT`)
      this.log(`✓ Total assets: ${balances.length}`)
      this.log(`✓ BTC price: $${btcPrice.toFixed(2)}`)

      return {
        success: true,
        balance: usdtBalance,
        btcPrice: btcPrice,
        balances,
        capabilities: this.getCapabilities(),
        logs: this.logs,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Connection error: ${errorMsg}`)
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
      // ── Quantity sanity & formatting ─────────────────────────────────────
      // BingX rejects quantities that fall below the symbol step size, and in
      // many cases responds with its generic "this api is not exist" error
      // instead of a precise reason. Normalise the quantity to a reasonable
      // precision and refuse obviously-doomed amounts before signing.
      if (!Number.isFinite(quantity) || quantity <= 0) {
        const msg = `Invalid quantity: ${quantity}`
        this.logError(`✗ ${msg}`)
        return { success: false, error: msg }
      }
      // Round to 6 decimal places (enough for both high- and low-priced assets)
      // then strip trailing zeros when serialising.
      const roundedQty = Math.round(quantity * 1e6) / 1e6
      if (roundedQty < 0.000001) {
        const msg = `Quantity too small after rounding: ${quantity} → ${roundedQty}`
        this.logError(`✗ ${msg}`)
        return { success: false, error: msg }
      }
      // Serialise without scientific notation or trailing zeros.
      const qtyStr = roundedQty.toFixed(6).replace(/\.?0+$/, "")

      // ── Symbol formatting ────────────────────────────────────────────────
      // BingX perpetual futures require the hyphenated form "BTC-USDT". Spot
      // accepts either. Passing "BTCUSDT" to a perp trade endpoint is the
      // single biggest cause of "this api is not exist" errors in the wild.
      const isSpot = this.credentials.apiType === "spot"
      const bingxSymbol = this.toBingXSymbol(symbol)

      this.log(`Placing ${orderType} ${side} order: ${qtyStr} ${bingxSymbol} (raw=${symbol})`)

      // Trade endpoints live under /openApi/swap/v2/* for perpetual futures
      // and /openApi/spot/v1/* for spot.
      const endpoint = isSpot ? "/openApi/spot/v1/trade/order" : "/openApi/swap/v2/trade/order"

      const params: Record<string, any> = {
        symbol: bingxSymbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: qtyStr,
        timestamp: Date.now(),
      }

      // BingX perpetual futures requires positionSide. Sending LONG/SHORT
      // works in both hedge and one-way mode; omit for spot.
      if (!isSpot) {
        params.positionSide = side === "buy" ? "LONG" : "SHORT"
      }

      if (price && orderType === "limit") {
        // Same precision treatment for price.
        const priceRounded = Math.round(price * 1e8) / 1e8
        params.price = priceRounded.toFixed(8).replace(/\.?0+$/, "")
      }

      const signature = this.getSignature(params)
      const stringParams = this.toStringParams(params)
      const queryString = `${new URLSearchParams(stringParams).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
      }

      // BingX wraps the order payload inconsistently: sometimes data.data.order,
      // sometimes data.data, sometimes data.data.orderId directly.
      const orderInfo = data.data?.order || data.data || {}
      const orderId = orderInfo.orderId || orderInfo.id || data.data?.orderId
      this.log(`✓ Order placed successfully: ${orderId}`)

      return { success: true, orderId: orderId ? String(orderId) : undefined }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)

      // Perp swap: DELETE /openApi/swap/v2/trade/order (no separate cancel path).
      // Spot: POST /openApi/spot/v1/trade/cancel (v1 spot still uses a subpath).
      const isSpot = this.credentials.apiType === "spot"
      const endpoint = isSpot ? "/openApi/spot/v1/trade/cancel" : "/openApi/swap/v2/trade/order"
      const method = isSpot ? "POST" : "DELETE"
      const bingxSymbol = this.toBingXSymbol(symbol)

      const params = {
        symbol: bingxSymbol,
        orderId,
        timestamp: Date.now(),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method,
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
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

      // Perp swap: GET /openApi/swap/v2/trade/order (same path as place/cancel, different method).
      // Spot: GET /openApi/spot/v1/trade/query (v1 spot uses a subpath).
      const isSpot = this.credentials.apiType === "spot"
      const endpoint = isSpot ? "/openApi/spot/v1/trade/query" : "/openApi/swap/v2/trade/order"
      const bingxSymbol = this.toBingXSymbol(symbol)

      const params = {
        symbol: bingxSymbol,
        orderId,
        timestamp: Date.now(),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "GET",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return null
      }

      return data.data
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order: ${errorMsg}`)
      return null
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)

      // Perp: /openApi/swap/v2/trade/openOrders (not v3).
      const endpoint = this.credentials.apiType === "spot" ? "/openApi/spot/v1/trade/openOrders" : "/openApi/swap/v2/trade/openOrders"

      const params: Record<string, any> = {
        timestamp: Date.now(),
      }

      if (symbol) {
        params.symbol = this.toBingXSymbol(symbol)
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return []
      }

      // Swap openOrders returns { orders: [...] }; spot returns an array directly.
      const rows = data.data?.orders || data.data
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch open orders: ${errorMsg}`)
      return []
    }
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)

      // Perp: /openApi/swap/v2/trade/allOrders (not v3).
      const endpoint = this.credentials.apiType === "spot" ? "/openApi/spot/v1/trade/allOrders" : "/openApi/swap/v2/trade/allOrders"

      const params: Record<string, any> = {
        limit,
        timestamp: Date.now(),
      }

      if (symbol) {
        params.symbol = this.toBingXSymbol(symbol)
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return []
      }

      const rows = data.data?.orders || data.data
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    const contractType = this.credentials.contractType
    const apiType = this.credentials.apiType || "perpetual_futures"
    
    // Determine effective contract type
    let effectiveContractType = contractType || "usdt-perpetual"
    if (!contractType && apiType === "spot") {
      effectiveContractType = "spot"
    }
    
    if (effectiveContractType === "spot" || apiType === "spot") {
      this.log("Positions not available for spot trading")
      return []
    }

    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""} (${effectiveContractType})`)

      const params: Record<string, any> = {
        timestamp: Date.now(),
      }

      if (symbol) {
        params.symbol = this.toBingXSymbol(symbol)
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      
      // Use different endpoint based on contract type
      let endpoint = "/openApi/swap/v3/user/positions" // USDT Perpetual
      if (effectiveContractType === "coin-perpetual") {
        endpoint = "/openApi/cswap/v1/user/positions" // Coin-M Perpetual
      }
      
      const url = `${this.getBaseUrl()}${endpoint}?${queryString}`
      this.log(`Using endpoint: ${endpoint}`)

      const response = await this.rateLimitedFetch(url, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return []
      }

      return Array.isArray(data.data) ? data.data : []
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

      const params: Record<string, any> = {
        symbol: this.toBingXSymbol(symbol),
        timestamp: Date.now(),
      }

      if (leverage) {
        params.leverage = String(leverage)
      }

      if (marginType) {
        params.marginType = marginType === "cross" ? "CROSSED" : "ISOLATED"
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(this.toStringParams(params)).toString()}&signature=${signature}`
      // Perp: /openApi/swap/v2/trade/positionSide/dual — v3 path does not exist.
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/positionSide/dual?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
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

      // Place opposite order to close
      const side = position.side === "LONG" ? "sell" : "buy"
      const result = await this.placeOrder(symbol, side as "buy" | "sell", position.contracts, position.currentPrice, "market")

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

      const params: Record<string, string> = {
        coin,
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/query_address?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
      }

      const address = data.data?.address
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

      const params: Record<string, string> = {
        coin,
        address,
        amount: String(amount),
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/withdraw?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
      }

      const txId = data.data?.txId
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

      const params: Record<string, string> = {
        limit: String(limit),
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/query_withdraw_list?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return []
      }

      return Array.isArray(data.data) ? data.data : []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch transfer history: ${errorMsg}`)
      return []
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    try {
      const bingxSymbol = this.toBingXSymbol(symbol)
      this.log(`Setting leverage to ${leverage}x for ${bingxSymbol}`)

      // BingX perpetual requires a `side` param on leverage changes; LONG is a
      // sensible default for initial position opening. If you need SHORT
      // leverage configured independently, call this again with the opposite.
      const params: Record<string, string> = {
        symbol: bingxSymbol,
        side: "LONG",
        leverage: String(leverage),
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      // Perp: /openApi/swap/v2/trade/leverage (not v3).
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/leverage?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
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
      const bingxSymbol = this.toBingXSymbol(symbol)
      this.log(`Setting margin type to ${marginType} for ${bingxSymbol}`)

      const params: Record<string, string> = {
        symbol: bingxSymbol,
        marginType: marginType === "cross" ? "CROSSED" : "ISOLATED",
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      // Perp: /openApi/swap/v2/trade/marginType (not v3).
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/marginType?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        // Margin-type-unchanged is not a real error on BingX; ignore code 101404.
        if (data.code === 101404 || /no need to change/i.test(String(data.msg || ""))) {
          this.log(`Margin type already ${marginType} — no change needed`)
          return { success: true }
        }
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
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

      const params: Record<string, string> = {
        dualSidePosition: String(hedgeMode),
        timestamp: String(Date.now()),
      }

      const signature = this.getSignature(params)
      const queryString = `${new URLSearchParams(params).toString()}&signature=${signature}`
      // Perp: /openApi/swap/v2/trade/positionSide/dual — v3 and /set do not exist.
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/positionSide/dual?${queryString}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        throw new Error(`BingX API error (code=${data.code}): ${data.msg || "Unknown error"}`)
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
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      // Transform symbol format for BingX
      let bingxSymbol = symbol
      if (apiType !== "spot") {
        // For perpetual/futures, ensure dash format: BTC-USDT
        if (!symbol.includes('-')) {
          bingxSymbol = symbol.replace('USDT', '-USDT').replace('USDC', '-USDC')
        }
      }
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = `/openApi/spot/v1/ticker/price?symbol=${bingxSymbol}`
      } else {
        endpoint = `/openApi/swap/v3/quote/price?symbol=${bingxSymbol}`
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}`, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (data.code !== 0 && data.code !== "0") {
        return null
      }

      const tickerData = data.data || {}
      const bid = Number.parseFloat(tickerData.bidPrice || tickerData.bid || "0")
      const ask = Number.parseFloat(tickerData.askPrice || tickerData.ask || "0")
      const last = Number.parseFloat(tickerData.lastPrice || tickerData.price || "0")

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
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      // Convert timeframe to BingX interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"

      // Transform symbol format for BingX
      // BingX perpetual futures requires format: BTC-USDT (with dash)
      // BingX spot requires format: BTCUSDT (no dash)
      let bingxSymbol = symbol
      if (apiType !== "spot") {
        // For perpetual/futures, ensure dash format: BTC-USDT
        if (!symbol.includes('-')) {
          // Convert BTCUSDT → BTC-USDT
          bingxSymbol = symbol.replace('USDT', '-USDT').replace('USDC', '-USDC')
        }
      }

      let endpoint = ""
      if (apiType === "spot") {
        endpoint = `/openApi/spot/v2/market/kline?symbol=${bingxSymbol}&interval=${interval}&limit=${limit}`
      } else {
        endpoint = `/openApi/swap/v3/quote/klines?symbol=${bingxSymbol}&interval=${interval}&limit=${limit}`
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}`, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      // Check for HTML response (API gateway error pages)
      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/html") || !response.ok) {
        // Silently return null - OHLCV data not critical, will retry next cycle
        return null
      }

      const data = await response.json()

      if (data.code !== 0 && data.code !== "0") {
        // Silently return null to avoid log flooding
        return null
      }

      // BingX returns different formats for spot vs swap
      const klines = Array.isArray(data.data) ? data.data : []
      
      const candles = klines.map((c: any) => ({
        timestamp: Number.parseInt(c.time || c[0]),
        open: Number.parseFloat(c.open || c[1]),
        high: Number.parseFloat(c.high || c[2]),
        low: Number.parseFloat(c.low || c[3]),
        close: Number.parseFloat(c.close || c[4]),
        volume: Number.parseFloat(c.volume || c[5])
      }))

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch {
      // Silently return null - OHLCV errors are expected when API returns HTML error pages
      // Will retry on next cycle
      return null
    }
  }
}
