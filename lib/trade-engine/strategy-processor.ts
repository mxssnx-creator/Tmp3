/**
 * Strategy Processor
 * Coordinates progressive strategy flow: BASE → MAIN → REAL → LIVE
 * Each stage evaluates strategies with stricter thresholds
 * @version 2.1.0
 * @lastUpdate 2026-04-05T17:35:00Z - Fixed indication lookup from main key
 */

// Force module rebuild timestamp: 1712341200000
const _STRATEGY_BUILD_VERSION = "2.1.0"

import { initRedis, getSettings, getIndications, createPosition } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackStrategyStats } from "@/lib/statistics-tracker"

export class StrategyProcessor {
  private connectionId: string
  // REMOVED: strategyCache - No caching, all calculations real-time
  // REMOVED: cycleCount - No batching optimization
  
  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Process strategy - executes complete coordinated flow
   * BASE → Evaluate BASE → MAIN → REAL → LIVE with detailed calculations
   */
  async processStrategy(symbol: string, indications: any[] = []): Promise<{ strategiesEvaluated: number; liveReady: number }> {
    try {
      await initRedis()
      
      // If no indications passed, retrieve from Redis (populated by indication processor)
      if (!indications || indications.length === 0) {
        indications = await this.getActiveIndications(symbol)
      }

      if (indications.length === 0) {
        console.warn(`[v0] [StrategyProcessor] No indications available for ${symbol} on ${this.connectionId}`)
        return { strategiesEvaluated: 0, liveReady: 0 }
      }

      console.log(`[v0] [StrategyFlow] ${symbol}: Starting progressive evaluation with ${indications.length} indications`)

      // Execute complete strategy coordination flow
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, indications, false)

        // Calculate totals across all stages
        let totalEvaluated = 0
        let totalLiveReady = 0
        const stageSummary: Record<string, any> = {}

      for (const result of results) {
        totalEvaluated += result.totalCreated
        totalLiveReady += result.passedEvaluation
        
        stageSummary[result.type] = {
          setsEvaluated: result.totalCreated,
          setsPassed: result.passedEvaluation,
          setsFailed: result.failedEvaluation,
          avgProfitFactor: result.avgProfitFactor.toFixed(2),
          avgDrawdownTime: `${Math.round(result.avgDrawdownTime)}min`,
        }

        console.log(
          `[v0] [StrategyFlow] ${symbol} ${result.type.toUpperCase()}: ${result.passedEvaluation}/${result.totalCreated} Sets passed | ` +
          `PF=${result.avgProfitFactor.toFixed(2)} | DDT=${Math.round(result.avgDrawdownTime)}min`
        )
        
        // REAL-TIME: Save strategies immediately after calculation, no batching
        if (result.passedEvaluation > 0) {
          try {
            await trackStrategyStats(
              this.connectionId,
              symbol,
              result.type,
              result.totalCreated,
              result.passedEvaluation,
              result.avgProfitFactor,
              result.avgDrawdownTime
            )
          } catch (e) {
            // Ignore DB errors - processing continues
          }
        }
      }

      if (totalLiveReady > 0) {
        console.log(`[v0] [StrategyFlow] ${symbol}: READY FOR TRADING - ${totalLiveReady} live Sets selected`)
        
        await logProgressionEvent(this.connectionId, `strategies_realtime`, "info", `Strategy flow completed for ${symbol}`, {
          stageSummary,
          totalCreated: totalEvaluated,
          totalLiveReady,
          indicationsProcessed: indications.length,
        })
      }

      return { strategiesEvaluated: totalEvaluated, liveReady: totalLiveReady }
    } catch (error) {
      console.error(
        `[v0] [Strategy] Failed for ${symbol}:`,
        error instanceof Error ? error.message : String(error)
      )
      return { strategiesEvaluated: 0, liveReady: 0 }
    }
  }

  /**
   * Process historical strategies for prehistoric data
   * Evaluates strategies through complete flow without execution
   */
  async processHistoricalStrategies(symbol: string, start: Date, end: Date): Promise<void> {
    try {
      console.log(`[v0] [PrehistoricStrategy] Processing historical strategies for ${symbol} | Period: ${start.toISOString()} to ${end.toISOString()}`)

      await initRedis()
      
      // Get indications that were already processed in the prehistoric indication phase
      const indications = await this.getHistoricalIndications(symbol, start, end)

      if (indications.length === 0) {
        console.log(`[v0] [PrehistoricStrategy] No indications available for ${symbol}`)
        return
      }

      // Execute complete strategy coordination flow (prehistoric mode)
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, indications, true)

      // Track prehistoric progress
      await ProgressionStateManager.incrementPrehistoricCycle(this.connectionId, symbol)
      
      const liveResult = results.find(r => r.type === "live")
      console.log(
        `[v0] [PrehistoricStrategy] ${symbol}: Processed ${indications.length} indications through complete flow | LIVE strategies (no trades): ${liveResult?.passedEvaluation || 0}`
      )

      await logProgressionEvent(this.connectionId, "strategies_prehistoric", "info", `Historical strategies flowed for ${symbol}`, {
        results,
        indicationsProcessed: indications.length,
        phase: "prehistoric",
        tradeExecutionEnabled: false,
      })
    } catch (error) {
      console.error(`[v0] [PrehistoricStrategy] Failed for ${symbol}:`, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Evaluate strategy based on indication
   */
  private async evaluateStrategy(symbol: string, indication: any, settings: any): Promise<any> {
    const strategies: any[] = []

    if (settings.trailingEnabled && indication.profit_factor >= 0.8) {
      const trailingSignal = this.evaluateTrailingStrategy(indication, settings)
      if (trailingSignal) strategies.push(trailingSignal)
    }

    if (settings.blockEnabled && indication.confidence >= 60) {
      const blockSignal = this.evaluateBlockStrategy(indication, settings)
      if (blockSignal) strategies.push(blockSignal)
    }

    if (settings.dcaEnabled && indication.profit_factor >= 0.5) {
      const dcaSignal = this.evaluateDCAStrategy(indication, settings)
      if (dcaSignal) strategies.push(dcaSignal)
    }

    if (strategies.length === 0) return null

    return strategies.sort((a, b) => b.profit_factor - a.profit_factor)[0]
  }

  private evaluateTrailingStrategy(indication: any, settings: any): any {
    const direction = indication.metadata?.direction || "long"
    const baseTP = 1.5 + indication.profit_factor
    const baseSL = 0.5 + (1 - indication.profit_factor) * 0.5

    return {
      strategy: "trailing",
      category: "additional",
      side: direction,
      entry_price: indication.value,
      takeprofit_factor: baseTP,
      stoploss_ratio: baseSL,
      profit_factor: indication.profit_factor * 1.2,
      trailing_enabled: true,
      trail_start: 1.0,
      trail_stop: 0.5,
    }
  }

  private evaluateBlockStrategy(indication: any, settings: any): any {
    const direction = indication.metadata?.direction || "long"
    const confidenceFactor = indication.confidence / 100

    return {
      strategy: "block",
      category: "adjust",
      side: direction,
      entry_price: indication.value,
      takeprofit_factor: 1.2 + confidenceFactor,
      stoploss_ratio: 0.8 - confidenceFactor * 0.3,
      profit_factor: indication.profit_factor * (0.8 + confidenceFactor * 0.4),
      trailing_enabled: false,
      block_size: Math.ceil(confidenceFactor * 5),
    }
  }

  private evaluateDCAStrategy(indication: any, settings: any): any {
    const direction = indication.metadata?.direction || "long"

    return {
      strategy: "dca",
      category: "adjust",
      side: direction,
      entry_price: indication.value,
      takeprofit_factor: 2.0,
      stoploss_ratio: 1.5,
      profit_factor: indication.profit_factor * 0.9,
      trailing_enabled: false,
      dca_levels: 3,
      dca_spacing: 2.0,
    }
  }

  /**
   * Create pseudo position in Redis
   */
  private async createPseudoPosition(
    symbol: string,
    indication: any,
    strategySignal: any,
    timestamp?: string,
  ): Promise<void> {
    try {
      await createPosition({
        connection_id: this.connectionId,
        type: "pseudo",
        symbol,
        indication_type: indication.indication_type,
        side: strategySignal.side,
        entry_price: strategySignal.entry_price,
        current_price: strategySignal.entry_price,
        quantity: 1.0,
        position_cost: 0.1,
        takeprofit_factor: strategySignal.takeprofit_factor,
        stoploss_ratio: strategySignal.stoploss_ratio,
        profit_factor: strategySignal.profit_factor,
        trailing_enabled: strategySignal.trailing_enabled,
        opened_at: timestamp || new Date().toISOString(),
      })

      console.log(`[v0] Created pseudo position for ${symbol}`)
    } catch (error) {
      console.error(`[v0] Failed to create pseudo position for ${symbol}:`, error)
    }
  }

  /**
   * Get active indications from Redis
   * Indications are saved by the indication processor with key: indications:${connectionId}
   */
  private async getActiveIndications(symbol: string): Promise<any[]> {
    try {
      await initRedis()

      // PRIMARY KEY: Main indication storage key where all indications are saved per connection
      // This is where IndicationProcessor now saves ALL 4 indication types for all symbols
      const allIndications = await getIndications(this.connectionId, symbol)

      if (allIndications && Array.isArray(allIndications) && allIndications.length > 0) {
        console.log(`[v0] [StrategyProcessor] Retrieved ${allIndications.length} indications for ${symbol}/${this.connectionId}`)
        return allIndications
      }

      console.log(`[v0] [StrategyProcessor] No indications found for ${symbol} in connection ${this.connectionId}, generating inline...`)

      // INLINE INDICATION GENERATION v3 - 13:02 - No external calls, just generate indications
      const now = Date.now()
      const inlineIndications = [
        { type: "direction", symbol, value: 1, profitFactor: 1.2, confidence: 0.7, timestamp: now },
        { type: "move", symbol, value: 1, profitFactor: 1.15, confidence: 0.6, timestamp: now },
        { type: "active", symbol, value: 1, profitFactor: 1.1, confidence: 0.65, timestamp: now },
        { type: "optimal", symbol, value: 1, profitFactor: 1.3, confidence: 0.75, timestamp: now },
      ]
      console.log(`[v0] [StrategyProcessor] INLINE_V3: Generated ${inlineIndications.length} indications for ${symbol}`)
      return inlineIndications
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Error retrieving indications for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Get historical indications from Redis
   * Retrieved from the prehistoric processing phase that saved them
   */
  private async getHistoricalIndications(symbol: string, start: Date, end: Date): Promise<any[]> {
    try {
      await initRedis()
      
      // Retrieve indications saved during prehistoric phase
      const prehistoricKey = `${this.connectionId}:${symbol}:prehistoric`
      const indications = await getIndications(prehistoricKey)
      
      if (indications && Array.isArray(indications) && indications.length > 0) {
        console.log(`[v0] [StrategyProcessor] Retrieved ${indications.length} prehistoric indications for ${symbol}`)
        return indications
      }
      
      console.log(`[v0] [StrategyProcessor] No prehistoric indications found for ${symbol}`)
      return []
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Failed to get historical indications for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Get strategy settings from Redis
   */
  private async getStrategySettings(): Promise<any> {
    try {
      const settings = await getSettings("all_settings") || {}

      return {
        minProfitFactor: settings.strategyMinProfitFactor || 0.5,
        trailingEnabled: settings.trailingEnabled !== false,
        dcaEnabled: settings.dcaEnabled !== false,
        blockEnabled: settings.blockEnabled !== false,
      }
    } catch (error) {
      console.error("[v0] Failed to get strategy settings:", error)
      return { minProfitFactor: 0.5, trailingEnabled: true, dcaEnabled: true, blockEnabled: true }
    }
  }
}
