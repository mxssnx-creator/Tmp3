/**
 * Centralised engine + cron + progression timing knobs.
 *
 * Every interval / throttle / hold-time / flush-interval previously
 * scattered as `private static readonly` constants across realtime-processor,
 * strategy-processor, live-stage, engine-progression-logs, and the
 * sync-live-positions cron is now read from a single Redis-backed hash
 * `settings:system` (mirrored to legacy `settings:system_settings` by
 * /api/settings/system — see that route's `writeMirroredSystem`).
 *
 * ── Why a sync getter on top of an async refresher ─────────────────────
 * Tick sites (realtime processor hot loop, strategy flow gate) run
 * dozens of times per second per connection. Hitting Redis on every
 * gate evaluation would defeat the very throttles being read. So:
 *   - `refreshEngineTimings()` is async, throttled to one Redis hit
 *     every CACHE_TTL_MS, called opportunistically from non-hot paths
 *     and once on module init (fire-and-forget).
 *   - `getEngineTimings()` is sync, returns the last cached snapshot
 *     (or hard-coded DEFAULTS until the first refresh lands).
 *
 * On settings change, /api/settings/system bumps the settings-version
 * counter. Any caller that wants immediate take-effect can call
 * `refreshEngineTimings({ force: true })`.
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"

export interface EngineTimings {
  // ── Cron self-loop cadence ────────────────────────────────────────────
  // Vercel cron schedule minimum is 1 minute (`* * * * *`). To get sub-
  // minute cadence the cron handler runs N iterations within one 60 s
  // invocation, sleeping `cronSyncIntervalSeconds` between each. Effective
  // sync cadence = `cronSyncIntervalSeconds`. Range: 5–60 s.
  cronSyncIntervalSeconds: number

  // ── Realtime-processor close path throttle ────────────────────────────
  // `RealtimeProcessor.maybeRunLiveSync()` is gated by this. Lower =
  // faster close-on-SL/TP detection but more REST calls to the exchange.
  // Default 200 ms — matches the live exchange-positions update cadence
  // so SL/TP cross detection and protection-order healing run in lock-
  // step with the freshest price data the venue gives us.
  liveSyncIntervalMs: number

  // ── Pause AFTER a completed live sync ─────────────────────────────────
  // Defence-in-depth on top of the single-flight guard. Once a sync
  // cycle has fully completed (every per-position branch, every protection
  // order placement / cancel, every Redis write), we wait this many ms
  // before the next sync can be triggered. Mirrors the `cyclePauseMs`
  // pattern used by the main progression cycle (see engine-manager.ts):
  // each cycle runs to completion → short breath → next cycle. Range
  // 10–200 ms, default 50 ms. Prevents back-to-back syncs starving the
  // event loop on a slow exchange API while keeping close latency low.
  liveSyncPauseMs: number

  // ── Realtime tick heartbeat throttle ──────────────────────────────────
  // How often the engine-state heartbeat (Redis `trade_engine_state:*`)
  // is rewritten. Independent of liveSync. 1000 ms = once per second.
  heartbeatIntervalMs: number

  // ── Strategy flow throttling ──────────────────────────────────────────
  // See lib/trade-engine/strategy-processor.ts header for the gate
  // matrix. Hard throttle is the absolute minimum gap between two
  // strategy-flow runs for the same (connection, symbol).
  strategyFlowMinIntervalMs: number
  strategyFlowHardThrottleMs: number
  strategyFlowMaxIntervalMs: number

  // ── Progression-lock TTL extension cadence ────────────────────────────
  // Engine extends its per-connection progression lock every N ms to
  // prevent a leadership-flap on transient Redis latency. Used by both
  // engine-manager (extender setInterval) and progression-lock module.
  lockExtendIntervalMs: number

  // ── Max position hold time (force-close after) ────────────────────────
  // Live-stage closes any position held longer than this with reason
  // `max_hold_time_exceeded`. Default 4h. `0` disables the check.
  maxPositionHoldMs: number

  // ── Progression log buffer flush cadence ──────────────────────────────
  // `lib/engine-progression-logs.ts` buffers progression events and
  // flushes either when the buffer hits 50 entries or this interval
  // elapses. NOTE: this is read at module init; runtime changes apply
  // after engine restart (the setInterval handle is fixed at first read).
  progressionBufferFlushMs: number

  // ── Three independent progression loops (the engine's "heartbeat") ──
  // The engine drives three top-level loops, EACH independent of the others
  // but sharing one inner ind+strat pipeline:
  //
  //   A. Prehistoric Progression  (default 1 s, continuous forever)
  //      → for each timeframe × symbol: runIndStratCycle(historical)
  //   B. Realtime  Progression    (default 1 s, continuous forever)
  //      → for each symbol:           runIndStratCycle(realtime)
  //   C. LivePositions Progression (default 200 ms, continuous forever)
  //      → live-exchange sync (mark price, SL/TP cross, control orders)
  //
  // Each loop has a start-to-start interval AND a post-completion pause
  // ("breath"). The pause guarantees the previous cycle's Redis writes
  // are durable before the next cycle reads — mirrors the live-sync
  // pause pattern that fixed double-fire SL/TP bugs.
  prehistoricIntervalMs: number       // Loop A start-to-start
  prehistoricCyclePauseMs: number     // Loop A post-cycle breath
  realtimeIntervalMs: number          // Loop B start-to-start
  realtimeCyclePauseMs: number        // Loop B post-cycle breath
  livePositionsCyclePauseMs: number   // Loop C post-cycle breath
                                      //   (Loop C uses `liveSyncIntervalMs`
                                      //    as start-to-start gate — that
                                      //    field already exists above.)
}

export const DEFAULT_ENGINE_TIMINGS: EngineTimings = {
  cronSyncIntervalSeconds:   15,
  // Tuned for sub-second close response — was 5_000 ms, lowered to match
  // the live exchange-positions cadence (~200 ms). Combined with the
  // `liveSyncPauseMs` post-cycle breath this gives ~5 close-path sweeps
  // per second while still letting each sweep finish cleanly.
  liveSyncIntervalMs:          200,
  liveSyncPauseMs:              50,
  heartbeatIntervalMs:       1_000,
  strategyFlowMinIntervalMs: 1_500,
  strategyFlowHardThrottleMs:  750,
  strategyFlowMaxIntervalMs: 15_000,
  lockExtendIntervalMs:     15_000,
  maxPositionHoldMs:    4 * 60 * 60 * 1000,
  progressionBufferFlushMs:  3_000,
  // ── Three-progression defaults ────────────────────────────────────────
  prehistoricIntervalMs:        1_000,  // 1s timeframe cadence
  prehistoricCyclePauseMs:         50,
  realtimeIntervalMs:           1_000,
  realtimeCyclePauseMs:            50,
  livePositionsCyclePauseMs:       50,
}

// Hard min/max bounds — UI + API normalise to these to avoid pathological
// values (a 1ms tick rate would lock the event loop; a 1h heartbeat
// would silence the dashboard's "engine alive" indicator).
export const ENGINE_TIMING_BOUNDS: Record<keyof EngineTimings, { min: number; max: number }> = {
  cronSyncIntervalSeconds:   { min: 5,           max: 60                  },
  // Lower bound 100 ms — anything faster than the exchange's own price
  // tick is wasted REST calls. Upper bound retained at 60 s for
  // operators who explicitly want a quiet REST footprint on paper-only
  // setups.
  liveSyncIntervalMs:        { min: 100,         max: 60_000              },
  liveSyncPauseMs:           { min: 10,          max: 200                 },
  heartbeatIntervalMs:       { min: 250,         max: 30_000              },
  strategyFlowMinIntervalMs: { min: 250,         max: 60_000              },
  strategyFlowHardThrottleMs:{ min: 100,         max: 30_000              },
  strategyFlowMaxIntervalMs: { min: 1_000,       max: 5 * 60_000          },
  lockExtendIntervalMs:      { min: 1_000,       max: 60_000              },
  maxPositionHoldMs:         { min: 0 /* off */, max: 7 * 24 * 60 * 60_000 },
  progressionBufferFlushMs:  { min: 500,         max: 60_000              },
  // ── Three-progression bounds ──────────────────────────────────────────
  // Floor at 200 ms protects the event loop from a runaway 1 ms cycle.
  // Ceiling at 60 s gives operators a way to "park" a loop without
  // disabling it entirely (e.g. quiet-mode for paper-only setups).
  prehistoricIntervalMs:     { min: 200,         max: 60_000              },
  prehistoricCyclePauseMs:   { min: 10,          max: 500                 },
  realtimeIntervalMs:        { min: 200,         max: 60_000              },
  realtimeCyclePauseMs:      { min: 10,          max: 500                 },
  livePositionsCyclePauseMs: { min: 10,          max: 200                 },
}

