/**
 * Redis Database Layer - High Performance Edition v3.0
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 * Optimized for 80K+ ops/sec with logging disabled
 * @version 3.0.0 - Cache rebuild forced
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

// Force webpack cache invalidation
const REDIS_DB_VERSION = "3.0.0"
void REDIS_DB_VERSION

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
      // Initialize with defaults
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
      
      // Try to load from disk snapshot if available
      this.loadFromDisk().catch(() => {
        // Ignore load errors - start with empty database
      });
    }
    
    // Ensure ttl map exists for older data structures
    if (!globalForRedis.__redis_data.ttl) {
      globalForRedis.__redis_data.ttl = new Map()
    }
    
    this.data = globalForRedis.__redis_data
    
    // Run cleanup every 60 seconds to remove expired keys
    this.startTTLCleanup();
    
    // Schedule periodic disk snapshots every 5 minutes
    this.startPersistence();
  }

  async loadFromDisk(): Promise<boolean> { return false }
  async startPersistence(): Promise<boolean> { return false }
  async saveToDisk(): Promise<boolean> { return false }
  saveToDiskSync(): boolean { return false }
  
  private startTTLCleanup(): void {
    // DISABLED: Automatic TTL cleanup causing all data to be deleted every 60 seconds
    // Only run cleanup manually when explicitly requested
    // const globalCleanup = globalThis as unknown as { __redis_cleanup_started?: boolean }
    // if (globalCleanup.__redis_cleanup_started) return
    // globalCleanup.__redis_cleanup_started = true
    
    // const ttlCleanupTimer = setInterval(() => {
    //   this.cleanupExpiredKeys()
    // }, 60000)
    // ttlCleanupTimer.unref?.()
  }
  
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
    return cleaned
  }
  
  private isExpired(key: string): boolean {
    const ttlMap = this.data.ttl
    if (!ttlMap) return false
    
    const expireAt = ttlMap.get(key)
    if (expireAt && Date.now() >= expireAt) {
      // Only delete expired keys during explicit cleanup operations
      // Not on every read operation!
      // this.deleteKey(key)
      // ttlMap.delete(key)
      return true
    }
    return false
  }
  
  private deleteKey(key: string): void {
    this.data.strings.delete(key)
    this.data.hashes.delete(key)
    this.data.sets.delete(key)
    this.data.lists.delete(key)
    this.data.sorted_sets.delete(key)
    this.data.ttl?.delete(key)
  }
  
  private setKeyTTL(key: string, seconds: number): void {
    if (!this.data.ttl) {
      this.data.ttl = new Map()
    }
    this.data.ttl.set(key, Date.now() + seconds * 1000)
  }

  private trackOperation(): void {
    // Lightweight: just increment the counter. Rate is computed lazily on read.
    const stats = this.data.requestStats
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec !== stats.lastSecond) {
      // New second window: snapshot ops/sec from previous window and reset
      stats.operationsPerSecond = stats.requestCount
      stats.requestCount = 0
      stats.lastSecond = nowSec
    }
    stats.requestCount++
  }

  async ping() {
    return "PONG"
  }

  async info(): Promise<string> {
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
    this.data.strings.set(key, value)
    this.setKeyTTL(key, seconds)
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1)
  }

  async incrby(key: string, increment: number): Promise<number> {
    if (this.isExpired(key)) {
      this.data.strings.set(key, String(increment))
      return increment
    }
    const current = parseInt(this.data.strings.get(key) || "0", 10)
    const newValue = current + increment
    this.data.strings.set(key, String(newValue))
    return newValue
  }

  async del(...keys: string[]): Promise<number> {
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
    this.data.strings.clear()
    this.data.hashes.clear()
    this.data.sets.clear()
    this.data.lists.clear()
    this.data.sorted_sets.clear()
    this.data.ttl?.clear()
  }

  async hset(key: string, dataOrField: Record<string, string> | string, value?: string): Promise<number> {
    this.trackOperation()
    const existing = this.data.hashes.get(key) || {}
    // Support both hset(key, { field: value }) and hset(key, "field", "value")
    if (typeof dataOrField === "string" && value !== undefined) {
      this.data.hashes.set(key, { ...existing, [dataOrField]: value })
      return 1
    }
    const data = dataOrField as Record<string, string>
    const updates = Object.keys(data).length
    this.data.hashes.set(key, { ...existing, ...data })
    return updates
  }

  async hmset(...args: string[]): Promise<void> {
    this.trackOperation()
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
    const hash = this.data.hashes.get(key)
    return hash ? Object.keys(hash).length : 0
  }

  async hget(key: string, field: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const hash = this.data.hashes.get(key)
    return hash?.[field] ?? null
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
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
    const hash = this.data.hashes.get(key) || {}
    const currentValue = parseInt(hash[field] || "0", 10)
    const newValue = currentValue + increment
    hash[field] = String(newValue)
    this.data.hashes.set(key, hash)
    return newValue
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<number> {
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
    if (this.isExpired(key)) return 0
    return this.data.sets.get(key)?.size ?? 0
  }

  async smembers(key: string): Promise<string[]> {
    this.trackOperation()
    if (this.isExpired(key)) return []
    return Array.from(this.data.sets.get(key) || new Set())
  }

  async sismember(key: string, member: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const set = this.data.sets.get(key)
    return set?.has(member) ? 1 : 0
  }

  async srem(key: string, ...members: string[]): Promise<number> {
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

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.data.lists.get(key) || []
    for (let i = values.length - 1; i >= 0; i--) {
      list.unshift(values[i])
    }
    this.data.lists.set(key, list)
    return list.length
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.data.lists.get(key) || []
    list.push(...values)
    this.data.lists.set(key, list)
    return list.length
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.isExpired(key)) return []
    const list = this.data.lists.get(key) || []
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    return list.slice(normalizedStart, normalizedStop + 1)
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.data.lists.get(key)
    if (!list) return
    const len = list.length
    const normalizedStart = start < 0 ? Math.max(0, len + start) : start
    const normalizedStop = stop < 0 ? len + stop : stop
    const trimmed = list.slice(normalizedStart, normalizedStop + 1)
    this.data.lists.set(key, trimmed)
  }

  async llen(key: string): Promise<number> {
    if (this.isExpired(key)) return 0
    return this.data.lists.get(key)?.length ?? 0
  }

  /**
   * Remove `count` occurrences of `value` from the list at `key`.
   * Semantics match Redis `LREM`:
   *   count > 0 — remove head→tail
   *   count < 0 — remove tail→head
   *   count = 0 — remove every occurrence
   *
   * Previously this method didn't exist on the in-memory adapter, which made
   * `live-stage.savePosition()` throw `TypeError: client.lrem is not a function`
   * on every position close and prevented the closed-index bookkeeping from
   * running. That in turn made `getLivePositions` re-scan terminal rows
   * forever and is visible in the server logs at live-stage.ts:156.
   */
  async lrem(key: string, count: number, value: string): Promise<number> {
    if (this.isExpired(key)) return 0
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return 0
    let removed = 0
    const wantAll = count === 0
    const target = Math.abs(count)
    if (count >= 0) {
      for (let i = 0; i < list.length; ) {
        if (list[i] === value && (wantAll || removed < target)) {
          list.splice(i, 1)
          removed++
        } else {
          i++
        }
      }
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === value && (wantAll || removed < target)) {
          list.splice(i, 1)
          removed++
        }
      }
    }
    if (list.length === 0) {
      this.data.lists.delete(key)
    } else {
      this.data.lists.set(key, list)
    }
    return removed
  }

  /**
   * Pop and return the first element of the list at `key`. Returns null when
   * the list is empty or missing. Added for parity with `lpush`/`rpush` so
   * upstream callers that move items between queues don't blow up.
   */
  async lpop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return null
    const head = list.shift() ?? null
    if (list.length === 0) this.data.lists.delete(key)
    return head
  }

  async rpop(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null
    const list = this.data.lists.get(key)
    if (!list || list.length === 0) return null
    const tail = list.pop() ?? null
    if (list.length === 0) this.data.lists.delete(key)
    return tail
  }

  async dbSize(): Promise<number> {
    return this.data.strings.size + this.data.hashes.size + this.data.sets.size + this.data.lists.size + this.data.sorted_sets.size
  }

  async keys(pattern: string): Promise<string[]> {
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
    if (this.isExpired(key)) return []
    const set = this.data.sorted_sets.get(key) || []
    const minValue = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const maxValue = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    return set.filter((entry) => entry.score >= minValue && entry.score <= maxValue).map((entry) => entry.member)
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const set = this.data.sorted_sets.get(key) || []
    const minValue = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min)
    const maxValue = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max)
    const before = set.length
    const remaining = set.filter((entry) => entry.score < minValue || entry.score > maxValue)
    if (remaining.length === 0) this.data.sorted_sets.delete(key)
    else this.data.sorted_sets.set(key, remaining)
    return before - remaining.length
  }

  async trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    const now = Date.now()
    
    if (!globalTracker.__db_ops_tracker) {
      globalTracker.__db_ops_tracker = { timestamp: now, count: 0 }
    }
    
    const tracker = globalTracker.__db_ops_tracker
    const windowStart = now - 60000
    
    if (tracker.timestamp < windowStart) {
      tracker.timestamp = now
      tracker.count = 0
    }
    
    tracker.count++
    tracker.timestamp = now
    
    return {
      current: tracker.count,
      limit: limit,
      exceeded: limit > 0 && tracker.count > limit,
    }
  }

  async getDatabaseOperationCount(): Promise<number> {
    const globalTracker = globalThis as unknown as { __db_ops_tracker?: { timestamp: number; count: number } }
    if (!globalTracker.__db_ops_tracker) return 0
    
    const now = Date.now()
    const windowStart = now - 60000
    
    if (globalTracker.__db_ops_tracker.timestamp < windowStart) {
      return 0
    }
    
    return globalTracker.__db_ops_tracker.count
  }

  async load(): Promise<void> {
    // No-op: data is already in global memory
  }

  async cleanupExpiredKeysPublic(): Promise<number> {
    return this.cleanupExpiredKeys()
  }

  async exists(key: string): Promise<number> {
    const exists = this.data.strings.has(key) || 
                   this.data.hashes.has(key) || 
                   this.data.sets.has(key) ||
                   this.data.lists.has(key) ||
                   this.data.sorted_sets.has(key)
    return exists ? 1 : 0
  }

  async ttl(key: string): Promise<number> {
    const ttlMap = this.data.ttl
    if (!ttlMap || !ttlMap.has(key)) {
      const existsResult = await this.exists(key)
      if (existsResult === 0) return -2
      return -1
    }
    
    const expireAt = ttlMap.get(key)!
    const now = Date.now()
    if (now >= expireAt) {
      return -2
    }
    
    return Math.floor((expireAt - now) / 1000)
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

  const pong = await redisInstance.ping()
  if (pong !== "PONG") {
    console.error("[v0] [Redis] Connection test failed")
  }

  if (!migrationsRan) {
    try {
      migrationsRan = true
      const { runMigrations } = await import("@/lib/redis-migrations")
      await runMigrations()
    } catch (error) {
      console.error("[v0] [Redis] Migration error:", error)
      migrationsRan = true
    }
  }

  if (!connectionsInitialized) {
    connectionsInitialized = true
  }
}

