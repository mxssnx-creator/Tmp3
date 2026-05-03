/**
 * Volume Calculator
 * Calculates position volume based on base volume factor, leverage, and risk management
 * Calculates position volume ONLY at Exchange level when actual orders are executed
 * This calculator is ONLY used by ExchangePositionManager
 * Base/Main/Real pseudo positions do NOT use volume - they use counts and ratios
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, getAppSettings, setSettings, getRedisClient, getConnection } from "@/lib/redis-db"

interface VolumeCalculationParams {
  baseVolumeFactor?: number
  positionsAverage?: number
  riskPercentage?: number
  maxLeverage?: number
  positionCost?: number
  accountBalance: number
  currentPrice: number
  leverage?: number
  exchangeMinVolume?: number
}

interface VolumeCalculationResult {
  calculatedVolume?: number
  finalVolume?: number
  leverage: number
  positionSize?: number
  volume?: number
  volumeUsd?: number
  volumeAdjusted: boolean
  adjustmentReason?: string
  riskAmount?: number
}

export class VolumeCalculator {
  /**
   * Universal hard floor: the smallest USD notional we will ever attempt to
   * place on an exchange when no specific minimum is known. $5 covers the
   * documented minimums of every major venue (Binance, BingX, Bybit, OKX,
   * Bitget). Applied AFTER any per-pair `exchangeMinVolume` so a known
   * larger minimum (e.g. some altcoin pairs require $10) still wins.
   */
  private static readonly UNIVERSAL_MIN_NOTIONAL_USD = 5

  /**
   * Calculate position volume with risk management (pure math, no DB).
   *
   * BEHAVIOR: minimum volume is ALWAYS enforced — never reject for "qty
   * too small". Three layers:
   *   1. Per-pair `exchangeMinVolume` (from trading_pair metadata)
   *   2. Universal $5-notional floor when no per-pair min is known
   *   3. Numeric safety: if math yields 0/NaN/Infinity (e.g. balance=0
   *      or currentPrice rounding), still emit at least layer 1 or 2.
   *
   * The result is flagged `volumeAdjusted: true` with an
   * `adjustmentReason` explaining the clamp so UI + logs show the user
   * exactly why the quantity doesn't match the pure math.
   */
  static calculatePositionVolume(params: VolumeCalculationParams): VolumeCalculationResult {
    const {
      baseVolumeFactor,
      positionsAverage,
      riskPercentage,
      maxLeverage,
      positionCost,
      accountBalance,
      currentPrice,
      leverage = 1,
      exchangeMinVolume = 0,
    } = params

    // ── Resolve the effective minimum that MUST be honored ──────────
    // Take the larger of the per-pair minimum and the universal $5
    // notional floor. Guarantees we always have a positive lower bound
    // as long as `currentPrice > 0` (the upstream caller is responsible
    // for rejecting price=0 before we get here).
    const universalMinFromNotional =
      currentPrice > 0
        ? VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD / currentPrice
        : 0
    const effectiveMin = Math.max(exchangeMinVolume || 0, universalMinFromNotional)

    /**
     * Final clamp: never return less than `effectiveMin`, never NaN,
     * never Infinity. Used by both the positionCost and the
     * risk-percentage branches below.
     */
    const clampUp = (raw: number): { final: number; adjusted: boolean; reason?: string } => {
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (effectiveMin > 0 && safeRaw < effectiveMin) {
        const usingUniversalFallback = exchangeMinVolume <= 0
        return {
          final: effectiveMin,
          adjusted: true,
          reason:
            safeRaw <= 0
              ? `Sizing math yielded ${raw} — clamped up to enforced minimum ${effectiveMin.toFixed(8)} (${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"}).`
              : `Calculated volume ${safeRaw.toFixed(8)} was below ${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"} ${effectiveMin.toFixed(8)} — clamped up to minimum order size.`,
        }
      }
      return { final: safeRaw, adjusted: false }
    }

    if (positionCost) {
      // ── positions_average is now wired into the positionCost path ────
      // Previously this branch ignored `positionsAverage`, so the
      // operator's "Positions Average" setting only affected the
      // (rarely-used) risk-percentage branch below. The real engine
      // calls this branch on every live order, which meant raising the
      // default 50 → 300 had no effect on per-position sizing.
      //
      // New formula:   pos_usd = (balance × positionCost) / posAvg
      // With positionCost expressed as a fraction of balance (the same
      // way the calling site already converts it: `pct/100`), the
      // denominator divides total budgeted exposure across the expected
      // concurrent position count. Falling back to 1 keeps legacy
      // behaviour identical when the operator hasn't set a value.
      const posAvg = positionsAverage && positionsAverage > 0 ? positionsAverage : 1
      const positionSizeUsd = (accountBalance * positionCost) / posAvg
      const calculatedVolume = positionSizeUsd / currentPrice
      const { final, adjusted, reason } = clampUp(calculatedVolume)

      return {
        calculatedVolume,
        finalVolume: final,
        volume: final,
        volumeUsd: final * currentPrice,
        leverage,
        volumeAdjusted: adjusted,
        adjustmentReason: reason,
      }
    }

    if (!riskPercentage || !positionsAverage) {
      throw new Error("riskPercentage and positionsAverage are required when positionCost is not provided")
    }

    const calculatedLeverage = maxLeverage || leverage
    const totalRiskAmount = accountBalance * (riskPercentage / 100)
    const riskPerPosition = totalRiskAmount / positionsAverage
    const adjustedRisk = riskPerPosition * (baseVolumeFactor || 1)
    const positionSize = adjustedRisk / (riskPercentage / 100)
    const rawVolume = positionSize / (currentPrice * calculatedLeverage)

    const { final, adjusted, reason } = clampUp(rawVolume)

    return {
      calculatedVolume: rawVolume,
      finalVolume: final,
      volume: final,
      volumeUsd: final * currentPrice,
      leverage: calculatedLeverage,
      positionSize,
      volumeAdjusted: adjusted,
      adjustmentReason: reason,
      riskAmount: adjustedRisk,
    }
  }

  /**
   * Calculate volume for a specific connection and symbol using Redis settings
   */
  static async calculateVolumeForConnection(
    connectionId: string,
    symbol: string,
    currentPrice: number,
  ): Promise<VolumeCalculationResult> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get settings from Redis via the mirror-aware reader. The volume
      // calculator needs `exchangePositionCost`/`positionCost`,
      // `leveragePercentage`, and `useMaximalLeverage` — all of which are
      // managed from the main Settings UI (canonical `app_settings`).
      // Previously this read `system_settings`, which is a different
      // bundle (cleanup schedule, backup toggles) — so the operator's
      // saved leverage/cost never reached volume calculations.
      const settings = (await getAppSettings()) || {}
      const positionCostPercent = parseFloat(
        String(settings.exchangePositionCost ?? settings.positionCost ?? "0.1")
      )
      const positionCost = positionCostPercent / 100

      // Read `positions_average` so the positionCost path divides the
      // global budget across the expected concurrent-position count.
      // Default 300 mirrors components/settings/utils.ts; the prior
      // default (50) is still honoured for users who explicitly chose
      // that value because we read whatever's in app_settings as-is.
      const positionsAverage = (() => {
        const raw = parseFloat(String(settings.positions_average ?? "300"))
        return Number.isFinite(raw) && raw > 0 ? raw : 300
      })()

      const leveragePercentage = parseFloat(String(settings.leveragePercentage ?? "100"))
      // `parseHash` coerces the stored "true"/"1" to boolean true, so a
      // strict `=== true` check is now safe (the old
      // `=== "true"` string compare would always miss).
      const useMaxLeverage = settings.useMaximalLeverage === true || settings.useMaximalLeverage === "true"
      const maxLeverage = useMaxLeverage ? 125 : Math.round(125 * (leveragePercentage / 100))

      // Get exchange min volume from Redis trading pair data. When the
      // metadata is missing or zero we leave `exchangeMinVolume`
      // undefined — `calculatePositionVolume` will then apply the
      // universal $5-notional floor itself, which works for ANY quote
      // currency (USDT, USDC, USD, BTC, BUSD, ...) without per-quote
      // string sniffing.
      const tradingPair = await getSettings(`trading_pair:${symbol}`)
      const exchangeMinVolume = tradingPair?.min_order_size
        ? parseFloat(tradingPair.min_order_size)
        : undefined

      let accountBalance = 10000 // Default fallback

      try {
        // Try to get cached balance from Redis
        const cachedBalance = await getSettings(`connection_balance:${connectionId}`)
        if (cachedBalance?.balance) {
          accountBalance = parseFloat(String(cachedBalance.balance))
        } else {
          // Try to fetch from exchange via connector
          const connection = await getConnection(connectionId)
          if (connection?.api_key && connection?.api_secret
            && !connection.api_key.includes("PLACEHOLDER")
            && connection.api_key.length >= 20) {
            const { createExchangeConnector } = await import("@/lib/exchange-connectors")
            const connector = await createExchangeConnector(connection.exchange, {
              apiKey: connection.api_key,
              apiSecret: connection.api_secret,
              apiType: connection.api_type,
              contractType: connection.contract_type,
              isTestnet: connection.is_testnet === true || connection.is_testnet === "true",
            })

            const balanceResult = await connector.getBalance()
            if (balanceResult?.balance) {
              accountBalance = balanceResult.balance
              // Cache the balance in Redis
              await setSettings(`connection_balance:${connectionId}`, {
                balance: accountBalance,
                updated_at: new Date().toISOString(),
              })
            }
          }
        }
      } catch (balanceError) {
        console.warn("[v0] Failed to fetch account balance, using default:", balanceError)
      }

      const result = this.calculatePositionVolume({
        positionCost,
        positionsAverage,
        accountBalance,
        currentPrice,
        leverage: maxLeverage,
        exchangeMinVolume,
      })

      return result
    } catch (error) {
      console.error("[v0] Failed to calculate volume for connection:", error)
      throw error
    }
  }

  /**
   * Log volume calculation to Redis
   */
  static async logVolumeCalculation(
    connectionId: string,
    symbol: string,
    calculation: VolumeCalculationResult,
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const logKey = `volume_calc:${connectionId}:${logId}`

      await client.set(logKey, JSON.stringify({
        connection_id: connectionId,
        symbol,
        leverage: calculation.leverage,
        calculated_volume: calculation.calculatedVolume,
        final_volume: calculation.finalVolume || calculation.volume,
        volume_usd: calculation.volumeUsd,
        volume_adjusted: calculation.volumeAdjusted,
        adjustment_reason: calculation.adjustmentReason || null,
        created_at: new Date().toISOString(),
      }))

      // Store in Redis list instead of sorted set (Upstash doesn't support zadd)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      let volumeCalcs: string[] = []
      
      const existing = await client.get(volumeCalcsKey)
      if (existing) {
        try { volumeCalcs = JSON.parse(existing) } catch { volumeCalcs = [] }
      }
      
      // Prepend new entry
      volumeCalcs.unshift(logId)
      
      // Trim to max 500 entries
      if (volumeCalcs.length > 500) {
        volumeCalcs = volumeCalcs.slice(0, 500)
      }
      
      await client.set(volumeCalcsKey, JSON.stringify(volumeCalcs))
    } catch (error) {
      console.error("[v0] Failed to log volume calculation:", error)
    }
  }

  /**
   * Get volume calculation history from Redis
   */
  static async getVolumeHistory(connectionId: string, _symbol?: string, limit = 100) {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get recent log IDs from list (prepended order, so slice from beginning)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      const existing = await client.get(volumeCalcsKey)
      
      let logIds: string[] = []
      if (existing) {
        try { logIds = JSON.parse(existing) } catch { logIds = [] }
      }
      
      if (!logIds || logIds.length === 0) return []

      // Take most recent entries (first in list)
      const recentIds = logIds.slice(0, Math.min(limit, logIds.length))
      
      const history = []
      for (const logId of recentIds) {
        const data = await client.get(`volume_calc:${connectionId}:${logId}`)
        if (data) {
          const parsed = typeof data === "string" ? JSON.parse(data) : data
          if (!_symbol || parsed.symbol === _symbol) {
            history.push(parsed)
          }
        }
      }

      return history.slice(0, limit)
    } catch (error) {
      console.error("[v0] Failed to get volume history:", error)
      return []
    }
  }

  /**
   * Calculate risk metrics for a position (pure math, no DB)
   */
  static calculateRiskMetrics(params: {
    entryPrice: number
    currentPrice: number
    volume: number
    leverage: number
    side: "long" | "short"
    stopLossPrice?: number
    takeProfitPrice?: number
  }) {
    const { entryPrice, currentPrice, volume, leverage, side, stopLossPrice, takeProfitPrice } = params

    const positionValue = volume * currentPrice

    let unrealizedPnL = 0
    if (side === "long") {
      unrealizedPnL = (currentPrice - entryPrice) * volume * leverage
    } else {
      unrealizedPnL = (entryPrice - currentPrice) * volume * leverage
    }

    const unrealizedPnLPercent = (unrealizedPnL / (entryPrice * volume)) * 100

    let potentialLoss = 0
    if (stopLossPrice) {
      if (side === "long") {
        potentialLoss = (stopLossPrice - entryPrice) * volume * leverage
      } else {
        potentialLoss = (entryPrice - stopLossPrice) * volume * leverage
      }
    }

    let potentialProfit = 0
    if (takeProfitPrice) {
      if (side === "long") {
        potentialProfit = (takeProfitPrice - entryPrice) * volume * leverage
      } else {
        potentialProfit = (entryPrice - takeProfitPrice) * volume * leverage
      }
    }

    let riskRewardRatio = 0
    if (potentialLoss !== 0) {
      riskRewardRatio = Math.abs(potentialProfit / potentialLoss)
    }

    return {
      positionValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      potentialLoss,
      potentialProfit,
      riskRewardRatio,
    }
  }
}
