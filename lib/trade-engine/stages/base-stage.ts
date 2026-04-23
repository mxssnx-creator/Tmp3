// Stage 2: Base Positions Generator
// Creates ALL possible pseudo positions from valid indication signals
// Generates 1 LONG + 1 SHORT position per indication (respecting max limits per direction)

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { ExchangeConnection } from "@/lib/types"
import type { IndicationSignal } from "./indication-stage"

const LOG_PREFIX = "[v0] [BasePositionStage]"

export interface BasePosition {
  id: string
  connectionId: string
  connectionName: string
  symbol: string
  timeframe: string
  direction: "long" | "short"
  entryPrice: number
  entryTime: number
  indicationSignal: "buy" | "sell" | "neutral"
  indicationStrength: number
  status: "pending" | "active" | "closed"
  sourceIndicationTimestamp: number
  createdAt: number
  updatedAt: number
}

/**
 * Generate base positions from valid indication signals
 * Creates 1 LONG and 1 SHORT pseudo position per indication
 * Respects max position limits per direction (configurable, default 1)
 */
export async function generateBasePositions(
  connection: ExchangeConnection,
  indications: IndicationSignal[],
  config: { maxLongPositions?: number; maxShortPositions?: number } = {}
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()
  const maxLong = config.maxLongPositions || 1
  const maxShort = config.maxShortPositions || 1
  const basePositions: BasePosition[] = []

  console.log(
    `${LOG_PREFIX} Generating base positions for ${connection.name} (max long: ${maxLong}, max short: ${maxShort})`
  )

  try {
    const connectionId = connection.id || connection.name

    for (const indication of indications) {
      // Count existing positions in each direction
      const existingLong = await countExistingPositions(
        client,
        connectionId,
        indication.symbol,
        "long"
      )
      const existingShort = await countExistingPositions(
        client,
        connectionId,
        indication.symbol,
        "short"
      )

      // Generate LONG position if under limit
      if (existingLong < maxLong) {
        const longPosition: BasePosition = {
          id: `base:${connectionId}:${indication.symbol}:${Date.now()}:long`,
          connectionId,
          connectionName: connection.name,
          symbol: indication.symbol,
          timeframe: indication.timeframe,
          direction: "long",
          entryPrice: indication.price,
          entryTime: Date.now(),
          indicationSignal: indication.signal,
          indicationStrength: indication.strength,
          status: "pending",
          sourceIndicationTimestamp: indication.timestamp,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        basePositions.push(longPosition)
        await storeBasePosition(client, longPosition)

        console.log(
          `${LOG_PREFIX} Created LONG base position ${longPosition.id} (strength: ${indication.strength.toFixed(2)})`
        )
      }

      // Generate SHORT position if under limit
      if (existingShort < maxShort) {
        const shortPosition: BasePosition = {
          id: `base:${connectionId}:${indication.symbol}:${Date.now()}:short`,
          connectionId,
          connectionName: connection.name,
          symbol: indication.symbol,
          timeframe: indication.timeframe,
          direction: "short",
          entryPrice: indication.price,
          entryTime: Date.now(),
          indicationSignal: indication.signal,
          indicationStrength: indication.strength,
          status: "pending",
          sourceIndicationTimestamp: indication.timestamp,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        basePositions.push(shortPosition)
        await storeBasePosition(client, shortPosition)

        console.log(
          `${LOG_PREFIX} Created SHORT base position ${shortPosition.id} (strength: ${indication.strength.toFixed(2)})`
        )
      }

      // If at limit, don't create more
      if (existingLong >= maxLong && existingShort >= maxShort) {
        console.log(
          `${LOG_PREFIX} Position limits reached for ${indication.symbol} (${existingLong}/${maxLong} long, ${existingShort}/${maxShort} short)`
        )
        continue
      }
    }

    console.log(`${LOG_PREFIX} Generated ${basePositions.length} base positions`)
    return basePositions
  } catch (err) {
    console.error(`${LOG_PREFIX} Error generating base positions: ${err}`)
    throw err
  }
}

/**
 * Store base position in Redis
 */
async function storeBasePosition(client: any, position: BasePosition): Promise<void> {
  const key = `base:position:${position.id}`
  const listKey = `base:positions:${position.connectionId}:${position.symbol}`

  try {
    // Store individual position
    await client.setex(key, 604800, JSON.stringify(position)) // 7 days

    // Add to list for quick access
    await client.lpush(listKey, JSON.stringify(position))
    await client.ltrim(listKey, 0, 999) // Keep max 1000 per symbol

    // Index by direction for counting
    const directionKey = `base:positions:${position.connectionId}:${position.symbol}:${position.direction}`
    await client.lpush(directionKey, position.id)
    await client.ltrim(directionKey, 0, 999)
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error storing base position: ${err}`)
  }
}

/**
 * Count existing positions in a direction
 */
async function countExistingPositions(
  client: any,
  connectionId: string,
  symbol: string,
  direction: "long" | "short"
): Promise<number> {
  try {
    const key = `base:positions:${connectionId}:${symbol}:${direction}`
    const count = await client.llen(key).catch(() => 0)
    return count || 0
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error counting positions: ${err}`)
    return 0
  }
}

/**
 * Get all base positions for connection
 */
export async function getBasePositions(connectionId: string): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const keys = await client.keys(`base:position:${connectionId}:*`)
    if (keys.length === 0) return []

    // Batch GETs into a single fan-out instead of a sequential await
    // loop. See real-stage / main-stage / live-stage for the same
    // pattern — at 250 positions this drops getBasePositions() from
    // ~250 RTTs down to roughly one RTT window.
    const rawValues = await Promise.all(
      keys.map((k: string) => client.get(k).catch(() => null)),
    )
    const positions: BasePosition[] = []
    for (const data of rawValues) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions: ${err}`)
    return []
  }
}

/**
 * Get base positions by symbol
 */
export async function getBasePositionsBySymbol(
  connectionId: string,
  symbol: string
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const listKey = `base:positions:${connectionId}:${symbol}`
    const positionStrs = await client.lrange(listKey, 0, -1)

    return positionStrs
      .map((p: string) => {
        try {
          return JSON.parse(p)
        } catch {
          return null
        }
      })
      .filter((p: any) => p !== null)
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions by symbol: ${err}`)
    return []
  }
}

