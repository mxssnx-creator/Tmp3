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

async function countKeys(client: any, patterns: string[]): Promise<number> {
  let total = 0
  for (const pattern of patterns) {
    const keys = await client.keys(pattern).catch(() => [])
    total += Array.isArray(keys) ? keys.length : 0
  }
  return total
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

    const [
      prehistoricSymbolsSet,
      prehistoricDataKeys,
      baseSetCount,
      mainSetCount,
      realSetCount,
      indicationDirectionCount,
      indicationMoveCount,
      indicationActiveCount,
      indicationOptimalCount,
      redisDbSize,
      redisMemoryInfo,
    ] = await Promise.all([
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      countKeys(client, [`prehistoric:${connectionId}:*`, `market_data:${connectionId}:*`]),
      countKeys(client, [`sets:${connectionId}:base:*`, `pseudo_positions:${connectionId}:base:*`]),
      countKeys(client, [`sets:${connectionId}:main:*`, `pseudo_positions:${connectionId}:main:*`]),
      countKeys(client, [`sets:${connectionId}:real:*`, `pseudo_positions:${connectionId}:real:*`]),
      toNumber(await client.get(`indications:${connectionId}:direction:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:move:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:active:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:optimal:evaluated`).catch(() => 0)),
      client.dbsize().catch(() => 0),
      client.info("memory").catch(() => ""),
    ])

    const usedMemoryLine = String(redisMemoryInfo)
      .split("\n")
      .find((line) => line.startsWith("used_memory:"))
    const usedMemoryBytes = toNumber(usedMemoryLine?.split(":")[1])
    const dbSizeMb = usedMemoryBytes > 0 ? usedMemoryBytes / (1024 * 1024) : 0

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
        strategyEvaluatedBase: toNumber(await client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0)),
        strategyEvaluatedMain: toNumber(await client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0)),
        strategyEvaluatedReal: toNumber(await client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0)),
        indicationEvaluatedDirection: indicationDirectionCount,
        indicationEvaluatedMove: indicationMoveCount,
        indicationEvaluatedActive: indicationActiveCount,
        indicationEvaluatedOptimal: indicationOptimalCount,
        prehistoricSymbolsProcessed: toNumber(engineState?.config_set_symbols_processed),
        prehistoricCandlesProcessed: toNumber(engineState?.config_set_candles_processed),
        prehistoricSymbolsProcessedCount: toNumber(prehistoricSymbolsSet || engineState?.config_set_symbols_processed),
        prehistoricDataSize: toNumber(prehistoricDataKeys),
        setsBaseCount: toNumber(baseSetCount),
        setsMainCount: toNumber(mainSetCount),
        setsRealCount: toNumber(realSetCount),
        setsTotalCount: toNumber(baseSetCount + mainSetCount + realSetCount),
        redisDbEntries: toNumber(redisDbSize),
        redisDbSizeMb: Number(dbSizeMb.toFixed(2)),
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
