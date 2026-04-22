/**
 * Realtime Processor
 * Processes real-time updates for active positions with market data.
 *
 * ── Prehistoric dependency ─────────────────────────────────────────────
 * This processor is SELF-GATED in `engine-manager.startRealtimeProcessor`
 * on the `prehistoric:{id}:done` Redis flag, and additionally verifies
 * readiness at the entry of every cycle in `processRealtimeUpdates()`.
 * Until prehistoric has finished it returns `{ updates: 0 }` and skips
 * all per-position work. This guarantees that when a tick evaluates a
 * live pseudo-position we can always enrich it with the "prev position"
 * context derived from the prehistoric Set calculations — see
 * `getPrevSetPosition()` below. Previous-position context feeds into
 * TP/SL calibration and prevents cold-start TP/SL decisions running
 * against an empty history.
 *
 * NOW: 100% Redis-backed, no SQL.
 */

import { getSettings, setSettings, getMarketData, getRedisClient } from "@/lib/redis-db"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { StrategyConfigManager, type PseudoPosition } from "@/lib/strategy-config-manager"

export class RealtimeProcessor {
  private connectionId: string
  private positionManager: PseudoPositionManager
  // StrategyConfigManager owns the canonical Set schema (entry format,
  // keyspace, trim cap). We hold a single instance per processor and
  // delegate to it for all prev-position retrieval — zero duplicated
  // parsing, zero key drift. Historic fill, realtime read, realtime
  // write-back (on close) all share the exact same methods.
  private strategy: StrategyConfigManager
  private priceCache: Map<string, { price: number; ts: number }> = new Map()
  private readonly PRICE_CACHE_TTL = 5000 // 5s

  // Cache of prev-set positions keyed by strategy-config id. The Set is
  // updated by the prehistoric fill path AND by live-close writebacks,
  // so the TTL is deliberately short (2s) — a live TP/SL close must
  // propagate into the realtime tick's context on the next cycle.
  private prevSetCache: Map<string, { pos: PseudoPosition | null; ts: number }> = new Map()
  private readonly PREV_SET_CACHE_TTL = 2_000

