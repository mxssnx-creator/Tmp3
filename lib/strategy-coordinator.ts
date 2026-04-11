/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 *
 * Flow:
 * 1. BASE: Create one strategy Set per (indication_type × direction) combination
 *          Each Set holds up to 250 config entries. Count = number of Sets.
 * 2. MAIN: Select Sets where avgProfitFactor >= 1.2 (from base).
 *          Expand each Set with position-size / leverage config variants.
 *          Max 250 entries per Set; rearrange by performance when over limit.
 * 3. REAL: Select Sets where avgProfitFactor >= 1.4 (from main).
 *          Exchange-mirrored high-confidence strategies.
 * 4. LIVE: Select best 500 Sets (ranked by profitFactor) for real trading.
 *          One pseudo position per (indication_type, direction) Set.
 *
 * Strategy counts always represent the number of SETS, not individual pseudo positions.
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"

export interface EvaluationMetrics {
  maxDrawdownTime: number
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number      // number of Sets created/evaluated
  passedEvaluation: number  // number of Sets that passed the filter
  failedEvaluation: number  // number of Sets that failed
  avgProfitFactor: number
  avgDrawdownTime: number
}

// One Set = one unique (indication_type × direction) combination
export interface StrategySet {
  setKey: string            // e.g. "direction:long"
  indicationType: string
  direction: "long" | "short"
  avgProfitFactor: number
  avgConfidence: number
  avgDrawdownTime: number
  entryCount: number        // number of config entries in this set (max 250)
  entries: StrategySetEntry[]
  createdAt: string
}

export interface StrategySetEntry {
  id: string
  sizeMultiplier: number
  leverage: number
  positionState: string
  profitFactor: number
  drawdownTime: number
  confidence: number
}

export interface StrategyCoordinatorConfig {
  maxEntriesPerSet?: number   // Default 250 (entries inside one Set)
  maxLiveSets?: number        // Default 500 (Sets eligible for live trading)
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

export class StrategyCoordinator {
  private connectionId: string
  private config: StrategyCoordinatorConfig = {
    maxEntriesPerSet: 250,
    maxLiveSets: 500,
    pruneStrategy: "hybrid",
  }

  // Profit factor thresholds per stage
  private readonly PF_BASE_MIN = 1.0    // Minimum to enter BASE set
  private readonly PF_MAIN_MIN = 1.2    // Base sets must have avgPF >= 1.2 to enter MAIN
  private readonly PF_REAL_MIN = 1.4    // Main sets must have avgPF >= 1.4 to enter REAL
  private readonly PF_LIVE_MIN = 2.0    // Real sets must have avgPF >= 2.0 to enter LIVE

