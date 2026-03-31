/**
 * Progression State Manager
 * Tracks trade engine progression metrics (cycles completed, success rates, etc.)
 * State is persisted to Redis for durability across restarts
 */

import { getRedisClient } from "@/lib/redis-db"

export interface ProgressionState {
  connectionId: string
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  successfulTrades: number
  totalProfit: number
  tradeSuccessRate?: number
  lastUpdate: Date
  prehistoricCyclesCompleted?: number
  prehistoricSymbolsProcessed?: string[]
  prehistoricPhaseActive?: boolean
  engine_cycles_total?: number
  lastCycleTime?: Date | null
  
  // Prehistoric data processing metrics
  prehistoricCandlesProcessed?: number
  prehistoricSymbolsProcessedCount?: number
  
  // Indications by type (direction, move, active, optimal, auto)
  indicationsDirectionCount?: number
  indicationsMoveCount?: number
  indicationsActiveCount?: number
  indicationsOptimalCount?: number
  indicationsAutoCount?: number
  
  // Strategy count sets and evaluated counts
  strategiesBaseTotal?: number
  strategiesMainTotal?: number
  strategiesRealTotal?: number
  strategyEvaluatedBase?: number
  strategyEvaluatedMain?: number
  strategyEvaluatedReal?: number
  
  // Engine performance metrics
  cycleTimeMs?: number
  intervalsProcessed?: number
  indicationsCount?: number
  strategiesCount?: number
}

export class ProgressionStateManager {
  /**
   * Get current progression state for a connection
   */
  static async getProgressionState(connectionId: string): Promise<ProgressionState> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`
      const data = await client.hgetall(key)

       if (!data || Object.keys(data).length === 0) {
         // Return default progression state
         return {
           connectionId,
           cyclesCompleted: 0,
           successfulCycles: 0,
           failedCycles: 0,
           totalTrades: 0,
           successfulTrades: 0,
           totalProfit: 0,
           cycleSuccessRate: 0,
           tradeSuccessRate: 0,
         lastCycleTime: undefined,
         lastUpdate: new Date(),
         prehistoricCyclesCompleted: 0,
         prehistoricSymbolsProcessed: [],
         prehistoricPhaseActive: false,
         prehistoricCandlesProcessed: 0,
         prehistoricSymbolsProcessedCount: 0,
         indicationsDirectionCount: 0,
         indicationsMoveCount: 0,
         indicationsActiveCount: 0,
         indicationsOptimalCount: 0,
         indicationsAutoCount: 0,
         strategiesBaseTotal: 0,
         strategiesMainTotal: 0,
         strategiesRealTotal: 0,
         strategyEvaluatedBase: 0,
         strategyEvaluatedMain: 0,
         strategyEvaluatedReal: 0,
         cycleTimeMs: 0,
         intervalsProcessed: 0,
         indicationsCount: 0,
         strategiesCount: 0,
         }
       }

       return {
         connectionId,
         cyclesCompleted: parseInt(data.cycles_completed || "0", 10),
         successfulCycles: parseInt(data.successful_cycles || "0", 10),
         failedCycles: parseInt(data.failed_cycles || "0", 10),
         totalTrades: parseInt(data.total_trades || "0", 10),
         successfulTrades: parseInt(data.successful_trades || "0", 10),
         totalProfit: parseFloat(data.total_profit || "0"),
         cycleSuccessRate: parseFloat(data.cycle_success_rate || "0"),
         tradeSuccessRate: parseFloat(data.trade_success_rate || "0"),
         lastCycleTime: data.last_cycle_time ? new Date(data.last_cycle_time) : undefined,
         lastUpdate: new Date(data.last_update || new Date()),
         prehistoricCyclesCompleted: parseInt(data.prehistoric_cycles_completed || "0", 10),
         prehistoricSymbolsProcessed: data.prehistoric_symbols_processed ? JSON.parse(data.prehistoric_symbols_processed) : [],
         prehistoricPhaseActive: data.prehistoric_phase_active === "true",
         prehistoricCandlesProcessed: parseInt(data.prehistoric_candles_processed || "0", 10),
         prehistoricSymbolsProcessedCount: parseInt(data.prehistoric_symbols_processed_count || "0", 10),
         indicationsDirectionCount: parseInt(data.indications_direction_count || "0", 10),
         indicationsMoveCount: parseInt(data.indications_move_count || "0", 10),
         indicationsActiveCount: parseInt(data.indications_active_count || "0", 10),
         indicationsOptimalCount: parseInt(data.indications_optimal_count || "0", 10),
         indicationsAutoCount: parseInt(data.indications_auto_count || "0", 10),
         strategiesBaseTotal: parseInt(data.strategies_base_total || "0", 10),
         strategiesMainTotal: parseInt(data.strategies_main_total || "0", 10),
         strategiesRealTotal: parseInt(data.strategies_real_total || "0", 10),
         strategyEvaluatedBase: parseInt(data.strategies_base_evaluated || "0", 10),
         strategyEvaluatedMain: parseInt(data.strategies_main_evaluated || "0", 10),
         strategyEvaluatedReal: parseInt(data.strategies_real_evaluated || "0", 10),
         cycleTimeMs: parseInt(data.cycle_time_ms || "0", 10),
         intervalsProcessed: parseInt(data.intervals_processed || "0", 10),
         indicationsCount: parseInt(data.indications_count || "0", 10),
         strategiesCount: parseInt(data.strategies_count || "0", 10),
       }
    } catch (error) {
      console.error(`[v0] Failed to get progression state for ${connectionId}:`, error)
      // Return default on error
      return {
        connectionId,
        cyclesCompleted: 0,
        successfulCycles: 0,
        failedCycles: 0,
        totalTrades: 0,
        successfulTrades: 0,
        totalProfit: 0,
        cycleSuccessRate: 0,
        tradeSuccessRate: 0,
        lastCycleTime: undefined,
        lastUpdate: new Date(),
        prehistoricCyclesCompleted: 0,
        prehistoricSymbolsProcessed: [],
        prehistoricPhaseActive: false,
      }
    }
  }

  /**
   * Increment completed cycle (successful or failed)
   * Writes every cycle so dashboard/log dialogs show live progression immediately.
   */
  private static cycleCounters: Map<string, { completed: number; successful: number; failed: number }> = new Map()

  static async incrementCycle(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) return

      const redisKey = `progression:${connectionId}`

      // Read current values from Redis first (to handle server restarts)
      const existing = await client.hgetall(redisKey)
      const currentCompleted = parseInt(existing?.cycles_completed || "0", 10)
      const currentSuccessful = parseInt(existing?.successful_cycles || "0", 10)
      const currentFailed = parseInt(existing?.failed_cycles || "0", 10)

      // Increment based on Redis values
      const newCompleted = currentCompleted + 1
      const newSuccessful = successful ? currentSuccessful + 1 : currentSuccessful
      const newFailed = successful ? currentFailed : currentFailed + 1

      // Update local counter for tracking
      this.cycleCounters.set(connectionId, {
        completed: newCompleted,
        successful: newSuccessful,
        failed: newFailed,
      })

      const successRate = newCompleted > 0 ? (newSuccessful / newCompleted) * 100 : 0

      // Write update to Redis
      await client.hset(redisKey, {
        cycles_completed: String(newCompleted),
        successful_cycles: String(newSuccessful),
        failed_cycles: String(newFailed),
        cycle_success_rate: String(successRate.toFixed(2)),
        last_cycle_time: new Date().toISOString(),
        last_update: new Date().toISOString(),
        connection_id: connectionId,
      })

      // Set expiration
      await client.expire(redisKey, 7 * 24 * 60 * 60)

      // Log every 25 cycles
      if (newCompleted % 25 === 0 && newCompleted > 0) {
        console.log(`[v0] [Progression] Cycle ${newCompleted}: ${successRate.toFixed(1)}% success rate`)
      }
    } catch (error) {
      // Silent fail to not block processing
    }
  }

  /**
   * Track prehistoric phase progress (separate from realtime)
   */
  static async incrementPrehistoricCycle(connectionId: string, symbol: string): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`

