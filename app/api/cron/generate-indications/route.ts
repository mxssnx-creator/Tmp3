/**
 * Cron-style API that generates indications independently of the broken IndicationProcessor
 * This endpoint should be called periodically to ensure indications are being generated
 * even when the main trade engine's indication processor is failing due to cache issues.
 */
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

// Module-level cache - guaranteed to exist
const MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 2000

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

async function getMarketDataSafe(symbol: string): Promise<any | null> {
  // Check cache first
  const cached = MARKET_DATA_CACHE.get(symbol)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  
  try {
    // Dynamic import to get fresh module
    const { initRedis, getRedisClient } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()
    
    // Try hash format first
    const hashData = await client.hgetall(`market_data:${symbol}`)
    if (hashData && Object.keys(hashData).length > 0) {
      MARKET_DATA_CACHE.set(symbol, { data: hashData, timestamp: Date.now() })
      return hashData
    }
    
    // Try string format
    const stringData = await client.get(`market_data:${symbol}`)
    if (stringData) {
      const parsed = JSON.parse(stringData)
      MARKET_DATA_CACHE.set(symbol, { data: parsed, timestamp: Date.now() })
      return parsed
    }
    
    return null
  } catch (e) {
    console.error(`[v0] [CronIndications] Error getting market data for ${symbol}:`, e)
    return null
  }
}

async function generateIndicationsForSymbol(symbol: string, connectionId: string, client: any): Promise<number> {
  try {
    const marketData = await getMarketDataSafe(symbol)
    if (!marketData) return 0
    
    const close = parseFloat(marketData?.close || marketData?.c || "0")
    const open = parseFloat(marketData?.open || marketData?.o || "0")
    const high = parseFloat(marketData?.high || marketData?.h || "0")
    const low = parseFloat(marketData?.low || marketData?.l || "0")
    
    if (close === 0) return 0
    
    const now = Date.now()
    const direction = close >= open ? "long" : "short"
    const range = high - low
    const rangePercent = (range / close) * 100
    
    const indications = [
      { type: "direction", symbol, value: direction === "long" ? 1 : -1, profitFactor: 1.2, confidence: 0.7, timestamp: now },
      { type: "move", symbol, value: rangePercent > 2 ? 1 : 0, profitFactor: 1.0 + rangePercent/100, confidence: 0.6, timestamp: now },
      { type: "active", symbol, value: rangePercent > 1 ? 1 : 0, profitFactor: 1.1, confidence: 0.65, timestamp: now },
      { type: "optimal", symbol, value: direction === "long" && rangePercent > 1.5 ? 1 : 0, profitFactor: 1.3, confidence: 0.75, timestamp: now },
    ]
    
    // Save to Redis
    const key = `indications:${connectionId}`
    const existing = await client.get(key).catch(() => null)
    const existingArr = existing ? JSON.parse(existing) : []
    existingArr.push(...indications)
    const trimmed = existingArr.slice(-1000)
    await client.set(key, JSON.stringify(trimmed))
    
    return indications.length
  } catch (e) {
    return 0
  }
}

export async function GET() {
  console.log("[v0] [CronIndications] Starting indication generation...")
  
  try {
    const { initRedis, getRedisClient, getAllConnections } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()
    
    // Get active connections
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) => c.isActive || c.is_active)
    
    let totalGenerated = 0
    
    for (const connection of activeConnections) {
      for (const symbol of SYMBOLS) {
        const count = await generateIndicationsForSymbol(symbol, connection.id, client)
        totalGenerated += count
      }
    }
    
    console.log(`[v0] [CronIndications] Generated ${totalGenerated} indications for ${activeConnections.length} connections`)
    
    return NextResponse.json({
      success: true,
      generated: totalGenerated,
      connections: activeConnections.length,
      symbols: SYMBOLS,
      timestamp: Date.now()
    })
  } catch (error) {
    console.error("[v0] [CronIndications] Error:", error)
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, { status: 500 })
  }
}

// Also support POST for flexibility
export async function POST() {
  return GET()
}
