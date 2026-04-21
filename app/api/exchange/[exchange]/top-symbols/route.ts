import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

// In-memory cache — volatile symbols don't change rapidly, 60s TTL is fine
const cache = new Map<string, { symbol: string; priceChangePercent: number; timestamp: number }>()
const CACHE_TTL = 60_000

// Fallback symbols if exchange API is unreachable
const FALLBACK: Record<string, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  bingx: "BTCUSDT",
  okx: "BTCUSDT",
  pionex: "BTCUSDT",
  orangex: "BTCUSDT",
}

async function fetchMostVolatileSymbols(
  exchange: string,
  limit = 1,
): Promise<{ symbol: string; priceChangePercent: number; symbols: { symbol: string; priceChangePercent: number }[] }> {
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit) || 1))
  // Cache only keeps the single top symbol — for limit > 1 we always fetch fresh
  // (still cheap: one public REST call with 5s timeout) and return the sorted list.
  if (safeLimit === 1) {
    const cached = cache.get(exchange)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return {
        symbol: cached.symbol,
        priceChangePercent: cached.priceChangePercent,
        symbols: [{ symbol: cached.symbol, priceChangePercent: cached.priceChangePercent }],
      }
    }
  }

  let tickers: { symbol: string; priceChangePercent: number }[] = []

  try {
    if (exchange === "binance") {
      // Binance public 24hr ticker — no auth required
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`)
      const data: any[] = await res.json()
      // Filter USDT perpetual-style pairs, >$1M volume, exclude stables
      tickers = data
        .filter(t =>
          t.symbol.endsWith("USDT") &&
          !t.symbol.includes("DOWN") &&
          !t.symbol.includes("UP") &&
          !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
          parseFloat(t.quoteVolume) > 1_000_000
        )
        .map(t => ({
          symbol: t.symbol,
          priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
        }))

    } else if (exchange === "bybit") {
      // Bybit blocks some IPs (403) - silently fallback to Binance data for USDT pairs
      // v2.0 - Removed all error throwing to prevent log spam
      try {
        const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
          headers: { 
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)",
          },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          // Bybit often returns 403 for serverless IPs - use Binance as proxy for USDT pairs (silent fallback)
          const binanceRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(5000),
          })
          if (binanceRes.ok) {
            const binanceData: any[] = await binanceRes.json()
            tickers = binanceData
              .filter(t =>
                t.symbol.endsWith("USDT") &&
                !t.symbol.includes("DOWN") &&
                !t.symbol.includes("UP") &&
                !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
                parseFloat(t.quoteVolume) > 1_000_000
              )
              .map(t => ({
                symbol: t.symbol,
                priceChangePercent: Math.abs(parseFloat(t.priceChangePercent)),
              }))
          }
        } else {
          const data = await res.json()
          tickers = (data?.result?.list || [])
            .filter((t: any) =>
              t.symbol.endsWith("USDT") &&
              parseFloat(t.turnover24h) > 1_000_000
            )
            .map((t: any) => ({
              symbol: t.symbol,
              priceChangePercent: Math.abs(parseFloat(t.price24hPcnt || "0") * 100),
            }))
        }
      } catch (bybitErr) {
        console.warn(`[TopSymbols] Bybit API error, using default:`, bybitErr instanceof Error ? bybitErr.message : bybitErr)
      }

    } else if (exchange === "bingx") {
      const res = await fetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`BingX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.symbol?.endsWith("-USDT") &&
          parseFloat(t.volume) > 100_000
        )
        .map((t: any) => ({
          symbol: (t.symbol as string).replace("-", ""),
          priceChangePercent: Math.abs(parseFloat(t.priceChangePercent || "0")),
        }))

    } else if (exchange === "okx") {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`OKX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.instId?.endsWith("USDT-SWAP") &&
          parseFloat(t.volCcy24h) > 1_000_000
        )
        .map((t: any) => ({
          symbol: (t.instId as string).replace("-SWAP", "").replace("-", ""),
          priceChangePercent: Math.abs(parseFloat(t.sodUtc8 || "0")),
        }))
    }
  } catch {
    // Silently handle - will use fallback below
  }

  if (tickers.length === 0) {
    // Fallback: return known safe default
    const fallback = FALLBACK[exchange] || "BTCUSDT"
    return { symbol: fallback, priceChangePercent: 0, symbols: [{ symbol: fallback, priceChangePercent: 0 }] }
  }

  // Sort by absolute price change % descending — highest volatility first
  tickers.sort((a, b) => b.priceChangePercent - a.priceChangePercent)

  // De-duplicate (guards against any exchange returning the same symbol twice)
  const seen = new Set<string>()
  const unique = tickers.filter(t => {
    if (seen.has(t.symbol)) return false
    seen.add(t.symbol)
    return true
  })

  const topN = unique.slice(0, safeLimit)
  const top = topN[0]
  cache.set(exchange, { symbol: top.symbol, priceChangePercent: top.priceChangePercent, timestamp: Date.now() })

  return { symbol: top.symbol, priceChangePercent: top.priceChangePercent, symbols: topN }
}

/**
 * GET /api/exchange/[exchange]/top-symbols?limit=N
 * Returns the top N most volatile symbols on the exchange (by 24h price change %).
 * - limit defaults to 1 and is clamped to [1,10]
 * - `symbol` keeps the top-1 for backward-compatibility with existing callers
 * - `symbols` is now a sorted list of objects: [{ symbol, priceChangePercent }, ...]
 *   (older callers using `symbols: [string]` should switch to `symbol` or read `.symbol`).
 * Uses public exchange REST APIs — no auth required.
 */
export async function GET(request: Request, { params }: { params: Promise<{ exchange: string }> }) {
  try {
    const { exchange } = await params
    const normalised = (exchange || "").toLowerCase()

    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "1", 10) || 1

    const { symbol, priceChangePercent, symbols } = await fetchMostVolatileSymbols(normalised, limit)

    return NextResponse.json({
      success: true,
      exchange: normalised,
      symbol,
      priceChangePercent,
      symbols,                             // [{ symbol, priceChangePercent }]
      symbolList: symbols.map(s => s.symbol), // plain string[] for convenience
      count: symbols.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[v0] [TopSymbols] Fatal error:`, error)
    return NextResponse.json(
      { error: "Failed to retrieve top symbols", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
