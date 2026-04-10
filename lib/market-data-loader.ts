/**
 * Market Data Loader
 * Populates Redis with REAL OHLCV data from exchanges for trading engine
 * 
 * KEY ARCHITECTURE:
 *   market_data:{symbol}:1m       → JSON string, full MarketData object with 250 candles (used by engine loader)
 *   market_data:{symbol}:candles  → JSON string, raw candles array (used by indication processor for history)
 *   market_data:{symbol}          → Redis hash, single latest candle (used by getMarketData() in redis-db)
 */

import { getClient, initRedis, getAllConnections } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors"

export interface MarketDataCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketData {
  symbol: string
  timeframe: string // "1m", "5m", "15m", "1h", "4h", "1d"
  candles: MarketDataCandle[]
  lastUpdated: string
  source: string // Exchange name or "synthetic"
}

/**
 * Generate synthetic market data as fallback
 * Only used when exchange fetch fails
 */
export function generateSyntheticCandles(
  symbol: string,
  basePrice: number,
  candleCount: number = 100
): MarketDataCandle[] {
  const candles: MarketDataCandle[] = []
  const now = Date.now()
  const candleInterval = 60000 // 1 minute in ms

  let lastClose = basePrice

  for (let i = candleCount; i > 0; i--) {
    const timestamp = now - i * candleInterval
    
    // Generate realistic price movement (±0.5% per candle)
    const change = (Math.random() - 0.5) * lastClose * 0.01
    const open = lastClose
    const close = Math.max(lastClose * 0.8, lastClose + change) // Prevent crashes
    const high = Math.max(open, close) * (1 + Math.random() * 0.005)
    const low = Math.min(open, close) * (1 - Math.random() * 0.005)
    const volume = Math.random() * 1000000

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    })

    lastClose = close
  }

  return candles
}

/**
 * Fetch real OHLCV data from exchange
 * Uses the first available connection with valid credentials
 */
async function fetchRealMarketData(
  symbol: string,
  timeframe = "1m",
  limit = 250
): Promise<{ candles: MarketDataCandle[]; source: string } | null> {
  try {
    // Get all connections with credentials
    const connections = await getAllConnections()
    const validConnections = connections.filter((c: any) => {
      const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
      const hasValidCredentials = hasCredentials && 
        (c.api_key || c.apiKey || "").length > 5 && 
        (c.api_secret || c.apiSecret || "").length > 5
      return hasValidCredentials
    })

    if (validConnections.length === 0) {
      console.log(`[v0] [MarketData] No valid connections for fetching real data`)
      return null
    }

    // Try each connection until we get data
    for (const conn of validConnections) {
      try {
        const connector = await createExchangeConnector(
          conn.exchange,
          {
            apiKey: conn.api_key || conn.apiKey || "",
            apiSecret: conn.api_secret || conn.apiSecret || "",
            apiType: (conn.api_type || "perpetual_futures") as "spot" | "perpetual_futures" | "unified",
            isTestnet: conn.is_testnet === "1" || conn.is_testnet === true,
          }
        )

        console.log(`[v0] [MarketData] Fetching ${symbol} from ${conn.exchange} (${conn.name})...`)
        
        const candles = await connector.getOHLCV(symbol, timeframe, limit)
        
        if (candles && candles.length > 0) {
          console.log(`[v0] [MarketData] ✓ Fetched ${candles.length} real candles from ${conn.exchange}`)
          return { candles, source: conn.exchange }
        }
      } catch (err) {
        console.warn(`[v0] [MarketData] Failed to fetch from ${conn.exchange}:`, err)
        continue
      }
    }

    return null
  } catch (error) {
    console.error("[v0] [MarketData] Error fetching real market data:", error)
    return null
  }
}

/**
 * Load market data for all symbols into Redis
 * Fetches REAL data from exchanges, falls back to synthetic only on failure
 */
