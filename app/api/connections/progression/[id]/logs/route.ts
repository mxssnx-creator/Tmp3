import { type NextRequest, NextResponse } from "next/server"
import { getProgressionLogs, clearProgressionLogs } from "@/lib/engine-progression-logs"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function readCount(client: any, key: string): Promise<number> {
  try {
    return toNumber(await client.get(key))
  } catch {
    return 0
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Get progression logs for this connection
    const logs = await getProgressionLogs(connectionId)
    
    // Get progression state (cycles, trades, etc.)
    const progressionState = await ProgressionStateManager.getProgressionState(connectionId)
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    
    // Get engine progression phase
    const engineProgression = await getSettings(`engine_progression:${connectionId}`)
    
    // Get structured engine logs
    const client = getRedisClient()
    let structuredLogs: any[] = []
    try {
      const rawLogs = await client.lrange(`engine:logs:${connectionId}`, 0, 100)
      structuredLogs = rawLogs.map((log: string) => {
        try { return JSON.parse(log) } catch { return null }
      }).filter(Boolean)
    } catch {
      structuredLogs = []
    }

    const mergedLogs = logs.length > 0
      ? logs
      : structuredLogs.map((log: any) => ({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.status === "error" ? "error" : "info",
          phase: log.phase || log.engine || "engine",
          message: log.action || "structured log",
          details: log.details || {},
          connectionId,
        }))

    const indicationByType = {
      direction: await readCount(client, `indications:${connectionId}:direction:count`),
      move: await readCount(client, `indications:${connectionId}:move:count`),
      active: await readCount(client, `indications:${connectionId}:active:count`),
      optimal: await readCount(client, `indications:${connectionId}:optimal:count`),
      auto: await readCount(client, `indications:${connectionId}:auto:count`),
    }

    const strategyStats = {
      base: {
        total: await readCount(client, `strategies:${connectionId}:base:total`),
        evaluated: await readCount(client, `strategies:${connectionId}:base:evaluated`),
        avgProfitFactor: await readCount(client, `strategies:${connectionId}:base:avg_profit_factor`),
        avgDrawdownTime: await readCount(client, `strategies:${connectionId}:base:avg_drawdown_time`),
      },
      main: {
        total: await readCount(client, `strategies:${connectionId}:main:total`),
        evaluated: await readCount(client, `strategies:${connectionId}:main:evaluated`),
        avgProfitFactor: await readCount(client, `strategies:${connectionId}:main:avg_profit_factor`),
        avgDrawdownTime: await readCount(client, `strategies:${connectionId}:main:avg_drawdown_time`),
      },
      real: {
        total: await readCount(client, `strategies:${connectionId}:real:total`),
        evaluated: await readCount(client, `strategies:${connectionId}:real:evaluated`),
        avgProfitFactor: await readCount(client, `strategies:${connectionId}:real:avg_profit_factor`),
        avgDrawdownTime: await readCount(client, `strategies:${connectionId}:real:avg_drawdown_time`),
      },
    }

    const calculateRate = (evaluated: number, total: number) => (total > 0 ? (evaluated / total) * 100 : 0)

    const prehistoricDbEntries = await readCount(client, `prehistoric:${connectionId}:db_entries`)
    const dbWritesPerSec = await readCount(client, `db:${connectionId}:writes_per_sec`)
    const dbSizeMb = await readCount(client, `db:${connectionId}:size_mb`)
    const setCounts = {
      base: await readCount(client, `sets:${connectionId}:base:count`),
      main: await readCount(client, `sets:${connectionId}:main:count`),
      real: await readCount(client, `sets:${connectionId}:real:count`),
      total: await readCount(client, `sets:${connectionId}:total`),
    }

    return NextResponse.json({
      success: true,
      connectionId,
      logsCount: mergedLogs.length,
      logs: mergedLogs,
      structuredLogs,
      structuredLogsCount: structuredLogs.length,
      progressionState: {
        cyclesCompleted: Math.max(progressionState.cyclesCompleted, Number(engineState?.indication_cycle_count || 0)),
        successfulCycles: Math.max(progressionState.successfulCycles, Number(engineState?.strategy_cycle_count || 0)),
        failedCycles: progressionState.failedCycles,
        totalTrades: progressionState.totalTrades,
        successfulTrades: progressionState.successfulTrades,
        totalProfit: progressionState.totalProfit,
        cycleSuccessRate: progressionState.cycleSuccessRate,
        tradeSuccessRate: progressionState.tradeSuccessRate,
        lastCycleTime: progressionState.lastCycleTime,
        prehistoricCyclesCompleted: progressionState.prehistoricCyclesCompleted,
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
        realtimeCycleCount: toNumber(engineState?.realtime_cycle_count),
        cycleTimeMs: toNumber(engineState?.last_cycle_duration),
        intervalsProcessed: toNumber(await client.get(`intervals:${connectionId}:processed_count`).catch(() => 0)),
        indicationsCount: toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0)),
        strategiesCount: toNumber(await client.get(`strategies:${connectionId}:count`).catch(() => 0)),
        strategyEvaluatedBase: strategyStats.base.evaluated,
        strategyEvaluatedMain: strategyStats.main.evaluated,
        strategyEvaluatedReal: strategyStats.real.evaluated,
        prehistoricSymbolsProcessed: toNumber(engineState?.config_set_symbols_processed),
        prehistoricSymbolsTotal: toNumber(engineState?.config_set_symbols_total),
        prehistoricCandlesProcessed: toNumber(engineState?.config_set_candles_processed),
        prehistoricDbEntries,
        dbWritesPerSec,
        dbSizeMb,
        indicationByType: {
          ...indicationByType,
          total: Object.values(indicationByType).reduce((sum, current) => sum + current, 0),
        },
        strategyStats: {
          base: {
            ...strategyStats.base,
            evaluationRatePercent: calculateRate(strategyStats.base.evaluated, strategyStats.base.total),
          },
          main: {
            ...strategyStats.main,
            evaluationRatePercent: calculateRate(strategyStats.main.evaluated, strategyStats.main.total),
          },
          real: {
            ...strategyStats.real,
            evaluationRatePercent: calculateRate(strategyStats.real.evaluated, strategyStats.real.total),
          },
        },
        setCounts,
      },
      enginePhase: engineProgression ? {
        phase: engineProgression.phase,
        progress: engineProgression.progress,
        detail: engineProgression.detail,
        updatedAt: engineProgression.updated_at,
      } : null,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error fetching progression logs:", error)
    return NextResponse.json(
      { error: "Failed to fetch progression logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Clear progression logs
    await clearProgressionLogs(connectionId)
    
    // Also clear structured logs
    const client = getRedisClient()
    await client.del(`engine:logs:${connectionId}`)
    await client.del(`engine_logs:${connectionId}`)

    return NextResponse.json({
      success: true,
      message: "Logs cleared successfully",
      connectionId,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error clearing progression logs:", error)
    return NextResponse.json(
      { error: "Failed to clear logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
