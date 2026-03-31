import { getRedisClient, initRedis } from "@/lib/redis-db"

/**
 * Database Coordination Layer
 * Handles schema validation, data consistency, and coordinated operations
 * across Redis for position tracking, trades, and system state
 */

// Schema validators - validate data before storage
export const SchemaValidators = {
  position: (data: any) => {
    const required = ["id", "connectionId", "symbol", "size", "entryPrice", "currentPrice", "side", "status"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (!["long", "short", "both"].includes(data.side)) throw new Error(`Invalid side: ${data.side}`)
    if (!["open", "closing", "closed"].includes(data.status)) throw new Error(`Invalid status: ${data.status}`)
    if (typeof data.size !== "number" || data.size <= 0) throw new Error(`Invalid size: ${data.size}`)
    if (typeof data.leverage !== "number" || data.leverage < 1) throw new Error(`Invalid leverage: ${data.leverage}`)
    return true
  },

  order: (data: any) => {
    const required = ["id", "connectionId", "symbol", "side", "quantity", "status"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (!["buy", "sell"].includes(data.side)) throw new Error(`Invalid side: ${data.side}`)
    if (!["pending", "filled", "partially_filled", "cancelled"].includes(data.status))
      throw new Error(`Invalid status: ${data.status}`)
    if (typeof data.quantity !== "number" || data.quantity <= 0) throw new Error(`Invalid quantity: ${data.quantity}`)
    return true
  },

  trade: (data: any) => {
    const required = ["id", "connectionId", "symbol", "entryPrice", "side"]
    for (const field of required) {
      if (data[field] === undefined) throw new Error(`Missing required field: ${field}`)
    }
    if (!["long", "short"].includes(data.side)) throw new Error(`Invalid side: ${data.side}`)
    return true
  },
}

/**
 * Main Database Coordinator
 * Ensures consistency and validates all data operations
 */
export class DatabaseCoordinator {
  private static instance: DatabaseCoordinator
  private readonly log = (msg: string) => console.log(`[v0] [DB-Coordinator] ${msg}`)
  private readonly error = (msg: string) => console.error(`[v0] [DB-Coordinator] ERROR: ${msg}`)

  private constructor() {}

  static getInstance(): DatabaseCoordinator {
    if (!DatabaseCoordinator.instance) {
      DatabaseCoordinator.instance = new DatabaseCoordinator()
    }
    return DatabaseCoordinator.instance
  }

  /**
   * Store position with validation
   */
  async storePosition(connectionId: string, symbol: string, position: any): Promise<boolean> {
    try {
      this.log(`Storing position: ${connectionId}/${symbol}`)

      // Validate schema
      SchemaValidators.position(position)

      await initRedis()
      const client = getRedisClient()

      const key = `position:${connectionId}:${symbol}`
      const hashData: Record<string, string> = {}

      // Transform nested objects to JSON strings for storage
      for (const [k, v] of Object.entries(position)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      await (client as any).hset(key, hashData)
      await (client as any).expire(key, 3600) // 1 hour TTL

      // Track in positions set for quick lookup
      await (client as any).sadd(`positions:${connectionId}`, symbol)
      this.log(`✓ Position stored: ${key}`)

      return true
    } catch (error) {
      this.error(`Failed to store position ${connectionId}/${symbol}: ${error}`)
      return false
    }
  }

  /**
   * Fetch position with validation
   */
  async getPosition(connectionId: string, symbol: string): Promise<any | null> {
    try {
      await initRedis()
      const client = getRedisClient()

      const key = `position:${connectionId}:${symbol}`
      const data = await (client as any).hgetall(key)

      if (!data || Object.keys(data).length === 0) {
        return null
      }

      // Parse JSON strings back to objects
      const parsed: Record<string, any> = {}
      for (const [k, v] of Object.entries(data)) {
        try {
          parsed[k] = typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? JSON.parse(v as string) : v
        } catch {
          parsed[k] = v
        }
      }

      // Validate after retrieval
      SchemaValidators.position(parsed)
      return parsed
    } catch (error) {
      this.error(`Failed to get position ${connectionId}/${symbol}: ${error}`)
      return null
    }
  }

  /**
   * Fetch all positions for a connection
   */
  async getPositions(connectionId: string): Promise<Record<string, any>> {
    try {
      await initRedis()
      const client = getRedisClient()

      const symbols = await (client as any).smembers(`positions:${connectionId}`)
      const positions: Record<string, any> = {}

      for (const symbol of symbols) {
        const position = await this.getPosition(connectionId, symbol)
        if (position) {
          positions[symbol] = position
        }
      }

      this.log(`Fetched ${Object.keys(positions).length} positions for ${connectionId}`)
      return positions
    } catch (error) {
      this.error(`Failed to get all positions for ${connectionId}: ${error}`)
      return {}
    }
  }

  /**
   * Store order with validation
   */
  async storeOrder(connectionId: string, orderId: string, order: any): Promise<boolean> {
    try {
      this.log(`Storing order: ${connectionId}/${orderId}`)

      // Validate schema
      SchemaValidators.order(order)

      await initRedis()
      const client = getRedisClient()

      const key = `order:${connectionId}:${orderId}`
      const hashData: Record<string, string> = {}

      for (const [k, v] of Object.entries(order)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      await (client as any).hset(key, hashData)
      await (client as any).expire(key, 3600)

      // Track in orders set
      await (client as any).sadd(`orders:${connectionId}`, orderId)
      this.log(`✓ Order stored: ${key}`)

      return true
    } catch (error) {
      this.error(`Failed to store order ${connectionId}/${orderId}: ${error}`)
      return false
    }
  }

  /**
   * Get order with validation
   */
  async getOrder(connectionId: string, orderId: string): Promise<any | null> {
    try {
      await initRedis()
      const client = getRedisClient()

      const key = `order:${connectionId}:${orderId}`
      const data = await (client as any).hgetall(key)

      if (!data || Object.keys(data).length === 0) {
        return null
      }

      // Parse JSON strings back
      const parsed: Record<string, any> = {}
      for (const [k, v] of Object.entries(data)) {
        try {
          parsed[k] = typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? JSON.parse(v as string) : v
        } catch {
          parsed[k] = v
        }
      }

      SchemaValidators.order(parsed)
      return parsed
    } catch (error) {
      this.error(`Failed to get order ${connectionId}/${orderId}: ${error}`)
      return null
    }
  }

  /**
   * Record a completed trade
   */
  async recordTrade(connectionId: string, trade: any): Promise<boolean> {
    try {
      SchemaValidators.trade(trade)

      await initRedis()
      const client = getRedisClient()

      const tradeId = trade.id || `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const key = `trade:${connectionId}:${tradeId}`

      const hashData: Record<string, string> = {}
      for (const [k, v] of Object.entries(trade)) {
        if (v === null || v === undefined) continue
        if (typeof v === "object") {
          hashData[k] = JSON.stringify(v)
        } else {
          hashData[k] = String(v)
        }
      }

      await (client as any).hset(key, hashData)
      await (client as any).expire(key, 7 * 24 * 60 * 60) // 7 days

      // Track in trades set
      await (client as any).sadd(`trades:${connectionId}`, tradeId)

      this.log(`✓ Trade recorded: ${tradeId}`)
      return true
    } catch (error) {
      this.error(`Failed to record trade: ${error}`)
      return false
    }
  }

  /**
   * Get all trades for a connection
   */
  async getTrades(connectionId: string, limit: number = 100): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      const tradeIds = (await (client as any).smembers(`trades:${connectionId}`)) || []
      const trades: any[] = []

      for (const tradeId of tradeIds.slice(0, limit)) {
        const key = `trade:${connectionId}:${tradeId}`
        const data = await (client as any).hgetall(key)
        if (data) {
          trades.push(data)
        }
      }

      return trades
    } catch (error) {
      this.error(`Failed to get trades for ${connectionId}: ${error}`)
      return []
    }
  }

  /**
   * Clean up closed positions
   */
  async cleanupClosedPositions(connectionId: string, retentionHours: number = 24): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000)
      let cleaned = 0

      await initRedis()
      const client = getRedisClient()

      const positions = await this.getPositions(connectionId)

      for (const [symbol, position] of Object.entries(positions)) {
        if (position.status === "closed") {
          const updatedAt = new Date(position.updated_at)
          if (updatedAt < cutoff) {
            const key = `position:${connectionId}:${symbol}`
            await (client as any).del(key)
            await (client as any).srem(`positions:${connectionId}`, symbol)
            cleaned++
          }
        }
      }

      if (cleaned > 0) {
        this.log(`Cleaned up ${cleaned} closed positions`)
      }

      return cleaned
    } catch (error) {
      this.error(`Failed to cleanup positions: ${error}`)
      return 0
    }
  }

  /**
   * Validate data consistency across keys
   */
  async validateConsistency(connectionId: string): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const errors: string[] = []

      await initRedis()
      const client = getRedisClient()

      // Check positions
      const symbols = await (client as any).smembers(`positions:${connectionId}`)
      for (const symbol of symbols) {
        const position = await this.getPosition(connectionId, symbol)
        if (!position) {
          errors.push(`Position set references non-existent position: ${symbol}`)
        }
      }

      // Check orders
      const orderIds = await (client as any).smembers(`orders:${connectionId}`)
      for (const orderId of orderIds) {
        const order = await this.getOrder(connectionId, orderId)
        if (!order) {
          errors.push(`Order set references non-existent order: ${orderId}`)
        }
      }

      const valid = errors.length === 0
      if (!valid) {
        this.log(`Consistency check failed for ${connectionId}: ${errors.length} errors`)
        errors.forEach((e) => this.log(`  - ${e}`))
      }

      return { valid, errors }
    } catch (error) {
      this.error(`Consistency check failed: ${error}`)
      return { valid: false, errors: [String(error)] }
    }
  }
}

// Export singleton instance
export const dbCoordinator = DatabaseCoordinator.getInstance()
