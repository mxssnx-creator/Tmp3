/**
 * Volume Calculator
 * Calculates position volume based on base volume factor, leverage, and risk management
 * Calculates position volume ONLY at Exchange level when actual orders are executed
 * This calculator is ONLY used by ExchangePositionManager
 * Base/Main/Real pseudo positions do NOT use volume - they use counts and ratios
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, setSettings, getRedisClient, getConnection } from "@/lib/redis-db"

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
   * Calculate position volume with risk management (pure math, no DB)
   * CRITICAL: If exchange minimum > calculated volume, REJECT position (don't force increase)
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

    let finalVolume: number
    let volumeAdjusted = false
    let adjustmentReason: string | undefined

    if (positionCost) {
      const positionSizeUsd = accountBalance * positionCost
      const calculatedVolume = positionSizeUsd / currentPrice
      finalVolume = calculatedVolume

      // CRITICAL: Check minimum volume constraint BEFORE accepting
      if (exchangeMinVolume > 0 && calculatedVolume < exchangeMinVolume) {
        // Position too small - REJECT instead of forcing
        return {
          volume: 0,
          volumeUsd: 0,
          leverage,
          volumeAdjusted: true,
          adjustmentReason: `Calculated volume ${calculatedVolume.toFixed(8)} is below exchange minimum ${exchangeMinVolume}. Position rejected.`,
        }
      }

      return {
        volume: finalVolume,
        volumeUsd: finalVolume * currentPrice,
        leverage,
        volumeAdjusted,
        adjustmentReason,
      }
    } else {
      if (!riskPercentage || !positionsAverage) {
        throw new Error("riskPercentage and positionsAverage are required when positionCost is not provided")
      }

      const calculatedLeverage = maxLeverage || leverage
      const totalRiskAmount = accountBalance * (riskPercentage / 100)
      const riskPerPosition = totalRiskAmount / positionsAverage
      const adjustedRisk = riskPerPosition * (baseVolumeFactor || 1)
      const positionSize = adjustedRisk / (riskPercentage / 100)
      finalVolume = positionSize / (currentPrice * calculatedLeverage)

      // CRITICAL: Check minimum volume constraint BEFORE accepting
      if (exchangeMinVolume > 0 && finalVolume < exchangeMinVolume) {
        // Position too small - REJECT instead of forcing
        return {
          calculatedVolume: finalVolume,
          finalVolume: 0,
          leverage: calculatedLeverage,
          positionSize,
          volumeAdjusted: true,
          adjustmentReason: `Calculated volume ${finalVolume.toFixed(8)} is below exchange minimum ${exchangeMinVolume}. Position rejected.`,
          riskAmount: adjustedRisk,
        }
      }

      return {
        calculatedVolume: finalVolume,
        finalVolume,
        leverage: calculatedLeverage,
        positionSize,
        volumeAdjusted,
        adjustmentReason,
        riskAmount: adjustedRisk,
      }
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

      // Get settings from Redis
      const settings = await getSettings("system_settings") || {}
      const positionCostPercent = parseFloat(
        String(settings.exchangePositionCost || settings.positionCost || "0.1")
      )
      const positionCost = positionCostPercent / 100

      const leveragePercentage = parseFloat(String(settings.leveragePercentage || "100"))
      const useMaxLeverage = settings.useMaximalLeverage === "true"
      const maxLeverage = useMaxLeverage ? 125 : Math.round(125 * (leveragePercentage / 100))

      // Get exchange min volume from Redis trading pair data
      const tradingPair = await getSettings(`trading_pair:${symbol}`)
      const exchangeMinVolume = tradingPair?.min_order_size ? parseFloat(tradingPair.min_order_size) : undefined

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
