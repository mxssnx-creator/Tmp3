import * as crypto from "crypto"
import {
  BaseExchangeConnector,
  type ExchangeConnectorResult,
  type PlaceOrderOptions,
} from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

/**
 * Bybit V5 Exchange Connector
 *
 * CRITICAL: Bybit V5 REST auth rules:
 *   - Auth travels in headers, NEVER in the query string:
 *       X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW,
 *       X-BAPI-SIGN-TYPE: 2 (HMAC-SHA256)
 *   - Signed payload differs by method:
 *       GET  → `${timestamp}${apiKey}${recvWindow}${sortedQueryString}`
 *       POST → `${timestamp}${apiKey}${recvWindow}${rawJsonBody}`
 *   - Querystring passed to a V5 endpoint must NOT include api_key, sign,
 *     recv_window, or timestamp. Those live only in headers.
 *
 * The previous implementation of every non-balance method used a legacy
 * V3-style `api_key=X&timestamp=Y&sign=Z` querystring which Bybit V5
 * rejects with `retCode 10003/10004` — that was the sole reason live
 * orders silently failed from this app.
 *
 * Supported API types (credentials.apiType):
 *   - "unified"           → UNIFIED account (V5 default for everything)
 *   - "perpetual_futures" → CONTRACT account (linear / inverse perps)
 *   - "spot"              → SPOT account
 *
 * Trading endpoint category is derived independently of accountType:
 *   - spot  → "spot"
 *   - *    → "linear" (USDT-M perpetual)
 *
 * Docs: https://bybit-exchange.github.io/docs/v5/intro
 */
