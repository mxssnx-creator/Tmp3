import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/resume
 * Resume the Global Trade Engine Coordinator
 * Resumes all trading operations across all connections and clears "Paused" state
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    await coordinator.resume()
    
    // ── Clear "Paused" state on all Main Connections ───────────────────
    // When resuming the global coordinator, clear the pause marker and
    // restore connections to their normal operational state.
    try {
      const connections = await client.smembers(`engine:connections:main`) || []
      for (const connId of connections) {
        const stateKey = `trade_engine_state:${connId}`
        const state = await client.hgetall(stateKey)
        if (state && state.paused_by === "global_coordinator") {
          await client.hdel(stateKey, "status", "paused_at", "paused_by")
        }
      }
      console.log(`[v0] Cleared "Paused" state from ${connections.length} Main Connections`)
    } catch (err) {
      console.warn("[v0] Failed to update Main Connections state:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if connection state update fails
    }
    
    console.log("[v0] Global Trade Engine Coordinator resumed via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine resumed successfully",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Resume API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}

