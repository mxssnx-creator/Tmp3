import { type NextRequest, NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { SystemLogger } from "@/lib/system-logger"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    if (body.volume_factor === undefined || body.volume_factor === null) {
      return NextResponse.json({ error: "Volume factor is required" }, { status: 400 })
    }

    const volumeFactor = Number.parseFloat(body.volume_factor)
    if (Number.isNaN(volumeFactor) || volumeFactor < 0.1 || volumeFactor > 10) {
      return NextResponse.json(
        { error: "Invalid volume factor", details: "Volume factor must be between 0.1 and 10" },
        { status: 400 },
      )
    }

    console.log("[v0] Updating volume factor for connection:", id, "to", volumeFactor)
    await SystemLogger.logConnection(`Updating volume factor to ${volumeFactor}`, id, "info")

    const connections = await query(`SELECT id FROM exchange_connections WHERE id = $1 AND is_active = true`, [id])

    if (connections.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    await execute(
      `INSERT INTO volume_configuration (connection_id, base_volume_factor, created_at, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (connection_id)
       DO UPDATE SET 
         base_volume_factor = $2,
         updated_at = CURRENT_TIMESTAMP`,
      [id, volumeFactor],
    )

    await SystemLogger.logConnection(`Volume factor updated successfully`, id, "info")

    return NextResponse.json({ success: true, volume_factor: volumeFactor })
  } catch (error) {
    console.error("[v0] Failed to update volume factor:", error)
    await SystemLogger.logError(error, "api", `PATCH /api/settings/connections/${(await params).id}/volume`)
    return NextResponse.json(
      { error: "Failed to update volume factor", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
