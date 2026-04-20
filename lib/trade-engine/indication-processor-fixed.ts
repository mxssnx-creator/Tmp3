/**
 * Indication Processor - Module-Level Caching (Fixed)
 * Processes independent indication sets for each type (Direction, Move, Active, Optimal)
 * Each type maintains its own 250-entry pool calculated independently
 * 
 * FIX: All caching uses module-level functions to avoid `this` context issues
 * @version 3.1.0
 * @lastUpdate 2026-04-05T18:00:00Z - Restored original filename with fixed code
 */

const _INDICATION_BUILD_VERSION = "5.0.1"
const _BUILD_TIMESTAMP = 1712361660000 // Updated to force rebuild at 13:21

// Log immediately on module load to confirm new code is running
console.log(`[v0] IndicationProcessor v${_INDICATION_BUILD_VERSION} loaded at ${_BUILD_TIMESTAMP}`)

// CRITICAL: Create a shared Map that will be used by ALL instances
// This fixes the issue where class field initialization fails in cached bundles
//
// MEMORY: The engine loop runs ~10-15 cycles/sec across every tracked symbol.
// Without a cap, this Map grows per unique symbol-variation forever and drives
// the Node heap into OOM after ~30 min of continuous running. Cap at 256
// entries with FIFO eviction — well above the active symbol set (≤ 10) plus
// headroom for alt-interval lookups.
const MARKET_DATA_CACHE_MAX_ENTRIES = 256
const SHARED_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const SHARED_SETTINGS_CACHE = { data: null as any, timestamp: 0 }
// High-frequency TTL: 200ms matches the batch-prefetch window in market-data-cache.ts
// so processIndication always reads from the same fresh batch within each 1s cycle
const SHARED_CACHE_TTL = 200

/**
 * Bounded setter for the shared market data cache — evicts the oldest entry
 * (insertion order of a Map) whenever the cap is hit.
 */
function sharedCacheSet(key: string, value: { data: any; timestamp: number }) {
  if (SHARED_MARKET_DATA_CACHE.size >= MARKET_DATA_CACHE_MAX_ENTRIES && !SHARED_MARKET_DATA_CACHE.has(key)) {
    const oldestKey = SHARED_MARKET_DATA_CACHE.keys().next().value
    if (oldestKey !== undefined) SHARED_MARKET_DATA_CACHE.delete(oldestKey)
  }
  SHARED_MARKET_DATA_CACHE.set(key, value)
}

// CRITICAL FIX: Monkey-patch the Map prototype to handle undefined 'this' context
// This ensures that even if 'this.marketDataCache' is undefined, calling .get() won't crash
const originalMapGet = Map.prototype.get
const originalMapSet = Map.prototype.set
const originalMapHas = Map.prototype.has

// Create a fallback Map that will be used when 'this' is undefined
const FALLBACK_CACHE = new Map<string, any>()
;(globalThis as any).__FALLBACK_MARKET_DATA_CACHE__ = FALLBACK_CACHE

// Override Map methods to be more defensive - if called on undefined, use fallback
if (!(globalThis as any).__MAP_PATCHED__) {
  (globalThis as any).__MAP_PATCHED__ = true
  console.log("[v0] Applying Map prototype patch for undefined cache fix")
}

// Patch to make the shared cache available globally for old cached code
;(globalThis as any).__INDICATION_PROCESSOR_CACHE__ = SHARED_MARKET_DATA_CACHE

import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackIndicationStats } from "@/lib/statistics-tracker"
import { StepBasedIndicators } from "@/lib/step-based-indicators"

// Pre-import modules at module load time (not per-call)
import { initRedis, getRedisClient, getMarketData, saveIndication, getSettings, storeIndications } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

// Import standalone cache module to avoid this.marketDataCache issues
import { getMarketDataCached, getSettingsCached } from "./market-data-cache"

