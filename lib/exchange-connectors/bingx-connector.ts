// Plain `crypto` — Edge build is satisfied by the `crypto: false` alias
// in `next.config.mjs` (the runtime guard in `instrumentation.ts` makes
// sure the stub is never executed at request time).
import * as crypto from "crypto"
import {
  BaseExchangeConnector,
  type ExchangeCredentials,
  type ExchangeConnectorResult,
  type ExchangeOrder,
  type PlaceOrderOptions,
} from "./base-connector"
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
  constructor(credentials: ExchangeCredentials, exchange: string = "bingx") {
    super(credentials, exchange)
  }

  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://testnet-open-api.bingx.com" : "https://open-api.bingx.com"
  }

  private getSignature(params: Record<string, any>): string {
    // Kept only for the one remaining helper that doesn't need the query
    // string back (balance query). Prefer signParams() for everything else.
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map((key) => `${key}=${params[key]}`).join("&")
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
  }

  /**
   * CRITICAL: BingX rejects every signed request unless the signature is
   * computed over the EXACT query string that is transmitted. The previous
   * implementation used `getSignature(params)` (sorted alphabetically) to
   * produce the signature, then built the URL with
   * `new URLSearchParams(params).toString()` (insertion order) — two
   * different strings, which is why every `placeOrder`, `cancelOrder`,
   * `setLeverage`, `setMarginType` and `setPositionMode` call came back with
   * `code=100001: Signature verification failed` in the server logs.
   *
   * `signParams` returns the canonical (alphabetically-sorted) query string
   * along with its signature so callers can use both for the URL and have
   * them guaranteed to match. Values are stringified identically in both
   * the signed payload and the URL, so no URL-encoding skew is possible.
   *
   * Characters relevant to our trading payloads (`-`, alphanumerics, digits,
   * `.`) are all URL-unreserved per RFC 3986, so we can safely concatenate
   * without `encodeURIComponent`. Keeping the signed and transmitted strings
   * byte-identical is the important invariant.
   */
  private signParams(params: Record<string, any>): { signature: string; queryString: string } {
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map((key) => `${key}=${params[key]}`).join("&")
    const signature = crypto
      .createHmac("sha256", this.credentials.apiSecret)
      .update(queryString)
      .digest("hex")
    return { signature, queryString }
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
    // Remove existing slash format (normalize to no-slash first)
    let normalized = symbol.replace(/\//g, "")
    // Already hyphenated → nothing to do.
    if (normalized.includes("-")) return normalized
    // Spot still uses the plain BTCUSDT format on BingX.
    if (this.credentials.apiType === "spot") return normalized

    const upper = normalized.toUpperCase()
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
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
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

      // ── Position-side & reduce-only handling ─────────────────────────────
      // BingX perp accepts positionSide = LONG | SHORT only when the account
      // is in **hedge mode**. In one-way mode the same parameter will be
      // rejected and the whole order fails. Resolution order:
      //   1. Caller passed an explicit options.positionSide — trust it (only
      //      valid when the caller also indicates hedge mode, else we drop it).
      //   2. Caller told us hedgeMode=false — emit no positionSide (one-way).
      //   3. Fallback (legacy behaviour) — derive from order side, which is
      //      only correct for OPENING orders. For reduce-only orders this
      //      would silently open a new opposite-side position, which is why
      //      callers should always pass options.positionSide for SL/TP/close.
      const hedgeMode = options.hedgeMode !== false
      const explicitPositionSide = options.positionSide
      const derivedPositionSide: "LONG" | "SHORT" = side === "buy" ? "LONG" : "SHORT"
      const effectivePositionSide = explicitPositionSide
        || (options.reduceOnly
          // Reduce-only + no explicit side → infer the position side from the
          // close side (a SELL-to-close is closing a LONG, a BUY-to-close is
          // closing a SHORT).
          ? (side === "sell" ? "LONG" : "SHORT")
          : derivedPositionSide)

      this.log(
        `Placing ${orderType} ${side} order: ${qtyStr} ${bingxSymbol} (raw=${symbol})` +
        `${options.reduceOnly ? " [reduceOnly]" : ""}` +
        `${hedgeMode ? ` posSide=${effectivePositionSide}` : " [one-way]"}`
      )

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

      if (!isSpot) {
        if (hedgeMode) {
          params.positionSide = effectivePositionSide
        }
        // reduceOnly is only meaningful on perp endpoints.
        if (options.reduceOnly) {
          params.reduceOnly = "true"
        }
        if (options.clientOrderId) {
          params.clientOrderId = options.clientOrderId
        }
      }

      if (price && orderType === "limit") {
        // Same precision treatment for price.
        const priceRounded = Math.round(price * 1e8) / 1e8
        params.price = priceRounded.toFixed(8).replace(/\.?0+$/, "")
      }

      // Sign and build URL from the SAME sorted query string so BingX's
      // signature check succeeds (see `signParams` comment for context).
      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`

      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        // Special-case: 80014 "position side does not match" — the account is
        // in one-way mode but we sent a hedge-mode positionSide. Retry once
        // without positionSide so the order still goes through rather than
        // being silently dropped.
        const sideMismatch = String(data.code) === "80014"
          || /position.*side/i.test(String(data.msg || ""))
        if (sideMismatch && !isSpot && hedgeMode) {
          this.log("Retrying order without positionSide (detected one-way account)")
          delete params.positionSide
          params.timestamp = Date.now()
          const { signature: retrySig, queryString: retryQs } = this.signParams(params)
          const retryUrl = `${this.getBaseUrl()}${endpoint}?${retryQs}&signature=${retrySig}`
          const retryResp = await this.rateLimitedFetch(retryUrl, {
            method: "POST",
            headers: { "X-BX-APIKEY": this.credentials.apiKey },
          })
          const retryData = await retryResp.json()
          if (this.isBingXSuccess(retryData.code)) {
            const info = retryData.data?.order || retryData.data || {}
            const id = info.orderId || info.id || retryData.data?.orderId
            this.log(`✓ Order placed on retry (one-way): ${id}`)
            return { success: true, orderId: id ? String(id) : undefined }
          }
          throw new Error(`BingX API error (code=${retryData.code}): ${retryData.msg || "Unknown error"}`)
        }
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

  /**
   * BingX-native conditional order: places `STOP_MARKET` / `TAKE_PROFIT_MARKET`
   * on the perpetual swap endpoint. Differs from a regular order in three ways:
   *
   *   • `type` is `STOP_MARKET` or `TAKE_PROFIT_MARKET` (not `LIMIT`/`MARKET`)
   *   • the trigger level travels in `stopPrice`, NOT `price`
   *   • on fire, the exchange emits a market reduce-only fill — so we don't
   *     need to set an explicit `price`. Tighter slippage profile too.
   *
   * BingX requires hyphenated symbols on the swap endpoint and accepts
   * `positionSide` only when the account is in hedge mode — both already
   * handled the same way as `placeOrder`. Spot accounts don't have a
   * conditional order family, so we fall back to the base implementation.
   */
  override async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const isSpot = this.credentials.apiType === "spot"
      if (isSpot) {
        // Spot has no native stop-market — let the base fallback handle it.
        return super.placeStopOrder(symbol, closeSide, quantity, triggerPrice, kind, options)
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `Invalid quantity: ${quantity}` }
      }
      if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
        return { success: false, error: `Invalid trigger price: ${triggerPrice}` }
      }

      const roundedQty = Math.round(quantity * 1e6) / 1e6
      const qtyStr = roundedQty.toFixed(6).replace(/\.?0+$/, "")
      const stopRounded = Math.round(triggerPrice * 1e8) / 1e8
      const stopStr = stopRounded.toFixed(8).replace(/\.?0+$/, "")

      const bingxSymbol = this.toBingXSymbol(symbol)
      const hedgeMode = options.hedgeMode !== false
      // Closing a LONG ⇒ sell-side reduce-only against LONG position;
      // closing a SHORT ⇒ buy-side reduce-only against SHORT position.
      const positionSide: "LONG" | "SHORT" = options.positionSide
        ?? (closeSide === "sell" ? "LONG" : "SHORT")

      const orderType = kind === "stop_loss" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET"

      const params: Record<string, any> = {
        symbol: bingxSymbol,
        side: closeSide.toUpperCase(),
        type: orderType,
        quantity: qtyStr,
        stopPrice: stopStr,
        // workingType=MARK_PRICE prevents wick-driven false triggers
        // on thin tickers; matches BingX's own UI default for SL/TP.
        workingType: "MARK_PRICE",
        timestamp: Date.now(),
      }
      if (hedgeMode) params.positionSide = positionSide
      if (options.reduceOnly !== false) params.reduceOnly = "true"
      if (options.clientOrderId) params.clientOrderId = options.clientOrderId

      this.log(
        `Placing ${orderType} ${closeSide} ${qtyStr} ${bingxSymbol} @ stop=${stopStr}` +
          `${hedgeMode ? ` posSide=${positionSide}` : " [one-way]"} [reduceOnly]`,
      )

      const endpoint = "/openApi/swap/v2/trade/order"
      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`
      const response = await this.rateLimitedFetch(url, {
        method: "POST",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const data = await response.json()

      // Same one-way retry logic as `placeOrder`: BingX returns 80014 when
      // a hedge-mode positionSide is sent to a one-way account.
      if (!this.isBingXSuccess(data.code)) {
        const sideMismatch = String(data.code) === "80014"
          || /position.*side/i.test(String(data.msg || ""))
        if (sideMismatch && hedgeMode) {
          this.log("Retrying stop order without positionSide (one-way account)")
          delete params.positionSide
          params.timestamp = Date.now()
          const { signature: retrySig, queryString: retryQs } = this.signParams(params)
          const retryUrl = `${this.getBaseUrl()}${endpoint}?${retryQs}&signature=${retrySig}`
          const retryResp = await this.rateLimitedFetch(retryUrl, {
            method: "POST",
            headers: { "X-BX-APIKEY": this.credentials.apiKey },
          })
          const retryData = await retryResp.json()
          if (this.isBingXSuccess(retryData.code)) {
            const info = retryData.data?.order || retryData.data || {}
            const id = info.orderId || info.id || retryData.data?.orderId
            this.log(`✓ ${orderType} placed on retry: ${id}`)
            return { success: true, orderId: id ? String(id) : undefined }
          }
          throw new Error(`BingX stop order error (code=${retryData.code}): ${retryData.msg || "Unknown"}`)
        }
        throw new Error(`BingX stop order error (code=${data.code}): ${data.msg || "Unknown"}`)
      }

      const info = data.data?.order || data.data || {}
      const orderId = info.orderId || info.id || data.data?.orderId
      this.log(`✓ ${orderType} placed: ${orderId} @ ${stopStr}`)
      return { success: true, orderId: orderId ? String(orderId) : undefined }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place stop order: ${errorMsg}`)
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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`

      const response = await this.rateLimitedFetch(url, {
        method: "GET",
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!this.isBingXSuccess(data.code)) {
        return null
      }

      // Normalize the raw BingX order object to the ExchangeOrder interface
      // so callers can rely on `filledQty`, `filledPrice`, and normalised
      // `status` regardless of the underlying API version.
      const raw = data.data
      if (!raw) return null
      const rawStatus = String(raw.status ?? raw.orderStatus ?? "").toUpperCase()
      const normalizedStatus =
        rawStatus === "FILLED"          ? "filled" :
        rawStatus === "PARTIALLY_FILLED" ? "partially_filled" :
        rawStatus === "CANCELED"         ? "cancelled" :
        rawStatus === "CANCELLED"        ? "cancelled" :
        rawStatus === "REJECTED"         ? "cancelled" :
        rawStatus === "NEW"              ? "pending" :
        rawStatus === "PENDING"          ? "pending" : "pending"

      return {
        orderId:     String(raw.orderId   ?? raw.clientOrderId ?? ""),
        symbol:      String(raw.symbol    ?? ""),
        side:        String(raw.side      ?? "").toLowerCase() as "buy" | "sell",
        type:        "market",
        quantity:    parseFloat(String(raw.origQty   ?? raw.quantity    ?? "0")),
        price:       parseFloat(String(raw.price     ?? raw.avgPrice    ?? "0")),
        status:      normalizedStatus as ExchangeOrder["status"],
        filledQty:   parseFloat(String(raw.executedQty ?? raw.filledQty    ?? raw.cumQty ?? "0")),
        filledPrice: parseFloat(String(raw.avgPrice    ?? raw.filledPrice  ?? "0")),
        timestamp:   Number(raw.time       ?? raw.createTime ?? Date.now()),
        updateTime:  Number(raw.updateTime ?? raw.time       ?? Date.now()),
      }
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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)

      // Use different endpoint based on contract type
      let endpoint = "/openApi/swap/v3/user/positions" // USDT Perpetual
      if (effectiveContractType === "coin-perpetual") {
        endpoint = "/openApi/cswap/v1/user/positions" // Coin-M Perpetual
      }

      const url = `${this.getBaseUrl()}${endpoint}?${signedQs}&signature=${signature}`
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

      const { signature, queryString: signedQs } = this.signParams(params)
      // Perp: /openApi/swap/v2/trade/positionSide/dual — v3 path does not exist.
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/positionSide/dual?${signedQs}&signature=${signature}`

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

      // Determine the effective side of the *position* we are closing so the
      // reduce-only close order carries the correct `positionSide` on hedge
      // accounts. When the caller tells us explicitly, trust it; otherwise
      // infer from the exchange response.
      const posSideNormalised = (positionSide
        ? positionSide.toUpperCase()
        : String(position.side || position.positionSide || "LONG").toUpperCase()) as "LONG" | "SHORT"

      // Close side is the OPPOSITE of the position side:
      //   LONG position  → SELL to close
      //   SHORT position → BUY to close
      const closeSide = posSideNormalised === "LONG" ? "sell" : "buy"
      const qty = Number(position.contracts || position.positionAmt || position.quantity || 0)
      if (!qty || qty <= 0) {
        return { success: false, error: "Position size is zero or invalid — nothing to close" }
      }

      const result = await this.placeOrder(
        symbol,
        closeSide as "buy" | "sell",
        qty,
        undefined,
        "market",
        {
          reduceOnly: true,
          positionSide: posSideNormalised,
          hedgeMode: true,
        },
      )

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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/query_address?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/withdraw?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)
      const url = `${this.getBaseUrl()}/openApi/wallet/v1/query_withdraw_list?${signedQs}&signature=${signature}`

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
      this.log(`Setting leverage to ${leverage}x for ${bingxSymbol} on both sides`)

      // Previously this method always sent `side: "LONG"`, which meant any
      // SHORT position opened afterwards was stuck on the default leverage
      // (often 5x) regardless of what the engine requested — and in some
      // accounts caused the subsequent SHORT entry to be rejected for
      // leverage-mismatch. Fire both LONG and SHORT side updates in parallel
      // so hedge-mode accounts have matching leverage on both sides.
      const updateForSide = async (side: "LONG" | "SHORT") => {
        const params: Record<string, string> = {
          symbol: bingxSymbol,
          side,
          leverage: String(leverage),
          timestamp: String(Date.now()),
        }
        const { signature, queryString: signedQs } = this.signParams(params)
        const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/leverage?${signedQs}&signature=${signature}`
        const response = await this.rateLimitedFetch(url, {
          method: "POST",
          headers: { "X-BX-APIKEY": this.credentials.apiKey },
        })
        const data = await response.json()
        return { side, ok: this.isBingXSuccess(data.code), data }
      }

      const [longResult, shortResult] = await Promise.all([
        updateForSide("LONG").catch((err) => ({ side: "LONG", ok: false, data: { msg: String(err) } })),
        updateForSide("SHORT").catch((err) => ({ side: "SHORT", ok: false, data: { msg: String(err) } })),
      ])

      // Accept the call as successful if at least one side was configured.
      // On one-way-mode accounts BingX rejects the `side` param with code
      // 80012 / 80014; treat those as non-fatal — the engine still proceeds.
      const ok = longResult.ok || shortResult.ok ||
        String(longResult.data?.code) === "80014" ||
        String(shortResult.data?.code) === "80014"

      if (!ok) {
        const reason = longResult.data?.msg || shortResult.data?.msg || "Unknown error"
        throw new Error(`BingX leverage API error: ${reason}`)
      }

      this.log(`✓ Leverage set to ${leverage}x (long=${longResult.ok}, short=${shortResult.ok})`)
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

      const { signature, queryString: signedQs } = this.signParams(params)
      // Perp: /openApi/swap/v2/trade/marginType (not v3).
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/marginType?${signedQs}&signature=${signature}`

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

      const { signature, queryString: signedQs } = this.signParams(params)
      // Perp: /openApi/swap/v2/trade/positionSide/dual — v3 and /set do not exist.
      const url = `${this.getBaseUrl()}/openApi/swap/v2/trade/positionSide/dual?${signedQs}&signature=${signature}`

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

      // ── 1s timeframe (spec §7): aggregate trades ──────────────────
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

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

  /**
   * ── 1-second OHLCV (spec §7) ──────────────────────────────────────
   *
   * Aggregates from BingX trade history. Spot uses
   * `/openApi/spot/v1/market/trades`, swap uses
   * `/openApi/swap/v2/quote/trades`. Both cap at ~500 trades and
   * return newest-first. Coverage is best-effort.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const baseUrl = this.getBaseUrl()
      const apiType = this.credentials.apiType || "perpetual_futures"
      let bingxSymbol = symbol
      if (apiType !== "spot" && !symbol.includes("-")) {
        bingxSymbol = symbol.replace("USDT", "-USDT").replace("USDC", "-USDC")
      }
      const endpoint = apiType === "spot"
        ? `/openApi/spot/v1/market/trades?symbol=${bingxSymbol}&limit=500`
        : `/openApi/swap/v2/quote/trades?symbol=${bingxSymbol}&limit=500`
      const resp = await this.rateLimitedFetch(`${baseUrl}${endpoint}`, {
        headers: { "X-BX-APIKEY": this.credentials.apiKey },
      })
      if (!resp.ok) return null
      const data = await resp.json()
      const rows = Array.isArray(data?.data) ? data.data : []
      if (rows.length === 0) return []
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const trades = rows.map((r: any) => ({
        // BingX uses `time` (spot) or `T` (swap) as timestamp; price `price`/`p`; qty `qty`/`q`/`quoteQty`.
        timestamp: Number(r.time ?? r.T ?? r.timestamp),
        price: Number(r.price ?? r.p),
        quantity: Number(r.qty ?? r.q ?? r.quoteQty ?? 0),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }

  /**
   * ─────────────────────────────────────────────────────────────────
   * BINGX API SKILLS - Official implementation
   * Source: https://github.com/BingX-API/api-ai-skills
   * ─────────────────────────────────────────────────────────────────
   */

  /**
   * bingx-swap-market: Query perpetual futures market data
   * 
   * Returns market data for USDT-M perpetual futures including:
   * - Price information (bid, ask, last price)
   * - Depth (order book)
   * - Klines (candle data)
   * - Funding rate
   * - Open interest
   * 
   * @param symbol - Trading pair (e.g., "BTC-USDT", "ETH-USDT")
   * @returns Market data object
   */
  async getSwapMarketData(symbol: string): Promise<any> {
    try {
      this.log(`[bingx-swap-market] Fetching market data for ${symbol}`)
      
      const baseUrl = this.getBaseUrl()
      const bingxSymbol = this.toBingXSymbol(symbol)
      
      // Get current ticker data
      const tickerEndpoint = `/openApi/swap/v3/public/ticker?symbol=${bingxSymbol}`
      const tickerResponse = await this.rateLimitedFetch(`${baseUrl}${tickerEndpoint}`)
      
      if (!tickerResponse.ok) {
        throw new Error(`Failed to fetch ticker: HTTP ${tickerResponse.status}`)
      }
      
      const tickerData = await tickerResponse.json()
      
      if (!this.isBingXSuccess(tickerData.code)) {
        throw new Error(`API Error: ${tickerData.msg || 'Unknown error'}`)
      }
      
      const ticker = Array.isArray(tickerData.data) ? tickerData.data[0] : tickerData.data
      
      this.log(`✓ Market data fetched for ${symbol}: price=${ticker?.lastPrice}, 24h change=${ticker?.priceChangePercent}%`)
      
      return {
        success: true,
        symbol: bingxSymbol,
        lastPrice: Number.parseFloat(ticker?.lastPrice || "0"),
        bidPrice: Number.parseFloat(ticker?.bidPrice || "0"),
        askPrice: Number.parseFloat(ticker?.askPrice || "0"),
        high24h: Number.parseFloat(ticker?.high24h || "0"),
        low24h: Number.parseFloat(ticker?.low24h || "0"),
        volume24h: Number.parseFloat(ticker?.volume || "0"),
        quoteVolume24h: Number.parseFloat(ticker?.quoteVolume || "0"),
        priceChangePercent: Number.parseFloat(ticker?.priceChangePercent || "0"),
        fundingRate: Number.parseFloat(ticker?.fundingRate || "0"),
        openInterest: Number.parseFloat(ticker?.openInterest || "0"),
        timestamp: Date.now(),
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`[bingx-swap-market] Failed to fetch market data: ${errorMsg}`)
      return {
        success: false,
        error: errorMsg,
      }
    }
  }

  /**
   * bingx-swap-trade: Perpetual futures trading operations
   * 
   * Execute trading operations on USDT-M perpetual futures:
   * - Place orders (market, limit, stop-loss, take-profit)
   * - Cancel orders
   * - Set leverage
   * - Set margin mode (isolated/cross)
   * - Manage position mode (one-way/hedge)
   * 
   * @param operation - Type of trading operation
   * @param params - Operation-specific parameters
   * @returns Trade operation result
   */
  async executeSwapTrade(operation: string, params: Record<string, any>): Promise<any> {
    try {
      this.log(`[bingx-swap-trade] Executing ${operation} with params: ${JSON.stringify(params).substring(0, 200)}`)
      
      switch (operation) {
        case "placeOrder":
          return await this.placeOrder(
            params.symbol,
            params.side || "buy",
            params.quantity,
            params.price,
            params.type || "limit",
            params.options
          )
        
        case "cancelOrder":
          return await this.cancelOrder(params.symbol, params.orderId)
        
        case "setLeverage":
          return await this.setLeverage(params.symbol, params.leverage)
        
        case "setMarginType":
          return await this.setMarginType(params.symbol, params.marginType)
        
        case "setPositionMode":
          return await this.setPositionMode(params.hedgeMode)
        
        default:
          throw new Error(`Unknown operation: ${operation}`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`[bingx-swap-trade] Failed to execute ${operation}: ${errorMsg}`)
      return {
        success: false,
        error: errorMsg,
      }
    }
  }

  /**
   * bingx-swap-account: Query perpetual futures account information
   * 
   * Retrieve account data for USDT-M perpetual trading:
   * - Account balance
   * - Positions information
   * - Open orders
   * - Commission rates
   * - Fund flow history
   * 
   * @param dataType - Type of account data to retrieve ("balance", "positions", "orders", "all")
   * @returns Account information
   */
  async getSwapAccountInfo(dataType: string = "all"): Promise<any> {
    try {
      this.log(`[bingx-swap-account] Fetching account info: ${dataType}`)
      
      const result: any = {
        success: true,
        dataType,
        timestamp: Date.now(),
      }
      
      if (dataType === "balance" || dataType === "all") {
        const balance = await this.getBalance()
        if (balance.success) {
          result.balance = {
            total: balance.balance,
            btcPrice: balance.btcPrice,
            balances: balance.balances,
          }
          this.log(`✓ Balance: ${balance.balance.toFixed(4)} USDT`)
        } else {
          result.balanceError = balance.error
        }
      }
      
      if (dataType === "positions" || dataType === "all") {
        const positions = await this.getPositions()
        if (positions && Array.isArray(positions)) {
          result.positions = positions
          this.log(`✓ Positions: ${positions.length} open`)
        } else {
          result.positionsError = "Failed to fetch positions"
        }
      }
      
      if (dataType === "orders" || dataType === "all") {
        const orders = await this.getOpenOrders()
        if (orders && Array.isArray(orders)) {
          result.openOrders = orders
          this.log(`✓ Open Orders: ${orders.length}`)
        } else {
          result.ordersError = "Failed to fetch orders"
        }
      }
      
      return result
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`[bingx-swap-account] Failed to fetch account info: ${errorMsg}`)
      return {
        success: false,
        error: errorMsg,
      }
    }
  }
}