// snake_case key in Redis hash → camelCase key in object. Both forms are
// accepted on read so a hand-edited HSET against either casing works.
const REDIS_KEY_MAP: Record<keyof EngineTimings, string[]> = {
  cronSyncIntervalSeconds:    ["cron_sync_interval_seconds",    "cronSyncIntervalSeconds"],
  liveSyncIntervalMs:         ["live_sync_interval_ms",         "liveSyncIntervalMs"],
  liveSyncPauseMs:            ["live_sync_pause_ms",            "liveSyncPauseMs"],
  heartbeatIntervalMs:        ["heartbeat_interval_ms",         "heartbeatIntervalMs"],
  strategyFlowMinIntervalMs:  ["strategy_flow_min_interval_ms", "strategyFlowMinIntervalMs"],
  strategyFlowHardThrottleMs: ["strategy_flow_hard_throttle_ms","strategyFlowHardThrottleMs"],
  strategyFlowMaxIntervalMs:  ["strategy_flow_max_interval_ms", "strategyFlowMaxIntervalMs"],
  lockExtendIntervalMs:       ["lock_extend_interval_ms",       "lockExtendIntervalMs"],
  maxPositionHoldMs:          ["max_position_hold_ms",          "maxPositionHoldMs"],
  progressionBufferFlushMs:   ["progression_buffer_flush_ms",   "progressionBufferFlushMs"],
  prehistoricIntervalMs:      ["prehistoric_interval_ms",       "prehistoricIntervalMs"],
  prehistoricCyclePauseMs:    ["prehistoric_cycle_pause_ms",    "prehistoricCyclePauseMs"],
  realtimeIntervalMs:         ["realtime_interval_ms",          "realtimeIntervalMs"],
  realtimeCyclePauseMs:       ["realtime_cycle_pause_ms",       "realtimeCyclePauseMs"],
  livePositionsCyclePauseMs:  ["live_positions_cycle_pause_ms", "livePositionsCyclePauseMs"],
}

