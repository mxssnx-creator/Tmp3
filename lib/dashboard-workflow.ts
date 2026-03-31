import { getAllConnections, getConnectionPositions, getConnectionTrades, getRedisClient, getSettings, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionEligibleForEngine,
  isConnectionInActivePanel,
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
} from "@/lib/connection-state-utils"

type WorkflowConnection = {
  id: string
  name: string
  exchange: string
  hasCredentials: boolean
  isActivePanel: boolean
  isDashboardEnabled: boolean
  liveTradeEnabled: boolean
  presetTradeEnabled: boolean
  testStatus: string
}


const SNAPSHOT_TTL_MS = 1000
let cachedSnapshot: any | null = null
let cachedSnapshotAt = 0
let snapshotInFlight: Promise<any> | null = null

export async function getDashboardWorkflowSnapshot() {
  const now = Date.now()
  if (cachedSnapshot && now - cachedSnapshotAt < SNAPSHOT_TTL_MS) {
    return cachedSnapshot
  }

  if (snapshotInFlight) {
    return snapshotInFlight
  }

  snapshotInFlight = buildDashboardWorkflowSnapshot()

  try {
    const snapshot = await snapshotInFlight
    cachedSnapshot = snapshot
    cachedSnapshotAt = Date.now()
    return snapshot
  } finally {
    snapshotInFlight = null
  }
}