export async function loadMarketDataForEngine(symbols: string[] = []): Promise<number> {
  try {
    await initRedis()
    const client = getClient()

    // Default symbols if none provided
    const targetSymbols = symbols.length > 0 ? symbols : [
      "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
      "DOGEUSDT", "LINKUSDT", "LITUSDT", "THETAUSDT", "AVAXUSDT",
      "MATICUSDT", "SOLUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT"
    ]

    // Base prices for fallback synthetic data
    const basePrices: Record<string, number> = {
      BTCUSDT: 45000, ETHUSDT: 2500, BNBUSDT: 600, XRPUSDT: 0.5,
      ADAUSDT: 0.8, DOGEUSDT: 0.12, LINKUSDT: 25, LITUSDT: 120,
      THETAUSDT: 2.5, AVAXUSDT: 35, MATICUSDT: 1.2, SOLUSDT: 140,
      UNIUSDT: 15, APTUSDT: 10, ARBUSDT: 1.8,
    }

    let loaded = 0
    let realDataCount = 0
    let syntheticCount = 0

    console.log(`[v0] [MarketData] Loading market data for ${targetSymbols.length} symbols...`)
    console.log(`[v0] [MarketData] Will try to fetch REAL data from exchanges first...`)

    for (const symbol of targetSymbols) {
      try {
        // Try to fetch real data first
        const realData = await fetchRealMarketData(symbol, "1m", 250)
        
        let candles: MarketDataCandle[]
        let source: string
        
        if (realData && realData.candles.length > 0) {
          candles = realData.candles
          source = realData.source
          realDataCount++
        } else {
          // Fall back to synthetic data
          const basePrice = basePrices[symbol] || 100
          candles = generateSyntheticCandles(symbol, basePrice, 250)
          source = "synthetic"
          syntheticCount++
          console.log(`[v0] [MarketData] ⚠ Using synthetic data for ${symbol} (exchange fetch failed)`)
        }

        const marketData: MarketData = {
          symbol,
          timeframe: "1m",
          candles,
          lastUpdated: new Date().toISOString(),
          source,
        }

        const key = `market_data:${symbol}:1m`
        const jsonData = JSON.stringify(marketData)
        await client.set(key, jsonData)
        await client.expire(key, 86400) // 24 hour TTL
        console.log(`[v0] [MarketData] ✓ Stored ${key} (${jsonData.length} chars)`)

        // Store raw candles array for indication processor historical access
        const candlesKey = `market_data:${symbol}:candles`
        await client.set(candlesKey, JSON.stringify(candles))
        await client.expire(candlesKey, 86400)

        // CRITICAL: Also write latest candle to hash format so getMarketData() works
        const latestCandle = candles[candles.length - 1]
        if (latestCandle) {
          const hashKey = `market_data:${symbol}`
          const flatHash: Record<string, string> = {
            symbol,
            exchange: source,
            interval: "1m",
            price: String(latestCandle.close),
            open: String(latestCandle.open),
            high: String(latestCandle.high),
            low: String(latestCandle.low),
            close: String(latestCandle.close),
            volume: String(latestCandle.volume),
            timestamp: new Date(latestCandle.timestamp).toISOString(),
            candles_count: String(candles.length),
            data_source: source,
          }
          const flatArgs: string[] = []
          for (const [k, v] of Object.entries(flatHash)) {
            flatArgs.push(k, v)
          }
          await client.hmset(hashKey, ...flatArgs)
          await client.expire(hashKey, 86400)
          console.log(`[v0] [MarketData] ✓ Stored hash ${hashKey} (${flatArgs.length / 2} fields)`)
          
          const priceStr = latestCandle.close.toFixed(2)
          const sourceLabel = source === "synthetic" ? "(synthetic)" : `(real: ${source})`
          console.log(`[v0] [MarketData] ✓ ${symbol}: $${priceStr} ${sourceLabel}`)
        }

        loaded++
      } catch (error) {
        console.error(`[v0] [MarketData] Failed to load ${symbol}:`, error)
      }
    }

    console.log(`[v0] [MarketData] ✅ Loaded ${loaded}/${targetSymbols.length} symbols`)
    console.log(`[v0] [MarketData]    Real data: ${realDataCount} | Synthetic: ${syntheticCount}`)
    return loaded
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load market data:", error)
    return 0
  }
}

/**
 * Update market data for a specific symbol with REAL data from exchange
 */
