/**
 * Config Set Processor
 * Processes prehistoric data through indication and strategy config managers
 * Each configuration combination calculates independently and stores results
 * 
 * Phase 5-6 Implementation: Fills config sets with calculated results
 */

import { IndicationConfigManager, IndicationResult, IndicationConfig } from "@/lib/indication-config-manager"
import { StrategyConfigManager, PseudoPosition, StrategyConfig } from "@/lib/strategy-config-manager"
import { getRedisClient, initRedis, getSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export interface ProcessingResult {
  indicationConfigs: number
  indicationResults: number
  strategyConfigs: number
  strategyPositions: number
  symbolsTotal: number
  symbolsProcessed: number
  symbolsWithoutData: number
  candlesProcessed: number
  errors: number
  duration: number
  // Interval-stepping metrics
  intervalsProcessed: number
  missingIntervalsLoaded: number
  timeframeSeconds: number
  rangeStartMs: number
  rangeEndMs: number
}

export class ConfigSetProcessor {
  private connectionId: string
  private indicationManager: IndicationConfigManager
  private strategyManager: StrategyConfigManager

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.indicationManager = new IndicationConfigManager(connectionId)
    this.strategyManager = new StrategyConfigManager(connectionId)
  }

  /**
   * Initialize default config sets if they don't exist
   * Creates baseline configurations for indications and strategies
   */
  async initializeConfigSets(): Promise<{ indications: number; strategies: number }> {
    console.log(`[v0] [ConfigSetProcessor] Initializing config sets for ${this.connectionId}`)

    const existingIndications = await this.indicationManager.getAllConfigs()
    const existingStrategies = await this.strategyManager.getAllConfigs()

    let newIndications = 0
    let newStrategies = 0

    if (existingIndications.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default indication configs...`)
      const indicationConfigs = await this.indicationManager.generateDefaultConfigs()
      newIndications = indicationConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newIndications} indication configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingIndications.length} existing indication configs`)
    }

    if (existingStrategies.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default strategy configs...`)
      const strategyConfigs = await this.strategyManager.generateDefaultConfigs()
      newStrategies = strategyConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newStrategies} strategy configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingStrategies.length} existing strategy configs`)
    }

    return {
      indications: existingIndications.length + newIndications,
      strategies: existingStrategies.length + newStrategies,
    }
  }

  /**
   * Process prehistoric data through all config sets.
   * Processes ONLY missing time intervals (skips already-loaded ranges).
   * Steps through the full time range one timeframe interval at a time.
   *
   * @param symbols       - Symbols to process
   * @param rangeStart    - Start of the historical range (default: now - 1 day)
   * @param rangeEnd      - End of the historical range (default: now)
   * @param timeframeSec  - Timeframe interval in seconds (default: 1 = 1-second bars)
   */
  async processPrehistoricData(
    symbols: string[],
    rangeStart?: Date,
    rangeEnd?: Date,
    timeframeSec: number = 1
  ): Promise<ProcessingResult> {
    const startTime = Date.now()
    const now = new Date()
    const effectiveEnd = rangeEnd ?? now
    const effectiveStart = rangeStart ?? new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const intervalMs = timeframeSec * 1000

    console.log(
      `[v0] [ConfigSetProcessor] Starting prehistoric processing for ${symbols.length} symbols | ` +
      `range=${effectiveStart.toISOString()} → ${effectiveEnd.toISOString()} | timeframe=${timeframeSec}s`
    )

    await initRedis()
    const client = getRedisClient()

    let totalIndicationResults = 0
    let totalStrategyPositions = 0
    let symbolsProcessed = 0
    let symbolsWithoutData = 0
    let candlesProcessed = 0
    let errors = 0
    let totalIntervalsProcessed = 0
    let missingIntervalsLoaded = 0

    const indicationConfigs = await this.indicationManager.getEnabledConfigs()
    const strategyConfigs = await this.strategyManager.getEnabledConfigs()

    console.log(
      `[v0] [ConfigSetProcessor] Processing with ${indicationConfigs.length} indication configs, ` +
      `${strategyConfigs.length} strategy configs`
    )

    // Store range metadata for dashboard
    try {
      await client.hset(`prehistoric:${this.connectionId}`, {
        range_start: effectiveStart.toISOString(),
        range_end: effectiveEnd.toISOString(),
        timeframe_seconds: String(timeframeSec),
        symbols_total: String(symbols.length),
        updated_at: new Date().toISOString(),
      })
    } catch { /* non-critical */ }

    for (const symbol of symbols) {
      try {
        // --- Load all available candles for this symbol ---
        let candles: any[] = []

        const candlesRaw = await client.get(`market_data:${symbol}:candles`)
        if (candlesRaw) {
          candles = JSON.parse(candlesRaw)
        }

        if (!candles || candles.length === 0) {
          const marketDataRaw = await client.get(`market_data:${symbol}:1m`)
          if (marketDataRaw) {
            const marketDataObj = JSON.parse(marketDataRaw)
            if (marketDataObj?.candles) {
              candles = marketDataObj.candles
            }
          }
        }

        if (candles.length === 0) {
          console.log(`[v0] [ConfigSetProcessor] No candles found for ${symbol}, skipping`)
          symbolsWithoutData++
          await logProgressionEvent(this.connectionId, "config_set_symbol_skipped", "warning", `No prehistoric candles for ${symbol}`, {
            symbol,
            stage: "prehistoric",
          })
          continue
        }

        // --- Determine which time intervals are already processed ---
        const processedKey = `prehistoric:${this.connectionId}:${symbol}:processed_intervals`
        let processedIntervals: Set<number> = new Set()
        try {
          const processedRaw = await client.get(processedKey)
          if (processedRaw) {
            const arr: number[] = JSON.parse(processedRaw)
            processedIntervals = new Set(arr)
          }
        } catch { /* non-critical */ }

        // --- Step through time range interval by interval, processing only missing ones ---
        let currentTs = effectiveStart.getTime()
        const endTs = effectiveEnd.getTime()

        const intervalCandles: any[] = []
        let symbolIntervalCount = 0
        let symbolMissingCount = 0

        while (currentTs < endTs) {
          const bucketTs = Math.floor(currentTs / intervalMs) * intervalMs
          totalIntervalsProcessed++
          symbolIntervalCount++

          if (!processedIntervals.has(bucketTs)) {
            // Find candles that fall within this interval bucket
            const bucketCandles = candles.filter((c: any) => {
              const cTs = typeof c.timestamp === "number" ? c.timestamp : new Date(c.timestamp || c.time).getTime()
              return cTs >= bucketTs && cTs < bucketTs + intervalMs
            })

            if (bucketCandles.length > 0) {
              intervalCandles.push(...bucketCandles)
              missingIntervalsLoaded++
              symbolMissingCount++
              processedIntervals.add(bucketTs)
            }
          }

          currentTs += intervalMs
        }

        // Persist the updated processed-intervals set for this symbol (TTL = 25h)
        try {
          await client.set(processedKey, JSON.stringify([...processedIntervals]), { EX: 90000 })
        } catch { /* non-critical */ }

        // Merge interval candles with full candle array for processing
        const combinedCandles = intervalCandles.length > 0 ? intervalCandles : candles
        candlesProcessed += combinedCandles.length
        symbolsProcessed++

        console.log(
          `[v0] [ConfigSetProcessor] ${symbol}: ${combinedCandles.length} candles | ` +
          `intervals=${symbolIntervalCount} | missing=${symbolMissingCount}`
        )

        // --- Write live progress to Redis hash ---
        try {
          const progressKey = `progression:${this.connectionId}`
          await client.hincrby(progressKey, "prehistoric_candles_processed", combinedCandles.length)
          await client.hincrby(progressKey, "prehistoric_symbols_processed_count", 1)
          await client.hset(progressKey, {
            prehistoric_current_symbol: symbol,
            prehistoric_intervals_processed: String(totalIntervalsProcessed),
            prehistoric_missing_loaded: String(missingIntervalsLoaded),
            prehistoric_timeframe_seconds: String(timeframeSec),
          })
          await client.expire(progressKey, 7 * 24 * 60 * 60)
        } catch { /* non-critical */ }

        // --- Process indications ---
        const indicationResults = await this.processIndicationConfigs(symbol, combinedCandles, indicationConfigs)
        totalIndicationResults += indicationResults

        try {
          await client.hincrby(`progression:${this.connectionId}`, "indications_count", indicationResults)
          await client.expire(`progression:${this.connectionId}`, 7 * 24 * 60 * 60)
        } catch { /* non-critical */ }

        // --- Process strategies ---
        const strategyPositions = await this.processStrategyConfigs(symbol, combinedCandles, strategyConfigs)
        totalStrategyPositions += strategyPositions

        try {
          await client.hincrby(`progression:${this.connectionId}`, "strategies_base_total", strategyPositions)
          await client.expire(`progression:${this.connectionId}`, 7 * 24 * 60 * 60)
        } catch { /* non-critical */ }

        // Mark symbol as completed in prehistoric hash
        try {
          await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)
          await client.expire(`prehistoric:${this.connectionId}:symbols`, 86400)
          await client.hset(`prehistoric:${this.connectionId}`, {
            candles_loaded: String(candlesProcessed),
            symbols_processed: String(symbolsProcessed),
            intervals_processed: String(totalIntervalsProcessed),
            missing_intervals: String(missingIntervalsLoaded),
          })
        } catch { /* non-critical */ }

      } catch (error) {
        console.error(`[v0] [ConfigSetProcessor] Error processing ${symbol}:`, error)
        errors++
        await logProgressionEvent(this.connectionId, "config_set_symbol_error", "error", `Prehistoric processing failed for ${symbol}`, {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const duration = Date.now() - startTime
    const result: ProcessingResult = {
      indicationConfigs: indicationConfigs.length,
      indicationResults: totalIndicationResults,
      strategyConfigs: strategyConfigs.length,
      strategyPositions: totalStrategyPositions,
      symbolsTotal: symbols.length,
      symbolsProcessed,
      symbolsWithoutData,
      candlesProcessed,
      errors,
      duration,
      intervalsProcessed: totalIntervalsProcessed,
      missingIntervalsLoaded,
      timeframeSeconds: timeframeSec,
      rangeStartMs: effectiveStart.getTime(),
      rangeEndMs: effectiveEnd.getTime(),
    }

    console.log(
      `[v0] [ConfigSetProcessor] Prehistoric processing complete: ` +
      `${totalIndicationResults} indication results, ${totalStrategyPositions} positions in ${duration}ms`
    )

    await logProgressionEvent(this.connectionId, "config_set_processing", "info", 
      `Processed prehistoric data through config sets`, result)

    await logProgressionEvent(this.connectionId, "config_set_processing_summary", errors > 0 ? "warning" : "info", "Prehistoric config processing summary", {
      symbolsTotal: result.symbolsTotal,
      symbolsProcessed: result.symbolsProcessed,
      symbolsWithoutData: result.symbolsWithoutData,
      candlesProcessed: result.candlesProcessed,
      indicationConfigs: result.indicationConfigs,
      strategyConfigs: result.strategyConfigs,
      indicationResults: result.indicationResults,
      strategyPositions: result.strategyPositions,
      errors: result.errors,
      durationMs: result.duration,
    })

    return result
  }

  /**
   * Process candles through all indication configs
   * Each config calculates independently
   */
  private async processIndicationConfigs(
    symbol: string,
    candles: any[],
    configs: IndicationConfig[]
  ): Promise<number> {
    let totalResults = 0

    for (const config of configs) {
      try {
        const results = this.calculateIndicationResults(symbol, candles, config)
        
        for (const result of results) {
          await this.indicationManager.addResult(config.id, result)
          totalResults++
        }
      } catch (error) {
        console.error(`[v0] [ConfigSetProcessor] Error processing indication config ${config.id}:`, error)
      }
    }

    return totalResults
  }

  /**
   * Calculate indication results for a specific config
   * Uses config parameters to generate signals
   */
  private calculateIndicationResults(
    symbol: string,
    candles: any[],
    config: IndicationConfig
  ): IndicationResult[] {
    const results: IndicationResult[] = []
    const { steps, drawdown_ratio, active_ratio, last_part_ratio, type } = config

    if (!candles || candles.length < steps) {
      return results
    }

    const prices = candles.slice(0, steps * 2).map((c: any) => 
      parseFloat(c.close || c.price || 0)
    ).filter((p: number) => p > 0)

    if (prices.length < steps) {
      return results
    }

    for (let i = 0; i < Math.min(prices.length - steps, 50); i++) {
      const windowPrices = prices.slice(i, i + steps)
      const firstHalf = windowPrices.slice(0, Math.floor(steps / 2))
      const secondHalf = windowPrices.slice(Math.floor(steps / 2))

      if (firstHalf.length < 2 || secondHalf.length < 2) continue

      const firstAvg = firstHalf.reduce((a: number, b: number) => a + b, 0) / firstHalf.length
      const secondAvg = secondHalf.reduce((a: number, b: number) => a + b, 0) / secondHalf.length

      const direction = secondAvg > firstAvg ? 1 : -1
      const magnitude = Math.abs(secondAvg - firstAvg) / firstAvg

      const adjustedMagnitude = magnitude * (1 - drawdown_ratio * 0.5) * active_ratio

      let signal: "buy" | "sell" | "neutral" = "neutral"
      let value = 0

      if (adjustedMagnitude > 0.005) {
        if (direction > 0) {
          signal = "buy"
          value = adjustedMagnitude * 100
        } else {
          signal = "sell"
          value = -adjustedMagnitude * 100
        }
      }

      if (signal !== "neutral") {
        const candle = candles[i]
        results.push({
          timestamp: candle?.timestamp || candle?.time || new Date().toISOString(),
          symbol,
          value,
          signal,
          confidence: Math.min(0.95, 0.5 + adjustedMagnitude),
        })
      }
    }

    return results.slice(0, 250)
  }

  /**
   * Process candles through all strategy configs
   * Creates pseudo positions based on strategy parameters
   */
  private async processStrategyConfigs(
    symbol: string,
    candles: any[],
    configs: StrategyConfig[]
  ): Promise<number> {
    let totalPositions = 0

    for (const config of configs) {
      try {
        const positions = this.calculateStrategyPositions(symbol, candles, config)
        
        for (const position of positions) {
          await this.strategyManager.addPosition(config.id, position)
          totalPositions++
        }
      } catch (error) {
        console.error(`[v0] [ConfigSetProcessor] Error processing strategy config ${config.id}:`, error)
      }
    }

    return totalPositions
  }

  /**
   * Calculate pseudo positions for a specific strategy config
   * Simulates trading with the config parameters
   */
  private calculateStrategyPositions(
    symbol: string,
    candles: any[],
    config: StrategyConfig
  ): PseudoPosition[] {
    const positions: PseudoPosition[] = []
    const { position_cost_step, takeprofit, stoploss, type } = config

    if (!candles || candles.length < position_cost_step * 2) {
      return positions
    }

    const prices = candles.map((c: any) => ({
      price: parseFloat(c.close || c.price || 0),
      time: c.timestamp || c.time || new Date().toISOString(),
    })).filter((p: any) => p.price > 0)

    let inPosition = false
    let entryPrice = 0
    let entryTime = ""
    let positionSide: "long" | "short" = "long"

    for (let i = position_cost_step; i < prices.length; i++) {
      const currentPrice = prices[i].price
      const currentTime = prices[i].time
      const lookbackPrices = prices.slice(i - position_cost_step, i).map(p => p.price)
      const avgPrice = lookbackPrices.reduce((a: number, b: number) => a + b, 0) / lookbackPrices.length

      if (!inPosition) {
        const priceDiff = (currentPrice - avgPrice) / avgPrice
        
        if (Math.abs(priceDiff) > 0.002) {
          inPosition = true
          entryPrice = currentPrice
          entryTime = currentTime
          positionSide = priceDiff > 0 ? "long" : "short"
        }
      } else {
        const pnl = positionSide === "long"
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice

        const takeProfitHit = pnl >= takeprofit
        const stopLossHit = pnl <= -stoploss

        if (takeProfitHit || stopLossHit) {
          positions.push({
            entry_time: entryTime,
            symbol,
            entry_price: entryPrice,
            take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
            stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
            status: "closed",
            result: pnl * 100,
            exit_time: currentTime,
            exit_price: currentPrice,
          })

          inPosition = false
        }
      }
    }

    if (inPosition && prices.length > 0) {
      const lastPrice = prices[prices.length - 1].price
      const lastTime = prices[prices.length - 1].time
      const pnl = positionSide === "long"
        ? (lastPrice - entryPrice) / entryPrice
        : (entryPrice - lastPrice) / entryPrice

      positions.push({
        entry_time: entryTime,
        symbol,
        entry_price: entryPrice,
        take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
        stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
        status: "open",
        result: pnl * 100,
      })
    }

    return positions.slice(0, 250)
  }

  /**
   * Get stats for all config sets
   */
  async getConfigSetStats(): Promise<{
    indications: { total: number; enabled: number; totalResults: number }
    strategies: { total: number; enabled: number; totalPositions: number }
  }> {
    const indicationConfigs = await this.indicationManager.getAllConfigs()
    const enabledIndications = indicationConfigs.filter(c => c.enabled)
    const strategyConfigs = await this.strategyManager.getAllConfigs()
    const enabledStrategies = strategyConfigs.filter(c => c.enabled)

    let totalIndicationResults = 0
    for (const config of enabledIndications) {
      totalIndicationResults += await this.indicationManager.getResultCount(config.id)
    }

    let totalStrategyPositions = 0
    for (const config of enabledStrategies) {
      totalStrategyPositions += await this.strategyManager.getPositionCount(config.id)
    }

    return {
      indications: {
        total: indicationConfigs.length,
        enabled: enabledIndications.length,
        totalResults: totalIndicationResults,
      },
      strategies: {
        total: strategyConfigs.length,
        enabled: enabledStrategies.length,
        totalPositions: totalStrategyPositions,
      },
    }
  }

  /**
   * Get best performing strategy configs
   */
  async getBestPerformingStrategies(limit: number = 10): Promise<Array<{
    config: StrategyConfig
    stats: any
  }>> {
    const configs = await this.strategyManager.getEnabledConfigs()
    const results: Array<{ config: StrategyConfig; stats: any }> = []

    for (const config of configs) {
      const stats = await this.strategyManager.getStats(config.id)
      if (stats.totalPositions > 0) {
        results.push({ config, stats })
      }
    }

    return results
      .sort((a, b) => b.stats.winRate - a.stats.winRate)
      .slice(0, limit)
  }
}
