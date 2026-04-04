import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getRedisClient, getRedisRequestsPerSecond } from "@/lib/redis-db"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionInActivePanel,
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
  isConnectionWorking,
  isTruthyFlag,
} from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

// Main/base connection scope for dashboard metrics.
const BASE_EXCHANGES = ["bybit", "bingx"]

function isBaseExchange(c: any): boolean {
  return BASE_EXCHANGES.includes((c?.exchange || "").toLowerCase().trim())
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Ensure default connections exist before fetching stats
    const allConnections = await getAllConnections()
    if (allConnections.length === 0) {
      console.log("[v0] [SystemStats] No connections, triggering seed...")
      const { ensureDefaultExchangesExist } = await import("@/lib/default-exchanges-seeder")
      await ensureDefaultExchangesExist()
    }
    
    const connections = await getAllConnections()
    console.log(`[v0] [SystemStats] Analyzing ${connections.length} total connections`)
    
    // BASE CONNECTIONS = All base exchange connections (predefined or user-created)
    // that are marked as enabled (is_enabled=1) in Settings
    const baseConnections = connections.filter((c: any) => isBaseExchange(c))
    const enabledBase = baseConnections.filter((c: any) => isTruthyFlag(c.is_enabled))
    console.log(`[v0] [SystemStats] Base connections: ${baseConnections.length}, enabled: ${enabledBase.length}`)
    
    // ACTIVE PANEL = Connections marked as active-inserted (shown in Active Connections panel)
    // These can be predefined templates OR user-created connections
    const activeInsertedAll = connections.filter((c: any) => isConnectionInActivePanel(c))
    console.log(`[v0] [SystemStats] In Active panel: ${activeInsertedAll.length}`)
    
    // ENABLED ON DASHBOARD = Active connections that user has toggled ON
    const enabledDashboard = activeInsertedAll.filter((c: any) => isConnectionDashboardEnabled(c))
    console.log(`[v0] [SystemStats] Enabled on dashboard: ${enabledDashboard.length}`)
    
    // WORKING = Connections where API test succeeded
    const workingAll = allConnections.filter((c: any) => isConnectionWorking(c))
    console.log(`[v0] [SystemStats] Working/tested: ${workingAll.length}`)
    
    // Get total Redis keys count - same pattern as monitoring route
    const allRedisKeys = await client.keys("*").catch(() => [])
    const totalKeys = Array.isArray(allRedisKeys) ? allRedisKeys.length : 0
    console.log(`[v0] [SystemStats] Total DB keys: ${totalKeys}`)

    // Trade Engine Status from Redis (stored as hash, not string)
    let globalEngineState: any = {}
    try {
      // trade_engine:global is stored as a hash using hset, so use hgetall
      const hashData = await client.hgetall("trade_engine:global")
      globalEngineState = hashData && Object.keys(hashData).length > 0 ? hashData : {}
    } catch {
      globalEngineState = {}
    }
    const globalStatus = globalEngineState.status || "stopped"

    // Main Connections: base connections that are either inserted OR in active panel
    const mainConnections = baseConnections.filter((c: any) => {
      const isInserted = isTruthyFlag(c.is_inserted)
      const isActiveInserted = isConnectionInActivePanel(c)
      return isInserted || isActiveInserted
    })
    const mainEnabled = mainConnections.length > 0
    
    // Live Trade: runs independently when is_live_trade=true (for real exchange position mirroring)
    // Does NOT require Main Engine to be running
    const liveTradeConnections = connections.filter((c: any) => isConnectionLiveTradeEnabled(c))
    const liveTradeEnabled = liveTradeConnections.length > 0
    
    // Preset: runs independently when is_preset_trade=true (for preset strategies)
    const presetTradeConnections = connections.filter((c: any) => isConnectionPresetTradeEnabled(c))
    const presetTradeEnabled = presetTradeConnections.length > 0
    
    // Main Engine status: running when main_enabled, regardless of live/preset
    const mainStatus = mainEnabled 
      ? "running" 
      : "stopped"
    
    // Live Trade status: independent - running when enabled
    const liveTradeStatus = liveTradeEnabled
      ? "running"
      : "stopped"
    
    // Preset status: independent - running when enabled  
    const presetStatus = presetTradeEnabled
      ? "running"
      : "stopped"
    
    // Connections with valid credentials (can actually trade)
    const connectionsWithCredentials = baseConnections.filter((c: any) => hasConnectionCredentials(c, 10))
    console.log(`[v0] [SystemStats] Connections with valid credentials: ${connectionsWithCredentials.length}`)
    
    // EXCHANGE CONNECTIONS = Base connections that are inserted (either is_inserted=1 OR is_active_inserted=1)
    // These are connections visible to the user, regardless of panel placement
    const insertedBaseConnections = baseConnections.filter((c: any) => {
      const isInserted = isTruthyFlag(c.is_inserted)
      const isActiveInserted = isConnectionInActivePanel(c)
      return isInserted || isActiveInserted
    })
    console.log(`[v0] [SystemStats] Exchange connections (inserted as cards): ${insertedBaseConnections.length}`)
    
    // Exchange status: healthy if connections with credentials exist, otherwise waiting for credentials
    const exchangeStatus = 
      connectionsWithCredentials.length > 0 ? "healthy" :
      insertedBaseConnections.length > 0 ? "waiting" :
      baseConnections.length > 0 ? "partial" : "down"

    const workflow = await getDashboardWorkflowSnapshot()
    
    console.log(`[v0] [SystemStats] Response: exchangeConnections.total=${insertedBaseConnections.length}, debug: base=${baseConnections.length}, enabled=${enabledBase.length}, inserted=${insertedBaseConnections.length}`)
    
    return NextResponse.json({
      success: true,
      tradeEngines: {
        globalStatus,
        mainStatus,
        mainCount: mainConnections.length,
        mainTotal: activeInsertedAll.length,
        mainEnabled,  // Whether Main Engine is enabled
        liveTradeStatus,
        liveTradeCount: liveTradeConnections.length,
        liveTradeEnabled,
        presetStatus,
        presetCount: presetTradeConnections.length,
        presetTotal: activeInsertedAll.length,
        presetEnabled: presetTradeEnabled,
        totalEnabled: mainConnections.length + liveTradeConnections.length + presetTradeConnections.length,
      },
      database: {
        status: "healthy",
        requestsPerSecond: getRedisRequestsPerSecond(),
        totalKeys,
      },
      exchangeConnections: {
        // Exchange connections = inserted base connections (independent of credentials)
        total: insertedBaseConnections.length,
        enabled: insertedBaseConnections.filter((c: any) => isTruthyFlag(c.is_enabled)).length,
        working: insertedBaseConnections.filter((c: any) => isConnectionWorking(c)).length,
        withCredentials: connectionsWithCredentials.length,
        status: exchangeStatus,
      },
      activeConnections: {
        // Active panel connections
        total: workflow.overview.activePanelConnections,
        active: workflow.overview.dashboardEnabledConnections,
        liveTrade: workflow.overview.liveTradeConnections,
        presetTrade: workflow.overview.presetTradeConnections,
      },
      // Available connections = enabled base connections NOT yet in Active panel
      availableConnections: enabledBase.filter((c: any) => !isConnectionInActivePanel(c)).length,
      liveTrades: {
        lastHour: 0,
        topConnections: [],
      },
      cycleStats: {
        cycleCount: workflow.connectionMetrics.engineCycles?.total || workflow.connectionMetrics.progression?.cyclesCompleted || 0,
        indicationCycles: workflow.connectionMetrics.engineCycles?.indication || 0,
        strategyCycles: workflow.connectionMetrics.engineCycles?.strategy || 0,
        cycleDurationMs: workflow.connectionMetrics.engineDurations?.indicationAvgMs || 0,
      },
      totalPositions: workflow.connectionMetrics.positions,
      totalTrades: workflow.connectionMetrics.trades,
      workflowOverview: workflow.overview,
      workflowPhases: workflow.workflowPhases,
      // DEBUG: Help understand what's being counted
      _debug: {
        baseConnectionsTotal: baseConnections.length,
        baseConnectionsEnabled: enabledBase.length,
        insertedBaseConnectionsCount: insertedBaseConnections.length,
        activeInsertedAllCount: activeInsertedAll.length,
      }
    })
  } catch (error) {
    console.error("[v0] [System Stats v3] ERROR:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch system stats" },
      { status: 500 }
    )
  }
}
