/**
 * Market Data Cache Module
 * Standalone module-level caching for market data to avoid class context issues
 * Optimized for high-frequency, high-performance processing:
 *   - 200ms TTL per symbol (covers 1s indication cycle with headroom)
 *   - Batch prefetch for multiple symbols in one Redis pipeline call
 *   - In-flight deduplication to prevent concurrent fetches for the same symbol
 * @version 2.0.0
 */

import { initRedis, getMarketData, getRedisClient } from "@/lib/redis-db"

// Module-level cache - guaranteed to exist, no class context issues
const CACHE = new Map<string, { data: any; timestamp: number }>()
// High-frequency TTL: 200ms ensures fresh data each indication cycle (1000ms interval)
// but avoids redundant Redis round-trips within the same cycle across parallel symbol processing
const CACHE_TTL = 200 // ms

// In-flight deduplication: if a fetch is already in-progress for a symbol, await the same promise
const IN_FLIGHT = new Map<string, Promise<any>>()

/**
 * Get market data with caching - module-level function
 * No class context needed - works reliably across webpack bundle reloads
 */
export async function getMarketDataCached(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = CACHE.get(symbol)

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  // Deduplicate concurrent fetches for the same symbol
  const inFlight = IN_FLIGHT.get(symbol)
  if (inFlight) return inFlight

  const fetchPromise = (async () => {
    try {
      await initRedis()
      const rawData = await getMarketData(symbol)

      if (!rawData) {
        return null
      }

      const latest = Array.isArray(rawData) ? rawData[0] : rawData

      if (latest) {
        CACHE.set(symbol, { data: latest, timestamp: Date.now() })
        return latest
      }
      return null
    } catch (error) {
      // Return stale cache entry rather than null on transient Redis errors
      return CACHE.get(symbol)?.data ?? null
    } finally {
      IN_FLIGHT.delete(symbol)
    }
  })()

  IN_FLIGHT.set(symbol, fetchPromise)
  return fetchPromise
}

/**
 * Batch prefetch market data for multiple symbols in a single Redis pipeline
 * Call this at the start of each indication cycle to warm the cache for all symbols
 * so individual processIndication calls hit cache (zero Redis round-trips).
 */
export async function prefetchMarketDataBatch(symbols: string[]): Promise<void> {
  if (!symbols || symbols.length === 0) return
  try {
    await initRedis()
    const client = getRedisClient()
    const now = Date.now()

    // Filter to only symbols whose cache is stale
    const stale = symbols.filter((s) => {
      const c = CACHE.get(s)
      return !c || now - c.timestamp >= CACHE_TTL
    })
    if (stale.length === 0) return

    // Use Redis pipeline for minimal round-trips
    const pipeline = client.multi()
    for (const symbol of stale) {
      pipeline.hgetall(`market_data:${symbol}`)
    }
    const results = await pipeline.exec()

    if (Array.isArray(results)) {
      for (let i = 0; i < stale.length; i++) {
        const data = results[i]
        if (data && typeof data === "object" && Object.keys(data).length > 0) {
          CACHE.set(stale[i], { data, timestamp: Date.now() })
        }
      }
    }
  } catch {
    // Non-critical — individual fetches will fall back to per-symbol reads
  }
}

// Settings cache - 5s TTL (settings change rarely)
let SETTINGS_CACHE: { data: any; timestamp: number } | null = null
const SETTINGS_CACHE_TTL = 5000 // ms

/**
 * Get settings with caching - module-level function
 */
export async function getSettingsCached(): Promise<any> {
  const now = Date.now()

  if (SETTINGS_CACHE && now - SETTINGS_CACHE.timestamp < SETTINGS_CACHE_TTL) {
    return SETTINGS_CACHE.data
  }

  try {
    const { getSettings } = await import("@/lib/redis-db")
    await initRedis()
    const settings = await getSettings("all_settings") || {}

    const indicationSettings = {
      minProfitFactor: settings.minProfitFactor || 1.2,
      minConfidence: settings.minConfidence || 0.6,
      timeframes: settings.timeframes || ["1h", "4h", "1d"],
    }

    SETTINGS_CACHE = { data: indicationSettings, timestamp: now }
    return indicationSettings
  } catch {
    return {
      minProfitFactor: 1.2,
      minConfidence: 0.6,
      timeframes: ["1h", "4h", "1d"],
    }
  }
}
