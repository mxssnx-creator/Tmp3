/**
 * Indication Processor - Module-Level Caching (Fixed)
 * Processes independent indication sets for each type (Direction, Move, Active, Optimal)
 * Each type maintains its own 250-entry pool calculated independently
 * 
 * FIX: All caching uses module-level functions to avoid `this` context issues
 * @version 3.1.0
 * @lastUpdate 2026-04-05T18:00:00Z - Restored original filename with fixed code
 */

const _INDICATION_BUILD_VERSION = "3.3.0"
const _BUILD_TIMESTAMP = 1712359000000

// Log immediately on module load to confirm new code is running
console.log(`[v0] IndicationProcessor v${_INDICATION_BUILD_VERSION} loaded`)

// CRITICAL: Create a shared Map that will be used by ALL instances
// This fixes the issue where class field initialization fails in cached bundles
const SHARED_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const SHARED_SETTINGS_CACHE = { data: null as any, timestamp: 0 }
const SHARED_CACHE_TTL = 500

// Patch to make the shared cache available globally for old cached code
;(globalThis as any).__INDICATION_PROCESSOR_CACHE__ = SHARED_MARKET_DATA_CACHE

import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackIndicationStats } from "@/lib/statistics-tracker"
import { StepBasedIndicators } from "@/lib/step-based-indicators"