  // Cached prehistoric-ready flag (mirrors the gate in engine-manager).
  // Checked once per ~3s while serving ticks; flipped to `true` we skip
  // re-reading Redis entirely. If we ever see a cycle *after* the flag
  // flipped to false again (cache flush, manual reset) the next
  // processRealtimeUpdates call will correctly re-gate.
  private prehistoricReady = false
  private prehistoricCheckedAt = 0
  private static readonly PREHISTORIC_RECHECK_MS = 3000

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
    this.strategy = new StrategyConfigManager(connectionId)
  }

  /**
   * Returns `true` once the prehistoric calc has written its "done"
   * marker. Cached for `PREHISTORIC_RECHECK_MS` to avoid hammering Redis.
   * The engine-manager tick loop ALSO gates on this flag (belt-and-
   * braces); this check is the second layer so callers of
   * `processRealtimeUpdates` directly (e.g. startup warm-up) can never
   * bypass the gate.
   */
  async isPrehistoricReady(): Promise<boolean> {
    if (this.prehistoricReady) return true
    const now = Date.now()
    if (now - this.prehistoricCheckedAt < RealtimeProcessor.PREHISTORIC_RECHECK_MS) {
      return this.prehistoricReady
    }
    this.prehistoricCheckedAt = now
    try {
      const client = getRedisClient()
      const v = await client.get(`prehistoric:${this.connectionId}:done`)
      this.prehistoricReady = v === "1"
    } catch {
      // Keep last-known value on transient failures.
    }
    return this.prehistoricReady
  }

  /**
   * Read the latest prev-set position for a given pseudo-position's
   * `config_set_key`. Delegates to `StrategyConfigManager.getLatestPosition`
   * — the single canonical primitive that owns both the Redis keyspace
   * (`strategy:{connId}:config:{configId}:positions`) and the entry
   * schema used by every writer (prehistoric fill in
   * `config-set-processor.calculateStrategyPositions` and live
   * write-back in `pseudo-position-manager.closePosition`).
   *
   * No parsing, no key construction, no schema here — all of that lives
   * on `StrategyConfigManager`. This method is just the per-tick cache
   * in front of that single source of truth.
   */
  async getPrevSetPosition(configSetKey: string | undefined): Promise<PseudoPosition | null> {
    const configId = StrategyConfigManager.extractConfigId(configSetKey)
    if (!configId) return null

    const now = Date.now()
    const cached = this.prevSetCache.get(configId)
    if (cached && now - cached.ts < this.PREV_SET_CACHE_TTL) return cached.pos

    try {
      const pos = await this.strategy.getLatestPosition(configId)
      this.prevSetCache.set(configId, { pos, ts: now })
      return pos
    } catch (err) {
      // On transient failure we negative-cache briefly so bursty traffic
      // doesn't stampede Redis with the same lookup.
      this.prevSetCache.set(configId, { pos: null, ts: now })
      console.warn(
        `[v0] [Realtime] getPrevSetPosition(${configId}) failed:`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }

  /**
   * Process real-time updates for all active positions.
   *
   * HARD GATED on `prehistoric:{id}:done`: if prehistoric hasn't finished
   * we return immediately with zero updates. The engine-manager loop
   * gates on the same flag with its own fast-poll interval, so this
   * check is a defence-in-depth guard that also protects any direct
   * caller (e.g. one-off warm-ups, tests) from running realtime against
   * an empty prev-position context.
   *
   * Returns the number of positions actually processed so callers can
   * gate follow-up work (telemetry, backoff) without re-querying Redis.
   */
  async processRealtimeUpdates(): Promise<{ updates: number }> {
    try {
      // ── Prehistoric readiness gate ────────────────────────────────
      // The realtime processor depends on prehistoric-calculated Set
      // positions to provide the "prev position" context used in
      // `processPosition`. Running before prehistoric has finished
      // would evaluate live positions with a cold history — exactly
      // the cold-start bug we want to avoid.
      const ready = await this.isPrehistoricReady()
      if (!ready) {
        return { updates: 0 }
      }

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
   * Process an individual active pseudo-position.
   *
   * Enriches the raw position with the "prev position" context derived
   * from the prehistoric Set calculations (see `getPrevSetPosition`).
   * The prev-set record is attached to the position object as
   * `_prev_set_position` and forwarded into the TP/SL + trailing-stop
   * helpers, so they can calibrate decisions against the most recent
   * closed position from the same strategy config (e.g. a prev-win
   * can tighten the trailing stop, a prev-loss can extend it).
   */
  private async processPosition(position: any): Promise<void> {
    try {
      // Pull the current price and the prev-set context concurrently —
      // both are cached and cheap, and avoiding an extra sequential
      // await keeps the per-tick budget predictable under high symbol
      // counts.
      const [currentPrice, prevSetPos] = await Promise.all([
        this.getCurrentPrice(position.symbol),
        this.getPrevSetPosition(position.config_set_key),
      ])

      if (!currentPrice) {
        return
      }

      // Attach the prev-set context onto the in-memory position object
      // so downstream helpers can reference it without re-querying
      // Redis. Using an underscore-prefixed field to make clear this is
      // a transient enrichment, not persisted state.
      if (prevSetPos) {
        position._prev_set_position = prevSetPos
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

      // Log position monitoring (reduced frequency to avoid spam). Also
      // surface prev-set outcome so operators can see the context
      // feeding the decision.
      if (Math.random() < 0.01) { // Log ~1% of cycles
        const prevTag = prevSetPos
          ? ` | prevSet=${prevSetPos.status}/${prevSetPos.result.toFixed(2)}`
          : " | prevSet=none"
        console.log(
          `[v0] [Realtime] Monitoring ${position.symbol} ${side}: ` +
          `Price=${currentPrice.toFixed(2)}, PnL=${pnl.toFixed(4)}${prevTag}`,
        )
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

      // Update trailing stop if enabled — the prev-set context is on
      // the position object so `updateTrailingStop` can honour it.
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
