import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/trade-engine/diagnostic
 * Diagnostic endpoint to show why trade engine isn't starting
 */
export async function GET() {
  try {
    console.log("[v0] [Diagnostic] Analyzing trade engine startup state...")
    
    await initRedis()
    const allConnections = await getAllConnections()
    
    // Check if ANY connections have is_enabled_dashboard = true/"1"
    const activeConnections = allConnections.filter((c: any) => {
      const d = c.is_enabled_dashboard
      return d === true || d === "1" || d === "true"
    })
    
    const dashboardInsertedConnections = allConnections.filter((c: any) => {
      const d = c.is_dashboard_inserted
      return d === "1" || d === true
    })
    
    const baseConnections = allConnections.filter((c: any) => {
      const isBase = ["bybit", "bingx", "pionex", "orangex", "binance", "okx"].includes((c.exchange || "").toLowerCase())
      return isBase
    })
    
    const diagnostic = {
      timestamp: new Date().toISOString(),
      summary: {
        totalConnections: allConnections.length,
        baseConnections: baseConnections.length,
        dashboardInserted: dashboardInsertedConnections.length,
        dashboardActive: activeConnections.length,
        tradeEngineCanStart: activeConnections.length > 0,
      },
      details: {
        allConnections: allConnections.map((c: any) => ({
          id: c.id,
          name: c.name,
          exchange: c.exchange,
          is_enabled: c.is_enabled,
          is_dashboard_inserted: c.is_dashboard_inserted,
          is_enabled_dashboard: c.is_enabled_dashboard,
          is_live_trade: c.is_live_trade,
        })),
      },
      diagnosis: {
        noActiveConnections: activeConnections.length === 0,
        reason: activeConnections.length === 0 
          ? "No connections have is_enabled_dashboard=true. Trade engine needs at least one active connection."
          : "Trade engine should be able to start.",
        nextSteps: activeConnections.length === 0
          ? [
              "1. Ensure Global Trade Engine is running: POST /api/trade-engine/start",
              "2. Enable at least one connection on the dashboard (bybit or bingx)",
              "3. Toggle the connection's Enable switch in the UI",
              "4. This will set is_enabled_dashboard='1' for the connection",
              "5. Trade engine will automatically pick it up and start processing"
            ]
          : ["Trade engine should start. Check logs for detailed progression."],
      },
    }
    
    console.log("[v0] [Diagnostic] Analysis complete:", {
      totalConnections: diagnostic.summary.totalConnections,
      dashboardActive: diagnostic.summary.dashboardActive,
      canStart: diagnostic.summary.tradeEngineCanStart,
    })
    
    return NextResponse.json(diagnostic)
  } catch (error) {
    console.error("[v0] [Diagnostic] Error:", error)
    return NextResponse.json(
      { error: "Failed to run diagnostic", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