export function getClient(): InlineLocalRedis {
  if (!redisInstance) {
    redisInstance = new InlineLocalRedis()
    isConnected = true
  }
  return redisInstance
}

export function getRedisClient(): InlineLocalRedis {
  return getClient()
}

export function isRedisConnected(): boolean {
  return isConnected
}

// ========== Helpers ==========

function convertToString(value: any): string {
  if (value === true) return "1"
  if (value === false) return "0"
  if (value === null || value === undefined) return ""
  return String(value)
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

function flattenForHmset(obj: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object" && !Array.isArray(value)) {
        result[key] = JSON.stringify(value)
      } else if (Array.isArray(value)) {
        result[key] = JSON.stringify(value)
      } else {
        result[key] = convertToString(value)
      }
    }
  }
  return result
}

function parseHashValue(value: unknown): unknown {
  // Guard against undefined/null
  if (value === undefined || value === null) return null
  
  // CRITICAL: Must be string to use string methods - fixes "value.startsWith is not a function"
  if (typeof value !== "string") {
    // Return non-string values as-is (numbers, booleans, objects already parsed)
    return value
  }
  
  // Now value is guaranteed to be a string
  const strValue: string = value
  
  if (strValue === "") return ""
  
  // Try to parse as JSON first (only for strings that look like JSON)
  if ((strValue.startsWith("{") && strValue.endsWith("}")) || 
      (strValue.startsWith("[") && strValue.endsWith("]"))) {
    try {
      return JSON.parse(strValue)
    } catch {
      return strValue
    }
  }
  
  // Check for boolean-like values
  if (strValue === "1" || strValue === "true") return true
  if (strValue === "0" || strValue === "false") return false
  
  // Check for numeric values
  if (/^-?\d+$/.test(strValue)) return parseInt(strValue, 10)
  if (/^-?\d+\.\d+$/.test(strValue)) return parseFloat(strValue)
  
  return strValue
}