export class BybitConnector extends BaseExchangeConnector {
  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"
  }

  /** Trading-endpoint category. Position / order endpoints expect this, NOT accountType. */
  private getTradingCategory(): "linear" | "spot" {
    return this.credentials.apiType === "spot" ? "spot" : "linear"
  }

  /**
   * Produce the V5 HMAC signature.
   * For GET pass `query` (sorted, URL-encoded, no leading '?'), for POST pass `body` (raw JSON).
   */
  private signV5(timestamp: string, recvWindow: string, payloadSuffix: string): string {
    const message = `${timestamp}${this.credentials.apiKey}${recvWindow}${payloadSuffix}`
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(message).digest("hex")
  }

  /**
   * Build a deterministic, V5-compliant querystring from a params bag.
   * Drops undefined / null / "" values. Keys are NOT sorted because Bybit
   * only requires the same string be used in both signing and URL (the
   * server re-parses and re-validates against the signed payload).
   */
  private toQueryString(query?: Record<string, any>): string {
    if (!query) return ""
    const parts: string[] = []
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
    return parts.join("&")
  }

  /** Single V5-authenticated request helper used by every private method below. */
  private async signedRequestV5<T = any>(opts: {
    method: "GET" | "POST"
    path: string
    query?: Record<string, any>
    body?: Record<string, any>
  }): Promise<{ ok: boolean; data: T; status: number }> {
    const { method, path, query, body } = opts
    const timestamp = Date.now().toString()
    const recvWindow = "5000"
    const baseUrl = this.getBaseUrl()

    const queryString = method === "GET" ? this.toQueryString(query) : ""
    const rawBody = method === "POST" && body ? JSON.stringify(body) : ""
    const payloadSuffix = method === "GET" ? queryString : rawBody
    const signature = this.signV5(timestamp, recvWindow, payloadSuffix)

    const url = queryString ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`
    const headers: Record<string, string> = {
      "X-BAPI-API-KEY": this.credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    }
    const init: RequestInit = { method, headers }
    if (method === "POST") {
      headers["Content-Type"] = "application/json"
      ;(init as any).body = rawBody
    }

    const response = await this.rateLimitedFetch(url, init)
    const data = (await safeParseResponse(response)) as T
    return { ok: response.ok, data, status: response.status }
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
      "reduce_only",
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
    const accountType = this.getEffectiveAccountType()
    const apiType = this.credentials.apiType || "perpetual_futures"
    this.log(`Configured API Type: ${apiType} → Bybit accountType: ${accountType}`)

    const { ok, data } = await this.signedRequestV5<any>({
      method: "GET",
      path: "/v5/account/wallet-balance",
      query: { accountType },
    })

    if (!ok || data?.retCode !== 0) {
      const msg = data?.retMsg || data?.error || `HTTP error`
      this.logError(`API Error: ${msg}`)
      throw new Error(msg)
    }

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
  }

  /**
   * Place an order on Bybit V5.
   *
   * Hedge / one-way handling:
   *   - One-way mode (default for most accounts): `positionIdx = 0`.
   *   - Hedge mode: `positionIdx = 1` for LONG, `2` for SHORT.
   * For reduce-only / SL / TP orders on hedge mode the caller MUST pass
   * options.positionSide matching the OPEN position so the closing order
   * targets the correct leg. Without it Bybit would either reject the
   * order (one-way, reduceOnly without position) or hedge against the
   * real position (hedge, wrong idx).
   *
   * On retCode 10001 ("position idx not match position mode") we retry
   * once with the opposite idx convention so accounts that switched mode
   * mid-session still get filled.
   */
  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      // ── Quantity validation ───────────────────────────────────────────
      if (!Number.isFinite(quantity) || quantity <= 0) {
        const msg = `Invalid quantity: ${quantity}`
        this.logError(`✗ ${msg}`)
        return { success: false, error: msg }
      }
      const roundedQty = Math.round(quantity * 1e8) / 1e8
      const qtyStr = roundedQty.toFixed(8).replace(/\.?0+$/, "")
      if (roundedQty < 1e-8) {
        const msg = `Quantity too small after rounding: ${quantity}`
        this.logError(`✗ ${msg}`)
        return { success: false, error: msg }
      }

      const category = this.getTradingCategory()
      const hedgeMode = options.hedgeMode === true
      const explicitSide = options.positionSide
      // When no explicit positionSide is given, infer from the order:
      //   • opening order (buy=LONG / sell=SHORT)
      //   • reduce-only close order (buy=close SHORT / sell=close LONG)
      const effectivePositionSide: "LONG" | "SHORT" = explicitSide
        ? explicitSide
        : options.reduceOnly
          ? side === "sell" ? "LONG" : "SHORT"
          : side === "buy" ? "LONG" : "SHORT"

      const body: Record<string, any> = {
        category,
        symbol,
        side: side === "buy" ? "Buy" : "Sell",
        orderType: orderType === "market" ? "Market" : "Limit",
        qty: qtyStr,
        timeInForce: orderType === "market" ? "IOC" : "GTC",
      }
      if (price && orderType === "limit") {
        const priceRounded = Math.round(price * 1e8) / 1e8
        body.price = priceRounded.toFixed(8).replace(/\.?0+$/, "")
      }
      if (options.clientOrderId) {
        body.orderLinkId = options.clientOrderId
      }
      if (category === "linear") {
        // positionIdx is only valid for derivatives.
        body.positionIdx = hedgeMode ? (effectivePositionSide === "LONG" ? 1 : 2) : 0
        if (options.reduceOnly) {
          body.reduceOnly = true
        }
      }

      this.log(
        `Placing ${orderType} ${side} order: ${qtyStr} ${symbol}` +
          `${options.reduceOnly ? " [reduceOnly]" : ""}` +
          ` idx=${body.positionIdx ?? "-"} cat=${category}`,
      )

      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/order/create",
        body,
      })

      if (data?.retCode !== 0) {
        // 10001 = "position idx not match position mode"
        // On that single retCode we flip one-way↔hedge once and retry so a
        // mode change that happened after connector boot still works.
        if (String(data?.retCode) === "10001" && category === "linear") {
          this.log("Retrying with flipped position mode (idx mismatch)")
          body.positionIdx = body.positionIdx === 0 ? (effectivePositionSide === "LONG" ? 1 : 2) : 0
          const retry = await this.signedRequestV5<any>({ method: "POST", path: "/v5/order/create", body })
          if (retry.data?.retCode === 0) {
            const retryId = retry.data.result?.orderId
            this.log(`✓ Order placed on retry: ${retryId}`)
            return { success: true, orderId: retryId }
          }
          throw new Error(`Bybit API error: ${retry.data?.retMsg || "Unknown error"}`)
        }
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
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
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/order/cancel",
        body: { category: this.getTradingCategory(), symbol, orderId },
      })
      if (data?.retCode !== 0) {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
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
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/realtime",
        query: { category: this.getTradingCategory(), symbol, orderId },
      })
      if (data?.retCode !== 0) return null
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
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/realtime",
        query: {
          category: this.getTradingCategory(),
          openOnly: 1,
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
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
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/history",
        query: {
          category: this.getTradingCategory(),
          limit,
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    // Positions live under category=linear/inverse. Spot has no positions.
    if (this.credentials.apiType === "spot") {
      this.log("Positions not available for spot trading")
      return []
    }
    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/position/list",
        query: {
          category: "linear",
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch positions: ${errorMsg}`)
      return []
    }
  }

  async getPosition(symbol: string): Promise<any> {
    const positions = await this.getPositions(symbol)
    // Pick the first position with non-zero size — in hedge mode both LONG
    // and SHORT legs are returned and only one (or neither) will be filled.
    return positions.find((p: any) => Number.parseFloat(p.size || "0") > 0) || positions[0] || null
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const tasks: Array<Promise<{ success: boolean; error?: string }>> = []
      if (typeof leverage === "number") tasks.push(this.setLeverage(symbol, leverage))
      if (marginType) tasks.push(this.setMarginType(symbol, marginType))
      if (tasks.length === 0) return { success: true }
      const results = await Promise.all(tasks)
      const failed = results.find((r) => !r.success)
      if (failed) return failed
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

      // Resolve the actual open position so we carry the right side + size.
      const positions = await this.getPositions(symbol)
      // Pick the leg the caller asked for when in hedge mode, else the
      // single non-zero position.
      const leg = positionSide
        ? positions.find(
            (p: any) =>
              String(p.side || "").toLowerCase() === positionSide &&
              Number.parseFloat(p.size || "0") > 0,
          )
        : positions.find((p: any) => Number.parseFloat(p.size || "0") > 0)

      if (!leg) {
        return { success: false, error: "No open position to close" }
      }

      const openSide = String(leg.side || "Buy") // Buy = LONG, Sell = SHORT
      const posDirection: "long" | "short" = openSide === "Buy" ? "long" : "short"
      const closeSide: "buy" | "sell" = openSide === "Buy" ? "sell" : "buy"
      const qty = Number.parseFloat(leg.size || "0")
      if (!qty || qty <= 0) {
        return { success: false, error: "Position size is zero — nothing to close" }
      }

      // Detect hedge mode from positionIdx: 0 = one-way, 1/2 = hedge legs.
      const hedgeMode = leg.positionIdx === 1 || leg.positionIdx === 2

      const result = await this.placeOrder(
        symbol,
        closeSide,
        qty,
        undefined,
        "market",
        {
          reduceOnly: true,
          hedgeMode,
          positionSide: posDirection === "long" ? "LONG" : "SHORT",
        },
      )

      if (!result.success) return result
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
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/asset/deposit/query-address",
        query: { coin },
      })
      if (data?.retCode !== 0) {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
      }
      const address = data.result?.chains?.[0]?.addressDeposit || data.result?.address
      this.log(`✓ Deposit address retrieved`)
      return { address }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch deposit address: ${errorMsg}`)
      return { error: errorMsg }
    }
  }

  async withdraw(
    coin: string,
    address: string,
    amount: number,
  ): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      this.log(`Withdrawing ${amount} ${coin}`)
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/asset/withdraw/create",
        body: {
          coin,
          address,
          amount: String(amount),
          // chain must be configurable per-coin, but sensible USDT default.
          chain: coin === "USDT" ? "TRX" : coin,
          timestamp: Date.now(),
        },
      })
      if (data?.retCode !== 0) {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
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
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/asset/transfer/query-inter-transfer-list",
        query: { limit },
      })
      if (data?.retCode !== 0) return []
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
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/position/set-leverage",
        body: {
          category: "linear",
          symbol,
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        },
      })
      // retCode 110043 = "leverage not modified" (same leverage already set).
      // Treat that as success so the engine doesn't bail on a harmless no-op.
      if (data?.retCode !== 0 && String(data?.retCode) !== "110043") {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
      }
      this.log(`✓ Leverage set to ${leverage}x`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set leverage: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setMarginType(
    symbol: string,
    marginType: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting margin type to ${marginType} for ${symbol}`)
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/position/switch-isolated",
        body: {
          category: "linear",
          symbol,
          tradeMode: marginType === "cross" ? 0 : 1,
          buyLeverage: "10",
          sellLeverage: "10",
        },
      })
      // 110026 = "cross/isolated mode not changed" — already set.
      if (data?.retCode !== 0 && String(data?.retCode) !== "110026") {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
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
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/position/switch-mode",
        body: {
          category: "linear",
          coin: "USDT",
          mode: hedgeMode ? 3 : 0, // V5: 0 = one-way, 3 = hedge (BothSides)
        },
      })
      // 110025 = "position mode not modified"
      if (data?.retCode !== 0 && String(data?.retCode) !== "110025") {
        throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
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
    // Public endpoint — no signature required.
    try {
      const baseUrl = this.getBaseUrl()
      const category = this.getTradingCategory()
      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`,
      )
      const data = await response.json()
      if (data.retCode !== 0 || !data.result?.list?.[0]) return null
      const ticker = data.result.list[0]
      const bid = Number.parseFloat(ticker.bid1Price || "0")
      const ask = Number.parseFloat(ticker.ask1Price || "0")
      const last = Number.parseFloat(ticker.lastPrice || "0")
      return { bid, ask, last }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch ticker: ${errorMsg}`)
      return null
    }
  }

  async getOHLCV(
    symbol: string,
    timeframe = "1m",
    limit = 250,
  ): Promise<
    Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null
  > {
    // Public endpoint — no signature required.
    try {
      const baseUrl = this.getBaseUrl()
      const category = this.getTradingCategory()
      const intervalMap: Record<string, string> = {
        "1m": "1",
        "3m": "3",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "2h": "120",
        "4h": "240",
        "6h": "360",
        "12h": "720",
        "1d": "D",
        "1w": "W",
        "1M": "M",
      }
      const interval = intervalMap[timeframe] || "1"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      )
      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/html") || !response.ok) return null

      const data = await response.json()
      if (data.retCode !== 0 || !data.result?.list) return null

      const candles = (data.result.list as string[][])
        .map((c) => ({
          timestamp: Number.parseInt(c[0]),
          open: Number.parseFloat(c[1]),
          high: Number.parseFloat(c[2]),
          low: Number.parseFloat(c[3]),
          close: Number.parseFloat(c[4]),
          volume: Number.parseFloat(c[5]),
        }))
        .reverse()

      return candles
    } catch {
      return null
    }
  }
}
