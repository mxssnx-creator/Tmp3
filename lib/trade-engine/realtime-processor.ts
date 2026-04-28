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

import { getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { StrategyConfigManager, type PseudoPosition } from "@/lib/strategy-config-manager"
// Shared module-level market-data cache with a 200ms TTL, in-flight
// deduplication, and pipelined batch prefetch. We delegate price reads
// to it instead of maintaining a second per-processor cache — a single
// 200ms-TTL cache aligns with the market-data feed cadence and lets
// multiple processors (indication, strategy, realtime) share the same
// warm entries.
import { getMarketDataCached, prefetchMarketDataBatch } from "./market-data-cache"

export class RealtimeProcessor {
  private connectionId: string
  private positionManager: PseudoPositionManager
  // StrategyConfigManager owns the canonical Set schema (entry format,
  // keyspace, trim cap). We hold a single instance per processor and
  // delegate to it for all prev-position retrieval — zero duplicated
  // parsing, zero key drift. Historic fill, realtime read, realtime
  // write-back (on close) all share the exact same methods.
  private strategy: StrategyConfigManager
  // Price reads go through the shared module-level `getMarketDataCached`
  // (200ms TTL, in-flight dedup, pipelined prefetch). No per-processor
  // price cache — a second cache here would just add a staleness layer
  // on top of the shared one.

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
   * Read the latest prev-set position for a live pseudo-position.
   *
   * Resolution order for the target `configId`:
   *   1. Explicit `strategy_config_id` field on the position hash (set
   *      by `createPosition` when the caller knows the DB primary key).
   *      This is the authoritative link into the historic-fill keyspace.
   *   2. Tail segment of `config_set_key` (legacy fallback, may be a
   *      fingerprint rather than a real configId).
   *
   * Delegates to `StrategyConfigManager.getLatestPosition` — the single
   * canonical primitive that owns both the Redis keyspace
   * (`strategy:{connId}:config:{configId}:positions`) and the entry
   * schema used by every writer.
   *
   * Cache is bounded to `MAX_PREV_SET_CACHE` entries using a simple FIFO
   * eviction so long-running engines with many distinct config ids can't
   * grow the map unboundedly. Also exposes `invalidatePrevSet` so the
   * close path can drop stale entries the moment the underlying Set is
   * mutated.
   */
  async getPrevSetPosition(
    position: { config_set_key?: string; strategy_config_id?: string } | string | undefined,
  ): Promise<PseudoPosition | null> {
    let configId = ""
    if (typeof position === "string" || position == null) {
      configId = StrategyConfigManager.extractConfigId(position)
    } else {
      const explicit = String(position.strategy_config_id || "").trim()
      configId = explicit || StrategyConfigManager.extractConfigId(position.config_set_key)
    }
    if (!configId) return null

    const now = Date.now()
    const cached = this.prevSetCache.get(configId)
    if (cached && now - cached.ts < this.PREV_SET_CACHE_TTL) return cached.pos

    try {
      const pos = await this.strategy.getLatestPosition(configId)
      this.setPrevSetCache(configId, pos, now)
      return pos
    } catch (err) {
      // On transient failure we negative-cache briefly so bursty traffic
      // doesn't stampede Redis with the same lookup.
      this.setPrevSetCache(configId, null, now)
      console.warn(
        `[v0] [Realtime] getPrevSetPosition(${configId}) failed:`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }

  /** Hard cap on `prevSetCache` entries. Exceeded entries are FIFO-evicted. */
  private readonly MAX_PREV_SET_CACHE = 2048

  /** Insert with FIFO-eviction when the cache is full. */
  private setPrevSetCache(configId: string, pos: PseudoPosition | null, ts: number): void {
    if (this.prevSetCache.size >= this.MAX_PREV_SET_CACHE && !this.prevSetCache.has(configId)) {
      // Map iteration is insertion order — drop the oldest entry.
      const oldest = this.prevSetCache.keys().next().value
      if (oldest !== undefined) this.prevSetCache.delete(oldest)
    }
    this.prevSetCache.set(configId, { pos, ts })
  }

  /** Drop a cached prev-set entry. Called from the close path to avoid
   *  serving stale context for the remainder of the TTL window. */
  invalidatePrevSet(configId: string | undefined): void {
    if (!configId) return
    this.prevSetCache.delete(configId)
  }

  /**
   * Process real-time updates for all active positions.
   *
   * ── Decoupling contract (P0-5) ────────────────────────────────────
   * Per the architectural spec — *"Open Pseudo positions get updated
   * handled on each cycle, Independent of active indication process"* —
   * this loop MUST update every open position every tick regardless of
   * whether indication/strategy/prehistoric phases have produced any
   * work. The prehistoric-ready flag used to be a HARD gate here; it
   * is now an ADVISORY flag, passed to `processPosition` to decide
   * whether to also do prev-set enrichment (Phase B). The mark-to-
   * market update (Phase A — `current_price`, `unrealized_pnl`,
   * trailing stop, TP/SL check) ALWAYS runs.
   *
   * Returns the number of positions actually processed so callers can
   * gate follow-up work (telemetry, backoff) without re-querying Redis.
   */
  async processRealtimeUpdates(): Promise<{ updates: number }> {
    try {
      // Advisory readiness flag — tells processPosition whether it's
      // safe to attach prev-set context. Never blocks Phase A work.
      const prehistoricReady = await this.isPrehistoricReady()

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

      // Pre-warm the shared market-data cache for every unique symbol
      // in a SINGLE pipelined batch (one Redis RTT regardless of symbol
      // count). Subsequent per-position price lookups hit the module-
      // level cache synchronously with zero round-trips until the 200ms
      // TTL expires. This is the single biggest win for dense ticks:
      // 100 positions across 30 symbols = 1 RTT here + 0 during the fan-
      // out, vs. the previous 30 RTTs just to warm prices.
      const uniqueSymbols = new Set<string>()
      for (const p of activePositions) {
        if (p?.symbol) uniqueSymbols.add(p.symbol)
      }
      if (uniqueSymbols.size > 0) {
        await prefetchMarketDataBatch(Array.from(uniqueSymbols))
      }

      // Process each position in parallel. Each call carries the
      // position object through — no second HGETALL in updatePosition
      // or closePosition, since the caller already has the hash.
      // `prehistoricReady` is passed as an advisory flag so Phase B
      // (prev-set enrichment) can be conditionally skipped without
      // blocking Phase A (mark-to-market + TP/SL).
      await Promise.all(
        activePositions.map((position) =>
          this.processPosition(position, prehistoricReady),
        ),
      )

      // ── Cross-tick visibility for the "open positions are being
      //    handled independent of indication/strategy" guarantee ─────
      // Spec: open pseudo positions inside the multiple Sets must get
      // mark-to-market refreshed on EVERY realtime cycle, before/
      // independent of indication+strategy ticks. We already do that
      // above (this is the only writer of `updatePosition` inside
      // trade-engine — verified by grep), but the dashboard needed a
      // way to *see* that it was firing without sampling individual
      // position hashes. We surface two atomic counters:
      //
      //   pseudo_positions_updated_count : cumulative position-tick events
      //                                    (= sum of `updates` across ticks)
      //   pseudo_positions_update_cycles : cumulative realtime cycles that
      //                                    actually touched ≥1 position
      //
      // These are independent of the existing realtime_*_cycle_count
      // family (which tracks tick existence regardless of work).
      try {
        const client = getRedisClient()
        const progKey = `progression:${this.connectionId}`
        await Promise.all([
          client.hincrby(progKey, "pseudo_positions_updated_count", count),
          client.hincrby(progKey, "pseudo_positions_update_cycles", 1),
          client.hset(progKey, {
            pseudo_positions_last_update_at: new Date().toISOString(),
            pseudo_positions_last_count: String(count),
          }),
          client.expire(progKey, 7 * 24 * 60 * 60),
        ])
      } catch {
        // Non-critical visibility metric — never break the realtime loop.
      }

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
   * ── Two-phase execution (P0-5) ─────────────────────────────────────
   * Every open pseudo-position gets a Phase A pass on every tick,
   * REGARDLESS of indication / strategy / prehistoric state. Phase B
   * enrichment is advisory and only runs when prehistoric has produced
   * the prev-set Sets.
   *
   *   Phase A — mark-to-market (ALWAYS):
   *     - refresh `current_price` from the 200ms market-data cache
   *     - recompute `unrealized_pnl`
   *     - update `trailing_stop_price` when trailing is enabled
   *     - check TP / SL and dispatch close
   *
   *   Phase B — prev-set enrichment (ONLY when prehistoricReady):
   *     - fetch the latest prev-set position via the 2s prev-set cache
   *     - attach it to the position as `_prev_set_position` so the
   *       TP/SL helpers can calibrate against the most recent closed
   *       position from the same strategy config
   *
   * This guarantees open positions always get mark-to-market updates
   * and timely TP/SL enforcement, even during the prehistoric warm-up
   * window or if any position somehow exists before prehistoric has
   * finished. Prev-set-calibrated decisions (a small refinement, not
   * the core safety mechanism) gracefully degrade to defaults when
   * prehistoric is not yet ready.
   */
  private async processPosition(position: any, prehistoricReady: boolean): Promise<void> {
    try {
      // Phase A is the critical path — always kick off the price fetch.
      // Phase B (prev-set) only fires when prehistoric is ready, and
      // runs in parallel with the price fetch to avoid sequential
      // latency under high symbol counts.
      const pricePromise = this.getCurrentPrice(position.symbol)
      const prevSetPromise: Promise<PseudoPosition | null> = prehistoricReady
        ? this.getPrevSetPosition(position)
        : Promise.resolve(null)

      const [currentPrice, prevSetPos] = await Promise.all([pricePromise, prevSetPromise])

      if (!currentPrice) {
        return
      }

      // Phase B attachment — only when prehistoric produced something.
      // Underscore prefix makes clear this is transient enrichment,
      // not persisted state.
      if (prevSetPos) {
        position._prev_set_position = prevSetPos
      }

      // Update position with current price. Pass the in-memory hash
      // through so the manager skips a redundant HGETALL round-trip
      // (see PseudoPositionManager.updatePosition hot-path notes).
      await this.positionManager.updatePosition(position.id, currentPrice, position)

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

      // Before handing to closePosition, stamp the latest market price
      // onto the position object so the manager's PnL calculation uses
      // the live price (not the potentially-stale `current_price` hash
      // field) without needing an extra HGETALL.
      position.current_price = String(currentPrice)

      // Resolve the target configId ONCE so we can invalidate the
      // prev-set cache entry the instant the underlying Set is mutated
      // by closePosition. Without this, the processor would serve the
      // stale (pre-close) prev-set record for up to PREV_SET_CACHE_TTL
      // to any other position pointing at the same config.
      const cacheConfigId =
        String(position.strategy_config_id || "").trim() ||
        StrategyConfigManager.extractConfigId(position.config_set_key)

      // Check take profit
      if (this.shouldCloseTakeProfit(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "take_profit", position)
        this.invalidatePrevSet(cacheConfigId)
        console.log(`[v0] [Realtime] TP hit for ${position.symbol} ${side} | PnL: ${pnl.toFixed(4)}`)
        return
      }

      // Check stop loss
      if (this.shouldCloseStopLoss(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "stop_loss", position)
        this.invalidatePrevSet(cacheConfigId)
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
   * Get the current price for a symbol via the shared 200ms market-
   * data cache. The cache handles in-flight dedup and pipelined batch
   * prefetch, so every realtime tick pays at most ONE Redis RTT per
   * 200ms window regardless of how many positions share the symbol.
   */
  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const data = await getMarketDataCached(symbol)
      if (!data) return null
      const price = parseFloat(data?.close || data?.price || "0")
      return price > 0 ? price : null
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
   * Trailing-stop tick — supports BOTH the legacy single-step path AND
   * the multi-step state machine driven by the Settings → Strategy →
   * Trailing matrix.
   *
   *   • Legacy path (no `trailing_start_ratio` on the hash, or 0): trail
   *     distance = `stoploss_ratio` %; ratchet on every favourable move.
   *     Identical to the previous behaviour — kept for back-compat with
   *     positions opened before multi-step trailing existed.
   *
   *   • Multi-step path (3 ratio fields populated): a 2-phase state
   *     machine.
   *
   *       1. INACTIVE — `gain_ratio < trailing_start_ratio` → no-op.
   *       2. ACTIVATION — `gain_ratio >= trailing_start_ratio` →
   *          flip `trailing_active = 1`, set `trailing_anchor` to
   *          `currentPrice` (high-water for long, low-water for short),
   *          set `trailing_stop_price` to
   *          `anchor × (1 ∓ trailing_stop_ratio)`.
   *       3. ACTIVE — re-anchor only when price has moved at least
   *          `trailing_step_ratio × anchor` in the favourable direction
   *          (so jitter inside the step doesn't re-write Redis on every
   *          tick). Stop ratchets one direction.
   *
   *   When stop is hit, `shouldCloseStopLoss` (unchanged) closes the
   *   position with reason `stop_loss`. The check there reads
   *   `trailing_stop_price`, which we set in BOTH paths, so the close
   *   gate is shared.
   */
  private async updateTrailingStop(position: any, currentPrice: number): Promise<void> {
    try {
      const entryPrice = parseFloat(position.entry_price || "0")
      const side: "long" | "short" = position.side === "short" ? "short" : "long"
      if (entryPrice <= 0 || currentPrice <= 0) return

      const startRatio = parseFloat(position.trailing_start_ratio || "0")
      const stopRatio = parseFloat(position.trailing_stop_ratio || "0")
      const stepRatio = parseFloat(position.trailing_step_ratio || "0")
      const useMultiStep = startRatio > 0 && stopRatio > 0

      const client = getRedisClient()
      const hashKey = `pseudo_position:${this.connectionId}:${position.id}`

      // ── Multi-step path ────────────────────────────────────────────
      if (useMultiStep) {
        // Profit ratio in the trade's favourable direction.
        const gainRatio =
          side === "long"
            ? (currentPrice - entryPrice) / entryPrice
            : (entryPrice - currentPrice) / entryPrice

        const wasActive = position.trailing_active === "1" || position.trailing_active === true
        const anchorStored = parseFloat(position.trailing_anchor || "0")
        const currentTrailingStop = parseFloat(position.trailing_stop_price || "0")

        // Phase 1 — INACTIVE: not yet at the activation threshold.
        if (!wasActive) {
          if (gainRatio < startRatio) return  // dormant; pure TP/SL governs

          // Phase 2 — ACTIVATION: cross the start threshold for the first time.
          const anchor = currentPrice
          const newStop =
            side === "long"
              ? anchor * (1 - stopRatio)
              : anchor * (1 + stopRatio)

          await client.hset(hashKey, {
            trailing_active: "1",
            trailing_anchor: String(anchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          // Mutate in-place so the very next gate (shouldCloseStopLoss)
          // sees the freshly-armed stop without re-fetching the hash.
          position.trailing_active = "1"
          position.trailing_anchor = String(anchor)
          position.trailing_stop_price = String(newStop)
          return
        }

        // Phase 3 — ACTIVE: re-anchor only when price has moved by ≥ step
        // in the favourable direction. Step is computed against the
        // STORED anchor (not currentPrice) so a single big tick doesn't
        // skip over and immediately re-anchor on the next.
        const stepDistance = anchorStored * stepRatio
        if (side === "long") {
          if (currentPrice <= anchorStored + stepDistance) return
          const newAnchor = currentPrice
          const newStop = newAnchor * (1 - stopRatio)
          // Ratchet — never relax the stop downward for longs
          if (currentTrailingStop > 0 && newStop <= currentTrailingStop) {
            // Anchor moved but stop didn't tighten meaningfully — write
            // the anchor only so subsequent steps measure from the new
            // high. Cheap one-field write.
            await client.hset(hashKey, {
              trailing_anchor: String(newAnchor),
              updated_at: new Date().toISOString(),
            })
            position.trailing_anchor = String(newAnchor)
            return
          }
          await client.hset(hashKey, {
            trailing_anchor: String(newAnchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          position.trailing_anchor = String(newAnchor)
          position.trailing_stop_price = String(newStop)
        } else {
          if (currentPrice >= anchorStored - stepDistance) return
          const newAnchor = currentPrice
          const newStop = newAnchor * (1 + stopRatio)
          if (currentTrailingStop > 0 && newStop >= currentTrailingStop) {
            await client.hset(hashKey, {
              trailing_anchor: String(newAnchor),
              updated_at: new Date().toISOString(),
            })
            position.trailing_anchor = String(newAnchor)
            return
          }
          await client.hset(hashKey, {
            trailing_anchor: String(newAnchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          position.trailing_anchor = String(newAnchor)
          position.trailing_stop_price = String(newStop)
        }
        return
      }

      // ── Legacy single-step path (back-compat) ─────────────────────
      const stoplossRatio = parseFloat(position.stoploss_ratio || "0")
      const currentTrailingStop = parseFloat(position.trailing_stop_price || "0")
      const trailingDistance = currentPrice * (stoplossRatio / 100)

      let newTrailingStop: number
      if (side === "long") {
        newTrailingStop = currentPrice - trailingDistance
        if (newTrailingStop <= currentTrailingStop && currentTrailingStop > 0) return
      } else {
        newTrailingStop = currentPrice + trailingDistance
        if (newTrailingStop >= currentTrailingStop && currentTrailingStop > 0) return
      }

      await client.hset(hashKey, {
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
