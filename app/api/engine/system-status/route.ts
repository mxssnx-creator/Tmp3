import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

/**
 * GET /api/engine/system-status
 * Returns comprehensive system health including:
 * - Active connections
 * - Indication processing status
 * - Strategy evaluation status
 * - Recent errors and performance metrics
 */
export async function GET() {
  try {
    await initRedis()

    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) => c.is_enabled === "1" && c.is_inserted === "1")

    // Get engine state for first active connection
    const connectionId = activeConnections[0]?.id || "unknown"
    const engineState = (await getSettings(`trade_engine_state:${connectionId}`)) || {}

    const status = {
      timestamp: new Date().toISOString(),
      system: {
        totalConnections: connections.length,
        activeConnections: activeConnections.length,
        activeConnectionNames: activeConnections.map((c: any) => c.name || c.exchange),
      },
      indication: {
        lastRun: engineState.last_indication_run,
        cycleCount: engineState.indication_cycle_count || 0,
        avgDurationMs: Math.round(engineState.indication_avg_duration_ms || 0),
        status: engineState.indication_cycle_count > 0 ? "running" : "idle",
      },
      strategy: {
        lastRun: engineState.last_strategy_run,
        cycleCount: engineState.strategy_cycle_count || 0,
        avgDurationMs: Math.round(engineState.strategy_avg_duration_ms || 0),
        totalEvaluated: engineState.total_strategies_evaluated || 0,
        status: engineState.strategy_cycle_count > 0 ? "running" : "idle",
      },
      recommendation: getRecommendation(activeConnections, engineState),
    }

    await logProgressionEvent(connectionId, "system_status_check", "info", "System status report generated", status)

    return NextResponse.json(status, { status: 200 })
  } catch (error) {
    console.error("[v0] [SystemStatus] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

function getRecommendation(activeConnections: any[], engineState: any): string {
  if (activeConnections.length === 0) {
    return "No active connections. Use quick-start to enable a connection."
  }
  if (!engineState.indication_cycle_count) {
    return "Indication engine not running. Check connection and restart."
  }
  if (!engineState.strategy_cycle_count) {
    return "Strategy engine not running. Check indication processor output."
  }
  if (engineState.total_strategies_evaluated === 0) {
    return "Strategies being evaluated but none passing evaluation yet. Check thresholds."
  }
  return "System healthy and processing strategies."
}
