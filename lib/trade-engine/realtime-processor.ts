/**
 * Realtime Processor
 * Processes real-time updates for active positions with market data
 * NOW: 100% Redis-backed, no SQL
 */

import { getSettings, setSettings, getMarketData, getRedisClient } from "@/lib/redis-db"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export class RealtimeProcessor {
  private connectionId: string
  private positionManager: PseudoPositionManager
  private priceCache: Map<string, { price: number; ts: number }> = new Map()
  private readonly PRICE_CACHE_TTL = 5000 // 5s

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.positionManager = new PseudoPositionManager(connectionId)
  }

  /**
   * Process real-time updates for all active positions
   */
  async processRealtimeUpdates(): Promise<void> {
    try {
      const activePositions = await this.positionManager.getActivePositions()

      // Always update engine state, even with 0 positions (shows processor is running)
      const stateKey = `trade_engine_state:${this.connectionId}`
      const engineState = (await getSettings(stateKey)) || {}
      await setSettings(stateKey, {
        ...engineState,
        active_positions_count: activePositions.length,
        last_realtime_run: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        realtime_processor_active: true,
      })

      if (activePositions.length === 0) {
        return
      }

      // Process each position in parallel
      await Promise.all(activePositions.map((position) => this.processPosition(position)))
    } catch (error) {
      console.error("[v0] Failed to process realtime updates:", error)
      await logProgressionEvent(this.connectionId, "realtime_error", "error", "Realtime processor failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Process individual position
   */
  private async processPosition(position: any): Promise<void> {
    try {
      const currentPrice = await this.getCurrentPrice(position.symbol)

      if (!currentPrice) {
        return
      }

      // Update position with current price
      await this.positionManager.updatePosition(position.id, currentPrice)

      // Calculate profit/loss
      const entryPrice = parseFloat(position.entry_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const pnl = side === "long"
        ? (currentPrice - entryPrice) * quantity
        : (entryPrice - currentPrice) * quantity

      // Log position monitoring (reduced frequency to avoid spam)
      if (Math.random() < 0.01) { // Log ~1% of cycles
        console.log(`[v0] [Realtime] Monitoring ${position.symbol} ${side}: Price=${currentPrice.toFixed(2)}, PnL=${pnl.toFixed(4)}`)
      }

      // Check take profit
      if (this.shouldCloseTakeProfit(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "take_profit")
        console.log(`[v0] [Realtime] TP hit for ${position.symbol} ${side} | PnL: ${pnl.toFixed(4)}`)
        return
      }

      // Check stop loss
      if (this.shouldCloseStopLoss(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "stop_loss")
        console.log(`[v0] [Realtime] SL hit for ${position.symbol} ${side} | PnL: ${pnl.toFixed(4)}`)
        return
      }

      // Update trailing stop if enabled
      if (position.trailing_enabled === "1" || position.trailing_enabled === true) {
        await this.updateTrailingStop(position, currentPrice)
      }
    } catch (error) {
      console.error(`[v0] Failed to process position ${position.id}:`, error)
    }
  }

  /**
   * Get current price from Redis market data (cached)
   */
  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const now = Date.now()
      const cached = this.priceCache.get(symbol)
      if (cached && now - cached.ts < this.PRICE_CACHE_TTL) {
        return cached.price
      }

      const marketData = await getMarketData(symbol)
      if (!marketData) return null

      const data = Array.isArray(marketData) ? marketData[0] : marketData
      const price = parseFloat(data?.close || data?.price || "0")

      if (price > 0) {
        this.priceCache.set(symbol, { price, ts: now })
        return price
      }

      return null
    } catch (error) {
      console.error(`[v0] Failed to get current price for ${symbol}:`, error)
      return null
    }
  }

  /**
   * Check if take profit should be triggered
   */
  private shouldCloseTakeProfit(position: any, currentPrice: number): boolean {
    const entryPrice = parseFloat(position.entry_price || "0")
    const takeprofitFactor = parseFloat(position.takeprofit_factor || "0")
    const side = position.side || "long"

    if (side === "long") {
      const takeProfitPrice = entryPrice * (1 + takeprofitFactor / 100)
      return currentPrice >= takeProfitPrice
    } else {
      const takeProfitPrice = entryPrice * (1 - takeprofitFactor / 100)
      return currentPrice <= takeProfitPrice
    }
  }

  /**
   * Check if stop loss should be triggered
   */
  private shouldCloseStopLoss(position: any, currentPrice: number): boolean {
    const entryPrice = parseFloat(position.entry_price || "0")
    const stoplossRatio = parseFloat(position.stoploss_ratio || "0")
    const side = position.side || "long"

    // Check trailing stop first if it exists
    const trailingStopPrice = parseFloat(position.trailing_stop_price || "0")
    if (trailingStopPrice > 0) {
      if (side === "long" && currentPrice <= trailingStopPrice) return true
      if (side === "short" && currentPrice >= trailingStopPrice) return true
    }

    // Check regular stop loss
    if (side === "long") {
      const stopLossPrice = entryPrice * (1 - stoplossRatio / 100)
      return currentPrice <= stopLossPrice
    } else {
      const stopLossPrice = entryPrice * (1 + stoplossRatio / 100)
      return currentPrice >= stopLossPrice
    }
  }

  /**
   * Update trailing stop (Redis-based)
   */
  private async updateTrailingStop(position: any, currentPrice: number): Promise<void> {
    try {
      const entryPrice = parseFloat(position.entry_price || "0")
      const stoplossRatio = parseFloat(position.stoploss_ratio || "0")
      const side = position.side || "long"
      const currentTrailingStop = parseFloat(position.trailing_stop_price || "0")

      const trailingDistance = currentPrice * (stoplossRatio / 100)

      let newTrailingStop: number
      if (side === "long") {
        newTrailingStop = currentPrice - trailingDistance
        // Only move trailing stop UP for longs
        if (newTrailingStop <= currentTrailingStop && currentTrailingStop > 0) return
      } else {
        newTrailingStop = currentPrice + trailingDistance
        // Only move trailing stop DOWN for shorts
        if (newTrailingStop >= currentTrailingStop && currentTrailingStop > 0) return
      }

      // Update via the position manager's update
      const client = getRedisClient()
      await client.hset(`pseudo_position:${this.connectionId}:${position.id}`, {
        trailing_stop_price: String(newTrailingStop),
        updated_at: new Date().toISOString(),
      })
    } catch (error) {
      console.error(`[v0] Failed to update trailing stop for position ${position.id}:`, error)
    }
  }

  /**
   * Get stream status
   */
  getStatus(): string {
    return "redis_polling"
  }

  /**
   * Initialize real-time data stream (placeholder for WebSocket-based streams)
   */
  async initializeStream(): Promise<void> {
    console.log(`[v0] [RealtimeProcessor] Stream initialized for ${this.connectionId} (using Redis polling)`)
  }

  /**
   * Stop real-time data stream
   */
  async stopStream(): Promise<void> {
    console.log(`[v0] [RealtimeProcessor] Stream stopped for ${this.connectionId}`)
  }

  /**
   * Get current stream status
   */
  getStreamStatus(): { active: boolean; type: string; lastUpdate?: number } {
    return {
      active: true,
      type: "redis_polling",
      lastUpdate: Date.now(),
    }
  }
}