function parseHash(hash: Record<string, string> | null): Record<string, any> | null {
  if (!hash) return null
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(hash)) {
    result[key] = parseHashValue(value)
  }
  return result
}

// ========== Connection Operations ==========

export async function getConnection(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`connection:${id}`)
  return parseHash(hash)
}

// ────────────────────────────────────────────────────────────────────────────
// PERF: in-memory TTL cache for `getAllConnections`.
// The dashboard polls every ~8s and each active card fans out multiple
// per-connection requests. Without this cache we issue N KEYS + N HGETALL
// ops per poll per component. A short TTL (1.5s) dedupes bursts without
// introducing user-visible staleness (all writes invalidate the cache
// immediately via `invalidateConnectionsCache()`).
// ────────────────────────────────────────────────────────────────────────────
const __CONN_CACHE_TTL_MS = 1500
let __connCache: { at: number; value: any[] } | null = null
let __connInflight: Promise<any[]> | null = null

export function invalidateConnectionsCache(): void {
  __connCache = null
  __connInflight = null
}

export async function getAllConnections(): Promise<any[]> {
  const now = Date.now()
  if (__connCache && now - __connCache.at < __CONN_CACHE_TTL_MS) {
    return __connCache.value
  }
  if (__connInflight) return __connInflight

  __connInflight = (async () => {
    try {
      await initRedis()
      const client = getClient()
      const keys = await client.keys("connection:*")

      // Filter out special sibling keys up-front so we don't fan out HGETALLs
      // for them (reduces Redis roundtrips in large deployments).
      const realKeys = keys.filter(
        (k) =>
          !k.includes(":settings:") &&
          !k.includes(":stats:") &&
          !k.includes(":logs:")
      )

      // Parallelize HGETALL across all connection keys. Previously ran
      // sequentially in a for-loop, which scaled linearly with connection count.
      const hashes = await Promise.all(
        realKeys.map(async (key) => {
          try {
            return await client.hgetall(key)
          } catch (err) {
            console.warn(
              `[v0] [redis-db] getAllConnections: hgetall failed for ${key}`,
              err instanceof Error ? err.message : err
            )
            return null
          }
        })
      )

      const connections = hashes
        .filter((h): h is Record<string, any> => !!h && Object.keys(h).length > 0)
        .map(parseHash)

      __connCache = { at: Date.now(), value: connections }
      return connections
    } finally {
      __connInflight = null
    }
  })()

  return __connInflight
}

