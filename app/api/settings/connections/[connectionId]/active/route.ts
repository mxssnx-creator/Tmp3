import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

interface RouteParams {
  params: {
    connectionId: string
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { connectionId } = params

    if (!connectionId) {
      return NextResponse.json(
        { error: "Connection ID is required" },
        { status: 400 }
      )
    }

    console.log(`[v0] [RemoveConnection] Removing connection: ${connectionId}`)

    await initRedis()
    const redis = getRedisClient()

    if (!redis) {
      return NextResponse.json(
        { error: "Redis connection failed" },
        { status: 503 }
      )
    }

    try {
      // Get the connection details before deletion for logging
      const connKey = `connection:${connectionId}`
      const connData = await redis.get(connKey)
      const connName = connData ? JSON.parse(connData).name : connectionId

      console.log(`[v0] [RemoveConnection] Disabling connection: ${connName}`)

      // 1. Disable dashboard active status
      const dashboardActiveKey = `connection:${connectionId}:dashboard:active`
      await redis.del(dashboardActiveKey)

      // 2. Disable live trading
      const liveTradeKey = `connection:${connectionId}:live_trade`
      await redis.del(liveTradeKey)

      // 3. Stop any active engine for this connection
      const engineKey = `engine:${connectionId}:status`
      await redis.del(engineKey)

      // 4. Clear progression state
      const progressionKey = `progression:${connectionId}`
      await redis.del(progressionKey)

      // 5. Clean up indications and strategies data for this connection
      let cursor = "0"
      const keysToDelete: string[] = []

      // Scan for all connection-specific keys
      do {
        try {
          const result = await redis.scan(cursor, {
            match: `*:${connectionId}:*`,
            count: 100,
          })

          cursor = result[0]
          const keys = result[1] || []

          // Filter for connection-specific data
          for (const key of keys) {
            if (
              key.includes("indication") ||
              key.includes("strategy") ||
              key.includes("position") ||
              key.includes("trade") ||
              key.includes("progression")
            ) {
              keysToDelete.push(key)
            }
          }
        } catch (scanErr) {
          console.warn(`[v0] [RemoveConnection] Error during scan:`, scanErr)
          break
        }
      } while (cursor !== "0")

      // Delete all found keys in batch
      if (keysToDelete.length > 0) {
        console.log(`[v0] [RemoveConnection] Cleaning up ${keysToDelete.length} connection data keys`)
        await Promise.all(keysToDelete.map(key => redis.del(key)))
      }

      console.log(`[v0] [RemoveConnection] ✓ Successfully removed connection: ${connName}`)

      return NextResponse.json(
        {
          success: true,
          message: `Connection ${connName} has been removed`,
          connectionId,
          removedKeys: keysToDelete.length,
        },
        { status: 200 }
      )
    } catch (redisErr) {
      console.error(`[v0] [RemoveConnection] Redis error:`, redisErr)
      return NextResponse.json(
        { error: "Failed to remove connection from Redis" },
        { status: 503 }
      )
    }
  } catch (error) {
    console.error("[v0] [RemoveConnection] Fatal error:", error)
    return NextResponse.json(
      {
        error: "Failed to remove connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
