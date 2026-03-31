/**
 * Market Data Stream
 * Handles real-time market data streaming and processing
 */

import { sql } from "@/lib/db"
import { WebSocketManager } from "./websocket-manager"

export interface MarketDataUpdate {
  symbol: string
  price: number
  volume: number
  timestamp: Date
  high?: number
  low?: number
  open?: number
  close?: number
}

export class MarketDataStream {
  private wsManager: WebSocketManager
  private connectionId: string
  private activeSymbols: Set<string> = new Set()
  private dataBuffer: Map<string, MarketDataUpdate[]> = new Map()
  private flushInterval: NodeJS.Timeout | null = null
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map()
  private readonly PRICE_CACHE_TTL_MS = 500 // 500ms cache for prices

  constructor(connectionId: string, wsUrl: string) {
    this.connectionId = connectionId
    this.wsManager = new WebSocketManager({ url: wsUrl })

    // Subscribe to market data updates
    this.wsManager.subscribe("market_data", this.handleMarketData.bind(this))
  }

  /**
   * Start streaming for symbols
   */
  async start(symbols: string[]): Promise<void> {
    try {
      await this.wsManager.connect()

      // Subscribe to each symbol
      for (const symbol of symbols) {
        this.subscribeToSymbol(symbol)
      }

      // Start periodic flush to database
      this.startFlushInterval()

      console.log(`[v0] Market data stream started for ${symbols.length} symbols`)
    } catch (error) {
      console.error("[v0] Failed to start market data stream:", error)
      throw error
    }
  }

  /**
   * Stop streaming
   */
  stop(): void {
    this.wsManager.disconnect()
    this.stopFlushInterval()
    this.activeSymbols.clear()
    console.log("[v0] Market data stream stopped")
  }

  /**
   * Subscribe to symbol
   */
  private subscribeToSymbol(symbol: string): void {
    this.activeSymbols.add(symbol)
    this.wsManager.send({
      type: "subscribe",
      channel: "market_data",
      symbol,
    })
  }

  /**
   * Unsubscribe from symbol
   */
  unsubscribeFromSymbol(symbol: string): void {
    this.activeSymbols.delete(symbol)
    this.wsManager.send({
      type: "unsubscribe",
      channel: "market_data",
      symbol,
    })
  }

  /**
   * Handle incoming market data
   */
  private handleMarketData(data: any): void {
    try {
      const update: MarketDataUpdate = {
        symbol: data.symbol,
        price: data.price || data.close,
        volume: data.volume,
        timestamp: new Date(data.timestamp),
        high: data.high,
        low: data.low,
        open: data.open,
        close: data.close,
      }

      // Add to buffer
      if (!this.dataBuffer.has(update.symbol)) {
        this.dataBuffer.set(update.symbol, [])
      }
      this.dataBuffer.get(update.symbol)!.push(update)

      this.priceCache.set(update.symbol, {
        price: update.price,
        timestamp: Date.now(),
      })

      // Emit event for real-time processing
      this.emitUpdate(update)
    } catch (error) {
      console.error("[v0] Failed to handle market data:", error)
    }
  }

  /**
   * Emit update to listeners
   */
  private emitUpdate(update: MarketDataUpdate): void {
    // Disabled logging - runs on every data update causing excessive Redis key growth
    // Only log errors if needed
  }

  /**
   * Start periodic flush to database
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flushToDatabase()
    }, 5000) // Flush every 5 seconds
  }

  /**
   * Stop flush interval
   */
  private stopFlushInterval(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
  }

  /**
   * Flush buffered data to database
   */
  private async flushToDatabase(): Promise<void> {
    if (this.dataBuffer.size === 0) return

    try {
      for (const [symbol, updates] of this.dataBuffer.entries()) {
        if (updates.length === 0) continue

        // Get trading pair ID
        const [tradingPair] = await sql`
          SELECT id FROM trading_pairs WHERE symbol = ${symbol} LIMIT 1
        `

        if (!tradingPair) continue

        // Insert all updates
        for (const update of updates) {
          await sql`
            INSERT INTO market_data (
              trading_pair_id, timestamp, open, high, low, close, volume
            )
            VALUES (
              ${tradingPair.id}, ${update.timestamp.toISOString()},
              ${update.open || update.price}, ${update.high || update.price},
              ${update.low || update.price}, ${update.close || update.price},
              ${update.volume}
            )
            ON CONFLICT (trading_pair_id, timestamp) DO UPDATE
            SET close = EXCLUDED.close, volume = EXCLUDED.volume
          `
        }

        console.log(`[v0] Flushed ${updates.length} market data updates for ${symbol}`)
      }

      // Clear buffer
      this.dataBuffer.clear()
    } catch (error) {
      console.error("[v0] Failed to flush market data to database:", error)
    }
  }

  /**
   * Get latest price for symbol
   */
  getLatestPrice(symbol: string): number | null {
    const cached = this.priceCache.get(symbol)
    if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL_MS) {
      return cached.price
    }

    // Fallback to buffer
    const updates = this.dataBuffer.get(symbol)
    if (!updates || updates.length === 0) return null
    return updates[updates.length - 1].price
  }

  /**
   * Get connection status
   */
  getStatus(): string {
    return this.wsManager.getStatus()
  }
}
