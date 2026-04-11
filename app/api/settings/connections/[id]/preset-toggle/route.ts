import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getRedisClient, getConnection, updateConnection } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { isTruthyFlag, parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"

// POST toggle preset trading for a connection
// This controls the PRESET Trade Engine
// Preset Engine starts ONLY if:
// 1. Connection is enabled (is_enabled = true)
// 2. Connection is active on dashboard (is_enabled_dashboard = true)
// 3. Preset Trade toggle is enabled (is_preset_trade = true)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()
    const isPresetTrade = parseBooleanInput(body?.is_preset_trade)

    console.log("[v0] [Preset Trade] Toggling Preset Engine for:", connectionId, "enabled:", isPresetTrade)

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Check if connection has credentials - PRESET MODE IS INDEPENDENT
    // It runs preset strategies without requiring main engine
    if (isPresetTrade) {
      const client = getRedisClient()
      const apiKey = (connection.api_key || connection.apiKey || "") as string
      const apiSecret = (connection.api_secret || connection.apiSecret || "") as string
      const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
      
      if (!hasCredentials) {
        return NextResponse.json({ 
          error: "API credentials required for preset trading",
          hint: "Add API key and secret in Settings to enable preset trading"
        }, { status: 400 })
      }
      
    }

    // Update connection with is_preset_trade flag
    const updatedConnection = {
      ...connection,
      is_preset_trade: toRedisFlag(isPresetTrade),
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)
    console.log("[v0] [Preset Trade] Updated is_preset_trade:", connectionId, "=", isPresetTrade)

    // Start or stop Preset Engine based on toggle
    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus = "stopped"

    if (isPresetTrade) {
      try {
        console.log("[v0] [Preset Trade] Starting Preset Engine for:", connection.name)
        
        // Start preset coordination engine
        await coordinator.startEngine(connectionId, {
          connectionId,
          connection_name: connection.name,
          exchange: connection.exchange,
          engine_type: "preset",
        })
        
        engineStatus = "running"
        console.log("[v0] [Preset Trade] Preset Engine started successfully")
        await SystemLogger.logConnection(
          `Preset Engine started via Preset Trade toggle`,
          connectionId,
          "info",
          { is_preset_trade: true },
        )
      } catch (error) {
        console.error("[v0] [Preset Trade] Failed to start Preset Engine:", error)
        engineStatus = "error"
        await SystemLogger.logError(error, "api", `Start Preset Engine for ${connectionId}`)
        return NextResponse.json(
          {
            error: "Failed to start Preset Engine",
            details: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500 },
        )
      }
    } else {
      try {
        console.log("[v0] [Preset Trade] Stopping Preset Engine for:", connection.name)
        await coordinator.stopEngine(connectionId)
        engineStatus = "stopped"
        console.log("[v0] [Preset Trade] Preset Engine stopped successfully")
        await SystemLogger.logConnection(
          `Preset Engine stopped via Preset Trade toggle`,
          connectionId,
          "info",
          { is_preset_trade: false },
        )
      } catch (error) {
        console.warn("[v0] [Preset Trade] Failed to stop Preset Engine:", error)
        // Don't fail the request if stop fails - engine might not be running
      }
    }

    return NextResponse.json({
      success: true,
      is_preset_trade: isPresetTrade,
      engineStatus,
      connection: updatedConnection,
      message: `Preset Engine ${isPresetTrade ? "enabled (starting...)" : "disabled"}`,
    })
  } catch (error) {
    console.error("[v0] [Preset Trade] Exception:", error)
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/preset-toggle")
    return NextResponse.json(
      {
        error: "Failed to toggle preset trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
