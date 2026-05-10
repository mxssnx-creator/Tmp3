/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          PROGRESSION LOCK — ONE-RUNNER-PER-CONNECTION GUARD          ║
 * ║                                                                      ║
 * ║  Purpose:                                                            ║
 * ║   • Guarantee that at most ONE TradeEngineManager instance is active ║
 * ║     for a given connectionId across the entire deployment (every     ║
 * ║     Node worker, every cold-started serverless function, every dev   ║
 * ║     reload). The in-process `startingEngines` Set in                ║
 * ║     `GlobalTradeEngineCoordinator` only prevents duplicates WITHIN   ║
 * ║     the same process — under multi-instance deployments two workers  ║
 * ║     can otherwise each launch their own progression and race on the  ║
 * ║     same progression counters.                                       ║
 * ║                                                                      ║
 * ║   • Stamp a monotonically-increasing EPOCH (epoch-ms) on every       ║
 * ║     successful acquisition. The epoch is written to the canonical    ║
 * ║     `progression:{id}` hash so downstream observers (dashboards,     ║
 * ║     log dialogs, stall watchdog) can detect when a generation flip   ║
 * ║     happened. Stale in-flight callbacks that complete after a        ║
 * ║     restart will see `epoch` advanced and silently drop their write. ║
 * ║                                                                      ║
 * ║  Redis schema:                                                       ║
 * ║   • Key:    engine_lock:{connectionId}                              ║
 * ║   • Value:  "{ownerToken}:{epoch}"                                   ║
 * ║   • TTL:    LOCK_TTL_SEC (60s by default). MUST be refreshed every   ║
 * ║             ~LOCK_TTL_SEC/3 by the lock owner; if the owner dies     ║
 * ║             without releasing the lock will expire and another       ║
 * ║             worker can take over within at most one TTL window.      ║
 * ║                                                                      ║
 * ║  Atomicity:                                                          ║
 * ║   • Acquire   → `SET key val NX EX ttl` — single command, atomic.    ║
 * ║   • Extend    → read value, compare to owner token, then `expire`.   ║
 * ║                 Small window race (~ms) but bounded by the cheap     ║
 * ║                 read-then-write semantics of our inline Redis        ║
 * ║                 client; worst case is a one-tick-late TTL refresh.   ║
 * ║   • Release   → read value, compare, then `del`. Same window. The    ║
 * ║                 TTL provides the fallback safety net.                ║
 * ║                                                                      ║
 * ║  Note on the inline Redis client (`lib/redis-db.ts`):                ║
 * ║   The local in-process client doesn't support `SCRIPT EVAL`, so      ║
 * ║   compare-and-swap is implemented in JS rather than Lua. This is     ║
 * ║   fine for the inline path — there's only one consumer. When wired  ║
 * ║   to a real Upstash/ioredis client at deploy time the same APIs     ║
 * ║   still work (the `set` options `{NX, EX}` are standard Redis); we   ║
 * ║   just lose one round-trip's worth of strict atomicity, which the    ║
 * ║   TTL safety net covers.                                             ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { getRedisClient } from "@/lib/redis-db"
import crypto from "node:crypto"

const LOCK_KEY_PREFIX = "engine_lock:"
/** TTL for a freshly-acquired lock. The owner must extend before this expires. */
export const LOCK_TTL_SEC = 60
/** Heartbeat extend cadence. Must be comfortably less than LOCK_TTL_SEC. */
export const LOCK_EXTEND_INTERVAL_MS = 15_000

export interface LockHandle {
  /** Unique-per-acquisition identifier; an arbitrary opaque cookie. */
  ownerToken: string
  /** Monotonic epoch-ms timestamp captured at acquisition time. */
  epoch: number
}

export interface AcquireResult {
  acquired: boolean
  /** Populated on success. */
  handle?: LockHandle
  /** Populated on failure — the existing owner's encoded value (for diagnostics). */
  existingOwner?: string
}

function key(connectionId: string): string {
  return `${LOCK_KEY_PREFIX}${connectionId}`
}

function encodeValue(handle: LockHandle): string {
  return `${handle.ownerToken}:${handle.epoch}`
}

function decodeValue(raw: string | null): { ownerToken: string; epoch: number } | null {
  if (!raw || typeof raw !== "string") return null
  const idx = raw.lastIndexOf(":")
  if (idx <= 0) return null
  const epoch = Number(raw.slice(idx + 1))
  if (!Number.isFinite(epoch)) return null
  return { ownerToken: raw.slice(0, idx), epoch }
}

