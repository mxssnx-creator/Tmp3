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

  // Heartbeat throttling: the realtime loop ticks multiple times per second.
  // Previously every tick performed a getSettings + setSettings round-trip on
  // trade_engine_state just to refresh `last_realtime_run` / the position
  // count. That was ~10+ Redis hits per second per engine with zero
  // behavioural value. We now throttle the engine-state heartbeat to once per
  // second and only re-read the full state hash when the position count
  // actually changed.
  private lastHeartbeatAt = 0
  private lastPositionsCount = -1
  private static readonly HEARTBEAT_INTERVAL_MS = 1000

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.positionManager = new PseudoPositionManager(connectionId)
  }

  /**
   * Process real-time updates for all active positions.
   * Returns the number of positions actually processed so callers can gate
   * follow-up work (telemetry, backoff) without re-querying Redis.
   */
  async processRealtimeUpdates(): Promise<{ updates: number }> {
    try {
      const activePositions = await this.positionManager.getActivePositions()
      const count = activePositions.length
      const now = Date.now()

      // Write the lightweight heartbeat at most once per second, and skip the
      // preceding getSettings() unless the position count changed (which is
      // when we need to merge with the persisted state hash).
      const countChanged = count !== this.lastPositionsCount
      const heartbeatDue = now - this.lastHeartbeatAt >= RealtimeProcessor.HEARTBEAT_INTERVAL_MS

      if (countChanged || heartbeatDue) {
        const stateKey = `trade_engine_state:${this.connectionId}`
        try {
          if (countChanged) {
            // Only re-fetch the state hash when we actually need to merge a
            // new count. The heartbeat-only path uses hset to touch two
            // fields without read-modify-write.
            const engineState = (await getSettings(stateKey)) || {}
            await setSettings(stateKey, {
              ...engineState,
              active_positions_count: count,
              last_realtime_run: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              realtime_processor_active: true,
            })
          } else {
            const client = getRedisClient()
            await client.hset(stateKey, {
              last_realtime_run: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              realtime_processor_active: "true",
            })
          }
          this.lastPositionsCount = count
          this.lastHeartbeatAt = now
        } catch (hbErr) {
          // Heartbeat failures are non-critical — don't abort the cycle.
          console.warn("[v0] [Realtime] Heartbeat write failed:", hbErr instanceof Error ? hbErr.message : String(hbErr))
        }
      }

      if (count === 0) {
        return { updates: 0 }
      }

      // Pre-warm the price cache for every unique symbol in parallel before
      // fanning out the per-position work. Previously every position paid
      // its own `getMarketData` round-trip on the first cycle after the
      // TTL expired (even though most positions share a symbol). Fetching
      // the distinct set first collapses those N reads into M << N.
      const uniqueSymbols = new Set<string>()
      for (const p of activePositions) {
        if (p?.symbol) uniqueSymbols.add(p.symbol)
      }
      if (uniqueSymbols.size > 0) {
        await Promise.all(
          Array.from(uniqueSymbols).map((sym) => this.getCurrentPrice(sym).catch(() => null)),
        )
      }

      // Process each position in parallel — every call now hits the
      // freshly-warmed price cache synchronously.
      await Promise.all(activePositions.map((position) => this.processPosition(position)))
      return { updates: count }
    } catch (error) {
      console.error("[v0] Failed to process realtime updates:", error)
      await logProgressionEvent(this.connectionId, "realtime_error", "error", "Realtime processor failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return { updates: 0 }
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