/**
 * Get base positions by direction
 */
export async function getBasePositionsByDirection(
  connectionId: string,
  symbol: string,
  direction: "long" | "short"
): Promise<BasePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const directionKey = `base:positions:${connectionId}:${symbol}:${direction}`
    const positionIds = await client.lrange(directionKey, 0, -1)
    const positions: BasePosition[] = []

    for (const positionId of positionIds) {
      const key = `base:position:${positionId}`
      const data = await client.get(key)
      if (data) {
        positions.push(JSON.parse(data))
      }
    }

    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting base positions by direction: ${err}`)
    return []
  }
}

/**
 * Update base position status
 */
export async function updateBasePositionStatus(
  positionId: string,
  status: "pending" | "active" | "closed"
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `base:position:${positionId}`
    const data = await client.get(key)

    if (data) {
      const position: BasePosition = JSON.parse(data)
      position.status = status
      position.updatedAt = Date.now()

      await client.setex(key, 604800, JSON.stringify(position))
      console.log(`${LOG_PREFIX} Updated position ${positionId} status to ${status}`)
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error updating position status: ${err}`)
  }
}

/**
 * Clean up old base positions (older than 24 hours with closed status)
 */
export async function cleanupOldBasePositions(connectionId: string): Promise<number> {
  await initRedis()
  const client = getRedisClient()
  let cleaned = 0

  try {
    const keys = await client.keys(`base:position:${connectionId}:*`)
    if (keys.length === 0) return 0

    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours

    // Phase 1: batch-fetch every row in parallel.
    const rawValues = await Promise.all(
      keys.map((k: string) => client.get(k).catch(() => null)),
    )

    // Phase 2: collect the deletable keys, then DEL them in parallel.
    const deletable: string[] = []
    for (let i = 0; i < keys.length; i++) {
      const data = rawValues[i]
      if (!data) continue
      try {
        const position: BasePosition = JSON.parse(data as string)
        if (position.status === "closed" && now - position.updatedAt > maxAge) {
          deletable.push(keys[i])
        }
      } catch { /* skip malformed rows */ }
    }
    if (deletable.length > 0) {
      await Promise.all(deletable.map((k) => client.del(k).catch(() => 0)))
      cleaned = deletable.length
    }

    console.log(`${LOG_PREFIX} Cleaned up ${cleaned} old base positions`)
    return cleaned
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error cleaning up positions: ${err}`)
    return 0
  }
}