/**
 * Generate a fresh opaque owner token. Uses `crypto.randomUUID` when
 * available (Node 19+ has it on the global; we import the namespace for
 * older runtimes). Falls back to a high-entropy hex string.
 */
export function mintOwnerToken(): string {
  try {
    if (typeof (crypto as any).randomUUID === "function") {
      return (crypto as any).randomUUID() as string
    }
  } catch {
    /* fall through */
  }
  return crypto.randomBytes(16).toString("hex")
}

/**
 * Atomically acquire the per-connection progression lock.
 *
 * Returns `{ acquired: true, handle }` on success. On contention,
 * returns `{ acquired: false, existingOwner }` and the caller MUST NOT
 * mutate progression state — another worker owns the connection.
 */
export async function acquireProgressionLock(
  connectionId: string,
  ttlSec: number = LOCK_TTL_SEC,
): Promise<AcquireResult> {
  const client = getRedisClient()
  if (!client) {
    // Fail closed: no lock store available means we cannot guarantee
    // single-runner semantics. Caller should treat this as "not
    // acquired" rather than racing blindly.
    return { acquired: false, existingOwner: "no-redis-client" }
  }
  const handle: LockHandle = {
    ownerToken: mintOwnerToken(),
    epoch: Date.now(),
  }
  try {
    const result = await client.set(key(connectionId), encodeValue(handle), {
      NX: true,
      EX: ttlSec,
    })
    if (result === "OK") {
      return { acquired: true, handle }
    }
    // Acquisition failed — look up the current owner for diagnostics.
    let existing: string | null = null
    try {
      existing = await client.get(key(connectionId))
    } catch {
      /* best effort */
    }
    return { acquired: false, existingOwner: existing ?? "unknown" }
  } catch (err) {
    console.warn(
      `[ProgressionLock] acquire failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { acquired: false, existingOwner: "acquire-error" }
  }
}

/**
 * Extend the TTL of a lock we own. Used by the engine's heartbeat to
 * keep the lock alive while the engine is actively processing. Returns
 * `false` (without mutating Redis) when:
 *   • the lock has expired or been deleted,
 *   • another worker has taken over (token mismatch),
 *   • or the lock store is unreachable.
 *
 * Callers MUST react to a `false` return value by gracefully stopping
 * the engine — they no longer own the progression.
 */
export async function extendProgressionLock(
  connectionId: string,
  handle: LockHandle,
  ttlSec: number = LOCK_TTL_SEC,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    if (!decoded) return false
    if (decoded.ownerToken !== handle.ownerToken || decoded.epoch !== handle.epoch) {
      return false
    }
    await client.expire(key(connectionId), ttlSec)
    return true
  } catch (err) {
    console.warn(
      `[ProgressionLock] extend failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Release the lock if and only if we still own it. Releasing a lock we
 * don't own is a no-op (returns `false`) — never delete another
 * worker's lock by mistake.
 */
export async function releaseProgressionLock(
  connectionId: string,
  handle: LockHandle,
): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    if (!decoded) {
      // Already gone — treat as released for caller's purposes.
      return true
    }
    if (decoded.ownerToken !== handle.ownerToken || decoded.epoch !== handle.epoch) {
      return false
    }
    await client.del(key(connectionId))
    return true
  } catch (err) {
    console.warn(
      `[ProgressionLock] release failed for ${connectionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Read-only lookup — what epoch (if any) currently owns the progression
 * for a connection? Returns `null` when unowned. Used by external
 * observers (the watchdog escalation path, the API stats route) to
 * detect a generation flip without needing the owner token.
 */
export async function getCurrentEpoch(connectionId: string): Promise<number | null> {
  const client = getRedisClient()
  if (!client) return null
  try {
    const raw = await client.get(key(connectionId))
    const decoded = decodeValue(raw)
    return decoded?.epoch ?? null
  } catch {
    return null
  }
}

/**
 * Forcefully break a lock — used ONLY by the watchdog escalation path
 * after a confirmed stall (the owner is unresponsive and the TTL hasn't
 * expired yet). Returns `true` if a lock was actually present and
 * removed, `false` otherwise. NEVER call this from the normal
 * start/stop flow; it bypasses the ownership check by design.
 */
export async function forceBreakProgressionLock(connectionId: string): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  try {
    const existed = await client.get(key(connectionId))
    if (!existed) return false
    await client.del(key(connectionId))
    return true
  } catch {
    return false
  }
}
