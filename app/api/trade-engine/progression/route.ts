import { NextResponse } from "next/server"
import { getActiveConnectionsForEngine, getConnectionTrades, getConnectionPositions, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    console.log("[v0] Fetching real-time trade engine progression data")
    await initRedis()
    const activeConnections = await getActiveConnectionsForEngine()
    
    console.log(`[v0] Processing ${activeConnections.length} active enabled connections`)
    
    // Import the global coordinator to get real engine status
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Get progression status for each connection with REAL data
    const progressionData = await Promise.all(
      activeConnections.map(async (conn) => {
        try {
          console.log(`[v0] Getting progression for ${conn.name}...`)
          
          // Get REAL engine status from running coordinator
          const engineStatus = await coordinator.getEngineStatus(conn.id)
          const isEngineRunning = engineStatus !== null
          const [trades, positions, progressionState] = await Promise.all([
            getConnectionTrades(conn.id),
            getConnectionPositions(conn.id),
            ProgressionStateManager.getProgressionState(conn.id),
          ])

          const tradeCount = trades.length
          const pseudoCount = positions.length
          const engineState = isEngineRunning ? "running" : "idle"
          const updatedAt = progressionState.lastUpdate?.toISOString?.() || null
          const prehistoricLoaded = (progressionState.prehistoricCyclesCompleted || 0) > 0
          
          // Get cycle metrics from engine status if available
          const cycleMetrics = engineStatus ? {
            indicationCycles: engineStatus.indication_cycle_count || engineStatus.engine_cycles_total || 0,
            strategyCycles: engineStatus.strategy_cycle_count || engineStatus.engine_cycles_total || 0,
            realtimeCycles: engineStatus.realtime_cycle_count || engineStatus.engine_cycles_total || 0,
            lastCycleAt: engineStatus.last_cycle_at || engineStatus.last_realtime_run || null,
          } : null
          
          console.log(`[v0] ${conn.name}: ${engineState}, ${tradeCount} trades, ${pseudoCount} positions, running=${isEngineRunning}`)
          
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning,
            engineState,
            tradeCount,
            pseudoPositionCount: pseudoCount,
            prehistoricDataLoaded: prehistoricLoaded,
            lastUpdate: updatedAt,
            cycleMetrics,
            progression: {
              cyclesCompleted: progressionState.cyclesCompleted,
              successfulCycles: progressionState.successfulCycles,
              failedCycles: progressionState.failedCycles,
              cycleSuccessRate: progressionState.cycleSuccessRate,
              totalTrades: progressionState.totalTrades,
              successfulTrades: progressionState.successfulTrades,
              totalProfit: progressionState.totalProfit,
            },
            realTimeData: true, // Flag indicating this is real data
          }
        } catch (err) {
          console.warn(`[v0] Failed to get progression for ${conn.id}:`, err)
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning: false,
            engineState: 'error',
            tradeCount: 0,
            pseudoPositionCount: 0,
            prehistoricDataLoaded: false,
            lastUpdate: null,
            cycleMetrics: null,
            error: err instanceof Error ? err.message : String(err),
            realTimeData: false,
          }
        }
      })
    )
    
    console.log(`[v0] Returned real-time progression data for ${progressionData.length} connections`)
    return NextResponse.json({
      success: true,
      connections: progressionData,
      totalConnections: progressionData.length,
      runningEngines: progressionData.filter(c => c.isEngineRunning).length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to fetch progression:", error)
    await SystemLogger.logError(error, "api", "GET /api/trade-engine/progression")
    return NextResponse.json({ 
      success: false,
      error: "Failed to fetch progression",
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
