import { NextResponse } from "next/server"
import { getSettings, getRedisClient } from "@/lib/redis-db"
import { query } from "@/lib/db"

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 })
    }

    // Get indication and strategy cycle counts from Redis state
    const engState = await getSettings(`trade_engine_state:${connectionId}`)
    const engHealth = await getSettings(`trade_engine_health:${connectionId}`)
    const progState = await getSettings(`progression_state:${connectionId}`)

    console.log(`[v0] [EngineStats] ${connectionId}: engState indication_cycle_count=${(engState as any)?.indication_cycle_count}, strategy_cycle_count=${(engState as any)?.strategy_cycle_count}`)

    let indicationCycleCount = (engState as any)?.indication_cycle_count || (engHealth as any)?.indications?.cycleCount || 0
    let strategyCycleCount = (engState as any)?.strategy_cycle_count || (engHealth as any)?.strategies?.cycleCount || 0
    const realtimeCycleCount = (engHealth as any)?.realtime?.cycleCount || 0

    console.log(`[v0] [EngineStats] ${connectionId}: FINAL cycleCount - indication=${indicationCycleCount}, strategy=${strategyCycleCount}`)

    // Get strategy sets from Redis (where they're actually stored)
    const redis = getRedisClient()
    let baseStrategyCount = 0
    let mainStrategyCount = 0
    let realStrategyCount = 0
    let liveStrategyCount = 0

    try {
      // Query Redis for strategy sets (stored by StrategyCoordinator)
      // Pattern: strategies:{connectionId}:{symbol}:{type}
      const keys = await redis.keys(`strategies:${connectionId}:*`)
      
      for (const key of keys) {
        const dataJson = await redis.get(key)
        if (dataJson) {
          try {
            const data = JSON.parse(dataJson)
            const count = data.count || data.strategies?.length || 0
            
            if (key.includes(":base")) baseStrategyCount += count
            else if (key.includes(":main")) mainStrategyCount += count
            else if (key.includes(":real")) realStrategyCount += count
            else if (key.includes(":live")) liveStrategyCount += count
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    } catch (e) {
      console.log(`[v0] [EngineStats] ${connectionId}: Error reading Redis strategy sets:`, e)
    }

    // Build response with counts from Redis
    const indicationsByType: Record<string, number> = {
      base: 0,
      main: 0,
      real: 0,
      live: 0,
    }

    const strategiesByType: Record<string, number> = {
      base: baseStrategyCount,
      main: mainStrategyCount,
      real: realStrategyCount,
      live: liveStrategyCount,
    }

    const symbolCount = (progState as any)?.symbolsCount || 1

    return NextResponse.json({
      success: true,
      indications: {
        cycleCount: indicationCycleCount,
        types: indicationsByType,
        evaluated: indicationCycleCount,
        base: indicationsByType.base,
        main: indicationsByType.main,
        real: indicationsByType.real,
        live: indicationsByType.live,
        totalRecords: indicationCycleCount,
      },
      strategies: {
        cycleCount: strategyCycleCount,
        types: strategiesByType,
        base: strategiesByType.base,
        main: strategiesByType.main,
        real: strategiesByType.real,
        live: strategiesByType.live,
        drawdown_max: 0,
        drawdown_time_hours: 0,
        totalRecords: Object.values(strategiesByType).reduce((a: number, b: number) => a + b, 0),
      },
      realtime: {
        cycleCount: realtimeCycleCount,
      },
      metadata: {
        symbolCount,
      },
    })
  } catch (error) {
    console.error("[v0] Engine stats error:", error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unknown error",
    }, { status: 500 })
  }
}
