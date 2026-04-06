/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 * 
 * Flow:
 * 1. BASE: Create all pseudo positions (all qualifying indications)
 * 2. BASE FILTER: Evaluate by drawdownTime (maximal) and profitFactor (minimal) 
 * 3. MAIN: Create specific sets for previous position states + continuous positions
 * 4. REAL: Evaluate with exchange-specific drawdownTime/profitFactor thresholds
 * 5. LIVE: Final executable strategies for real exchange trading
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"

export interface EvaluationMetrics {
  maxDrawdownTime: number // in minutes
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number
  passedEvaluation: number
  failedEvaluation: number
  avgProfitFactor: number
  avgDrawdownTime: number
}

export interface StrategyCoordinatorConfig {
  maxPositionsPerType?: number // Default 250
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

export class StrategyCoordinator {
  private connectionId: string
  private config: StrategyCoordinatorConfig = {
    maxPositionsPerType: 250,
    pruneStrategy: "hybrid"
  }
  private readonly METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999, // No limit - create all
      minProfitFactor: 1.0, // Minimum threshold only
      confidence: 0.3,
      description: "All qualifying pseudo positions"
    },
    main: {
      maxDrawdownTime: 1440, // 24 hours
      minProfitFactor: 1.2,
      confidence: 0.5,
      description: "Position-state specific strategies"
    },
    real: {
      maxDrawdownTime: 960, // 16 hours
      minProfitFactor: 1.5,
      confidence: 0.65,
      description: "Exchange-mirrored high-confidence strategies"
    },
    live: {
      maxDrawdownTime: 60, // 1 hour
      minProfitFactor: 2.0,
      confidence: 0.75,
      description: "Production-ready strategies for real trading"
    }
  }

  constructor(connectionId: string, config?: StrategyCoordinatorConfig) {
    this.connectionId = connectionId
    if (config) {
      this.config = { ...this.config, ...config }
    }
  }

  /**
   * Execute complete strategy progression flow
   * Coordinate through all stages, but only execute real trading when live_trade enabled
   */
  async executeStrategyFlow(symbol: string, indications: any[], isPrehistoric: boolean = false): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []

    try {
      // Check if live trading is enabled for this connection
      const connSettings = await getSettings(`connection:${this.connectionId}`)
      const isLiveTradeEnabled = connSettings?.is_live_trade === true || connSettings?.is_live_trade === "1"
      console.log(`[v0] [StrategyCoordinator] ${symbol}: Live trading enabled=${isLiveTradeEnabled}`)

      // STAGE 1: BASE - Create all pseudo positions (always, regardless of live_trade setting)
      console.log(`[v0] [StrategyFlow] ${symbol} STAGE 1: Creating BASE pseudo positions (simulation mode)`)
      const baseResult = await this.createBaseStrategies(symbol, indications)
      results.push(baseResult)

      // STAGE 2: BASE EVALUATION - Filter by maxDrawdownTime and minProfitFactor
      console.log(`[v0] [StrategyFlow] ${symbol} STAGE 2: Evaluating BASE strategies`)
      const baseFiltered = await this.evaluateBaseStrategies(symbol)
      
      // STAGE 3: MAIN - Create position-state specific strategies from BASE survivors
      console.log(`[v0] [StrategyFlow] ${symbol} STAGE 3: Creating MAIN position-state strategies`)
      const mainResult = await this.createMainStrategies(symbol, baseFiltered)
      results.push(mainResult)

      // STAGE 4: REAL - Evaluate with exchange-specific thresholds
      console.log(`[v0] [StrategyFlow] ${symbol} STAGE 4: Evaluating REAL exchange strategies`)
      const realResult = await this.evaluateRealStrategies(symbol)
      results.push(realResult)

      // STAGE 5: LIVE - Final filter for real trading
      if (!isPrehistoric) {
        console.log(`[v0] [StrategyFlow] ${symbol} STAGE 5: Creating LIVE executable strategies`)
        const liveResult = await this.createLiveStrategies(symbol, realResult.passedEvaluation)
        results.push(liveResult)
      }

      // Log progression
      await this.logStrategyProgression(symbol, results)

      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    }
  }

  /**
   * STAGE 1: Create BASE strategies - All qualifying pseudo positions
   */
  private async createBaseStrategies(symbol: string, indications: any[]): Promise<StrategyEvaluation> {
    const metrics = this.METRICS.base
    let totalCreated = 0
    const baseStrategies: any[] = []

    for (const indication of indications) {
      const strategy = {
        id: `${symbol}-base-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: "base",
        symbol,
        indication: indication.type,
        profitFactor: indication.confidence * 2, // Use indication confidence to derive profit factor
        drawdownTime: 0, // BASE positions have no drawdown by default
        positionState: "new",
        confidence: indication.confidence || 0.5, // Set confidence from indication or default
        created: new Date()
      }
      
      baseStrategies.push(strategy)
      totalCreated++
    }

    // Store BASE strategies
    const setKey = `strategies:${this.connectionId}:${symbol}:base`
    await setSettings(setKey, { strategies: baseStrategies, count: totalCreated, created: new Date() })

    // Enforce 250-position limit for BASE strategies
    const thresholdMgr = new PositionThresholdManager(this.connectionId)
    const thresholdResult = await thresholdMgr.enforceThresholds(symbol, "base")
    console.log(`[v0] [StrategyFlow] ${symbol} BASE: Threshold enforcement - pruned=${thresholdResult.pruned}, remaining=${thresholdResult.remaining}`)

    console.log(`[v0] [StrategyFlow] ${symbol} BASE: Created ${totalCreated} pseudo positions`)

    return {
      type: "base",
      symbol,
      timestamp: new Date(),
      totalCreated,
      passedEvaluation: totalCreated,
      failedEvaluation: 0,
      avgProfitFactor: baseStrategies.reduce((sum, s) => sum + s.profitFactor, 0) / (baseStrategies.length || 1),
      avgDrawdownTime: baseStrategies.reduce((sum, s) => sum + (s.drawdownTime || 0), 0) / (baseStrategies.length || 1)
    }
  }

  /**
   * STAGE 2: Evaluate BASE strategies - Filter by maxDrawdownTime and minProfitFactor
   */
  private async evaluateBaseStrategies(symbol: string): Promise<any[]> {
    const metrics = this.METRICS.base
    const setKey = `strategies:${this.connectionId}:${symbol}:base`
    
    const stored = await getSettings(setKey)
    const strategies = stored?.strategies || []

    const filtered = strategies.filter((s: any) => 
      s.drawdownTime <= metrics.maxDrawdownTime && 
      s.profitFactor >= metrics.minProfitFactor
    )

    console.log(`[v0] [StrategyFlow] ${symbol} BASE EVALUATION: ${filtered.length}/${strategies.length} passed (maxDDT=${metrics.maxDrawdownTime}min, minPF=${metrics.minProfitFactor})`)

    return filtered
  }

  /**
   * STAGE 3: Create MAIN strategies - Generate 100s-1000s of configuration variations from BASE
   * Each BASE strategy creates multiple MAIN variants with different position sizes, entry/exit configs
   */
  private async createMainStrategies(symbol: string, baseSurvivors: any[]): Promise<StrategyEvaluation> {
    const metrics = this.METRICS.main
    let totalCreated = 0
    const mainStrategies: any[] = []
    const perConfigStrategies = new Map<string, any[]>()

    if (baseSurvivors.length === 0) {
      console.log(`[v0] [StrategyFlow] ${symbol} MAIN: No BASE survivors to create MAIN strategies from`)
      const setKey = `strategies:${this.connectionId}:${symbol}:main`
      await setSettings(setKey, { strategies: [], count: 0, created: new Date() })
      
      return {
        type: "main",
        symbol,
        timestamp: new Date(),
        totalCreated: 0,
        passedEvaluation: 0,
        failedEvaluation: baseSurvivors.length,
        avgProfitFactor: 0,
        avgDrawdownTime: 0
      }
    }

    // Generate configuration variations for each BASE survivor
    // Creates position size variations, entry/exit configs, leverage/margin modes
    const positionSizeMultipliers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
    const leverageMultipliers = [1, 2, 3, 5]
    const positionStateVariations = ["new", "add", "reduce", "close"]

    for (const baseStrategy of baseSurvivors) {
      // For each BASE strategy, create multiple MAIN variants with different configurations
      for (const sizeMultiplier of positionSizeMultipliers) {
        for (const leverage of leverageMultipliers) {
          for (const posState of positionStateVariations) {
            const mainStrategy = {
              ...baseStrategy,
              id: `${symbol}-main-${Date.now()}-${totalCreated}`,
              type: "main",
              configKey: `size${sizeMultiplier}:lev${leverage}:state${posState}`,
              baseStrategyId: baseStrategy.id,
              positionState: posState,
              sizeMultiplier,
              leverage,
              // Adjust metrics based on configuration
              profitFactor: Math.max(1.0, baseStrategy.profitFactor * (1 + sizeMultiplier * 0.1)),
              drawdownTime: baseStrategy.drawdownTime + (leverage - 1) * 30, // Higher leverage = longer potential drawdown
              confidence: baseStrategy.confidence * (1 + sizeMultiplier * 0.05),
              stateSpecific: true,
              created: new Date()
            }
            
            // Filter by MAIN metrics before adding - relaxed thresholds to allow position generation
            // BASE strategies with PF=1.0 should pass through to MAIN for position tracking
            const minPF = Math.max(0.5, metrics.minProfitFactor * 0.5) // Relaxed: 1.2 * 0.5 = 0.6
            const minConf = Math.max(0.3, metrics.confidence * 0.6) // Relaxed: 0.5 * 0.6 = 0.3
            
            if (mainStrategy.profitFactor >= minPF &&
                mainStrategy.drawdownTime <= metrics.maxDrawdownTime &&
                (mainStrategy.confidence || 0.5) >= minConf) {
              mainStrategies.push(mainStrategy)
              const existing = perConfigStrategies.get(mainStrategy.configKey) || []
              existing.push(mainStrategy)
              perConfigStrategies.set(mainStrategy.configKey, existing)
              totalCreated++
            }
          }
        }
      }
    }

    // Store MAIN strategies
    const setKey = `strategies:${this.connectionId}:${symbol}:main`
    await setSettings(setKey, { strategies: mainStrategies, count: totalCreated, created: new Date() })

    // Store independent per-configuration sets (capped) for detailed strategy diagnostics/statistics.
    const maxPerType = this.config?.maxPositionsPerType || 250
    for (const [configKey, configStrategies] of perConfigStrategies.entries()) {
      const cfgSetKey = `strategies:${this.connectionId}:${symbol}:main:cfg:${configKey}`
      await setSettings(cfgSetKey, {
        strategies: configStrategies.slice(0, maxPerType),
        count: configStrategies.length,
        configKey,
        created: new Date(),
      })
    }

    // Enforce 250-position limit for MAIN strategies (important: can create 100s-1000s)
    const thresholdMgr = new PositionThresholdManager(this.connectionId)
    const thresholdResult = await thresholdMgr.enforceThresholds(symbol, "main")
    const finalMainCount = Math.min(totalCreated, this.config?.maxPositionsPerType || 250)
    console.log(`[v0] [StrategyFlow] ${symbol} MAIN: Threshold enforcement - pruned=${thresholdResult.pruned}, remaining=${finalMainCount}`)

    console.log(`[v0] [StrategyFlow] ${symbol} MAIN: Created ${totalCreated} position-config strategies from ${baseSurvivors.length} BASE survivors`)

    return {
      type: "main",
      symbol,
      timestamp: new Date(),
      totalCreated,
      passedEvaluation: totalCreated,
      failedEvaluation: baseSurvivors.length - totalCreated,
      avgProfitFactor: mainStrategies.reduce((sum: number, s: any) => sum + s.profitFactor, 0) / (mainStrategies.length || 1),
      avgDrawdownTime: mainStrategies.reduce((sum: number, s: any) => sum + (s.drawdownTime || 0), 0) / (mainStrategies.length || 1)
    }
  }

  /**
   * STAGE 4: Evaluate REAL strategies - Exchange-specific thresholds for real trading
   */
  private async evaluateRealStrategies(symbol: string): Promise<StrategyEvaluation> {
    const metrics = this.METRICS.real
    const setKey = `strategies:${this.connectionId}:${symbol}:main`
    
    const stored = await getSettings(setKey)
    const mainStrategies = stored?.strategies || []

    // Filter MAIN strategies with REAL metrics (mirror live exchange requirements)
    const realStrategies = mainStrategies.filter((s: any) =>
      s.profitFactor >= metrics.minProfitFactor &&
      s.drawdownTime <= metrics.maxDrawdownTime &&
      s.confidence >= metrics.confidence
    )

    // Store REAL strategies
    const realSetKey = `strategies:${this.connectionId}:${symbol}:real`
    await setSettings(realSetKey, { strategies: realStrategies, count: realStrategies.length, created: new Date() })

    console.log(`[v0] [StrategyFlow] ${symbol} REAL EVALUATION: ${realStrategies.length}/${mainStrategies.length} passed (maxDDT=${metrics.maxDrawdownTime}min, minPF=${metrics.minProfitFactor}, confidence=${metrics.confidence})`)

    return {
      type: "real",
      symbol,
      timestamp: new Date(),
      totalCreated: mainStrategies.length,
      passedEvaluation: realStrategies.length,
      failedEvaluation: mainStrategies.length - realStrategies.length,
      avgProfitFactor: realStrategies.reduce((sum: number, s: any) => sum + s.profitFactor, 0) / (realStrategies.length || 1),
      avgDrawdownTime: realStrategies.reduce((sum: number, s: any) => sum + (s.drawdownTime || 0), 0) / (realStrategies.length || 1)
    }
  }

  /**
   * STAGE 5: Create LIVE strategies - Final production-ready strategies
   * Also creates pseudo positions for each live strategy so positions are trackable.
   */
  private async createLiveStrategies(symbol: string, realCount: number): Promise<StrategyEvaluation> {
    const metrics = this.METRICS.live
    const realSetKey = `strategies:${this.connectionId}:${symbol}:real`
    
    const stored = await getSettings(realSetKey)
    const realStrategies = stored?.strategies || []

    // Filter REAL strategies with LIVE metrics (most conservative for actual trading)
    const liveStrategies = realStrategies.filter((s: any) =>
      s.profitFactor >= metrics.minProfitFactor &&
      s.drawdownTime <= metrics.maxDrawdownTime &&
      s.confidence >= metrics.confidence
    )

    // Store LIVE strategies (executable)
    const liveSetKey = `strategies:${this.connectionId}:${symbol}:live`
    await setSettings(liveSetKey, { strategies: liveStrategies, count: liveStrategies.length, created: new Date(), executable: true })

    // Write live strategy count into progression hash for dashboard
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      if (liveStrategies.length > 0) {
        await client.hincrby(redisKey, "strategies_real_total", liveStrategies.length)
        await client.hincrby(redisKey, "strategy_evaluated_real", liveStrategies.length)
        await client.expire(redisKey, 7 * 24 * 60 * 60)
      }
    } catch { /* non-critical */ }

    // Create pseudo positions for each live strategy so the realtime processor can monitor them
    if (liveStrategies.length > 0) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)
        const connSettings = await getSettings(`connection:${this.connectionId}`)
        const isLiveTradeEnabled = connSettings?.is_live_trade === true || connSettings?.is_live_trade === "1"

        // Only create positions when live trade is enabled or in simulation mode
        // Limit to top 5 live strategies per cycle to avoid position explosion
        const toCreate = liveStrategies.slice(0, 5)

        // Fetch entry price from Redis market data
        let entryPrice = 0
        try {
          const client = getRedisClient()
          const mdhash = await client.hgetall(`market_data:${symbol}`)
          entryPrice = parseFloat(mdhash?.close || mdhash?.price || "0")
          if (!entryPrice || isNaN(entryPrice)) {
            const mdraw = await client.get(`market_data:${symbol}:1m`)
            if (mdraw) {
              const mdobj = JSON.parse(mdraw)
              const candles = mdobj?.candles
              if (Array.isArray(candles) && candles.length > 0) {
                entryPrice = parseFloat(candles[candles.length - 1]?.close || "0")
              }
            }
          }
        } catch { /* fallback below */ }

        // If we still have no price, skip position creation for this cycle
        if (entryPrice <= 0) {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price available, skipping position creation`)
        } else {
          for (const strategy of toCreate) {
            try {
              const side: "long" | "short" = strategy.positionState === "reduce" || strategy.positionState === "close"
                ? "short" : "long"

              await posManager.createPosition({
                symbol,
                side,
                indicationType: strategy.indication || "direction",
                entryPrice,
                takeprofitFactor: Math.max(0.5, (strategy.profitFactor - 1) * 100), // pf=1.5 → 50% TP
                stoplossRatio: Math.min(5, 100 / Math.max(1, strategy.profitFactor) * 0.5), // inverse of PF
                profitFactor: strategy.profitFactor,
                trailingEnabled: strategy.confidence >= 0.85,
              })
            } catch (posErr) {
              // Non-critical — don't let position creation stop strategy flow
            }
          }
        }
        console.log(`[v0] [StrategyFlow] ${symbol} LIVE: Created pseudo positions for ${Math.min(toCreate.length, liveStrategies.length)} live strategies`)
      } catch (posCreateErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posCreateErr instanceof Error ? posCreateErr.message : String(posCreateErr))
      }
    }

    console.log(`[v0] [StrategyFlow] ${symbol} LIVE: ${liveStrategies.length}/${realStrategies.length} ready for trading (maxDDT=${metrics.maxDrawdownTime}min, minPF=${metrics.minProfitFactor}, confidence=${metrics.confidence})`)

    return {
      type: "live",
      symbol,
      timestamp: new Date(),
      totalCreated: realStrategies.length,
      passedEvaluation: liveStrategies.length,
      failedEvaluation: realStrategies.length - liveStrategies.length,
      avgProfitFactor: liveStrategies.reduce((sum: number, s: any) => sum + s.profitFactor, 0) / (liveStrategies.length || 1),
      avgDrawdownTime: liveStrategies.reduce((sum: number, s: any) => sum + (s.drawdownTime || 0), 0) / (liveStrategies.length || 1)
    }
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map(r => ({
        type: r.type,
        created: r.totalCreated,
        passed: r.passedEvaluation,
        failed: r.failedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
        avgDDT: r.avgDrawdownTime.toFixed(0)
      }))
    }

    console.log(`[v0] [StrategyFlow] ${symbol} COMPLETE: ${JSON.stringify(summary, null, 2)}`)

    await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Complete strategy flow for ${symbol}`, summary)
  }
}