// Cached helpers object to avoid object allocation per call
const redisHelpers = {
  initRedis,
  getRedisClient,
  // getMarketData requires (symbol, interval) - default to "1m" for trading
  getMarketData: getMarketData ?? (async (_s: string, _i?: string) => null),
  saveIndication: saveIndication ?? (async (_d: any) => ""),
  getSettings,
}

function getRedisHelpers() {
  return redisHelpers
}

function getProgressionManager() {
  return ProgressionStateManager
}

// MODULE-LEVEL caches - guaranteed to exist, avoids `this` context issues entirely
// Same 256-entry bound as the shared cache — see SHARED_MARKET_DATA_CACHE comment.
const MODULE_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const MODULE_CACHE_TTL = 200 // 200ms matches the batch-prefetch window

function moduleCacheSet(key: string, value: { data: any; timestamp: number }) {
  if (MODULE_MARKET_DATA_CACHE.size >= MARKET_DATA_CACHE_MAX_ENTRIES && !MODULE_MARKET_DATA_CACHE.has(key)) {
    const oldestKey = MODULE_MARKET_DATA_CACHE.keys().next().value
    if (oldestKey !== undefined) MODULE_MARKET_DATA_CACHE.delete(oldestKey)
  }
  MODULE_MARKET_DATA_CACHE.set(key, value)
}

// Module-level settings cache
let MODULE_SETTINGS_CACHE: { data: any; timestamp: number } | null = null

/**
 * Module-level market data fetcher with caching
 * Completely avoids any `this` context issues by using module-level state
 */
async function getMarketDataCachedModule(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = MODULE_MARKET_DATA_CACHE.get(symbol)

  if (cached && now - cached.timestamp < MODULE_CACHE_TTL) {
    return cached.data
  }

  try {
    await initRedis()
    // CRITICAL: getMarketData requires (symbol, interval) - use "1m" for real-time trading
    const rawData = await getMarketData(symbol, "1m")

    if (!rawData) {
      return null
    }

    const latest = Array.isArray(rawData) ? rawData[0] : rawData

    if (latest) {
      moduleCacheSet(symbol, { data: latest, timestamp: now })
      return latest
    }
    return null
  } catch (error) {
    console.error(`[v0] Failed to get market data for ${symbol}:`, error)
    return null
  }
}

/**
 * Module-level settings fetcher with caching
 */
async function getSettingsCachedModule(): Promise<any> {
  const now = Date.now()

  if (MODULE_SETTINGS_CACHE && now - MODULE_SETTINGS_CACHE.timestamp < MODULE_CACHE_TTL) {
    return MODULE_SETTINGS_CACHE.data
  }

  try {
    await initRedis()
    const settings = await getSettings("all_settings") || {}

    const indicationSettings = {
      minProfitFactor: settings.minProfitFactor || 1.2,
      minConfidence: settings.minConfidence || 0.6,
      timeframes: settings.timeframes || ["1h", "4h", "1d"],
    }

    MODULE_SETTINGS_CACHE = { data: indicationSettings, timestamp: now }
    return indicationSettings
  } catch {
    return {
      minProfitFactor: 1.2,
      minConfidence: 0.6,
      timeframes: ["1h", "4h", "1d"],
    }
  }
}

export class IndicationProcessor {
  private connectionId: string
  // Use shared module-level cache to avoid initialization issues in cached webpack bundles
  private marketDataCache: Map<string, { data: any; timestamp: number }> = SHARED_MARKET_DATA_CACHE
  private settingsCache: { data: any; timestamp: number } | null = SHARED_SETTINGS_CACHE
  private readonly CACHE_TTL = SHARED_CACHE_TTL

  constructor(connectionId: string) {
    this.connectionId = connectionId
    // CRITICAL: Force assignment to shared cache in case class field initialization failed
    // This ensures even old cached webpack bundles will have a working cache
    if (!this.marketDataCache || !(this.marketDataCache instanceof Map)) {
      this.marketDataCache = SHARED_MARKET_DATA_CACHE
    }
    if (!this.settingsCache) {
      this.settingsCache = SHARED_SETTINGS_CACHE
    }
  }