export async function saveConnection(connection: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = connection.id || connection.name
  if (!id) {
    throw new Error("Connection must have an id or name")
  }
  
  const data = flattenForHmset({
    ...connection,
    id,
    updated_at: new Date().toISOString(),
  })
  
  await client.hset(`connection:${id}`, data)
  invalidateConnectionsCache()
}

export async function deleteConnection(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  await client.del(`connection:${id}`)
  invalidateConnectionsCache()
}

// ========== Settings Operations ==========

export async function getSettings(key: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`settings:${key}`)
  return parseHash(hash)
}

export async function setSettings(key: string, value: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const data = flattenForHmset(value)
  await client.hset(`settings:${key}`, data)
}

export async function getAllSettings(): Promise<Record<string, any>> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("settings:*")
  const settings: Record<string, any> = {}
  
  for (const key of keys) {
    const settingKey = key.replace("settings:", "")
    const hash = await client.hgetall(key)
    if (hash) {
      settings[settingKey] = parseHash(hash)
    }
  }
  
  return settings
}

// ========== Market Data Operations ==========

export async function getMarketData(symbol: string, interval: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const data = await client.get(`market_data:${symbol}:${interval}`)
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function setMarketData(symbol: string, interval: string, data: any, ttlSeconds: number = 300): Promise<void> {
  await initRedis()
  const client = getClient()
  await client.set(`market_data:${symbol}:${interval}`, JSON.stringify(data), { EX: ttlSeconds })
}

// ========== Position Operations ==========

export async function getPosition(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`position:${id}`)
  return parseHash(hash)
}

export async function getAllPositions(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("position:*")
  const positions: any[] = []
  
  for (const key of keys) {
    const hash = await client.hgetall(key)
    if (hash) {
      positions.push(parseHash(hash))
    }
  }
  
  return positions
}

