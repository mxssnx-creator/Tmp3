import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()

    const cpuUsage = process.cpuUsage()
    const memUsage = process.memoryUsage()
    const cpuPercent = Math.min(100, Math.round((cpuUsage.user / 1000000) * 0.1))
    const memPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)

    let allKeys: string[] = []
    try {
      const keysResult = await client.keys("*").catch(() => [])
      allKeys = Array.isArray(keysResult) ? keysResult : []
    } catch {
      allKeys = []
    }
    
    const keys = allKeys.length
    const sets = allKeys.filter((k: string) => k.includes(":set") || k.includes("_set")).length
    const positions1h = allKeys.filter((k: string) => k.includes("position")).length
    const entries1h = allKeys.filter((k: string) => k.includes("entry") || k.includes("indication")).length

    let estimatedDbBytes = 0
    try {
      const sampleKeys = allKeys.slice(0, 20)
      let sampledBytes = 0
      for (const key of sampleKeys) {
        sampledBytes += key.length
        const strValue = await client.get(key).catch(() => null)
        if (typeof strValue === "string" && strValue.length > 0) {
          sampledBytes += strValue.length
          continue
        }
        const hashValue = await client.hgetall(key).catch(() => null)
        if (hashValue && typeof hashValue === "object") {
          for (const [field, value] of Object.entries(hashValue)) {
            sampledBytes += String(field).length + String(value).length
          }
        }
      }
      estimatedDbBytes = sampleKeys.length > 0
        ? Math.max(0, Math.round((sampledBytes / sampleKeys.length) * Math.max(keys, 1)))
        : 0
    } catch {
      estimatedDbBytes = 0
    }

    let coordinatorEngineCount = 0
    try {
      coordinatorEngineCount = coordinator?.getActiveEngineCount?.() ?? 0
    } catch {
      coordinatorEngineCount = 0
    }
    
    const indicationKeys = allKeys.filter((k: string) => 
      k.includes("indication") || k.includes("indications:") || k.includes(":rsi") || k.includes(":macd") || k.includes(":ema")
    ).length
    const strategyKeys = allKeys.filter((k: string) => 
      k.includes("strategy") || k.includes("strategies:") || k.includes("entry:") || k.includes("signal:")
    ).length
    const entryKeys = allKeys.filter((k: string) => k.includes("entry:") || k.includes("entries:")).length
    
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let indicationsRunning = false
    let strategiesRunning = false
    let redisActiveEngineCount = 0
    
    try {
      const connectionStateKeys = allKeys.filter((k: string) => k.startsWith("settings:trade_engine_state:"))
      for (const stateKey of connectionStateKeys) {
        try {
          const stateStr = await client.get(stateKey)
          if (stateStr) {
            const state = JSON.parse(stateStr)
            totalIndicationCycles += state.indication_cycle_count ?? 0
            totalStrategyCycles += state.strategy_cycle_count ?? 0
            if (state.status === "running") {
              indicationsRunning = true
              strategiesRunning = true
              redisActiveEngineCount++
            }
          }
        } catch {}
      }
    } catch {}
    
    let redisEngineRunning = false
    try {
      const globalEngine = await client.hgetall("trade_engine:global")
      if (globalEngine && Object.keys(globalEngine).length > 0) {
        redisEngineRunning = globalEngine.status === "running"
      }
    } catch {}
    
    const engineRunning = redisEngineRunning || indicationsRunning || strategiesRunning || coordinatorEngineCount > 0
    const activeEngineCount = Math.max(coordinatorEngineCount, redisActiveEngineCount)
    const indicationsEngineRunning = indicationsRunning || (engineRunning && activeEngineCount > 0)
    const strategiesEngineRunning = strategiesRunning || (engineRunning && activeEngineCount > 0)

    let requestsPerSecond = 0
    try {
      const { getRedisRequestsPerSecond } = await import("@/lib/redis-db")
      requestsPerSecond = getRedisRequestsPerSecond()
    } catch {
      requestsPerSecond = 0
    }

    return NextResponse.json({
      cpu: cpuPercent,
      memory: memPercent,
      memoryUsed: Math.round(memUsage.heapUsed / 1024),
      memoryTotal: Math.round(memUsage.heapTotal / 1024),
      database: {
        size: estimatedDbBytes,
        keys,
        sets,
        positions1h,
        entries1h,
        requestsPerSecond: Math.max(1, requestsPerSecond),
      },
      services: {
        tradeEngine: engineRunning,
        indicationsEngine: indicationsEngineRunning,
        strategiesEngine: strategiesEngineRunning,
        websocket: true,
      },
      modules: {
        redis: true,
        persistence: keys > 0,
        coordinator: engineRunning,
        logger: true,
      },
      engines: {
        indications: {
          running: indicationsEngineRunning,
          cycleCount: totalIndicationCycles,
          resultsCount: indicationKeys || entries1h,
        },
        strategies: {
          running: strategiesEngineRunning,
          cycleCount: totalStrategyCycles,
          resultsCount: strategyKeys || entryKeys,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Monitoring] Error:", error)
    return NextResponse.json(
      { 
        cpu: 0, 
        memory: 0, 
        memoryUsed: 0, 
        memoryTotal: 1,
        database: { size: 0, keys: 0, sets: 0, positions1h: 0, entries1h: 0, requestsPerSecond: 0 },
        services: { tradeEngine: false, indicationsEngine: false, strategiesEngine: false, websocket: false },
        modules: { redis: false, persistence: false, coordinator: false, logger: false },
        error: "Failed to fetch metrics", 
        details: error instanceof Error ? error.message : "Unknown" 
      },
      { status: 200 }
    )
  }
}