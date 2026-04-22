/**
 * Pseudo Position Manager
 * Manages pseudo positions (paper trading) with volume calculations
 * NOW: 100% Redis-backed, no SQL
 */

import { getRedisClient, getSettings, setSettings, createPosition as redisCreatePosition } from "@/lib/redis-db"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { emitPositionUpdate } from "@/lib/broadcast-helpers"
import { StrategyConfigManager, type PseudoPosition as StrategyPseudoPosition } from "@/lib/strategy-config-manager"

function nanoid(len = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let id = ""
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

export class PseudoPositionManager {
  private connectionId: string
  private activePositionsCache: any[] | null = null
  private cacheTimestamp = 0
  private readonly CACHE_TTL_MS = 1000 // 1 second cache

  // ── Hot-path write elision ─────────────────────────────────────────
  // Per-position last-written price. The realtime tick compares the
  // incoming market price against this memo before issuing an HSET, so
  // sub-epsilon ticks on quiet symbols produce zero Redis writes. Entry
  // is cleared on close via invalidatePriceMemo() so a reopened id with
  // the same position key starts fresh.
  private lastWrittenPrice: Map<string, number> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** Redis set key that indexes every position id for this connection */
  private positionsSetKey(): string {
    return `pseudo_positions:${this.connectionId}`
  }

  /**
   * Redis set key that indexes all currently-active configSetKeys for O(1) duplicate detection.
   * Each active position's configSetKey is added on creation and removed on close.
   */
  private activeConfigKeysSetKey(): string {
    return `pseudo_positions:${this.connectionId}:active_config_keys`
  }

  /** Redis hash key for one position */
  private positionKey(id: string): string {
    return `pseudo_position:${this.connectionId}:${id}`
  }

  /** Read a single position hash from Redis */
  private async readPosition(id: string): Promise<any | null> {
    try {
      const client = getRedisClient()
      const data = await client.hgetall(this.positionKey(id))
      if (!data || Object.keys(data).length === 0) return null
      return { ...data, id }
    } catch {
      return null
    }
  }

  /**
   * List all positions for this connection, optionally filtered.
   *
   * PERFORMANCE: The previous implementation awaited `readPosition(id)` once
   * per id — one Redis round-trip per position. With dozens of active
   * pseudo positions this ran serially on every realtime tick (1/sec per
   * engine), easily dominating cycle time. We now fan-out all reads in a
   * single `Promise.all` so the whole list is fetched in one RTT window and
   * filtering happens after in O(N) on the already-materialised array.
   */
  private async listPositions(filter?: { status?: string; side?: string; symbol?: string; indicationType?: string }): Promise<any[]> {
    try {
      const client = getRedisClient()
      const ids = await client.smembers(this.positionsSetKey())
      if (!ids || ids.length === 0) return []

      const raw = await Promise.all(ids.map((id: string) => this.readPosition(id).catch(() => null)))
      const hasFilter = Boolean(
        filter?.status || filter?.side || filter?.symbol || filter?.indicationType,
      )

      if (!hasFilter) {
        return raw.filter((p): p is any => Boolean(p))
      }

      const positions: any[] = []
      for (const pos of raw) {
        if (!pos) continue
        if (filter?.status && pos.status !== filter.status) continue
        if (filter?.side && pos.side !== filter.side) continue
        if (filter?.symbol && pos.symbol !== filter.symbol) continue
        if (filter?.indicationType && pos.indication_type !== filter.indicationType) continue
        positions.push(pos)
      }
      return positions
    } catch (error) {
      console.error("[v0] [PseudoPosMgr] Failed to list positions:", error)
      return []
    }
  }

  // ── public API ────────────────────────────────────────────────────────

  /**
   * Create new pseudo position with proper volume calculation.
   * configSetKey identifies the unique config combination (indType:dir:tp:sl:trailing:size:lev:state).
   * Exactly one active position is allowed per configSetKey.
   */
  async createPosition(params: {
    symbol: string
    indicationType: string
    side: "long" | "short"
    entryPrice: number
    takeprofitFactor: number
    stoplossRatio: number
    profitFactor: number
    trailingEnabled: boolean
    configSetKey?: string  // unique fingerprint of the config combination
  }): Promise<string | null> {
    try {
      // Build a canonical config set key if not provided
      const configSetKey = params.configSetKey || [
        params.indicationType,
        params.side,
        params.takeprofitFactor.toFixed(4),
        params.stoplossRatio.toFixed(4),
        params.trailingEnabled ? "1" : "0",
      ].join(":")

      const canCreate = await this.canCreatePosition(
        params.symbol,
        configSetKey,
      )

      if (!canCreate) {
        return null  // silent — one position per config set is expected
      }

      // Calculate volume for this position
      const volumeCalc = await VolumeCalculator.calculateVolumeForConnection(
        this.connectionId,
        params.symbol,
        params.entryPrice,
      )

      // Check if volume calculation succeeded and meets minimum requirements
      if (!volumeCalc.finalVolume || volumeCalc.finalVolume <= 0) {
        console.warn(
          `[v0] Cannot create position for ${params.symbol}: ` +
          `volume too small (${volumeCalc.finalVolume}) - ${volumeCalc.adjustmentReason || 'below minimum'}`
        )
        return null
      }

      // Calculate take profit and stop loss prices
      const takeProfitPrice =
        params.side === "long"
          ? params.entryPrice * (1 + params.takeprofitFactor / 100)
          : params.entryPrice * (1 - params.takeprofitFactor / 100)

      const stopLossPrice =
        params.side === "long"
          ? params.entryPrice * (1 - params.stoplossRatio / 100)
          : params.entryPrice * (1 + params.stoplossRatio / 100)

      // Calculate position cost
      const positionCost = (volumeCalc.finalVolume * params.entryPrice) / volumeCalc.leverage

      // Store position in Redis
      const id = nanoid()
      const client = getRedisClient()

      const positionData: Record<string, string> = {
        connection_id: this.connectionId,
        symbol: params.symbol,
        indication_type: params.indicationType,
        side: params.side,
        config_set_key: configSetKey,
        entry_price: String(params.entryPrice),
        current_price: String(params.entryPrice),
        quantity: String(volumeCalc.finalVolume),
        position_cost: String(positionCost),
        takeprofit_factor: String(params.takeprofitFactor),
        takeprofit_price: String(takeProfitPrice),
        stoploss_ratio: String(params.stoplossRatio),
        stoploss_price: String(stopLossPrice),
        profit_factor: String(params.profitFactor),
        trailing_enabled: params.trailingEnabled ? "1" : "0",
        trailing_stop_price: "0",
        status: "active",
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      await client.hset(this.positionKey(id), positionData)
      await client.sadd(this.positionsSetKey(), id)
      // Register this configSetKey as active for O(1) duplicate detection on next creation
      await client.sadd(this.activeConfigKeysSetKey(), configSetKey)

      console.log(`[v0] Created pseudo position ${id} for ${params.symbol} side=${params.side} vol=${volumeCalc.finalVolume}`)

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // Broadcast position creation to connected clients
      emitPositionUpdate(this.connectionId, {
        id,
        symbol: params.symbol,
        currentPrice: params.entryPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        status: 'open',
      })

      return id
    } catch (error) {
      console.error("[v0] Failed to create pseudo position:", error)
      return null
    }
  }

  /**
   * Get active pseudo positions
   */
  async getActivePositions(): Promise<any[]> {
    try {
      const now = Date.now()
      if (this.activePositionsCache && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
        return this.activePositionsCache
      }

      const positions = await this.listPositions({ status: "active" })

      // Sort by opened_at DESC
      positions.sort((a, b) => {
        const tA = new Date(a.opened_at || 0).getTime()
        const tB = new Date(b.opened_at || 0).getTime()
        return tB - tA
      })

      this.activePositionsCache = positions
      this.cacheTimestamp = now

      return positions
    } catch (error) {
      console.error("[v0] Failed to get active positions:", error)
      return []
    }
  }

  /**
   * Update a pseudo-position with the latest market price.
   *
   * Hot-path optimisations (critical at 100ms tick intervals):
   *
   *   1. **Pre-loaded position object.** The realtime processor already
   *      has the full position hash in-memory from `getActivePositions`,
   *      so we accept it as an optional `existingPosition` and skip the
   *      redundant `readPosition` HGETALL round-trip. Legacy callers
   *      that don't pass one fall back to the old behaviour.
   *
   *   2. **Write elision.** Prices do NOT move on every 100ms tick —
   *      the market-data feed typically refreshes at sub-second cadence
   *      with many consecutive ticks returning identical prices. We
   *      skip the Redis HSET entirely when the incoming price matches
   *      the last-known `current_price` within a tight epsilon
   *      (0.0001%). The broadcast is also skipped in that case, since
   *      dashboards have nothing new to render. This turns a "N-RTT-
   *      per-tick" cost into "only when price actually moved."
   *
   *   3. **Last-written memoisation.** We track per-position last-seen
   *      price in-memory to avoid parsing the previous `current_price`
   *      string out of the hash on every tick.
   */
  async updatePosition(
    positionId: string,
    currentPrice: number,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    try {
      const client = getRedisClient()

      // Prefer the caller-supplied position to avoid an extra HGETALL.
      const position = existingPosition ?? (await this.readPosition(positionId))
      if (!position) return

      // Compare against last-written price. First tick (no memo) uses
      // the persisted `current_price` so we don't fire a redundant
      // write just because the processor restarted.
      const memoPrice = this.lastWrittenPrice.get(positionId)
      const prevPrice = memoPrice ?? parseFloat(position.current_price || "0")
      const epsilon = prevPrice > 0 ? Math.max(prevPrice * 1e-6, 1e-9) : 0
      const priceMoved = Math.abs(currentPrice - prevPrice) > epsilon

      if (priceMoved) {
        await client.hset(this.positionKey(positionId), {
          current_price: String(currentPrice),
          updated_at: new Date().toISOString(),
        })
        this.lastWrittenPrice.set(positionId, currentPrice)

        // Calculate unrealized PnL for the broadcast only — skipping
        // the broadcast when nothing moved eliminates a huge amount of
        // WebSocket chatter on quiet symbols.
        const entryPrice = parseFloat(position.entry_price || "0")
        const quantity = parseFloat(position.quantity || "0")
        const side = position.side || "long"
        const unrealizedPnl = side === "long"
          ? (currentPrice - entryPrice) * quantity
          : (entryPrice - currentPrice) * quantity
        const unrealizedPnlPercent =
          entryPrice > 0 && quantity > 0
            ? (unrealizedPnl / (entryPrice * quantity)) * 100
            : 0

        emitPositionUpdate(this.connectionId, {
          id: positionId,
          symbol: position.symbol,
          currentPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          status: "open",
        })
      }
    } catch (error) {
      console.error(`[v0] Failed to update position ${positionId}:`, error)
    }
  }

  /**
   * Close a pseudo-position with the given reason.
   *
   * Accepts an optional pre-loaded `existingPosition` hash (mirrors the
   * `updatePosition` optimisation) so the realtime processor can reuse
   * the object it already holds instead of issuing an extra HGETALL on
   * every TP/SL hit.
   *
   * All state-mutation writes for this connection (status flip, index
   * removals, TTL, Set append for prev-position context, heartbeat) are
   * issued as a SINGLE Redis pipeline via `client.multi()`. The previous
   * serial implementation paid 6–7 RTTs per close which was material on
   * hot symbols — pipelining collapses that to one. The strategy-Set
   * append is composed into the same pipeline rather than going through
   * `StrategyConfigManager.addPosition` (which would open its own
   * second pipeline) to keep everything in one atomic batch.
   */
  async closePosition(
    positionId: string,
    reason: string,
    existingPosition?: Record<string, string> | null,
  ): Promise<void> {
    try {
      const position = existingPosition ?? (await this.readPosition(positionId))
      if (!position) return

      const entryPrice = parseFloat(position.entry_price || "0")
      const currentPrice = parseFloat(position.current_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const pnl = side === "long"
        ? (currentPrice - entryPrice) * quantity
        : (entryPrice - currentPrice) * quantity

      const client = getRedisClient()
      const closedAtIso = new Date().toISOString()
      const configSetKey = position.config_set_key || ""
      const configId = StrategyConfigManager.extractConfigId(configSetKey)

      // Build the single close-path pipeline.
      const pipeline = client.multi()
      pipeline.hset(this.positionKey(positionId), {
        status: "closed",
        closed_at: closedAtIso,
        close_reason: reason,
        realized_pnl: String(pnl),
      })
      pipeline.srem(this.positionsSetKey(), positionId)
      if (configSetKey) {
        pipeline.srem(this.activeConfigKeysSetKey(), configSetKey)
      }
      // 7-day TTL on the closed hash for operator forensics.
      pipeline.expire(this.positionKey(positionId), 604800)

      // ── Continuous Set update (in same pipeline) ──────────────────
      // The realtime processor reads the HEAD of each strategy-config's
      // position list as its "prev position" context (first filled by
      // the prehistoric processor via StrategyConfigManager.addPositions).
      // We append each closed live position back into the SAME uniquely-
      // keyed list here so the Set stays continuously current, not
      // frozen at prehistoric-time. Entry serialisation goes through
      // the canonical static on StrategyConfigManager so writer and
      // reader never drift.
      if (configId) {
        const notional = entryPrice * quantity
        const resultPct = notional > 0 ? (pnl / notional) * 100 : 0
        // Canonical field on a live `pseudo_position` hash is `opened_at` (see
        // createPosition()). Historical/fill rows use `entry_time`. Legacy
        // rows used `created_at`. Fall through in priority order so the
        // prev-set entry ALWAYS carries the true entry timestamp — previously
        // it silently fell through to `closedAtIso` (= exit_time), which made
        // every live-closed writeback look like a zero-duration trade.
        const entryIso = String(
          position.opened_at ||
          position.entry_time ||
          position.created_at ||
          closedAtIso,
        )
        // Take-profit / stop-loss absolute prices live under different field
        // names depending on the writer:
        //   - `pseudo-position-manager.createPosition()` stores them as
        //     `takeprofit_price` / `stoploss_price` (canonical).
        //   - `config-set-processor.calculateStrategyPositions()` (historical
        //     fill) stores them as `take_profit` / `stop_loss`.
        // Read both so the Set entry exposes real levels regardless of origin.
        const tpPrice = parseFloat(
          position.takeprofit_price || position.take_profit || "0",
        )
        const slPrice = parseFloat(
          position.stoploss_price || position.stop_loss || "0",
        )
        const setEntry: StrategyPseudoPosition = {
          entry_time:  entryIso,
          symbol:      String(position.symbol || ""),
          entry_price: entryPrice,
          take_profit: tpPrice,
          stop_loss:   slPrice,
          status:      "closed",
          result:      resultPct,
          exit_time:   closedAtIso,
          exit_price:  currentPrice,
        }
        const setKey = `strategy:${this.connectionId}:config:${configId}:positions`
        pipeline.lpush(setKey, StrategyConfigManager.serializeSetEntry(setEntry))
        pipeline.ltrim(setKey, 0, StrategyConfigManager.MAX_POSITIONS - 1)
      }

      await pipeline.exec()

      // Clear the per-tick price memo so a reused id can't be elided.
      this.lastWrittenPrice.delete(positionId)

      console.log(`[v0] Closed position ${positionId}: ${reason} (PnL: ${pnl.toFixed(4)})`)

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // Broadcast position closure to connected clients
      emitPositionUpdate(this.connectionId, {
        id: positionId,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPercent:
          entryPrice > 0 && quantity > 0 ? (pnl / (entryPrice * quantity)) * 100 : 0,
        status: "closed",
      })
    } catch (error) {
      console.error(`[v0] Failed to close position ${positionId}:`, error)
    }
  }

  /**
   * Get active position count
   */
  async getPositionCount(): Promise<number> {
    const active = await this.listPositions({ status: "active" })
    return active.length
  }

  /**
   * Update active positions count in engine state (Redis)
   */
  private async updateActivePositionsCount(): Promise<void> {
    try {
      const count = await this.getPositionCount()
      const stateKey = `trade_engine_state:${this.connectionId}`
      const current = (await getSettings(stateKey)) || {}
      await setSettings(stateKey, { ...current, active_positions_count: count })
    } catch (error) {
      console.error("[v0] Failed to update active positions count:", error)
    }
  }

  /**
   * Get position statistics
   */
  async getPositionStats(): Promise<any> {
    try {
      const allPositions = await this.listPositions()

      const active = allPositions.filter(p => p.status === "active")
      const closed = allPositions.filter(p => p.status === "closed")
      const activeLong = active.filter(p => p.side === "long").length
      const activeShort = active.filter(p => p.side === "short").length

      // Closed-position PnL is authoritative in the stored `realized_pnl`
      // field (written atomically during closePosition() from the live
      // current_price at close time). Recomputing from current_price here
      // risked drift because:
      //   - `updatePosition` elides Redis writes on tiny price moves,
      //     which meant the hash's `current_price` could lag the price
      //     that was live when TP/SL actually triggered;
      //   - for closed rows the semantically correct value to report is
      //     realised PnL, not a mark-to-market recomputation.
      // We still fall back to the recompute path for any legacy row
      // that predates the `realized_pnl` field, so nothing regresses.
      let totalPnl = 0
      let pnlLong = 0
      let pnlShort = 0
      let closedLongCount = 0
      let closedShortCount = 0

      for (const p of closed) {
        const side = p.side || "long"
        let pnl: number
        const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
        if (Number.isFinite(stored)) {
          pnl = stored
        } else {
          const entry = parseFloat(p.entry_price || "0")
          const current = parseFloat(p.current_price || "0")
          const qty = parseFloat(p.quantity || "0")
          pnl = side === "long" ? (current - entry) * qty : (entry - current) * qty
        }
        totalPnl += pnl
        if (side === "long") {
          pnlLong += pnl
          closedLongCount++
        } else {
          pnlShort += pnl
          closedShortCount++
        }
      }

      const totalRealizedPct = closed.length > 0
        ? closed.reduce((acc, p) => {
            const entry = parseFloat(p.entry_price || "0")
            const qty = parseFloat(p.quantity || "0")
            const notional = entry * qty
            if (!(notional > 0)) return acc
            const stored = p.realized_pnl != null ? parseFloat(p.realized_pnl) : NaN
            const pnl = Number.isFinite(stored)
              ? stored
              : (() => {
                  const current = parseFloat(p.current_price || "0")
                  const side = p.side || "long"
                  return side === "long" ? (current - entry) * qty : (entry - current) * qty
                })()
            return acc + (pnl / notional) * 100
          }, 0)
        : 0

      return {
        total_positions: allPositions.length,
        active_positions: active.length,
        active_long: activeLong,
        active_short: activeShort,
        closed_positions: closed.length,
        total_pnl: totalPnl,
        avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
        avg_pnl_long: closedLongCount > 0 ? pnlLong / closedLongCount : 0,
        avg_pnl_short: closedShortCount > 0 ? pnlShort / closedShortCount : 0,
        avg_pnl_pct: closed.length > 0 ? totalRealizedPct / closed.length : 0,
      }
    } catch (error) {
      console.error("[v0] Failed to get position stats:", error)
      return null
    }
  }

  /**
   * Check if a new position can be created for the given config set key.
   * Each unique config combination (indType:dir:symbol) is an independent Set —
   * exactly 1 active pseudo position is allowed per Set.
   *
   * Uses O(1) SISMEMBER on the activeConfigKeysSetKey index instead of scanning
   * all positions, which is critical for high-frequency operation.
   */
  private async canCreatePosition(
    symbol: string,
    configSetKey: string,
  ): Promise<boolean> {
    try {
      const client = getRedisClient()
      const isMember = await client.sismember(this.activeConfigKeysSetKey(), configSetKey)
      // isMember is 1 (number) if already active, 0 or null if not
      return !isMember
    } catch (error) {
      console.error("[v0] Failed to check position limit for config set:", error)
      // On Redis error fall through and allow creation (fail-open)
      return true
    }
  }

  /**
   * Get position count by direction
   */
  async getPositionCountByDirection(side: "long" | "short"): Promise<number> {
    const positions = await this.listPositions({ status: "active", side })
    return positions.length
  }

  /**
   * Invalidate position cache
   */
  private invalidateCache(): void {
    this.activePositionsCache = null
    this.cacheTimestamp = 0
  }
}