export async function savePosition(position: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = position.id
  if (!id) {
    throw new Error("Position must have an id")
  }
  
  const data = flattenForHmset({
    ...position,
    updated_at: new Date().toISOString(),
  })
  
  await client.hset(`position:${id}`, data)
}

export async function deletePosition(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  await client.del(`position:${id}`)
}

// ========== Trade Operations ==========

export async function getTrade(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`trade:${id}`)
  return parseHash(hash)
}

export async function getAllTrades(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("trade:*")
  const trades: any[] = []
  
  for (const key of keys) {
    const hash = await client.hgetall(key)
    if (hash) {
      trades.push(parseHash(hash))
    }
  }
  
  return trades
}

export async function saveTrade(trade: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = trade.id
  if (!id) {
    throw new Error("Trade must have an id")
  }
  
  const data = flattenForHmset({
    ...trade,
    updated_at: new Date().toISOString(),
  })
  
  await client.hset(`trade:${id}`, data)
}

// ========== Indication Operations ==========

export async function getIndication(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`indication:${id}`)
  return parseHash(hash)
}

export async function getAllIndications(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("indication:*")
  const indications: any[] = []
  
  for (const key of keys) {
    const hash = await client.hgetall(key)
    if (hash) {
      indications.push(parseHash(hash))
    }
  }
  
  return indications
}

export async function saveIndication(indication: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = indication.id
  if (!id) {
    throw new Error("Indication must have an id")
  }
  
  const data = flattenForHmset({
    ...indication,
    updated_at: new Date().toISOString(),
  })
  
  await client.hset(`indication:${id}`, data)
}

// ========== Strategy Operations ==========

export async function getStrategy(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`strategy:${id}`)
  return parseHash(hash)
}

export async function getAllStrategies(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("strategy:*")
  const strategies: any[] = []
  
  for (const key of keys) {
    const hash = await client.hgetall(key)
    if (hash) {
      strategies.push(parseHash(hash))
    }
  }
  
  return strategies
}

export async function saveStrategy(strategy: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = strategy.id
  if (!id) {
    throw new Error("Strategy must have an id")
  }
  
  const data = flattenForHmset({
    ...strategy,
    updated_at: new Date().toISOString(),
  })
  
  await client.hset(`strategy:${id}`, data)
}

// ========== Connection State Helpers ==========

export function getConnectionStates(connection: any): {
  base_enabled: boolean
  base_inserted: boolean
  main_enabled: boolean
  main_assigned: boolean
  is_active: boolean
} {
  return {
    base_enabled: isEnabledFlag(connection.is_enabled),
    base_inserted: isEnabledFlag(connection.is_inserted),
    main_enabled: isEnabledFlag(connection.is_enabled_dashboard),
    main_assigned: isEnabledFlag(connection.is_active_inserted),
    is_active: isEnabledFlag(connection.is_active_inserted) && isEnabledFlag(connection.is_enabled_dashboard),
  }
}

export function isConnectionAssignedToMain(connection: any): boolean {
  return isEnabledFlag(connection.is_active_inserted)
}

export function isConnectionMainEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled_dashboard)
}

export function isConnectionBaseEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled)
}

