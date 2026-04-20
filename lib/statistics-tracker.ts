import { query } from "@/lib/db"
import { getRedisClient, initRedis } from "@/lib/redis-db"

/**
 * Track indication statistics - called after each indication processing cycle
 * Records indication type, value, and confidence to database for statistics
 * ALSO updates Redis counters for dashboard display
 */
export async function trackIndicationStats(
  connectionId: string,
  symbol: string,
  indicationType: string,
  value: number,
  confidence: number
): Promise<void> {
  try {
    await query(
      `INSERT INTO indications (connection_id, symbol, type, value, confidence, calculated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [connectionId, symbol, indicationType, value, confidence]
    )
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to track indication in DB:`, e instanceof Error ? e.message : String(e))
  }

  // Track in Redis using counters (not unbounded sets) for dashboard counts.
  // Fan out all writes concurrently so we don't pay 9 sequential Redis
  // round-trips for every indication result.
  try {
    await initRedis()
    const client = getRedisClient()

    const typeCountKey = `indications:${connectionId}:${indicationType}:count`
    const totalCountKey = `indications:${connectionId}:count`
    const latestKey = `indications:${connectionId}:${indicationType}:latest`
    const progKey = `progression:${connectionId}`

    await Promise.all([
      client.incr(typeCountKey),
      client.expire(typeCountKey, 86400),
      client.incr(totalCountKey),
      client.expire(totalCountKey, 86400),
      client.set(latestKey, JSON.stringify({ symbol, value, confidence, timestamp: Date.now() })),
      client.expire(latestKey, 3600),
      client.hincrby(progKey, `indications_${indicationType}_count`, 1),
      client.hincrby(progKey, "indications_count", 1),
      client.expire(progKey, 7 * 24 * 60 * 60),
    ])
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track indication in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Track strategy statistics - called after strategy evaluation
 * Records strategy type, counts, and metrics to database for statistics
 */
export async function trackStrategyStats(
  connectionId: string,
  symbol: string,
  strategyType: string,
  totalCreated: number,
  passedCount: number,
  profitFactor: number,
  drawdownTimeMinutes: number
): Promise<void> {
  try {
    await query(
      `INSERT INTO strategies_real (connection_id, symbol, type, count, passed_count, avg_profit_factor, avg_drawdown_time, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [connectionId, symbol, strategyType, totalCreated, passedCount, profitFactor, Math.round(drawdownTimeMinutes)]
    )
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to track strategy:`, e instanceof Error ? e.message : String(e))
  }

  try {
    await initRedis()
    const client = getRedisClient()

    const typeCountKey = `strategies:${connectionId}:${strategyType}:count`
    const totalCountKey = `strategies:${connectionId}:count`
    const evalKey = `strategies:${connectionId}:${strategyType}:evaluated`
    const passedKey = `strategies:${connectionId}:${strategyType}:passed`
    const latestKey = `strategies:${connectionId}:${strategyType}:latest`

    const writes: Promise<any>[] = [
      client.incrby(typeCountKey, 1),
      client.expire(typeCountKey, 86400),
      client.incrby(totalCountKey, 1),
      client.expire(totalCountKey, 86400),
      client.set(
        latestKey,
        JSON.stringify({ symbol, totalCreated, passedCount, profitFactor, drawdownTimeMinutes, timestamp: Date.now() }),
      ),
      client.expire(latestKey, 3600),
    ]
    if (totalCreated > 0) {
      writes.push(client.incrby(evalKey, totalCreated), client.expire(evalKey, 86400))
    }
    if (passedCount > 0) {
      writes.push(client.incrby(passedKey, passedCount), client.expire(passedKey, 86400))
    }
    await Promise.all(writes)
    // NOTE: Per-stage progression hash fields (strategies_base_total, strategies_main_total,
    // strategies_real_total, strategy_evaluated_*) are written exclusively by StrategyCoordinator
    // to avoid double-counting. trackStrategyStats only writes to the flat counter keys above
    // and to the SQL strategies_real table for historical analytics.
  } catch (e) {
    console.error(`[v0] [Stats] Failed to track strategy in Redis:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Get recent indication statistics for dashboard
 */
export async function getIndicationStats(connectionId: string, hoursBack: number = 24): Promise<any> {
  try {
    const stats = await query(
      `SELECT type, COUNT(*) as count, AVG(value) as avg_value, AVG(confidence) as avg_confidence
       FROM indications
       WHERE connection_id = ? AND calculated_at > datetime('now', ?)
       GROUP BY type`,
      [connectionId, `-${hoursBack} hours`]
    )
    return stats || []
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to get indication stats:`, e instanceof Error ? e.message : String(e))
    return []
  }
}

/**
 * Get recent strategy statistics for dashboard
 */
export async function getStrategyStats(connectionId: string, hoursBack: number = 24): Promise<any> {
  try {
    const stats = await query(
      `SELECT type, COUNT(*) as count, SUM(passed_count) as total_passed, 
              AVG(avg_profit_factor) as avg_profit_factor, AVG(avg_drawdown_time) as avg_drawdown_time
       FROM strategies_real
       WHERE connection_id = ? AND evaluated_at > datetime('now', ?)
       GROUP BY type`,
      [connectionId, `-${hoursBack} hours`]
    )
    return stats || []
  } catch (e) {
    console.warn(`[v0] [Stats] Failed to get strategy stats:`, e instanceof Error ? e.message : String(e))
    return []
  }
}
