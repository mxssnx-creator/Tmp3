import { NextResponse } from "next/server"
import { getAllConnections } from "@/lib/redis-db"
import { getTopVolatileSymbols, cacheVolatilityMetrics } from "@/lib/volatility-calculator"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * GET /api/symbols/screen-volatility
 * Screens available symbols for high volatility in the last hour
 * Returns top 3 high-volatility symbols suitable for active trading
 */
export async function GET() {
  try {
    // Get all connections and their symbols
    const connections = await getAllConnections()
    const allSymbols = new Set<string>()

    for (const conn of connections) {
      const symbols = conn.symbols || conn.active_symbols || ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      if (Array.isArray(symbols)) {
        symbols.forEach((s: string) => allSymbols.add(s))
      }
    }

    const symbolsArray = Array.from(allSymbols)

    // Screen for high volatility (>2% range in last hour)
    const topVolatile = await getTopVolatileSymbols(symbolsArray, 3, 2.0)

    // Cache the results
    for (const metrics of topVolatile) {
      await cacheVolatilityMetrics(metrics)
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      screened: symbolsArray.length,
      highVolatile: topVolatile.length,
      results: topVolatile.map(m => ({
        symbol: m.symbol,
        volatility: `${m.lastHourRangePercent}%`,
        score: m.volatilityScore,
        range: `${Math.round(m.high * 100) / 100} - ${Math.round(m.low * 100) / 100}`,
        isHighVolatility: m.isHighVolatility,
      })),
      selectedSymbols: topVolatile.map(m => m.symbol),
    })
  } catch (error) {
    console.error("[v0] Error screening symbols:", error)
    return NextResponse.json(
      { error: "Failed to screen symbols", details: (error as Error).message },
      { status: 500 }
    )
  }
}
