import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { updateConnection, initRedis, getConnection } from "@/lib/redis-db"
import { RedisTrades, RedisPositions } from "@/lib/redis-operations"
import { notifySettingsChanged, detectChangedFields } from "@/lib/settings-coordinator"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const trades = await RedisTrades.getTradesByConnection(id)
    const positions = await RedisPositions.getPositionsByConnection(id)

    const settings = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    return NextResponse.json({
      connection,
      settings,
      statistics: {
        active_trades: trades?.length || 0,
        active_positions: positions?.length || 0,
        created_at: connection.created_at,
        updated_at: connection.updated_at,
      },
    })
  } catch (error) {
    console.error("[v0] [Settings] GET error:", error)
    await SystemLogger.logError(error, "api", "GET /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to fetch settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const updated = {
      ...connection,
      name: body.name || connection.name,
      api_type: body.api_type || connection.api_type,
      connection_method: body.connection_method || connection.connection_method,
      connection_library: body.connection_library || connection.connection_library,
      margin_type: body.margin_type || connection.margin_type,
      position_mode: body.position_mode || connection.position_mode,
      is_testnet: body.is_testnet !== undefined ? body.is_testnet : connection.is_testnet,
      is_enabled: body.is_enabled !== undefined ? body.is_enabled : connection.is_enabled,
      is_active: body.is_active !== undefined ? body.is_active : connection.is_active,
      volume_factor: body.volume_factor || connection.volume_factor,
      connection_settings: body.settings || connection.connection_settings,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // Notify engine of settings change AND fast-path apply so operators
    // don't have to wait for the next 3 s watcher tick.
    //
    // CRITICAL COMPREHENSIVE FIX: after the fast-path apply, ALSO ask
    // the coordinator to (re-)start any missing engines using the
    // freshly-updated connection record. This handles the case where:
    //   1. Operator edits credentials in the dialog → "restart" classed.
    //   2. Operator toggles dashboard enabled / changes intervals →
    //      "reload" classed but engine may have been stopped earlier.
    //
    // Without this second step, hot-reload only fires when the engine
    // is ALREADY running. Operators who saved settings while the engine
    // was stopped (or after a crash) saw "settings saved" but no actual
    // restart, exactly matching the report "Changing main connections
    // settings through settings dialog does not do take affection".
    const changedFields = detectChangedFields(connection, updated)
    if (changedFields.length > 0) {
      await notifySettingsChanged(id, changedFields, connection, updated)
      try {
        const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
        const coordinator = getGlobalTradeEngineCoordinator()
        // Step 1 — fast-path apply for already-running engines.
        await coordinator.applyPendingChangesNow(id)

        // Step 2 — recoordinate: ensure the engine for this connection
        // is running if it should be (assigned + enabled + main mode).
        // `startMissingEngines` is idempotent — a running engine is
        // left alone, a stopped-but-should-be-running engine is
        // (re)started with the latest settings/config snapshot.
        const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
          "@/lib/connection-state-utils"
        )
        const shouldRun =
          isConnectionMainProcessing(updated) &&
          (hasConnectionCredentials(updated, 5, true) ||
            isTruthyFlag((updated as any).is_predefined) ||
            isTruthyFlag((updated as any).is_testnet) ||
            isTruthyFlag((updated as any).demo_mode))
        if (shouldRun) {
          await coordinator.startMissingEngines([updated])
        }
      } catch (applyErr) {
        console.warn(
          `[v0] [Settings PUT] coordinator recoordination failed for ${id}:`,
          applyErr instanceof Error ? applyErr.message : String(applyErr),
        )
      }
    }

    await SystemLogger.logConnection(`Updated settings`, id, "info")

    return NextResponse.json({ success: true, connection: updated })
  } catch (error) {
    console.error("[v0] [Settings] PUT error:", error)
    await SystemLogger.logError(error, "api", "PUT /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const settings = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const current = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    const merged = { ...current, ...settings }

    const updated = {
      ...connection,
      connection_settings: merged,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // Notify engine of settings change AND fast-path apply + recoordinate.
    // See same-pattern comment in PUT handler above for rationale.
    const changedFields = Object.keys(settings)
    if (changedFields.length > 0) {
      await notifySettingsChanged(id, ["connection_settings"], { connection_settings: current }, { connection_settings: merged })
      try {
        const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
        const coordinator = getGlobalTradeEngineCoordinator()
        await coordinator.applyPendingChangesNow(id)

        // Recoordinate (idempotent) so a connection that was stopped
        // when the operator saved nested settings actually restarts
        // with the new connection_settings JSON applied.
        const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
          "@/lib/connection-state-utils"
        )
        const shouldRun =
          isConnectionMainProcessing(updated) &&
          (hasConnectionCredentials(updated, 5, true) ||
            isTruthyFlag((updated as any).is_predefined) ||
            isTruthyFlag((updated as any).is_testnet) ||
            isTruthyFlag((updated as any).demo_mode))
        if (shouldRun) {
          await coordinator.startMissingEngines([updated])
        }
      } catch (applyErr) {
        console.warn(
          `[v0] [Settings PATCH] coordinator recoordination failed for ${id}:`,
          applyErr instanceof Error ? applyErr.message : String(applyErr),
        )
      }
    }

    await SystemLogger.logConnection(`Patched settings`, id, "info")

    return NextResponse.json({ success: true, settings: merged })
  } catch (error) {
    console.error("[v0] [Settings] PATCH error:", error)
    await SystemLogger.logError(error, "api", "PATCH /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
