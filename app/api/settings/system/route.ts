import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"

export async function GET(request: NextRequest) {
  try {
    const settings = (await getSettings("system")) || {}
    return NextResponse.json(settings)
  } catch (error) {
    console.error("[v0] Failed to fetch system settings:", error)
    return NextResponse.json({})
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const current = (await getSettings("system")) || {}
    const merged = { ...current, ...body }

    await setSettings("system", merged)

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