async function buildDashboardWorkflowSnapshot() {
  await initRedis()

  const client = getRedisClient()
  const allConnections = await getAllConnections()
  const globalState = await client.hgetall("trade_engine:global")
  const globalStatus = globalState?.status || "stopped"

  const normalizedConnections: WorkflowConnection[] = allConnections.map((connection: any) => {
    return {
      id: connection.id,
      name: connection.name || connection.exchange || connection.id,
      exchange: connection.exchange || "unknown",
      hasCredentials: hasConnectionCredentials(connection, 10),
      isActivePanel: isConnectionInActivePanel(connection),
      isDashboardEnabled: isConnectionDashboardEnabled(connection),
      liveTradeEnabled: isConnectionLiveTradeEnabled(connection),
      presetTradeEnabled: isConnectionPresetTradeEnabled(connection),
      testStatus: connection.last_test_status || connection.test_status || "untested",
    }
  })

  const eligibleConnections = allConnections.filter((connection: any) => isConnectionEligibleForEngine(connection))
  const eligibleIds = new Set(eligibleConnections.map((conn: any) => conn.id))

  const focusConnection =
    normalizedConnections.find((conn) => eligibleIds.has(conn.id)) ||
    normalizedConnections.find((conn) => conn.isActivePanel && conn.isDashboardEnabled) ||
    normalizedConnections.find((conn) => conn.isActivePanel) ||
    normalizedConnections[0] ||
    null

  let connectionMetrics = {
    progression: null as null | Awaited<ReturnType<typeof ProgressionStateManager.getProgressionState>>,
    positions: 0,
    trades: 0,
    logs: [] as Awaited<ReturnType<typeof getProgressionLogs>>,
    engineCycles: { indication: 0, strategy: 0, realtime: 0, total: 0 },
    engineDurations: { indicationAvgMs: 0, strategyAvgMs: 0, realtimeAvgMs: 0 },
    comprehensiveStats: null as null | {
      symbols: { prehistoricLoaded: number; prehistoricDataSize: number; intervalsProcessed: number }
      indicationsByType: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
      pseudoPositions: { base: number; main: number; real: number; total: number }
      livePositions: number
    }
  }

  if (focusConnection) {
    const [progression, positions, trades, logs, engineState] = await Promise.all([
      ProgressionStateManager.getProgressionState(focusConnection.id),
      getConnectionPositions(focusConnection.id),
      getConnectionTrades(focusConnection.id),
      getProgressionLogs(focusConnection.id),
      getSettings(`trade_engine_state:${focusConnection.id}`),
    ])

    // Gather comprehensive stats for the focus connection
    const connId = focusConnection.id
    
    // Get indications by type
    const directionIndications = await client.scard(`indications:${connId}:direction`).catch(() => 0)
    const moveIndications = await client.scard(`indications:${connId}:move`).catch(() => 0)
    const activeIndications = await client.scard(`indications:${connId}:active`).catch(() => 0)
    const optimalIndications = await client.scard(`indications:${connId}:optimal`).catch(() => 0)
    const autoIndications = await client.scard(`indications:${connId}:auto`).catch(() => 0)
    
    // Get pseudo positions by type
    const basePseudoPositions = await client.scard(`base_pseudo:${connId}`).catch(() => 0)
    const mainPseudoPositions = await client.scard(`main_pseudo:${connId}`).catch(() => 0)
    const realPseudoPositions = await client.scard(`real_pseudo:${connId}`).catch(() => 0)
    
    // Get live positions
    const livePositionsCount = await client.scard(`positions:${connId}:live`).catch(() => 0)
    
    // Get prehistoric data info
    const prehistoricSymbols = await client.scard(`prehistoric:${connId}:symbols`).catch(() => 0)
    let prehistoricDataSize = 0
    try {
      const keys = await client.keys(`prehistoric:${connId}:*`)
      prehistoricDataSize = keys.length
    } catch { /* ignore */ }
    
    // Get intervals processed
    const intervalsProcessed = await client.scard(`intervals:${connId}:processed`).catch(() => 0)
    
    connectionMetrics = {
      progression,
      positions: positions.length,
      trades: trades.length,
      logs: logs.slice(0, 50),
      engineCycles: {
        indication: Number((engineState as any)?.indication_cycle_count || 0),
        strategy: Number((engineState as any)?.strategy_cycle_count || 0),
        realtime: Number((engineState as any)?.realtime_cycle_count || 0),
        total:
          Number((engineState as any)?.indication_cycle_count || 0) +
          Number((engineState as any)?.strategy_cycle_count || 0) +
          Number((engineState as any)?.realtime_cycle_count || 0),
      },
      engineDurations: {
        indicationAvgMs: Number((engineState as any)?.indication_avg_duration_ms || 0),
        strategyAvgMs: Number((engineState as any)?.strategy_avg_duration_ms || 0),
        realtimeAvgMs: Number((engineState as any)?.realtime_avg_duration_ms || 0),
      },
      // Comprehensive stats
      comprehensiveStats: {
        symbols: {
          prehistoricLoaded: prehistoricSymbols,
          prehistoricDataSize,
          intervalsProcessed,
        },
        indicationsByType: {
          direction: directionIndications,
          move: moveIndications,
          active: activeIndications,
          optimal: optimalIndications,
          auto: autoIndications,
          total: directionIndications + moveIndications + activeIndications + optimalIndications + autoIndications,
        },
        pseudoPositions: {
          base: basePseudoPositions,
          main: mainPseudoPositions,
          real: realPseudoPositions,
          total: basePseudoPositions + mainPseudoPositions + realPseudoPositions,
        },
        livePositions: livePositionsCount,
      },
    }
  }

  const [recentGlobalLogs, quickstartStateRaw] = await Promise.all([
    getProgressionLogs("global"),
    client.get("quickstart:last_run").catch(() => null),
  ])
  let quickstartState: null | {
    connectionId?: string
    connectionName?: string
    exchange?: string
    timestamp?: string
    durationMs?: number
  } = null
  if (quickstartStateRaw) {
    try {
      quickstartState = JSON.parse(quickstartStateRaw as string)
    } catch {
      quickstartState = null
    }
  }

  const workflowPhases = [
    {
      id: "credentials",
      label: "Credentials",
      status: normalizedConnections.some((conn) => conn.hasCredentials) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.hasCredentials)
        ? "API credentials detected for at least one connection"
        : "Add API key and secret in Settings to unlock exchange-backed processing",
    },
    {
      id: "active-panel",
      label: "Active Panel",
      status: normalizedConnections.some((conn) => conn.isActivePanel) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.isActivePanel)
        ? "Connection is inserted into the dashboard active panel"
        : "Use Add Connection or Quick Start to insert a connection into the active panel",
    },
    {
      id: "dashboard-enable",
      label: "Dashboard Enable",
      status: normalizedConnections.some((conn) => conn.isDashboardEnabled) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.isDashboardEnabled)
        ? "Dashboard enable toggle is active for at least one connection"
        : "Toggle Enable on an active connection to start engine-side processing",
    },
    {
      id: "global-engine",
      label: "Global Engine",
      status: globalStatus === "running" ? "complete" : globalStatus === "paused" ? "warning" : "pending",
      detail:
        globalStatus === "running"
          ? "Global coordinator is running"
          : globalStatus === "paused"
            ? "Global coordinator is paused"
            : "Start the global coordinator to begin processing cycles",
    },
    {
      id: "engine-eligible",
      label: "Eligible Processing",
      status: eligibleConnections.length > 0 ? "complete" : normalizedConnections.length > 0 ? "warning" : "pending",
      detail:
        eligibleConnections.length > 0
          ? `${eligibleConnections.length} connection(s) currently eligible for engine processing`
          : normalizedConnections.length > 0
            ? "Connections exist but none currently satisfy all engine eligibility checks"
            : "No connections configured yet",
    },
  ]

  return {
    timestamp: new Date().toISOString(),
    globalStatus,
    overview: {
      totalConnections: normalizedConnections.length,
      activePanelConnections: normalizedConnections.filter((conn) => conn.isActivePanel).length,
      dashboardEnabledConnections: normalizedConnections.filter((conn) => conn.isDashboardEnabled).length,
      eligibleEngineConnections: eligibleConnections.length,
      liveTradeConnections: normalizedConnections.filter((conn) => conn.liveTradeEnabled).length,
      presetTradeConnections: normalizedConnections.filter((conn) => conn.presetTradeEnabled).length,
    },
    workflowPhases,
    focusConnection,
    connectionMetrics,
    recentGlobalLogs: recentGlobalLogs.slice(0, 20),
    quickstartState,
  }
}