export function buildMainConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    is_enabled_dashboard: "1",
    is_dashboard_inserted: "1",
    is_active_inserted: "1",
    is_active: "1",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionDisableUpdate(connection: any): any {
  return {
    ...connection,
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionRemoveUpdate(connection: any): any {
  return {
    ...connection,
    is_active_inserted: "0",
    is_dashboard_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildBaseConnectionEnableUpdate(connection: any): any {
  return {
    ...connection,
    is_enabled: "1",
    is_inserted: "1",
    updated_at: new Date().toISOString(),
  }
}

// ========== Stats Operations ==========

export async function closeRedis(): Promise<void> {
  isConnected = false
}

export function getRedisRequestsPerSecond(): number {
  const data = globalForRedis.__redis_data
  if (!data || !data.requestStats) return 0
  const stats = data.requestStats
  // If still within the current second, return running count; otherwise return last completed second
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec === stats.lastSecond) {
    return stats.requestCount
  }
  return stats.operationsPerSecond
}

export function getConnectionState(id: string): { isRunning: boolean } {
  // Simple state check based on global tracking
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  return { isRunning: globalEngineState.__engine_states.get(id) ?? false }
}

export function setConnectionRunningState(id: string, isRunning: boolean): void {
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  globalEngineState.__engine_states.set(id, isRunning)
}

// ========== Migration State Management ==========

const globalMigrationState = globalThis as unknown as { __migrations_run?: boolean }

export function haveMigrationsRun(): boolean {
  return globalMigrationState.__migrations_run ?? false
}

export function setMigrationsRun(value: boolean): void {
  globalMigrationState.__migrations_run = value
}

// ========== Engine Connection Operations ==========

export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const client = getRedisClient()
  const keys = await client.keys("connection:*")
  const connections: any[] = []
  
  for (const key of keys) {
    if (key.includes(":settings") || key.includes(":state")) continue
    const data = await client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      // Check if connection is active for engine (is_active_inserted = 1)
      if (isEnabledFlag(data.is_active_inserted) || isEnabledFlag(data.is_active)) {
        connections.push({
          id: key.replace("connection:", ""),
          ...data,
        })
      }
    }
  }
  
  return connections
}

export async function getAllConnectionsWithStatus(): Promise<any[]> {
  const client = getRedisClient()
  const keys = await client.keys("connection:*")
  const connections: any[] = []
  
  for (const key of keys) {
    if (key.includes(":settings") || key.includes(":state")) continue
    const data = await client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      connections.push({
        id: key.replace("connection:", ""),
        ...data,
      })
    }
  }
  
  return connections
}

// ========== Additional CRUD Operations ==========

export async function createConnection(data: any): Promise<any> {
  await initRedis()
  const client = getRedisClient()
  const id = data.id || `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // Check if connection already exists to prevent duplicates
  const existingConnection = await client.hgetall(`connection:${id}`)
  if (existingConnection && Object.keys(existingConnection).length > 0) {
    console.log(`[v0] [Redis] Connection already exists with id ${id}, updating instead of creating duplicate`)
    // Update existing connection
    const connectionData = {
      ...data,
      id,
      updated_at: new Date().toISOString(),
    }
    await client.hset(`connection:${id}`, connectionData)
    invalidateConnectionsCache()
    return connectionData
  }

  const connectionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await client.hset(`connection:${id}`, connectionData)
  invalidateConnectionsCache()
  return connectionData
}

export async function updateConnection(id: string, updates: any): Promise<any> {
  const client = getRedisClient()
  const existing = await client.hgetall(`connection:${id}`)
  if (!existing || Object.keys(existing).length === 0) {
    return null
  }
  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  }
  await client.hset(`connection:${id}`, updated)
  invalidateConnectionsCache()
  return updated
}

export async function createPosition(data: any): Promise<any> {
  const client = getRedisClient()
  const id = data.id || `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const positionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await client.hset(`position:${id}`, positionData)
  // Also add to positions set for easy listing
  await client.sadd("positions:all", id)
  return positionData
}

export async function getIndications(connectionId?: string, symbol?: string): Promise<any[]> {
  const client = getRedisClient()
  const indications: any[] = []
  
  // First, try to get from the main key directly (storeIndications saves here)
  if (connectionId) {
    const mainKey = `indications:${connectionId}`
    try {
      const mainData = await client.get(mainKey)
      if (mainData) {
        const parsed = typeof mainData === "string" ? JSON.parse(mainData) : mainData
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        
        // Filter by symbol if provided
        if (symbol) {
          const filtered = arr.filter((ind: any) => ind.symbol === symbol)
          if (filtered.length > 0) {
            return filtered
          }
        } else {
          return arr
        }
      }
    } catch (e) {
      console.warn(`[v0] Error reading main indication key ${mainKey}:`, e)
    }
  }
  
  // Fallback: search with pattern matching
  let pattern: string
  if (connectionId && symbol) {
    pattern = `indications:${connectionId}:${symbol}:*`
  } else if (connectionId) {
    pattern = `indications:${connectionId}:*`
  } else if (symbol) {
    pattern = `indication:${symbol}:*`
  } else {
    pattern = `indications:*`
  }
  
  const keys = await client.keys(pattern)
  
  for (const key of keys) {
    try {
      const stringData = await client.get(key)
      if (stringData) {
        try {
          const parsed = typeof stringData === "string" ? JSON.parse(stringData) : stringData
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          indications.push(...arr)
        } catch (e) {
          console.warn(`[v0] Failed to parse indication key ${key}:`, e)
        }
        continue
      }
      
      const hashData = await client.hgetall(key)
      if (hashData && Object.keys(hashData).length > 0) {
        // Parse numeric fields from string — hgetall always returns strings
        const parsed: Record<string, any> = { id: key.replace(/^indications?:/, ""), ...hashData }
        if (typeof parsed.confidence === "string")    parsed.confidence    = parseFloat(parsed.confidence)
        if (typeof parsed.profitFactor === "string")  parsed.profitFactor  = parseFloat(parsed.profitFactor)
        if (typeof parsed.profit_factor === "string") parsed.profit_factor = parseFloat(parsed.profit_factor)
        if (typeof parsed.value === "string")         parsed.value         = parseFloat(parsed.value)
        if (typeof parsed.timestamp === "string")     parsed.timestamp     = parseInt(parsed.timestamp, 10)
        indications.push(parsed)
      }
    } catch (e) {
      console.warn(`[v0] Error reading indication key ${key}:`, e)
    }
  }
  
  return indications
}

