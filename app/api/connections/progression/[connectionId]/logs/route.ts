import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: { connectionId: string } }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const connectionId = params.connectionId

    if (!connectionId) {
      return NextResponse.json({ error: "Missing connectionId parameter" }, { status: 400 })
    }

    // Get progression logs for the connection
    const logs = await getProgressionLogs(connectionId)
    const progressionState = await ProgressionStateManager.getProgressionState(connectionId)

    // Get additional stats from Redis
    const additionalStats = await getAdditionalStats(client, connectionId)

    // Combine progression state with additional stats
    const combinedProgressionState = {
      ...progressionState,
      ...additionalStats,
    }

    return NextResponse.json({
      logs,
      progressionState: combinedProgressionState,
    })
  } catch (error) {
    console.error("[Connections Progression Logs API] Error:", error)
    return NextResponse.json(
      {
        logs: [],
        progressionState: null,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

async function getAdditionalStats(client: any, connectionId: string) {
  try {
    const stats = {
      cyclesCompleted: 0,
      successfulCycles: 0,
      failedCycles: 0,
      cycleSuccessRate: 0,
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      tradeSuccessRate: 0,
      intervalsProcessed: 0,
      indicationsCount: 0,
      strategiesCount: 0,
      strategyEvaluatedBase: 0,
      strategyEvaluatedMain: 0,
      strategyEvaluatedReal: 0,
      prehistoricCyclesCompleted: 0,
      prehistoricSymbolsProcessedCount: 0,
      prehistoricCandlesProcessed: 0,
      prehistoricDataSize: 0,
      indicationEvaluatedDirection: 0,
      indicationEvaluatedMove: 0,
      indicationEvaluatedActive: 0,
      indicationEvaluatedOptimal: 0,
      setsBaseCount: 0,
      setsMainCount: 0,
      setsRealCount: 0,
      setsTotalCount: 0,
      redisDbEntries: 0,
      redisDbSizeMb: 0,
      processingCompleteness: {
        prehistoricLoaded: false,
        indicationsRunning: false,
        strategiesRunning: false,
        realtimeRunning: false,
        hasErrors: false,
      }
    }

    // Get data from Redis keys
    const [
      cyclesCompleted,
      successfulCycles,
      failedCycles,
      totalTrades,
      totalProfit,
      intervalsProcessed,
      indicationsCount,
      strategiesCount,
      strategyEvaluatedBase,
      strategyEvaluatedMain,
      strategyEvaluatedReal,
      prehistoricCyclesCompleted,
      prehistoricSymbolsProcessedCount,
      prehistoricCandlesProcessed,
      prehistoricDataKeys,
      indicationEvaluatedDirection,
      indicationEvaluatedMove,
      indicationEvaluatedActive,
      indicationEvaluatedOptimal,
      setsBaseCount,
      setsMainCount,
      setsRealCount,
      redisDbEntries,
      processingState,
    ] = await Promise.all([
      client.get(`stats:${connectionId}:cycles_completed`).catch(() => 0),
      client.get(`stats:${connectionId}:cycles_successful`).catch(() => 0),
      client.get(`stats:${connectionId}:cycles_failed`).catch(() => 0),
      client.get(`stats:${connectionId}:total_trades`).catch(() => 0),
      client.get(`stats:${connectionId}:total_profit`).catch(() => 0),
      client.get(`stats:${connectionId}:intervals_processed`).catch(() => 0),
      client.get(`stats:${connectionId}:indications_count`).catch(() => 0),
      client.get(`stats:${connectionId}:strategies_count`).catch(() => 0),
      client.get(`stats:${connectionId}:strategy_evaluated_base`).catch(() => 0),
      client.get(`stats:${connectionId}:strategy_evaluated_main`).catch(() => 0),
      client.get(`stats:${connectionId}:strategy_evaluated_real`).catch(() => 0),
      client.get(`stats:${connectionId}:prehistoric_cycles_completed`).catch(() => 0),
      client.get(`stats:${connectionId}:prehistoric_symbols_processed`).catch(() => 0),
      client.get(`stats:${connectionId}:prehistoric_candles_processed`).catch(() => 0),
      client.keys(`prehistoric:${connectionId}:*`).then((keys: string[]) => keys.length).catch(() => 0),
      client.get(`stats:${connectionId}:indication_direction`).catch(() => 0),
      client.get(`stats:${connectionId}:indication_move`).catch(() => 0),
      client.get(`stats:${connectionId}:indication_active`).catch(() => 0),
      client.get(`stats:${connectionId}:indication_optimal`).catch(() => 0),
      client.scard(`sets:${connectionId}:base`).catch(() => 0),
      client.scard(`sets:${connectionId}:main`).catch(() => 0),
      client.scard(`sets:${connectionId}:real`).catch(() => 0),
      client.keys(`${connectionId}:*`).then((keys: string[]) => keys.length).catch(() => 0),
      client.hgetall(`processing:${connectionId}:state`).catch(() => ({})),
    ])

    // Convert and assign values
    stats.cyclesCompleted = parseInt(cyclesCompleted) || 0
    stats.successfulCycles = parseInt(successfulCycles) || 0
    stats.failedCycles = parseInt(failedCycles) || 0
    stats.cycleSuccessRate = stats.cyclesCompleted > 0 ? (stats.successfulCycles / stats.cyclesCompleted) * 100 : 0
    stats.totalTrades = parseInt(totalTrades) || 0
    stats.totalProfit = parseFloat(totalProfit) || 0
    stats.tradeSuccessRate = stats.totalTrades > 0 ? (stats.successfulTrades / stats.totalTrades) * 100 : 0
    stats.intervalsProcessed = parseInt(intervalsProcessed) || 0
    stats.indicationsCount = parseInt(indicationsCount) || 0
    stats.strategiesCount = parseInt(strategiesCount) || 0
    stats.strategyEvaluatedBase = parseInt(strategyEvaluatedBase) || 0
    stats.strategyEvaluatedMain = parseInt(strategyEvaluatedMain) || 0
    stats.strategyEvaluatedReal = parseInt(strategyEvaluatedReal) || 0
    stats.prehistoricCyclesCompleted = parseInt(prehistoricCyclesCompleted) || 0
    stats.prehistoricSymbolsProcessedCount = parseInt(prehistoricSymbolsProcessedCount) || 0
    stats.prehistoricCandlesProcessed = parseInt(prehistoricCandlesProcessed) || 0
    stats.prehistoricDataSize = prehistoricDataKeys || 0
    stats.indicationEvaluatedDirection = parseInt(indicationEvaluatedDirection) || 0
    stats.indicationEvaluatedMove = parseInt(indicationEvaluatedMove) || 0
    stats.indicationEvaluatedActive = parseInt(indicationEvaluatedActive) || 0
    stats.indicationEvaluatedOptimal = parseInt(indicationEvaluatedOptimal) || 0
    stats.setsBaseCount = setsBaseCount || 0
    stats.setsMainCount = setsMainCount || 0
    stats.setsRealCount = setsRealCount || 0
    stats.setsTotalCount = stats.setsBaseCount + stats.setsMainCount + stats.setsRealCount
    stats.redisDbEntries = redisDbEntries || 0
    stats.redisDbSizeMb = Math.round((stats.redisDbEntries * 150) / (1024 * 1024) * 100) / 100 // Rough estimate

    // Processing completeness
    stats.processingCompleteness.prehistoricLoaded = processingState?.prehistoric_loaded === "true"
    stats.processingCompleteness.indicationsRunning = processingState?.indications_running === "true"
    stats.processingCompleteness.strategiesRunning = processingState?.strategies_running === "true"
    stats.processingCompleteness.realtimeRunning = processingState?.realtime_running === "true"
    stats.processingCompleteness.hasErrors = processingState?.has_errors === "true"

    return stats
  } catch (error) {
    console.warn("[Additional Stats] Failed to get stats:", error)
    return {}
  }
}