import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections, getSettings } from "@/lib/redis-db"
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
    const enabledConnections = allConnections.filter(c => 
      (c.is_enabled === "1" || c.is_enabled === true) &&
      (c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true)
    )
    
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
        
        // Check for strategy sets per connection (check for common symbols)
        const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        for (const symbol of symbols) {
          const baseKey = `strategies:${conn.id}:${symbol}:base`
          const mainKey = `strategies:${conn.id}:${symbol}:main`
          const realKey = `strategies:${conn.id}:${symbol}:real`
          const liveKey = `strategies:${conn.id}:${symbol}:live`
          
          const baseJson = await client.get(baseKey)
          const mainJson = await client.get(mainKey)
          const realJson = await client.get(realKey)
          const liveJson = await client.get(liveKey)
          
          if (baseJson) {
            const data = JSON.parse(baseJson)
            baseSetsCount += data.count || data.strategies?.length || 0
          }
          if (mainJson) {
            const data = JSON.parse(mainJson)
            mainSetsCount += data.count || data.strategies?.length || 0
          }
          if (realJson) {
            const data = JSON.parse(realJson)
            realSetsCount += data.count || data.strategies?.length || 0
          }
          if (liveJson) {
            const data = JSON.parse(liveJson)
            liveSetsCount += data.count || data.strategies?.length || 0
          }
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
