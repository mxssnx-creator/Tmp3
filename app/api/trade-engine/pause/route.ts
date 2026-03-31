import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/pause
 * Pause the Global Trade Engine Coordinator
 * Pauses all trading operations across all connections
 */
export async function POST() {
  try {
    await initRedis()
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    await coordinator.pause()
    
    // Update Redis global state
    const client = getRedisClient()
    await client.hset("trade_engine:global", { status: "paused", paused_at: new Date().toISOString() })
    
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
