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

  // Track in Redis using counters (not unbounded sets) for dashboard counts
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Use INCR counters instead of SADD with unique IDs to prevent unbounded growth
    await client.incr(`indications:${connectionId}:${indicationType}:count`)
    await client.expire(`indications:${connectionId}:${indicationType}:count`, 86400) // 24h TTL
    await client.incr(`indications:${connectionId}:count`)
    await client.expire(`indications:${connectionId}:count`, 86400) // 24h TTL
    
    // Store latest value for dashboard display (single key, not growing set)
    const latestKey = `indications:${connectionId}:${indicationType}:latest`
    await client.set(latestKey, JSON.stringify({ symbol, value, confidence, timestamp: Date.now() }))
    await client.expire(latestKey, 3600) // 1h TTL

    // Also increment per-type counter in the progression hash so dashboard reads real values
    const field = `indications_${indicationType}_count`
    await client.hincrby(`progression:${connectionId}`, field, 1)
    await client.hincrby(`progression:${connectionId}`, "indications_count", 1)
    await client.expire(`progression:${connectionId}`, 7 * 24 * 60 * 60)
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

    await client.incr(`strategies:${connectionId}:${strategyType}:count`)
    await client.expire(`strategies:${connectionId}:${strategyType}:count`, 86400)
    await client.incr(`strategies:${connectionId}:count`)
    await client.expire(`strategies:${connectionId}:count`, 86400)

    for (let i = 0; i < totalCreated; i++) {
      await client.incr(`strategies:${connectionId}:${strategyType}:evaluated`)
    }
    await client.expire(`strategies:${connectionId}:${strategyType}:evaluated`, 86400)
    for (let i = 0; i < passedCount; i++) {
      await client.incr(`strategies:${connectionId}:${strategyType}:passed`)
    }
    await client.expire(`strategies:${connectionId}:${strategyType}:passed`, 86400)

    await client.set(
      `strategies:${connectionId}:${strategyType}:latest`,
      JSON.stringify({
        symbol,
        totalCreated,
        passedCount,
        profitFactor,
        drawdownTimeMinutes,
        timestamp: Date.now(),
      }),
    )
    await client.expire(`strategies:${connectionId}:${strategyType}:latest`, 3600)

    // Also increment strategy counts in the progression hash for dashboard real-time display
    const baseField = strategyType === "base" ? "strategies_base_total"
      : strategyType === "main" ? "strategies_main_total" : "strategies_real_total"
    const evaluatedField = strategyType === "base" ? "strategy_evaluated_base"
      : strategyType === "main" ? "strategy_evaluated_main" : "strategy_evaluated_real"
    await client.hincrby(`progression:${connectionId}`, baseField, totalCreated)
    await client.hincrby(`progression:${connectionId}`, evaluatedField, passedCount)
    await client.hincrby(`progression:${connectionId}`, "strategies_count", totalCreated)
    await client.expire(`progression:${connectionId}`, 7 * 24 * 60 * 60)
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
