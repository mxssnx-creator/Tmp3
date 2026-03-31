import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connectionId") || searchParams.get("id")
    
    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId or id parameter required" },
        { status: 400 }
      )
    }
    
    await initRedis()
    const redis = getRedisClient()
    
    // Get strategy sets from Redis for this connection
    let baseStrategyCount = 0
    let mainStrategyCount = 0
    let realStrategyCount = 0
    let liveStrategyCount = 0
    
    try {
      // Query Redis for strategy sets by symbol
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      
      for (const symbol of symbols) {
        const baseKey = `strategies:${connectionId}:${symbol}:base`
        const mainKey = `strategies:${connectionId}:${symbol}:main`
        const realKey = `strategies:${connectionId}:${symbol}:real`
        const liveKey = `strategies:${connectionId}:${symbol}:live`
        
        const baseJson = await redis.get(baseKey)
        const mainJson = await redis.get(mainKey)
        const realJson = await redis.get(realKey)
        const liveJson = await redis.get(liveKey)
        
        if (baseJson) {
          const data = JSON.parse(baseJson)
          baseStrategyCount += data.count || data.strategies?.length || 0
        }
        if (mainJson) {
          const data = JSON.parse(mainJson)
          mainStrategyCount += data.count || data.strategies?.length || 0
        }
        if (realJson) {
          const data = JSON.parse(realJson)
          realStrategyCount += data.count || data.strategies?.length || 0
        }
        if (liveJson) {
          const data = JSON.parse(liveJson)
          liveStrategyCount += data.count || data.strategies?.length || 0
        }
      }
    } catch (e) {
      console.log(`[v0] [EngineStrategies] Error reading Redis:`, e)
    }
    
    return NextResponse.json({
      connectionId,
      strategies: {
        base: baseStrategyCount,
        main: mainStrategyCount,
        real: realStrategyCount,
        live: liveStrategyCount,
        total: baseStrategyCount + mainStrategyCount + realStrategyCount + liveStrategyCount,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [EngineStrategies] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch strategies status" },
      { status: 500 }
    )
  }
}
