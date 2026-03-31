import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getRedisClient } from "@/lib/redis-db"

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  takeProfitPrice?: number
  stopLossPrice?: number
  createdAt: string
  status: "open" | "closing" | "closed"
}

function generateMockPositions(connectionId: string, count: number = 25): Position[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT"]
  const now = Date.now()

  return Array.from({ length: count }, (_, i) => {
    const symbol = symbols[i % symbols.length]
    const entryPrice = 40000 + Math.random() * 20000
    const currentPrice = entryPrice * (1 + (Math.random() - 0.5) * 0.05)
    const quantity = 0.1 + Math.random() * 1
    const leverage = Math.floor(1 + Math.random() * 20)
    const pnl = (currentPrice - entryPrice) * quantity * leverage
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100

    return {
      id: `pos-${connectionId}-${i}`,
      symbol,
      side: Math.random() > 0.5 ? "LONG" : "SHORT",
      entryPrice,
      currentPrice,
      quantity,
      leverage,
      unrealizedPnl: pnl,
      unrealizedPnlPercent: pnlPercent,
      takeProfitPrice: entryPrice * 1.05,
      stopLossPrice: entryPrice * 0.95,
      createdAt: new Date(now - Math.random() * 24 * 60 * 60 * 1000).toISOString(),
      status: "open",
    }
  })
}

async function getRealPositions(connectionId: string): Promise<Position[]> {
  try {
    const client = await getRedisClient()
    
    // Get position IDs for this connection
    const positionIds = await client.smembers(`positions:by-connection:${connectionId}`)
    
    if (!positionIds || positionIds.length === 0) {
      return []
    }

    const positions: Position[] = []

    // Fetch each position from Redis
    for (const posId of positionIds) {
      try {
        const posData = await client.get(`position:${posId}`)
        if (posData) {
          const pos = JSON.parse(posData)
          positions.push({
            id: pos.id || posId,
            symbol: pos.symbol || "UNKNOWN",
            side: pos.side || "LONG",
            entryPrice: Number(pos.entryPrice) || 0,
            currentPrice: Number(pos.currentPrice) || 0,
            quantity: Number(pos.quantity) || 0,
            leverage: Number(pos.leverage) || 1,
            unrealizedPnl: Number(pos.unrealizedPnl) || 0,
            unrealizedPnlPercent: Number(pos.unrealizedPnlPercent) || 0,
            takeProfitPrice: pos.takeProfitPrice ? Number(pos.takeProfitPrice) : undefined,
            stopLossPrice: pos.stopLossPrice ? Number(pos.stopLossPrice) : undefined,
            createdAt: pos.createdAt || new Date().toISOString(),
            status: pos.status || "open",
          })
        }
      } catch (err) {
        console.warn(`Failed to parse position ${posId}:`, err)
      }
    }

    return positions
  } catch (error) {
    console.error(`Failed to get real positions for ${connectionId}:`, error)
    return []
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId query parameter required" }, { status: 400 })
    }

    // Determine if this is a demo connection or real connection
    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let positions: Position[] = []

    if (isDemo) {
      // Generate mock positions for demo mode
      positions = generateMockPositions(connectionId)
    } else {
      // Try to get real positions from Redis, fallback to empty
      positions = await getRealPositions(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: positions,
      isDemo,
      connectionId,
    })
  } catch (error) {
    console.error("[v0] Get positions error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
