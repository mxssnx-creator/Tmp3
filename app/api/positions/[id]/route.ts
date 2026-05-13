import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { getSession } from "@/lib/auth"

export const dynamic = "force-dynamic"

/**
 * GET /api/positions/[id] - Get specific position details
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Allow development/testing access without auth
    const user = process.env.NODE_ENV === "development" ? { id: 1, username: "dev" } : await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { id: positionId } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    const position = await client.hgetall(`position:${connectionId}:${positionId}`)
    
    if (!position || Object.keys(position).length === 0) {
      return NextResponse.json(
        { success: false, error: "Position not found" },
        { status: 404 }
      )
    }

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Fetched position ${positionId}`,
      { symbol: position.symbol, status: position.status }
    )

    return NextResponse.json({
      success: true,
      data: { ...position, id: positionId },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] GET detail error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to fetch position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/positions/[id] - Update position (price, stop-loss, take-profit)
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Allow development/testing access without auth
    const user = process.env.NODE_ENV === "development" ? { id: 1, username: "dev" } : await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { id: positionId } = await params
    const body = await request.json()
    const { connection_id, current_price, stop_loss, take_profit } = body

    if (!connection_id) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Get current position
    const position = await client.hgetall(`position:${connection_id}:${positionId}`)
    if (!position || Object.keys(position).length === 0) {
      return NextResponse.json({ success: false, error: "Position not found" }, { status: 404 })
    }

    // Calculate PnL if price updated
    let updates: Record<string, string> = {}
    
    if (current_price !== undefined) {
      updates.current_price = String(current_price)
      
      const entry = parseFloat(position.entry_price)
      const current = parseFloat(current_price)
      const qty = parseFloat(position.quantity)
      const pnl = (current - entry) * qty
      const pnlPercent = ((current - entry) / entry) * 100
      
      updates.pnl = String(pnl.toFixed(2))
      updates.pnl_percent = String(pnlPercent.toFixed(2))
    }

    if (stop_loss !== undefined) updates.stop_loss = String(stop_loss)
    if (take_profit !== undefined) updates.take_profit = String(take_profit)
    
    updates.updated_at = new Date().toISOString()

    // Update position
    await client.hset(`position:${connection_id}:${positionId}`, updates)

    await logProgressionEvent(
      connection_id,
      "positions_api",
      "info",
      `Updated position ${positionId}`,
      { updates }
    )

    return NextResponse.json({
      success: true,
      data: { ...position, ...updates, id: positionId },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] PATCH error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to update position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/positions/[id] - Close/delete position
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Allow development/testing access without auth
    const user = process.env.NODE_ENV === "development" ? { id: 1, username: "dev" } : await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { id: positionId } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const closePrice = searchParams.get("close_price")
    const closeReason = searchParams.get("close_reason") || "manual"

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Get position for details and validation
    const position = await client.hgetall(`position:${connectionId}:${positionId}`)
    if (!position || Object.keys(position).length === 0) {
      return NextResponse.json({ success: false, error: "Position not found" }, { status: 404 })
    }

    console.log(`[v0] [PositionsAPI] DELETE: Closing position ${positionId} via API (reason: ${closeReason})`)

    // Determine if this is a live position or pseudo position by checking for live-position markers
    const isLivePosition = position.connectionId && (position.orderId || position.status === "filled")
    
    if (isLivePosition && closePrice) {
      // For live positions with close price, use the live-stage close logic
      try {
        const { closeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
        const closedPos = await closeLivePosition(
          connectionId,
          positionId,
          parseFloat(closePrice),
          undefined, // No connector for manual close - just update state
          closeReason
        )
        
        if (closedPos) {
          console.log(`[v0] [PositionsAPI] Successfully closed live position via live-stage`)
          return NextResponse.json({
            success: true,
            data: {
              id: positionId,
              status: "closed",
              closeReason: closeReason,
              final_pnl: closedPos.realizedPnL?.toFixed(2) || "0",
            },
          })
        }
      } catch (err) {
        console.error(`[v0] [PositionsAPI] Failed to use live-stage close:`, err)
        // Fall through to basic close
      }
    }

    // Fallback: Basic close for pseudo positions or when live-stage unavailable
    const finalPrice = closePrice ? parseFloat(closePrice) : parseFloat(position.current_price || "0")
    const entry = parseFloat(position.entry_price || "0")
    const qty = parseFloat(position.quantity || "0")
    const finalPnL = (finalPrice - entry) * qty

    // Mark as closed with comprehensive metadata
    await client.hset(`position:${connectionId}:${positionId}`, {
      status: "closed",
      close_price: String(finalPrice),
      final_pnl: String(finalPnL.toFixed(2)),
      close_reason: closeReason,
      closed_at: new Date().toISOString(),
      closed_via: "api",
    })

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Closed position ${positionId} via API`,
      { symbol: position.symbol, final_pnl: finalPnL, reason: closeReason }
    )

    console.log(`[v0] [PositionsAPI] Closed position ${positionId}: PnL=${finalPnL.toFixed(2)} reason=${closeReason}`)

    return NextResponse.json({
      success: true,
      data: { id: positionId, status: "closed", final_pnl: finalPnL.toFixed(2), close_reason: closeReason },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] DELETE error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to close position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}
