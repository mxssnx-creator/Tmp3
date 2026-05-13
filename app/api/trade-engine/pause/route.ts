import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/pause
 * Pause the Global Trade Engine Coordinator
 * Pauses all trading operations across all connections and marks Main Connections as "Paused"
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    await coordinator.pause()
    
    // Update Redis global state
    await client.hset("trade_engine:global", { status: "paused", paused_at: new Date().toISOString() })
    
    // ── Set all Main Connections to "Paused" state ──────────────────
    // When the global coordinator is paused, all enabled Main Connections
    // (connections visible in the dashboard) should reflect that they are
    // paused. This is independent from their individual is_enabled status
    // — they remain enabled, but their operational state becomes "Paused".
    try {
      const connections = await client.smembers(`engine:connections:main`) || []
      for (const connId of connections) {
        await client.hset(`trade_engine_state:${connId}`, {
          status: "paused",
          paused_at: new Date().toISOString(),
          paused_by: "global_coordinator",
        })
      }
      console.log(`[v0] Set ${connections.length} Main Connections to "Paused" state`)
    } catch (err) {
      console.warn("[v0] Failed to update Main Connections state:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if connection state update fails
    }
    
    console.log("[v0] Global Trade Engine Coordinator paused via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine paused successfully",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Pause API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}
