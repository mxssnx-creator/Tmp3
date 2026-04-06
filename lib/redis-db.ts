/**
 * Redis Database Layer
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

interface RedisData {
  strings: Map<string, string>
  hashes: Map<string, Record<string, string>>
  sets: Map<string, Set<string>>
  lists: Map<string, string[]>
  sorted_sets: Map<string, Array<{ score: number; member: string }>>
  ttl: Map<string, number> // key -> expiration timestamp in ms
  requestStats: {
    lastSecond: number
    requestCount: number
    operationsPerSecond: number
  }
}

// Global storage for persistence across hot reloads
const globalForRedis = globalThis as unknown as { __redis_data?: RedisData }

export class InlineLocalRedis {
  private data: RedisData

  constructor() {
    // Use global storage for persistence across hot reloads
    if (!globalForRedis.__redis_data) {
      globalForRedis.__redis_data = {
        strings: new Map(),
        hashes: new Map(),
        sets: new Map(),
        lists: new Map(),
        sorted_sets: new Map(),
        ttl: new Map(),
        requestStats: {
          lastSecond: Math.floor(Date.now() / 1000),
          requestCount: 0,
          operationsPerSecond: 0,
        },
      }
    }
    // Ensure ttl map exists for older data structures
    if (!globalForRedis.__redis_data.ttl) {
      globalForRedis.__redis_data.ttl = new Map()
    }
    this.data = globalForRedis.__redis_data
    
    // Run cleanup every 60 seconds to remove expired keys
    this.startTTLCleanup()
  }
  
  /**
   * Start periodic TTL cleanup to remove expired keys
   */
  private startTTLCleanup(): void {
    // Only start once per process
    const globalCleanup = globalThis as unknown as { __redis_cleanup_started?: boolean }
    if (globalCleanup.__redis_cleanup_started) return
    globalCleanup.__redis_cleanup_started = true
    
    const ttlCleanupTimer = setInterval(() => {
      this.cleanupExpiredKeys()
    }, 60000) // Every 60 seconds

    // Avoid blocking script/test process exit.
    ttlCleanupTimer.unref?.()
  }
  
  /**
   * Remove all expired keys
   * @returns Number of keys removed
   */
  private cleanupExpiredKeys(): number {
    const now = Date.now()
    const ttlMap = this.data.ttl
    if (!ttlMap) return 0
    
    let cleaned = 0
    for (const [key, expireAt] of ttlMap.entries()) {
      if (now >= expireAt) {
        this.deleteKey(key)
        ttlMap.delete(key)
        cleaned++
      }
    }
    
    if (cleaned > 0) {
      console.log(`[v0] [Redis] TTL cleanup: removed ${cleaned} expired keys`)
    }
    return cleaned
  }
  
  /**
   * Check if key is expired and delete if so
   */
  private isExpired(key: string): boolean {
    const ttlMap = this.data.ttl
    if (!ttlMap) return false
    
    const expireAt = ttlMap.get(key)
    if (expireAt && Date.now() >= expireAt) {
      this.deleteKey(key)
      ttlMap.delete(key)
      return true
    }
    return false
  }
  
  /**
   * Delete a key from all data structures
   */
  private deleteKey(key: string): void {
    this.data.strings.delete(key)
    this.data.hashes.delete(key)
    this.data.sets.delete(key)
    this.data.lists.delete(key)
    this.data.sorted_sets.delete(key)
    this.data.ttl?.delete(key)
  }
  
  /**
   * Set TTL for a key
   */
  private setKeyTTL(key: string, seconds: number): void {
    if (!this.data.ttl) {
      this.data.ttl = new Map()
    }
    this.data.ttl.set(key, Date.now() + seconds * 1000)
  }

  /**
   * Track a Redis operation for accurate requests per second calculation
   */
  private trackOperation(): void {
    const now = Math.floor(Date.now() / 1000)
    
    // Initialize requestStats if it doesn't exist (for existing data without this field)
    if (!this.data.requestStats) {
      this.data.requestStats = {
        lastSecond: now,
        requestCount: 0,
        operationsPerSecond: 0,
      }
    }
    
    const stats = this.data.requestStats
    
    if (now > stats.lastSecond) {
      // New second: save current count and reset
      stats.operationsPerSecond = stats.requestCount
      stats.requestCount = 1
      stats.lastSecond = now
      // Log high req/sec once per second when rolling over (not on every single operation)
      if (stats.operationsPerSecond > 100) {
        console.log(`[v0] [Redis] High request rate: ${stats.operationsPerSecond} ops/sec`)
      }
    } else {
      // Same second: increment count — no logging here to avoid log flood
      stats.requestCount++
    }
  }

  async ping() {
    return "PONG"
  }

  async info(): Promise<string> {
    this.trackOperation()
    const totalKeys = await this.dbSize()
    return [`redis_version:local-inline`, `db0:keys=${totalKeys}`, `uptime_in_seconds:${Math.floor(process.uptime())}`].join("\n")
  }

  async get(key: string): Promise<string | null> {
    this.trackOperation()
    if (this.isExpired(key)) return null
    return this.data.strings.get(key) ?? null
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<void> {
    this.trackOperation()
    this.data.strings.set(key, value)
    if (options?.EX) {
      this.setKeyTTL(key, options.EX)
    }
  }
  
  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.trackOperation()
    this.data.strings.set(key, value)
    this.setKeyTTL(key, seconds)
  }

  async incr(key: string): Promise<number> {
    this.trackOperation()
    if (this.isExpired(key)) {
      this.data.strings.set(key, "1")
      return 1
    }
    const current = parseInt(this.data.strings.get(key) || "0", 10)
    const newValue = current + 1
    this.data.strings.set(key, String(newValue))
    return newValue
  }

  async del(...keys: string[]): Promise<number> {
    this.trackOperation()
    let count = 0
    for (const key of keys) {
      const exists = this.data.strings.has(key) ||
        this.data.hashes.has(key) ||
        this.data.sets.has(key) ||
        this.data.lists.has(key) ||
        this.data.sorted_sets.has(key)

      if (exists) {
        this.deleteKey(key)
        count++
      }
    }
    return count
  }

  async flushDb(): Promise<void> {
    this.trackOperation()
    this.data.strings.clear()
    this.data.hashes.clear()
    this.data.sets.clear()
    this.data.lists.clear()
    this.data.sorted_sets.clear()
    this.data.ttl?.clear()
  }

  async hset(key: string, data: Record<string, string>): Promise<number> {
    this.trackOperation()
    const existing = this.data.hashes.get(key) || {}
    const updates = Object.keys(data).length
    this.data.hashes.set(key, { ...existing, ...data })
    return updates
  }

  async hmset(...args: string[]): Promise<void> {
    if (args.length < 3) return
    const key = args[0]
    const obj: Record<string, string> = {}
    for (let i = 1; i < args.length; i += 2) {
      obj[args[i]] = args[i + 1]
    }
    this.data.hashes.set(key, { ...this.data.hashes.get(key), ...obj })
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    this.trackOperation()
    if (this.isExpired(key)) return null
    return this.data.hashes.get(key) ?? null
  }

  async hlen(key: string): Promise<number> {
    this.trackOperation()
    const hash = this.data.hashes.get(key)
    return hash ? Object.keys(hash).length : 0
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.trackOperation()
    if (this.isExpired(key)) return null
    const hash = this.data.hashes.get(key)
    return hash?.[field] ?? null
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.trackOperation()
    const hash = this.data.hashes.get(key)
    if (!hash) return 0
    let deleted = 0
    for (const field of fields) {
      if (field in hash) {
        delete hash[field]
        deleted++
      }
    }
    if (Object.keys(hash).length === 0) {
      this.data.hashes.delete(key)
    }
    return deleted
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    this.trackOperation()
    const hash = this.data.hashes.get(key) || {}
    const currentValue = parseInt(hash[field] || "0", 10)
    const newValue = currentValue + increment
    hash[field] = String(newValue)
    this.data.hashes.set(key, hash)
    return newValue
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<number> {
    this.trackOperation()
    const hash = this.data.hashes.get(key) || {}
    const currentValue = parseFloat(hash[field] || "0")
    const newValue = currentValue + increment
    hash[field] = String(newValue)
    this.data.hashes.set(key, hash)
    return newValue
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.trackOperation()
    const set = this.data.sets.get(key) || new Set()
    const sizeBefore = set.size
    for (const member of members) {
      if (member) set.add(member)
    }
    this.data.sets.set(key, set)
    return set.size - sizeBefore
  }

  async scard(key: string): Promise<number> {
    this.trackOperation()
    if (this.isExpired(key)) return 0
    return this.data.sets.get(key)?.size ?? 0
  }

  async smembers(key: string): Promise<string[]> {
    this.trackOperation()
    if (this.isExpired(key)) return []
    return Array.from(this.data.sets.get(key) || new Set())
  }

  async sismember(key: string, member: string): Promise<number> {
    this.trackOperation()
    if (this.isExpired(key)) return 0
    const set = this.data.sets.get(key)
    return set?.has(member) ? 1 : 0
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    this.trackOperation()
    const set = this.data.sets.get(key)
    if (!set) return 0
    let removed = 0
    for (const member of members) {
      if (set.delete(member)) removed++
    }
    if (set.size === 0) this.data.sets.delete(key)
    else this.data.sets.set(key, set)
    return removed
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.trackOperation()
    // Check if key exists in any data structure
    const exists = this.data.strings.has(key) || 
                   this.data.hashes.has(key) || 
                   this.data.sets.has(key) ||
                   this.data.lists.has(key) ||
                   this.data.sorted_sets.has(key)
    if (exists) {
      this.setKeyTTL(key, seconds)
      return 1
    }
    return 0
  }

  // ========== List Operations ==========

  async lpush(key: string, ...values: string[]): Promise<number> {
    this.trackOperation()
    const list = this.data.lists.get(key) || []
    // lpush adds to the beginning of the list
    for (let i = values.length - 1; i >= 0; i--) {
      list.unshift(values[i])
    }
    this.data.lists.set(key, list)
    return list.length
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.trackOperation()
    const list = this.data.lists.get(key) || []
    // rpush adds to the end of the list
    list.push(...values)
    this.data.lists.set(key, list)
    return list.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.trackOperation()
    if (this.isExpired(key)) return []
    const list = this.data.lists.get(key) || []
    // Handle negative indices like Redis
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    return list.slice(normalizedStart, normalizedStop + 1)
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    this.trackOperation()
    const list = this.data.lists.get(key)
    if (!list) return
    // Handle negative indices like Redis
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    const trimmed = list.slice(normalizedStart, normalizedStop + 1)
    this.data.lists.set(key, trimmed)
  }

  async llen(key: string): Promise<number> {
    this.trackOperation()
    if (this.isExpired(key)) return 0
    return this.data.lists.get(key)?.length ?? 0
  }

  async dbSize(): Promise<number> {
    this.trackOperation()
    // Clean up expired keys first for accurate count
    this.cleanupExpiredKeys() // ignore return value
    return this.data.strings.size + this.data.hashes.size + this.data.sets.size + this.data.lists.size + this.data.sorted_sets.size
  }

  async keys(pattern: string): Promise<string[]> {
    this.trackOperation()
    // Convert Redis glob pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    const regex = new RegExp(`^${regexPattern}$`)

    const uniqueKeys = new Set<string>()
    const keyCollections = [
      this.data.strings.keys(),
      this.data.hashes.keys(),
      this.data.sets.keys(),
      this.data.lists.keys(),
      this.data.sorted_sets.keys(),
    ]

    for (const collection of keyCollections) {
      for (const key of collection) {
        if (this.isExpired(key)) continue
        if (regex.test(key)) uniqueKeys.add(key)
      }
    }

    return Array.from(uniqueKeys)
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.trackOperation()
    const set = this.data.sorted_sets.get(key) || []
    const existingIndex = set.findIndex((entry) => entry.member === member)
    if (existingIndex >= 0) {
      set[existingIndex] = { score, member }
      this.data.sorted_sets.set(key, set.sort((a, b) => a.score - b.score))
      return 0
    }
    set.push({ score, member })
    this.data.sorted_sets.set(key, set.sort((a, b) => a.score - b.score))
    return 1
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    this.trackOperation()
    if (this.isExpired(key)) return []
    const set = this.data.sorted_sets.get(key) || []
    const minValue = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const maxValue = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    return set.filter((entry) => entry.score >= minValue && entry.score <= maxValue).map((entry) => entry.member)
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    this.trackOperation()
    const set = this.data.sorted_sets.get(key) || []
    const minValue = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const maxValue = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    const before = set.length
    const remaining = set.filter((entry) => entry.score < minValue || entry.score > maxValue)
    if (remaining.length === 0) this.data.sorted_sets.delete(key)
    else this.data.sorted_sets.set(key, remaining)
    return before - remaining.length
  }

  /**
   * Track database write operations for per-minute limit enforcement
   * Uses a sliding 60-second window stored in memory
   * Returns: { current: count, limit: max_allowed, exceeded: boolean }
   */
  async trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    const now = Date.now()
    
    // Initialize tracker on first call
    if (!globalTracker.__db_ops_tracker) {
      globalTracker.__db_ops_tracker = { timestamp: now, count: 0 }
    }
    
    const tracker = globalTracker.__db_ops_tracker
    const windowStart = now - 60000 // 60 second window in milliseconds
    
    // Reset counter if window has expired (new minute)
    if (tracker.timestamp < windowStart) {
      tracker.timestamp = now
      tracker.count = 0
    }
    
    // Increment operation count
    tracker.count++
    tracker.timestamp = now
    
    // Return current status
    return {
      current: tracker.count,
      limit: limit,
      exceeded: limit > 0 && tracker.count > limit,
    }
  }

  /**
   * Get current per-minute operation count
   */
  async getDatabaseOperationCount(): Promise<number> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    if (!globalTracker.__db_ops_tracker) return 0
    
    const now = Date.now()
    const windowStart = now - 60000
    
    // If window has expired, count is 0
    if (globalTracker.__db_ops_tracker.timestamp < windowStart) {
      return 0
    }
    
    return globalTracker.__db_ops_tracker.count
  }

  async load(): Promise<void> {
    // No-op: data is already in global memory
  }

  /**
   * Public wrapper for cleanupExpiredKeys for monitoring systems
   */
  async cleanupExpiredKeysPublic(): Promise<number> {
    return this.cleanupExpiredKeys()
  }

  /**
   * Check if key exists in any data structure
   */
  async exists(key: string): Promise<number> {
    const exists = this.data.strings.has(key) || 
                   this.data.hashes.has(key) || 
                   this.data.sets.has(key) ||
                   this.data.lists.has(key) ||
                   this.data.sorted_sets.has(key)
    return exists ? 1 : 0
  }

  /**
   * Get TTL for a key (returns -1 if no TTL, -2 if key doesn't exist)
   */
  async ttl(key: string): Promise<number> {
    const ttlMap = this.data.ttl
    if (!ttlMap || !ttlMap.has(key)) {
      // Check if key exists at all
      const existsResult = await this.exists(key)
      if (existsResult === 0) return -2 // key doesn't exist
      return -1 // key exists but has no expiry
    }
    
    const expireAt = ttlMap.get(key)!
    const now = Date.now()
    if (now >= expireAt) {
      return -2 // Expired (treat as non-existent)
    }
    
    return Math.floor((expireAt - now) / 1000) // Return seconds
  }
}

