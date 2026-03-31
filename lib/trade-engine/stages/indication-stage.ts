// Stage 1: Indication Processor
// Independent calculation of technical analysis signals (RSI, MACD, EMA, etc.)
// Output: Indication signals at specific timestamps

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { ExchangeConnection } from "@/lib/types"

const LOG_PREFIX = "[v0] [IndicationStage]"

export interface IndicationSignal {
  connectionId: string
  connectionName: string
  symbol: string
  timeframe: string
  timestamp: number
  indicators: {
    rsi?: number
    macd?: { macd: number; signal: number; histogram: number }
    ema?: { ema20: number; ema50: number; ema200: number }
    bb?: { upper: number; middle: number; lower: number }
  }
  signal: "buy" | "sell" | "neutral"
  strength: number // 0-1, confidence level
  price: number
}

/**
 * Process market data and generate indication signals
 * Independent of position states - purely technical analysis
 */
export async function processIndications(
  connection: ExchangeConnection,
  symbol: string,
  ohlcData: any[]
): Promise<IndicationSignal[]> {
  await initRedis()
  const client = getRedisClient()
  const signals: IndicationSignal[] = []

  console.log(`${LOG_PREFIX} Processing indications for ${symbol} (${connection.name})`)

  try {
    // Process each timeframe independently
    const timeframes = ["1m", "5m", "15m", "1h", "4h"]

    for (const timeframe of timeframes) {
      // Calculate indicators for timeframe
      const rsi = calculateRSI(ohlcData, 14)
      const macd = calculateMACD(ohlcData)
      const ema = calculateEMA(ohlcData)
      const bb = calculateBollingerBands(ohlcData)

      // Generate signal based on indicators
      const signal = generateSignal({ rsi, macd, ema, bb })

      const indication: IndicationSignal = {
        connectionId: connection.id || connection.name,
        connectionName: connection.name,
        symbol,
        timeframe,
        timestamp: Date.now(),
        indicators: { rsi, macd, ema, bb },
        signal: signal.type,
        strength: signal.strength,
        price: ohlcData[ohlcData.length - 1]?.close || 0,
      }

      signals.push(indication)

      // Store indication
      const indicationKey = `indication:${connection.id}:${symbol}:${timeframe}`
      await client.setex(indicationKey, 86400, JSON.stringify(indication))

      // Disabled per-signal logging - only log on errors to avoid excessive Redis key growth
    }

    return signals
  } catch (err) {
    console.error(`${LOG_PREFIX} Error processing indications: ${err}`)
    throw err
  }
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(data: any[], period: number = 14): number {
  if (data.length < period + 1) return 50 // Default neutral

  let gains = 0
  let losses = 0

  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close
    if (change > 0) gains += change
    else losses += Math.abs(change)
  }

  const avgGain = gains / period
  const avgLoss = losses / period
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
  const rsi = 100 - 100 / (1 + rs)

  return Math.round(rsi * 100) / 100
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(
  data: any[]
): { macd: number; signal: number; histogram: number } | undefined {
  if (data.length < 26) return undefined

  const closes = data.map((d: any) => d.close)
  const ema12 = calculateEMAValues(closes, 12)
  const ema26 = calculateEMAValues(closes, 26)

  const macd = ema12[ema12.length - 1] - ema26[ema26.length - 1]
  const signalLine = calculateEMAValues([macd], 9)[0]
  const histogram = macd - signalLine

  return {
    macd: Math.round(macd * 1000) / 1000,
    signal: Math.round(signalLine * 1000) / 1000,
    histogram: Math.round(histogram * 1000) / 1000,
  }
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(data: any[]): { ema20: number; ema50: number; ema200: number } | undefined {
  if (data.length < 200) return undefined

  const closes = data.map((d: any) => d.close)
  const ema20 = calculateEMAValues(closes, 20)[closes.length - 1]
  const ema50 = calculateEMAValues(closes, 50)[closes.length - 1]
  const ema200 = calculateEMAValues(closes, 200)[closes.length - 1]

  return {
    ema20: Math.round(ema20 * 100) / 100,
    ema50: Math.round(ema50 * 100) / 100,
    ema200: Math.round(ema200 * 100) / 100,
  }
}

/**
 * Helper: Calculate EMA values
 */
function calculateEMAValues(data: number[], period: number): number[] {
  const k = 2 / (period + 1)
  let ema = data[0]
  const emaValues = [ema]

  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k)
    emaValues.push(ema)
  }

  return emaValues
}

/**
 * Calculate Bollinger Bands
 */
function calculateBollingerBands(
  data: any[]
): { upper: number; middle: number; lower: number } | undefined {
  if (data.length < 20) return undefined

  const closes = data.slice(-20).map((d: any) => d.close)
  const middle = closes.reduce((a, b) => a + b) / closes.length
  const variance = closes.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / closes.length
  const stdDev = Math.sqrt(variance)

  return {
    upper: Math.round((middle + 2 * stdDev) * 100) / 100,
    middle: Math.round(middle * 100) / 100,
    lower: Math.round((middle - 2 * stdDev) * 100) / 100,
  }
}

/**
 * Generate buy/sell signal from indicators
 */
function generateSignal(indicators: {
  rsi?: number
  macd?: { macd: number; signal: number; histogram: number }
  ema?: { ema20: number; ema50: number; ema200: number }
  bb?: { upper: number; middle: number; lower: number }
}): { type: "buy" | "sell" | "neutral"; strength: number } {
  let buyScore = 0
  let sellScore = 0
  const maxScore = 4 // Max 4 indicators

  // RSI signals
  if (indicators.rsi !== undefined) {
    if (indicators.rsi < 30) buyScore += 1
    if (indicators.rsi > 70) sellScore += 1
  }

  // MACD signals
  if (indicators.macd) {
    if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal)
      buyScore += 1
    if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal)
      sellScore += 1
  }

  // EMA signals
  if (indicators.ema) {
    if (indicators.ema.ema20 > indicators.ema.ema50 && indicators.ema.ema50 > indicators.ema.ema200)
      buyScore += 1
    if (indicators.ema.ema20 < indicators.ema.ema50 && indicators.ema.ema50 < indicators.ema.ema200)
      sellScore += 1
  }

  // Bollinger Bands signals
  if (indicators.bb) {
    // Price at lower band = oversold = buy
    if (Math.abs(indicators.bb.lower - (indicators.bb.middle - 1)) < 0.1) buyScore += 1
    // Price at upper band = overbought = sell
    if (Math.abs(indicators.bb.upper - (indicators.bb.middle + 1)) < 0.1) sellScore += 1
  }

  const strength = Math.max(buyScore, sellScore) / maxScore

  if (buyScore > sellScore) {
    return { type: "buy", strength }
  } else if (sellScore > buyScore) {
    return { type: "sell", strength }
  } else {
    return { type: "neutral", strength: 0 }
  }
}

/**
 * Get current indications for connection
 */
export async function getCurrentIndications(
  connectionId: string
): Promise<IndicationSignal[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const keys = await client.keys(`indication:${connectionId}:*`)
    const indications: IndicationSignal[] = []

    for (const key of keys) {
      const data = await client.get(key)
      if (data) {
        indications.push(JSON.parse(data))
      }
    }

    return indications
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting indications: ${err}`)
    return []
  }
}
