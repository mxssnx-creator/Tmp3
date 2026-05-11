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

    // Get engine state for first active connection.
    //
    // Canonical key per the dual-progression audit (see
    // `v0_plans/comprehensive-system-audit.md`, item 5):
    //   • last_*_run + *_avg_duration_ms       → trade_engine_state:{id}  (heartbeat / health)
    //   • *_cycle_count + total_strategies_evaluated → progression:{id}    (atomic counters)
    //
    // Previously every cycle counter on this route was read from
    // `trade_engine_state` only, which held a *snapshot* written at most
    // once per cycle and lagged the authoritative atomic counters in
    // `progression:{id}`. After a watchdog re-arm the snapshot can stay
    // empty for many seconds while progression keeps incrementing —
    // visually freezing this status surface and producing false
    // "engine not running" recommendations. We now read the counters
    // from `progression:` first and fall back to `trade_engine_state` so
    // the response stays correct on legacy data.
    const connectionId = activeConnections[0]?.id || "unknown"
    const engineState = (await getSettings(`trade_engine_state:${connectionId}`)) || {}
    const progression = (await getSettings(`progression:${connectionId}`)) || {}

    const indicationCycles =
      Number((progression as any).indication_cycle_count) ||
      Number(engineState.indication_cycle_count) || 0
    const strategyCycles =
      Number((progression as any).strategy_cycle_count) ||
      Number(engineState.strategy_cycle_count) || 0
    const totalStrategiesEvaluated =
      Number((progression as any).total_strategies_evaluated) ||
      Number(engineState.total_strategies_evaluated) || 0

    const status = {
      timestamp: new Date().toISOString(),
      system: {
        totalConnections: connections.length,
        activeConnections: activeConnections.length,
        activeConnectionNames: activeConnections.map((c: any) => c.name || c.exchange),
      },
      indication: {
        lastRun: engineState.last_indication_run,
        cycleCount: indicationCycles,
        avgDurationMs: Math.round(engineState.indication_avg_duration_ms || 0),
        status: indicationCycles > 0 ? "running" : "idle",
      },
      strategy: {
        lastRun: engineState.last_strategy_run,
        cycleCount: strategyCycles,
        avgDurationMs: Math.round(engineState.strategy_avg_duration_ms || 0),
        totalEvaluated: totalStrategiesEvaluated,
        status: strategyCycles > 0 ? "running" : "idle",
      },
      recommendation: getRecommendation(activeConnections, {
        indication_cycle_count: indicationCycles,
        strategy_cycle_count: strategyCycles,
        total_strategies_evaluated: totalStrategiesEvaluated,
      }),
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