let redisInstance: InlineLocalRedis | null = null
let isConnected = false
let connectionsInitialized = false
let migrationsRan = false

export async function initRedis(): Promise<void> {
  if (isConnected) return

  if (!redisInstance) {
    redisInstance = new InlineLocalRedis()
    await redisInstance.load()
  }

  isConnected = true
  console.log("[v0] [Redis] Client initialized with persistence")

  const pong = await redisInstance.ping()
  if (pong === "PONG") {
    console.log("[v0] [Redis] Connection test successful")
  }

  // Run migrations on first connection (lazy initialization)
  if (!migrationsRan) {
    try {
      migrationsRan = true
      console.log("[v0] [Redis] Running migrations...")
      const { runMigrations } = await import("@/lib/redis-migrations")
      await runMigrations()
      console.log("[v0] [Redis] ✓ Migrations completed")
    } catch (error) {
      console.error("[v0] [Redis] Migration error (continuing anyway):", error)
      migrationsRan = true // Prevent retry loop
    }
  }

  // NOTE: Do NOT initialize user-created connections here
  // Migrations 011-016 already set up all 15 predefined template connections
  // and mark 4 as "base" (is_inserted=1, is_enabled=1, is_active_inserted=1)
  // Creating separate "conn-*" connections would create duplicates on dashboard
  if (!connectionsInitialized) {
    connectionsInitialized = true
    console.log("[v0] [Connections] ✓ Connection initialization skipped (handled by migrations 011-016)")
  }
}

