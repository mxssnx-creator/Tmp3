import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections, getSettings, getAssignedAndEnabledConnections } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

// GET functional overview metrics
// Returns real-time information about what's currently running:
// - Active symbols being traded
// - Indications calculated
// - Strategies evaluated
// - Sets created (base, main, real)
// - DB position entries created
export async function GET() {
  try {
    console.log("[v0] [FunctionalOverview] Fetching system metrics...")
    
    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()

    // Get active symbols count
    const allConnections = await getAllConnections()
    const enabledConnections = await getAssignedAndEnabledConnections()
    
    // Get main engine config to find how many symbols are configured
    const mainConfigKey = await client.hgetall("trade_engine:main_config")
    const configuredSymbols = Array.isArray(mainConfigKey?.symbols) 
      ? mainConfigKey.symbols.length 
      : (mainConfigKey?.symbols_count || 15)

    // Get indication/strategy metrics from actual engine state keys
    let totalIndicationCycles = 0
    let totalStrategyCycles = 0
    let totalStrategiesEvaluated = 0
    let baseSetsCount = 0
    let mainSetsCount = 0
    let realSetsCount = 0
    let liveSetsCount = 0
    
    for (const conn of enabledConnections) {
      try {
        // Read engine state from settings namespace (write path uses setSettings)
        const state = await getSettings(`trade_engine_state:${conn.id}`)
        const progression = await ProgressionStateManager.getProgressionState(conn.id)
        
        if (state) {
          totalIndicationCycles += state.indication_cycle_count || 0
          totalStrategyCycles += state.strategy_cycle_count || 0
          totalStrategiesEvaluated += state.total_strategies_evaluated || 0
        }

        // Fallback to progression metrics when engine-state counters are not yet populated.
        if ((state?.indication_cycle_count || 0) === 0) {
          totalIndicationCycles += progression.cyclesCompleted || 0
        }
        if ((state?.strategy_cycle_count || 0) === 0) {
          totalStrategyCycles += progression.successfulCycles || 0
        }
        if ((state?.total_strategies_evaluated || 0) === 0) {
          totalStrategiesEvaluated += progression.successfulCycles || 0
        }
        
        const parseSetCount = (raw: string | null): number => {
          if (!raw) return 0
          try {
            const data = JSON.parse(raw)
            if (Array.isArray(data)) return data.length
            if (typeof data?.count === "number") return data.count
            if (Array.isArray(data?.strategies)) return data.strategies.length
            if (Array.isArray(data?.entries)) return data.entries.length
            return 0
          } catch {
            return 0
          }
        }

        // Check for strategy sets per connection (common symbols + both key families)
        const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        for (const symbol of symbols) {
          const keys = {
            base: [`strategies:${conn.id}:${symbol}:base`, `strategy_set:${conn.id}:${symbol}:base`],
            main: [`strategies:${conn.id}:${symbol}:main`, `strategy_set:${conn.id}:${symbol}:main`],
            real: [`strategies:${conn.id}:${symbol}:real`, `strategy_set:${conn.id}:${symbol}:real`],
            live: [`strategies:${conn.id}:${symbol}:live`, `strategy_set:${conn.id}:${symbol}:live`],
          }

          const [baseJsonA, baseJsonB, mainJsonA, mainJsonB, realJsonA, realJsonB, liveJsonA, liveJsonB] = await Promise.all([
            client.get(keys.base[0]),
            client.get(keys.base[1]),
            client.get(keys.main[0]),
            client.get(keys.main[1]),
            client.get(keys.real[0]),
            client.get(keys.real[1]),
            client.get(keys.live[0]),
            client.get(keys.live[1]),
          ])

          baseSetsCount += parseSetCount(baseJsonA) || parseSetCount(baseJsonB)
          mainSetsCount += parseSetCount(mainJsonA) || parseSetCount(mainJsonB)
          realSetsCount += parseSetCount(realJsonA) || parseSetCount(realJsonB)
          liveSetsCount += parseSetCount(liveJsonA) || parseSetCount(liveJsonB)
        }
      } catch (e) {
        // Ignore per-connection errors
      }
    }

    // Get position entries count from Redis
    const positionKeys = await client.keys("positions:*")
    const positionsCount = positionKeys.length

    // Get in-memory persistence stats
    const persistenceKeys = await client.keys("persistence:*")
    console.log(`[v0] [FunctionalOverview] Metrics: symbols=${configuredSymbols}, indicationCycles=${totalIndicationCycles}, strategyCycles=${totalStrategyCycles}, base=${baseSetsCount}, main=${mainSetsCount}, real=${realSetsCount}, positions=${positionsCount}`)

    return NextResponse.json({
      symbolsActive: configuredSymbols,
      indicationsCalculated: totalIndicationCycles,
      strategiesEvaluated: totalStrategiesEvaluated || totalStrategyCycles,
      baseSetsCreated: baseSetsCount > 0,
      mainSetsCreated: mainSetsCount > 0,
      realSetsCreated: realSetsCount > 0,
      liveSetsCreated: liveSetsCount > 0,
      positionsEntriesCreated: positionsCount,
      enabledConnections: enabledConnections.length,
      totalConnections: allConnections.length,
      persistenceKeys: persistenceKeys.length,
      // Detailed counts
      counts: {
        indicationCycles: totalIndicationCycles,
        strategyCycles: totalStrategyCycles,
        baseStrategies: baseSetsCount,
        mainStrategies: mainSetsCount,
        realStrategies: realSetsCount,
        liveStrategies: liveSetsCount,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [FunctionalOverview] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to get functional overview",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
