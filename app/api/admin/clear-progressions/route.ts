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

// Patterns to delete. Each entry is a `KEYS`-style glob that the inline
// Redis client supports. The arrangement is intentional: progression →
// sets → indications/strategies → positions → engine state → counters
// → variant cache → trades. Adding new ephemeral key namespaces in the
// future means appending here, not changing the route shape.
const RUNTIME_KEY_PATTERNS = [
  "progression:*",            // Per-connection progression log streams
  "engine_progression:*",     // Engine-level progression counters
  "set:*",                    // Generic set storage
  "sets:*",                   // Set indices
  "preh:*",                   // Prehistoric processor state (cycles/frames/symbol cursors)
  "preset-set:*",             // Preset Set rows
  "preset_set:*",             // Underscore variant
  "tracking:*",               // Tracker entries (per-position)
  "trackings:*",              // Tracker indices
  "indication:*",             // Per-symbol indications
  "indications:*",            // Indication indices
  "strategy:*",               // Per-symbol strategies
  "strategies:*",             // Strategy indices
  "live:position:*",          // Open / placed live positions
  "live:set:*",               // Active live sets
  "live:order:*",             // Live order references (queued, pending fills)
  "position:*",               // Cumulative position records
  "position_history:*",       // Per-symbol position history rings
  "engine:state:*",           // Per-connection engine state hash
  "engine:metrics:*",         // Per-connection metrics
  "runtime:*",                // Misc runtime breadcrumbs (last_tick_at etc.)
  "cycle:*",                  // Per-cycle markers
  "metric:*",                 // Counter rolls
  "stats:*",                  // Aggregated stat caches
  "fp:cache:*",               // Variant fingerprint cache
  "variant:*",                // Variant runtime entries
  "trade:*",                  // Trade history
  "trades:*",                 // Trade indices
] as const

// Patterns we MUST NOT touch even if they share a prefix accidentally.
// The match is exact-prefix substring — a single accidental
// `progression:connection:*` would otherwise wipe credentials.
const PROTECTED_PREFIXES = [
  "connection:",
  "settings:",
  "app_settings",
  "migration:",
  "predefinitions:",
  "trade_engine:paused",      // Resume-list — operator may want to keep it
]

function isProtected(key: string): boolean {
  for (const prefix of PROTECTED_PREFIXES) {
    if (key.startsWith(prefix)) return true
  }
  return false
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

    // ── 2. Walk each pattern and delete matching keys ──────────────────
    // We log each pattern's count individually so the operator (and
    // any future debugger) can see exactly which buckets were cleared.
    const removed: Record<string, number> = {}
    const protectedSkipped: string[] = []

    for (const pattern of RUNTIME_KEY_PATTERNS) {
      try {
        const keys = await client.keys(pattern)
        if (!keys || keys.length === 0) {
          removed[pattern] = 0
          continue
        }

        // Filter out anything that landed in a protected namespace by
        // accident. Keys/list ordering is not stable so we have to
        // double-check every time rather than rely on pattern wording.
        const safe: string[] = []
        for (const k of keys) {
          if (isProtected(k)) {
            protectedSkipped.push(k)
            continue
          }
          safe.push(k)
        }

        if (safe.length > 0) {
          // `del(...keys)` accepts varargs — chunk to keep the command
          // size sane on remote Redis backends (some adapters reject
          // commands > ~1000 args). 500 is well within Upstash's limits.
          const CHUNK = 500
          let deleted = 0
          for (let i = 0; i < safe.length; i += CHUNK) {
            const slice = safe.slice(i, i + CHUNK)
            const n = await client.del(...slice)
            deleted += n || slice.length
          }
          removed[pattern] = deleted
          console.log(`[v0] [ClearProgressions] ${pattern}: ${deleted} deleted`)
        } else {
          removed[pattern] = 0
        }
      } catch (err) {
        console.warn(
          `[v0] [ClearProgressions] pattern ${pattern} failed:`,
          err instanceof Error ? err.message : String(err),
        )
        removed[pattern] = -1 // surface as "errored" in the UI
      }
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

    const totalRemoved = Object.values(removed).reduce(
      (acc, n) => (n > 0 ? acc + n : acc),
      0,
    )

    await SystemLogger.logTradeEngine(
      `Reset DB: cleared ${totalRemoved} runtime keys across ${RUNTIME_KEY_PATTERNS.length} buckets`,
      "info",
      { removed, protectedSkipped: protectedSkipped.length, engineStopError },
    )

    console.log(
      `[v0] [ClearProgressions] === done in ${Date.now() - startedAt}ms — ${totalRemoved} keys removed ===`,
    )

    return NextResponse.json({
      success: true,
      message: `Cleared ${totalRemoved} runtime keys. Credentials, settings, and migrations preserved.`,
      totalRemoved,
      removed,
      protectedSkipped: protectedSkipped.length,
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
