import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"

/**
 * POST /api/settings/connections/[id]/live-trade
 *
 * Toggles the `is_live_trade` flag on a connection. This flag is read DYNAMICALLY
 * by the running trade engine (every cycle) to decide whether the Live stage
 * should escalate strategies to real exchange orders. See
 * `lib/trade-engine/stages/live-stage.ts` for how the flag is checked.
 *
 * STABILITY RULE (important):
 *   The running engine for a connection is a single shared instance that handles
 *   indication → strategy → real → live stages regardless of mode flags. This
 *   endpoint must NOT stop the engine when the user turns Live Trade off — doing
 *   so would also kill the Main trading pipeline (which was the bug before this
 *   refactor). It must also NOT restart the engine when turning Live on if the
 *   engine is already running — that is a no-op on TradeEngineManager and leaks
 *   "starting..." UI state.
 *
 *   The only case where this endpoint starts the engine is when Live is turned
 *   ON while the Main engine is not yet running — in that case the engine is
 *   started so the new flag actually has an effect.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    const body = await request.json()
    const isLiveTrade = parseBooleanInput(body?.is_live_trade)

    console.log(`[v0] [LiveTrade] POST for ${connectionId}, is_live_trade=${isLiveTrade}`)

    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const connName = connection.name

    // When enabling Live, check credentials. Inject predefined creds for base connections.
    let apiKey = (connection.api_key || connection.apiKey || "") as string
    let apiSecret = (connection.api_secret || connection.apiSecret || "") as string
    let hasCredentials = apiKey.length > 10 && apiSecret.length > 10

    if (isLiveTrade) {
      if (
        !hasCredentials &&
        BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]
      ) {
        const creds = BASE_CONNECTION_CREDENTIALS[connectionId as keyof typeof BASE_CONNECTION_CREDENTIALS]
        apiKey = creds.apiKey
        apiSecret = creds.apiSecret
        hasCredentials = true
        await updateConnection(connectionId, {
          ...connection,
          api_key: apiKey,
          api_secret: apiSecret,
          updated_at: new Date().toISOString(),
        })
        console.log(`[v0] [LiveTrade] Injected predefined credentials for ${connName}`)
      }
      if (!hasCredentials) {
        return NextResponse.json(
          {
            success: false,
            error: "API credentials required for live trading",
            hint: "Add API key and secret in Settings to enable live trading",
          },
          { status: 400 },
        )
      }
    }

    // Write the flag — this is what the running engine's live-stage checks.
    const updatedConnection = {
      ...connection,
      api_key: apiKey,
      api_secret: apiSecret,
      is_live_trade: toRedisFlag(isLiveTrade),
      updated_at: new Date().toISOString(),
    }
    await updateConnection(connectionId, updatedConnection)

    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus: "running" | "starting" | "stopped" | "error" = "stopped"
    let engineStartedNow = false

    if (isLiveTrade) {
      // If the engine is already running (because Enable is on), just flip the flag
      // and let the next cycle pick it up. Do NOT restart — that no-ops silently in
      // TradeEngineManager.start() (isRunning guard) and leaves the UI confused.
      if (coordinator.isEngineRunning(connectionId)) {
        engineStatus = "running"
        console.log(`[v0] [LiveTrade] Engine already running for ${connName} — flag updated, no restart`)
      } else {
        // Engine is not running — start it so the flag has an effect.
        try {
          const settings = await loadSettingsAsync()
          await coordinator.startEngine(connectionId, {
            connectionId,
            connection_name: connName,
            exchange: connection.exchange,
            engine_type: "live",
            indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
            strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
            realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.2,
          })
          engineStatus = "starting"
          engineStartedNow = true
          console.log(`[v0] [LiveTrade] Engine started for ${connName} to service live-trade flag`)
        } catch (err) {
          console.error(`[v0] [LiveTrade] Failed to start engine for ${connName}:`, err)
          await SystemLogger.logError(err, "api", `Start engine for ${connName}`)
          return NextResponse.json(
            {
              success: false,
              error: "Failed to start engine",
              details: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      }
    } else {
      // Turning Live OFF must NOT stop the engine — the Main pipeline might still
      // be running. The flag change alone is sufficient: next cycle, the live-stage
      // will short-circuit because is_live_trade is "0". This was the root cause
      // of "toggling Live off also disabled Main trading" before this refactor.
      engineStatus = coordinator.isEngineRunning(connectionId) ? "running" : "stopped"
      console.log(`[v0] [LiveTrade] Flag cleared for ${connName} — engine left untouched (status=${engineStatus})`)
    }

    await SystemLogger.logConnection(
      `Live Trading ${isLiveTrade ? "enabled" : "disabled"} via UI toggle`,
      connectionId,
      "info",
      { is_live_trade: isLiveTrade, engineStartedNow, engineStatus },
    )

    return NextResponse.json({
      success: true,
      is_live_trade: isLiveTrade,
      engineStatus,
      engineStartedNow,
      connection: updatedConnection,
      message: `Live Trading ${isLiveTrade ? "enabled" : "disabled"}`,
      connectionName: connName,
      exchange: connection.exchange,
    })
  } catch (error) {
    console.error("[v0] [LiveTrade] Exception:", error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/${connectionId}/live-trade`)
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