export async function updateMarketDataForSymbol(symbol: string, connectionId?: string): Promise<boolean> {
  try {
    await initRedis()
    const client = getClient()

    // If connectionId provided, use that specific connection
    // Otherwise try all connections
    let candles: MarketDataCandle[] | null = null
    let source = "synthetic"

    if (connectionId) {
      const connections = await getAllConnections()
      const conn = connections.find((c: any) => c.id === connectionId)
      if (conn) {
        const result = await fetchRealMarketData(symbol, "1m", 250)
        if (result) {
          candles = result.candles
          source = result.source
        }
      }
    } else {
      const result = await fetchRealMarketData(symbol, "1m", 250)
      if (result) {
        candles = result.candles
        source = result.source
      }
    }

    // If no real data, use existing or generate synthetic
    if (!candles || candles.length === 0) {
      // Try to get existing data
      const existing = await client.get(`market_data:${symbol}:1m`)
      if (existing) {
        const existingData: MarketData = JSON.parse(existing)
        candles = existingData.candles
        source = existingData.source || "synthetic"
      } else {
        // Generate synthetic
        candles = generateSyntheticCandles(symbol, 100, 250)
        source = "synthetic"
      }
    }

    const marketData: MarketData = {
      symbol,
      timeframe: "1m",
      candles,
      lastUpdated: new Date().toISOString(),
      source,
    }

    const key = `market_data:${symbol}:1m`
    await client.set(key, JSON.stringify(marketData))
    await client.expire(key, 86400)

    // Update candles array
    const candlesKey = `market_data:${symbol}:candles`
    await client.set(candlesKey, JSON.stringify(candles))
    await client.expire(candlesKey, 86400)

    // Update hash
    const latestCandle = candles[candles.length - 1]
    if (latestCandle) {
      const hashKey = `market_data:${symbol}`
      const flatHash: Record<string, string> = {
        symbol,
        exchange: source,
        interval: "1m",
        price: String(latestCandle.close),
        open: String(latestCandle.open),
        high: String(latestCandle.high),
        low: String(latestCandle.low),
        close: String(latestCandle.close),
        volume: String(latestCandle.volume),
        timestamp: new Date(latestCandle.timestamp).toISOString(),
        candles_count: String(candles.length),
        data_source: source,
        last_updated: new Date().toISOString(),
      }
      const flatArgs: string[] = []
      for (const [k, v] of Object.entries(flatHash)) {
        flatArgs.push(k, v)
      }
      await client.hmset(hashKey, ...flatArgs)
      await client.expire(hashKey, 86400)
    }

    console.log(`[v0] [MarketData] ✓ Updated ${symbol} with ${source} data`)
    return source !== "synthetic"
  } catch (error) {
    console.error(`[v0] [MarketData] Failed to update ${symbol}:`, error)
    return false
  }
}

/**
 * Load market data for a specific date range
 * Fetches REAL historical data from exchanges when possible
 */
export async function loadHistoricalMarketData(
  symbol: string,
  startDate: Date,
  endDate: Date,
  timeframe: string = "1h"
): Promise<MarketDataCandle[]> {
  try {
    // Try to fetch real historical data - NO LIMIT
    const realData = await fetchRealMarketData(symbol, timeframe, 1000000)
    
    if (realData && realData.candles.length > 0) {
      console.log(`[v0] [MarketData] Using real historical data for ${symbol}: ${realData.candles.length} candles`)
      return realData.candles
    }

    // Fall back to synthetic - NO LIMIT
    console.log(`[v0] [MarketData] Generating synthetic historical data for ${symbol}`)
    const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const candlesPerDay = timeframe === "1h" ? 24 : timeframe === "4h" ? 6 : 1
    const totalCandles = daysDiff * candlesPerDay

    const candles = generateSyntheticCandles(symbol, 100, totalCandles)

    // Adjust timestamps to match the date range
    const startTimestamp = startDate.getTime()
    const interval = timeframe === "1h" ? 3600000 : timeframe === "4h" ? 14400000 : 86400000

    candles.forEach((candle, index) => {
      candle.timestamp = startTimestamp + index * interval
    })

    console.log(`[v0] [MarketData] Generated synthetic historical for ${symbol}: ${candles.length} candles`)
    return candles
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load historical data:", error)
    return []
  }
}
