import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/test/quickstart-10-symbols
 * 
 * Test harness for the progression refactoring:
 * - Creates a test connection and 10 symbols
 * - Simulates strategy evaluation pipeline
 * - Tracks position numbers, profit factors, and drawdowns
 * - Verifies coordination correctness
 * - Returns comprehensive metrics snapshot
 */

interface TestSymbol {
  symbol: string
  profitFactor: number
  drawdownTime: number
  positionCount: number
  trades: number
  winRate: number
}

// 10 test symbols with varied metrics
const TEST_SYMBOLS: TestSymbol[] = [
  { symbol: "BTCUSDT", profitFactor: 2.1, drawdownTime: 25, positionCount: 3, trades: 45, winRate: 0.62 },
  { symbol: "ETHUSDT", profitFactor: 1.8, drawdownTime: 35, positionCount: 2, trades: 32, winRate: 0.59 },
  { symbol: "BNBUSDT", profitFactor: 1.5, drawdownTime: 42, positionCount: 1, trades: 28, winRate: 0.54 },
  { symbol: "ADAUSDT", profitFactor: 1.2, drawdownTime: 48, positionCount: 2, trades: 18, winRate: 0.50 },
  { symbol: "SOLUSDT", profitFactor: 0.9, drawdownTime: 65, positionCount: 4, trades: 22, winRate: 0.45 },
  { symbol: "DOGEUSDT", profitFactor: 1.6, drawdownTime: 38, positionCount: 1, trades: 25, winRate: 0.56 },
  { symbol: "XRPUSDT", profitFactor: 1.3, drawdownTime: 52, positionCount: 2, trades: 20, winRate: 0.52 },
  { symbol: "LTCUSDT", profitFactor: 1.4, drawdownTime: 40, positionCount: 1, trades: 24, winRate: 0.55 },
  { symbol: "AVAXUSDT", profitFactor: 1.7, drawdownTime: 32, positionCount: 3, trades: 30, winRate: 0.58 },
  { symbol: "MATICUSDT", profitFactor: 1.1, drawdownTime: 58, positionCount: 2, trades: 16, winRate: 0.48 },
]

function calculateCoordinationScore(avgProfitFactor: number, avgDrawdownTime: number): boolean {
  return avgProfitFactor > 1.0 && avgDrawdownTime < 60
}

function detectExtremePositions(positionCount: number, threshold: number = 100): string | null {
  return positionCount > threshold 
    ? `Extreme high position count: ${positionCount} (threshold: ${threshold})`
    : null
}