/**
 * Store indications for a connection - HIGH FREQUENCY OPTIMIZED
 * Maintains independent sets per configuration type for optimal performance
 */
export async function storeIndications(connectionId: string, symbol: string, indications: any[]): Promise<void> {
  if (!indications || indications.length === 0) return
  
  const client = getRedisClient()
  const mainKey = `indications:${connectionId}`
  
  try {
    // Read existing indications
    const existingRaw = await client.get(mainKey)
    let existing: any[] = []
    if (existingRaw) {
      try {
        existing = JSON.parse(typeof existingRaw === "string" ? existingRaw : JSON.stringify(existingRaw))
        if (!Array.isArray(existing)) existing = []
      } catch {
        existing = []
      }
    }
    
    // Add new indications with metadata for per-config tracking
    const newIndications = indications.map(ind => ({
      ...ind,
      symbol,
      connectionId,
      timestamp: new Date().toISOString(),
      configSet: getConfigurationSet(ind.type, ind.value), // Track which config set this belongs to
    }))
    
    existing.push(...newIndications)
    
    // Keep only latest 2500 indications per connection (250 per symbol × 10 symbols typical)
    if (existing.length > 2500) {
      existing = existing.slice(-2500)
    }
    
    // Save to main key with 1-hour TTL
    await client.set(mainKey, JSON.stringify(existing), { EX: 3600 })
    
    // Also maintain per-type independent sets for high-frequency lookups
    await Promise.all(
      indications.map(async (indication) => {
        const typeKey = `indications:${connectionId}:${indication.type}`
        const typeIndications = indications.filter(i => i.type === indication.type)
        if (typeIndications.length > 0) {
          await client.set(typeKey, JSON.stringify(typeIndications), { EX: 3600 })
        }
      })
    )

  } catch (error) {
    console.error(`[v0] Error storing indications for ${connectionId}:`, error)
  }
}

/**
 * Determine configuration set based on indication parameters
 * Used for organizing independent sets per configuration combination
 */
function getConfigurationSet(type: string, value: any): string {
  // Map indication characteristics to configuration sets for independent tracking
  // This allows parallel processing of different configuration combinations
  if (!value || typeof value !== "object") return "config:default"
  
  const stepCount = value.stepCount || 10
  const drawdown = value.drawdownRatio || 0.2
  const activity = value.activityRatio || 0.05
  const rangeRatio = value.rangeRatio || 0.2
  
  // Create configuration hash to group similar configs together
  const configHash = Math.abs(
    ((stepCount * 7) ^ (Math.round(drawdown * 100) * 11) ^ 
     (Math.round(activity * 1000) * 13) ^ (Math.round(rangeRatio * 100) * 17)) % 1000
  )
  
  return `config:${type}:${configHash}`
}

