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
    const [
      progHash,
      prehistoricHash,
      realtimeHash,
      engineState,
      engineProgression,
      prehistoricSymbolCount,
    ] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => ({})) as Promise<Record<string, string>>,
      client.hgetall(`prehistoric:${connectionId}`).catch(() => ({})) as Promise<Record<string, string>>,
      client.hgetall(`realtime:${connectionId}`).catch(() => ({})) as Promise<Record<string, string>>,
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`engine_progression:${connectionId}`).catch(() => ({})),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
    ])

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
        const h = await client.hgetall(`pseudo_position:${connectionId}:${posId}`).catch(() => ({}))
        if ((h as any)?.status === "active" || !(h as any)?.status) positionsOpen++
      }
    } catch { /* non-critical */ }

    const realtimeIsActive =
      realtimeIndicationCycles > 0 ||
      ep?.phase === "live_trading" ||
      ep?.phase === "realtime" ||
      es.status === "running"

    // ── BREAKDOWN section ────────────────────────────────────────────────────
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
