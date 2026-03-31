import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get connection strategy settings
    const result = await sql`
      SELECT 
        strategy_type,
        is_enabled,
        min_profit_factor,
        max_positions
      FROM connection_strategy_settings
      WHERE connection_id = ${id}
      ORDER BY strategy_type
    `

    return NextResponse.json({
      strategies: result || [],
    })
  } catch (error) {
    console.error("[v0] Failed to fetch connection strategies:", error)
    return NextResponse.json({ error: "Failed to fetch strategies" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { strategies } = await request.json()

    // Update strategy settings
    for (const strat of strategies) {
      await sql`
        INSERT INTO connection_strategy_settings (connection_id, strategy_type, is_enabled, min_profit_factor, max_positions)
        VALUES (${id}, ${strat.strategy_type}, ${strat.is_enabled}, ${strat.min_profit_factor || null}, ${strat.max_positions || null})
        ON CONFLICT (connection_id, strategy_type) 
        DO UPDATE SET 
          is_enabled = ${strat.is_enabled},
          min_profit_factor = ${strat.min_profit_factor || null},
          max_positions = ${strat.max_positions || null},
          updated_at = CURRENT_TIMESTAMP
      `
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to update connection strategies:", error)
    return NextResponse.json({ error: "Failed to update strategies" }, { status: 500 })
  }
}
