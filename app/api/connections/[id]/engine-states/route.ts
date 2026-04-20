/**
 * GET /api/connections/[id]/engine-states
 *
 * Returns per-connection engine running state for all three engines (main,
 * live, preset) together with the persisted DB toggle flags. The UI uses this
 * to keep the Enable / Live Trade / Preset Mode switches bidirectionally synced
 * with the actual engine state and to surface drift (e.g. flag is ON but the
 * engine is not actually running).
 *
 * Response shape:
 * {
 *   success: true,
 *   connectionId: string,
 *   enabled:  { flag: boolean, running: boolean, inSync: boolean },
 *   live:     { flag: boolean, running: boolean, inSync: boolean },
 *   preset:   { flag: boolean, running: boolean, inSync: boolean },
 * }
 */
import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, getSettings } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

const toBoolean = (v: unknown) =>
  v === true || v === 1 || v === "1" || v === "true"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: connectionId } = await params

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
  }

  try {
    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers }
      )
    }

    const coordinator = getGlobalTradeEngineCoordinator()
    const engineRunning =
      !!coordinator && coordinator.isEngineRunning(connectionId)

    // Redis hint key for stale-flag detection — written by the coordinator on
    // successful startup and cleared on stop. If the in-memory manager is
    // missing but this hint is still "1", we treat it as stale drift.
    let runningHint = false
    try {
      const hint = await getSettings(`engine_is_running:${connectionId}`)
      runningHint = hint === "true" || hint === true || hint === "1"
    } catch {
      /* non-critical */
    }

    // DB flags — the canonical source of truth for the slider `checked` state.
    const flagEnabled = toBoolean((connection as any).is_enabled_dashboard)
    const flagLive    = toBoolean((connection as any).is_live_trade)
    const flagPreset  = toBoolean((connection as any).is_preset_trade)

    // A single engineManager per connection holds one "engine_type" at a time.
    // We cannot tell from the coordinator whether the currently-running engine
    // is the main/live/preset variant, so we report `running=engineRunning` for
    // every flag that is ON. That is still useful for drift detection:
    //   - flag ON + running OFF  → drift (user expects engine, it is not up)
    //   - flag OFF + running ON  → drift (engine up but user disabled)
    const buildState = (flag: boolean) => ({
      flag,
      running: engineRunning,
      // `inSync` is `true` when both are on or both are off.
      inSync: flag === engineRunning,
    })

    return NextResponse.json(
      {
        success: true,
        connectionId,
        engineRunning,
        runningHint,
        enabled: buildState(flagEnabled),
        live: buildState(flagLive),
        preset: buildState(flagPreset),
        timestamp: new Date().toISOString(),
      },
      { headers }
    )
  } catch (error) {
    await SystemLogger.logError(
      error,
      "api",
      `GET /api/connections/${connectionId}/engine-states`
    )
    return NextResponse.json(
      {
        success: false,
        error: "Failed to resolve engine states",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers }
    )
  }
}
