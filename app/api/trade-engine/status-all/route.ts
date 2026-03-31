import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadConnections } from "@/lib/file-storage"
import { SystemLogger } from "@/lib/system-logger"

export async function GET() {
  try {
    console.log("[v0] Fetching all trade engine statuses")

    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Null check on coordinator
    if (!coordinator) {
      console.warn("[v0] Coordinator is null - engines may not be initialized yet")
      return NextResponse.json({
        success: false,
        error: "Trade engine coordinator not initialized",
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
        timestamp: new Date().toISOString(),
      }, { status: 503 })
    }

    const connections = loadConnections()
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
        timestamp: new Date().toISOString(),
      }, { status: 500 })
    }

    const activeConnections = connections.filter((c) => c.is_active && c.is_enabled)

    const engineStatuses = await Promise.all(
      activeConnections.map(async (conn) => {
        try {
          const status = await coordinator.getEngineStatus(conn.id)
          const isRunning = status !== null

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning: isRunning,
            engineStatus: status,
          }
        } catch (error) {
          console.error(`[v0] Failed to get status for ${conn.id}:`, error)
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            isEnabled: conn.is_enabled,
            isActive: conn.is_active,
            isLiveTrading: conn.is_live_trade,
            isEngineRunning: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      })
    )

    const runningCount = engineStatuses.filter((s) => s.isEngineRunning).length
    const totalCount = engineStatuses.length

    console.log(`[v0] Engine status: ${runningCount}/${totalCount} running`)

    return NextResponse.json({
      success: true,
      engines: engineStatuses,
      summary: {
        total: totalCount,
        running: runningCount,
        stopped: totalCount - runningCount,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to fetch engine statuses:", error)
    await SystemLogger.logError(error, "trade-engine", "GET /api/trade-engine/status-all")

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch engine statuses",
        details: error instanceof Error ? error.message : String(error),
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
      },
      { status: 500 }
    )
  }
}
