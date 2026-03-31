import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export async function GET() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()
    
    console.log(`[v0] [LiveTradeStatus] Checking ${allConnections.length} connections`)
    
    const liveTradeStatus = allConnections.map((conn: any) => {
      const isLiveTrading = conn.is_live_trade === "1" || conn.is_live_trade === true
      const isDashboardActive = conn.is_enabled_dashboard === "1" || conn.is_enabled_dashboard === true
      const isEnabled = conn.is_enabled === "1" || conn.is_enabled === true
      
      return {
        connectionId: conn.id,
        name: conn.name,
        exchange: conn.exchange,
        is_live_trade: isLiveTrading,
        is_enabled: isEnabled,
        is_enabled_dashboard: isDashboardActive,
        ready_for_live_trading: isEnabled && isDashboardActive,
      }
    })
    
    const activeLiveTrading = liveTradeStatus.filter(c => c.is_live_trade)
    console.log(`[v0] [LiveTradeStatus] ${activeLiveTrading.length} connections with live trading enabled`)
    
    return NextResponse.json({
      success: true,
      total: allConnections.length,
      live_trading_active: activeLiveTrading.length,
      connections: liveTradeStatus,
      active_live_trading: activeLiveTrading,
    })
  } catch (error) {
    console.error("[v0] [LiveTradeStatus] Error:", error)
    return NextResponse.json(
      { error: "Failed to get live trade status", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
