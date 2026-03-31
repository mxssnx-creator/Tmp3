import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getSettings, setSettings } from "@/lib/redis-db"

export const runtime = "nodejs"

/**
 * GET /api/market-data
 * Returns market data (mock for development, real-time in production)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const symbol = searchParams.get("symbol") || "BTCUSDT"
    const exchange = searchParams.get("exchange") || "bybit"
    const interval = searchParams.get("interval") || "1m"

    await initRedis()

    // Check cache
    const cacheKey = `market:${exchange}:${symbol}:${interval}`
    let marketData = await getSettings(cacheKey)

    if (!marketData) {
      // Generate mock market data for development
      const basePrice = getBasePrice(symbol)
      const variation = basePrice * 0.02
      
      marketData = {
        symbol,
        exchange,
        interval,
        price: basePrice + (Math.random() - 0.5) * variation,
        open: basePrice,
        high: basePrice + variation,
        low: basePrice - variation,
        close: basePrice + (Math.random() - 0.5) * variation,
        volume: Math.random() * 1000000,
        volume_24h: Math.random() * 10000000,
        high_24h: basePrice + variation,
        low_24h: basePrice - variation,
        change_24h: (Math.random() - 0.5) * 5,
        change_24h_percentage: ((Math.random() - 0.5) * 5).toFixed(2) + "%",
        timestamp: Date.now(),
        datetime: new Date().toISOString(),
        bid: basePrice - 0.5,
        ask: basePrice + 0.5,
        bid_volume: Math.random() * 100,
        ask_volume: Math.random() * 100,
        last_update: new Date().toISOString(),
      }

      // Cache for 5 seconds
      await setSettings(cacheKey, JSON.stringify(marketData))
    } else if (typeof marketData === "string") {
      try {
        marketData = JSON.parse(marketData)
      } catch {
        // If parsing fails, use the value as-is
      }
    }

    return NextResponse.json({
      success: true,
      data: marketData,
    })
  } catch (error) {
    console.error("[v0] Market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

/**
 * POST /api/market-data/batch
 * Fetch market data for multiple symbols
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbols, exchange = "bybit", interval = "1m" } = body

    if (!Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json(
        { success: false, error: "Symbols array is required" },
        { status: 400 },
      )
    }

    await initRedis()

    const marketData: Record<string, any> = {}

    for (const symbol of symbols) {
      const cacheKey = `market:${exchange}:${symbol}:${interval}`
      let data = await getSettings(cacheKey)

      if (!data) {
        const basePrice = getBasePrice(symbol)
        const variation = basePrice * 0.02

        data = {
          symbol,
          exchange,
          interval,
          price: basePrice + (Math.random() - 0.5) * variation,
          open: basePrice,
          high: basePrice + variation,
          low: basePrice - variation,
          close: basePrice + (Math.random() - 0.5) * variation,
          volume: Math.random() * 1000000,
          timestamp: Date.now(),
          datetime: new Date().toISOString(),
          bid: basePrice - 0.5,
          ask: basePrice + 0.5,
          last_update: new Date().toISOString(),
        }

        await setSettings(cacheKey, JSON.stringify(data))
      } else if (typeof data === "string") {
        try {
          data = JSON.parse(data)
        } catch {
          // Use as-is if parsing fails
        }
      }

      marketData[symbol] = data
    }

    return NextResponse.json({
      success: true,
      count: Object.keys(marketData).length,
      data: marketData,
    })
  } catch (error) {
    console.error("[v0] Batch market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch batch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

function getBasePrice(symbol: string): number {
  if (symbol.includes("BTC")) return 45000
  if (symbol.includes("ETH")) return 2500
  if (symbol.includes("BNB")) return 300
  if (symbol.includes("XRP")) return 0.5
  if (symbol.includes("ADA")) return 0.4
  if (symbol.includes("DOGE")) return 0.08
  if (symbol.includes("SOL")) return 100
  if (symbol.includes("MATIC")) return 0.8
  if (symbol.includes("DOT")) return 7
  if (symbol.includes("AVAX")) return 35
  return 100
}
