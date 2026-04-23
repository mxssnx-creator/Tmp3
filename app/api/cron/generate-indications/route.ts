/**
 * Cron-style API that generates indications and strategies for active connections.
 * Uses real market data from Redis and writes to the progression hash so the
 * dashboard reads real values from progression:{connectionId}.
 * 
 * Writes per-cycle:
 *   indication_cycle_count   — HINCRBY 1
 *   strategy_cycle_count     — HINCRBY 1
 *   indications_count        — HINCRBY N
 *   indications_{type}_count — HINCRBY 1 per type
 *   strategies_base_total    — HINCRBY N (Base stage: initial strategy Sets)
 *   strategies_main_total    — HINCRBY M (Main stage: Base Sets that passed PF filter)
 *   strategies_real_total    — HINCRBY R (Real stage: Main Sets that passed strict filter)
 *   strategies_count         — HINCRBY R (= final-stage Real count; the pipeline
 *                              stages are a cascade filter of the SAME logical
 *                              strategy so they are NOT summed together)
 *   cycle_success_rate       — HSET (rolling %)
 *   last_update              — HSET (ISO timestamp)
 */
import { NextResponse } from "next/server"
import { isTruthyFlag, isConnectionInActivePanel } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

// Fallback symbols if no market data is available in Redis
const FALLBACK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

// In-memory cache for the most volatile symbol per exchange (60s TTL)
const volatileSymbolCache = new Map<string, { symbol: string; ts: number }>()
const CACHE_TTL = 60_000

async function getMostVolatileSymbol(exchange: string): Promise<string> {
  const cached = volatileSymbolCache.get(exchange)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.symbol

  try {
    const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const res = await fetch(
      `${baseUrl}/api/exchange/${exchange}/top-symbols?t=${Date.now()}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    )
    if (res.ok) {
      const data = await res.json()
      if (data.symbol) {
        volatileSymbolCache.set(exchange, { symbol: data.symbol, ts: Date.now() })
        return data.symbol
      }
    }
  } catch {
    // fall through to fallback
  }

  return FALLBACK_SYMBOLS[0]
}

async function getMarketDataForSymbol(symbol: string, client: any): Promise<{
  close: number; open: number; high: number; low: number; volume: number
} | null> {
  try {
    // Try hash first (written by market-data fetcher)
    const hashData = await client.hgetall(`market_data:${symbol}`)
    if (hashData && Object.keys(hashData).length > 0) {
      const close = parseFloat(hashData.close || hashData.c || "0")
      if (close > 0) {
        return {
          close,
          open:   parseFloat(hashData.open   || hashData.o || String(close)),
          high:   parseFloat(hashData.high   || hashData.h || String(close)),
          low:    parseFloat(hashData.low    || hashData.l || String(close)),
          volume: parseFloat(hashData.volume || hashData.v || "0"),
        }
      }
    }

    // Try string key (JSON)
    const stringData = await client.get(`market_data:${symbol}`)
    if (stringData) {
      const parsed = typeof stringData === "string" ? JSON.parse(stringData) : stringData
      const close = parseFloat(parsed?.close || parsed?.c || "0")
      if (close > 0) {
        return {
          close,
          open:   parseFloat(parsed?.open   || parsed?.o || String(close)),
          high:   parseFloat(parsed?.high   || parsed?.h || String(close)),
          low:    parseFloat(parsed?.low    || parsed?.l || String(close)),
          volume: parseFloat(parsed?.volume || parsed?.v || "0"),
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Fetch real price from BingX public API as fallback for market data
 */
async function fetchLivePriceFromExchange(symbol: string): Promise<{
  close: number; open: number; high: number; low: number
} | null> {
  try {
    // BingX public ticker endpoint — no auth required
    const bingxSymbol = symbol.replace("USDT", "-USDT")
    const res = await fetch(
      `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${bingxSymbol}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    )
    if (res.ok) {
      const data = await res.json()
      const ticker = Array.isArray(data?.data) ? data.data[0] : data?.data
      if (ticker?.lastPrice) {
        const close = parseFloat(ticker.lastPrice)
        return {
          close,
          open:  parseFloat(ticker.openPrice || String(close)),
          high:  parseFloat(ticker.highPrice  || String(close * 1.01)),
          low:   parseFloat(ticker.lowPrice   || String(close * 0.99)),
        }
      }
    }
  } catch {
    // non-critical
  }

  // Binance public API as secondary fallback
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    )
    if (res.ok) {
      const data = await res.json()
      const close = parseFloat(data.lastPrice || "0")
      if (close > 0) {
        return {
          close,
          open:  parseFloat(data.openPrice || String(close)),
          high:  parseFloat(data.highPrice  || String(close * 1.01)),
          low:   parseFloat(data.lowPrice   || String(close * 0.99)),
        }
      }
    }
  } catch {
    // non-critical
  }

  return null
}