export function getClient(): InlineLocalRedis {
  if (!redisInstance) {
    redisInstance = new InlineLocalRedis()
    isConnected = true
  }
  return redisInstance
}

export function isRedisConnected(): boolean {
  return isConnected
}

// ========== Helpers ==========

function convertToString(value: any): string {
  // Handle booleans specially
  if (value === true) return "1"
  if (value === false) return "0"
  // Handle null/undefined
  if (value === null || value === undefined) return ""
  // Convert everything else to string
  return String(value)
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function flattenForHmset(obj: Record<string, string>): string[] {
  const args: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    args.push(k, v)
  }
  return args
}

// ========== Connection Operations ==========

export async function getAllConnections(): Promise<any[]> {
  const client = getClient()
  const connIds = await client.smembers("connections")

  if (!connIds || connIds.length === 0) {
    console.log("[v0] [Connections] No connections found in set")
    return []
  }

  const connectionRecords = await Promise.all(connIds.map((id) => client.hgetall(`connection:${id}`)))
  return connectionRecords.filter((data): data is Record<string, string> => !!data && Object.keys(data).length > 0)
}

export async function getConnection(id: string): Promise<any | null> {
  const client = getClient()
  const data = await client.hgetall(`connection:${id}`)
  return data && Object.keys(data).length > 0 ? data : null
}

