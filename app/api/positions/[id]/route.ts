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
    const user = await getSession()
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
    const user = await getSession()
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
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const { id: positionId } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const closePrice = searchParams.get("close_price")

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Get position for final calculation
    const position = await client.hgetall(`position:${connectionId}:${positionId}`)
    if (!position || Object.keys(position).length === 0) {
      return NextResponse.json({ success: false, error: "Position not found" }, { status: 404 })
    }

    // Mark as closed
    const finalPrice = closePrice ? parseFloat(closePrice) : parseFloat(position.current_price)
    const entry = parseFloat(position.entry_price)
    const qty = parseFloat(position.quantity)
    const finalPnL = (finalPrice - entry) * qty

    await client.hset(`position:${connectionId}:${positionId}`, {
      status: "closed",
      close_price: String(finalPrice),
      final_pnl: String(finalPnL.toFixed(2)),
      closed_at: new Date().toISOString(),
    })

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Closed position ${positionId}`,
      { symbol: position.symbol, final_pnl: finalPnL }
    )

    return NextResponse.json({
      success: true,
      data: { id: positionId, status: "closed", final_pnl: finalPnL.toFixed(2) },
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
