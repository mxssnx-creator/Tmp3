import { NextResponse } from "next/server"
import { getAllConnections } from "@/lib/redis-db"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import { WorkflowLogger } from "@/lib/workflow-logger"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

type LogLevel = "error" | "warn" | "warning" | "info" | "debug"

function normalizeLogLevel(level: unknown): LogLevel {
  const value = String(level || "").toLowerCase()
  if (value === "error" || value === "failed") return "error"
  if (value === "warn" || value === "warning") return "warn"
  if (value === "debug") return "debug"
  return "info"
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    
    await initRedis()
    
    const allConnections = await getAllConnections()
    const connection = allConnections.find((conn: any) => conn.id === id) || null

    const [progressionLogs, workflowLogs, progressionState, engineState] = await Promise.all([
      getProgressionLogs(id),
      WorkflowLogger.getLogs(id, 100),
      ProgressionStateManager.getProgressionState(connectionId),
      getSettings(`trade_engine_state:${connectionId}`)
    ])
    const client = getRedisClient()

    const mappedProgressionLogs = progressionLogs.map((log) => ({
      source: "progression",
      timestamp: log.timestamp,
      level: normalizeLogLevel(log.level),
      phase: log.phase || "progression",
      message: log.message,
      details: log.details || {},
    }))
    const mappedWorkflowLogs = workflowLogs.map((log) => ({
      source: "workflow",
      timestamp: new Date(log.timestamp).toISOString(),
      level: normalizeLogLevel(log.status),
      phase: log.eventType || "workflow",
      message: log.message,
      details: {
        symbol: log.symbol,
        duration: log.duration,
        ...(log.details || {}),
      },
    }))

    const logs = [...mappedProgressionLogs, ...mappedWorkflowLogs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 100)

    const levelSummary = logs.reduce(
      (acc, log) => {
        if (log.level === "error") acc.errors += 1
        else if (log.level === "warn" || log.level === "warning") acc.warnings += 1
        else if (log.level === "debug") acc.debug += 1
        else acc.info += 1
        return acc
      },
      { errors: 0, warnings: 0, info: 0, debug: 0 },
    )

    const phaseSummary = logs.reduce<Record<string, number>>((acc, log) => {
      const phase = log.phase || "unknown"
      acc[phase] = (acc[phase] || 0) + 1
      return acc
    }, {})

    const [
      directionCount,
      moveCount,
      activeCount,
      optimalCount,
      autoCount,
      baseCount,
      mainCount,
      realCount,
      baseEvaluated,
      mainEvaluated,
      realEvaluated,
      intervalsProcessed,
      totalIndications,
      totalStrategies,
      dbOpsPerSecond,
      dbSizeMb,
    ] = await Promise.all([
      client.get(`indications:${connectionId}:direction:count`).catch(() => 0),
      client.get(`indications:${connectionId}:move:count`).catch(() => 0),
      client.get(`indications:${connectionId}:active:count`).catch(() => 0),
      client.get(`indications:${connectionId}:optimal:count`).catch(() => 0),
      client.get(`indications:${connectionId}:auto:count`).catch(() => 0),
      client.get(`strategies:${connectionId}:base:count`).catch(() => 0),
      client.get(`strategies:${connectionId}:main:count`).catch(() => 0),
      client.get(`strategies:${connectionId}:real:count`).catch(() => 0),
      client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0),
      client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0),
      client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0),
      client.get(`intervals:${connectionId}:processed_count`).catch(() => 0),
      client.get(`indications:${connectionId}:count`).catch(() => 0),
      client.get(`strategies:${connectionId}:count`).catch(() => 0),
      client.get(`db:${connectionId}:entries_per_second`).catch(() => 0),
      client.get(`db:${connectionId}:size_mb`).catch(() => 0),
    ])

    const strategySetKeys = await client.keys(`strategy_set:${connectionId}:*:*`).catch(() => [] as string[])
    let strategySetTotal = 0
    let strategySetBase = 0
    let strategySetMain = 0
    let strategySetReal = 0
    let evaluatedPfSumBase = 0
    let evaluatedPfSumMain = 0
    let evaluatedPfSumReal = 0
    let evaluatedDdSumReal = 0
    let evaluatedPfCountBase = 0
    let evaluatedPfCountMain = 0
    let evaluatedPfCountReal = 0

    for (const key of strategySetKeys) {
      if (key.endsWith(":stats")) continue
      const entriesRaw = await client.get(key).catch(() => null)
      if (!entriesRaw) continue
      try {
        const entries = JSON.parse(entriesRaw)
        const list = Array.isArray(entries) ? entries : []
        strategySetTotal += list.length
        if (key.endsWith(":base")) strategySetBase += list.length
        if (key.endsWith(":main")) strategySetMain += list.length
        if (key.endsWith(":real")) strategySetReal += list.length
        for (const item of list) {
          const pf = toNumber(item?.profitFactor ?? item?.avg_profit_factor)
          const dd = toNumber(item?.drawdownTime ?? item?.drawdown_hours)
          if (key.endsWith(":base") && pf > 0) {
            evaluatedPfSumBase += pf
            evaluatedPfCountBase += 1
          }
          if (key.endsWith(":main") && pf > 0) {
            evaluatedPfSumMain += pf
            evaluatedPfCountMain += 1
          }
          if (key.endsWith(":real") && pf > 0) {
            evaluatedPfSumReal += pf
            evaluatedPfCountReal += 1
            evaluatedDdSumReal += dd
          }
        }
      } catch {
        // ignore malformed entries
      }
    }

    const avgPfBase = evaluatedPfCountBase > 0 ? evaluatedPfSumBase / evaluatedPfCountBase : 0
    const avgPfMain = evaluatedPfCountMain > 0 ? evaluatedPfSumMain / evaluatedPfCountMain : 0
    const avgPfReal = evaluatedPfCountReal > 0 ? evaluatedPfSumReal / evaluatedPfCountReal : 0
    const avgDdReal = evaluatedPfCountReal > 0 ? evaluatedDdSumReal / evaluatedPfCountReal : 0

    // Enhanced summary with prehistoric data, indications, strategies, and cycle info
     const enhancedSummary = {
       total: logs.length,
       ...levelSummary,
       phases: phaseSummary,
       latestTimestamp: logs[0]?.timestamp || null,
       oldestTimestamp: logs[logs.length - 1]?.timestamp || null,
       
       // Prehistoric data processing info
       prehistoricData: {
         cyclesCompleted: progressionState.prehistoricCyclesCompleted || toNumber(engineState?.config_set_symbols_processed),
         symbolsProcessed: Array.isArray(progressionState.prehistoricSymbolsProcessed)
           ? progressionState.prehistoricSymbolsProcessed.length
           : toNumber(engineState?.config_set_symbols_processed),
         candlesProcessed: progressionState.prehistoricCandlesProcessed || toNumber(engineState?.config_set_candles_processed),
         phaseActive: progressionState.prehistoricPhaseActive || false,
         lastUpdate: progressionState.lastUpdate?.toISOString() || null
       },
       
       // Indications by type (direction, move, active, optimal, auto)
       indicationsCounts: {
         direction: progressionState.indicationsDirectionCount || toNumber(directionCount),
         move: progressionState.indicationsMoveCount || toNumber(moveCount),
         active: progressionState.indicationsActiveCount || toNumber(activeCount),
         optimal: progressionState.indicationsOptimalCount || toNumber(optimalCount),
         auto: progressionState.indicationsAutoCount || toNumber(autoCount)
       },
       
       // Strategy count sets and evaluated counts
       strategyCounts: {
         base: {
           total: progressionState.strategiesBaseTotal || toNumber(baseCount),
           evaluated: progressionState.strategyEvaluatedBase || toNumber(baseEvaluated),
           pending: Math.max(
             0,
             (progressionState.strategiesBaseTotal || toNumber(baseCount)) -
               (progressionState.strategyEvaluatedBase || toNumber(baseEvaluated)),
           ),
           evaluatedRatePercent: (() => {
             const total = progressionState.strategiesBaseTotal || toNumber(baseCount)
             const evald = progressionState.strategyEvaluatedBase || toNumber(baseEvaluated)
             return total > 0 ? (evald / total) * 100 : 0
           })(),
           avgProfitFactor: avgPfBase,
         },
         main: {
           total: progressionState.strategiesMainTotal || toNumber(mainCount),
           evaluated: progressionState.strategyEvaluatedMain || toNumber(mainEvaluated),
           pending: Math.max(
             0,
             (progressionState.strategiesMainTotal || toNumber(mainCount)) -
               (progressionState.strategyEvaluatedMain || toNumber(mainEvaluated)),
           ),
           evaluatedRatePercent: (() => {
             const total = progressionState.strategiesMainTotal || toNumber(mainCount)
             const evald = progressionState.strategyEvaluatedMain || toNumber(mainEvaluated)
             return total > 0 ? (evald / total) * 100 : 0
           })(),
           avgProfitFactor: avgPfMain,
         },
         real: {
           total: progressionState.strategiesRealTotal || toNumber(realCount),
           evaluated: progressionState.strategyEvaluatedReal || toNumber(realEvaluated),
           pending: Math.max(
             0,
             (progressionState.strategiesRealTotal || toNumber(realCount)) -
               (progressionState.strategyEvaluatedReal || toNumber(realEvaluated)),
           ),
           evaluatedRatePercent: (() => {
             const total = progressionState.strategiesRealTotal || toNumber(realCount)
             const evald = progressionState.strategyEvaluatedReal || toNumber(realEvaluated)
             return total > 0 ? (evald / total) * 100 : 0
           })(),
           avgProfitFactor: avgPfReal,
           avgDrawdownTime: avgDdReal,
         }
       },
       
       // Engine performance info
       enginePerformance: {
         cycleTimeMs: progressionState.cycleTimeMs || toNumber(engineState?.last_cycle_duration),
         cyclesCompleted: progressionState.cyclesCompleted || 0,
         successfulCycles: progressionState.successfulCycles || 0,
         failedCycles: progressionState.failedCycles || 0,
         cycleSuccessRate: progressionState.cycleSuccessRate || 0,
         totalTrades: progressionState.totalTrades || 0,
         successfulTrades: progressionState.successfulTrades || 0,
         tradeSuccessRate: progressionState.tradeSuccessRate || 0,
         totalProfit: progressionState.totalProfit || 0,
         lastCycleTime: progressionState.lastCycleTime?.toISOString() || null,
         intervalsProcessed: progressionState.intervalsProcessed || toNumber(intervalsProcessed),
         indicationsCount: progressionState.indicationsCount || toNumber(totalIndications),
         strategiesCount: progressionState.strategiesCount || toNumber(totalStrategies)
       },
       processingOverview: {
         prehistoricSymbolsTotal: toNumber(engineState?.config_set_symbols_total),
         prehistoricSymbolsWithoutData: toNumber(engineState?.config_set_symbols_without_data),
         strategySetsTotal: strategySetTotal,
         strategySetsBase: strategySetBase,
         strategySetsMain: strategySetMain,
         strategySetsReal: strategySetReal,
         dbEntriesPerSecond: toNumber(dbOpsPerSecond),
         dbSizeMb: toNumber(dbSizeMb),
       }
     }

    return NextResponse.json({
      success: true,
      connection: connection
        ? {
            id: connection.id,
            name: connection.name || connection.exchange || connection.id,
            exchange: connection.exchange || "unknown",
            is_enabled: connection.is_enabled,
            is_enabled_dashboard: connection.is_enabled_dashboard,
            is_active_inserted: connection.is_active_inserted,
            last_test_status: connection.last_test_status || connection.test_status || "untested",
            last_test_timestamp: connection.last_test_timestamp || connection.updated_at || null,
          }
        : null,
      logs: logs || [],
      summary: enhancedSummary,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error fetching connection logs:", error)
    return NextResponse.json(
      { error: "Failed to fetch connection logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
