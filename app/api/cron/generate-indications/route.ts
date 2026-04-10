/**
 * Cron-style API that generates indications for active-inserted connections.
 * Uses real market data from Redis and writes to the progression hash so the
 * dashboard reads real values from progression:{connectionId}.
 */
import { NextResponse } from "next/server"
import { isTruthyFlag, isConnectionInActivePanel } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

async function getMarketData(symbol: string, client: any): Promise<any | null> {
  try {
    const hashData = await client.hgetall(`market_data:${symbol}`)
    if (hashData && Object.keys(hashData).length > 0) return hashData

    const stringData = await client.get(`market_data:${symbol}`)
    if (stringData) return typeof stringData === "string" ? JSON.parse(stringData) : stringData

    return null
  } catch {
    return null
  }
}

async function generateIndicationsForConnection(
  connectionId: string,
  symbol: string,
  client: any,
): Promise<number> {
  try {
    const marketData = await getMarketData(symbol, client)
    if (!marketData) return 0

    const close = parseFloat(marketData?.close || marketData?.c || "0")
    const open  = parseFloat(marketData?.open  || marketData?.o || "0")
    const high  = parseFloat(marketData?.high  || marketData?.h || "0")
    const low   = parseFloat(marketData?.low   || marketData?.l || "0")

    if (close === 0) return 0

    const direction    = close >= open ? "long" : "short"
    const range        = high - low
    const rangePercent = (range / close) * 100
    const now          = Date.now()

    const indications = [
      { type: "direction", value: direction === "long" ? 1 : -1,           confidence: 0.70, profitFactor: 1.2 },
      { type: "move",      value: rangePercent > 2 ? 1 : 0,               confidence: 0.60, profitFactor: 1.0 + rangePercent / 100 },
      { type: "active",    value: rangePercent > 1 ? 1 : 0,               confidence: 0.65, profitFactor: 1.1 },
      { type: "optimal",   value: direction === "long" && rangePercent > 1.5 ? 1 : 0, confidence: 0.75, profitFactor: 1.3 },
    ]

    const progKey = `progression:${connectionId}`

    for (const ind of indications) {
      const field = `indications_${ind.type}_count`
      await client.hincrby(progKey, field, 1)

      // Store latest indication value for dashboard type breakdown
      await client.hset(`indications:${connectionId}:${ind.type}:latest`, {
        symbol,
        value: String(ind.value),
        confidence: String(ind.confidence),
        profitFactor: String(ind.profitFactor),
        timestamp: String(now),
      })
      await client.expire(`indications:${connectionId}:${ind.type}:latest`, 3600)
    }

    await client.hincrby(progKey, "indications_count", indications.length)
    await client.expire(progKey, 7 * 24 * 60 * 60)

    return indications.length
  } catch {
    return 0
  }
}

export async function GET() {
  console.log("[v0] [CronIndications] Starting indication generation...")

  try {
    const { initRedis, getRedisClient, getAllConnections } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()

    const connections = await getAllConnections()

    // Use active-inserted connections — same eligibility as the trade engine
    const activeConnections = connections.filter(
      (c: any) =>
        isConnectionInActivePanel(c) ||
        isTruthyFlag(c.is_active_inserted) ||
        isTruthyFlag(c.is_assigned)
    )

    let totalGenerated = 0

    for (const connection of activeConnections) {
      for (const symbol of SYMBOLS) {
        const count = await generateIndicationsForConnection(connection.id, symbol, client)
        totalGenerated += count
      }
    }

    console.log(
      `[v0] [CronIndications] Generated ${totalGenerated} indications for ${activeConnections.length} connections`,
    )

    return NextResponse.json({
      success: true,
      generated: totalGenerated,
      connections: activeConnections.length,
      symbols: SYMBOLS,
      timestamp: Date.now(),
    })
  } catch (error) {
    console.error("[v0] [CronIndications] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function POST() {
  return GET()
}
