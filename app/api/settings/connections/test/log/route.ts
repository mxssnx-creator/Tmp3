import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    const allConnections = await getAllConnections()
    const activeConnections = allConnections.filter((c: any) => c.is_assigned === "1")
    
    const summary: any = {
      enginePerformance: {
        cyclesCompleted: 0,
        cycleSuccessRate: 100,
        cycleTimeMs: 0,
      },
      prehistoricData: {
        symbolsProcessed: 0,
        candlesProcessed: 0,
        phaseActive: false,
        cyclesCompleted: 0,
      },
      indicationsCounts: {},
      strategyCounts: {},
      activeConnections: activeConnections.length,
    }

    for (const conn of activeConnections) {
      // Get engine state
      const engineStateRaw = await client.get(`settings:trade_engine_state:${conn.id}`)
      if (engineStateRaw) {
        try {
          const engineState = JSON.parse(engineStateRaw)
          summary.enginePerformance.cyclesCompleted += Number(engineState.indication_cycle_count) || 0
          summary.enginePerformance.cycleTimeMs = Math.max(summary.enginePerformance.cycleTimeMs, Number(engineState.last_cycle_duration) || 0)
        } catch {}
      }

      // Get prehistoric data status
      const prehistoricKeys = await client.keys(`prehistoric:${conn.id}:*`)
      summary.prehistoricData.symbolsProcessed += await client.scard(`prehistoric:${conn.id}:symbols`).catch(() => 0)
      summary.prehistoricData.candlesProcessed += prehistoricKeys.length
      summary.prehistoricData.cyclesCompleted += Number(await client.get(`prehistoric:${conn.id}:cycles`).catch(() => 0))
      
      // Check if prehistoric phase is still active
      const prehistoricStatus = await client.get(`prehistoric:${conn.id}:status`)
      if (prehistoricStatus === "running") {
        summary.prehistoricData.phaseActive = true
      }

      // Count indications
      const indicationTypes = ['direction', 'move', 'active', 'optimal', 'auto']
      for (const type of indicationTypes) {
        const count = Number(await client.get(`indications:${conn.id}:${type}:count`).catch(() => 0))
        if (count > 0) {
          summary.indicationsCounts[type] = (summary.indicationsCounts[type] || 0) + count
        }
      }

      // Count strategies
      const strategyTypes = ['base', 'main', 'real']
      for (const type of strategyTypes) {
        const count = Number(await client.get(`strategies:${conn.id}:${type}:evaluated`).catch(() => 0))
        if (count > 0) {
          summary.strategyCounts[type] = (summary.strategyCounts[type] || 0) + count
        }
      }
    }

    // Calculate success rate
    const totalCycles = summary.enginePerformance.cyclesCompleted
    if (totalCycles > 0) {
      const failedCycles = Number(await client.get(`trade_engine:failed_cycles`).catch(() => 0))
      summary.enginePerformance.cycleSuccessRate = Math.round(((totalCycles - failedCycles) / totalCycles) * 100)
    }

    return NextResponse.json({
      success: true,
      summary,
      connections: activeConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        isActive: c.is_active === "1",
        isLiveTrade: c.is_live_trade === "1",
      }))
    })

  } catch (error) {
    console.error("[Connections Test Log] Error:", error)
    return NextResponse.json({
      success: false,
      summary: {
        enginePerformance: { cyclesCompleted: 0, cycleSuccessRate: 0, cycleTimeMs: 0 },
        prehistoricData: { symbolsProcessed: 0, candlesProcessed: 0, phaseActive: false, cyclesCompleted: 0 },
        indicationsCounts: {},
        strategyCounts: {},
      }
    })
  }
}
