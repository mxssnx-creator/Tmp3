/**
 * Market Data Cache Module
 * Standalone module-level caching for market data to avoid class context issues
 * @version 1.0.0
 */

import { initRedis, getMarketData } from "@/lib/redis-db"

console.log("[v0] MarketDataCache module loaded v1.0.0")

// Module-level cache - guaranteed to exist
const CACHE = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 500 // ms

/**
 * Get market data with caching - module-level function
 * No class context needed - works reliably
 */
export async function getMarketDataCached(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = CACHE.get(symbol)

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  try {
    await initRedis()
    const rawData = await getMarketData(symbol)

    if (!rawData) {
      return null
    }

    const latest = Array.isArray(rawData) ? rawData[0] : rawData

    if (latest) {
      CACHE.set(symbol, { data: latest, timestamp: now })
      return latest
    }
    return null
  } catch (error) {
    console.error(`[v0] Failed to get market data for ${symbol}:`, error)
    return null
  }
}

// Settings cache
let SETTINGS_CACHE: { data: any; timestamp: number } | null = null

/**
 * Get settings with caching - module-level function
 */
export async function getSettingsCached(): Promise<any> {
  const now = Date.now()

  if (SETTINGS_CACHE && now - SETTINGS_CACHE.timestamp < CACHE_TTL) {
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
