import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getRedisClient, getConnection, updateConnection } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { isTruthyFlag, parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"

// POST toggle live trading for a connection
// This enables REAL exchange trading via strategies
// Requirements for enabling:
// 1. Global Trade Engine must be running
// 2. Connection must be enabled in Settings
// 3. Connection must be active on Dashboard
// 4. is_live_trade flag set to true
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()
    const isLiveTrade = parseBooleanInput(body?.is_live_trade)

    console.log(`[v0] [LiveTrade] POST handler called for: ${connectionId}, is_live_trade=${isLiveTrade}`)

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      console.log(`[v0] [LiveTrade] ✗ Connection not found: ${connectionId}`)
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const connName = connection.name
    console.log(`[v0] [LiveTrade] Found connection: ${connName} (${connection.exchange})`)

    // If enabling, check prerequisites - LIVE TRADE IS INDEPENDENT
    // It mirrors exchange positions without requiring main engine
    if (isLiveTrade) {
      console.log(`[v0] [LiveTrade] Checking prerequisites for enabling ${connName}...`)

      // Check: Connection must have credentials for exchange API calls
      const client = getRedisClient()
      let apiKey = (connection.api_key || connection.apiKey || "") as string
      let apiSecret = (connection.api_secret || connection.apiSecret || "") as string
      let hasCredentials = apiKey.length > 10 && apiSecret.length > 10
      console.log(`[v0] [LiveTrade]   - Has API credentials: ${hasCredentials}`)

      // If no credentials but this is a base connection with predefined credentials, inject them
      if (!hasCredentials && BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]) {
        console.log(`[v0] [LiveTrade]   - Injecting predefined credentials for base connection: ${connectionId}`)
        const creds = BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]
        apiKey = creds.apiKey
        apiSecret = creds.apiSecret
        hasCredentials = true

        // Update connection with injected credentials
        await updateConnection(connectionId, {
          ...connection,
          api_key: apiKey,
          api_secret: apiSecret,
          updated_at: new Date().toISOString(),
        })
        console.log(`[v0] [LiveTrade] ✓ Predefined credentials injected for ${connName}`)
      }

      if (!hasCredentials) {
        console.log(`[v0] [LiveTrade] ✗ Prerequisite failed: No API credentials`)
        return NextResponse.json({
          success: false,
          error: "API credentials required for live trading",
          hint: "Add API key and secret in Settings to enable live trading"
        }, { status: 400 })
      }

      console.log(`[v0] [LiveTrade] ✓ Prerequisites met for ${connName} - starting independent live trade engine`)
    }

    // Update connection with is_live_trade flag
    console.log(`[v0] [LiveTrade] Updating connection state: is_live_trade=${isLiveTrade}`)
    const updatedConnection = {
      ...connection,
      is_live_trade: toRedisFlag(isLiveTrade),
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)
    console.log(`[v0] [LiveTrade] ✓ Connection updated in database`)

    // Start or stop engine based on toggle
    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus = "stopped"

    if (isLiveTrade) {
      try {
        console.log(`[v0] [LiveTrade] Starting live trading engine for: ${connName}`)
        const settings = await loadSettingsAsync()
        
        // Load latest config
        const latestConnection = await getConnection(connectionId)
        
        await coordinator.startEngine(connectionId, {
          connectionId,
          connection_name: latestConnection?.name || connName,
          exchange: latestConnection?.exchange || connection.exchange,
          engine_type: "live", // Independent live trade engine for exchange position mirroring
          indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
          strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
          realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.2,
        })
        
        engineStatus = "running"
        console.log(`[v0] [LiveTrade] ✓ INDEPENDENT Live trading engine started for ${connName} (exchange position mirroring)`)
        
        await SystemLogger.logConnection(
          `Live Trading enabled via UI toggle`,
          connectionId,
          "info",
          { is_live_trade: true, exchange: connection.exchange },
        )
      } catch (error) {
        console.error(`[v0] [LiveTrade] ✗ Failed to start live trading engine for ${connName}:`, error)
        engineStatus = "error"
        
        await SystemLogger.logError(error, "api", `Start live trading for ${connName}`)
        
        return NextResponse.json(
          {
            success: false,
            error: "Failed to start live trading engine",
            details: error instanceof Error ? error.message : "Unknown error",
            connectionName: connName,
          },
          { status: 500 },
        )
      }
    } else {
      try {
        console.log(`[v0] [LiveTrade] Stopping live trading engine for: ${connName}`)
        await coordinator.stopEngine(connectionId)
        engineStatus = "stopped"
        console.log(`[v0] [LiveTrade] ✓ Live trading engine stopped successfully for ${connName}`)
        
        await SystemLogger.logConnection(
          `Live Trading disabled via UI toggle`,
          connectionId,
          "info",
          { is_live_trade: false, exchange: connection.exchange },
        )
      } catch (error) {
        console.warn(`[v0] [LiveTrade] ⚠ Failed to stop live trading engine for ${connName}:`, error)
        // Don't fail the request - engine might not be running
      }
    }

    console.log(`[v0] [LiveTrade] ✓ Live trading toggle completed for ${connName}: ${engineStatus}`)

    return NextResponse.json({
      success: true,
      is_live_trade: isLiveTrade,
      engineStatus,
      connection: updatedConnection,
      message: `Live Trading ${isLiveTrade ? "enabled (starting real exchange trading...)" : "disabled"}`,
      connectionName: connName,
      exchange: connection.exchange,
    })
  } catch (error) {
    console.error("[v0] [LiveTrade] Exception in POST handler:", error)
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/live-trade")
    return NextResponse.json(
      {
        success: false,
        error: "Failed to toggle live trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
