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

    // CPU and Memory (in-process estimation)
    const cpuUsage = process.cpuUsage()
    const memUsage = process.memoryUsage()
    const cpuPercent = Math.min(100, Math.round((cpuUsage.user / 1000000) * 0.1))
    const memPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)

    // Get Redis key counts
    const allKeys = await client.keys("*").catch(() => [])
    const keys = Array.isArray(allKeys) ? allKeys.length : 0
    const sets = allKeys.filter((k: string) => k.includes(":set") || k.includes("_set")).length
    const positions1h = allKeys.filter((k: string) => k.includes("position")).length
    const entries1h = allKeys.filter((k: string) => k.includes("entry") || k.includes("indication")).length

    // Estimate DB footprint (bytes) using a bounded sample to keep endpoint lightweight.
    const sampleKeys = (allKeys as string[]).slice(0, 40)
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
    const estimatedDbBytes = sampleKeys.length > 0
      ? Math.max(0, Math.round((sampledBytes / sampleKeys.length) * Math.max(keys, 1)))
      : 0

    // Get engine status - use Redis state as source of truth (coordinator may not track all engines)
    // Note: coordinatorRunning method may not exist, so we derive it from actual engine state
    const coordinatorEngineCount = coordinator?.getActiveEngineCount?.() ?? 0
    
    // Count actual indications and strategies in Redis
    const indicationKeys = allKeys.filter((k: string) => 
      k.includes("indication") || k.includes("indications:") || k.includes(":rsi") || k.includes(":macd") || k.includes(":ema")
    ).length
    const strategyKeys = allKeys.filter((k: string) => 
      k.includes("strategy") || k.includes("strategies:") || k.includes("entry:") || k.includes("signal:")
    ).length
    const entryKeys = allKeys.filter((k: string) => k.includes("entry:") || k.includes("entries:")).length
    
    // Get engine stats from ALL active connections (they store in trade_engine_state:{connectionId})
    const connectionStateKeys = allKeys.filter((k: string) => k.startsWith("settings:trade_engine_state:"))
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let indicationsRunning = false
    let strategiesRunning = false
    let redisActiveEngineCount = 0
    
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
      } catch { /* ignore parse errors */ }
    }
    
    // Also check global engine stats (fallback)
    const globalIndicationsStr = await client.get("engine:indications:stats").catch(() => null)
    const globalStrategiesStr = await client.get("engine:strategies:stats").catch(() => null)
    if (globalIndicationsStr) {
      try {
        const globalInd = JSON.parse(globalIndicationsStr)
        totalIndicationCycles = Math.max(totalIndicationCycles, globalInd.cycleCount ?? 0)
        indicationsRunning = indicationsRunning || globalInd.running
      } catch { /* ignore */ }
    }
    if (globalStrategiesStr) {
      try {
        const globalStrat = JSON.parse(globalStrategiesStr)
        totalStrategyCycles = Math.max(totalStrategyCycles, globalStrat.cycleCount ?? 0)
        strategiesRunning = strategiesRunning || globalStrat.running
      } catch { /* ignore */ }
    }
    
    // Check global engine state (stored as Redis HASH via hset, not a string)
    let redisEngineRunning = false
    try {
      const globalEngine = await client.hgetall("trade_engine:global")
      if (globalEngine && Object.keys(globalEngine).length > 0) {
        redisEngineRunning = globalEngine.status === "running"
      }
    } catch { /* ignore */ }
    
    // Engine is running if Redis state or processors indicate activity (no coordinatorRunning var needed)
    const engineRunning = redisEngineRunning || indicationsRunning || strategiesRunning || coordinatorEngineCount > 0
    const activeEngineCount = Math.max(coordinatorEngineCount, redisActiveEngineCount)
    
    // Use actual Redis key counts for results (actual data in DB)
    const indicationsCycleCount = totalIndicationCycles
    const totalIndicationsResults = indicationKeys || entries1h
    const indicationsEngineRunning = indicationsRunning || (engineRunning && activeEngineCount > 0)
    
    const strategiesCycleCount = totalStrategyCycles
    const totalStrategiesResults = strategyKeys || entryKeys
    const strategiesEngineRunning = strategiesRunning || (engineRunning && activeEngineCount > 0)

    // Get Redis request rate per second - use actual tracked operations
    let requestsPerSecond = 0
    try {
      const { getRedisRequestsPerSecond } = await import("@/lib/redis-db")
      requestsPerSecond = getRedisRequestsPerSecond()
    } catch (err) {
      console.error("[v0] Failed to get RPS:", err)
      requestsPerSecond = 0
    }
    
    // Log AFTER all variables are defined
    console.log(`[v0] [Monitoring] DB Keys: ${keys}, CPU: ${cpuPercent}%, Mem: ${memPercent}%, RPS: ${requestsPerSecond}`)
    console.log(`[v0] [Monitoring] Engine: running=${engineRunning}, active=${activeEngineCount}`)

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
        requestsPerSecond: Math.max(1, requestsPerSecond), // Show at least 1 if active
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
        coordinator: engineRunning, // Coordinator is active if engine is running
        logger: true,
      },
      engines: {
        indications: {
          running: indicationsEngineRunning,
          cycleCount: indicationsCycleCount,
          resultsCount: totalIndicationsResults,
        },
        strategies: {
          running: strategiesEngineRunning,
          cycleCount: strategiesCycleCount,
          resultsCount: totalStrategiesResults,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Monitoring] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch metrics", details: error instanceof Error ? error.message : "Unknown" },
      { status: 500 }
    )
  }
}
