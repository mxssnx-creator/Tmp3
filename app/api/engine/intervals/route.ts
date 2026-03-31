import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    
    await initRedis()
    
    // Get engine state for this connection
    const engState = await getSettings(`trade_engine_state:${id}`)
    const engHealth = await getSettings(`trade_engine_health:${id}`)
    
    // Extract interval/timing metrics from engine state
    const lastIndicationRun = (engState as any)?.last_indication_run || 0
    const lastStrategyRun = (engState as any)?.last_strategy_run || 0
    const now = Date.now()
    
    // Determine if intervals are "running" (ran within last 30 seconds)
    const indicationRunning = (now - lastIndicationRun) < 30000
    const strategyRunning = (now - lastStrategyRun) < 30000
    
    return NextResponse.json({
      connectionId: id,
      intervals: {
        indication: {
          running: indicationRunning,
          lastRun: lastIndicationRun,
          cycleCount: (engState as any)?.indication_cycle_count || 0,
        },
        strategy: {
          running: strategyRunning,
          lastRun: lastStrategyRun,
          cycleCount: (engState as any)?.strategy_cycle_count || 0,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [MonitoringIntervals] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch intervals status" },
      { status: 500 }
    )
  }
}
