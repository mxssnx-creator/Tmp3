import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export async function GET() {
  try {
    const connectionCheck = await query(`SELECT COUNT(*) as count FROM exchange_connections WHERE is_enabled = 1`)
    const indicationCheck = await query(`
      SELECT COUNT(*) as count FROM indications 
      WHERE datetime(created_at) > datetime('now', '-5 minutes')
    `)
    const positionCheck = await query(`SELECT COUNT(*) as count FROM pseudo_positions WHERE status = 'active'`)

    const activeConnections = Number.parseInt(connectionCheck[0]?.count || "0") || 0
    const recentIndications = Number.parseInt(indicationCheck[0]?.count || "0") || 0
    const activePositions = Number.parseInt(positionCheck[0]?.count || "0") || 0

    const modules = [
      {
        name: "Live Trading Engine",
        status: activeConnections > 0 ? "active" : "inactive",
        health: activeConnections > 0 ? 98 : 0,
        last_update: "2 min ago",
      },
      {
        name: "Indication Generator",
        status: recentIndications > 0 ? "active" : "inactive",
        health: recentIndications > 0 ? 95 : 0,
        last_update: "1 min ago",
      },
      {
        name: "Strategy Optimizer",
        status: "active",
        health: 92,
        last_update: "3 min ago",
      },
      {
        name: "Position Manager",
        status: activePositions > 0 ? "active" : "inactive",
        health: activePositions > 0 ? 97 : 0,
        last_update: "1 min ago",
      },
      {
        name: "Analytics Engine",
        status: "active",
        health: 89,
        last_update: "5 min ago",
      },
      {
        name: "Database Sync",
        status: "active",
        health: 94,
        last_update: "2 min ago",
      },
      {
        name: "API Gateway",
        status: "active",
        health: 96,
        last_update: "1 min ago",
      },
      {
        name: "WebSocket Server",
        status: "active",
        health: 93,
        last_update: "2 min ago",
      },
    ]

    return NextResponse.json({
      success: true,
      data: modules,
    })
  } catch (error) {
    console.error("[v0] Error fetching module status:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch module status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