export async function createConnection(data: Record<string, any>): Promise<void> {
  const client = getClient()
  const id = data.id
  if (!id) throw new Error("Connection ID is required")

  const flattened: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    flattened[k] = convertToString(v)
  }

  await client.hset(`connection:${id}`, flattened)
  await client.sadd("connections", id)
}

export async function updateConnection(id: string, updates: Record<string, any>): Promise<void> {
  const client = getClient()
  const flattened: Record<string, string> = {}
  for (const [k, v] of Object.entries(updates)) {
    flattened[k] = convertToString(v)
  }

  await client.hset(`connection:${id}`, flattened)
}

export async function deleteConnection(id: string): Promise<void> {
  const client = getClient()
  await client.del(`connection:${id}`)
  await client.srem("connections", id)
}

// ========== Settings Operations ==========

export async function setSettings(key: string, value: any): Promise<void> {
  const client = getClient()
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  await client.set(`settings:${key}`, serialized)
}

export async function getSettings(key: string): Promise<any | null> {
  const client = getClient()
  const value = await client.get(`settings:${key}`)
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    // Return null on parse failure to maintain consistent return type
    console.warn(`[v0] [Redis] getSettings: Failed to parse ${key}, returning null`)
    return null
  }
}

// ========== Market Data ==========

export async function saveMarketData(symbol: string, data: any): Promise<void> {
  const client = getClient()
  const key = `market_data:${symbol}`
  await client.set(key, JSON.stringify(data))
}

// Track last indication generation per symbol to avoid flooding
const indicationGenerationTracker = new Map<string, number>()
const INDICATION_GENERATION_INTERVAL = 2000 // 2 seconds

// Auto-generate indications when market data is fetched
// This bypasses the broken IndicationProcessor class which has cache initialization issues
async function autoGenerateIndications(symbol: string, marketData: any, client: InlineLocalRedis) {
  const now = Date.now()
  const lastGenerated = indicationGenerationTracker.get(symbol) || 0
  
  if (now - lastGenerated < INDICATION_GENERATION_INTERVAL) {
    return // Skip if generated recently
  }
  
  indicationGenerationTracker.set(symbol, now)
  
  try {
    const close = parseFloat(marketData?.close || marketData?.c || "0")
    const open = parseFloat(marketData?.open || marketData?.o || "0")
    const high = parseFloat(marketData?.high || marketData?.h || "0")
    const low = parseFloat(marketData?.low || marketData?.l || "0")
    
    if (close === 0) return
    
    const direction = close >= open ? "long" : "short"
    const range = high - low
    const rangePercent = (range / close) * 100
    
    const indications = [
      { type: "direction", symbol, value: direction === "long" ? 1 : -1, profitFactor: 1.2, confidence: 0.7, timestamp: now },
      { type: "move", symbol, value: rangePercent > 2 ? 1 : 0, profitFactor: 1.0 + rangePercent/100, confidence: 0.6, timestamp: now },
      { type: "active", symbol, value: rangePercent > 1 ? 1 : 0, profitFactor: 1.1, confidence: 0.65, timestamp: now },
      { type: "optimal", symbol, value: direction === "long" && rangePercent > 1.5 ? 1 : 0, profitFactor: 1.3, confidence: 0.75, timestamp: now },
    ]
    
    // Get active connections and save indications for each
    const connMembers = await client.smembers("connections").catch(() => [])
    for (const connId of connMembers) {
      const connData = await client.hgetall(`connection:${connId}`).catch(() => ({}))
      if (connData?.isActive === "true" || connData?.is_active === "true") {
        const key = `indications:${connId}`
        const existing = await client.get(key).catch(() => null)
        const existingArr = existing ? JSON.parse(existing) : []
        existingArr.push(...indications)
        // Keep last 1000
        const trimmed = existingArr.slice(-1000)
        await client.set(key, JSON.stringify(trimmed))
      }
    }
  } catch (e) {
    // Silently ignore indication generation errors
  }
}