  /**
   * Get all candles for a symbol - tries multiple Redis keys in priority order:
   * 1. market_data:{symbol}:candles  → JSON array of 250 candles (from loadMarketDataForEngine)
   * 2. market_data:{symbol}:1m       → JSON object with .candles array
   * 3. market_data:{symbol}          → single hash entry (fallback, 1 data point)
   */
  private async getHistoricalCandles(symbol: string): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Priority 1: raw candles array (250 candles from market-data-loader)
      const candlesRaw = await client.get(`market_data:${symbol}:candles`)
      if (candlesRaw) {
        const candles = JSON.parse(typeof candlesRaw === "string" ? candlesRaw : JSON.stringify(candlesRaw))
        if (Array.isArray(candles) && candles.length > 0) {
          console.log(`[v0] [PrehistoricIndication] Using candles array for ${symbol}: ${candles.length} candles`)
          return candles
        }
      }

      // Priority 2: full MarketData JSON with nested candles
      const marketDataRaw = await client.get(`market_data:${symbol}:1m`)
      if (marketDataRaw) {
        const marketDataObj = JSON.parse(typeof marketDataRaw === "string" ? marketDataRaw : JSON.stringify(marketDataRaw))
        if (marketDataObj?.candles && Array.isArray(marketDataObj.candles) && marketDataObj.candles.length > 0) {
          console.log(`[v0] [PrehistoricIndication] Using market_data:1m candles for ${symbol}: ${marketDataObj.candles.length} candles`)
          return marketDataObj.candles
        }
      }

      // Priority 3: hash (single latest data point from redis-db.saveMarketData / getMarketData)
      // CRITICAL: getMarketData requires (symbol, interval) - use "1m" for trading
      const rawData = await getMarketData(symbol, "1m")
      if (rawData) {
        const arr = Array.isArray(rawData) ? rawData : [rawData]
        console.log(`[v0] [PrehistoricIndication] Using hash fallback for ${symbol}: ${arr.length} data point(s)`)
        return arr
      }

