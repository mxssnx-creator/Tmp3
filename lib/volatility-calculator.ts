/**
 * Volatility Calculator & Symbol Screener
 * Calculates 1-hour volatility for symbols and filters for high-volatility trading
 */

import { getClient, initRedis } from "@/lib/redis-db"

export interface VolatilityMetrics {
  symbol: string
  lastHourRange: number
  lastHourRangePercent: number
  volatilityScore: number // 0-100, higher = more volatile
  isHighVolatility: boolean // > 2% range in last hour
  candleCount: number
  priceAtHourStart: number
  priceAtHourEnd: number
  high: number
  low: number
  avgVolume: number
  timestamp: number
}

/**
 * Calculate volatility for a symbol based on last hour of 1-minute candles
 * Volatility = (high - low) / close * 100
 */
export async function calculateSymbolVolatility(symbol: string): Promise<VolatilityMetrics | null> {
  try {
    await initRedis()
    const client = getClient()

    // Get 1-minute candles for the symbol
    const candlesKey = `market_data:${symbol}:candles`
    const candlesData = await client.get(candlesKey)

    if (!candlesData) {
      console.log(`[v0] No candles found for ${symbol}`)
      return null
    }

    const candles = JSON.parse(candlesData)
    if (!Array.isArray(candles) || candles.length === 0) {
      return null
    }

    // Filter candles from the last hour (60 minutes)
    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000
    
    const lastHourCandles = candles.filter((c: any) => {
      const candleTime = typeof c.timestamp === 'string' 
        ? new Date(c.timestamp).getTime() 
        : c.timestamp
      return candleTime >= oneHourAgo
    })

    if (lastHourCandles.length === 0) {
      // If no candles in last hour, use all available
      console.log(`[v0] No candles in last hour for ${symbol}, using all available`)
    }

    const dataToAnalyze = lastHourCandles.length > 0 ? lastHourCandles : candles.slice(-60)

    if (dataToAnalyze.length === 0) {
      return null
    }

    // Calculate volatility metrics
    const prices = dataToAnalyze.map((c: any) => c.close)
    const highs = dataToAnalyze.map((c: any) => c.high)
    const lows = dataToAnalyze.map((c: any) => c.low)
    const volumes = dataToAnalyze.map((c: any) => c.volume)

    const high = Math.max(...highs)
    const low = Math.min(...lows)
    const close = prices[prices.length - 1]
    const priceAtHourStart = prices[0]
    const priceAtHourEnd = prices[prices.length - 1]
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length

    // Volatility range percentage
    const lastHourRange = high - low
    const lastHourRangePercent = (lastHourRange / close) * 100

    // Volatility score: 0-100
    // Base on range, add bonus for large price moves
    const priceMove = Math.abs(priceAtHourEnd - priceAtHourStart)
    const priceMovePercent = (priceMove / priceAtHourStart) * 100
    
    const volatilityScore = Math.min(100, (lastHourRangePercent * 2) + (priceMovePercent * 1.5))

    const isHighVolatility = lastHourRangePercent >= 2.0

    return {
      symbol,
      lastHourRange,
      lastHourRangePercent: Math.round(lastHourRangePercent * 100) / 100,
      volatilityScore: Math.round(volatilityScore),
      isHighVolatility,
      candleCount: dataToAnalyze.length,
      priceAtHourStart,
      priceAtHourEnd,
      high,
      low,
      avgVolume: Math.round(avgVolume),
      timestamp: now,
    }
  } catch (error) {
    console.error(`[v0] Error calculating volatility for ${symbol}:`, error)
    return null
  }
}

/**
 * Screen symbols for high volatility
 * Returns list of symbols sorted by volatility score (highest first)
 */
export async function screenSymbolsForVolatility(symbols: string[]): Promise<VolatilityMetrics[]> {
  const results: VolatilityMetrics[] = []

  for (const symbol of symbols) {
    try {
      const metrics = await calculateSymbolVolatility(symbol)
      if (metrics) {
        results.push(metrics)
      }
    } catch (error) {
      console.warn(`[v0] Error screening ${symbol}:`, error)
    }
  }

  // Sort by volatility score descending (most volatile first)
  return results.sort((a, b) => b.volatilityScore - a.volatilityScore)
}

/**
 * Get top N high-volatility symbols
 * Returns symbols with volatility score >= minScore
 */
export async function getTopVolatileSymbols(
  symbols: string[],
  topN: number = 3,
  minVolatilityPercent: number = 2.0
): Promise<VolatilityMetrics[]> {
  const screened = await screenSymbolsForVolatility(symbols)
  
  // Filter for high volatility
  const highVolatile = screened.filter(m => m.lastHourRangePercent >= minVolatilityPercent)
  
  console.log(`[v0] Found ${highVolatile.length}/${screened.length} symbols with >=${minVolatilityPercent}% volatility in last hour`)
  
  return highVolatile.slice(0, topN)
}

/**
 * Cache volatility metrics in Redis for quick UI updates
 */
export async function cacheVolatilityMetrics(metrics: VolatilityMetrics): Promise<void> {
  try {
    await initRedis()
    const client = getClient()
    
    const key = `volatility:${metrics.symbol}`
    await client.set(key, JSON.stringify(metrics), { ex: 300 }) // Cache for 5 minutes
    
    // Also add to sorted set for ranking
    await client.zadd(`volatility:scores`, metrics.volatilityScore, metrics.symbol)
  } catch (error) {
    console.error(`[v0] Error caching volatility metrics:`, error)
  }
}

/**
 * Get cached volatility metrics for a symbol
 */
export async function getCachedVolatility(symbol: string): Promise<VolatilityMetrics | null> {
  try {
    await initRedis()
    const client = getClient()
    
    const cached = await client.get(`volatility:${symbol}`)
    return cached ? JSON.parse(cached) : null
  } catch (error) {
    console.error(`[v0] Error getting cached volatility:`, error)
    return null
  }
}

/**
 * Get top volatility symbols from cache (ranked)
 */
export async function getTopVolatileFromCache(limit: number = 5): Promise<string[]> {
  try {
    await initRedis()
    const client = getClient()
    
    const topSymbols = await client.zrevrange(`volatility:scores`, 0, limit - 1)
    return topSymbols || []
  } catch (error) {
    console.error(`[v0] Error getting top volatile from cache:`, error)
    return []
  }
}
