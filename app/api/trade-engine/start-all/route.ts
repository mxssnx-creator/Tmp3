import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { initRedis, getAllConnections, getSettings } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

export async function GET() {
  try {
    const coordinator = getGlobalTradeEngineCoordinator()
    
    if (!coordinator) {
      console.warn("[v0] [START-ALL] Coordinator is null")
      return NextResponse.json({
        success: false,
        error: "Trade engine coordinator not initialized",
        results: [],
      }, { status: 503 })
    }

    await initRedis()
    const connections = await getAllConnections()
    
    if (!Array.isArray(connections)) {
      console.error("[v0] [START-ALL] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        results: [],
      }, { status: 500 })
    }

    // Filter for ONLY connections that are BOTH inserted AND enabled
    // These are the ones displayed in "Active Connections"
    const activeConnections = connections.filter((c: any) => {
      const isInserted = c.is_inserted === "1" || c.is_inserted === true
      const isEnabled = c.is_enabled === "1" || c.is_enabled === true
      const hasLiveTrade = c.is_live_trade === "1" || c.is_live_trade === true
      return isInserted && isEnabled && hasLiveTrade
    })

    console.log(`[v0] [START-ALL] Total: ${connections.length}, Active: ${activeConnections.length}, With LiveTrade: ${activeConnections.length}`)

    if (activeConnections.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No active connections with live trade enabled",
        totalConnections: connections.length,
        activeConnections: 0,
        results: [],
      })
    }

    const settings = (await getSettings("trade_engine_settings")) || {}
    const indicationInterval = settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1
    const strategyInterval = settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1
    const realtimeInterval = settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.2

    const results = []
    let successCount = 0

    for (const connection of activeConnections) {
      try {
        console.log(`[v0] [START-ALL] Starting engine for: ${connection.name}`)

        await coordinator.startEngine(connection.id, {
          connectionId: connection.id,
          indicationInterval,
          strategyInterval,
          realtimeInterval,
        })

        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          exchange: connection.exchange,
          success: true,
          message: "Engine started successfully",
        })

        successCount++
      } catch (error) {
        console.error(`[v0] [START-ALL] Failed to start ${connection.name}:`, error)

        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          exchange: connection.exchange,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    console.log(`[v0] [START-ALL] Complete: ${successCount}/${activeConnections.length} started`)

    return NextResponse.json({
      success: true,
      message: `Started ${successCount} of ${activeConnections.length} trade engines`,
      totalConnections: connections.length,
      activeConnections: activeConnections.length,
      successCount,
      results,
    })
  } catch (error) {
    console.error("[v0] [START-ALL] Error:", error)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to start trade engines",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