const CACHE_TTL_MS = 10_000

let cached: EngineTimings = { ...DEFAULT_ENGINE_TIMINGS }
let cachedAt = 0
let inflight: Promise<EngineTimings> | null = null

function clamp(key: keyof EngineTimings, value: number): number {
  const b = ENGINE_TIMING_BOUNDS[key]
  if (!Number.isFinite(value)) return DEFAULT_ENGINE_TIMINGS[key]
  return Math.max(b.min, Math.min(b.max, value))
}

function parseTimingsFromHash(hash: Record<string, any> | null | undefined): EngineTimings {
  const out: EngineTimings = { ...DEFAULT_ENGINE_TIMINGS }
  if (!hash) return out
  ;(Object.keys(REDIS_KEY_MAP) as (keyof EngineTimings)[]).forEach((k) => {
    const aliases = REDIS_KEY_MAP[k]
    let raw: any = undefined
    for (const a of aliases) {
      if (hash[a] !== undefined && hash[a] !== null && hash[a] !== "") {
        raw = hash[a]
        break
      }
    }
    if (raw === undefined) return
    const n = parseFloat(String(raw))
    out[k] = clamp(k, n)
  })
  return out
}

/**
 * Async refresher. De-duplicates concurrent calls. Respects CACHE_TTL_MS
 * unless `force: true` is passed (used by /api/settings/system after a
 * write so the next tick sees the new value immediately).
 */
export async function refreshEngineTimings(opts: { force?: boolean } = {}): Promise<EngineTimings> {
  const now = Date.now()
  if (!opts.force && now - cachedAt < CACHE_TTL_MS) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      await initRedis()
      const client = getRedisClient()
      // Merge canonical + legacy hashes (canonical wins). Matches the
      // mirror-write pattern in /api/settings/system.
      const [canonical, legacy] = await Promise.all([
        client.hgetall("settings:system").catch(() => ({})),
        client.hgetall("settings:system_settings").catch(() => ({})),
      ])
      const merged = { ...(legacy || {}), ...(canonical || {}) }
      cached = parseTimingsFromHash(merged)
      cachedAt = Date.now()
      return cached
    } catch {
      // On Redis error keep the previous cache rather than reverting to
      // defaults — protects against transient outages causing throttle
      // resets that could double-fire SL/TP healing.
      return cached
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Sync getter for hot loops. Returns the last refreshed snapshot, or
 * DEFAULTS if no refresh has completed yet. Never blocks, never throws.
 *
 * Opportunistically kicks a background refresh when the cache is stale
 * so a long-running process with no async settings-change touch points
 * still gets new values within CACHE_TTL_MS of the next tick after a
 * settings write.
 */
export function getEngineTimings(): EngineTimings {
  if (Date.now() - cachedAt >= CACHE_TTL_MS) {
    // Fire-and-forget; ignore the promise. Next tick will see fresh data.
    refreshEngineTimings().catch(() => {})
  }
  return cached
}

// Kick a refresh on module load so the first tick after process start
// doesn't have to fall back to DEFAULTS.
refreshEngineTimings().catch(() => {})
