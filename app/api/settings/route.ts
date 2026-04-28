import { NextResponse } from "next/server"
import {
  getAppSettings,
  setAppSettings,
  initRedis,
  getAllConnections,
} from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { invalidateCompactionCache } from "@/lib/sets-compaction"

/**
 * Fan out a single "settings_changed" progression log event to every
 * active connection so the operator sees confirmation in the Engine
 * Progression dashboard that their saved change was detected by the
 * running engine on the very next cycle. Errors are swallowed — a log
 * failure must never cause a settings save to 500.
 */
async function emitSettingsChanged(keyCount: number): Promise<void> {
  try {
    const connections = await getAllConnections().catch(() => [])
    await Promise.all(
      (connections || []).map((conn: any) =>
        logProgressionEvent(
          conn.id,
          "settings_changed",
          "info",
          `Operator saved ${keyCount} setting${keyCount === 1 ? "" : "s"} — change will apply on the next cycle`,
          { keyCount },
        ).catch(() => { /* non-critical */ }),
      ),
    )
  } catch {
    /* non-critical */
  }
}

export const runtime = "nodejs"

function getDefaultSettings(): Record<string, any> {
  return {
    mainEngineIntervalMs: 1000,
    presetEngineIntervalMs: 120000,
    strategyUpdateIntervalMs: 10000,
    realtimeIntervalMs: 3000,
    mainEngineEnabled: true,
    presetEngineEnabled: true,
    minimum_connect_interval: 200,
    theme: "dark",
    language: "en",
    notifications_enabled: true,
    default_leverage: 10,
    default_volume: 100,
    max_open_positions: 10,
    max_drawdown_percent: 20,
    daily_loss_limit: 1000,
    main_symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    forced_symbols: [],
    database_type: "redis",
    // Canonical prehistoric range (1-50h, step 1, default 8). Must be seeded
    // here so fresh installs pick it up on first GET /api/settings — otherwise
    // the Settings UI would fall back to its own client default of 8 while
    // the engine read would find no value and use its internal default,
    // causing a brief off-by-one between what the UI shows and what the
    // engine actually applies until the user hits Save.
    prehistoric_range_hours: 8,
    // P0-4 spec cap — hard cap on concurrent pseudo positions per direction
    // (Long / Short). Kept in the defaults so fresh installs boot with the
    // spec-mandated value instead of an undefined sentinel.
    maxActiveBasePseudoPositionsPerDirection: 1,
  }
}

export async function GET() {
  try {
    await initRedis()

    // Mirror-aware read: merges `app_settings` (canonical / UI-facing) and
    // `all_settings` (legacy — still read by several trade-engine modules).
    // This unifies the view so the UI always shows what the engine will
    // actually apply, regardless of which key a setting happens to live in.
    let settings = await getAppSettings({ bypassCache: true })

    if (!settings || Object.keys(settings).length === 0) {
      // Auto-seed defaults when BOTH keys are empty. `setAppSettings` writes
      // to canonical + legacy in one go so legacy consumers also boot with
      // the defaults applied.
      const defaults = getDefaultSettings()
      await setAppSettings(defaults)
      settings = defaults
      console.log("[v0] Settings auto-seeded with", Object.keys(defaults).length, "default keys")
    }

    return NextResponse.json({ settings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to get settings from Redis:", errorMsg)
    // Return defaults even on error so the UI always has data
    return NextResponse.json({ settings: getDefaultSettings() })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    console.log("[v0] Saving settings to Redis (POST):", Object.keys(body).length, "keys")

    await initRedis()

    // Mirror-write: writes to BOTH `app_settings` and `all_settings` so the
    // Settings UI and every trade-engine module (strategy-processor,
    // pseudo-position-manager, market-data-cache, indication-processor-fixed,
    // indication-sets-processor — all of which read `all_settings`) see the
    // same snapshot on the next cycle.
    await setAppSettings(body)
    // Bust the in-process compaction config cache so the new
    // setCompactionFloor / setCompactionThresholdPct / per-type
    // overrides apply on the very next save cycle (otherwise the 5s
    // TTL inside `lib/sets-compaction.ts` would delay propagation in
    // this Node instance).
    invalidateCompactionCache()
    // Fan out a progression event so the operator can confirm the new
    // values reached every running engine.
    await emitSettingsChanged(Object.keys(body || {}).length)

    console.log("[v0] Settings saved successfully to Redis (canonical + legacy mirror)")

    return NextResponse.json({ success: true })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to save settings to Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json()
    const incoming = body.settings || body

    console.log("[v0] Saving settings to Redis (PUT):", Object.keys(incoming).length, "keys")

    await initRedis()

    // Merge with the FULL current view (canonical + legacy merged) so PUT
    // semantics stay correct even if a setting currently lives only in the
    // legacy hash.
    const existingSettings = (await getAppSettings({ bypassCache: true })) || {}
    const mergedSettings = { ...existingSettings, ...incoming }

    await setAppSettings(mergedSettings)
    invalidateCompactionCache()
    await emitSettingsChanged(Object.keys(incoming || {}).length)

    console.log("[v0] Settings updated successfully in Redis (canonical + legacy mirror)")

    return NextResponse.json({ success: true, settings: mergedSettings })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Failed to update settings in Redis:", errorMsg)

    return NextResponse.json(
      { error: "Failed to update settings", details: errorMsg },
      { status: 500 },
    )
  }
}
