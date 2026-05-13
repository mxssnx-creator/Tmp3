import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient, getActiveConnectionsForEngine } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/resume
 * Resume the Global Trade Engine Coordinator
 * Resumes all trading operations across all connections and restores previous state
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
    
    // ── Restore previous global status ──────────────────────────────────
    // When resuming, restore the status to what it was before the pause
    // (running, stopped, or whatever the previous_status field was set to).
    // This ensures the coordinator's state is fully synchronized with Redis.
    try {
      const currentGlobalState = await client.hgetall("trade_engine:global").catch(() => ({}))
      const previousStatus = (currentGlobalState as any).previous_status || "running"
      
      await client.hset("trade_engine:global", {
        status: previousStatus,
        resumed_at: new Date().toISOString(),
      })
      await client.hdel("trade_engine:global", "paused_at", "paused_by", "previous_status")
      console.log(`[v0] Global status restored to: ${previousStatus}`)
    } catch (err) {
      console.warn("[v0] Failed to restore global status:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if status restore fails
    }
    
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

    // ── Resume all paused progressions ──────────────────────────────────
    // Clear the pause marker from every progression so they resume
    // accepting work cycles. Only clear if marked by global_coordinator.
    try {
      const activeConnections = await getActiveConnectionsForEngine()
      const progressionIds = activeConnections.map((c) => c.id)
      
      let resumedCount = 0
      for (const progId of progressionIds) {
        const progKey = `progression:${progId}`
        const progState = await client.hgetall(progKey)
        if (progState && progState.paused_by === "global_coordinator") {
          await client.hdel(progKey, "status", "paused_at", "paused_by")
          resumedCount++
        }
      }
      
      if (resumedCount > 0) {
        console.log(`[v0] Resumed ${resumedCount} progressions`)
      }
    } catch (err) {
      console.warn("[v0] Failed to resume progressions:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if progression resume fails
    }
    
    console.log("[v0] Global Trade Engine Coordinator resumed via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine resumed successfully",
      status: "running",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Resume API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}