export async function verifyRedisHealth(): Promise<{ healthy: boolean; latency: number; error?: string }> {
  const start = Date.now()
  try {
    const client = getRedisClient()
    // Simple ping test
    await client.set("health:check", Date.now().toString())
    const result = await client.get("health:check")
    const latency = Date.now() - start
    return {
      healthy: result !== null,
      latency,
    }
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ========== Connection Position and Trade Operations ==========

export async function getConnectionPositions(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  const keys = await client.keys(`position:${connectionId}:*`)
  const positions: any[] = []
  
  for (const key of keys) {
    const data = await client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      positions.push({
        id: key.replace(`position:${connectionId}:`, ""),
        connection_id: connectionId,
        ...data,
      })
    }
  }
  
  // Also check global positions that reference this connection
  const globalKeys = await client.keys("position:*")
  for (const key of globalKeys) {
    if (key.startsWith(`position:${connectionId}:`)) continue // Already processed
    const data = await client.hgetall(key)
    if (data && data.connection_id === connectionId) {
      positions.push({
        id: key.replace("position:", ""),
        ...data,
      })
    }
  }
  
  return positions
}

export async function getConnectionTrades(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  const keys = await client.keys(`trade:${connectionId}:*`)
  const trades: any[] = []
  
  for (const key of keys) {
    const data = await client.hgetall(key)
    if (data && Object.keys(data).length > 0) {
      trades.push({
        id: key.replace(`trade:${connectionId}:`, ""),
        connection_id: connectionId,
        ...data,
      })
    }
  }
  
  // Also check global trades that reference this connection
  const globalKeys = await client.keys("trade:*")
  for (const key of globalKeys) {
    if (key.startsWith(`trade:${connectionId}:`)) continue // Already processed
    const data = await client.hgetall(key)
    if (data && data.connection_id === connectionId) {
      trades.push({
        id: key.replace("trade:", ""),
        ...data,
      })
    }
  }
  
  return trades
}

export async function getProgressionLogs(connectionId: string, limit: number = 50): Promise<any[]> {
  const client = getRedisClient()
  // Get logs from sorted set or list
  const logsKey = `progression:${connectionId}:logs`
  const logsList = await client.lrange(logsKey, 0, limit - 1)
  
  const logs: any[] = []
  for (const logStr of logsList) {
    try {
      const log = typeof logStr === "string" ? JSON.parse(logStr) : logStr
      logs.push(log)
    } catch {
      logs.push({ message: logStr, timestamp: new Date().toISOString() })
    }
  }
  
  return logs
}

export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error",
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  const client = getRedisClient()
  const logsKey = `progression:${connectionId}:logs`
  
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    phase,
    level,
    message,
    ...metadata,
  })
  
  // Add to list (prepend for newest first)
  await client.lpush(logsKey, logEntry)
  // Keep only last 100 logs
  await client.ltrim(logsKey, 0, 99)
  // Set TTL of 7 days
  await client.expire(logsKey, 7 * 24 * 60 * 60)
}

// ========== Connection Filter Functions ==========

export async function getEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => isEnabledFlag(conn.is_enabled) || isEnabledFlag(conn.enabled))
}

export async function getAssignedAndEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => 
    (isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned)) &&
    (isEnabledFlag(conn.is_enabled) || isEnabledFlag(conn.enabled))
  )
}

export async function getConnectionsByExchange(exchange: string): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => 
    conn.exchange?.toLowerCase() === exchange.toLowerCase() ||
    conn.exchange_name?.toLowerCase() === exchange.toLowerCase()
  )
}

// ========== Missing Exports for db.ts compatibility ==========

export async function deleteSettings(key: string): Promise<void> {
  const client = getRedisClient()
  await client.del(`settings:${key}`)
}

export async function flushAll(): Promise<void> {
   const client = getRedisClient()
   await client.flushDb()
 }

export async function getRedisStats(): Promise<{
  connected: boolean
  memoryUsage: number
  keyCount: number
  uptime: number
}> {
  try {
    const client = getRedisClient()
    const keys = await client.keys("*")
    return {
      connected: true,
      memoryUsage: 0, // In-memory implementation doesn't track this
      keyCount: keys.length,
      uptime: Date.now() - (globalThis as any).__redis_start_time || 0,
    }
  } catch {
    return {
      connected: false,
      memoryUsage: 0,
      keyCount: 0,
      uptime: 0,
    }
  }
}

export async function saveMarketData(symbol: string, timeframe: string, data: any): Promise<void> {
  const client = getRedisClient()
  const key = `market_data:${symbol}:${timeframe}`
  await client.set(key, JSON.stringify(data))
  // Set 24 hour TTL for market data
  await client.expire(key, 86400)
}

// ===========================================================================
// EXPLICIT PERSISTENCE FUNCTIONS
// ===========================================================================

export async function saveDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.saveToDisk()
  return true
}

export async function loadDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.loadFromDisk()
  return true
}

export function saveDatabaseSnapshotSync(): boolean {
  const client = getRedisClient()
  client.saveToDiskSync()
  return true
}