export async function getMarketData(symbol: string): Promise<any | null> {
  const client = getClient()
  
  // Priority 1: Check hash format (used by market-data-loader.ts via hmset)
  const hashData = await client.hgetall(`market_data:${symbol}`)
  if (hashData && Object.keys(hashData).length > 0) {
    // Auto-generate indications when market data is fetched
    autoGenerateIndications(symbol, hashData, client).catch(() => {})
    return hashData
  }
  
  // Priority 2: Check string format (fallback for older data)
  const value = await client.get(`market_data:${symbol}`)
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    // Auto-generate indications when market data is fetched
    autoGenerateIndications(symbol, parsed, client).catch(() => {})
    return parsed
  } catch {
    return null
  }
}

// ========== Migration State ==========

export async function setMigrationsRun(): Promise<void> {
  const client = getClient()
  await client.set("_migrations_run", "true")
  ;(globalThis as any).__migrations_run = true
}

export function haveMigrationsRun(): boolean {
  // Process-local guard to avoid repeated migration scans in the same runtime.
  return (globalThis as any).__migrations_run === true
}

// ========== Aliases for backward compatibility ==========

// Alias: getRedisClient -> getClient (used by many modules)
export function getRedisClient(): InlineLocalRedis {
  return getClient()
}

// Alias: saveConnection -> createConnection (used by some modules)
export async function saveConnection(data: Record<string, any>): Promise<void> {
  return createConnection(data)
}

// Additional aliases for direct exports
export const redisGetSettings = getSettings;
export const redisSetSettings = setSettings;

// ========== Additional operations for compatibility ==========

export async function deleteSettings(key: string): Promise<void> {
  const client = getClient()
  await client.del(`settings:${key}`)
}

export async function flushAll(): Promise<void> {
  // Clear all data - dangerous operation
  const client = getClient()
  
  // Clear all connection data
  const connKeys = await client.smembers("connections")
  for (const k of connKeys) {
    await client.del(`connection:${k}`)
  }
  await client.del("connections")
  
  // Clear all other data sets
  const dataSets = [
    "connections:bybit", "connections:bingx", "connections:pionex", "connections:orangex",
    "connections:active", "connections:inactive",
    "trades:all", "trades:open", "trades:closed", "trades:pending",
    "positions:all", "positions:open", "positions:closed",
    "indications", "strategies", "presets",
  ]
  
  for (const setKey of dataSets) {
    const keys = await client.smembers(setKey).catch(() => [])
    for (const key of keys) {
      await client.del(`${setKey}:${key}`)
    }
    await client.del(setKey)
  }
  
  // Clear all settings
  const allKeys = await client.keys("settings:*").catch(() => [])
  for (const key of allKeys) {
    await client.del(key)
  }
  
  // Clear all cache
  const cacheKeys = await client.keys("cache:*").catch(() => [])
  for (const key of cacheKeys) {
    await client.del(key)
  }
  
  console.log("[v0] [Redis] flushAll called - cleared all data")
}

export async function getIndications(key: string): Promise<any[]> {
  const client = getClient()
  // Support both formats: full key ("indications:conn-id") or just connection ID ("conn-id")
  const actualKey = key.startsWith("indications:") ? key : `indications:${key}`
  const value = await client.get(actualKey)
  if (!value) return []
  try {
    return JSON.parse(value)
  } catch {
    return []
  }
}

export async function saveIndication(key: string, indication: any): Promise<void> {
  const client = getClient()
  // Support both formats: full key ("indications:conn-id") or just connection ID ("conn-id")
  const actualKey = key.startsWith("indications:") ? key : `indications:${key}`
  const existing = await getIndications(actualKey)
  existing.push(indication)
  // Keep last 1000 indications
  const trimmed = existing.slice(-1000)
  await client.set(actualKey, JSON.stringify(trimmed))
}

export async function getRedisStats(): Promise<any> {
  const client = getClient()
  const size = await client.dbSize()
  const allKeys = await client.keys("*").catch(() => [])
  const keyCount = Array.isArray(allKeys) ? allKeys.length : size
  return {
    connected: isConnected,
    dbSize: size,
    keyCount: keyCount,
    total_keys: keyCount,
    uptimeSeconds: process.uptime(),
    uptime_seconds: process.uptime(),
    memory_used: "N/A",
  }
}

