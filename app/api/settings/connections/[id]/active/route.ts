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

    // Add connection to Active panel (assigned but NOT yet enabled — user must toggle Enable)
    const updatedConnection = {
      ...connection,
      is_active_inserted: "1",     // Mark as assigned to Active panel
      is_dashboard_inserted: "1",  // Mark as inserted on dashboard
      is_assigned: "1",            // Assigned to Main Connections
      is_enabled_dashboard: "0",   // Disabled by default — user enables via toggle
      is_active: "0",              // Not processing yet
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

    // Update connection to remove from active panel - unassign from Main Connections
    // NOTE: is_inserted is preserved so the connection remains in Settings
    const updatedConnection = {
      ...connection,
      is_active_inserted: "0",      // Remove assignment from main panel
      is_dashboard_inserted: "0",   // Remove dashboard insertion
      is_enabled_dashboard: "0",    // Disable dashboard toggle
      is_active: "0",               // Not active for processing
      is_assigned: "0",             // Unassign from main connections
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)

    const logMsg = `[v0] [ActiveConnection] ✗ REMOVED: ${connection.name} (${connectionId}) | Exchange: ${connection.exchange}`
    console.log(logMsg)
    await SystemLogger.logConnection("Dashboard: Removed active connection", connectionId, "info")

    return NextResponse.json({
      success: true,
      connection: updatedConnection,
      message: "Connection removed from active panel",
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
