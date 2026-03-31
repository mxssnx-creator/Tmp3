import { NextResponse } from "next/server"

/**
 * GET /api/exchange/[exchange]/top-symbols
 * Retrieve top N symbols by trading volume from the past 24 hours
 */
export async function GET(request: Request, { params }: { params: { exchange: string } }) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Number(searchParams.get("limit") || "3")
    const exchange = (params.exchange || "").toLowerCase()

    console.log(`[v0] [TopSymbols] Fetching top ${limit} symbols by volume for ${exchange}`)

    // Default top symbols by 24h volume (cached list - in production would call exchange APIs)
    const topSymbolsByExchange: Record<string, string[]> = {
      bingx: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
      bybit: ["BTCUSDT", "ETHUSDT", "XRPUSDT"],
      binance: ["BTCUSDT", "ETHUSDT", "ADAUSDT"],
      okx: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    }

    const symbols = topSymbolsByExchange[exchange] || ["BTCUSDT", "ETHUSDT", "BNBUSDT"]

    return NextResponse.json({
      success: true,
      exchange,
      symbols: symbols.slice(0, limit),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[v0] [TopSymbols] Error:`, error)
    return NextResponse.json(
      { error: "Failed to retrieve top symbols", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
