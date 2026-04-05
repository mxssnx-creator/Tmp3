import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// High-performance cache for strategy data (5 second TTL)
const strategiesCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 5000

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
    
    // Check high-performance cache first
    const cacheKey = `strategies:${connectionId}`
    const cached = strategiesCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.data)
    }
    
    await initRedis()
    const redis = getRedisClient()
    
    if (!redis) {
      return NextResponse.json(
        { error: "Redis not available" },
        { status: 503 }
      )
    }
    
    try {
      // OPTIMIZATION: Batch scan all strategy keys at once instead of querying hardcoded symbols
      let baseStrategyCount = 0
      let mainStrategyCount = 0
      let realStrategyCount = 0
      let evaluatedBase = 0
      let evaluatedMain = 0
      let evaluatedReal = 0
      
      // Use SCAN to efficiently get all strategy keys in batch (high-frequency optimized)
      let cursor = "0"
      const batchSize = 100
      let iterations = 0
      const maxIterations = 50 // Safety limit to prevent infinite loops
      
      do {
        try {
          // Scan for strategy keys matching pattern (non-blocking)
          const result = await redis.scan(cursor, {
            match: `strategies:${connectionId}:*`,
            count: batchSize,
          })
          
          cursor = result[0]
          const keys = result[1] || []
          
          // Process keys efficiently
          for (const key of keys) {
            try {
              const data = await redis.get(key)
              if (!data) continue
              
              const parsed = JSON.parse(data)
              const count = parsed.count || parsed.strategies?.length || 0
              const evaluated = parsed.evaluated || 0
              
              if (key.includes(":base")) {
                baseStrategyCount += count
                evaluatedBase += evaluated
              } else if (key.includes(":main")) {
                mainStrategyCount += count
                evaluatedMain += evaluated
              } else if (key.includes(":real")) {
                realStrategyCount += count
                evaluatedReal += evaluated
              }
            } catch (parseErr) {
              // Skip malformed data
              continue
            }
          }
          
          iterations++
        } catch (scanErr) {
          console.warn(`[v0] [EngineStrategies] Error during scan:`, scanErr)
          break
        }
      } while (cursor !== "0" && iterations < maxIterations)
      
      const response = {
        connectionId,
        strategies: {
          base: baseStrategyCount,
          main: mainStrategyCount,
          real: realStrategyCount,
          total: baseStrategyCount + mainStrategyCount + realStrategyCount,
        },
        evaluated: {
          base: evaluatedBase,
          main: evaluatedMain,
          real: evaluatedReal,
          total: evaluatedBase + evaluatedMain + evaluatedReal,
        },
        timestamp: new Date().toISOString(),
      }
      
      // Cache for 5 seconds (high-frequency access)
      strategiesCache.set(cacheKey, { data: response, timestamp: Date.now() })
      
      return NextResponse.json(response)
    } catch (redisErr) {
      console.error(`[v0] [EngineStrategies] Redis error:`, redisErr)
      return NextResponse.json(
        { error: "Failed to fetch strategies from Redis" },
        { status: 503 }
      )
    }
  } catch (error) {
    console.error("[v0] [EngineStrategies] Fatal error:", error)
    return NextResponse.json(
      { error: "Failed to fetch strategies status" },
      { status: 500 }
    )
  }
}
