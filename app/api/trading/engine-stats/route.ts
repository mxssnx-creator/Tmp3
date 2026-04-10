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

    // ── 2. Read strategy counts ──────────────────────────────────────────────────
    // PRIMARY: progression hash fields written by statistics-tracker (hincrby every cycle)
    let baseSetCount = parseInt(progHash.strategies_base_total || "0", 10)
    let mainSetCount = parseInt(progHash.strategies_main_total || "0", 10)
    let realSetCount = parseInt(progHash.strategies_real_total || "0", 10)
    let liveSetCount = 0
    const totalFromProgression = baseSetCount + mainSetCount + realSetCount

    // SECONDARY: direct counter keys strategies:{connId}:{type}:count (written by statistics-tracker via incrby)
    // These are the most up-to-date values per strategy type.
    try {
      for (const type of ["base", "main", "real", "live"]) {
        const raw = await redis.get(`strategies:${connectionId}:${type}:count`)
        const count = parseInt(String(raw || "0"), 10)
        if (type === "base") baseSetCount = Math.max(baseSetCount, count)
        else if (type === "main") mainSetCount = Math.max(mainSetCount, count)
        else if (type === "real") realSetCount = Math.max(realSetCount, count)
        else if (type === "live") liveSetCount = Math.max(liveSetCount, count)
      }
    } catch (e) {
      console.warn("[v0] [EngineStats] Error reading strategy counter keys:", e)
    }

    // TERTIARY: settings:strategies:{connId}:*:sets hash keys (written by setSettings every 50-100 cycles)
    // Only use if primary/secondary both return 0.
    if (totalFromProgression === 0 && baseSetCount === 0) {
      try {
        const strategyKeys = await redis.keys(`settings:strategies:${connectionId}:*:sets`)
        for (const key of strategyKeys) {
          const hash = await redis.hgetall(key) || {}
          const count = parseInt(hash.count || "0", 10)
          if (key.includes(":base:"))      baseSetCount += count
          else if (key.includes(":main:")) mainSetCount += count
          else if (key.includes(":real:")) realSetCount += count
          else if (key.includes(":live:")) liveSetCount += count
        }
      } catch (e) {
        console.warn("[v0] [EngineStats] Error reading strategy set keys:", e)
      }
    }

    // ── 3. Read strategy cycle count from progression hash (written every cycle) ─
    // The engine-manager writes strategy_cycle_count to progression:{connId}
    // every single cycle. settings:trade_engine_state is only persisted every 100 cycles.
    let strategyCycleCount = parseInt(progHash.strategy_cycle_count || "0", 10)
    let realtimeCycleCount = 0
    let cycleSuccessRate = parseFloat(progHash.cycle_success_rate || "100")

    // Fallback: read from settings:trade_engine_state if progression hash is empty
    if (strategyCycleCount === 0) {
      try {
        const stateHash = await redis.hgetall(`settings:trade_engine_state:${connectionId}`) || {}
        strategyCycleCount = parseInt(stateHash.strategy_cycle_count || "0", 10)
        realtimeCycleCount = parseInt(stateHash.realtime_cycle_count || "0", 10)
        if (!cycleSuccessRate) {
          cycleSuccessRate = parseFloat(stateHash.cycle_success_rate || "100")
        }
      } catch (e) {
        console.warn("[v0] [EngineStats] Error reading engine state fallback:", e)
      }
    }

    // Also read cycles_completed from ProgressionStateManager field for the overall count
    const cyclesCompleted = parseInt(progHash.cycles_completed || "0", 10)

    // ── 4. Read active pseudo positions count ────────────────────────────────────
    // PseudoPositionManager stores positions at:
    //   pseudo_positions:{connectionId}  → Redis set of IDs
    //   pseudo_position:{connectionId}:{id}  → Redis hash per position
    let positionsCount = 0
    try {
      const posIds = await redis.smembers(`pseudo_positions:${connectionId}`) || []
      for (const posId of posIds) {
        const hash = await redis.hgetall(`pseudo_position:${connectionId}:${posId}`) || {}
        if ((hash.status || "active") === "active") positionsCount++
      }
      // Also check stage-specific position sets
      if (positionsCount === 0) {
        for (const stage of ["base", "main", "real", "live"]) {
          const stageIds = await redis.smembers(`${stage}_pseudo_positions:${connectionId}`).catch(() => [] as string[])
          for (const posId of stageIds) {
            const hash = await redis.hgetall(`${stage}_pseudo_position:${connectionId}:${posId}`).catch(() => ({})) || {}
            if ((hash.status || "active") === "active") positionsCount++
          }
        }
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
      cyclesCompleted,
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
