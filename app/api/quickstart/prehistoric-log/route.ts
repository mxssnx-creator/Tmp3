import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

/**
 * Prehistoric Logging - Captures historical data about indications and strategies
 * before trade engine or active connections were enabled
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    console.log("[v0] [PrehistoricLog] ========================================")
    console.log("[v0] [PrehistoricLog] PREHISTORIC DATA ANALYSIS")
    console.log("[v0] [PrehistoricLog] ========================================")

    // Get all indication-related keys to count historical cycles
    const allKeys = await client.keys("*").catch(() => [])
    
    const indicationKeys = allKeys.filter((k: string) => k.includes("indication"))
    const strategyKeys = allKeys.filter((k: string) => k.includes("strategy"))
    const positionKeys = allKeys.filter((k: string) => k.includes("position"))
    const entryKeys = allKeys.filter((k: string) => k.includes("entry"))

    console.log("[v0] [PrehistoricLog] Total keys found:", allKeys.length)
    console.log("[v0] [PrehistoricLog] Indication keys:", indicationKeys.length)
    console.log("[v0] [PrehistoricLog] Strategy keys:", strategyKeys.length)
    console.log("[v0] [PrehistoricLog] Position keys:", positionKeys.length)
    console.log("[v0] [PrehistoricLog] Entry keys:", entryKeys.length)

    // Analyze symbols processed
    const symbolsSet = new Set<string>()
    for (const key of indicationKeys) {
      // Parse symbol from key (e.g., "indication:BTCUSDT:...")
      const parts = key.split(":")
      if (parts[1]) {
        symbolsSet.add(parts[1])
      }
    }
    const symbolsArray = Array.from(symbolsSet).sort()

    console.log("[v0] [PrehistoricLog] Symbols processed:", symbolsArray.length)
    console.log("[v0] [PrehistoricLog] Symbol list:", symbolsArray.join(", "))

    // Get indication engine state
    const indicationState = await client.hgetall("engine:indications:state").catch(() => null) as Record<string, string> | null
    const cycleCount = indicationState?.cycleCount ? parseInt(indicationState.cycleCount) : 0
    const cycleDuration = indicationState?.cycleDuration_ms ? parseInt(indicationState.cycleDuration_ms) : 0

    console.log("[v0] [PrehistoricLog] Indication Engine:")
    console.log(`[v0] [PrehistoricLog]   - Cycles executed: ${cycleCount}`)
    console.log(`[v0] [PrehistoricLog]   - Avg cycle duration: ${cycleDuration}ms`)
    console.log(`[v0] [PrehistoricLog]   - Symbols per cycle: ${symbolsArray.length}`)
    console.log(`[v0] [PrehistoricLog]   - Indications calculated: ${indicationKeys.length}`)

    // Get strategy engine state
    const strategyState = await client.hgetall("engine:strategies:state").catch(() => null) as Record<string, string> | null
    const strategyCycleCount = strategyState?.cycleCount ? parseInt(strategyState.cycleCount) : 0
    const strategyCycleDuration = strategyState?.cycleDuration_ms ? parseInt(strategyState.cycleDuration_ms) : 0

    console.log("[v0] [PrehistoricLog] Strategy Engine:")
    console.log(`[v0] [PrehistoricLog]   - Cycles executed: ${strategyCycleCount}`)
    console.log(`[v0] [PrehistoricLog]   - Avg cycle duration: ${strategyCycleDuration}ms`)
    console.log(`[v0] [PrehistoricLog]   - Symbols evaluated: ${symbolsArray.length}`)
    console.log(`[v0] [PrehistoricLog]   - Strategies evaluated: ${strategyKeys.length}`)

    // Summary
    console.log("[v0] [PrehistoricLog] ========================================")
    console.log("[v0] [PrehistoricLog] SUMMARY - Prehistoric State Before Quickstart")
    console.log("[v0] [PrehistoricLog]   Process State: RUNNING")
    console.log(`[v0] [PrehistoricLog]   Indications: ${indicationKeys.length} calculated over ${cycleCount} cycles`)
    console.log(`[v0] [PrehistoricLog]   Strategies: ${strategyKeys.length} evaluated over ${strategyCycleCount} cycles`)
    console.log(`[v0] [PrehistoricLog]   Symbols: ${symbolsArray.length} symbols (${symbolsArray.join(", ")})`)
    console.log(`[v0] [PrehistoricLog]   Positions: ${positionKeys.length}`)
    console.log(`[v0] [PrehistoricLog]   Entries: ${entryKeys.length}`)
    console.log("[v0] [PrehistoricLog] ========================================")

    return NextResponse.json({
      success: true,
      prehistoric: {
        processState: "running",
        indicationEngine: {
          cyclesExecuted: cycleCount,
          avgCycleDuration: cycleDuration,
          symbolsProcessedPerCycle: symbolsArray.length,
          indicationsCalculated: indicationKeys.length,
        },
        strategyEngine: {
          cyclesExecuted: strategyCycleCount,
          avgCycleDuration: strategyCycleDuration,
          symbolsEvaluatedPerCycle: symbolsArray.length,
          strategiesEvaluated: strategyKeys.length,
        },
        symbols: {
          count: symbolsArray.length,
          list: symbolsArray,
        },
        data: {
          positionsCreated: positionKeys.length,
          entriesCreated: entryKeys.length,
          totalIndicationRecords: indicationKeys.length,
          totalStrategyRecords: strategyKeys.length,
        },
      },
    })
  } catch (error) {
    console.error("[v0] [PrehistoricLog] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch prehistoric log",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