// Pre-import modules at module load time (not per-call)
import { initRedis, getRedisClient, getMarketData, saveIndication, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

// Import standalone cache module to avoid this.marketDataCache issues
import { getMarketDataCached, getSettingsCached } from "./market-data-cache"

// Cached helpers object to avoid object allocation per call
const redisHelpers = {
  initRedis,
  getRedisClient,
  getMarketData: getMarketData ?? (async (_s: string) => null),
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
const MODULE_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const MODULE_CACHE_TTL = 500

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
    const rawData = await getMarketData(symbol)

    if (!rawData) {
      return null
    }

    const latest = Array.isArray(rawData) ? rawData[0] : rawData

    if (latest) {
      MODULE_MARKET_DATA_CACHE.set(symbol, { data: latest, timestamp: now })
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
      const rawData = await getMarketData(symbol)
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
   */
  async processIndication(symbol: string): Promise<any[]> {
    try {
      // Defensive initialization - ensure cache exists even if constructor failed
      if (!this.marketDataCache) {
        this.marketDataCache = new Map()
      }
      
      let marketData = await this.getLatestMarketDataCached(symbol)
      if (!marketData) {
        // Try to load market data if not available
        const redis = await getRedisHelpers()
        await redis.initRedis()

        // Force load market data for this symbol
        const { loadMarketDataForEngine } = await import("@/lib/market-data-loader")
        await loadMarketDataForEngine([symbol])

        // Retry getting market data
        const retryMarketData = await this.getLatestMarketDataCached(symbol)
        if (!retryMarketData) {
          console.log(`[v0] [IndicationProcessor] No market data available for ${symbol} after loading attempt`)
          return []
        }
        console.log(`[v0] [IndicationProcessor] Market data loaded on-demand for ${symbol}`)
        // Continue with the loaded market data
        marketData = retryMarketData
      }

      // Get historical candles for step-based calculations
      const candles = await this.getHistoricalCandles(symbol)
      if (candles.length === 0) {
        // Fallback to single candle if no history
        candles.push(marketData)
      }

      // Calculate STEP-BASED indicators (3-30 steps)
      const stepRange = Array.from({ length: 28 }, (_, i) => i + 3) // Steps 3 through 30
      const stepIndicators = StepBasedIndicators.calculateAll(candles, stepRange)

      console.log(`[v0] [IndicationProcessor] Step-based indicators calculated for ${symbol}: ${stepRange.length} steps analyzed`)

      // Market data is a single candle object with fields: price, open, high, low, close, volume, timestamp
      // Extract price information from the single candle
      const currentClose = Number.parseFloat(marketData.close || marketData.price || "0")
      const currentOpen = Number.parseFloat(marketData.open || currentClose)
      const currentHigh = Number.parseFloat(marketData.high || currentClose)
      const currentLow = Number.parseFloat(marketData.low || currentClose)
      const currentVolume = Number.parseFloat(marketData.volume || "0")
      
      if (currentClose === 0 || isNaN(currentClose)) {
        // Disabled logging - runs per symbol per cycle
        return []
      }

      // Generate indication from current candle data
      // Since we only have 1 candle, use OHLC to create artificial price history
      const prices = [currentOpen, currentLow, currentClose, currentHigh, currentClose] // Simple 5-point history
      
      // Disabled logging - runs per symbol per cycle
      const direction = currentClose >= currentOpen ? "long" : "short"
      const priceChange = ((currentClose - currentOpen) / currentOpen) * 100
      const directionConfidence = Math.min(0.95, 0.5 + Math.abs(priceChange) / 100)
      
      // Calculate simple indications from current candle OHLC
      const indications: any[] = []
      
      // Step-based indicators for DIRECTION indication
      const stepDirections: any = {}
      for (const [step, indicators] of Object.entries(stepIndicators)) {
        const ma = indicators.ma as number
        if (!ma || ma === 0) continue
        const signal = currentClose > ma ? 1 : -1
        stepDirections[step] = { signal, ma, confidence: 0.5 + Math.abs((currentClose - ma) / ma) * 0.45 }
      }
      
      indications.push({
        type: "direction",
        symbol,
        value: direction === "long" ? 1 : -1,
        profitFactor: 1.0 + Math.abs(priceChange) / 100,
        drawdownTime: 0,
        confidence: directionConfidence,
        positionState: "new",
        continuousPosition: false,
        stepIndicators: stepDirections,
        metadata: {
          direction,
          priceChange,
          open: currentOpen,
          close: currentClose,
          high: currentHigh,
          low: currentLow,
        }
      })
      
      // Move indication: based on high-low range AND step-based RSI
      const range = currentHigh - currentLow
      const rangePercent = (range / currentClose) * 100
      const moveConfidence = Math.min(0.95, 0.5 + Math.min(rangePercent, 10) / 20)
      
      const stepRSI: any = {}
      for (const [step, indicators] of Object.entries(stepIndicators)) {
        const rsi = indicators.rsi as number
        if (rsi === undefined || rsi === null) continue
        stepRSI[step] = { rsi, isOversold: rsi < 30, isOverbought: rsi > 70, confidence: Math.abs(50 - rsi) / 50 }
      }
      
      indications.push({
        type: "move",
        symbol,
        value: rangePercent > 2 ? 1 : 0,
        profitFactor: 1.0 + rangePercent / 100,
        drawdownTime: 0,
        confidence: moveConfidence,
        positionState: "new",
        continuousPosition: false,
        stepIndicators: stepRSI,
        metadata: {
          range,
          rangePercent,
          volatility: rangePercent,
        }
      })
      
      // Active indication: based on volume AND step-based MACD
      const activeConfidence = Math.min(0.95, 0.5 + Math.min(currentVolume, 1000) / 2000)
      
      const stepMACD: any = {}
      for (const [step, indicators] of Object.entries(stepIndicators)) {
        const macd = indicators.macd as any
        if (!macd || macd.macd === undefined || macd.signal === undefined) continue
        const macdSignal = macd.macd > macd.signal ? 1 : -1
        const histogram = macd.macd - macd.signal
        stepMACD[step] = { macd: macd.macd, signal: macd.signal, histogram, direction: macdSignal, confidence: Math.abs(histogram) / Math.max(Math.abs(macd.signal), 0.001) }
      }
      
      indications.push({
        type: "active",
        symbol,
        value: currentVolume > 0 ? 1 : 0,
        profitFactor: 1.0 + Math.min(currentVolume, 1000) / 1000,
        drawdownTime: 0,
        confidence: activeConfidence,
        positionState: "new",
        continuousPosition: false,
        stepIndicators: stepMACD,
        metadata: {
          volume: currentVolume,
          volumeActive: currentVolume > 0,
        }
      })
      
      // Optimal indication: step-based Bollinger Bands
      const stepBB: any = {}
      for (const [step, indicators] of Object.entries(stepIndicators)) {
        const bb = indicators.bb as any
        if (!bb || bb.upper === undefined) continue
        const bbRange = bb.upper - bb.lower
        const isNearUpper = currentClose > (bb.upper * 0.95)
        const isNearLower = currentClose < (bb.lower * 1.05)
        const bbPosition = bbRange > 0 ? (currentClose - bb.lower) / bbRange : 0.5
        stepBB[step] = { upper: bb.upper, middle: bb.middle, lower: bb.lower, nearUpper: isNearUpper, nearLower: isNearLower, confidence: Math.min(0.95, 0.5 + bbPosition) }
      }
      
      indications.push({
        type: "optimal",
        symbol,
        value: currentClose > currentOpen ? 1 : -1,
        profitFactor: 1.0 + Math.abs(priceChange) / 100,
        drawdownTime: 0,
        confidence: directionConfidence,
        positionState: "new",
        continuousPosition: false,
        stepIndicators: stepBB,
        metadata: {
          allStepsAnalyzed: stepRange.length,
          stepRange: { min: 3, max: 30 },
        }
      })
      
      // Disabled per-cycle logging - only store and return

      // Store indications in Redis for progression tracking (batch save)
      try {
        // Save ALL indications to the main indication storage key for strategy processor
        const mainKey = `indications:${this.connectionId}`
        
        // Get existing indications or create new array — must call initRedis then get client
        await initRedis()
        const client = getRedisClient()
        
        if (!client) {
          console.error(`[v0] [IndicationProcessor] Redis client not available for ${symbol}`)
          return indications
        }
        
        console.log(`[v0] [IndicationProcessor] Processing ${indications.length} indications for ${symbol}`)
        
        // Read existing indications
        const existingRaw = await client.get(mainKey)
        let existingIndications: any[] = []
        if (existingRaw) {
          try {
            existingIndications = JSON.parse(typeof existingRaw === "string" ? existingRaw : JSON.stringify(existingRaw))
            if (!Array.isArray(existingIndications)) {
              existingIndications = []
            }
          } catch {
            existingIndications = []
          }
        }
        
        console.log(`[v0] [IndicationProcessor] Found ${existingIndications.length} existing indications in Redis at ${mainKey}`)
        
        // Add new indications with symbol context
        for (const ind of indications) {
          existingIndications.push({
            ...ind,
            symbol,
            timestamp: new Date().toISOString(),
          })
        }
        
        console.log(`[v0] [IndicationProcessor] Total indications after merge: ${existingIndications.length}`)
        
        // Keep only latest 1000 indications per connection to avoid memory bloat
        if (existingIndications.length > 1000) {
          existingIndications = existingIndications.slice(-1000)
        }
        
        // Save back to Redis
        await client.set(mainKey, JSON.stringify(existingIndications), { EX: 3600 })
        console.log(`[v0] [IndicationProcessor] ✓ Saved ${indications.length} indications for ${symbol} to ${mainKey}, total now=${existingIndications.length}`)
        
        // Also save per-symbol for debugging
        const symbolKey = `${this.connectionId}:${symbol}:realtime`
        await saveIndication(symbolKey, indications[0])
        
        // Track each indication to database for statistics and historical analysis
        for (const indication of indications) {
          try {
            await trackIndicationStats(
              this.connectionId,
              symbol,
              indication.type,
              indication.value,
              indication.confidence
            )
          } catch (e) {
            console.warn(`[v0] [IndicationProcessor] Failed to track indication:`, e)
          }
        }
      } catch (redisErr) {
        console.error(`[v0] [IndicationProcessor] Redis error saving indications:`, redisErr)
      }

      return indications
    } catch (error) {
      console.error(`[v0] [RealtimeIndication] ERROR:`, error)
      return []
    }
  }

  /**
   * Get latest market data with caching to avoid repeated Redis calls
   * Uses standalone module import to avoid any `this` context issues
   */
  private async getLatestMarketDataCached(symbol: string): Promise<any> {
    // Use imported standalone function from market-data-cache.ts
    return getMarketDataCached(symbol)
  }

  /**
   * Get indication settings with caching - uses standalone module
   */
  private async getIndicationSettingsCached(): Promise<any> {
    // Use imported standalone function from market-data-cache.ts
    return getSettingsCached()
  }
}
