import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? x : 0
}

function pick(...values: unknown[]): number {
  for (const v of values) {
    const x = n(v)
    if (x > 0) return x
  }
  return 0
}

/**
 * GET /api/connections/progression/[id]/stats
 *
 * Canonical statistics endpoint consumed by all dashboard UIs.
 * Reads from three dedicated Redis namespaces so historic vs realtime
 * processing metrics are always cleanly separated:
 *
 *   prehistoric:{connId}              – written by trackPrehistoricStats()
 *   realtime:{connId}                 – written by trackRealtimeCycle()
 *   progression:{connId}              – written every cycle by ProgressionStateManager
 *                                       and statistics-tracker (hincrby)
 *
 * Falls back to trade_engine_state:{connId} (flushed every 50-100 cycles)
 * only when the primary sources return zero.
 *
 * Response shape:
 * {
 *   historic: { symbolsProcessed, symbolsTotal, candlesLoaded, indicatorsCalculated,
 *               cyclesCompleted, isComplete, progressPercent }
 *   realtime: { indicationCycles, strategyCycles, realtimeCycles, indicationsTotal,
 *               strategiesTotal, positionsOpen, isActive, successRate, avgCycleTimeMs }
 *   breakdown: {
 *     indications: { direction, move, active, optimal, auto, total }
 *     strategies:  { base, main, real, live, total,
 *                    baseEvaluated, mainEvaluated, realEvaluated }
 *   }
 *   metadata: { engineRunning, phase, progress, message, lastUpdate, redisDbEntries }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: connectionId } = await params

    await initRedis()
    const client = getRedisClient()
    if (!client) {
      return NextResponse.json({ error: "Redis not available" }, { status: 503 })
    }

    // ── Read all namespaces in parallel ──────────────────────────────────────
    // NOTE: hgetall returns null (not throws) when the key doesn't exist — always coerce to {}
    const [
      progHashRaw,
      prehistoricHashRaw,
      realtimeHashRaw,
      engineState,
      engineProgression,
      prehistoricSymbolCount,
    ] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => null),
      client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
      client.hgetall(`realtime:${connectionId}`).catch(() => null),
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`engine_progression:${connectionId}`).catch(() => ({})),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
    ])

    const progHash: Record<string, string>       = progHashRaw       || {}
    const prehistoricHash: Record<string, string> = prehistoricHashRaw || {}
    const realtimeHash: Record<string, string>   = realtimeHashRaw   || {}

    const es = (engineState as Record<string, any>) || {}
    const ep = (engineProgression as Record<string, any>) || {}

    // ── HISTORIC section ─────────────────────────────────────────────────────
    // Primary: prehistoric:{connId} hash (written by trackPrehistoricStats)
    // Secondary: progression hash mirror fields
    // Tertiary: trade_engine_state fields (config_set_*)
    const historicSymbolsProcessed = pick(
      n(prehistoricHash.symbols_processed),
      prehistoricSymbolCount,
      n(progHash.prehistoric_symbols_processed_count),
      n(es.config_set_symbols_processed)
    )
    const historicSymbolsTotal = Math.max(
      historicSymbolsProcessed,
      n(es.config_set_symbols_total) || 3   // default minimum of 3 if unknown
    )
    const historicCandlesLoaded = pick(
      n(prehistoricHash.candles_loaded),
      n(progHash.prehistoric_candles_processed),
      n(es.config_set_candles_processed)
    )
    const historicIndicatorsCalculated = pick(
      n(prehistoricHash.indicators_calculated),
      n(es.config_set_indication_results)
    )
    const historicCyclesCompleted = pick(
      n(progHash.prehistoric_cycles_completed),
      n(es.config_set_symbols_processed)
    )
    const historicIsComplete =
      prehistoricHash.is_complete === "1" ||
      progHash.prehistoric_phase_active === "false" && historicSymbolsProcessed > 0 ||
      es.prehistoric_data_loaded === true ||
      es.prehistoric_data_loaded === "1"
    const historicProgressPercent = historicIsComplete
      ? 100
      : historicSymbolsTotal > 0
        ? Math.min(99, Math.round((historicSymbolsProcessed / historicSymbolsTotal) * 100))
        : 0

    // ── REALTIME section ─────────────────────────────────────────────────────
    // Primary: realtime:{connId} hash (written by trackRealtimeCycle)
    // Secondary: progression hash (written by ProgressionStateManager.incrementCycle)
    // Tertiary: trade_engine_state
    const realtimeIndicationCycles = pick(
      n(progHash.indication_cycle_count),
      n(realtimeHash.cycle_count),        // realtime hash may double-count with indication, use prog hash first
      n(es.indication_cycle_count)
    )
    const realtimeStrategyCycles = pick(
      n(progHash.strategy_cycle_count),
      n(es.strategy_cycle_count)
    )
    const realtimeCycles = pick(
      n(progHash.realtime_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.realtime_cycle_count)
    )

    // Cycle time average from realtime hash
    const realtimeCycleTimeSum = n(realtimeHash.cycle_time_sum_ms)
    const realtimeCycleCount   = n(realtimeHash.cycle_count) || 1  // avoid div-by-zero
    const avgCycleTimeMs = realtimeCycleTimeSum > 0
      ? Math.round(realtimeCycleTimeSum / realtimeCycleCount)
      : n(es.last_cycle_duration)

    const successRate = parseFloat(progHash.cycle_success_rate || String(es.cycle_success_rate || "100"))

    // Total indications/strategies evaluated — prefer progression hash
    const indicationsTotal = pick(
      n(progHash.indications_count),
      n(realtimeHash.total_indications),
      n(es.total_indications_evaluated)
    )
    const strategiesTotal = pick(
      n(progHash.strategies_count),
      n(realtimeHash.total_strategies),
      n(es.total_strategies_evaluated)
    )

    // Open positions: check pseudo_positions:{connId} set
    let positionsOpen = 0
    try {
      const posIds = await client.smembers(`pseudo_positions:${connectionId}`).catch(() => [] as string[])
      for (const posId of posIds.slice(0, 200)) {
        const h = (await client.hgetall(`pseudo_position:${connectionId}:${posId}`).catch(() => null)) || {}
        if ((h as any)?.status === "active" || !(h as any)?.status) positionsOpen++
      }
    } catch { /* non-critical */ }

    const realtimeIsActive =
      realtimeIndicationCycles > 0 ||
      ep?.phase === "live_trading" ||
      ep?.phase === "realtime" ||
      es.status === "running"

    // ── BREAKDOWN section ────────────────────────────────��───────────────────
    // Indication per-type counts live in two places:
    //   1. progression hash: indications_{type}_count  (written by statistics-tracker hincrby)
    //   2. standalone key:   indications:{connId}:{type}:count  (also by statistics-tracker incr)
    // We read both and take the higher.

    const indTypes = ["direction", "move", "active", "optimal", "auto"] as const
    const indCounts: Record<string, number> = {}
    await Promise.all(
      indTypes.map(async (type) => {
        const fromHash  = n(progHash[`indications_${type}_count`])
        const fromKey   = n(await client.get(`indications:${connectionId}:${type}:count`).catch(() => 0))
        const fromEval  = n(await client.get(`indications:${connectionId}:${type}:evaluated`).catch(() => 0))
        indCounts[type] = Math.max(fromHash, fromKey, fromEval)
      })
    )
    const indTotal = Object.values(indCounts).reduce((s, v) => s + v, 0) || indicationsTotal

    // Strategy per-stage counts
    const stratTypes = ["base", "main", "real", "live"] as const
    const stratCounts: Record<string, number> = {}
    const stratEvaluated: Record<string, number> = {}
    await Promise.all(
      stratTypes.map(async (type) => {
        const fromHash  = n(progHash[`strategies_${type}_total`])
        const fromKey   = n(await client.get(`strategies:${connectionId}:${type}:count`).catch(() => 0))
        stratCounts[type] = Math.max(fromHash, fromKey)

        const evalFromHash = n(progHash[`strategies_${type}_evaluated`])
        const evalFromKey  = n(await client.get(`strategies:${connectionId}:${type}:evaluated`).catch(() => 0))
        stratEvaluated[type] = Math.max(evalFromHash, evalFromKey)
      })
    )
    const stratTotal = Object.values(stratCounts).reduce((s, v) => s + v, 0) || strategiesTotal

    // ── STRATEGY DETAIL fields ───────────────────────────────────────────────
    // Per-stage avg positions per set, created sets, avg profit factor, avg processing time
    // Written by strategy-processor as HSET strategy_detail:{connId}:{stage} ...
    const stratDetailKeys = ["base", "main", "real"] as const
    const stratDetail: Record<string, {
      avgPosPerSet: number; createdSets: number; avgProfitFactor: number; avgProcessingTimeMs: number
      evalPct: number
    }> = {}

    await Promise.all(
      stratDetailKeys.map(async (stage) => {
        const dh = ((await client.hgetall(`strategy_detail:${connectionId}:${stage}`).catch(() => null)) || {}) as Record<string, string>
        const createdSets       = n(dh.created_sets      || progHash[`strategy_${stage}_created_sets`])
        const avgPosPerSet      = parseFloat(dh.avg_pos_per_set      || progHash[`strategy_${stage}_avg_pos_per_set`]      || "0")
        const avgProfitFactor   = parseFloat(dh.avg_profit_factor    || progHash[`strategy_${stage}_avg_profit_factor`]    || "0")
        const avgProcessingMs   = parseFloat(dh.avg_processing_ms    || progHash[`strategy_${stage}_avg_processing_ms`]    || "0")
        // Average position evaluation score for Real stage (stored by strategy-coordinator)
        const avgPosEvalReal    = parseFloat(dh.avg_pos_eval_real    || progHash[`strategy_${stage}_avg_pos_eval_real`]    || "0")
        // Drawdown time (avg minutes from strategy sets)
        const avgDrawdownTime   = parseFloat(dh.avg_drawdown_time    || progHash[`strategy_${stage}_avg_drawdown_time`]    || "0")

        // Eval percentage: main = evaluated/base, real = evaluated/main
        let evalPct = 0
        if (stage === "main") {
          const base = stratCounts.base || 1
          evalPct = base > 0 ? Math.round((stratEvaluated.main / base) * 1000) / 10 : 0
        } else if (stage === "real") {
          const main = stratCounts.main || 1
          evalPct = main > 0 ? Math.round((stratEvaluated.real / main) * 1000) / 10 : 0
        }

        // Pass ratio = passed/evaluated for this stage
        const stageEvaluated = stratEvaluated[stage] || 0
        const stagePassed    = n(dh.passed_sets || progHash[`strategy_${stage}_passed`])
        const passRatio      = stageEvaluated > 0 ? Math.round((stagePassed / stageEvaluated) * 1000) / 10 : 0

        stratDetail[stage] = {
          avgPosPerSet:        isFinite(avgPosPerSet)    ? Math.round(avgPosPerSet * 100) / 100      : 0,
          createdSets,
          avgProfitFactor:     isFinite(avgProfitFactor) ? Math.round(avgProfitFactor * 1000) / 1000 : 0,
          avgProcessingTimeMs: isFinite(avgProcessingMs) ? Math.round(avgProcessingMs * 10) / 10     : 0,
          avgPosEvalReal:      isFinite(avgPosEvalReal)  ? Math.round(avgPosEvalReal * 1000) / 1000  : 0,
          avgDrawdownTime:     isFinite(avgDrawdownTime) ? Math.round(avgDrawdownTime * 10) / 10     : 0,
          evalPct,
          passRatio,
          evaluated: stageEvaluated,
          passed: stagePassed,
          failed: Math.max(0, stageEvaluated - stagePassed),
        }
      })
    )

    // --- Prehistoric metadata (range, timeframe, interval progress) ---
    const prehistoricMeta = {
      rangeStart:              prehistoricHash.range_start          || null,
      rangeEnd:                prehistoricHash.range_end            || null,
      rangeDays:               n(prehistoricHash.range_days)        || 1,
      timeframeSeconds:        n(prehistoricHash.timeframe_seconds) || 1,
      intervalsProcessed:      n(prehistoricHash.intervals_processed) || n(progHash.prehistoric_intervals_processed),
      missingIntervalsLoaded:  n(prehistoricHash.missing_intervals)   || n(progHash.prehistoric_missing_loaded),
      currentSymbol:           prehistoricHash.current_symbol         || progHash.prehistoric_current_symbol || "",
      isComplete:              prehistoricHash.is_complete === "1",
    }

    // ── WINDOW DATA (last 5min / 60min) ──────────────────────────────────────
    // Stored in sorted sets: indications:{connId}:window  scored by unix ms timestamp
    // If not present fall back to estimating from cycle counts using elapsed time
    const nowMs = Date.now()
    const ago5m  = nowMs - 5  * 60 * 1000
    const ago60m = nowMs - 60 * 60 * 1000

    let indWindow5m  = 0
    let indWindow60m = 0
    let stratWindow5m  = 0
    let stratWindow60m = 0

    try {
      // ZRANGEBYSCORE on indications window zset (score = timestamp ms, value = count increment)
      const ind5m  = await client.zrangebyscore(`indications:${connectionId}:window`,  ago5m,  "+inf").catch(() => [])
      const ind60m = await client.zrangebyscore(`indications:${connectionId}:window`,  ago60m, "+inf").catch(() => [])
      const str5m  = await client.zrangebyscore(`strategies:${connectionId}:window`,   ago5m,  "+inf").catch(() => [])
      const str60m = await client.zrangebyscore(`strategies:${connectionId}:window`,   ago60m, "+inf").catch(() => [])
      indWindow5m  = ind5m.length
      indWindow60m = ind60m.length
      stratWindow5m  = str5m.length
      stratWindow60m = str60m.length
    } catch { /* non-critical; fall back to zero */ }

    // If window sets are empty, estimate from rate: total / elapsed_minutes * window
    if (indWindow5m === 0 && indTotal > 0) {
      const startedAtMs = n(progHash.started_at) || (nowMs - 3600_000)
      const elapsedMin = (nowMs - startedAtMs) / 60_000 || 1
      const ratePerMin = indTotal / elapsedMin
      indWindow5m  = Math.round(ratePerMin * 5)
      indWindow60m = Math.round(ratePerMin * Math.min(60, elapsedMin))
    }

    // ── METADATA section ─────────────────────────────────────────────────────
    const phase    = ep?.phase || "unknown"
    const progress = n(ep?.progress)
    const message  = ep?.detail || ep?.message || ""
    const lastUpdate = progHash.last_update || realtimeHash.last_cycle_at || new Date().toISOString()

    let redisDbEntries = 0
    try { redisDbEntries = await client.dbSize() } catch { /* non-critical */ }

    // ── Build response ───────────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      connectionId,

      historic: {
        symbolsProcessed:       historicSymbolsProcessed,
        symbolsTotal:           historicSymbolsTotal,
        candlesLoaded:          historicCandlesLoaded,
        indicatorsCalculated:   historicIndicatorsCalculated,
        cyclesCompleted:        historicCyclesCompleted,
        isComplete:             historicIsComplete,
        progressPercent:        historicProgressPercent,
      },

      realtime: {
        indicationCycles: realtimeIndicationCycles,
        strategyCycles:   realtimeStrategyCycles,
        realtimeCycles,
        indicationsTotal,
        strategiesTotal,
        positionsOpen,
        isActive:         realtimeIsActive,
        successRate:      Math.round(successRate * 10) / 10,
        avgCycleTimeMs,
      },

      breakdown: {
        indications: {
          direction: indCounts.direction || 0,
          move:      indCounts.move      || 0,
          active:    indCounts.active    || 0,
          optimal:   indCounts.optimal   || 0,
          auto:      indCounts.auto      || 0,
          total:     indTotal,
        },
        strategies: {
          base: stratCounts.base || 0,
          main: stratCounts.main || 0,
          real: stratCounts.real || 0,
          live: stratCounts.live || 0,
          total: stratTotal,
          baseEvaluated: stratEvaluated.base || 0,
          mainEvaluated: stratEvaluated.main || 0,
          realEvaluated: stratEvaluated.real || 0,
        },
      },

      // Per-stage strategy detail — avg positions per set, created sets, avg profit factor, avg processing time,
      // avg pos eval for Real, pass ratios, drawdown time
      strategyDetail: {
        base: stratDetail.base,
        main: stratDetail.main,
        real: stratDetail.real,
      },

      // Prehistoric processing metadata — range, timeframe, interval progress
      prehistoricMeta,

      // Rolling time-window indication and strategy counts
      windows: {
        indications: { last5m: indWindow5m, last60m: indWindow60m },
        strategies:  { last5m: stratWindow5m, last60m: stratWindow60m },
      },

      metadata: {
        engineRunning: realtimeIsActive,
        phase,
        progress,
        message,
        lastUpdate,
        redisDbEntries,
      },

      // Legacy flat fields kept for backward compat with existing components
      // that still read engine-stats shape directly
      indicationCycleCount:  realtimeIndicationCycles,
      strategyCycleCount:    realtimeStrategyCycles,
      cyclesCompleted:       realtimeIndicationCycles,
      cycleSuccessRate:      Math.round(successRate * 10) / 10,
      totalIndicationsCount: indTotal,
      indicationsByType:     indCounts,
      baseStrategyCount:     stratCounts.base || 0,
      mainStrategyCount:     stratCounts.main || 0,
      realStrategyCount:     stratCounts.real || 0,
      liveStrategyCount:     stratCounts.live || 0,
      totalStrategyCount:    stratTotal,
      positionsCount:        positionsOpen,
    })
  } catch (error) {
    console.error("[v0] [/stats] Error:", error)
    const { id } = await params
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error", connectionId: id },
      { status: 500 }
    )
  }
}
