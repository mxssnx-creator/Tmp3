/**
 * Independent Strategy Sets Processor
 * Maintains separate 500-entry pools for each strategy calculation type
 * Each type evaluates independently with own set configurations
 */

import { getRedisClient, initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitStrategyUpdate } from "@/lib/broadcast-helpers"

// Pre-cached client reference
let cachedClient: any = null
async function getCachedClient() {
  if (!cachedClient) {
    await initRedis()
    cachedClient = getRedisClient()
  }
  return cachedClient
}

// Default limits per strategy type (independently configurable)
const DEFAULT_LIMITS = {
  base: 900,
  main: 300,
  real: 120,
  live: 500,
}

export interface StrategySetLimits {
  base: number
  main: number
  real: number
  live: number
}

export interface StrategySet {
  type: "base" | "main" | "real" | "live"
  connectionId: string
  symbol: string
  entries: Array<{
    id: string
    timestamp: Date
    profitFactor: number
    confidence: number
    config: any
    metadata: any
  }>
  maxEntries: number // Configurable per type, default 500
  stats: {
    totalCalculated: number
    totalQualified: number
    avgProfitFactor: number
    lastCalculated: Date | null
  }
}

export class StrategySetsProcessor {
  private connectionId: string
  private limits: StrategySetLimits = { ...DEFAULT_LIMITS }

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await getSettings("strategy_sets_config")
      if (settings) {
        // Load independent limits per type
        if (settings.base) this.limits.base = Number(settings.base)
        if (settings.main) this.limits.main = Number(settings.main)
        if (settings.real) this.limits.real = Number(settings.real)
        if (settings.live) this.limits.live = Number(settings.live)
        // Fallback: legacy maxEntriesPerSet applies weighted by type.
        if (settings.maxEntriesPerSet && !settings.base) {
          const limit = Number(settings.maxEntriesPerSet)
          this.limits = {
            base: Math.max(300, Math.round(limit * 1.8)),
            main: Math.max(120, Math.round(limit * 0.8)),
            real: Math.max(60, Math.round(limit * 0.35)),
            live: Math.max(120, limit),
          }
        }
      }
    } catch (error) {
      console.error("[v0] [StrategySets] Failed to load settings:", error)
    }
  }

  /** Get the limit for a specific strategy type */
  getLimit(type: keyof StrategySetLimits): number {
    return this.limits[type] || DEFAULT_LIMITS[type] || 500
  }

  /**
   * Process all strategy types independently for a symbol
   */
  async processAllStrategySets(symbol: string, indications: any[]): Promise<void> {
    try {
      const startTime = Date.now()

      // Sort indications by profitFactor descending so that the best-performing
      // signals are processed first across all strategy type pools.
      const sortedIndications = [...indications].sort(
        (a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0)
      )

      // Process all 4 strategy types in parallel with independent logic
      const [baseResults, mainResults, realResults, liveResults] = await Promise.all([
        this.processBaseStrategySet(symbol, sortedIndications),
        this.processMainStrategySet(symbol, sortedIndications),
        this.processRealStrategySet(symbol, sortedIndications),
        this.processLiveStrategySet(symbol, sortedIndications),
      ])

      const duration = Date.now() - startTime
      const totalQualified =
        (baseResults?.qualified || 0) +
        (mainResults?.qualified || 0) +
        (realResults?.qualified || 0) +
        (liveResults?.qualified || 0)

      if (totalQualified > 0) {
        console.log(
          `[v0] [StrategySets] ${symbol}: All types evaluated in ${duration}ms | Base=${baseResults?.qualified}/${baseResults?.total} Main=${mainResults?.qualified}/${mainResults?.total} Real=${realResults?.qualified}/${realResults?.total} Live=${liveResults?.qualified}/${liveResults?.total}`
        )

        await logProgressionEvent(this.connectionId, "strategies_sets", "info", `All strategy types evaluated for ${symbol}`, {
          base: baseResults,
          main: mainResults,
          real: realResults,
          live: liveResults,
          duration,
        })
      }
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to process sets for ${symbol}:`, error)
    }
  }

  /**
   * Base Strategy Set - Conservative, low-risk signals only
   */
  private async processBaseStrategySet(symbol: string, indications: any[]): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:base`
    let qualified = 0
    let total = 0

    for (const indication of indications) {
      try {
        total++
        // Base: broad intake (must be much higher volume than main/real)
        if (indication.confidence > 0.45 && indication.profitFactor > 0.9) {
          const strategy = {
            profitFactor: indication.profitFactor * 0.95,
            confidence: indication.confidence,
            metadata: { ...indication.metadata, strategyType: "base", riskLevel: "low" },
          }

          if (strategy.profitFactor >= 1.0) {
            qualified++
            await this.saveStrategyToSet(setKey, strategy, "base", indication.type)
          }
        }
      } catch (error) {
        console.error(`[v0] [StrategySets] Base strategy error:`, error)
      }
    }

    return { type: "base", total, qualified }
  }

  /**
   * Main Strategy Set - Balanced, medium-risk signals
   */
  private async processMainStrategySet(symbol: string, indications: any[]): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:main`
    let qualified = 0
    let total = 0

    for (const indication of indications) {
      try {
        total++
        // Main: stricter than base
        if (indication.confidence > 0.62 && indication.profitFactor > 1.2) {
          const strategy = {
            profitFactor: indication.profitFactor,
            confidence: indication.confidence,
            metadata: { ...indication.metadata, strategyType: "main", riskLevel: "medium" },
          }

          if (strategy.profitFactor >= 1.0) {
            qualified++
            await this.saveStrategyToSet(setKey, strategy, "main", indication.type)
          }
        }
      } catch (error) {
        console.error(`[v0] [StrategySets] Main strategy error:`, error)
      }
    }

    return { type: "main", total, qualified }
  }

  /**
   * Real Strategy Set - Aggressive, higher-risk signals
   */
  private async processRealStrategySet(symbol: string, indications: any[]): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:real`
    let qualified = 0
    let total = 0

    for (const indication of indications) {
      try {
        total++
        // Real: strictest (must remain less than main volume)
        if (indication.confidence > 0.78 && indication.profitFactor > 1.45) {
          const strategy = {
            profitFactor: indication.profitFactor * 1.1, // Aggressive multiplier
            confidence: indication.confidence,
            metadata: { ...indication.metadata, strategyType: "real", riskLevel: "high" },
          }

          if (strategy.profitFactor >= 1.0) {
            qualified++
            await this.saveStrategyToSet(setKey, strategy, "real", indication.type)
          }
        }
      } catch (error) {
        console.error(`[v0] [StrategySets] Real strategy error:`, error)
      }
    }

    return { type: "real", total, qualified }
  }

  /**
   * Live Strategy Set - All qualifying signals, real-time only
   */
  private async processLiveStrategySet(symbol: string, indications: any[]): Promise<any> {
    const setKey = `strategy_set:${this.connectionId}:${symbol}:live`
    let qualified = 0
    let total = 0

    for (const indication of indications) {
      try {
        total++
        // Live: All indications with any positive profit factor
        if (indication.profitFactor >= 1.0) {
          const strategy = {
            profitFactor: indication.profitFactor,
            confidence: indication.confidence,
            metadata: { ...indication.metadata, strategyType: "live", riskLevel: "variable" },
          }

          qualified++
          await this.saveStrategyToSet(setKey, strategy, "live", indication.type)
        }
      } catch (error) {
        console.error(`[v0] [StrategySets] Live strategy error:`, error)
      }
    }

    return { type: "live", total, qualified }
  }

  /**
   * Save strategy to its independent set pool (max 250 entries)
   */
  private async saveStrategyToSet(
    setKey: string,
    strategy: any,
    strategyType: string,
    indicationType: string
  ): Promise<void> {
    try {
      const client = await getCachedClient()
      let entries: any[] = []

      const existing = await client.get(setKey)
      if (existing) {
        try {
          entries = JSON.parse(existing)
        } catch {
          entries = []
        }
      }

      // Add new strategy
      entries.push({
        id: `${strategyType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        profitFactor: strategy.profitFactor,
        confidence: strategy.confidence,
        indicationType,
        strategyType,
        metadata: strategy.metadata,
      })

      // Get limit for this strategy type
      const maxEntries = this.getLimit(strategyType as keyof StrategySetLimits)

      // Sort by profitFactor descending so the best-performing entries are always
      // processed first and retained when the pool is trimmed.
      entries.sort((a: any, b: any) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))

      // Trim to max entries — lowest-PF entries are dropped first
      if (entries.length > maxEntries) {
        entries = entries.slice(0, maxEntries)
      }

      // Save back
      await client.set(setKey, JSON.stringify(entries))

      // Update stats
      const statsKey = `${setKey}:stats`
      const prevStats = (await getSettings(statsKey)) || {}
      const stats = {
        maxEntries: maxEntries,
        currentEntries: entries.length,
        totalCalculated: (prevStats.totalCalculated || 0) + 1,
        totalQualified: (prevStats.totalQualified || 0) + 1,
        avgProfitFactor: entries.reduce((sum: number, e: any) => sum + e.profitFactor, 0) / entries.length,
        lastCalculated: new Date().toISOString(),
      }
      await setSettings(statsKey, stats)

      // Broadcast strategy update to connected clients
      emitStrategyUpdate(this.connectionId, {
        id: entries[0].id,
        symbol: setKey.split(':')[2], // Extract symbol from setKey
        profit_factor: strategy.profitFactor || 0,
        win_rate: strategy.confidence || 0,
        active_positions: entries.length,
      })
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to save to ${setKey}:`, error)
    }
  }

  /**
   * Get stats for a specific strategy type set
   */
  async getSetStats(symbol: string, type: string): Promise<any> {
    try {
      const setKey = `strategy_set:${this.connectionId}:${symbol}:${type}:stats`
      return await getSettings(setKey)
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get stats for ${type}:`, error)
      return null
    }
  }

  /**
   * Get all entries from a specific strategy type set
   */
  async getSetEntries(symbol: string, type: string, limit = 50): Promise<any[]> {
    try {
      const client = await getCachedClient()
      const setKey = `strategy_set:${this.connectionId}:${symbol}:${type}`
      const data = await client.get(setKey)

      if (!data) return []

      const entries: any[] = JSON.parse(data)
      // Always return in best-performance-first order
      entries.sort((a: any, b: any) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))
      return entries.slice(0, limit)
    } catch (error) {
      console.error(`[v0] [StrategySets] Failed to get entries for ${type}:`, error)
      return []
    }
  }
}
