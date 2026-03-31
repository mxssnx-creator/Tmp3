import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSettings } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadConnections } from "@/lib/file-storage"

/**
 * Comprehensive Engine System Verification
 * Returns detailed status of: prehistoric data, indications, strategies, realtime, live trading
 */
export async function GET() {
  try {
    const coordinator = getGlobalTradeEngineCoordinator()
    const connections = loadConnections()
    const activeConnections = connections.filter((c) => c.is_active === true)

    console.log("[v0] [SystemVerify] Starting comprehensive verification...")

    const systemStatus = {
      timestamp: new Date().toISOString(),
      coordinatorRunning: coordinator.isRunning(),
      activeConnectionCount: activeConnections.length,
      components: [] as any[],
      verification: {
        allPhasesPassing: true,
        issues: [] as string[],
        warnings: [] as string[],
      },
    }

    // Verify each active connection
    for (const conn of activeConnections) {
      console.log(`[v0] [SystemVerify] Verifying ${conn.name} (${conn.exchange})...`)

      const engineStatus = await coordinator.getEngineStatus(conn.id)
      const engineState = await getSettings(`trade_engine_state:${conn.id}`)

      // Get progression data
      const progressionState = await getSettings(`progression:${conn.id}`)
      const cycleData = await getSettings(`engine:indications:stats`)
      const strategyStats = await getSettings(`engine:strategies:stats`)

      // Get database metrics
      const trades = await query<{ count: number }>(
        "SELECT COUNT(*) as count FROM trades WHERE connection_id = ?",
        [conn.id]
      ).catch(() => [{ count: 0 }])

      const pseudoPositions = await query<{ count: number }>(
        "SELECT COUNT(*) as count FROM pseudo_positions WHERE connection_id = ?",
        [conn.id]
      ).catch(() => [{ count: 0 }])

      const indications = await query<{ count: number }>(
        "SELECT COUNT(*) as count FROM indications WHERE connection_id = ? AND created_at > datetime('now', '-1 hour')",
        [conn.id]
      ).catch(() => [{ count: 0 }])

      const strategies = await query<{ count: number }>(
        "SELECT COUNT(*) as count FROM strategies WHERE connection_id = ? AND created_at > datetime('now', '-1 hour')",
        [conn.id]
      ).catch(() => [{ count: 0 }])

      const status = {
        connectionId: conn.id,
        connectionName: conn.name,
        exchange: conn.exchange,
        engineRunning: engineStatus !== null,
        isTestnet: conn.is_testnet === true,
        phases: {
          prehistoric: {
            completed: engineState?.prehistoric_data_loaded === true || engineState?.prehistoric_data_loaded === "1",
            startDate: engineState?.prehistoric_data_start,
            endDate: engineState?.prehistoric_data_end,
            progressionCycles: progressionState?.prehistoric_cycles_completed || 0,
          },
          indications: {
            processing: engineStatus !== null,
            cycleCount: engineState?.indication_cycle_count || cycleData?.cycleCount || 0,
            avgDurationMs: engineState?.indication_avg_duration_ms || 0,
            successRate: progressionState?.cycle_success_rate || "0%",
            lastRun: engineState?.last_indication_run,
            recentRecords: indications[0]?.count || 0,
          },
          strategies: {
            processing: engineStatus !== null,
            cycleCount: engineState?.strategy_cycle_count || strategyStats?.cycleCount || 0,
            avgDurationMs: engineState?.strategy_avg_duration_ms || 0,
            totalEvaluated: engineState?.total_strategies_evaluated || 0,
            lastRun: engineState?.last_strategy_run,
            recentRecords: strategies[0]?.count || 0,
          },
          realtime: {
            processing: engineStatus !== null,
            cycleCount: engineState?.realtime_cycle_count || 0,
            avgDurationMs: engineState?.realtime_avg_duration_ms || 0,
            lastRun: engineState?.last_realtime_run,
          },
          liveTrading: {
            active: engineStatus !== null,
            tradesTotal: trades[0]?.count || 0,
            pseudoPositions: pseudoPositions[0]?.count || 0,
            status: engineState?.status || "idle",
          },
        },
        metrics: {
          successRate: progressionState?.cycle_success_rate || "0%",
          totalCycles: progressionState?.cycles_completed || 0,
          successfulCycles: progressionState?.successful_cycles || 0,
          failedCycles: progressionState?.failed_cycles || 0,
        },
      }

      // Verification checks
      if (!engineStatus) {
        systemStatus.verification.issues.push(`${conn.name}: Engine not running`)
        systemStatus.verification.allPhasesPassing = false
      }

      if (!status.phases.prehistoric.completed) {
        systemStatus.verification.warnings.push(`${conn.name}: Prehistoric data not loaded yet`)
      }

      if ((cycleData?.cycleCount || 0) === 0) {
        systemStatus.verification.issues.push(`${conn.name}: No indication cycles detected`)
        systemStatus.verification.allPhasesPassing = false
      }

      if ((indications[0]?.count || 0) < 10) {
        systemStatus.verification.warnings.push(`${conn.name}: Low indication activity (${indications[0]?.count} recent)`)
      }

      if ((strategies[0]?.count || 0) < 5) {
        systemStatus.verification.warnings.push(`${conn.name}: Low strategy activity (${strategies[0]?.count} recent)`)
      }

      systemStatus.components.push(status)
    }

    // Global verification
    if (!coordinator.isRunning()) {
      systemStatus.verification.issues.push("Global coordinator not running")
      systemStatus.verification.allPhasesPassing = false
    }

    if (activeConnections.length === 0) {
      systemStatus.verification.warnings.push("No active connections configured")
    }

    console.log("[v0] [SystemVerify] Verification complete:", {
      passing: systemStatus.verification.allPhasesPassing,
      issues: systemStatus.verification.issues.length,
      warnings: systemStatus.verification.warnings.length,
    })

    return NextResponse.json(systemStatus)
  } catch (error) {
    console.error("[v0] [SystemVerify] Verification failed:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Verification failed",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
