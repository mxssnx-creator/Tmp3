import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * GET /api/positions - Get positions for a connection with filtering
 * Query params: connection_id, status, symbol, limit, offset
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    await initRedis()
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const status = searchParams.get("status") || "all"
    const symbol = searchParams.get("symbol")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 1000)
    const offset = parseInt(searchParams.get("offset") || "0")

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    const client = getRedisClient()
    
    // Get all position IDs for this connection
    const positionIds = await client.smembers(`positions:${connectionId}`)
    
    if (!positionIds || positionIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        count: 0,
        total: 0,
        limit,
        offset,
        duration: Date.now() - startTime,
      })
    }

    // Fetch and filter positions (batch processing)
    const positions: any[] = []
    let processed = 0
    
    for (const posId of positionIds) {
      const pos = await client.hgetall(`position:${connectionId}:${posId}`)
      if (!pos || Object.keys(pos).length === 0) continue
      
      processed++
      
      // Apply filters
      if (status !== "all" && pos.status !== status) continue
      if (symbol && pos.symbol !== symbol) continue
      
      positions.push({ ...pos, id: posId })
    }

    // Apply pagination
    const paginated = positions.slice(offset, offset + limit)

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Fetched ${paginated.length} positions`,
      { total: positions.length, processed, offset, limit, filters: { status, symbol } }
    )

    return NextResponse.json({
      success: true,
      data: paginated,
      count: paginated.length,
      total: positions.length,
      limit,
      offset,
      duration: Date.now() - startTime,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] GET error:", errorMsg)
    
    await logProgressionEvent(
      "system",
      "positions_api_error",
      "error",
      `GET /api/positions error: ${errorMsg}`
    )

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch positions",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/positions - Create new position
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now()
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    await initRedis()
    const body = await request.json()
    
    const {
      connection_id,
      symbol,
      position_type,
      entry_price,
      quantity,
      leverage,
      stop_loss,
      take_profit,
      margin_type,
      side,
      trade_mode,
    } = body

    // Validate required fields
    if (!connection_id || !symbol || !position_type || !entry_price || !quantity) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields",
          required: ["connection_id", "symbol", "position_type", "entry_price", "quantity"],
        },
        { status: 400 }
      )
    }

    // Validate numeric fields
    if (isNaN(parseFloat(entry_price)) || isNaN(parseFloat(quantity))) {
      return NextResponse.json({ success: false, error: "entry_price and quantity must be valid numbers" }, { status: 400 })
    }

    const client = getRedisClient()
    const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // Store position
    await client.hset(`position:${connection_id}:${posId}`, {
      id: posId,
      connection_id,
      symbol,
      position_type,
      entry_price: String(entry_price),
      current_price: String(entry_price),
      quantity: String(quantity),
      leverage: String(leverage || 1),
      stop_loss: String(stop_loss || ""),
      take_profit: String(take_profit || ""),
      margin_type: margin_type || "isolated",
      side: side || "long",
      trade_mode: trade_mode || "main",
      status: "open",
      opened_at: new Date().toISOString(),
      pnl: "0",
      pnl_percent: "0",
    })

    // Add to position set for this connection
    await client.sadd(`positions:${connection_id}`, posId)

    await logProgressionEvent(
      connection_id,
      "positions_api",
      "info",
      `Created position ${posId}`,
      { symbol, position_type, entry_price, quantity, leverage }
    )

    return NextResponse.json({
      success: true,
      data: { id: posId, status: "open" },
      duration: Date.now() - startTime,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] POST error:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to create position",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 }
    )
  }
}
