/**
 * Redis Persistence Manager - Pure In-Memory Local Redis
 * Uses local in-memory store for all state
 * No Upstash or external persistence
 */

export class UpstashSync {
  /**
   * Write a hash (no-op for local-only)
   */
  static async hset(key: string, fields: Record<string, string>): Promise<void> {
    // Local Redis is already in-memory, no external sync needed
    return
  }

  /**
   * Read a hash (no-op for local-only)
   */
  static async hgetall(key: string): Promise<Record<string, string> | null> {
    // Local Redis is already in-memory, no external sync needed
    return null
  }

  /**
   * Write a string (no-op for local-only)
   */
  static async set(key: string, value: string): Promise<void> {
    // Local Redis is already in-memory, no external sync needed
    return
  }

  /**
   * Read a string (no-op for local-only)
   */
  static async get(key: string): Promise<string | null> {
    // Local Redis is already in-memory, no external sync needed
    return null
  }
}

export class RedisPersistenceManager {
  static async saveSnapshot(redisStore: Map<string, any>): Promise<void> {
    const size = redisStore.size
    if (size > 0) {
      console.log(`[v0] [Persistence] In-memory store: ${size} keys`)
    }
  }

  static async loadSnapshot(): Promise<Map<string, any> | null> {
    console.log("[v0] [Persistence] Starting with pure in-memory local Redis")
    return null
  }

  static startPeriodicSnapshots(redisStore: Map<string, any>, intervalMs: number = 240000): void {
    const timer = setInterval(() => {
      const size = redisStore.size
      if (size > 0) {
        console.log(`[v0] [Persistence] In-memory store active: ${size} keys`)
      }
    }, intervalMs)
    timer.unref?.() // Don't block process exit
  }
}
