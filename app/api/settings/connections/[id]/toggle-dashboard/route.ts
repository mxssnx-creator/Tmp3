import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, updateConnection, setSettings, getSettings, getAllConnections, 
  getConnectionState, buildMainConnectionEnableUpdate, buildMainConnectionDisableUpdate,
  isConnectionReadyForEngine, getRedisClient } from "@/lib/redis-db"
import { toggleConnectionLimiter } from "@/lib/connection-rate-limiter"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { isTruthyFlag, parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"

// POST toggle connection active status (inserted/enabled) - INDEPENDENT from Settings
// When enabling, also triggers engine start for this connection
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()
    
    // Check rate limit using systemwide limiter
    const limitResult = await toggleConnectionLimiter.checkLimit(connectionId)
    
    if (!limitResult.allowed) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum 30 toggle requests per minute. Retry after ${limitResult.retryAfter} seconds.`,
          retryAfter: limitResult.retryAfter,
          resetTime: limitResult.resetTime,
        },
        { status: 429, headers: { "Retry-After": String(limitResult.retryAfter) } }
      )
    }
    
    // Support both active fields:
    // - is_active_inserted: whether connection appears in active list
    // - is_enabled_dashboard: whether connection is enabled/active
    const hasActiveInserted = body?.is_active_inserted !== undefined
    const hasDashboardEnabled = body?.is_enabled_dashboard !== undefined
    const isActiveInserted = parseBooleanInput(body?.is_active_inserted)
    const isDashboardEnabled = parseBooleanInput(body?.is_enabled_dashboard)

    await initRedis()
    let connection = await getConnection(connectionId)
    let resolvedId = connectionId

    // Fallback: try with conn- prefix if not found (handles predefined IDs like bybit-x03 → conn-bybit-x03)
    if (!connection && !connectionId.startsWith("conn-")) {
      const prefixedId = `conn-${connectionId}`
      console.log(`[v0] [Toggle] Not found with id=${connectionId}, trying conn- prefix: ${prefixedId}`)
      connection = await getConnection(prefixedId)
      if (connection) {
        resolvedId = prefixedId
        console.log(`[v0] [Toggle] Resolved to: ${resolvedId}`)
      }
    }

    if (!connection) {
      console.log(`[v0] [Toggle] Connection not found: ${connectionId} (also tried conn-${connectionId})`)
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Get clean connection state
    const state = getConnectionState(connection)
    console.log(`[v0] [Toggle] Toggling ${connection.name} (${connectionId}):`)
    console.log(`[v0] [Toggle]   Before: main_assigned=${state.main_assigned}, main_enabled=${state.main_enabled}`)
    
    // Determine new state based on request
    const enableMain = hasDashboardEnabled ? isDashboardEnabled : (hasActiveInserted ? isActiveInserted : state.main_enabled)

    // Guard: enabling dashboard processing must not implicitly insert into Main panel.
    // Users must explicitly add connection to Main first (add-to-active flow).
    if (hasDashboardEnabled && isDashboardEnabled && !hasActiveInserted && !state.main_assigned) {
      console.log(`[v0] [Toggle] Rejecting enable for unassigned connection: ${connection.name} (${resolvedId})`)
      return NextResponse.json(
        {
          error: "Connection is not assigned to Main Connections",
          details: "Add the connection to Main Connections first, then enable it.",
          connectionId: resolvedId,
        },
        { status: 409 },
      )
    }
    
    // Check if state actually changes
    const currentMainEnabled = state.main_enabled
    const needsUpdate = currentMainEnabled !== enableMain
    
    let updatedConnection: any
    let engineAction: "start" | "stop" | null = null
    
    if (needsUpdate) {
      if (enableMain) {
        // Enable in Main Connections - use clean helper
        updatedConnection = buildMainConnectionEnableUpdate(connection)
        engineAction = "start"
        console.log(`[v0] [Toggle] ENABLING: main_assigned=true, main_enabled=true (engine will process)`)
      } else {
        // Disable in Main Connections - use clean helper  
        updatedConnection = buildMainConnectionDisableUpdate(connection)
        engineAction = "stop"
        console.log(`[v0] [Toggle] DISABLING: main_enabled=false (engine will stop)`)
      }
    } else {
      // No state change - do not force restart/start to avoid unintended churn.
      updatedConnection = connection
      engineAction = null
      console.log(`[v0] [Toggle] No state change detected (enabled=${enableMain}) - skipping engine action`)
    }

    // Save connection state only if state changed
    if (needsUpdate && updatedConnection) {
      await updateConnection(resolvedId, updatedConnection)
      console.log(`[v0] [Toggle] Updated ${connection.name} (resolved id: ${resolvedId})`)
    }

    // Trigger engine action based on toggle state
    let engineStatus = "unchanged"
    if (engineAction === "start") {
      try {
        // Log progression event for UI feedback
        await logProgressionEvent(resolvedId, "toggle_enabled", "info", "Connection enabled via dashboard toggle", {
          connectionId: resolvedId,
          connectionName: connection.name,
          exchange: connection.exchange,
        })
        
        // Check if connection has valid credentials
        const apiKey = (updatedConnection.api_key || updatedConnection.apiKey || "") as string
        const apiSecret = (updatedConnection.api_secret || updatedConnection.apiSecret || "") as string
        const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
        
        // ALWAYS try to start the engine - even without credentials (for testing/demo)
        // If credentials are missing, engine will start but won't be able to trade
        await setSettings(`engine_progression:${resolvedId}`, {
          phase: "initializing",
          progress: 10,
          detail: hasCredentials 
            ? "Connection enabled - engine starting..." 
            : "Connection enabled - engine starting (credentials needed for live trading)",
          updated_at: new Date().toISOString(),
        })
        
        if (!hasCredentials) {
          await logProgressionEvent(resolvedId, "engine_starting_no_credentials", "warning", 
            "Engine starting without API credentials - live trading disabled", {
              connectionId: resolvedId,
              hint: "Add API key and secret in Settings for live trading",
            })
        }
        
        // Update global engine state to show running (stored as Redis HASH)
        const toggleClient = getRedisClient()
        const globalState: Record<string, string> = await toggleClient.hgetall("trade_engine:global").catch(() => ({})) || {}
        const allConnections = await getAllConnections()
        // Use clean helper function for counting main-enabled connections
        const activeDashboardCount = allConnections.filter((c: any) => 
          c.id === resolvedId || isConnectionReadyForEngine(c)
        ).length
        await toggleClient.hset("trade_engine:global", {
          ...globalState,
          status: "running",
          started_at: globalState.started_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          active_connections: String(activeDashboardCount),
        })
        
        // DIRECTLY START THE ENGINE - don't rely on coordinator polling
        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          const settings = await loadSettingsAsync()
            
            // Start the engine directly
            await coordinator.startEngine(resolvedId, {
              connectionId: resolvedId,
              connection_name: connection.name,
              exchange: connection.exchange,
              engine_type: "main",
              indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
              realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 3,
            })
            
            console.log(`[v0] [Toggle] ✓ Engine started directly for ${connection.name}`)
            await logProgressionEvent(resolvedId, "engine_started_direct", "info", "Main Trade Engine started directly from enable", {
              connectionId: resolvedId,
              connectionName: connection.name,
              exchange: connection.exchange,
            })
          } catch (engineStartError) {
            console.error(`[v0] [Toggle] Failed to start engine directly:`, engineStartError)
            // Still set the flag as fallback - coordinator may pick it up
            await setSettings("engine_coordinator:refresh_requested", {
              timestamp: new Date().toISOString(),
              connectionId: resolvedId,
              action: "start",
            })
          }
          
          engineStatus = "started"
          console.log(`[v0] [Toggle] Engine progression initialized for ${connection.name}`)
      } catch (engineError) {
        console.error(`[v0] [Toggle] Failed to initialize engine:`, engineError)
        engineStatus = "error"
        
        await logProgressionEvent(resolvedId, "toggle_error", "error", "Failed to start engine after toggle", {
          error: engineError instanceof Error ? engineError.message : String(engineError),
        })
      }
    } else if (engineAction === "stop") {
      try {
        // Log progression event for UI feedback
        await logProgressionEvent(resolvedId, "toggle_disabled", "info", "Connection disabled via dashboard toggle", {
          connectionId: resolvedId,
          connectionName: connection.name,
        })
        
        // Update engine progression phase to show stopped
        await setSettings(`engine_progression:${resolvedId}`, {
          phase: "idle",
          progress: 0,
          detail: "Connection disabled",
          updated_at: new Date().toISOString(),
        })
        
        // Update global engine state (stored as Redis HASH)
        const disableClient = getRedisClient()
        const disableGlobalState = await disableClient.hgetall("trade_engine:global").catch(() => ({})) || {}
        const allConnsForDisable = await getAllConnections()
        // Use clean helper function - exclude current connection
        const activeCount = allConnsForDisable.filter((c: any) => 
          c.id !== resolvedId && isConnectionReadyForEngine(c)
        ).length
        await disableClient.hset("trade_engine:global", {
          ...disableGlobalState,
          updated_at: new Date().toISOString(),
          active_connections: String(activeCount),
          status: activeCount > 0 ? "running" : "idle",
        })
        
        // DIRECTLY STOP THE ENGINE - don't rely on coordinator polling
        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          await coordinator.stopEngine(resolvedId)
          console.log(`[v0] [Toggle] ✓ Engine stopped directly for ${connection.name}`)
          await logProgressionEvent(resolvedId, "engine_stopped_direct", "info", "Main Trade Engine stopped directly from disable", {
            connectionId: resolvedId,
            connectionName: connection.name,
          })
        } catch (engineStopError) {
          console.warn(`[v0] [Toggle] Failed to stop engine directly:`, engineStopError)
        }
        
        engineStatus = "stopped"
        console.log(`[v0] [Toggle] Engine stopped for ${connection.name}`)
      } catch (engineError) {
        console.error(`[v0] [Toggle] Failed to stop engine:`, engineError)
        engineStatus = "error"
      }
    }

    return NextResponse.json({
      success: true,
      connection: {
        id: resolvedId,
        name: connection.name,
        exchange: connection.exchange,
        is_active_inserted: updatedConnection.is_active_inserted,
        is_enabled_dashboard: updatedConnection.is_enabled_dashboard,
        is_enabled: updatedConnection.is_enabled,
        is_inserted: updatedConnection.is_inserted,
      },
      engine: {
        action: engineAction,
        status: engineStatus,
      },
      progressionUrl: `/api/connections/progression/${resolvedId}`,
    })
  } catch (error) {
    console.error(`[v0] [Toggle] Error:`, error)
    return NextResponse.json(
      { error: "Failed to update active status", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
