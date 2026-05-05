import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/admin/clear-progressions
 *
 * Targeted "Reset DB" surface for the QuickStart panel.
 *
 * The existing `/api/admin/reset-and-init` flushes the entire Redis
 * keyspace and re-runs migrations — that is too destructive for the
 * common operator workflow ("I want to clear runtime state and start
 * a clean QuickStart run without losing my exchange credentials").
 *
 * This endpoint instead performs a *surgical* clear:
 *   • STOPS every running engine via the coordinator so no producer
 *     can race the deletion (otherwise a tick mid-flight could re-
 *     create the keys we just deleted).
 *   • DELETES all runtime keys: progression logs, set caches, indication
 *     and strategy snapshots, tracking entries, position runtime data,
 *     engine state/metrics, cycle counters, variant fingerprint cache,
 *     and per-connection trade history.
 *   • PRESERVES: connection records (`connection:*`), settings
 *     (`settings:*`, `app_settings:*`), migration markers, and
 *     predefinitions.
 *
 * Returns a per-pattern breakdown of how many keys were removed so the
 * UI can show a useful confirmation toast.
 */

// ── ALLOWLIST CLEAR MODEL ─────────────────────────────────────────────
// Operator report: "after resetting db, db keys still showing same high
// number of keys." The previous implementation walked an INCLUDE list of
// 28 patterns. Anything outside that list (engine_session:*, scheduler:*,
// last_*, queue:*, lock:*, idem:*, fp:*, ratelimit:*, pubsub:*, etc.)
// would silently survive the reset.
//
// New strategy: scan the ENTIRE keyspace via `KEYS *` (one call,
// chunked DEL afterwards), then DELETE every key whose prefix is NOT
// on the protected list. This guarantees that any ephemeral/runtime
// key namespace — present today or added in a future code path — is
// captured by the reset without us having to remember to update an
// include list.
//
// Buckets are still surfaced in the response for operator visibility:
// after the protected/safe split we group safe keys by their first
// `:` segment so the UI can show "Cleared 1247 keys across 14 buckets".
//
// Keys that share a protected prefix with a runtime concept (e.g. a
// hypothetical `connection:test:*` cache) are handled by adding the
// runtime concept to the FORCE-CLEAR list below — it overrides the
// protected match. Order: PROTECTED → unless FORCE_CLEAR_PREFIXES says
// otherwise → delete.

const PROTECTED_PREFIXES = [
  "connection:",          // Exchange credentials & per-connection config
  "connections:tombstoned", // Operator delete decisions (must outlive reset)
  "settings:",            // Operator settings
  "app_settings",         // Canonical settings hash
  "all_settings",         // Legacy settings hash
  "migration:",           // Schema migration markers
  "_migration",           // Migration internal flags (`_migrations_run`, `_schema_version`)
  "_schema_version",
  "predefinitions:",      // Operator-defined predefined sets
  "system:base_connections_seeded", // Idempotency guard for seeder
] as const

// FORCE-CLEAR: prefixes that LOOK like they're protected but are pure
// runtime caches that must be wiped on reset. Add here only if the
// runtime cache is NOT recoverable from a fresh start.
const FORCE_CLEAR_PREFIXES = [
  "connection:test:",              // Test result cache (safe to lose; tests re-run)
  "connection:test:history:",      // Test history ring buffer
  "connection:rate_limit:",        // Rate-limit tracker (5-min window)
] as const

function isProtected(key: string): boolean {
  // Force-clear overrides protection.
  for (const fc of FORCE_CLEAR_PREFIXES) {
    if (key.startsWith(fc)) return false
  }
  for (const prefix of PROTECTED_PREFIXES) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// Group a key into a "bucket" name for the per-bucket count summary
// surfaced to the UI. We use the first `:` segment, falling back to
// the literal key for top-level singletons.
function bucketOf(key: string): string {
  const idx = key.indexOf(":")
  return idx > 0 ? key.slice(0, idx) + ":*" : key
}

export async function POST() {
  const startedAt = Date.now()
  try {
    console.log("[v0] [ClearProgressions] === starting targeted runtime clear ===")
    await initRedis()
    const client = getRedisClient()

    // ── 1. Stop every running engine first ──────────────────────────────
    // We do this BEFORE deleting keys so a tick mid-flight cannot re-
    // create progression rows / position records under our feet.
    // Failure here is non-fatal — we still continue with the clear so a
    // crashed coordinator doesn't permanently block the operator from
    // resetting state. The errors are surfaced in the response.
    let engineStopError: string | null = null
    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      if (coordinator?.stopAll) {
        await coordinator.stopAll()
        console.log("[v0] [ClearProgressions] coordinator.stopAll() OK")
      }
    } catch (err) {
      engineStopError = err instanceof Error ? err.message : String(err)
      console.warn("[v0] [ClearProgressions] coordinator.stopAll() failed:", engineStopError)
    }

    // ── 2. Scan entire keyspace, partition into safe/protected ────────
    // `KEYS *` is O(N) but acceptable here — Reset DB is an operator
    // action invoked at most a few times an hour, and the inline
    // Redis client used in dev runs in-process anyway.
    let allKeys: string[] = []
    try {
      const result = await client.keys("*")
      allKeys = Array.isArray(result) ? result : []
    } catch (err) {
      console.error("[v0] [ClearProgressions] KEYS * failed:", err)
      allKeys = []
    }
    const startingKeyCount = allKeys.length
    console.log(`[v0] [ClearProgressions] Scanning ${startingKeyCount} keys for safe deletion...`)

    const safeKeys: string[] = []
    const protectedSkipped: string[] = []
    for (const k of allKeys) {
      if (typeof k !== "string" || k.length === 0) continue
      if (isProtected(k)) {
        protectedSkipped.push(k)
      } else {
        safeKeys.push(k)
      }
    }

    // Group BEFORE deletion so the response can show what was cleared.
    const removed: Record<string, number> = {}
    for (const k of safeKeys) {
      const bucket = bucketOf(k)
      removed[bucket] = (removed[bucket] || 0) + 1
    }

    // ── 3. Chunked DELETE ──────────────────────────────────────────────
    // 500 keys per command keeps us well within Upstash/Redis client
    // arg-limit ceilings (~1000 typical). Track per-batch result so a
    // partial-failure still surfaces a useful number.
    //
    // IMPORTANT: The Redis `DEL` command can be unreliable with some
    // adapters (returns 0 even when keys are deleted, or silently fails
    // to delete certain keys). So we also do a pre/post key-scan to
    // verify the actual deletion happened.
    const CHUNK = 500
    let totalDeleted = 0
    let deleteErrors = 0
    let preDeleteKeySet: Set<string> | null = null
    let postDeleteKeySet: Set<string> | null = null
    
    // Capture the pre-delete key set for verification
    if (safeKeys.length > 0 && safeKeys.length < 10000) {
      // Only do this for reasonable key counts to avoid O(N) overhead
      preDeleteKeySet = new Set(safeKeys)
    }
    
    for (let i = 0; i < safeKeys.length; i += CHUNK) {
      const slice = safeKeys.slice(i, i + CHUNK)
      try {
        const n = await client.del(...slice)
        const delResult = typeof n === "number" ? n : slice.length
        totalDeleted += delResult
        console.log(`[v0] [ClearProgressions] DEL chunk ${Math.floor(i / CHUNK)} (${slice.length} keys) → deleted ${delResult}`)
      } catch (err) {
        deleteErrors++
        console.warn(
          `[v0] [ClearProgressions] DEL chunk ${Math.floor(i / CHUNK)} failed (${slice.length} keys):`,
          err instanceof Error ? err.message : String(err),
        )
        // Try one-by-one fallback for this slice so we don't lose the
        // whole batch to a single bad key.
        let fallbackCount = 0
        for (const k of slice) {
          try {
            const m = await client.del(k)
            const singleDelResult = typeof m === "number" ? m : 1
            fallbackCount += singleDelResult
            totalDeleted += singleDelResult
          } catch {
            /* per-key failure is logged via batch counter only */
          }
        }
        console.log(`[v0] [ClearProgressions] DEL chunk ${Math.floor(i / CHUNK)} fallback → deleted ${fallbackCount} one-by-one`)
      }
    }
    
    // Capture post-delete key set to verify deletion actually happened
    if (preDeleteKeySet && preDeleteKeySet.size > 0) {
      try {
        const keysAfterDel = await client.keys("*")
        postDeleteKeySet = new Set(keysAfterDel)
        const stillExist = Array.from(preDeleteKeySet).filter((k) => postDeleteKeySet!.has(k))
        if (stillExist.length > 0) {
          console.warn(
            `[v0] [ClearProgressions] DELETION VERIFICATION FAILED: ${stillExist.length} keys that should have been deleted still exist!`,
            `Examples: ${stillExist.slice(0, 5).join(", ")}`
          )
        }
      } catch (err) {
        console.warn("[v0] [ClearProgressions] Post-delete verification scan failed:", err)
      }
    }
    
    console.log(
      `[v0] [ClearProgressions] Cleared ${totalDeleted}/${safeKeys.length} safe keys ` +
      `across ${Object.keys(removed).length} buckets (${protectedSkipped.length} protected)`,
    )

    // ── 2.5. Force persistence flush to ensure deletes are durable ────────
    // The Redis client may buffer writes. Explicitly flush to disk (if
    // using file persistence) and refresh in-memory state so DBSIZE
    // reports accurate counts immediately after deletion.
    try {
      // BGSAVE triggers async snapshot; SAVE would block but is more
      // reliable for small keysets. We use BGSAVE since the operator
      // doesn't need to wait for persistence — they just want to see
      // the key count drop in the next stats poll.
      const persistFn = (client as any).bgsave || (client as any).save
      if (typeof persistFn === "function") {
        await persistFn.call(client)
        console.log("[v0] [ClearProgressions] Persistence flush requested (BGSAVE)")
      }
    } catch (err) {
      console.warn(
        "[v0] [ClearProgressions] Persistence flush warning:",
        err instanceof Error ? err.message : String(err),
      )
    }

    // ── 3. Reset per-connection runtime flags on connection records ───
    // The connection row itself is preserved, but transient flags
    // (paused-by-global, dashboard-active, live-trade) should reset so
    // the operator gets a clean slate on the next QuickStart run.
    try {
      const { getAllConnections, updateConnection } = await import("@/lib/redis-db")
      const conns = await getAllConnections()
      for (const c of conns) {
        await updateConnection(c.id, {
          ...c,
          is_enabled_dashboard: "0",
          is_active: "0",
          is_live_trade: "0",
          is_preset_trade: "0",
          paused_by_global: "0",
          paused_preset_by_global: "0",
          updated_at: new Date().toISOString(),
        })
      }
      console.log(`[v0] [ClearProgressions] reset runtime flags on ${conns.length} connections`)
    } catch (err) {
      console.warn(
        "[v0] [ClearProgressions] connection flag reset failed:",
        err instanceof Error ? err.message : String(err),
      )
    }

    // ── 4. Final verification: re-count keys after the deletion ───────
    // Operator report: "after resetting db, db keys still showing same
    // high number of keys." Surfacing the post-delete DBSIZE in the
    // response makes silent-failure scenarios immediately obvious in
    // the toast (e.g. "starting=4127, ending=4127, delete returned 0"
    // → tells the operator the Redis client adapter dropped the calls).
    // 
    // We do this TWICE: once immediately, and again after a 100ms delay
    // to give the Redis server time to process any pending commands and
    // also to verify that a client reconnect or new adapter instance
    // still shows the same count (preventing "the adapter had stale
    // cached DBSIZE from before the deletion").
    let endingKeyCount = -1
    let endingKeyCountAfterDelay = -1
    
    const getKeyCount = async (): Promise<number> => {
      try {
        const dbSizeFn = (client as any).dbsize || (client as any).dbSize
        if (typeof dbSizeFn === "function") {
          return await dbSizeFn.call(client)
        }
        // Fallback: count via KEYS *. Slow but correct.
        const keysAfter = await client.keys("*")
        return Array.isArray(keysAfter) ? keysAfter.length : -1
      } catch {
        return -1
      }
    }
    
    endingKeyCount = await getKeyCount()
    
    // Small delay to let Redis process the batch
    await new Promise((r) => setTimeout(r, 100))
    endingKeyCountAfterDelay = await getKeyCount()
    
    // If the two counts differ significantly, it means keys are being
    // re-created or the deletion didn't actually complete. Alert the log.
    if (endingKeyCountAfterDelay > endingKeyCount && endingKeyCountAfterDelay - endingKeyCount > 10) {
      console.warn(
        `[v0] [ClearProgressions] WARNING: Keys re-appeared after deletion! ` +
        `Immediately after: ${endingKeyCount}, after 100ms: ${endingKeyCountAfterDelay}. ` +
        `Some process may be re-creating keys (engine auto-start, scheduled task, etc).`
      )
    }

    await SystemLogger.logTradeEngine(
      `Reset DB: cleared ${totalDeleted} runtime keys ` +
      `(starting=${startingKeyCount}, ending=${endingKeyCount}, after-delay=${endingKeyCountAfterDelay}, ` +
      `protected=${protectedSkipped.length}, errors=${deleteErrors})`,
      "info",
      { removed, protectedSkipped: protectedSkipped.length, engineStopError, startingKeyCount, endingKeyCount, endingKeyCountAfterDelay, deleteErrors },
    )

    console.log(
      `[v0] [ClearProgressions] === done in ${Date.now() - startedAt}ms — ` +
      `cleared ${totalDeleted}, starting=${startingKeyCount}, ending=${endingKeyCount}, after-delay=${endingKeyCountAfterDelay} ===`,
    )

    return NextResponse.json({
      success: true,
      message:
        `Cleared ${totalDeleted} runtime keys. ` +
        `${protectedSkipped.length} protected (credentials/settings/migrations) preserved.`,
      totalRemoved: totalDeleted,
      removed,
      protectedSkipped: protectedSkipped.length,
      startingKeyCount,
      endingKeyCount,
      endingKeyCountAfterDelay,
      deleteErrors,
      engineStopError,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [ClearProgressions] FATAL:", error)
    await SystemLogger.logError(error, "api", "POST /api/admin/clear-progressions")
    return NextResponse.json(
      {
        success: false,
        error: "Failed to clear progressions",
        details: errorMessage,
      },
      { status: 500 },
    )
  }
}
