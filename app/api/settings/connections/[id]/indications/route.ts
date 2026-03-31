import { type NextRequest, NextResponse } from "next/server"
import { getIndications, saveIndication } from "@/lib/redis-db"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get connection indications from Redis
    const indications = await getIndications(id)

    return NextResponse.json({
      indications: indications || [],
    })
  } catch (error) {
    console.error("[v0] Failed to fetch connection indications:", error)
    return NextResponse.json({ error: "Failed to fetch indications" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { indications } = await request.json()

    // Save indications to Redis
    for (const ind of indications) {
      await saveIndication(id, {
        id: ind.id || `${id}-ind-${Date.now()}`,
        connection_id: id,
        type: ind.type || ind.indication_type,
        enabled: ind.enabled !== false,
        config: ind,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to update connection indications:", error)
    return NextResponse.json({ error: "Failed to update indications" }, { status: 500 })
  }
}
