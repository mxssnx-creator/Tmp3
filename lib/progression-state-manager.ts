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
      // PRODUCTION FIX: Always initialize Redis connection before using it
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not initialized for ${connectionId}, returning default state`)
        return this.getDefaultState(connectionId)
      }

      const key = `progression:${connectionId}`
      let data: Record<string, string> = {}
      
      try {
        data = await client.hgetall(key)
      } catch (redisError) {
        console.warn(`[v0] Redis connection error reading progression:${connectionId}, using default state:`, redisError)
        return this.getDefaultState(connectionId)
      }

       if (!data || Object.keys(data).length === 0) {
         return this.getDefaultState(connectionId)
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
      return this.getDefaultState(connectionId)
    }
  }

  /**
   * Get default progression state (reusable helper)
   * Public static method to allow callers to get default state on errors
   */
  static getDefaultState(connectionId: string): ProgressionState {
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

  /**
   * Increment completed cycle (successful or failed)
   * Writes every cycle so dashboard/log dialogs show live progression immediately.
   */
  private static cycleCounters: Map<string, { completed: number; successful: number; failed: number }> = new Map()

  static async incrementCycle(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not available for incrementCycle`)
        return
      }

      const redisKey = `progression:${connectionId}`

      // CRITICAL FIX: use atomic hincrby instead of read-modify-write hset.
      // Three processors (indication/strategy/realtime) call incrementCycle
      // concurrently. The old read-then-write pattern had a race window that
      // dropped updates, which contributed to jumping/inconsistent counters
      // across refreshes. hincrby is atomic at the Redis level.
      let newCompleted = 0
      let newSuccessful = 0
      let newFailed = 0
      try {
        // Fire the counter increment + the read of the non-incremented counter
        // concurrently. The two operations are independent (hincrby on one
        // field, hget on another) so there is no ordering constraint, and we
        // save one Redis round-trip per cycle.
        if (successful) {
          const [completed, successCount, failedStr] = await Promise.all([
            client.hincrby(redisKey, "cycles_completed", 1),
            client.hincrby(redisKey, "successful_cycles", 1),
            client.hget(redisKey, "failed_cycles"),
          ])
          newCompleted = Number(completed) || 0
          newSuccessful = Number(successCount) || 0
          newFailed = parseInt((failedStr as any) || "0", 10)
        } else {
          const [completed, failCount, successStr] = await Promise.all([
            client.hincrby(redisKey, "cycles_completed", 1),
            client.hincrby(redisKey, "failed_cycles", 1),
            client.hget(redisKey, "successful_cycles"),
          ])
          newCompleted = Number(completed) || 0
          newFailed = Number(failCount) || 0
          newSuccessful = parseInt((successStr as any) || "0", 10)
        }
      } catch (e) {
        console.warn(`[v0] Failed to increment progression counters for ${connectionId}:`, e)
        return
      }

      // Update local counter for tracking (best-effort mirror; not authoritative)
      this.cycleCounters.set(connectionId, {
        completed: newCompleted,
        successful: newSuccessful,
        failed: newFailed,
      })

      const successRate = newCompleted > 0 ? (newSuccessful / newCompleted) * 100 : 0

      // Write metadata (non-counter fields) + expire in parallel.
      try {
        const nowIso = new Date().toISOString()
        await Promise.all([
          client.hset(redisKey, {
            cycle_success_rate: String(successRate.toFixed(2)),
            last_cycle_time: nowIso,
            last_update: nowIso,
            connection_id: connectionId,
          }),
          client.expire(redisKey, 7 * 24 * 60 * 60),
        ])
      } catch (writeError) {
        console.warn(`[v0] Failed to write progression metadata for ${connectionId}:`, writeError)
        return
      }

      // Log every 25 cycles
      if (newCompleted % 25 === 0 && newCompleted > 0) {
        console.log(`[v0] [Progression] Cycle ${newCompleted}: ${successRate.toFixed(1)}% success rate`)
      }
    } catch (error) {
      // Silent fail to not block processing
      console.error(`[v0] Unexpected error in incrementCycle:`, error)
    }
  }

  /**
   * Track prehistoric phase progress (separate from realtime)
   */
  static async incrementPrehistoricCycle(connectionId: string, symbol: string): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `progression:${connectionId}`

      // PERFORMANCE: The previous implementation called `getProgressionState`
      // which does a full `hgetall` + JSON parse on every call — expensive
      // and unnecessary. We now use atomic hincrby for the counter and a
      // per-connection Set for the processed symbols which deduplicates in
      // O(1) Redis-side without needing to re-read the whole hash.
      const symbolsSetKey = `${key}:prehistoric_symbols_set`
      const nowIso = new Date().toISOString()

      const [prehistoricCycles] = await Promise.all([
        client.hincrby(key, "prehistoric_cycles_completed", 1),
        client.sadd(symbolsSetKey, symbol).catch(() => 0),
        client.expire(symbolsSetKey, 7 * 24 * 60 * 60).catch(() => 0),
      ])

      // Mirror the processed symbols list into the hash so existing readers
      // (which still expect `prehistoric_symbols_processed` as JSON) keep
      // working. `smembers` replaces the old read-modify-write cycle.
      const symbolsProcessed = ((await client.smembers(symbolsSetKey).catch(() => [])) || []) as string[]

      await Promise.all([
        client.hset(key, {
          prehistoric_symbols_processed: JSON.stringify(symbolsProcessed),
          prehistoric_phase_active: "true",
          last_update: nowIso,
        }),
        client.expire(key, 7 * 24 * 60 * 60),
      ])

      console.log(
        `[v0] [Prehistoric] Symbol ${symbol}: Cycle ${prehistoricCycles} | Processed: ${symbolsProcessed.join(", ")}`,
      )
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
   *
   * CRITICAL FIX: the previous implementation used the classic read-modify-write
   * pattern (`getProgressionState` → mutate locally → `hset`). When trades
   * complete for multiple symbols concurrently (e.g. the strategy coordinator
   * fans out live-set execution in parallel) this silently dropped counter
   * updates because the two in-flight writers each read the same `total_trades`
   * value and wrote `+1` on top of the other's write.
   *
   * We now use atomic Redis primitives (`hincrby` / `hincrbyfloat`) so every
   * trade is counted exactly once regardless of concurrency. The derived
   * `trade_success_rate` is computed from the freshly-incremented counters
   * rather than from stale in-memory snapshots.
   *
   * `total_profit` is stored as a float via `hincrbyfloat`. On the mock Redis
   * adapter this call falls through to `hincrby` (which rejects non-integer
   * deltas); we detect that path and fall back to a safe snapshot update.
   */
  static async recordTrade(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not available for recordTrade`)
        return
      }
      const key = `progression:${connectionId}`

      // Atomic counter increments. Kick off both counters concurrently — hincrby
      // returns the post-increment value so we can derive the success rate from
      // authoritative data rather than a read-then-write snapshot.
      const totalTradesP = client.hincrby(key, "total_trades", 1)
      const successfulTradesP = successful
        ? client.hincrby(key, "successful_trades", 1)
        : Promise.resolve(null as any)

      // Profit is a float. Prefer hincrbyfloat; if the adapter doesn't support
      // it (e.g. mock / older inline client) fall back to a read-modify-write
      // on `total_profit` only — the counters above remain atomic either way.
      let totalProfitP: Promise<any>
      const hincrbyfloat = (client as any).hincrbyfloat as
        | ((k: string, f: string, d: number) => Promise<string | number>)
        | undefined
      if (typeof hincrbyfloat === "function" && profit !== 0) {
        totalProfitP = hincrbyfloat.call(client, key, "total_profit", profit).catch(async () => {
          // Fallback: read current, add, write. Best-effort only — racy vs
          // other profit updates but the counter integrity is preserved.
          try {
            const cur = Number((await client.hget(key, "total_profit")) || "0") || 0
            await client.hset(key, { total_profit: String(cur + profit) })
          } catch { /* ignore */ }
        })
      } else if (profit !== 0) {
        totalProfitP = (async () => {
          try {
            const cur = Number((await client.hget(key, "total_profit")) || "0") || 0
            await client.hset(key, { total_profit: String(cur + profit) })
          } catch { /* ignore */ }
        })()
      } else {
        totalProfitP = Promise.resolve()
      }

      const [totalTradesRaw, successfulTradesRaw] = await Promise.all([
        totalTradesP,
        successfulTradesP,
        totalProfitP,
      ])

      const newTotalTrades = Number(totalTradesRaw) || 0
      // If this trade was unsuccessful we didn't increment `successful_trades`
      // — read it so the success rate math is still correct.
      let newSuccessfulTrades: number
      if (successful) {
        newSuccessfulTrades = Number(successfulTradesRaw) || 0
      } else {
        try {
          newSuccessfulTrades = Number((await client.hget(key, "successful_trades")) || "0") || 0
        } catch {
          newSuccessfulTrades = 0
        }
      }

      const tradeSuccessRate =
        newTotalTrades > 0 ? (newSuccessfulTrades / newTotalTrades) * 100 : 0

      // Metadata + rate write in parallel with the expire refresh.
      const nowIso = new Date().toISOString()
      await Promise.all([
        client.hset(key, {
          trade_success_rate: String(tradeSuccessRate.toFixed(2)),
          last_update: nowIso,
          last_trade_time: nowIso,
        }),
        client.expire(key, 7 * 24 * 60 * 60),
      ]).catch(() => { /* non-critical */ })

      console.log(
        `[v0] [Progression] Trade recorded: ${successful ? "✓ Win" : "✗ Loss"} | ` +
          `Profit: ${profit.toFixed(2)} | Trades: ${newSuccessfulTrades}/${newTotalTrades} | ` +
          `Success Rate: ${tradeSuccessRate.toFixed(1)}%`,
      )
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