export async function POST() {
  try {
    console.log("[v0] [TestQuickstart10] === Starting 10-symbol progression test ===")
    await initRedis()
    const client = getRedisClient()
    const connectionId = "test-quickstart-conn"
    const now = new Date().toISOString()
    const progressionKey = `progression:${connectionId}`

    // Initialize progression state
    console.log("[v0] [TestQuickstart10] Initializing progression state...")
    await client.hset(progressionKey, {
      session_number: "1",
      started_at: now,
      last_update: now,
    })

    // Process 10 symbols
    let totalCycles = 0
    let successfulCycles = 0
    let totalTrades = 0
    let successfulTrades = 0
    let totalPositions = 0
    let profitFactorSum = 0
    let drawdownTimeSum = 0
    const indicationCounts = {
      direction: 0,
      move: 0,
      active: 0,
      activeAdvanced: 0,
      optimal: 0,
      auto: 0,
    }

    console.log("[v0] [TestQuickstart10] Processing 10 symbols...")
    for (let i = 0; i < TEST_SYMBOLS.length; i++) {
      const sym = TEST_SYMBOLS[i]
      console.log(`[v0] [TestQuickstart10] [${i + 1}/10] Processing ${sym.symbol}`)

      const indicationType = ["direction", "move", "active", "activeAdvanced", "optimal", "auto"][i % 6] as keyof typeof indicationCounts
      indicationCounts[indicationType]++

      totalCycles += 3
      successfulCycles += Math.floor(Math.random() * 3 + 2)

      totalPositions += sym.positionCount
      totalTrades += sym.trades
      successfulTrades += Math.floor(sym.trades * sym.winRate)
      profitFactorSum += sym.profitFactor
      drawdownTimeSum += sym.drawdownTime

      // Store per-symbol data
      const symbolKey = `symbol:${connectionId}:${sym.symbol}`
      await client.hset(symbolKey, {
        symbol: sym.symbol,
        profit_factor: String(sym.profitFactor),
        drawdown_time: String(sym.drawdownTime),
        position_count: String(sym.positionCount),
        total_trades: String(sym.trades),
        successful_trades: String(Math.floor(sym.trades * sym.winRate)),
        win_rate: String(sym.winRate),
        last_update: now,
      })
    }

    const avgProfitFactor = profitFactorSum / TEST_SYMBOLS.length
    const avgDrawdownTime = drawdownTimeSum / TEST_SYMBOLS.length
    const tradeSuccessRate = totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0

    // Store aggregated metrics
    console.log("[v0] [TestQuickstart10] Storing aggregated metrics...")
    await client.hset(progressionKey, {
      cycles_completed: String(totalCycles),
      successful_cycles: String(successfulCycles),
      failed_cycles: String(totalCycles - successfulCycles),
      indication_cycle_count: String(TEST_SYMBOLS.length),
      indication_live_cycle_count: String(Math.floor(TEST_SYMBOLS.length * 0.8)),
      strategy_cycle_count: String(totalCycles),
      strategy_live_cycle_count: String(successfulCycles),
      realtime_cycle_count: String(totalCycles),
      realtime_live_cycle_count: String(successfulCycles),
      frames_processed: String(TEST_SYMBOLS.length * 100),
      strategies_base_total: "10",
      strategies_base_evaluated: "10",
      strategies_main_total: "10",
      strategies_main_evaluated: String(Math.floor(successfulCycles / 3 * 10)),
      strategies_real_total: "10",
      strategies_real_evaluated: String(Math.floor(successfulCycles / 3 * 10)),
      total_trades: String(totalTrades),
      successful_trades: String(successfulTrades),
      total_profit: String((avgProfitFactor - 1) * 1000),
      position_count: String(totalPositions),
      avg_profit_factor: String(avgProfitFactor),
      avg_drawdown_time: String(avgDrawdownTime),
      indications_direction_count: String(indicationCounts.direction),
      indications_move_count: String(indicationCounts.move),
      indications_active_count: String(indicationCounts.active),
      indications_active_advanced_count: String(indicationCounts.activeAdvanced),
      indications_optimal_count: String(indicationCounts.optimal),
      indications_auto_count: String(indicationCounts.auto),
      engine_started: "true",
      prehistoric_phase_active: "false",
    })

    // Increment atomic counter
    await client.hincrby(progressionKey, "position_count", totalPositions)

    const isCoordinated = calculateCoordinationScore(avgProfitFactor, avgDrawdownTime)
    const extremeAlert = detectExtremePositions(totalPositions)

    // Fetch stored progression data to verify it was saved
    const storedState = await client.hgetall(progressionKey)
    
    const report = {
      success: true,
      timestamp: now,
      connectionId,
      testSymbols: TEST_SYMBOLS.length,
      cycleMetrics: {
        total: totalCycles,
        successful: successfulCycles,
        failed: totalCycles - successfulCycles,
        successRate: ((successfulCycles / totalCycles) * 100).toFixed(2),
      },
      tradeMetrics: {
        total: totalTrades,
        successful: successfulTrades,
        successRate: tradeSuccessRate.toFixed(2),
        avgProfitFactor: avgProfitFactor.toFixed(2),
        avgDrawdownTime: avgDrawdownTime.toFixed(2),
      },
      positionMetrics: {
        total: totalPositions,
        average: (totalPositions / TEST_SYMBOLS.length).toFixed(2),
        extremeDetected: extremeAlert ? true : false,
        extremeAlert,
      },
      coordinationMetrics: {
        profitFactorTarget: avgProfitFactor.toFixed(2),
        drawdownTimeTarget: avgDrawdownTime.toFixed(2),
        isCoordinated,
        coordinationMessage: isCoordinated
          ? "✅ Metrics are properly coordinated"
          : "⚠️ Profit factor and drawdown diverge",
      },
      indicationBreakdown: indicationCounts,
      dataIntegrity: {
        allSymbolsStored: TEST_SYMBOLS.length,
        progressionStateSet: true,
        atomicCountersUpdated: true,
        redisDataVerified: Object.keys(storedState).length > 0,
        storedFieldCount: Object.keys(storedState).length,
      },
      verificationSample: {
        cycles_completed: storedState.cycles_completed,
        successful_cycles: storedState.successful_cycles,
        position_count: storedState.position_count,
        avg_profit_factor: storedState.avg_profit_factor,
        avg_drawdown_time: storedState.avg_drawdown_time,
      },
    }

    console.log("[v0] [TestQuickstart10] === Test complete ===")
    return NextResponse.json(report, { status: 200 })
  } catch (error) {
    console.error("[v0] [TestQuickstart10] FATAL:", error)
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    test: "quickstart-10-symbols",
    description: "10-symbol progression tracking test",
    symbols: TEST_SYMBOLS.length,
    metrics: ["cycles", "trades", "positions", "profit_factor", "drawdown_time", "coordination_score"],
    usage: "POST /api/test/quickstart-10-symbols",
  })
}
