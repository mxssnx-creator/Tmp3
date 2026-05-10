/**
 * Market Data Loader
 * Populates Redis with REAL OHLCV data from exchanges for trading engine
 *
 * ── KEY ARCHITECTURE (post spec §7 migration) ──────────────────────
 *
 *   market_data:{symbol}:1s       → JSON envelope, MarketData with 1s
 *                                   OHLCV buckets (default 1-day window,
 *                                   up to 86,400 buckets). Authoritative
 *                                   prehistoric source. Replaces the
 *                                   legacy `:1m` envelope which is no
 *                                   longer populated.
 *   market_data:{symbol}:candles  → JSON string, raw candles array
 *                                   (mirrors the 1s array; used by the
 *                                   indication processor for history
 *                                   access without parsing the envelope).
 *   market_data:{symbol}          → Redis hash, single latest candle
 *                                   (used by getMarketData() in
 *                                   redis-db for ticker snapshots).
 *
 * Why we changed timeframe everywhere:
 *   The operator spec explicitly says "Interval / Timeframe has to be
 *   1s as in Settings, change everywhere for Main Engine ... actually
 *   1 day." All callers now pass timeframe="1s" and the connector
 *   either uses native 1s klines (Binance spot) or aggregates from
 *   public-trade endpoints (see lib/exchange-connectors/aggregate-1s.ts).
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
  // Spec §7: timeframe is 1s, so synthetic samples step at 1-second
  // intervals (was 1 minute). Magnitude of per-bar drift is scaled
  // down 60× below so the price walk doesn't look insane.
  const candleInterval = 1000 // 1 second in ms

  let lastClose = basePrice

  for (let i = candleCount; i > 0; i--) {
    const timestamp = now - i * candleInterval
    
    // Generate realistic per-second price movement. At 1s resolution
    // a ±0.5% drift per bar would integrate to crazy intraday swings,
    // so we scale to ~±0.008% / bar — roughly 0.5% per minute on a
    // random walk basis, matching the previous behaviour at 1m.
    const change = (Math.random() - 0.5) * lastClose * 0.000167
    const open = lastClose
    const close = Math.max(lastClose * 0.8, lastClose + change)
    const high = Math.max(open, close) * (1 + Math.random() * 0.0001)
    const low = Math.min(open, close) * (1 - Math.random() * 0.0001)
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
        // Pass the original api_type - connector factory handles normalization per-exchange
        const connector = await createExchangeConnector(
          conn.exchange,
          {
            apiKey: conn.api_key || conn.apiKey || "",
            apiSecret: conn.api_secret || conn.apiSecret || "",
            apiType: (conn.api_type || "perpetual") as string,
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

    console.log(`[v0] [MarketData] Loading 1s market data for ${targetSymbols.length} symbols (1-day window)...`)
    console.log(`[v0] [MarketData] Will try to fetch REAL 1s intervals from exchanges first...`)

    // ── Window: 1 day at 1s timeframe (spec §7) ─────────────────────
    // 86,400 buckets per symbol. Real connectors will return what
    // their public endpoints allow — Binance spot delivers the full
    // window via paginated 1s klines; other connectors return their
    // best-effort coverage from recent-trades aggregation.
    const ONE_DAY_SECONDS = 86_400

    for (const symbol of targetSymbols) {
      try {
        // Try to fetch real 1s data first.
        const realData = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)

        let candles: MarketDataCandle[]
        let source: string

        if (realData && realData.candles.length > 0) {
          candles = realData.candles
          source = realData.source
          realDataCount++
        } else {
          // Fall back to synthetic 1s data — same shape so downstream
          // doesn't care. We don't generate 86k synthetic buckets; a
          // 250-bucket sample is enough for cold-boot decoration
          // before real data arrives via the engine's own loader.
          const basePrice = basePrices[symbol] || 100
          candles = generateSyntheticCandles(symbol, basePrice, 250)
          source = "synthetic"
          syntheticCount++
          console.log(`[v0] [MarketData] ⚠ Using synthetic data for ${symbol} (exchange 1s fetch failed)`)
        }

        const marketData: MarketData = {
          symbol,
          timeframe: "1s",
          candles,
          lastUpdated: new Date().toISOString(),
          source,
        }

        // Authoritative key under the new :1s suffix.
        const key = `market_data:${symbol}:1s`
        const jsonData = JSON.stringify(marketData)
        await client.set(key, jsonData)
        await client.expire(key, 86400) // 24 hour TTL

        // Store raw candles array for indication processor historical access.
        const candlesKey = `market_data:${symbol}:candles`
        await client.set(candlesKey, JSON.stringify(candles))
        await client.expire(candlesKey, 86400)

        // Also write latest bucket to hash format so getMarketData() works.
        const latestCandle = candles[candles.length - 1]
        if (latestCandle) {
          const hashKey = `market_data:${symbol}`
          const flatHash: Record<string, string> = {
            symbol,
            exchange: source,
            interval: "1s",
            price: String(latestCandle.close),
            open: String(latestCandle.open),
            high: String(latestCandle.high),
            low: String(latestCandle.low),
            close: String(latestCandle.close),
            volume: String(latestCandle.volume),
            timestamp: new Date(latestCandle.timestamp).toISOString(),
            // `candles_count` field name preserved so downstream readers
            // don't need a migration; it now counts 1s INTERVALS.
            candles_count: String(candles.length),
            data_source: source,
          }
          const flatArgs: string[] = []
          for (const [k, v] of Object.entries(flatHash)) {
            flatArgs.push(k, v)
          }
          await client.hmset(hashKey, ...flatArgs)
          await client.expire(hashKey, 86400)

          const priceStr = latestCandle.close.toFixed(2)
          const sourceLabel = source === "synthetic" ? "(synthetic)" : `(real: ${source})`
          console.log(`[v0] [MarketData] ✓ ${symbol}: $${priceStr} ${sourceLabel} (${candles.length} intervals)`)
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

    // Spec §7: same window as the bulk loader — 1s × 1 day.
    const ONE_DAY_SECONDS = 86_400

    if (connectionId) {
      const connections = await getAllConnections()
      const conn = connections.find((c: any) => c.id === connectionId)
      if (conn) {
        const result = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)
        if (result) {
          candles = result.candles
          source = result.source
        }
      }
    } else {
      const result = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)
      if (result) {
        candles = result.candles
        source = result.source
      }
    }

    // If no real data, use existing or generate synthetic
    if (!candles || candles.length === 0) {
      // Try to get existing data — :1s is now authoritative; fall back
      // to the legacy :1m envelope for one release so partial upgrades
      // don't lose data.
      const existing = (await client.get(`market_data:${symbol}:1s`)) ?? (await client.get(`market_data:${symbol}:1m`))
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
      timeframe: "1s",
      candles,
      lastUpdated: new Date().toISOString(),
      source,
    }

    const key = `market_data:${symbol}:1s`
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
        interval: "1s",
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