  private readonly METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999,
      minProfitFactor: 1.0,
      confidence: 0.3,
      description: "One Set per (indication_type × direction) — all qualifying",
    },
    main: {
      maxDrawdownTime: 1440,  // 24 hours
      minProfitFactor: 1.2,   // Base sets with avgPF >= 1.2 → promoted to MAIN
      confidence: 0.5,
      description: "Sets promoted from BASE with profitFactor >= 1.2",
    },
    real: {
      maxDrawdownTime: 960,   // 16 hours
      minProfitFactor: 1.4,   // Main sets with avgPF >= 1.4 → promoted to REAL
      confidence: 0.65,
      description: "Sets promoted from MAIN with profitFactor >= 1.4",
    },
    live: {
      maxDrawdownTime: 60,    // 1 hour
      minProfitFactor: 2.0,
      confidence: 0.75,
      description: "Best 500 Sets ready for real trading",
    },
  }

  constructor(connectionId: string, config?: StrategyCoordinatorConfig) {
    this.connectionId = connectionId
    if (config) {
      this.config = { ...this.config, ...config }
    }
  }

  /**
   * Execute complete strategy progression flow
   */
  async executeStrategyFlow(
    symbol: string,
    indications: any[],
    isPrehistoric: boolean = false
  ): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []

    try {
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const baseResult = await this.createBaseSets(symbol, indications)
      results.push(baseResult)

      // STAGE 2: MAIN — promote Sets with avgPF >= 1.2, expand config entries
      const mainResult = await this.createMainSets(symbol)
      results.push(mainResult)

      // STAGE 3: REAL — promote Sets with avgPF >= 1.4
      const realResult = await this.evaluateRealSets(symbol)
      results.push(realResult)

      // STAGE 4: LIVE — best 500 Sets for execution (skip in prehistoric mode)
      if (!isPrehistoric) {
        const liveResult = await this.createLiveSets(symbol)
        results.push(liveResult)
      }

      await this.logStrategyProgression(symbol, results)
      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    }
  }

  // ─── STAGE 1: BASE ───────────────────────────────────────────────────────────

  /**
   * Create one StrategySet per (indication_type × direction) combination.
   * Each Set holds multiple config entries (max 250), but counts as 1 Set.
   */
  private async createBaseSets(symbol: string, indications: any[]): Promise<StrategyEvaluation> {
    // Group indications by (type × direction)
    const setMap = new Map<string, { indicationType: string; direction: "long" | "short"; indications: any[] }>()

    for (const ind of indications) {
      const direction: "long" | "short" = ind.metadata?.direction === "short" ? "short" : "long"
      const key = `${ind.type || "direction"}:${direction}`
      if (!setMap.has(key)) {
        setMap.set(key, { indicationType: ind.type || "direction", direction, indications: [] })
      }
      setMap.get(key)!.indications.push(ind)
    }

    const baseSets: StrategySet[] = []
    const maxEntries = this.config.maxEntriesPerSet || 250

    for (const [setKey, group] of setMap.entries()) {
      // Build up to maxEntries config entries for this Set
      const entries: StrategySetEntry[] = []
      let entryIdx = 0

      for (const ind of group.indications) {
        if (entryIdx >= maxEntries) break
        const pf = (ind.confidence || 0.5) * 2
        if (pf < this.PF_BASE_MIN) continue

        entries.push({
          id: `${setKey}-${entryIdx}`,
          sizeMultiplier: 1.0,
          leverage: 1,
          positionState: "new",
          profitFactor: pf,
          drawdownTime: 0,
          confidence: ind.confidence || 0.5,
        })
        entryIdx++
      }

      if (entries.length === 0) continue

      const avgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
      const avgConf = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

      const set: StrategySet = {
        setKey,
        indicationType: group.indicationType,
        direction: group.direction,
        avgProfitFactor: avgPF,
        avgConfidence: avgConf,
        avgDrawdownTime: 0,
        entryCount: entries.length,
        entries,
        createdAt: new Date().toISOString(),
      }

      baseSets.push(set)
    }

    // Persist BASE sets
    const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
    await setSettings(baseKey, { sets: baseSets, count: baseSets.length, created: new Date() })

    // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      await client.hincrby(redisKey, "strategies_base_total", baseSets.length)
      await client.hincrby(redisKey, "strategy_evaluated_base", baseSets.length)
      await client.expire(redisKey, 7 * 24 * 60 * 60)
    } catch { /* non-critical */ }

    console.log(`[v0] [StrategyFlow] ${symbol} BASE: ${baseSets.length} Sets created (${baseSets.reduce((s, set) => s + set.entryCount, 0)} total entries)`)

    return {
      type: "base",
      symbol,
      timestamp: new Date(),
      totalCreated: baseSets.length,
      passedEvaluation: baseSets.length,
      failedEvaluation: 0,
      avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
      avgDrawdownTime: 0,
    }
  }

  // ─── STAGE 2: MAIN ───────────────────────────────────────────────────────────

  /**
   * Promote BASE Sets with avgProfitFactor >= 1.2 to MAIN.
   * Expand each Set with multiple position-size / leverage variants (max 250 entries).
   */
  private async createMainSets(symbol: string): Promise<StrategyEvaluation> {
    const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
    const stored = await getSettings(baseKey)
    const baseSets: StrategySet[] = stored?.sets || []

    const metrics = this.METRICS.main
    const maxEntries = this.config.maxEntriesPerSet || 250

    // Config variants to expand each qualifying base Set
    const sizeMultipliers = [0.5, 1.0, 1.5, 2.0]
    const leverageOptions = [1, 2, 3, 5]
    const positionStates = ["new", "add", "reduce", "close"]

    const mainSets: StrategySet[] = []

    for (const baseSet of baseSets) {
      // Filter: only promote Sets with avgPF >= 1.2
      if (baseSet.avgProfitFactor < metrics.minProfitFactor) continue
      if (baseSet.avgConfidence < metrics.confidence) continue

      const entries: StrategySetEntry[] = []
      let entryIdx = 0

      // Expand config variants from the base Set entries
      for (const baseEntry of baseSet.entries) {
        for (const size of sizeMultipliers) {
          for (const leverage of leverageOptions) {
            for (const state of positionStates) {
              if (entryIdx >= maxEntries) break

              const pf = Math.max(
                metrics.minProfitFactor,
                baseEntry.profitFactor * (1 + size * 0.05)
              )
              const ddt = baseEntry.drawdownTime + (leverage - 1) * 30

              if (ddt > metrics.maxDrawdownTime) continue

              entries.push({
                id: `${baseSet.setKey}-main-${entryIdx}`,
                sizeMultiplier: size,
                leverage,
                positionState: state,
                profitFactor: pf,
                drawdownTime: ddt,
                confidence: Math.min(0.99, baseEntry.confidence * (1 + size * 0.02)),
              })
              entryIdx++
            }
            if (entryIdx >= maxEntries) break
          }
          if (entryIdx >= maxEntries) break
        }
        if (entryIdx >= maxEntries) break
      }

      if (entries.length === 0) continue

      // Enforce max 250 entries per Set — keep highest profitFactor entries
      const cappedEntries = this.pruneEntries(entries, maxEntries)

      const avgPF = cappedEntries.reduce((s, e) => s + e.profitFactor, 0) / cappedEntries.length
      const avgConf = cappedEntries.reduce((s, e) => s + e.confidence, 0) / cappedEntries.length
      const avgDDT = cappedEntries.reduce((s, e) => s + e.drawdownTime, 0) / cappedEntries.length

      mainSets.push({
        setKey: baseSet.setKey,
        indicationType: baseSet.indicationType,
        direction: baseSet.direction,
        avgProfitFactor: avgPF,
        avgConfidence: avgConf,
        avgDrawdownTime: avgDDT,
        entryCount: cappedEntries.length,
        entries: cappedEntries,
        createdAt: new Date().toISOString(),
      })
    }

    // Persist MAIN sets
    const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
    await setSettings(mainKey, { sets: mainSets, count: mainSets.length, created: new Date() })

    // Write Main counts to progression hash (evaluated = sets promoted, total = base sets evaluated)
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      await client.hincrby(redisKey, "strategies_main_total", baseSets.length)   // how many Base sets were evaluated against Main threshold
      await client.hincrby(redisKey, "strategy_evaluated_main", mainSets.length) // how many passed to Main
      await client.expire(redisKey, 7 * 24 * 60 * 60)
    } catch { /* non-critical */ }

    const failed = baseSets.length - mainSets.length
    console.log(
      `[v0] [StrategyFlow] ${symbol} MAIN: ${mainSets.length}/${baseSets.length} Sets promoted (minPF=${metrics.minProfitFactor}) | ` +
      `${mainSets.reduce((s, set) => s + set.entryCount, 0)} total entries`
    )

    return {
      type: "main",
      symbol,
      timestamp: new Date(),
      totalCreated: baseSets.length,
      passedEvaluation: mainSets.length,
      failedEvaluation: failed,
      avgProfitFactor: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgProfitFactor, 0) / mainSets.length : 0,
      avgDrawdownTime: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / mainSets.length : 0,
    }
  }

  // ─── STAGE 3: REAL ───────────────────────────────────────────────────────────

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(symbol: string): Promise<StrategyEvaluation> {
    const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
    const stored = await getSettings(mainKey)
    const mainSets: StrategySet[] = stored?.sets || []

    const metrics = this.METRICS.real

    const realSets = mainSets.filter(
      (s) =>
        s.avgProfitFactor >= metrics.minProfitFactor &&
        s.avgDrawdownTime <= metrics.maxDrawdownTime &&
        s.avgConfidence >= metrics.confidence
    )

    // Persist REAL sets
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    await setSettings(realKey, { sets: realSets, count: realSets.length, created: new Date() })

    // Write Real counts to progression hash
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      await client.hincrby(redisKey, "strategies_real_total", mainSets.length)    // how many Main sets were evaluated
      await client.hincrby(redisKey, "strategy_evaluated_real", realSets.length)  // how many passed to Real
      await client.expire(redisKey, 7 * 24 * 60 * 60)
    } catch { /* non-critical */ }

    console.log(
      `[v0] [StrategyFlow] ${symbol} REAL: ${realSets.length}/${mainSets.length} Sets promoted (minPF=${metrics.minProfitFactor}, conf=${metrics.confidence})`
    )

    return {
      type: "real",
      symbol,
      timestamp: new Date(),
      totalCreated: mainSets.length,
      passedEvaluation: realSets.length,
      failedEvaluation: mainSets.length - realSets.length,
      avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
      avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
    }
  }

  // ─── STAGE 4: LIVE ───────────────────────────────────────────────────────────

  /**
   * Select the best 500 Sets from REAL for live trading.
   * Creates exactly ONE pseudo position per Set (per indication_type × direction).
   */
  private async createLiveSets(symbol: string): Promise<StrategyEvaluation> {
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    const stored = await getSettings(realKey)
    const realSets: StrategySet[] = stored?.sets || []

    const metrics = this.METRICS.live
    const maxLive = this.config.maxLiveSets || 500

    // Filter by LIVE thresholds then rank by avgProfitFactor, take top N
    const qualifying = realSets
      .filter(
        (s) =>
          s.avgProfitFactor >= metrics.minProfitFactor &&
          s.avgDrawdownTime <= metrics.maxDrawdownTime &&
          s.avgConfidence >= metrics.confidence
      )
      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      .slice(0, maxLive)

    // Persist LIVE sets
    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    await setSettings(liveKey, {
      sets: qualifying,
      count: qualifying.length,
      created: new Date(),
      executable: true,
    })

    // Write live set count into progression hash — track how many Real sets were promoted to Live
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    //       Here we only write the live-specific counter to avoid double-counting.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      if (qualifying.length > 0) {
        await client.hincrby(redisKey, "strategies_live_total", qualifying.length)
        await client.expire(redisKey, 7 * 24 * 60 * 60)
      }
    } catch { /* non-critical */ }

    // Create EXACTLY ONE pseudo position per Set (one per indication_type × direction combination).
    // Each Set represents a unique (indication_type × direction) coordinate.
    // We pick the highest-profitFactor entry from the Set as the representative config for the position.
    if (qualifying.length > 0) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)

        // Fetch current market price for entry
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
        } catch { /* skip price lookup */ }

        if (entryPrice > 0) {
          let positionsCreated = 0
          for (const set of qualifying) {
            try {
              // Pick the best-performing entry from this Set as the representative config.
              // "Best" = highest profitFactor (already sorted by pruneEntries).
              const bestEntry = set.entries.reduce(
                (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                set.entries[0]
              )
              if (!bestEntry) continue

              const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
              const sl = Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)
              const trailing = bestEntry.confidence >= 0.85

              // configSetKey identifies this unique Set (indication_type × direction).
              // One active pseudo position per Set is enforced inside createPosition.
              const configSetKey = `${set.indicationType}:${set.direction}:${symbol}`

              const posId = await posManager.createPosition({
                symbol,
                side: set.direction,
                indicationType: set.indicationType,
                entryPrice,
                takeprofitFactor: tp,
                stoplossRatio: sl,
                profitFactor: bestEntry.profitFactor,
                trailingEnabled: trailing,
                configSetKey,
              })
              if (posId) positionsCreated++
            } catch { /* non-critical per-Set error */ }
          }
          console.log(`[v0] [StrategyFlow] ${symbol} LIVE: Created/updated ${positionsCreated} pseudo positions for ${qualifying.length} Sets`)
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price, skipping position creation`)
        }
      } catch (posErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posErr instanceof Error ? posErr.message : String(posErr))
      }
    }

    console.log(
      `[v0] [StrategyFlow] ${symbol} LIVE: ${qualifying.length}/${realSets.length} Sets selected (top ${maxLive} by PF, minPF=${metrics.minProfitFactor})`
    )

    return {
      type: "live",
      symbol,
      timestamp: new Date(),
      totalCreated: realSets.length,
      passedEvaluation: qualifying.length,
      failedEvaluation: realSets.length - qualifying.length,
      avgProfitFactor: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgProfitFactor, 0) / qualifying.length : 0,
      avgDrawdownTime: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgDrawdownTime, 0) / qualifying.length : 0,
    }
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  /**
   * Enforce max entries per Set using hybrid pruning (keep highest PF first, recent bonus).
   */
  private pruneEntries(entries: StrategySetEntry[], max: number): StrategySetEntry[] {
    if (entries.length <= max) return entries
    // Performance-based: keep top PF entries
    return entries
      .sort((a, b) => b.profitFactor - a.profitFactor)
      .slice(0, max)
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map((r) => ({
        type: r.type,
        sets: r.passedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
      })),
      totalLiveSets: results.find((r) => r.type === "live")?.passedEvaluation || 0,
    }

    try {
      await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Strategy Sets flow: ${symbol}`, summary)
    } catch { /* non-critical */ }
  }
}