      // Get current state
      const current = await this.getProgressionState(connectionId)

      // Update prehistoric metrics
      const prehistoricCycles = (current.prehistoricCyclesCompleted || 0) + 1
      const symbolsProcessed = current.prehistoricSymbolsProcessed || []
      
      if (!symbolsProcessed.includes(symbol)) {
        symbolsProcessed.push(symbol)
      }

      // Save to Redis
      await client.hset(key, {
        prehistoric_cycles_completed: String(prehistoricCycles),
        prehistoric_symbols_processed: JSON.stringify(symbolsProcessed),
        prehistoric_phase_active: "true",
        last_update: new Date().toISOString(),
      })

      console.log(`[v0] [Prehistoric] Symbol ${symbol}: Cycle ${prehistoricCycles} | Processed: ${symbolsProcessed.join(", ")}`)
    } catch (error) {
      console.error(`[v0] Failed to track prehistoric cycle for ${connectionId}:`, error)
    }
  }

  /**
   * Mark prehistoric phase as complete
   */
  static async completePrehistoricPhase(connectionId: string): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`

      await client.hset(key, {
        prehistoric_phase_active: "false",
        last_update: new Date().toISOString(),
      })

      console.log(`[v0] [Prehistoric] Phase completed for connection ${connectionId}`)
    } catch (error) {
      console.error(`[v0] Failed to mark prehistoric phase complete:`, error)
    }
  }

  /**
   * Record a trade execution
   */
  static async recordTrade(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`

      // Get current state
      const current = await this.getProgressionState(connectionId)

      // Update trade metrics
      const totalTrades = current.totalTrades + 1
      const successfulTrades = successful ? current.successfulTrades + 1 : current.successfulTrades
      const totalProfit = current.totalProfit + profit
      const tradeSuccessRate = totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0

      // Save to Redis
      await client.hset(key, {
        total_trades: String(totalTrades),
        successful_trades: String(successfulTrades),
        total_profit: String(totalProfit),
        trade_success_rate: String(tradeSuccessRate),
        last_update: new Date().toISOString(),
      })

      console.log(`[v0] [Progression] Trade recorded: ${successful ? "✓ Win" : "✗ Loss"} | Profit: ${profit.toFixed(2)} | Success Rate: ${tradeSuccessRate.toFixed(1)}%`)
    } catch (error) {
      console.error(`[v0] Failed to record trade for ${connectionId}:`, error)
    }
  }

  /**
   * Reset progression state (useful for testing or manual reset)
   */
  static async resetProgressionState(connectionId: string): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`
      await client.del(key)
      console.log(`[v0] [Progression] State reset for ${connectionId}`)
    } catch (error) {
      console.error(`[v0] Failed to reset progression state for ${connectionId}:`, error)
    }
  }
}