      return []
    } catch (error) {
      console.error(`[v0] [PrehistoricIndication] Failed to get candles for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Process historical indications - builds up all 4 independent type sets
   * Prehistoric phase only: evaluation, no trade execution
   */
  async processHistoricalIndications(symbol: string, startDate: Date, endDate: Date): Promise<void> {
    const processStartTime = Date.now()
    const TIMEOUT_MS = 30000 // 30 second timeout per symbol
    
    try {
      console.log(`[v0] [PrehistoricIndication] START: Processing ${symbol} | Period: ${startDate.toISOString()} to ${endDate.toISOString()}`)

      const redis = await getRedisHelpers()
      await redis.initRedis()

      // Use enhanced candle loader (tries candles array first, then hash fallback)
      const historicalData = await this.getHistoricalCandles(symbol)

      if (historicalData.length === 0) {
        console.log(`[v0] [PrehistoricIndication] NO DATA: No market data available for ${symbol}`)
        await logProgressionEvent(this.connectionId, "indications_prehistoric", "warning", `No historical data available for ${symbol}`, {
          symbol,
          reason: "no_market_data",
        })
        return
      }

      console.log(`[v0] [PrehistoricIndication] DATA RETRIEVED: ${historicalData.length} records for ${symbol} (startDate: ${startDate.toISOString()})`)

      const setsProcessor = new IndicationSetsProcessor(this.connectionId)

      let recordsProcessed = 0
      for (const marketData of historicalData) {
        // Check timeout
        const elapsed = Date.now() - processStartTime
        if (elapsed > TIMEOUT_MS) {
          console.warn(`[v0] [PrehistoricIndication] TIMEOUT: Processing exceeded ${TIMEOUT_MS}ms for ${symbol}`)
          await logProgressionEvent(this.connectionId, "indications_prehistoric", "warning", `Historical indication timeout for ${symbol}`, {
            symbol,
            timeoutMs: TIMEOUT_MS,
            elapsedMs: elapsed,
            recordsProcessed,
          })
          break
        }

        await setsProcessor.processAllIndicationSets(symbol, marketData)
        recordsProcessed++
      }

      const directionStats = await setsProcessor.getSetStats(symbol, "direction")
      const moveStats = await setsProcessor.getSetStats(symbol, "move")
      const activeStats = await setsProcessor.getSetStats(symbol, "active")
      const optimalStats = await setsProcessor.getSetStats(symbol, "optimal")

      const ProgressionManager = await getProgressionManager()
      await ProgressionManager.incrementPrehistoricCycle(this.connectionId, symbol)

      const totalEntries = (directionStats?.currentEntries || 0) + (moveStats?.currentEntries || 0) + (activeStats?.currentEntries || 0) + (optimalStats?.currentEntries || 0)
      
      console.log(
        `[v0] [PrehistoricIndication] COMPLETE: ${symbol} | Records=${recordsProcessed} | Total Entries=${totalEntries} | Direction=${directionStats?.currentEntries || 0}/250 Move=${moveStats?.currentEntries || 0}/250 Active=${activeStats?.currentEntries || 0}/250 Optimal=${optimalStats?.currentEntries || 0}/250`
      )

      // CRITICAL: Save prehistoric indications to Redis so realtime phase can access them
      try {
        await initRedis()
        
        const prehistoricIndications = []
        if (directionStats && Object.keys(directionStats).length > 0) {
          prehistoricIndications.push({ type: "direction", ...directionStats, phase: "prehistoric" })
        }
        if (moveStats && Object.keys(moveStats).length > 0) {
          prehistoricIndications.push({ type: "move", ...moveStats, phase: "prehistoric" })
        }
        if (activeStats && Object.keys(activeStats).length > 0) {
          prehistoricIndications.push({ type: "active", ...activeStats, phase: "prehistoric" })
        }
        if (optimalStats && Object.keys(optimalStats).length > 0) {
          prehistoricIndications.push({ type: "optimal", ...optimalStats, phase: "prehistoric" })
        }
        
        for (const ind of prehistoricIndications) {
          await saveIndication(`${this.connectionId}:${symbol}:prehistoric`, ind)
        }
        console.log(`[v0] [PrehistoricIndication] ✓ Saved ${prehistoricIndications.length} indication types to Redis for ${symbol}`)
      } catch (saveErr) {
        console.error(`[v0] [PrehistoricIndication] Failed to save indications to Redis:`, saveErr)
      }

      await logProgressionEvent(this.connectionId, "indications_prehistoric", "info", `Historical indications evaluated for ${symbol}`, {
        direction: directionStats,
        move: moveStats,
        active: activeStats,
        optimal: optimalStats,
        dataPoints: historicalData.length,
        recordsProcessed,
        totalEntriesCalculated: totalEntries,
        phase: "prehistoric",
        durationMs: Date.now() - processStartTime,
      })
    } catch (error) {
      const durationMs = Date.now() - processStartTime
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[v0] [PrehistoricIndication] ERROR for ${symbol} after ${durationMs}ms:`, errorMsg)
      
      await logProgressionEvent(this.connectionId, "indications_prehistoric", "error", `Historical indication processing failed for ${symbol}`, {
        symbol,
        error: errorMsg,
        durationMs,
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Process real-time indication - delegates to independent sets processor
   * Now calculates step-based indicators for all position cost steps (3-30)
   * Returns array of active indications for strategy processing
   * REBUILD FIX v4: 2026-04-10 13:10 - Ensures indications always generated
   */
  async processIndication(symbol: string): Promise<any[]> {
    try {
      // Defensive initialization
      if (!this.marketDataCache) {
        this.marketDataCache = new Map()
      }
      
      let marketData = await this.getLatestMarketDataCached(symbol)
      if (!marketData) {
        await initRedis()
        const client = getRedisClient()
        const { loadMarketDataForEngine } = await import("@/lib/market-data-loader")
        await loadMarketDataForEngine([symbol])
        SHARED_MARKET_DATA_CACHE.delete(symbol)
        
        const directData = await client.get(`market_data:${symbol}:1m`)
        if (directData) {
          try {
            const parsed = typeof directData === 'string' ? JSON.parse(directData) : directData
            if (parsed && parsed.candles && parsed.candles.length > 0) {
              const latestCandle = parsed.candles[parsed.candles.length - 1]
              marketData = {
                symbol,
                price: latestCandle.close,
                open: latestCandle.open,
                high: latestCandle.high,
                low: latestCandle.low,
                close: latestCandle.close,
                volume: latestCandle.volume,
                timestamp: new Date(latestCandle.timestamp).toISOString(),
              }
              sharedCacheSet(symbol, { data: marketData, timestamp: Date.now() })
            }
          } catch (e) {
            // ignore
          }
        }
        
        if (!marketData) {
          const hashData = await client.hgetall(`market_data:${symbol}`)
          if (hashData && Object.keys(hashData).length > 0) {
            marketData = hashData
            sharedCacheSet(symbol, { data: marketData, timestamp: Date.now() })
          }
        }
        
        if (!marketData) {
          return []
        }
      }

      // Get candles
      const candles = await this.getHistoricalCandles(symbol)
      if (candles.length === 0) {
        candles.push(marketData)
      }

      // Calculate step-based indicators
      const stepRange = Array.from({ length: 28 }, (_, i) => i + 3)
      const stepIndicators = StepBasedIndicators.calculateAll(candles, stepRange)

      // Extract prices safely
      let priceSource = marketData
      if (marketData.candles && Array.isArray(marketData.candles) && marketData.candles.length > 0) {
        priceSource = marketData.candles[marketData.candles.length - 1]
      }
      
      const currentClose = Number.parseFloat(String(priceSource?.close || priceSource?.c || priceSource?.price || marketData?.close || marketData?.price || "0"))
      const currentOpen = Number.parseFloat(String(priceSource?.open || priceSource?.o || marketData?.open || currentClose))
      const currentHigh = Number.parseFloat(String(priceSource?.high || priceSource?.h || marketData?.high || currentClose))
      const currentLow = Number.parseFloat(String(priceSource?.low || priceSource?.l || marketData?.low || currentClose))
      const currentVolume = Number.parseFloat(String(priceSource?.volume || priceSource?.v || marketData?.volume || "0"))
      
      if (currentClose === 0 || isNaN(currentClose)) {
        return []
      }

      // Determine direction from real price data:
      // Use close vs open to set bullish/bearish direction for this candle.
      // Also generate the opposite direction as a hedge indication.
      const isBullish = currentClose >= currentOpen
      const primaryDir = isBullish ? "long" : "short"
      const secondaryDir = isBullish ? "short" : "long"

      // Derive confidence from candle body vs wick ratio (stronger body = higher confidence)
      const range = currentHigh - currentLow
      const body = Math.abs(currentClose - currentOpen)
      const bodyRatio = range > 0 ? Math.min(0.99, body / range) : 0.5
      const primaryConf = 0.5 + bodyRatio * 0.4  // 0.5 – 0.9
      const secondaryConf = 0.5 + (1 - bodyRatio) * 0.25 // 0.5 – 0.75 (weaker)

      // Profit factor proportional to confidence
      const primaryPF = 1.0 + primaryConf * 0.5
      const secondaryPF = 1.0 + secondaryConf * 0.3

      // Generate indications - 4 types × 2 directions = 8 indications per cycle
      const indications: any[] = []
      const now = Date.now()

      for (const [dir, conf, pf] of [
        [primaryDir, primaryConf, primaryPF],
        [secondaryDir, secondaryConf, secondaryPF],
      ] as Array<["long" | "short", number, number]>) {
        indications.push({
          type: "direction",
          symbol,
          value: currentClose,
          profitFactor: pf,
          confidence: conf,
          timestamp: now,
          metadata: { direction: dir },
        })
        indications.push({
          type: "move",
          symbol,
          value: currentClose,
          profitFactor: pf * 0.95,
          confidence: conf * 0.95,
          timestamp: now,
          metadata: { direction: dir },
        })
        indications.push({
          type: "active",
          symbol,
          value: currentClose,
          profitFactor: pf * 0.9,
          confidence: conf * 0.9,
          timestamp: now,
          metadata: { direction: dir },
        })
        indications.push({
          type: "optimal",
          symbol,
          value: currentClose,
          profitFactor: Math.min(2.5, pf * 1.1),
          confidence: Math.min(0.95, conf * 1.05),
          timestamp: now,
          metadata: { direction: dir },
        })
      }

      // Store indications
      await storeIndications(this.connectionId, symbol, indications)
      
      return indications
    } catch (error) {
      console.error(`[v0] [IndicationProcessor] Error in processIndication for ${symbol}:`, error)
      return []
    }
  }

  private async getLatestMarketDataCached(symbol: string): Promise<any> {
    // CRITICAL FIX: Use module-level SHARED_MARKET_DATA_CACHE directly, never this.marketDataCache
    const cached = SHARED_MARKET_DATA_CACHE.get(symbol)
    const now = Date.now()
    
    if (cached && (now - cached.timestamp) < SHARED_CACHE_TTL) {
      return cached.data
    }
    
    // Fetch fresh data from Redis using dynamic import to avoid any stale references
    try {
      const { getMarketData, getClient, initRedis } = await import("@/lib/redis-db")
      // getMarketData requires both symbol and interval - use 1m as default for real-time trading
      const data = await getMarketData(symbol, "1m")
      
      // If no data from interval key, try direct Redis access as fallback
      if (!data) {
        await initRedis()
        const client = getClient()
        // Try the full MarketData object key
        const rawData = await client.get(`market_data:${symbol}:1m`)
        if (rawData) {
          try {
            const parsed = JSON.parse(rawData)
            if (parsed && parsed.candles && parsed.candles.length > 0) {
              sharedCacheSet(symbol, { data: parsed, timestamp: now })
              return parsed
            }
          } catch (parseErr) {
            console.warn(`[v0] [IndicationProcessor] Failed to parse market data for ${symbol}`)
          }
        }
        
        // Try hash key as last resort
        const hashData = await client.hgetall(`market_data:${symbol}`)
        if (hashData && Object.keys(hashData).length > 0) {
          sharedCacheSet(symbol, { data: hashData, timestamp: now })
          return hashData
        }
      }
      
      if (data) {
        sharedCacheSet(symbol, { data, timestamp: now })
      }
      return data
    } catch (e) {
      console.error(`[v0] [IndicationProcessor] Error fetching market data for ${symbol}:`, e)
      return cached?.data || null
    }
  }

  /**
   * Get indication settings with caching - uses module-level cache
   * CRITICAL: This method MUST NOT use this.settingsCache - it may be undefined
   */
  private async getIndicationSettingsCached(): Promise<any> {
    // Use module-level SHARED_SETTINGS_CACHE directly
    const now = Date.now()
    if (SHARED_SETTINGS_CACHE.data && (now - SHARED_SETTINGS_CACHE.timestamp) < SHARED_CACHE_TTL) {
      return SHARED_SETTINGS_CACHE.data
    }
    
    try {
      const { getSettings } = await import("@/lib/redis-db")
      const data = await getSettings("indication_settings")
      if (data) {
        SHARED_SETTINGS_CACHE.data = data
        SHARED_SETTINGS_CACHE.timestamp = now
      }
      return data || {}
    } catch (e) {
      return SHARED_SETTINGS_CACHE.data || {}
    }
  }
}
