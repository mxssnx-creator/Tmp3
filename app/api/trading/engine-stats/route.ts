import { NextResponse } from "next/server"
import { getRedisClient } from "@/lib/redis-db"

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 })
    }

    const redis = getRedisClient()

    // ── 1. Read live cycle counts from progression:{connId} hash ──────────────
    // This hash is updated EVERY indication cycle, so it is always current.
    const progHash = await redis.hgetall(`progression:${connectionId}`) || {}

    const indicationCycleCount = parseInt(progHash.indication_cycle_count || "0", 10)
    const indicationsCount     = parseInt(progHash.indications_count     || "0", 10)

    // Per-type indication counts stored as indications_{type}_count
    const indicationsByType: Record<string, number> = {}
    for (const [field, val] of Object.entries(progHash)) {
      if (field.startsWith("indications_") && field.endsWith("_count") && field !== "indications_count") {
        const typeName = field.replace("indications_", "").replace("_count", "")
        indicationsByType[typeName] = parseInt(String(val || "0"), 10)
      }
    }

    // ── 2. Read strategy Set counts from settings:strategies:{connId}:*:sets ──
    // Strategy sets are stored via setSettings() which prefixes with "settings:".
    // The value is a flattened hash; the "count" field holds the number of Sets.
    let baseSetCount = 0
    let mainSetCount = 0
    let realSetCount = 0
    let liveSetCount = 0

    try {
      const strategyKeys = await redis.keys(`settings:strategies:${connectionId}:*:sets`)
      for (const key of strategyKeys) {
        const hash = await redis.hgetall(key) || {}
        const count = parseInt(hash.count || "0", 10)
        if (key.includes(":base:"))  baseSetCount += count
        else if (key.includes(":main:")) mainSetCount += count
        else if (key.includes(":real:")) realSetCount += count
        else if (key.includes(":live:")) liveSetCount += count
      }
    } catch (e) {
      console.warn("[v0] [EngineStats] Error reading strategy set keys:", e)
    }

    // ── 3. Read strategy cycle count from settings:trade_engine_state ──────────
    // This is updated every 100 indication cycles and every strategy cycle.
    let strategyCycleCount = 0
    let realtimeCycleCount = 0
    let cycleSuccessRate = 100

    try {
      const stateHash = await redis.hgetall(`settings:trade_engine_state:${connectionId}`) || {}
      strategyCycleCount = parseInt(stateHash.strategy_cycle_count || "0", 10)
      realtimeCycleCount = parseInt(stateHash.realtime_cycle_count || "0", 10)
      cycleSuccessRate   = parseFloat(stateHash.cycle_success_rate || "100")
    } catch (e) {
      console.warn("[v0] [EngineStats] Error reading engine state:", e)
    }

    // ── 4. Read active pseudo positions count ────────────────────────────────────
    let positionsCount = 0
    try {
      const posKeys = await redis.keys(`settings:pseudo_positions:${connectionId}:*`)
      for (const key of posKeys) {
        const hash = await redis.hgetall(key) || {}
        if (hash.status === "active") positionsCount++
      }
    } catch (e) {
      // non-critical
    }

    // ── 5. Build response ────────────────────────────────────────────────────────
    const totalStrategySets = baseSetCount + mainSetCount + realSetCount + liveSetCount

    console.log(
      `[v0] [EngineStats] ${connectionId}: ` +
      `indicationCycles=${indicationCycleCount} strategyCycles=${strategyCycleCount} ` +
      `base=${baseSetCount} main=${mainSetCount} real=${realSetCount} live=${liveSetCount} ` +
      `positions=${positionsCount} totalIndications=${indicationsCount}`
    )

    return NextResponse.json({
      success: true,
      connectionId,
      // Flat fields (consumed by quickstart-section and dashboard)
      indicationCycleCount,
      strategyCycleCount,
      realtimeCycleCount,
      cycleSuccessRate,
      totalIndicationsCount: indicationsCount,
      indicationsByType,
      baseStrategyCount:  baseSetCount,
      mainStrategyCount:  mainSetCount,
      realStrategyCount:  realSetCount,
      liveStrategyCount:  liveSetCount,
      totalStrategyCount: totalStrategySets,
      positionsCount,
      totalProfit: 0, // calculated from closed positions if needed
      // Legacy nested shapes for backward compat
      indications: {
        cycleCount: indicationCycleCount,
        totalRecords: indicationsCount,
        byType: indicationsByType,
      },
      strategies: {
        cycleCount: strategyCycleCount,
        base: baseSetCount,
        main: mainSetCount,
        real: realSetCount,
        live: liveSetCount,
        total: totalStrategySets,
        totalRecords: totalStrategySets,
      },
      realtime: {
        cycleCount: realtimeCycleCount,
      },
      metadata: {
        symbolCount: 1,
      },
    })
  } catch (error) {
    console.error("[v0] Engine stats error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