export function getRedisRequestsPerSecond(): number {
  // Get the accurate requests per second from tracking
  const globalData = globalThis as unknown as { __redis_data?: RedisData }
  if (!globalData.__redis_data?.requestStats) return 0

  const now = Math.floor(Date.now() / 1000)
  const stats = globalData.__redis_data.requestStats

  // If there were no operations in the previous second window, report 0.
  if (now - stats.lastSecond > 1) {
    return 0
  }

  // Return the operations from the last completed second
  const rps = stats.operationsPerSecond
  return Math.max(0, rps)
}

export async function verifyRedisHealth(): Promise<{ healthy: boolean; message: string }> {
  try {
    const client = getClient()
    const pong = await client.ping()
    return { healthy: pong === "PONG", message: "Redis is healthy" }
  } catch (e) {
    return { healthy: false, message: e instanceof Error ? e.message : "Unknown error" }
  }
}

// ========== Connection Queries ==========

export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const allConnections = await getAllConnections()
  // Filter for connections that are:
  // 1. Added to active panel AND explicitly enabled on dashboard
  // 2. Either has credentials OR is set to testnet/demo mode
  const filtered = allConnections.filter((c: any) => {
    const isActiveInserted = isEnabledFlag(c.is_active_inserted)
    const isDashboardEnabled = isEnabledFlag(c.is_enabled_dashboard)
    
    // Check for credentials (from connection OR from environment)
    const apiKey = c.api_key || c.apiKey || ""
    const apiSecret = c.api_secret || c.apiSecret || ""
    const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
    
    // Check for testnet/demo/predefined mode
    const isTestnet = isEnabledFlag(c.is_testnet)
    const isDemoMode = isEnabledFlag(c.demo_mode)
    const isPredefined = isEnabledFlag(c.is_predefined)
    
    // Engine processing follows dashboard activation, not settings-default enabled state.
    const isReadyForEngine = isActiveInserted && isDashboardEnabled
    
    // Allow with credentials OR testnet/demo/predefined mode (credentials checked per-operation)
    return isReadyForEngine && (hasCredentials || isTestnet || isDemoMode || isPredefined)
  })
  
  console.log(`[v0] [Engine] Active connections for engine: ${filtered.length} (from ${allConnections.length} total)`)
  return filtered
}

export async function getEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter((c: any) => isEnabledFlag(c.is_enabled))
}

export async function getAssignedAndEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  // Return connections that are:
  // 1. Active-inserted into Active panel (is_active_inserted="1")
  // 2. AND dashboard-enabled (is_enabled_dashboard="1")
  // This is the filter used by the trade engine coordinator to find active connections
  return allConnections.filter((c: any) => {
    // Check for active panel flags (modern approach)
    const isActiveInserted = isEnabledFlag(c.is_active_inserted)
    const isDashboardEnabled = isEnabledFlag(c.is_enabled_dashboard)
    return isActiveInserted && isDashboardEnabled
  })
}

// ========== Clean Connection State Model ==========
// Organizes chaos: base connections (Settings) vs main connections (Dashboard/Active)
// 
// BASE CONNECTIONS (Settings panel):
// - base_enabled: maps to is_enabled - connection is enabled in Settings
// - base_inserted: maps to is_inserted - connection exists in Settings
//
// MAIN CONNECTIONS (Dashboard/Active panel):
// - main_enabled: maps to is_enabled_dashboard - connection is enabled in Main Connections
// - main_assigned: maps to is_active_inserted - connection is assigned to Main Connections
//
// This eliminates the confusing doubled states (is_enabled, is_dashboard_inserted, etc.)

export interface ConnectionState {
  base_enabled: boolean
  base_inserted: boolean
  main_enabled: boolean
  main_assigned: boolean
  is_active: boolean  // derived: main_assigned && main_enabled
}

/**
 * Get clean connection state from a connection object
 * Normalizes all the confusing doubled states into a clean model
 */
export function getConnectionState(connection: any): ConnectionState {
  return {
    // Base Connection states (Settings)
    base_enabled: isEnabledFlag(connection.is_enabled),
    base_inserted: isEnabledFlag(connection.is_inserted),
    
    // Main Connection states (Dashboard/Active)
    main_enabled: isEnabledFlag(connection.is_enabled_dashboard),
    main_assigned: isEnabledFlag(connection.is_active_inserted),
    
    // Derived: active for processing = assigned AND enabled in main
    is_active: isEnabledFlag(connection.is_active_inserted) && isEnabledFlag(connection.is_enabled_dashboard),
  }
}

  /**
   * Track operation count for monitoring (disabled for now due to log flood)
   * High-frequency operations at 75K+/sec cause event loop blocking when logging
   */
  private trackOperation(): void {
    // DISABLED: Tracking causes massive log flood at high ops/sec
    // This was blocking the event loop and hanging the server
    // Re-enable only if needed for debugging, with proper sampling
  }

/**
 * Check if connection is active (assigned to Main Connections)
 */
export function isConnectionAssignedToMain(connection: any): boolean {
  return isEnabledFlag(connection.is_active_inserted)
}

/**
 * Check if connection is enabled in Main Connections
 */
export function isConnectionMainEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled_dashboard)
}

/**
 * Check if connection is enabled in Settings (Base)
 */
export function isConnectionBaseEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled)
}

