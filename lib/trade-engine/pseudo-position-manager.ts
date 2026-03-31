/**
 * Pseudo Position Manager
 * Manages pseudo positions (paper trading) with volume calculations
 * NOW: 100% Redis-backed, no SQL
 */

import { getRedisClient, getSettings, setSettings, createPosition as redisCreatePosition } from "@/lib/redis-db"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { emitPositionUpdate } from "@/lib/broadcast-helpers"

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

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** Redis set key that indexes every position id for this connection */
  private positionsSetKey(): string {
    return `pseudo_positions:${this.connectionId}`
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

  /** List all positions for this connection, optionally filtered */
  private async listPositions(filter?: { status?: string; side?: string; symbol?: string; indicationType?: string }): Promise<any[]> {
    try {
      const client = getRedisClient()
      const ids = await client.smembers(this.positionsSetKey())
      if (!ids || ids.length === 0) return []

      const positions: any[] = []
      for (const id of ids) {
        const pos = await this.readPosition(id)
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
   * Create new pseudo position with proper volume calculation
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
  }): Promise<string | null> {
    try {
      const canCreate = await this.canCreatePosition(
        params.symbol,
        params.indicationType,
        params.side,
        params.takeprofitFactor,
        params.stoplossRatio,
        params.trailingEnabled,
      )

      if (!canCreate) {
        console.log(
          `[v0] Cannot create ${params.side} position for ${params.symbol} (TP=${params.takeprofitFactor}, SL=${params.stoplossRatio}, trailing=${params.trailingEnabled}): max positions reached`,
        )
        return null
      }

      // Calculate volume for this position
      const volumeCalc = await VolumeCalculator.calculateVolumeForConnection(
        this.connectionId,
        params.symbol,
        params.entryPrice,
      )

      if (!volumeCalc.finalVolume || volumeCalc.finalVolume <= 0) {
        console.error(`[v0] Failed to calculate valid volume for ${params.symbol}: ${volumeCalc.finalVolume}`)
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
   * Update position with current price
   */
  async updatePosition(positionId: string, currentPrice: number): Promise<void> {
    try {
      const client = getRedisClient()

      // Get position data before updating to calculate PnL
      const position = await this.readPosition(positionId)
      if (!position) return

      await client.hset(this.positionKey(positionId), {
        current_price: String(currentPrice),
        updated_at: new Date().toISOString(),
      })

      // Calculate unrealized PnL
      const entryPrice = parseFloat(position.entry_price || '0')
      const quantity = parseFloat(position.quantity || '0')
      const side = position.side || 'long'

      let unrealizedPnl = 0
      if (side === 'long') {
        unrealizedPnl = (currentPrice - entryPrice) * quantity
      } else {
        unrealizedPnl = (entryPrice - currentPrice) * quantity
      }

      const unrealizedPnlPercent = entryPrice > 0 ? (unrealizedPnl / (entryPrice * quantity)) * 100 : 0

      // Broadcast position update to connected clients
      emitPositionUpdate(this.connectionId, {
        id: positionId,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl,
        unrealizedPnlPercent,
        status: 'open',
      })
    } catch (error) {
      console.error(`[v0] Failed to update position ${positionId}:`, error)
    }
  }

  /**
   * Close position with reason
   */
  async closePosition(positionId: string, reason: string): Promise<void> {
    try {
      const position = await this.readPosition(positionId)
      if (!position) return

      const entryPrice = parseFloat(position.entry_price || "0")
      const currentPrice = parseFloat(position.current_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const pnl = side === "long"
        ? (currentPrice - entryPrice) * quantity
        : (entryPrice - currentPrice) * quantity

      const client = getRedisClient()
      await client.hset(this.positionKey(positionId), {
        status: "closed",
        closed_at: new Date().toISOString(),
        close_reason: reason,
        realized_pnl: String(pnl),
      })
      
      // Remove closed position from index set to prevent unbounded growth
      await client.srem(this.positionsSetKey(), positionId)
      // Set TTL on the closed position hash so it auto-cleans (7 days)
      await client.expire(this.positionKey(positionId), 604800)

      console.log(`[v0] Closed position ${positionId}: ${reason} (PnL: ${pnl.toFixed(4)})`)

      this.invalidateCache()
      await this.updateActivePositionsCount()

      // Broadcast position closure to connected clients
      emitPositionUpdate(this.connectionId, {
        id: positionId,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: entryPrice > 0 ? (pnl / (entryPrice * quantity)) * 100 : 0,
        status: 'closed',
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

      let totalPnl = 0
      let pnlLong = 0
      let pnlShort = 0

      for (const p of closed) {
        const entry = parseFloat(p.entry_price || "0")
        const current = parseFloat(p.current_price || "0")
        const qty = parseFloat(p.quantity || "0")
        const side = p.side || "long"
        const pnl = side === "long" ? (current - entry) * qty : (entry - current) * qty
        totalPnl += pnl
        if (side === "long") pnlLong += pnl
        else pnlShort += pnl
      }

      return {
        total_positions: allPositions.length,
        active_positions: active.length,
        active_long: activeLong,
        active_short: activeShort,
        closed_positions: closed.length,
        avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
        avg_pnl_long: closed.filter(p => p.side === "long").length > 0 ? pnlLong / closed.filter(p => p.side === "long").length : 0,
        avg_pnl_short: closed.filter(p => p.side === "short").length > 0 ? pnlShort / closed.filter(p => p.side === "short").length : 0,
      }
    } catch (error) {
      console.error("[v0] Failed to get position stats:", error)
      return null
    }
  }

  /**
   * Check if can create new position for specific config+direction
   */
  private async canCreatePosition(
    symbol: string,
    indicationType: string,
    side: "long" | "short",
    takeprofitFactor?: number,
    stoplossRatio?: number,
    trailingEnabled?: boolean,
  ): Promise<boolean> {
    try {
      const maxSetting = await getSettings("maxPositionsPerConfigSet")
      const maxPerConfig = maxSetting ? parseInt(String(maxSetting), 10) : 1

      // Get active positions matching this config
      const active = await this.listPositions({ status: "active", symbol, indicationType, side })

      let matching: any[]
      if (takeprofitFactor !== undefined && stoplossRatio !== undefined && trailingEnabled !== undefined) {
        matching = active.filter(p =>
          parseFloat(p.takeprofit_factor || "0") === takeprofitFactor &&
          parseFloat(p.stoploss_ratio || "0") === stoplossRatio &&
          (p.trailing_enabled === "1") === trailingEnabled
        )
      } else {
        matching = active
      }

      const canCreate = matching.length < maxPerConfig

      console.log(
        `[v0] Position check: ${symbol} ${indicationType} ${side} | ${matching.length}/${maxPerConfig} (can create: ${canCreate})`,
      )

      return canCreate
    } catch (error) {
      console.error("[v0] Failed to check if can create position:", error)
      return false
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