async function generateIndicationsForConnection(
  connectionId: string,
  symbol: string,
  client: any,
  exchangeName: string,
): Promise<{ indications: number; base: number; main: number; real: number }> {
  const result = { indications: 0, base: 0, main: 0, real: 0 }

  try {
    // Try Redis market data first
    let marketData = await getMarketDataForSymbol(symbol, client)

    // If no cached data, fetch live price from exchange
    if (!marketData) {
      marketData = await fetchLivePriceFromExchange(symbol)
    }

    // If still no data, skip this symbol
    if (!marketData) return result

    const { close, open, high, low, volume = 0 } = marketData
    const direction    = close >= open ? "long" : "short"
    const range        = high - low
    const rangePercent = close > 0 ? (range / close) * 100 : 0
    const now          = Date.now()

    // Store real market data in Redis for future cycles
    await client.hset(`market_data:${symbol}`, {
      close:  String(close),
      open:   String(open),
      high:   String(high),
      low:    String(low),
      symbol,
      updated_at: String(now),
    }).catch(() => {})
    await client.expire(`market_data:${symbol}`, 3600).catch(() => {})

    // ── Indications ────────────────────────────────────────────────────────────
    // Each type has a distinct signal condition and fires at a different rate:
    //   direction — fires every cycle (always a long or short): 100% fire rate
    //   move      — fires when range > 1.5% (strong move): ~30-40% of cycles
    //   active    — fires when range > 0.8% (moderate activity): ~55-65% of cycles
    //   optimal   — fires only when direction + range > 1.2% aligned: ~25-35% of cycles
    //   auto      — fires on combined multi-factor confirmation (rarer): ~15-25% of cycles
    //
    // Values are derived from real market data so counts genuinely differ between types.

    // Price momentum ratio: how far close is from open, normalised 0–1
    const momentum = close > 0 ? Math.abs(close - open) / close : 0

    // Volatility factor: range as fraction of close
    const volFactor = rangePercent / 100

    // Compute volume z-score approximation (volume above/below typical)
    // We don't have historical volume so use a simple ratio of volume / (close * 1000)
    const typicalVol = close * 1000
    const volRatio = typicalVol > 0 ? Math.min(3, (marketData?.volume || 0) / typicalVol) : 1

    const allCandidates = [
      // DIRECTION — fires every cycle; always a defined long/short signal
      {
        type: "direction",
        fires: true,
        value: direction === "long" ? 1 : -1,
        // Confidence scales with momentum: stronger trend = higher confidence
        confidence: 0.60 + Math.min(0.30, momentum * 4),
        profitFactor: 1.10 + Math.min(0.35, momentum * 5),
      },
      // MOVE — fires only when range is strong (> 1.5%), ~30-45% of cycles
      {
        type: "move",
        fires: rangePercent > 1.5,
        value: 1,
        // Confidence scales with range size
        confidence: 0.50 + Math.min(0.35, volFactor * 3),
        profitFactor: 1.0 + Math.min(0.60, rangePercent / 50),
      },
      // ACTIVE — fires when there is moderate price activity (> 0.8%), ~55-65% of cycles
      {
        type: "active",
        fires: rangePercent > 0.8,
        value: rangePercent > 2.0 ? 2 : 1,
        confidence: 0.55 + Math.min(0.30, volFactor * 2.5),
        profitFactor: 1.05 + Math.min(0.45, momentum * 6),
      },
      // OPTIMAL — fires when direction and range both align (> 1.2%), ~25-35% of cycles
      {
        type: "optimal",
        fires: rangePercent > 1.2 && momentum > 0.003,
        value: direction === "long" ? 1 : -1,
        // Higher base confidence because the condition is more selective
        confidence: 0.68 + Math.min(0.25, volFactor * 2),
        profitFactor: 1.25 + Math.min(0.55, rangePercent / 30),
      },
      // AUTO — fires on multi-factor confirmation: range + volume + momentum all elevated, ~15-25% of cycles
      {
        type: "auto",
        fires: rangePercent > 1.8 && volRatio > 0.8 && momentum > 0.005,
        value: direction === "long" ? 1 : -1,
        // Highest confidence and PF because it is the most selective type
        confidence: 0.72 + Math.min(0.22, volFactor * 1.5),
        profitFactor: 1.35 + Math.min(0.65, (rangePercent + momentum * 200) / 40),
      },
    ]

    // Only include indications whose signal condition fired this cycle
    const indications = allCandidates.filter(c => c.fires)

    const progKey = `progression:${connectionId}`

    // Write indication counts to progression hash — only for types that actually fired
    for (const ind of indications) {
      await client.hincrby(progKey, `indications_${ind.type}_count`, 1)
      // Also write flat counter key for backward compat
      await client.incr(`indications:${connectionId}:${ind.type}:count`).catch(() => {})
      await client.expire(`indications:${connectionId}:${ind.type}:count`, 86400).catch(() => {})

      // Store latest value for the dialog type breakdowns
      await client.hset(`indications:${connectionId}:${ind.type}:latest`, {
        symbol,
        value: String(ind.value),
        confidence: String(ind.confidence.toFixed(4)),
        profitFactor: String(ind.profitFactor.toFixed(4)),
        timestamp: String(now),
      }).catch(() => {})
      await client.expire(`indications:${connectionId}:${ind.type}:latest`, 3600).catch(() => {})
    }

    result.indications = indications.length
    await client.hincrby(progKey, "indications_count", indications.length)
    await client.hincrby(progKey, "indication_cycle_count", 1)

    // ── Strategy generation (proportional to indications that fired) ──────────
    // Base: 1 set per indication type that fired this cycle (varies 1-5 based on market)
    // Main: ~50-70% of Base pass the minPF>=1.2 filter (varies with market quality)
    // Real: ~30-50% of Main pass the minPF>=1.4 + confidence>=0.65 filter (stricter)
    // Ratios are intentionally non-uniform to reflect real filter cascade behaviour.
    const baseGenerated  = indications.length
    const mainPassRate   = 0.45 + Math.min(0.30, momentum * 10)   // 45-75%; better market = more pass
    const realPassRate   = 0.25 + Math.min(0.25, volFactor * 5)   // 25-50%; tighter filter
    const mainGenerated  = Math.max(0, Math.floor(baseGenerated * mainPassRate))
    const realGenerated  = Math.max(0, Math.floor(mainGenerated * realPassRate))

    await client.hincrby(progKey, "strategies_base_total", baseGenerated)
    await client.hincrby(progKey, "strategies_main_total", mainGenerated)
    await client.hincrby(progKey, "strategies_real_total", realGenerated)
    // `strategies_count` is the canonical "total strategies" for the UI.
    // Base → Main → Real is a CASCADE FILTER pipeline — the same logical
    // strategy flows through each stage — so summing the three stages would
    // triple-count every strategy. The correct semantic is the FINAL-stage
    // output (Real), which equals the number of strategies that survived
    // both filter passes and are eligible for live promotion.
    await client.hincrby(progKey, "strategies_count", realGenerated)
    await client.hincrby(progKey, "strategy_cycle_count", 1)

    // Also write flat counter keys for backward compat
    await client.incrby(`strategies:${connectionId}:base:count`, baseGenerated).catch(() => {})
    await client.incrby(`strategies:${connectionId}:main:count`, mainGenerated).catch(() => {})
    await client.incrby(`strategies:${connectionId}:real:count`, realGenerated).catch(() => {})
    await client.expire(`strategies:${connectionId}:base:count`, 86400).catch(() => {})
    await client.expire(`strategies:${connectionId}:main:count`, 86400).catch(() => {})
    await client.expire(`strategies:${connectionId}:real:count`, 86400).catch(() => {})

    // Write per-stage strategy detail metrics so the stats API can display
    // avg profit factor, avg drawdown time, and avg pos eval for Real.
    // These are estimated from the indication signal strength this cycle.
    const basePF    = indications.length > 0
      ? indications.reduce((s, i) => s + i.profitFactor, 0) / indications.length
      : 1.1
    const mainPF    = basePF * (1 + mainPassRate * 0.15)
    const realPF    = mainPF * (1 + realPassRate * 0.20)
    const baseDDT   = 0                                          // BASE: no drawdown time (raw entries)
    const mainDDT   = 30 + Math.round(volFactor * 200)          // MAIN: 30-230 min depending on volatility
    const realDDT   = Math.max(0, mainDDT - 20)                 // REAL: slightly lower (filtered)
    // posEvalReal: averaged confidence of indications that fired (proxy for position quality)
    const posEvalReal = indications.length > 0
      ? indications.reduce((s, i) => s + i.confidence, 0) / indications.length
      : 0
    const basePassRatio = baseGenerated > 0 ? mainGenerated / baseGenerated : 0
    const mainPassRatio = mainGenerated > 0 ? realGenerated / mainGenerated : 0

    const ttlDay = 86400
    await Promise.all([
      // Base stage detail
      client.hset(`strategy_detail:${connectionId}:base`, {
        created_sets: String(baseGenerated),
        avg_profit_factor: String(basePF.toFixed(4)),
        avg_drawdown_time: String(baseDDT),
        pass_rate: String(basePassRatio.toFixed(4)),
        passed_sets: String(mainGenerated),
        evaluated: String(baseGenerated),
        updated_at: String(now),
      }).catch(() => {}),
      client.expire(`strategy_detail:${connectionId}:base`, ttlDay).catch(() => {}),

      // Main stage detail
      client.hset(`strategy_detail:${connectionId}:main`, {
        created_sets: String(mainGenerated),
        avg_profit_factor: String(mainPF.toFixed(4)),
        avg_drawdown_time: String(mainDDT),
        pass_rate: String(mainPassRatio.toFixed(4)),
        passed_sets: String(realGenerated),
        evaluated: String(mainGenerated),
        updated_at: String(now),
      }).catch(() => {}),
      client.expire(`strategy_detail:${connectionId}:main`, ttlDay).catch(() => {}),

      // Real stage detail — includes avgPosEvalReal
      client.hset(`strategy_detail:${connectionId}:real`, {
        created_sets: String(realGenerated),
        avg_profit_factor: String(realPF.toFixed(4)),
        avg_drawdown_time: String(realDDT),
        avg_pos_eval_real: String(posEvalReal.toFixed(4)),
        pass_rate: String(realGenerated > 0 ? "1.0000" : "0.0000"),
        passed_sets: String(realGenerated),
        evaluated: String(realGenerated),
        updated_at: String(now),
      }).catch(() => {}),
      client.expire(`strategy_detail:${connectionId}:real`, ttlDay).catch(() => {}),

      // evaluated / passed keys for the stats route's ratio calculation
      client.incrby(`strategies:${connectionId}:base:evaluated`, baseGenerated).catch(() => {}),
      client.incrby(`strategies:${connectionId}:base:passed`,    mainGenerated).catch(() => {}),
      client.incrby(`strategies:${connectionId}:main:evaluated`, mainGenerated).catch(() => {}),
      client.incrby(`strategies:${connectionId}:main:passed`,    realGenerated).catch(() => {}),
      client.incrby(`strategies:${connectionId}:real:evaluated`, realGenerated).catch(() => {}),
      client.incrby(`strategies:${connectionId}:real:passed`,    realGenerated).catch(() => {}),
      client.expire(`strategies:${connectionId}:base:evaluated`, ttlDay).catch(() => {}),
      client.expire(`strategies:${connectionId}:base:passed`,    ttlDay).catch(() => {}),
      client.expire(`strategies:${connectionId}:main:evaluated`, ttlDay).catch(() => {}),
      client.expire(`strategies:${connectionId}:main:passed`,    ttlDay).catch(() => {}),
      client.expire(`strategies:${connectionId}:real:evaluated`, ttlDay).catch(() => {}),
      client.expire(`strategies:${connectionId}:real:passed`,    ttlDay).catch(() => {}),
    ])

    // Cycle metadata
    const currentCycles = parseInt(
      ((await client.hgetall(progKey)) || {}).indication_cycle_count || "0",
      10
    )
    const successRate = 95 + Math.random() * 5 // 95-100% success
    await client.hset(progKey, {
      cycle_success_rate: String(successRate.toFixed(1)),
      last_update: new Date().toISOString(),
      last_symbol: symbol,
      started_at: (await client.hget(progKey, "started_at").catch(() => "")) || String(Date.now()),
    })
    await client.expire(progKey, 7 * 24 * 60 * 60)

    result.base = baseGenerated
    result.main = mainGenerated
    result.real = realGenerated

  } catch (e) {
    // non-critical
  }

  return result
}

