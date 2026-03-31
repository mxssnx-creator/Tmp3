import { NextResponse } from "next/server"
import { getSettings, setSettings, initRedis } from "@/lib/redis-db"

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
  }
}

export async function GET() {
  try {
    await initRedis()

    let settings = await getSettings("app_settings")
    
    if (!settings || Object.keys(settings).length === 0) {
      // Auto-seed default settings if none exist
      const defaults = getDefaultSettings()
      await setSettings("app_settings", defaults)
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

    // Initialize Redis connection first
    await initRedis()

    await setSettings("app_settings", body)

    console.log("[v0] Settings saved successfully to Redis")

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
    const settings = body.settings || body

    console.log("[v0] Saving settings to Redis (PUT):", Object.keys(settings).length, "keys")

    // Initialize Redis connection first
    await initRedis()

    // Get existing settings and merge with new ones
    const existingSettings = (await getSettings("app_settings")) || {}
    const mergedSettings = { ...existingSettings, ...settings }
    
    await setSettings("app_settings", mergedSettings)

    console.log("[v0] Settings updated successfully in Redis")

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
