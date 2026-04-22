import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"

/**
 * System-scoped settings bundle (rate limits, cleanup, backup toggles).
 *
 * ── Key mirroring ─────────────────────────────────────────────────────
 * Two consumers historically drifted apart:
 *   - This route wrote/read `"system"`.
 *   - `lib/volume-calculator.ts` + `lib/data-cleanup-manager.ts` read
 *     `"system_settings"`.
 * We now MERGE on read and MIRROR on write so whichever key a caller
 * happens to use, the data is consistent.
 */
const SYSTEM_KEY_CANONICAL = "system"
const SYSTEM_KEY_LEGACY    = "system_settings"

async function readMergedSystem(): Promise<Record<string, any>> {
  const [canonical, legacy] = await Promise.all([
    getSettings(SYSTEM_KEY_CANONICAL),
    getSettings(SYSTEM_KEY_LEGACY),
  ])
  // Canonical (`system`) wins on conflict — it's the UI-facing key.
  return { ...(legacy || {}), ...(canonical || {}) }
}

async function writeMirroredSystem(value: Record<string, any>): Promise<void> {
  await Promise.all([
    setSettings(SYSTEM_KEY_CANONICAL, value),
    setSettings(SYSTEM_KEY_LEGACY,    value),
  ])
}

export async function GET(_request: NextRequest) {
  try {
    const settings = await readMergedSystem()
    return NextResponse.json(settings)
  } catch (error) {
    console.error("[v0] Failed to fetch system settings:", error)
    return NextResponse.json({})
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const current = await readMergedSystem()
    const merged = { ...current, ...body }

    await writeMirroredSystem(merged)

    return NextResponse.json({
      success: true,
      data: merged,
      updated: Object.keys(body).length,
    })
  } catch (error) {
    console.error("[v0] Failed to save system settings:", error)
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
