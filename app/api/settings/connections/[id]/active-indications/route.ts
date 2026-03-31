import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    // Get active indications settings from Redis
    const indicationSettings = await getSettings(`active_indications:${connectionId}`)

    if (!indicationSettings) {
      // Return default configuration
      return NextResponse.json(
        {
          direction: true,
          move: true,
          active: true,
          optimal: false,
          auto: false,
        },
        { status: 200 }
      )
    }

    return NextResponse.json(indicationSettings)
  } catch (error) {
    console.error("[v0] Error fetching active indications:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch active indications",
        direction: true,
        move: true,
        active: true,
        optimal: false,
        auto: false,
      },
      { status: 200 }
    )
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()

    console.log("[v0] Saving active indications for connection:", connectionId, body)

    // Save to Redis
    await setSettings(`active_indications:${connectionId}`, {
      direction: body.direction !== false,
      move: body.move !== false,
      active: body.active !== false,
      optimal: body.optimal === true,
      auto: body.auto === true,
      updated_at: new Date().toISOString(),
    })

    console.log("[v0] Active indications saved successfully")
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error saving active indications:", error)

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to save active indications",
      },
      { status: 500 }
    )
  }
}
