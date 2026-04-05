import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getConnection } from "@/lib/redis-db"
import { getProgressionLogs, forceFlushLogs } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * GET /api/connections/progression/[id]
 * Returns comprehensive progression data for an active connection
 * Tracks: initialization, historical data loading, indications, strategies, realtime, live trading
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    // PRODUCTION FIX: Initialize Redis before use
    try {
      await initRedis()
    } catch (redisErr) {
      console.error(`[v0] [ProgressionAPI] Redis init failed for ${connectionId}:`, redisErr)
      return getErrorResponse(connectionId, "Redis initialization failed")
    }
    
    // Force flush any pending logs before fetching
    try {
      await forceFlushLogs(connectionId)
    } catch (flushErr) {
      console.warn(`[v0] [ProgressionAPI] Failed to flush logs for ${connectionId}:`, flushErr)
    }

    // Get connection details for context
    const connection = await getConnection(connectionId).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get connection ${connectionId}:`, e)
      return null
    })
    const connName = connection?.name || connectionId

    // Get progression phase data from engine-manager's updateProgressionPhase
    const progression = await getSettings(`engine_progression:${connectionId}`).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression settings for ${connectionId}:`, e)
      return {}
    })
    
    // Get engine state from the correct Redis key: trade_engine_state:{connectionId}
    const client = getRedisClient()
    const engineState = await getSettings(`trade_engine_state:${connectionId}`).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get engine state for ${connectionId}:`, e)
      return {}
    })
    
    // Also check global state (stored as Redis HASH via hset, not a string)
    let globalState: any = {}
    try {
      if (client) {
        const globalStateData = await client.hgetall("trade_engine:global").catch(() => null)
        globalState = globalStateData && Object.keys(globalStateData).length > 0 ? globalStateData : {}
      }
    } catch {
      globalState = {}
    }
    const isGloballyRunning = globalState?.status === "running"
    
     // PHASE 2 FIX: Check running flag directly from coordinator (most reliable)
     // Get current engine running state from coordinator
     let isEngineRunning = false
     try {
       const coordinator = getGlobalTradeEngineCoordinator()
       if (coordinator) {
         isEngineRunning = coordinator.isEngineRunning(connectionId)
         console.log(`[v0] [ProgressionAPI] ${connectionId}: Coordinator reports engine running = ${isEngineRunning}`)
       }
     } catch (e) {
       console.warn(`[v0] [ProgressionAPI] ${connectionId}: Failed to check coordinator state, falling back to Redis flag`)
       const runningFlag = await getSettings(`engine_is_running:${connectionId}`).catch(() => null)
       isEngineRunning = runningFlag === "true" || runningFlag === true
     }
    
    // Check if this connection is currently active/dashboard enabled
    const isActive = connection?.is_enabled_dashboard === "1" || connection?.is_enabled_dashboard === true
    const isEnabled = connection?.is_enabled === "1" || connection?.is_enabled === true
    const isInserted = connection?.is_inserted === "1" || connection?.is_inserted === true
    const isActiveInserted = connection?.is_active_inserted === "1" || connection?.is_active_inserted === true
    
    // Get progression state (cycles, success rates)
    let progressionState = await ProgressionStateManager.getProgressionState(connectionId).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression state for ${connectionId}:`, e)
      return ProgressionStateManager.getDefaultState(connectionId)
    })
    
    // Count indications processed for this connection
    let indicationsCount = 0
    let strategiesCount = 0
    try {
      if (client) {
        indicationsCount =
          toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0)) ||
          (await client.keys(`indications:${connectionId}:*`).catch(() => [])).length

        strategiesCount =
          toNumber(await client.get(`strategies:${connectionId}:count`).catch(() => 0)) ||
          (await client.keys(`strategies:${connectionId}:*`).catch(() => [])).length
      }
    } catch {
      indicationsCount = 0
      strategiesCount = 0
    }
    
    // Check for actual running evidence from cycle counts in engine state
    const indicationCycleCount = toNumber(engineState?.indication_cycle_count)
    const strategyCycleCount = toNumber(engineState?.strategy_cycle_count)
    const hasRecentActivity = engineState?.last_indication_run 
      ? (Date.now() - new Date(engineState.last_indication_run).getTime()) < 60000 // Active in last 60s
      : false
    
    // DEBUG: Log what we're reading (production safe)
    console.log(`[v0] [ProgressionAPI] ${connectionId}: cycleCount=${indicationCycleCount}, stratCount=${strategyCycleCount}, recent=${hasRecentActivity}, engineState.status=${engineState?.status}, running=${isEngineRunning}`)
    
    // Engine is running only when there is current runtime evidence
    const engineRunning = isEngineRunning || 
      (isGloballyRunning && (isActiveInserted || isInserted) && isEnabled) ||
      engineState?.status === "running" ||
      hasRecentActivity
    
    // Phase progression depends on stored phase or derived from state
    let phase = progression?.phase || "idle"
    let progress = Number(progression?.progress) || 0
    let detail = progression?.detail || "Not running"
    
    // Better phase detection based on actual metrics (most reliable)
    if (indicationCycleCount > 100 || progressionState.cyclesCompleted > 100) {
      phase = "live_trading"
      progress = 100
      detail = `Live trading active - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
      console.log(`[v0] [Phase] ${connectionId}: Strong cycles evidence → live_trading`)
    } else if (indicationCycleCount > 20 || progressionState.cyclesCompleted > 20 || indicationsCount > 50) {
      phase = "live_trading"
      progress = 90 + Math.min(10, indicationCycleCount / 100)
      detail = `Live trading - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
      console.log(`[v0] [Phase] ${connectionId}: Moderate cycles (${indicationCycleCount}) OR indications (${indicationsCount}) → live_trading`)
    } else if (indicationCycleCount > 0 || indicationsCount > 0 || progressionState.cyclesCompleted > 0) {
      const totalCycles = Math.max(progressionState.cyclesCompleted, indicationCycleCount)
      phase = "realtime"
      progress = 80 + Math.min(20, totalCycles / 10)
      detail = `Processing - ${totalCycles} cycles`
      console.log(`[v0] [Phase] ${connectionId}: Initial cycles (${indicationCycleCount}) OR keys (${indicationsCount}) → realtime`)
    } else if (progression?.phase && !["ready", "idle", "initializing"].includes(progression.phase)) {
      phase = progression.phase
      progress = Number(progression.progress) || 50
      detail = progression.detail || "Engine running"
    } else if (engineState?.all_phases_started || engineState?.live_trading_started) {
      phase = "live_trading"
      progress = 100
      detail = "All phases active"
    } else if (engineState?.strategies_started) {
      phase = "strategies"
      progress = 75
      detail = "Strategies processor active"
    } else if (engineState?.indications_started) {
      phase = "indications"
      progress = 60
      detail = "Indications processor active"
    } else if (engineState?.prehistoric_data_loaded) {
      phase = "prehistoric_data"
      progress = 15
      detail = "Prehistoric data loaded"
    } else if (engineState?.status === "running" || isEngineRunning) {
      phase = "initializing"
      progress = 30
      detail = "Engine starting up..."
    } else if (!isEnabled || (!isActiveInserted && !isInserted)) {
      phase = "idle"
      progress = 0
      detail = "Connection disabled or not inserted"
    } else if (progression?.phase === "ready") {
      phase = "ready"
      progress = 0
      detail = progression.detail || "Ready - toggle Enable on dashboard to start"
    }
    
    // Get detailed prehistoric progress tracking
    let prehistoricProgress = {
      symbolsProcessed: 0,
      symbolsTotal: 3, // BTC, ETH, SOL
      candlesLoaded: 0,
      candlesTotal: 0,
      indicatorsCalculated: 0,
      currentSymbol: "",
      duration: 0,
      percentComplete: 0,
    }
    
    try {
      if (client) {
        // Check for prehistoric progress tracking in Redis
        const prehistoricData = await client.hgetall(`prehistoric:${connectionId}`).catch(() => ({}))
        if (prehistoricData && Object.keys(prehistoricData).length > 0) {
          prehistoricProgress.currentSymbol = prehistoricData.current_symbol || ""
          prehistoricProgress.candlesLoaded = Number(prehistoricData.candles_loaded || 0)
          prehistoricProgress.candlesTotal = Number(prehistoricData.candles_total || 0)
          prehistoricProgress.indicatorsCalculated = Number(prehistoricData.indicators_calculated || 0)
          prehistoricProgress.duration = Number(prehistoricData.duration || 0)
          
          // Count symbols processed based on completed prehistoric phases tracked in engine state
          const prehistoricSymbols = await client.keys(`prehistoric:${connectionId}:*:completed`).catch(() => [])
          prehistoricProgress.symbolsProcessed = Math.min(prehistoricSymbols.length, prehistoricProgress.symbolsTotal)
          
          // If no completed symbols tracked yet, infer from current activity
          if (prehistoricProgress.symbolsProcessed === 0 && prehistoricProgress.currentSymbol) {
            prehistoricProgress.symbolsProcessed = 1
          }
          
          // Calculate percentage (symbols based, since that's the main progress unit)
          prehistoricProgress.percentComplete = prehistoricProgress.symbolsTotal > 0
            ? Math.round((prehistoricProgress.symbolsProcessed / prehistoricProgress.symbolsTotal) * 100)
            : 0
        }
      }
    } catch (e) {
      console.warn(`[v0] [ProgressionAPI] Failed to get prehistoric progress for ${connectionId}:`, e)
    }
    
    const subItem = progression?.sub_item || ""
    const subCurrent = Number(progression?.sub_current) || 0
    const subTotal = Number(progression?.sub_total) || 0

    // Build comprehensive message
    let message = detail
    if (subTotal > 0 && subCurrent > 0) {
      message = `${detail} (${subCurrent}/${subTotal}${subItem ? ` - ${subItem}` : ""})`
    } else if (engineRunning && phase === "realtime") {
      message = "Processing realtime indications and strategies"
    }

    // Derive detailed step flags from phase progression
    const phaseOrder = ["idle", "initializing", "prehistoric_data", "indications", "strategies", "realtime", "live_trading"]
    const currentIdx = phaseOrder.indexOf(phase)

    console.log(`[v0] [Progression] Phase analysis for ${connName}:`, {
      phase,
      progress,
      message,
      phaseIndex: currentIdx,
      running: engineRunning,
    })

    // Get recent logs for this connection
    const recentLogs = await getProgressionLogs(connectionId)

    const response = {
      success: true,
      connectionId,
      connectionName: connName,
      connection: {
        exchange: connection?.exchange || "unknown",
        isActive,
        isEnabled,
        isInserted,
        isActiveInserted,
      },
      progression: {
        phase,
        progress,
        message,
        subPhase: subItem || null,
        subProgress: {
          current: subCurrent,
          total: subTotal,
        },
        startedAt: globalState?.started_at || engineState?.started_at || null,
        updatedAt: progression?.updated_at || engineState?.last_indication_run || new Date().toISOString(),
        details: {
          historicalDataLoaded: currentIdx >= 3 || (progressionState.prehistoricCyclesCompleted || 0) > 0,
          indicationsCalculated: currentIdx >= 4 || engineRunning || indicationsCount > 0,
          strategiesProcessed: currentIdx >= 5 || engineRunning || strategiesCount > 0,
          liveProcessingActive: currentIdx >= 5 || engineRunning,
          liveTradingActive: phase === "live_trading",
        },
        prehistoricProgress: prehistoricProgress,
        error: phase === "error" ? detail : null,
      },
      state: {
        cyclesCompleted: progressionState.cyclesCompleted,
        successfulCycles: progressionState.successfulCycles,
        failedCycles: progressionState.failedCycles,
        cycleSuccessRate: Math.round(progressionState.cycleSuccessRate * 10) / 10,
        totalTrades: progressionState.totalTrades,
        successfulTrades: progressionState.successfulTrades,
        totalProfit: progressionState.totalProfit,
        tradeSuccessRate: Math.round((progressionState.tradeSuccessRate ?? 0) * 10) / 10,
        lastCycleTime: progressionState.lastCycleTime?.toISOString() || null,
        prehistoricCyclesCompleted: progressionState.prehistoricCyclesCompleted,
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
      },
      metrics: {
        indicationsCount,
        strategiesCount,
        intervalsProcessed: toNumber(await client?.get(`intervals:${connectionId}:processed_count`).catch(() => 0)),
        engineRunning,
        isEngineRunning,
        hasRecentActivity,
        globalEngineStatus: globalState?.status || "unknown",
        engineStateStatus: engineState?.status || "unknown",
        indicationCycleCount,
        strategyCycleCount,
        realtimeCycleCount: toNumber(engineState?.realtime_cycle_count),
        cycleTimeMs: toNumber(engineState?.last_cycle_duration),
        totalStrategiesEvaluated: toNumber(engineState?.total_strategies_evaluated),
        totalIndicationsEvaluated: toNumber(engineState?.total_indications_evaluated),
        prehistoricSymbolsTotal: toNumber(engineState?.config_set_symbols_total),
        prehistoricSymbolsProcessed: toNumber(engineState?.config_set_symbols_processed),
        prehistoricCandlesProcessed: toNumber(engineState?.config_set_candles_processed),
        prehistoricIndicationResults: toNumber(engineState?.config_set_indication_results),
        prehistoricStrategyPositions: toNumber(engineState?.config_set_strategy_positions),
        prehistoricErrors: toNumber(engineState?.config_set_errors),
        progressionCyclesCompleted: progressionState.cyclesCompleted,
        lastIndicationRun: engineState?.last_indication_run || null,
        lastStrategyRun: engineState?.last_strategy_run || null,
      },
      recentLogs: recentLogs.slice(0, 20).map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        phase: log.phase,
        message: log.message,
        details: log.details,
      })),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[v0] [Progression] Failed to fetch progression:", error)
    const { id } = await params
    return getErrorResponse(id, error instanceof Error ? error.message : "Unknown error")
  }
}

// Production-safe error response helper
function getErrorResponse(connectionId: string, message: string) {
  return NextResponse.json({ 
    success: false,
    connectionId,
    progression: {
      phase: "error",
      progress: 0,
      message: "Failed to fetch progression status",
      subPhase: null,
      subProgress: { current: 0, total: 0 },
      startedAt: null,
      updatedAt: null,
      details: {
        historicalDataLoaded: false,
        indicationsCalculated: false,
        strategiesProcessed: false,
        liveProcessingActive: false,
        liveTradingActive: false,
      },
      error: message,
    },
  }, { status: 500 })
}
