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
  private readonly PF_LIVE_MIN = 1.4    // Real sets must have avgPF >= 1.4 to enter LIVE

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
      maxDrawdownTime: 120,   // 2 hours — realistic for current strategy output
      minProfitFactor: 1.4,   // Match REAL stage minimum so Sets can flow through
      confidence: 0.65,       // Match REAL stage confidence floor
      description: "Best 500 Sets ready for real trading (PF≥1.4, conf≥0.65)",
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
      // Sets flow BASE → MAIN → REAL → LIVE. Each stage used to re-read its
      // predecessor's output from Redis via getSettings(); we now pipe the
      // computed arrays directly between stages in memory to eliminate 3
      // Redis round-trips per symbol per cycle. Each stage still persists
      // its own output to Redis for downstream consumers (stats API, dashboard).
      //
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const { result: baseResult, sets: baseSets } = await this.createBaseSets(symbol, indications)
      results.push(baseResult)

      // STAGE 2: MAIN — promote Sets with avgPF >= 1.2, expand config entries
      const { result: mainResult, sets: mainSets } = await this.createMainSets(symbol, baseSets)
      results.push(mainResult)

      // STAGE 3: REAL — promote Sets with avgPF >= 1.4
      const { result: realResult, sets: realSets } = await this.evaluateRealSets(symbol, mainSets)
      results.push(realResult)

      // STAGE 4: LIVE — best 500 Sets for execution (skip in prehistoric mode)
      if (!isPrehistoric) {
        const { result: liveResult } = await this.createLiveSets(symbol, realSets)
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
  private async createBaseSets(
    symbol: string,
    indications: any[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
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
        // Always parse as numbers — indication fields may arrive as strings from Redis hgetall
        const rawConf = parseFloat(String(ind.confidence ?? 0.5))
        const conf = Number.isFinite(rawConf) ? rawConf : 0.5
        const rawPF = parseFloat(String(ind.profitFactor ?? ind.profit_factor ?? 0))
        const pfFromPF = Number.isFinite(rawPF) && rawPF > 0 ? rawPF : conf * 2
        const pf = pfFromPF
        if (pf < this.PF_BASE_MIN) continue

        entries.push({
          id: `${setKey}-${entryIdx}`,
          sizeMultiplier: 1.0,
          leverage: 1,
          positionState: "new",
          profitFactor: pf,
          drawdownTime: 0,
          confidence: conf,
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

    // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts.
    // CRITICAL: Use hincrby (cumulative) not hset (snapshot). Previously each cycle overwrote the
    // value with the current cycle's count, which made the dashboard oscillate between high/low
    // values every few seconds ("jumping more and less"). The per-cycle snapshot is still
    // available in `strategy_detail:{connId}:base` (`created_sets` field).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const detailKey  = `strategy_detail:${this.connectionId}:base`
      const baseAvgPF  = baseSets.length > 0 ? baseSets.reduce((s, st) => s + st.avgProfitFactor, 0) / baseSets.length : 0
      const baseAvgDDT = baseSets.length > 0 ? baseSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / baseSets.length : 0

      // Fan-out all independent writes. The awaited chain used to add ~8 Redis
      // round-trips to every BASE cycle even when nothing had changed; issuing
      // them concurrently cuts that to a single bounded round-trip window.
      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_base_current", String(baseSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(detailKey, {
          created_sets:      String(baseSets.length),
          avg_profit_factor: String(baseAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(baseAvgDDT)),
          evaluated:         String(baseSets.length),
          passed_sets:       "0",   // will be updated by createMainSets
          updated_at:        String(Date.now()),
        }),
        client.expire(detailKey, 86400),
        client.set(`strategies:${this.connectionId}:base:count`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:evaluated`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:base:count`, 86400),
        client.expire(`strategies:${this.connectionId}:base:evaluated`, 86400),
      ]
      if (baseSets.length > 0) {
        writes.push(client.hincrby(redisKey, "strategies_base_total", baseSets.length))
        writes.push(client.hincrby(redisKey, "strategies_base_evaluated", baseSets.length))
      }
      await Promise.all(writes)
    } catch { /* non-critical */ }

    console.log(`[v0] [StrategyFlow] ${symbol} BASE: ${baseSets.length} Sets created (${baseSets.reduce((s, set) => s + set.entryCount, 0)} total entries)`)

    return {
      result: {
        type: "base",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: baseSets.length,
        failedEvaluation: 0,
        avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
        avgDrawdownTime: 0,
      },
      sets: baseSets,
    }
  }

  // ─── STAGE 2: MAIN ───────────────────────────────────────────────────────────

  /**
   * Promote BASE Sets with avgProfitFactor >= 1.2 to MAIN.
   * Expand each Set with multiple position-size / leverage variants (max 250 entries).
   */
  private async createMainSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Prefer in-memory input (hot-path pipelined from createBaseSets). Fall
    // back to Redis only when called standalone (tests / diagnostics).
    let baseSets: StrategySet[]
    if (inputSets) {
      baseSets = inputSets
    } else {
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      const stored = await getSettings(baseKey)
      baseSets = stored?.sets || []
    }

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

      const avgPF   = cappedEntries.reduce((s, e) => s + Number(e.profitFactor  || 0), 0) / cappedEntries.length
      const avgConf = cappedEntries.reduce((s, e) => s + Number(e.confidence    || 0), 0) / cappedEntries.length
      const avgDDT  = cappedEntries.reduce((s, e) => s + Number(e.drawdownTime  || 0), 0) / cappedEntries.length

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

    // Write Main counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // does not oscillate with per-cycle snapshots (see matching fix in createBaseSets).
    // Per-cycle snapshot is kept in `strategies_main_current` for components that want it.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const mainDetailKey = `strategy_detail:${this.connectionId}:main`
      const mainAvgPF  = mainSets.length > 0 ? mainSets.reduce((s, st) => s + st.avgProfitFactor, 0) / mainSets.length : 0
      const mainAvgDDT = mainSets.length > 0 ? mainSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / mainSets.length : 0
      const passRatioMain = baseSets.length > 0 ? mainSets.length / baseSets.length : 0

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_main_current", String(mainSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(mainDetailKey, {
          created_sets:      String(mainSets.length),
          avg_profit_factor: String(mainAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(mainAvgDDT)),
          evaluated:         String(baseSets.length),
          passed_sets:       String(mainSets.length),
          pass_rate:         String(passRatioMain.toFixed(4)),
          updated_at:        String(Date.now()),
        }),
        client.expire(mainDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:base`, {
          passed_sets: String(mainSets.length),
          pass_rate:   String(passRatioMain.toFixed(4)),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:main:count`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:evaluated`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:passed`, String(mainSets.length)),
        client.expire(`strategies:${this.connectionId}:main:count`, 86400),
        client.expire(`strategies:${this.connectionId}:main:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:base:passed`, 86400),
      ]
      if (baseSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_total", baseSets.length))
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_evaluated", mainSets.length))
      await Promise.all(writes)
    } catch { /* non-critical */ }

    const failed = baseSets.length - mainSets.length
    if (baseSets.length > 0) {
      const sample = baseSets[0]
      console.log(`[v0] [StrategyFlow] ${symbol} MAIN: ${mainSets.length}/${baseSets.length} promoted (minPF=${metrics.minProfitFactor}) | sample={pf=${sample.avgProfitFactor.toFixed(2)}, conf=${sample.avgConfidence.toFixed(2)}}`)
    } else {
      console.log(`[v0] [StrategyFlow] ${symbol} MAIN: 0 base sets available`)
    }

    return {
      result: {
        type: "main",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: mainSets.length,
        failedEvaluation: failed,
        avgProfitFactor: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgProfitFactor, 0) / mainSets.length : 0,
        avgDrawdownTime: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / mainSets.length : 0,
      },
      sets: mainSets,
    }
  }

  // ─── STAGE 3: REAL ───────────────────────────────────────────────────────────

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let stored: any = null
    if (!inputSets) {
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      stored = await getSettings(mainKey)
    }
    const mainSets: StrategySet[] = inputSets ?? (stored?.sets || [])

    const metrics = this.METRICS.real

    const realSets = mainSets.filter(
      (s) =>
        s.avgProfitFactor >= metrics.minProfitFactor &&
        s.avgDrawdownTime <= metrics.maxDrawdownTime &&
        s.avgConfidence >= metrics.confidence
    )

    // Debug: show why sets failed REAL filter
    if (mainSets.length > 0 && realSets.length === 0) {
      const sample = mainSets[0]
      console.log(`[v0] [StrategyFlow] ${symbol} REAL filter rejected all: sample={pf=${sample.avgProfitFactor.toFixed(2)}, conf=${sample.avgConfidence.toFixed(2)}, ddt=${sample.avgDrawdownTime.toFixed(0)}} threshold={minPF=${metrics.minProfitFactor}, conf=${metrics.confidence}, maxDDT=${metrics.maxDrawdownTime}}`)
    }

    // Persist REAL sets
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    await setSettings(realKey, { sets: realSets, count: realSets.length, created: new Date() })

    // Write Real counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // doesn't oscillate with per-cycle snapshots (see matching fix in createBaseSets/createMainSets).
    // Per-cycle snapshot is kept in `strategies_real_current` for components that want it.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const realDetailKey = `strategy_detail:${this.connectionId}:real`
      const realAvgPF   = realSets.length > 0 ? realSets.reduce((s, st) => s + st.avgProfitFactor, 0) / realSets.length : 0
      const realAvgDDT  = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / realSets.length : 0
      const realAvgConf = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgConfidence || 0), 0) / realSets.length : 0
      const passRatioReal = mainSets.length > 0 ? realSets.length / mainSets.length : 0

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_real_current", String(realSets.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(realDetailKey, {
          created_sets:       String(realSets.length),
          avg_profit_factor:  String(realAvgPF.toFixed(4)),
          avg_drawdown_time:  String(Math.round(realAvgDDT)),
          avg_pos_eval_real:  String(realAvgConf.toFixed(4)),
          evaluated:          String(mainSets.length),
          passed_sets:        String(realSets.length),
          pass_rate:          String(passRatioReal.toFixed(4)),
          count_pos_eval:     String(realSets.length),
          updated_at:         String(Date.now()),
        }),
        client.expire(realDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:main`, {
          passed_sets: String(realSets.length),
          pass_rate:   String(passRatioReal.toFixed(4)),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:real:count`, String(realSets.length)),
        client.set(`strategies:${this.connectionId}:real:evaluated`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:passed`, String(realSets.length)),
        client.expire(`strategies:${this.connectionId}:real:count`, 86400),
        client.expire(`strategies:${this.connectionId}:real:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:main:passed`, 86400),
      ]
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_total", mainSets.length))
      if (realSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_evaluated", realSets.length))
      await Promise.all(writes)
    } catch { /* non-critical */ }

    console.log(
      `[v0] [StrategyFlow] ${symbol} REAL: ${realSets.length}/${mainSets.length} Sets promoted (minPF=${metrics.minProfitFactor}, conf=${metrics.confidence})`
    )

    return {
      result: {
        type: "real",
        symbol,
        timestamp: new Date(),
        totalCreated: mainSets.length,
        passedEvaluation: realSets.length,
        failedEvaluation: mainSets.length - realSets.length,
        avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
        avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
      },
      sets: realSets,
    }
  }

  // ─── STAGE 4: LIVE ────────────────────��──────��───────────────────────────────

  /**
   * Select the best 500 Sets from REAL for live trading.
   * Creates exactly ONE pseudo position per Set (per indication_type × direction).
   */
  private async createLiveSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let realSets: StrategySet[]
    if (inputSets) {
      realSets = inputSets
    } else {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      const stored = await getSettings(realKey)
      realSets = stored?.sets || []
    }

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

    console.log(`[v0] [StrategyFlow] ${symbol} LIVE: ${qualifying.length}/${realSets.length} Sets selected (top ${maxLive} by PF, minPF=${metrics.minProfitFactor}, minConf=${metrics.confidence}, maxDDT=${metrics.maxDrawdownTime})`)
    if (realSets.length > 0 && qualifying.length === 0) {
      const sample = realSets[0]
      console.log(`[v0] [StrategyFlow] ${symbol} LIVE filter rejected all real sets: sample={pf=${sample.avgProfitFactor.toFixed(2)}, conf=${sample.avgConfidence.toFixed(2)}, ddt=${sample.avgDrawdownTime.toFixed(0)}}`)
    }

    // Persist LIVE sets
    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    await setSettings(liveKey, {
      sets: qualifying,
      count: qualifying.length,
      created: new Date(),
      executable: true,
    })

    // Write live set count into progression hash — use hset so count reflects current cycle snapshot.
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    // Previously this block fired 7 sequential Redis round-trips (hset × 2, set, expire × 3, + a
    // compound hset). Parallelising them cuts the per-cycle Redis stall to a single network hop
    // worth of latency, matching the base/main/real coordinators.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const liveDetailKey = `strategy_detail:${this.connectionId}:live`
      const liveCountKey = `strategies:${this.connectionId}:live:count`

      const liveAvgPF  = qualifying.length > 0 ? qualifying.reduce((s, st) => s + st.avgProfitFactor, 0) / qualifying.length : 0
      const liveAvgDDT = qualifying.length > 0 ? qualifying.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / qualifying.length : 0
      const passRatioLive = realSets.length > 0 ? qualifying.length / realSets.length : 0

      await Promise.all([
        client.hset(redisKey, "strategies_live_total", String(qualifying.length)),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(liveDetailKey, {
          created_sets:      String(qualifying.length),
          avg_profit_factor: String(liveAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(liveAvgDDT)),
          evaluated:         String(realSets.length),
          passed_sets:       String(qualifying.length),
          pass_rate:         String(passRatioLive.toFixed(4)),
          updated_at:        String(Date.now()),
        }),
        client.expire(liveDetailKey, 86400),
        // `set` with EX in a single command avoids the separate expire round-trip.
        client.set(liveCountKey, String(qualifying.length), { EX: 86400 } as any),
      ])
    } catch { /* non-critical */ }

    // Attempt real exchange trading for qualifying LIVE sets when the connection has live trading enabled.
    // This is guarded by is_live_trade flag on the connection — if disabled, only pseudo positions are created.
    if (qualifying.length > 0) {
      try {
        // Use getConnection() as authoritative source — it reads connection:{id} hash via parseHash
        // which handles boolean/string coercion. Raw hgetall may miss "true" vs "1" vs boolean true.
        const { getConnection: getConn } = await import("@/lib/redis-db")
        const connData = await getConn(this.connectionId)
        const { isTruthyFlag } = await import("@/lib/connection-state-utils")
        const isLiveTrade = isTruthyFlag(connData?.is_live_trade) || isTruthyFlag(connData?.live_trade_enabled)
        console.log(`[v0] [StrategyFlow] ${symbol} LIVE gate: is_live_trade=${isLiveTrade} (raw=${JSON.stringify(connData?.is_live_trade)}, conn=${this.connectionId})`)
        if (isLiveTrade) {
          const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
          if (connector) {
            // Dispatch each qualifying set as a live exchange position. The
            // full pipeline (pre-flight → price fetch → volume calc → leverage
            // setup → entry order → fill poll → SL/TP → exchange sync → logs
            // → metrics) is owned by executeLivePosition. We only supply the
            // strategic inputs (direction, SL/TP %, leverage hint) and let the
            // pipeline decide the exact quantity and entry price from live
            // exchange state.
            let placed = 0
            let filled = 0
            let rejected = 0
            let errored = 0

            for (const set of qualifying) {
              try {
                const bestEntry = set.entries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  set.entries[0]
                )
                if (!bestEntry) continue

                // Derive SL/TP % from the set's profit factor. The pipeline
                // converts these to concrete prices after the entry fills.
                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, (100 / Math.max(1, bestEntry.profitFactor)) * 0.5)

                const liveResult = await executeLivePosition(
                  this.connectionId,
                  {
                    id: `real:${this.connectionId}:${set.setKey}:${symbol}:${Date.now()}`,
                    connectionId: this.connectionId,
                    symbol,
                    direction: set.direction,
                    // Seed values — the live pipeline will recalc both from
                    // the exchange connector and VolumeCalculator.
                    quantity: 0,
                    entryPrice: 0,
                    leverage: bestEntry.leverage || 1,
                    riskAmount: 0,
                    rewardTarget: 0,
                    stopLoss: sl,
                    takeProfit: tp,
                    mainPositionCount: set.entryCount,
                    evaluationScore: bestEntry.confidence,
                    ratioMet: bestEntry.confidence >= 0.65,
                    timestamp: Date.now(),
                    ratios: {
                      profitabilityRatio: bestEntry.profitFactor,
                      accountRiskRatio: sl / 100,
                      successRateRatio: bestEntry.confidence,
                      consistencyRatio: set.avgConfidence,
                    },
                    status: "pending",
                  },
                  connector
                )

                if (!liveResult) continue
                if (liveResult.status === "open" || liveResult.status === "filled" || liveResult.status === "partially_filled") {
                  filled++
                  placed++
                } else if (liveResult.status === "placed") {
                  placed++
                } else if (liveResult.status === "rejected") {
                  rejected++
                } else if (liveResult.status === "error") {
                  errored++
                }
              } catch (err) {
                errored++
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} per-set live execution error:`,
                  err instanceof Error ? err.message : String(err)
                )
              }
            }

            if (placed > 0 || rejected > 0 || errored > 0) {
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored}`
              )
            }
          } else {
            console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: live_trade=true but connector not available`)
          }
        }
      } catch (liveErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Real exchange execution error:`, liveErr instanceof Error ? liveErr.message : String(liveErr))
      }

      // After dispatching new entries, reconcile already-open positions with
      // the exchange so that any SL/TP/manual-close that happened since the
      // last cycle transitions the Redis record to "closed". Rate-limited per
      // connection to once every 30 seconds to stay well within exchange
      // rate limits while still providing near-real-time closure tracking.
      try {
        const client = getRedisClient()
        const rlKey = `live:reconcile:ratelimit:${this.connectionId}`
        const last = await client.get(rlKey).catch(() => null)
        const now = Date.now()
        const lastTs = last ? parseInt(last as string, 10) : 0
        if (!lastTs || now - lastTs > 30_000) {
          await client.setex(rlKey, 60, String(now)).catch(() => {})
          // Fire-and-forget: don't block the strategy flow on exchange IO.
          ;(async () => {
            try {
              const { reconcileLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
              const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
              const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
              if (connector) {
                const result = await reconcileLivePositions(this.connectionId, connector)
                if (result.closed > 0) {
                  console.log(
                    `[v0] [StrategyFlow] ${this.connectionId} reconcile closed ${result.closed} positions via exchange sync`
                  )
                }
              }
            } catch (reconErr) {
              console.warn(
                `[v0] [StrategyFlow] ${this.connectionId} reconcile error:`,
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              )
            }
          })()
        }
      } catch {
        /* non-critical; skip if redis rate-limit read fails */
      }
    }

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
          // Pseudo-position creation is local Redis work with per-Set idempotency
          // enforced inside createPosition (one active pseudo position per Set).
          // Safe to fan out in parallel — no exchange calls, no shared balance.
          const creations = await Promise.all(
            qualifying.map(async (set) => {
              try {
                const bestEntry = set.entries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  set.entries[0],
                )
                if (!bestEntry) return false

                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)
                const trailing = bestEntry.confidence >= 0.85
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
                return Boolean(posId)
              } catch {
                return false
              }
            }),
          )
          const positionsCreated = creations.filter(Boolean).length
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
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: realSets.length,
        passedEvaluation: qualifying.length,
        failedEvaluation: realSets.length - qualifying.length,
        avgProfitFactor: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgProfitFactor, 0) / qualifying.length : 0,
        avgDrawdownTime: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgDrawdownTime, 0) / qualifying.length : 0,
      },
      sets: qualifying,
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
