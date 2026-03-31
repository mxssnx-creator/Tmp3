import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"

// POST - Add connection to active connections (set is_enabled_dashboard flag)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Update connection to be active on dashboard
    const updatedConnection = {
      ...connection,
      is_active_inserted: "1",
      is_dashboard_inserted: "1",
      is_enabled_dashboard: "1",
      is_active: "1",
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)

    const logMsg = `[v0] [ActiveConnection] ✓ ENABLED: ${connection.name} (${connectionId}) | Exchange: ${connection.exchange} | Base: ${["bybit", "bingx", "pionex", "orangex", "binance", "okx"].includes((connection.exchange || "").toLowerCase())}`
    console.log(logMsg)
    await SystemLogger.logConnection("Dashboard: Enabled active connection", connectionId, "info")

    return NextResponse.json({
      success: true,
      connection: updatedConnection,
      message: "Connection enabled on dashboard",
    })
  } catch (error) {
    console.error(`[v0] [ActiveConnection] ✗ FAILED to enable: ${error instanceof Error ? error.message : String(error)}`)
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to enable connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

// DELETE - Remove connection from active connections
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Update connection to remove from active
    const updatedConnection = {
      ...connection,
      is_enabled_dashboard: "0",
      is_active: "0",
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)

    const logMsg = `[v0] [ActiveConnection] ✗ DISABLED: ${connection.name} (${connectionId}) | Exchange: ${connection.exchange}`
    console.log(logMsg)
    await SystemLogger.logConnection("Dashboard: Disabled active connection", connectionId, "info")

    return NextResponse.json({
      success: true,
      connection: updatedConnection,
      message: "Connection disabled on dashboard",
    })
  } catch (error) {
    console.error(`[v0] [ActiveConnection] ✗ FAILED to disable: ${error instanceof Error ? error.message : String(error)}`)
    await SystemLogger.logError(error, "api", "DELETE /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to disable connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