/**
 * Build connection update object for enabling in Main Connections
 * Sets both main_assigned and main_enabled
 */
export function buildMainConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    // Main Connection states
    is_enabled_dashboard: "1",  // main_enabled = true
    is_dashboard_inserted: "1",  // backward compatibility
    is_active_inserted: "1",     // main_assigned = true
    is_active: "1",              // active for processing
    
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build connection update object for disabling in Main Connections
 * Disables main but keeps base states intact
 */
export function buildMainConnectionDisableUpdate(connection: any): any {
  return {
    ...connection,
    // Main Connection states - disable
    is_enabled_dashboard: "0",  // main_enabled = false
    is_active: "0",             // not active for processing
    // Keep is_active_inserted = "1" so it stays in active panel (just disabled)
    
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build connection update object for removing from Main Connections
 * Completely unassigns the connection from the main panel
 */
export function buildMainConnectionRemoveUpdate(connection: any): any {
  return {
    ...connection,
    // Main Connection states - remove completely
    is_active_inserted: "0",      // main_assigned = false
    is_dashboard_inserted: "0",   // remove dashboard insertion
    is_enabled_dashboard: "0",    // main_enabled = false
    is_active: "0",               // not active for processing
    
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build connection update object for enabling in Settings (Base)
 */
export function buildBaseConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    // Base Connection states
    is_enabled: "1",   // base_enabled = true
    is_inserted: "1",  // base_inserted = true
    
    updated_at: new Date().toISOString(),
  }
}

// ========== Stats Operations ==========

export async function closeRedis(): Promise<void> {
  // No-op for in-memory implementation
  isConnected = false
}

// ========== Position Operations ==========

export async function createPosition(data: Record<string, any>): Promise<void> {
  const client = getClient()
  const id = data.id || `pos_${Date.now()}`
  const flattened: Record<string, string> = { id }
  for (const [k, v] of Object.entries(data)) {
    flattened[k] = convertToString(v)
  }
  await client.hset(`position:${id}`, flattened)
  await client.sadd("positions", id)
  const connectionId = data.connection_id || data.connectionId
  if (connectionId) {
    await client.sadd(`positions:by-connection:${connectionId}`, id)
  }
}

export async function getPosition(id: string): Promise<any | null> {
  const client = getClient()
  const data = await client.hgetall(`position:${id}`)
  return data && Object.keys(data).length > 0 ? data : null
}

export async function updatePosition(id: string, updates: Record<string, any>): Promise<void> {
  const client = getClient()
  const existing = await getPosition(id)
  const flattened: Record<string, string> = {}
  for (const [k, v] of Object.entries(updates)) {
    flattened[k] = convertToString(v)
  }
  await client.hset(`position:${id}`, flattened)

  const previousConnectionId = existing?.connection_id
  const newConnectionId = updates.connection_id || updates.connectionId
  if (previousConnectionId && newConnectionId && previousConnectionId !== newConnectionId) {
    await client.srem(`positions:by-connection:${previousConnectionId}`, id)
    await client.sadd(`positions:by-connection:${newConnectionId}`, id)
  } else if (newConnectionId) {
    await client.sadd(`positions:by-connection:${newConnectionId}`, id)
  }
}

export async function deletePosition(id: string): Promise<void> {
  const client = getClient()
  const existing = await getPosition(id)
  await client.del(`position:${id}`)
  await client.srem("positions", id)
  if (existing?.connection_id) {
    await client.srem(`positions:by-connection:${existing.connection_id}`, id)
  }
}

export async function getConnectionPositions(connectionId: string): Promise<any[]> {
  const client = getClient()
  const indexedIds = await client.smembers(`positions:by-connection:${connectionId}`)
  if (indexedIds.length > 0) {
    const positions = await Promise.all(indexedIds.map((id) => getPosition(id)))
    const staleIds = indexedIds.filter((_, index) => !positions[index])
    if (staleIds.length > 0) {
      await client.srem(`positions:by-connection:${connectionId}`, ...staleIds)
    }
    return positions.filter(Boolean)
  }

  // Backward-compat fallback: scan global set once and hydrate per-connection index.
  const positionIds = await client.smembers("positions")
  const positions = await Promise.all(positionIds.map((id) => getPosition(id)))
  const filtered = positions.filter((pos) => pos && pos.connection_id === connectionId)
  if (filtered.length > 0) {
    await client.sadd(`positions:by-connection:${connectionId}`, ...filtered.map((pos) => pos.id))
  }
  return filtered
}

// ========== Trade Operations ==========

export async function createTrade(data: Record<string, any>): Promise<void> {
  const client = getClient()
  const id = data.id || `trade_${Date.now()}`
  const flattened: Record<string, string> = { id }
  for (const [k, v] of Object.entries(data)) {
    flattened[k] = convertToString(v)
  }
  await client.hset(`trade:${id}`, flattened)
  await client.sadd("trades", id)
  const connectionId = data.connection_id || data.connectionId
  if (connectionId) {
    await client.sadd(`trades:by-connection:${connectionId}`, id)
  }
}

export async function getTrade(id: string): Promise<any | null> {
  const client = getClient()
  const data = await client.hgetall(`trade:${id}`)
  return data && Object.keys(data).length > 0 ? data : null
}

export async function updateTrade(id: string, updates: Record<string, any>): Promise<void> {
  const client = getClient()
  const existing = await getTrade(id)
  const flattened: Record<string, string> = {}
  for (const [k, v] of Object.entries(updates)) {
    flattened[k] = convertToString(v)
  }
  await client.hset(`trade:${id}`, flattened)

  const previousConnectionId = existing?.connection_id
  const newConnectionId = updates.connection_id || updates.connectionId
  if (previousConnectionId && newConnectionId && previousConnectionId !== newConnectionId) {
    await client.srem(`trades:by-connection:${previousConnectionId}`, id)
    await client.sadd(`trades:by-connection:${newConnectionId}`, id)
  } else if (newConnectionId) {
    await client.sadd(`trades:by-connection:${newConnectionId}`, id)
  }
}

export async function getConnectionTrades(connectionId: string): Promise<any[]> {
  const client = getClient()
  const indexedIds = await client.smembers(`trades:by-connection:${connectionId}`)
  if (indexedIds.length > 0) {
    const trades = await Promise.all(indexedIds.map((id) => getTrade(id)))
    const staleIds = indexedIds.filter((_, index) => !trades[index])
    if (staleIds.length > 0) {
      await client.srem(`trades:by-connection:${connectionId}`, ...staleIds)
    }
    return trades.filter(Boolean)
  }

  // Backward-compat fallback: scan global set once and hydrate per-connection index.
  const tradeIds = await client.smembers("trades")
  const trades = await Promise.all(tradeIds.map((id) => getTrade(id)))
  const filtered = trades.filter((trade) => trade && trade.connection_id === connectionId)
  if (filtered.length > 0) {
    await client.sadd(`trades:by-connection:${connectionId}`, ...filtered.map((trade) => trade.id))
  }
  return filtered
}

export interface Connection {
  id: string
  name: string
  exchange: string
  api_key: string
  api_secret: string
  api_passphrase?: string
  api_type?: string
  api_subtype?: string
  connection_method?: string
  connection_library?: string
  margin_type?: string
  position_mode?: string
  is_testnet?: boolean
  is_enabled?: boolean
  is_enabled_dashboard?: boolean
  is_live_trade?: boolean
  is_active?: boolean
  is_predefined?: boolean
  is_inserted?: boolean
  is_active_inserted?: boolean
  demo_mode?: boolean
  created_at?: string
  updated_at?: string
  last_test_log?: string[]
  last_test_status?: string
  last_test_balance?: number
  last_test_error?: string
  last_test_timestamp?: string
  last_test_btc_price?: number
  last_test_at?: string
  [key: string]: any
}

export const redisDb = {
  get: async (key: string): Promise<string | null> => {
    const client = getClient()
    return client.get(key)
  },
  set: async (key: string, value: string, options?: { ex?: number }): Promise<void> => {
    const client = getClient()
    if (options?.ex) {
      await client.setex(key, options.ex, value)
    } else {
      await client.set(key, value)
    }
  },
  del: async (key: string): Promise<number> => {
    const client = getClient()
    return client.del(key)
  },
  hget: async (key: string, field: string): Promise<string | null> => {
    const client = getClient()
    return client.hget(key, field)
  },
  hset: async (key: string, data: Record<string, string>): Promise<number> => {
    const client = getClient()
    return client.hset(key, data)
  },
  hgetall: async (key: string): Promise<Record<string, string> | null> => {
    const client = getClient()
    return client.hgetall(key)
  },
  hdel: async (key: string, ...fields: string[]): Promise<number> => {
    const client = getClient()
    return client.hdel(key, ...fields)
  },
  sadd: async (key: string, ...members: string[]): Promise<number> => {
    const client = getClient()
    return client.sadd(key, ...members)
  },
  smembers: async (key: string): Promise<string[]> => {
    const client = getClient()
    return client.smembers(key)
  },
  srem: async (key: string, ...members: string[]): Promise<number> => {
    const client = getClient()
    return client.srem(key, ...members)
  },
  keys: async (pattern: string): Promise<string[]> => {
    const client = getClient()
    return client.keys(pattern)
  },
  expire: async (key: string, seconds: number): Promise<number> => {
    const client = getClient()
    return client.expire(key, seconds)
  },
  lpush: async (key: string, ...values: string[]): Promise<number> => {
    const client = getClient()
    return client.lpush(key, ...values)
  },
  rpush: async (key: string, ...values: string[]): Promise<number> => {
    const client = getClient()
    return client.rpush(key, ...values)
  },
  lrange: async (key: string, start: number, stop: number): Promise<string[]> => {
    const client = getClient()
    return client.lrange(key, start, stop)
  },
  zadd: async (key: string, score: number, member: string): Promise<number> => {
    const client = getClient()
    return client.zadd(key, score, member)
  },
  zrangebyscore: async (key: string, min: number | string, max: number | string): Promise<string[]> => {
    const client = getClient()
    return client.zrangebyscore(key, min, max)
  },
  zremrangebyscore: async (key: string, min: number | string, max: number | string): Promise<number> => {
    const client = getClient()
    return client.zremrangebyscore(key, min, max)
  },
  ping: async (): Promise<string> => {
    const client = getClient()
    return client.ping()
  },
  info: async (): Promise<string> => {
    const client = getClient()
    return client.info()
  },
  dbSize: async (): Promise<number> => {
    const client = getClient()
    return client.dbSize()
  },
}