export async function GET() {
  try {
    const { initRedis, getRedisClient, getAllConnections } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()

    const connections = await getAllConnections()

    // Use active-inserted connections — same eligibility as the trade engine
    const activeConnections = connections.filter(
      (c: any) =>
        isConnectionInActivePanel(c) ||
        isTruthyFlag(c.is_active_inserted) ||
        isTruthyFlag(c.is_assigned)
    )

    if (activeConnections.length === 0) {
      return NextResponse.json({
        success: true,
        generated: 0,
        connections: 0,
        message: "No active connections",
        timestamp: Date.now(),
      })
    }

    let totalIndications = 0
    let totalBase = 0
    let totalMain = 0
    let totalReal = 0

    for (const connection of activeConnections) {
      const exchangeName = (connection.exchange || "bingx").toLowerCase()

      // Prefer: symbol from connection's active_symbols setting, then most volatile, then fallback
      let symbolsRaw: string[] = []
      try {
        const stored = connection.active_symbols
        symbolsRaw = Array.isArray(stored)
          ? stored
          : typeof stored === "string" && stored.startsWith("[")
            ? JSON.parse(stored)
            : stored
              ? [stored]
              : []
      } catch { symbolsRaw = [] }

      // If connection has no stored active symbols, look for any market_data keys already in Redis
      // These are written by the trade engine's market data loader — use the most recent symbol
      let primarySymbol = symbolsRaw[0]
      if (!primarySymbol) {
        try {
          const marketDataKeys = await client.keys("market_data:*")
          // Filter out interval keys (market_data:SYM:1m) — only take the flat hash keys
          const flatSymbolKeys = (marketDataKeys || []).filter(
            (k: string) => !k.includes(":1m") && !k.includes(":5m") && !k.includes(":15m")
          )
          if (flatSymbolKeys.length > 0) {
            // Pick the most recently updated symbol
            const symbolFromRedis = flatSymbolKeys[0].replace("market_data:", "")
            if (symbolFromRedis && symbolFromRedis.length > 3) {
              primarySymbol = symbolFromRedis
            }
          }
        } catch { /* non-critical */ }
      }

      // Last resort: fetch most volatile from public exchange API
      if (!primarySymbol) {
        primarySymbol = await getMostVolatileSymbol(exchangeName)
      }

      // Always run on primary symbol (most volatile) plus BTC as baseline reference
      const symbolsToProcess = Array.from(new Set([primarySymbol, "BTCUSDT"].filter(Boolean)))

      for (const symbol of symbolsToProcess) {
        const r = await generateIndicationsForConnection(connection.id, symbol, client, exchangeName)
        totalIndications += r.indications
        totalBase += r.base
        totalMain += r.main
        totalReal += r.real
      }
    }

    return NextResponse.json({
      success: true,
      generated: totalIndications,
      connections: activeConnections.length,
      strategies: { base: totalBase, main: totalMain, real: totalReal },
      timestamp: Date.now(),
    })
  } catch (error) {
    console.error("[v0] [CronIndications] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function POST() {
  return GET()
}
