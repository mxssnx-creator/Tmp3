import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getActiveIndications, getBestPerformingIndications } from "@/lib/db-helpers"
import { getRedisClient } from "@/lib/redis-db"

interface Indication {
  id: string
  symbol: string
  indicationType: string
  direction: "UP" | "DOWN" | "NEUTRAL"
  confidence: number
  strength: number
  timestamp: string
  enabled: boolean
  metadata?: {
    macdValue?: number
    rsiValue?: number
    maValue?: number
    bbUpper?: number
    bbLower?: number
    volatility?: number
  }
}

function generateMockIndications(connectionId: string): Indication[] {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AAPL", "EURUSD", "XAUUSD"]
  const types = ["Momentum", "Volatility", "Trend", "Mean Reversion", "Volume"]
  const directions: ("UP" | "DOWN" | "NEUTRAL")[] = ["UP", "DOWN", "NEUTRAL"]

  return Array.from({ length: 200 }, (_, i) => {
    const now = new Date()
    const minutesAgo = Math.floor(Math.random() * 60)
    const timestamp = new Date(now.getTime() - minutesAgo * 60000).toISOString()

    return {
      id: `ind-${connectionId}-${i}`,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      indicationType: types[Math.floor(Math.random() * types.length)],
      direction: directions[Math.floor(Math.random() * directions.length)],
      confidence: 30 + Math.random() * 70,
      strength: Math.random() * 100,
      timestamp,
      enabled: Math.random() > 0.3,
      metadata: {
        rsiValue: 30 + Math.random() * 40,
        macdValue: (Math.random() - 0.5) * 0.01,
        volatility: 15 + Math.random() * 30,
      },
    }
  })
}

async function getRealIndications(connectionId: string): Promise<Indication[]> {
  try {
    // Try to get active indications from Redis first
    const activeIndications = await getActiveIndications(connectionId)
    
    if (activeIndications && activeIndications.length > 0) {
      // Convert Redis data to Indication interface
      return activeIndications.map((ind: any) => ({
        id: ind.id || `ind-${Date.now()}-${Math.random()}`,
        symbol: ind.symbol || "UNKNOWN",
        indicationType: ind.indication_type || ind.type || "Unknown",
        direction: (ind.direction || "NEUTRAL") as "UP" | "DOWN" | "NEUTRAL",
        confidence: Number(ind.confidence) || 50,
        strength: Number(ind.strength) || 50,
        timestamp: ind.timestamp || new Date().toISOString(),
        enabled: ind.enabled !== false && ind.enabled !== "0",
        metadata: {
          rsiValue: ind.rsi ? Number(ind.rsi) : undefined,
          macdValue: ind.macd ? Number(ind.macd) : undefined,
          volatility: ind.volatility ? Number(ind.volatility) : undefined,
        },
      }))
    }

    // If no active indications, try getting best performing ones
    const bestIndications = await getBestPerformingIndications(connectionId)
    if (bestIndications && bestIndications.length > 0) {
      return bestIndications.map((ind: any) => ({
        id: ind.id || `ind-${Date.now()}-${Math.random()}`,
        symbol: ind.symbol || "UNKNOWN",
        indicationType: ind.indication_type || ind.type || "Unknown",
        direction: (ind.direction || "NEUTRAL") as "UP" | "DOWN" | "NEUTRAL",
        confidence: Number(ind.confidence) || 50,
        strength: Number(ind.strength) || 50,
        timestamp: ind.timestamp || new Date().toISOString(),
        enabled: ind.enabled !== false && ind.enabled !== "0",
        metadata: {
          rsiValue: ind.rsi ? Number(ind.rsi) : undefined,
          macdValue: ind.macd ? Number(ind.macd) : undefined,
          volatility: ind.volatility ? Number(ind.volatility) : undefined,
        },
      }))
    }

    // Return empty array if no indications found
    return []
  } catch (error) {
    console.error(`[v0] Failed to get real indications for ${connectionId}:`, error)
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

    let indications: Indication[] = []

    if (isDemo) {
      // Generate mock indications for demo mode
      indications = generateMockIndications(connectionId)
    } else {
      // Fetch real indications from trading engine via Redis
      indications = await getRealIndications(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: indications,
      isDemo,
      connectionId,
      count: indications.length,
    })
  } catch (error) {
    console.error("[v0] Get indications error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
