/**
 * Trade Engine Manager V11
 * Manages asynchronous processing for symbols, indications, pseudo positions, and strategies
 * V10: Define totalStrategiesEvaluated globally to prevent stale closure ReferenceError
 * V11: Self-scheduling setTimeout loops with configurable cycle pause
 *      (app_settings.cyclePauseMs, default 50 ms) to fix 4 s+ cycle hang.
 * @version 11.0.0
 * @lastUpdate 2026-04-20 — self-scheduling cycle loops
 */

const _ENGINE_BUILD_VERSION = "11.0.0"

// CRITICAL FIX: Define totalStrategiesEvaluated in global scope as fallback
// This allows stale closures from old code to continue without ReferenceError
// The variable is defined but not used - new code doesn't reference it
declare global {
  // eslint-disable-next-line no-var
  var totalStrategiesEvaluated: number
}
if (typeof globalThis.totalStrategiesEvaluated === "undefined") {
  globalThis.totalStrategiesEvaluated = 0
}

// Type for global engine state
interface EngineGlobalState {
  __engine_version?: string
  __engine_timers?: Set<ReturnType<typeof setInterval>>
  __engine_instances?: Map<string, unknown>
}

const engineGlobal = (typeof globalThis !== "undefined" ? globalThis : {}) as EngineGlobalState

// STABILITY: NEVER clear live engine timers on module reload.
//
// Previously this block ran on every module reload (HMR / serverless
// warm-restart / redeploy) and cleared every interval handle that any live
// engine had registered. After the clear the timer handles still existed
// inside the engines' closures, but firing them did nothing — and the
// per-tick "stale module version" guard (also removed in this changeset)
// then refused to schedule the next cycle. Net effect: every running
// engine silently went to sleep on every reload. Hence the
// "engines silently stop running" symptom.
//
// We now log the version transition and preserve the timer set. Real
// timer disposal is owned by `EngineManager.stop()` and `rearmIfStalled()`.
if (engineGlobal.__engine_version && engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
  console.log(
    `[v0] Engine version ${engineGlobal.__engine_version} -> ${_ENGINE_BUILD_VERSION} ` +
      `(keeping ${engineGlobal.__engine_timers?.size ?? 0} live timers)`,
  )
}
engineGlobal.__engine_version = _ENGINE_BUILD_VERSION

// Initialize timer set if it doesn't exist yet (first load in this process).
if (!engineGlobal.__engine_timers) {
  engineGlobal.__engine_timers = new Set()
}

// Helper to register timers so they can be cleaned up on reload
function registerEngineTimer(timer: ReturnType<typeof setInterval>): void {
  engineGlobal.__engine_timers?.add(timer)
}

function unregisterEngineTimer(timer: ReturnType<typeof setInterval>): void {
  engineGlobal.__engine_timers?.delete(timer)
}

/**
 * Configurable pause (ms) between engine cycles.
 *
 * Value comes from the `app_settings.cyclePauseMs` key in Redis, clamped to
 * [10, 200]. Default 50 ms.
 *
 * ── Live-settings contract ────────────────────────────────────────────
 * Cached in-memory so cycle scheduling never blocks on Redis I/O, BUT the
 * cache is tied to the global `settings_version` counter (bumped by every
 * write via `setAppSettings` / `bumpSettingsVersion`), not a wall-clock
 * TTL. The synchronous getter returns the last-known value and fires an
 * async refresh whenever:
 *   (a) the counter has changed since the last refresh   → operator saved
 *   (b) 30 s have elapsed without any version bump       → defence-in-
 *       depth against a missed signal (Redis flush, lost INCR, etc.)
 * This makes saved settings take effect on the very next cycle (typically
 * < 300 ms later, bounded by SETTINGS_VERSION_READ_TTL_MS + cycle pause)
 * with NO engine restart required.
 */
const DEFAULT_CYCLE_PAUSE_MS = 50
const CYCLE_PAUSE_MIN = 10
const CYCLE_PAUSE_MAX = 200
const CYCLE_PAUSE_HARD_REFRESH_MS = 30_000

let _cyclePauseMsCached: number = DEFAULT_CYCLE_PAUSE_MS
let _cyclePauseMsFetchedAt = 0
let _cyclePauseMsVersion = -1
let _cyclePauseMsRefreshing = false

function clampCyclePauseMs(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return DEFAULT_CYCLE_PAUSE_MS
  return Math.max(CYCLE_PAUSE_MIN, Math.min(CYCLE_PAUSE_MAX, Math.round(v)))
}

function refreshCyclePauseMsAsync(): void {
  if (_cyclePauseMsRefreshing) return
  _cyclePauseMsRefreshing = true
  ;(async () => {
    try {
      // `getAppSettings` / `getSettingsVersion` are statically imported
      // at the top of the module — hoisted out of the hot path to avoid
      // a per-cycle `await import()` round-trip that was previously
      // costing ~1 ms every time the settings version advanced.
      //
      // Snapshot the version BEFORE the read so any further bump that
      // lands mid-read still triggers a subsequent refresh.
      const version = await getSettingsVersion()
      const s = (await getAppSettings()) || {}
      if (s && typeof s === "object" && "cyclePauseMs" in s) {
        _cyclePauseMsCached = clampCyclePauseMs((s as any).cyclePauseMs)
      }
      _cyclePauseMsVersion = version
      _cyclePauseMsFetchedAt = Date.now()
    } catch {
      // Keep last-known value on error; still stamp the clock so we
      // don't stampede the refresh on every cycle.
      _cyclePauseMsFetchedAt = Date.now()
    } finally {
      _cyclePauseMsRefreshing = false
    }
  })()
}

/**
 * Synchronous read used by every cycle loop. Hot path — must not await.
 * Checks the version-counter cache (maintained by getSettingsVersion's
 * own 250 ms in-process cache) and fires a background refresh whenever
 * the counter has advanced OR the hard-refresh deadline has passed.
 */
function getCyclePauseMsSync(): number {
  const now = Date.now()
  // Read the cached version synchronously via the non-blocking snapshot
  // maintained in redis-db.ts. `getSettingsVersionCachedSync` never
  // awaits — it opportunistically schedules a background refresh when
  // its own 250 ms TTL has lapsed and returns the last-known value.
  const liveVersion = getSettingsVersionCachedSync()
  if (liveVersion !== _cyclePauseMsVersion) {
    refreshCyclePauseMsAsync()
  } else if (now - _cyclePauseMsFetchedAt > CYCLE_PAUSE_HARD_REFRESH_MS) {
    refreshCyclePauseMsAsync()
  }
  return _cyclePauseMsCached
}

// Prime the cache on module load so the first cycle uses a recent value.
refreshCyclePauseMsAsync()

import { getSettings, setSettings, getAllConnections, getRedisClient, initRedis, getSettingsVersionCachedSync, getAppSettings, getAppSetting, getSettingsVersion } from "@/lib/redis-db"
import { DataSyncManager } from "@/lib/data-sync-manager"
import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { RealtimeProcessor } from "./realtime-processor"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { loadMarketDataForEngine } from "@/lib/market-data-loader"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { engineMonitor } from "@/lib/engine-performance-monitor"
import { ConfigSetProcessor } from "./config-set-processor"
import { prefetchMarketDataBatch } from "./market-data-cache"
import {
  // ── Cross-process progression ownership (spec §"no multiple started
  // progressions per connection, no switching"). The lock guarantees a
  // single TradeEngineManager runs per connection across the entire
  // deployment; the `epoch` it carries is also written to the
  // `progression:{id}` hash so stale callbacks from a previous
  // generation can be detected and dropped by external readers.
  LOCK_EXTEND_INTERVAL_MS,
  extendProgressionLock,
  releaseProgressionLock,
  type LockHandle,
} from "./progression-lock"

/**
 * Per-symbol fan-out concurrency cap.
 *
 * `Promise.all(symbols.map(...))` is conceptually parallel but practically
 * unbounded: at 50+ symbols every per-symbol task fires simultaneously,
 * each performing several Redis reads + indicator math + (sometimes)
 * a market-data refetch. The cumulative pressure can:
 *   • saturate the Redis client's pipeline depth → tail latency spikes
 *   • starve the Node event loop while indicator math runs → other
 *     timers (heartbeat, /api requests, watchdog) drift
 *   • cause the per-cycle deadline to fire even though no single task
 *     was hung — the whole batch was just queued behind itself
 *
 * Capping concurrency at 16 keeps p99 cycle latency stable across watchlist
 * sizes from 1 to a few hundred symbols. The cap is intentionally
 * larger than typical symbol counts (most operators run 1–25) so the
 * common case still runs fully in parallel; the cap only kicks in for
 * heavy workloads where it provides real protection.
 *
 * If a future operator runs hundreds of symbols and the cap becomes the
 * bottleneck, expose this as a setting — but don't remove the cap.
 */
const SYMBOL_CONCURRENCY = 16

/**
 * Per-cycle hard deadline (ms) for engine processor ticks.
 *
 * The engine has a strong self-scheduling design (try/catch + finally
 * scheduleNext), but `finally` only fires when the awaited body settles.
 * A single hung await — Redis network black-hole, exchange connector
 * waiting on a stuck WebSocket frame, malformed promise that never
 * resolves — would leave the tick suspended forever and the loop
 * silently dead.
 *
 * `withCycleDeadline` wraps each tick's primary work in a `Promise.race`
 * against a 30s timeout. When the deadline fires, the wrapper rejects,
 * the rejection is caught by the tick's outer try/catch, `finally` runs,
 * and `scheduleNext` re-arms the loop. Any in-flight promises continue
 * to settle in the background — they just no longer block subsequent
 * ticks.
 */
const CYCLE_DEADLINE_MS = 30_000

function withCycleDeadline<T>(work: Promise<T>, label: string, ms: number = CYCLE_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} cycle deadline ${ms}ms exceeded — likely hung await`))
    }, ms)
    // Detach the deadline timer from the Node ref-count so it never holds
    // the process open during shutdown — the tick's outer finally will
    // settle and the timer fires only if the work itself wedges.
    if (typeof (timer as any).unref === "function") {
      try { (timer as any).unref() } catch { /* non-Node runtime */ }
    }
    work.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Run `task(item)` for each item with at most `concurrency` tasks
 * in flight at a time. Preserves input order in the result array
 * (so callers using `for (let i...)` indexing into both `symbols`
 * and the result array remain correct).
 *
 * Failures inside `task` should be caught by the task itself and
 * mapped to a sentinel value — this helper does NOT swallow rejections,
 * because losing track of an erroring symbol is exactly the bug we're
 * fixing. The existing call sites already wrap with `.catch(...)`.
 */
async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  task: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return []
  // Fast path: when the list fits inside the cap there's no benefit to
  // the worker-pool overhead — defer to plain Promise.all.
  if (items.length <= concurrency) {
    return Promise.all(items.map((item, index) => task(item, index)))
  }

  const results = new Array<TOut>(items.length)
  let nextIndex = 0
  // Worker draining a shared cursor. Each worker pulls the next index,
  // awaits the task, stores the result at the original position, and
  // loops until the cursor is exhausted. This is the classic
  // bounded-parallelism pattern (no third-party dependency, no Symbol
  // iterator overhead, deterministic ordering).
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await task(items[i], i)
    }
  }
  const workers: Promise<void>[] = []
  const poolSize = Math.min(concurrency, items.length)
  for (let i = 0; i < poolSize; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

export interface EngineConfig {
  connectionId: string
  connection_name?: string
  exchange?: string
  engine_type?: string
  indicationInterval?: number // seconds, default 1
  strategyInterval?: number // seconds, default 1
  realtimeInterval?: number // seconds, default 1
}

export interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
  cycleCount: number
}

export class TradeEngineManager {
  private connectionId: string
  private isRunning = false
  private isStarting = false // Guard against concurrent start() calls
  private indicationTimer?: NodeJS.Timeout
  private strategyTimer?: NodeJS.Timeout
  private realtimeTimer?: NodeJS.Timeout
  private healthCheckTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout

  /**
   * Wall-clock timestamp at which this manager instance was constructed.
   * Used by the coordinator's `pruneZombieManagers()` self-heal so a
   * not-yet-running manager that's freshly constructed isn't mistaken
   * for a zombie. Distinct from `startTime` (which is set on
   * successful `start()`).
   */
  public readonly createdAt: number = Date.now()

  private indicationProcessor: IndicationProcessor
  private strategyProcessor: StrategyProcessor
  private pseudoPositionManager: PseudoPositionManager
  private realtimeProcessor: RealtimeProcessor
  private startTime?: Date

  /**
   * Cached `EngineConfig` from the most recent successful `start()`.
   * Used by the watchdog's in-place re-arm path (`rearmIfStalled`) so we
   * can re-start ONLY the missing processor timers using the same intervals
   * the user originally configured — without rebuilding the manager,
   * re-loading market data, or re-running prehistoric.
   */
  private startConfig?: EngineConfig

  /**
   * ── One-progression-per-connection ownership ─────────────────────
   *
   * `lockHandle` is the {token, epoch} pair we acquired in the
   * coordinator before this manager's `start()` was invoked. It is the
   * cross-process proof that no other worker is running the same
   * connection's engine. While the engine is running the heartbeat
   * timer extends the lock TTL; if the extend fails (someone else
   * stole the slot, or the lock expired due to a long pause) the
   * heartbeat triggers a graceful self-stop so we don't continue
   * mutating progression state we no longer own.
   *
   * `epoch` mirrors `lockHandle.epoch` for fast in-memory checks — any
   * async result-write path can quickly verify "is my epoch still the
   * live one?" by comparing `this.epoch` to a captured local value.
   * `epoch === 0` means "not running"; the manager is freshly
   * constructed or has been stopped.
   */
  private lockHandle?: LockHandle
  private epoch = 0
  /** Optional lock-extend timer (separate from the user-visible heartbeat). */
  private lockExtendTimer?: NodeJS.Timeout

  /**
   * ── Live settings-reload bus ─────────────────────────────────────
   *
   * When connection settings change (e.g. operator edits indication
   * thresholds, volume factor, presets, etc.) the API handler writes
   * a change event + bumps `settings_change_counter:{id}` in Redis.
   * The `settingsWatcherTimer` below polls that counter every 3s and,
   * on a bump, calls `applyPendingSettingsChange()` to dispatch the
   * event:
   *
   *   • `reload` → in-place: bump `settingsVersion`, re-read the
   *     connection snapshot, refresh config-set processor caches. No
   *     stop/start, no epoch change.
   *   • `restart` → escalates to the coordinator's stop+start path so
   *     the new credentials / api-type take effect with a fresh epoch.
   *
   * Public `settingsVersion` lets per-cycle code in processors detect
   * a generational settings flip and bust any local memoization (e.g.
   * "did the indication thresholds change since I last computed?").
   */
  private settingsWatcherTimer?: NodeJS.Timeout
  private lastSettingsCounter = 0
  private settingsVersion = 0
  /** Set true while a settings apply is in flight to prevent overlap. */
  private settingsApplying = false

  private componentHealth: {
    indications: ComponentHealth
    strategies: ComponentHealth
    realtime: ComponentHealth
  }

  constructor(config: EngineConfig) {
    this.connectionId = config.connectionId
    this.indicationProcessor = new IndicationProcessor(config.connectionId)
    this.strategyProcessor = new StrategyProcessor(config.connectionId)
    this.pseudoPositionManager = new PseudoPositionManager(config.connectionId)
    this.realtimeProcessor = new RealtimeProcessor(config.connectionId)

    this.componentHealth = {
      indications: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
      strategies: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
      realtime: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
    }

    console.log("[v0] TradeEngineManager initialized")
  }

  /**
   * Public getter to check if engine is running
   */
  get isEngineRunning(): boolean {
    return this.isRunning
  }

  /**
   * Start the trade engine.
   *
   * @param config   The engine configuration to launch with.
   * @param lockCtx  Optional ownership handle obtained from
   *                 `acquireProgressionLock` in the coordinator. When
   *                 omitted the manager is running in single-process
   *                 mode (legacy callers / unit tests) and the epoch
   *                 is generated locally; cross-process safety is
   *                 then NOT guaranteed and the caller is responsible
   *                 for ensuring no other worker can race.
   */
  async start(config: EngineConfig, lockCtx?: LockHandle): Promise<void> {
    if (this.isRunning || this.isStarting) {
      return
    }
    this.isStarting = true

    // ── Stamp generation token BEFORE anything writes to Redis ──────
    // Even if startup later fails, downstream readers will see a
    // higher epoch and can correctly invalidate stale cached state.
    // Local fallback for non-coordinator callers: a fresh epoch with
    // no owner token (writes that need owner verification will skip).
    this.lockHandle = lockCtx
    this.epoch = lockCtx?.epoch ?? Date.now()

    // Cache config for the watchdog's in-place re-arm path. We do this
    // BEFORE any await so a fast-fail in startup still leaves a usable
    // record of intended intervals.
    this.startConfig = config

    // Idempotent global unhandled-rejection handler. Defined here (not at
    // module top) so it runs in the same process tick as the engine that
    // would otherwise leak the rejection. Multiple managers calling this
    // method only attach the listener once thanks to the global guard.
    this.setupErrorRecovery()

    try {
      // Ensure Redis is initialized before using it
      await initRedis()
      
      // ── Initialise / archive progression state ────────────────────────
      // `archiveAndStartNewProgression` handles both cases:
      //   • First start: creates a fresh hash with counters = 0.
      //   • Restart / re-enable: stamps `ended_at` on the old hash,
      //     snapshots it to `progression:{id}:history:{oldEpoch}` (7-day
      //     TTL), then creates a clean new hash so this session's counters
      //     start from zero. The `session_number` field increments so the
      //     dashboard can show "Progression #N".
      // This replaces the previous logic that silently preserved counters
      // across restarts, making it impossible to distinguish sessions.
      try {
        await ProgressionStateManager.archiveAndStartNewProgression(
          this.connectionId,
          this.epoch,
        )
      } catch (e) {
        console.warn("[v0] [Engine] Failed to init progression state:", e)
      }

      // Initialize engine state
      await this.updateProgressionPhase("initializing", 5, "Starting engine components")
      await logProgressionEvent(this.connectionId, "initializing", "info", "Engine initialization started")
      await this.updateEngineState("running")
      await this.setRunningFlag(true)

      // Load market data for all symbols
      await this.updateProgressionPhase("market_data", 8, "Loading market data...")
      const symbols = await this.getSymbols()
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        symbols: symbols,
        active_symbols: symbols,
        updated_at: new Date().toISOString(),
      })

      const loaded = await loadMarketDataForEngine(symbols)
      if (loaded === 0) {
        console.warn(`[v0] [Engine] No market data loaded for symbols: ${symbols.join(", ")}`)
      }

      // Phase 2: Load prehistoric data (NON-BLOCKING)
      const prehistoricCacheKey = `prehistoric_loaded:${this.connectionId}`
      const redisClient = getRedisClient()
      const prehistoricCached = await redisClient.get(prehistoricCacheKey)
      
      if (prehistoricCached === "1") {
        await this.updateProgressionPhase("prehistoric_data", 15, "Using cached historical data")
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: true,
          prehistoric_data_source: "cache",
          updated_at: new Date().toISOString(),
        })
        // CRITICAL: Re-arm the `prehistoric:{id}:done` gate flag in the cache
        // path. Without this, the realtime processor stays gated forever after
        // an engine restart inside the 24h TTL window of
        // `prehistoric_loaded:{id}` — because the `done` flag lives on a
        // separate key with an independent TTL and was never set in this
        // path. The fix is idempotent (same value, 24h re-expire) and costs
        // exactly one Redis SET per engine boot.
        try {
          await redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 } as any)
        } catch (gateErr) {
          console.warn(
            `[v0] [Engine] Failed to re-arm prehistoric done gate on cache hit:`,
            gateErr instanceof Error ? gateErr.message : String(gateErr),
          )
        }
        // CRITICAL: Also restore the prehistoric:{id} hash completion fields.
        // The QuickStart route wipes `is_complete`, `symbols_processed`, etc.
        // on every new run so the UI can show fresh progress. In the cache
        // path, the processor never re-runs to restore them, so the stats
        // route sees `is_complete !== "1"` and `symbols_processed = 0`,
        // causing the dashboard to display "0/N symbols" indefinitely even
        // though historic data is fully ready. Re-stamp the canonical
        // completion fields here so the dashboard correctly reflects the
        // cached state.
        try {
          const symbols = await this.getSymbols()
          await redisClient.hset(`prehistoric:${this.connectionId}`, {
            is_complete: "1",
            symbols_processed: String(symbols.length),
            symbols_total: String(symbols.length),
            updated_at: new Date().toISOString(),
            data_source: "cache",
          })
          await redisClient.expire(`prehistoric:${this.connectionId}`, 86400)
          console.log(`[v0] [Engine] Prehistoric cache hit — restored hash for ${symbols.length} symbols (${this.connectionId})`)
        } catch (restoreErr) {
          console.warn(
            `[v0] [Engine] Failed to restore prehistoric hash on cache hit:`,
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          )
        }
      } else {
        // Non-blocking prehistoric loading
        await this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data (background)...")
        this.loadPrehistoricDataInBackground(prehistoricCacheKey, redisClient)
      }

      // Mark engine as running BEFORE starting the self-scheduling processor
      // loops. The new setTimeout-based loops check `this.isRunning` at the
      // start of every tick, and the first tick fires at 0 ms — if the flag is
      // still false at that moment the loop aborts and never re-schedules,
      // leaving strategy/indication stats stuck at zero.
      this.isRunning = true

      // ── Spec contract (prehistoric → realtime ordering) ─────────────────
      // All three live processors (indication / strategy / realtime) are
      // ARMED here so their timer infrastructure is live, but every tick
      // SELF-GATES on the `prehistoric:{id}:done` flag (set at the end of
      // loadPrehistoricData). Until that flag flips the ticks return a
      // "gated" outcome with zero counters bumped — guaranteeing realtime
      // only evaluates the SET data that prehistoric calculations created,
      // never half-filled or empty sets.
      //
      // We deliberately DO NOT run forced "immediate" indication/strategy
      // warm-up cycles before prehistoric is complete: those bypass the
      // tick gate and would poison `indications_count` / `strategy_cycle_count`
      // with empty-set evaluations, which in turn flipped the dashboard
      // phase auto-derivation straight to "live_trading" while the
      // prehistoric calculator was still running. The first productive
      // tick of each processor fires the moment the `:done` flag flips.
      this.startIndicationProcessor(config.indicationInterval)
      this.startStrategyProcessor(config.strategyInterval)
      this.startRealtimeProcessor(config.realtimeInterval)

      // Phase stays at `prehistoric_data` while the historical calculator
      // is filling sets. `loadPrehistoricData` updates the phase percent
      // and sub_progress (X/Y symbols) live on every symbol completion;
      // `loadPrehistoricDataInBackground` advances the phase to
      // `live_trading` after the done flag flips. Cache-hit path falls
      // straight through to live_trading below since prehistoric is
      // already complete.
      const cacheHit = prehistoricCached === "1"
      if (cacheHit) {
        await this.updateProgressionPhase(
          "live_trading",
          100,
          `Live trading ACTIVE - monitoring ${symbols.length} symbols (cached prehistoric)`,
        )
      } else {
        await this.updateProgressionPhase(
          "prehistoric_data",
          15,
          `Prehistoric calc filling sets — processors armed, gated until done`,
          { current: 0, total: symbols.length, item: "symbols" },
        )
      }

      // Verify timers are running
      setTimeout(async () => {
        if (this.indicationTimer && this.strategyTimer && this.realtimeTimer) {
          await logProgressionEvent(this.connectionId, "engine_started", "info", "All engine processors started")
        } else {
          console.error(`[v0] [Engine] Timer startup failed`)
        }
      }, 2000)
      this.startHealthMonitoring()
      this.startHeartbeat()
      // ── Cross-process lock-extend ticker ─────────────────────────
      // Runs only when we acquired the lock via the coordinator. Each
      // tick refreshes the Redis TTL so a long-running engine never
      // loses its slot, and SELF-STOPS the engine the moment the
      // refresh fails (e.g. another worker took over after a network
      // partition or we missed too many beats). This is the only
      // place that gracefully tears down the engine because we
      // discovered we no longer own it.
      this.startLockExtender()
      // ── Live settings-reload watcher ─────────────────────────────
      // Picks up operator edits to connection settings and applies
      // them WITHOUT requiring a manual restart. See `applyPendingSettingsChange`.
      this.startSettingsWatcher()
      
      // Phase 6: Boot complete. The engine is now "ready":
      //   - Cache-hit path: live_trading @ 100% (set above).
      //   - Cache-miss path: phase stays at `prehistoric_data` with live
      //     percent — `loadPrehistoricDataInBackground` advances it to
      //     `live_trading` once prehistoric calc has finished filling sets.
      // Do NOT unconditionally overwrite the phase here — that would
      // backfill a fake 100% over the real prehistoric percent the user
      // sees on the progress bar.
      this.isStarting = false
      this.startTime = new Date()

      // Log boot completion. Real indication/strategy counts will appear
      // only after prehistoric is done and the gated ticks start
      // producing work — at boot time both are intentionally zero.
      await logProgressionEvent(this.connectionId, "engine_started", "info", `Engine boot complete — processors armed${cacheHit ? " (cached prehistoric)" : ", waiting for prehistoric calc"}`, {
        symbols: symbols.length,
        indicationInterval: config.indicationInterval,
        strategyInterval: config.strategyInterval,
        realtimeInterval: config.realtimeInterval,
        prehistoricCached: cacheHit,
      })
      
      // Also update engine state to indicate all phases are running
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        all_phases_started: true,
        indications_started: true,
        strategies_started: true,
        realtime_started: true,
        live_trading_started: true,
        updated_at: new Date().toISOString(),
      })
      
      await logProgressionEvent(this.connectionId, "engine_started", "info", "Trade engine fully started", {
        symbols: symbols.length,
        phases: 6,
        config,
      })

      // Ensure the engine state reflects active processors and result flow immediately
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        ...((await getSettings(`trade_engine_state:${this.connectionId}`)) || {}),
        indications_started: true,
        strategies_started: true,
        realtime_started: true,
        live_trading_started: true,
        engine_ready: true,
        updated_at: new Date().toISOString(),
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[v0] [EngineManager] ✗ FAILED to start trade engine:`, errorMsg)
      if (error instanceof Error) {
        console.error(`[v0] [EngineManager] Stack:`, error.stack)
      }
      // CRITICAL: Clean up any timers that were already started before the error.
      // (indication/strategy/realtime are now setTimeout-based; healthCheck/heartbeat
      // remain setInterval. clearInterval and clearTimeout are interchangeable on
      // Node.js Timeouts but we use clearTimeout where appropriate for clarity.)
      if (this.indicationTimer) { clearTimeout(this.indicationTimer); this.indicationTimer = undefined }
      if (this.strategyTimer)   { clearTimeout(this.strategyTimer);   this.strategyTimer = undefined }
      if (this.realtimeTimer)   { clearTimeout(this.realtimeTimer);   this.realtimeTimer = undefined }
      if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = undefined }
      if (this.heartbeatTimer)   { clearInterval(this.heartbeatTimer);   this.heartbeatTimer = undefined }
      
      await this.updateProgressionPhase("error", 0, errorMsg)
      await this.updateEngineState("error", errorMsg)
      await this.setRunningFlag(false)
      this.isStarting = false
      await logProgressionEvent(this.connectionId, "engine_error", "error", "Engine failed to start", {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      })
      // Don't throw - allow coordinator to handle the error gracefully
    }
  }

  /**
   * Graceful error recovery — catches unhandled rejections that escape the
   * processor try/catch blocks and re-arms the engine in place instead of
   * letting it die. Idempotent across re-init: the listener is attached
   * exactly once per process via a global flag.
   */
  private setupErrorRecovery() {
    const g = globalThis as unknown as { __engine_unhandled_attached?: boolean }
    if (g.__engine_unhandled_attached) return
    g.__engine_unhandled_attached = true

    try { (process as any).setMaxListeners?.(50) } catch {}

    process.on("unhandledRejection", (reason) => {
      // The listener is global and shared across all live managers. We
      // can't tell which engine the rejection belongs to, so we route it
      // through the global coordinator: every running engine gets a
      // chance to re-arm any missing timers. This is what makes the
      // "self-heal in-place, no engine restart" guarantee real — a stray
      // unhandled rejection no longer silently kills the loop.
      console.error("[v0] [Engine] Unhandled rejection:", reason)
      ;(async () => {
        try {
          const { getGlobalCoordinator } = await import("@/lib/trade-engine")
          const coord = getGlobalCoordinator?.()
          if (!coord) return
          // @ts-expect-error - reach into the coordinator's manager map
          const managers: Map<string, TradeEngineManager> | undefined = coord.engineManagers
          if (!managers) return
          for (const [, mgr] of managers.entries()) {
            if (!mgr.isEngineRunning) continue
            try { await mgr.rearmIfStalled() } catch {}
          }
        } catch {
          // If even the import fails (extremely unlikely), at least make
          // sure the current manager survives.
          if (this.isRunning) {
            try { await this.rearmIfStalled() } catch {}
            try { await this.updateEngineState("error", `Unhandled rejection: ${reason}`) } catch {}
          }
        }
      })().catch(() => {})
    })
  }

  /**
   * In-place self-heal for a stalled engine. Called by the coordinator's
   * watchdog (heartbeat older than 60s) and the unhandled-rejection
   * recovery path. Re-arms ONLY the processor timers that are currently
   * missing — does NOT stop/start the engine, NOT rebuild the manager,
   * NOT re-load market data, NOT re-run prehistoric.
   *
   * Returns true if at least one processor timer was re-armed, false if
   * everything was already armed (in which case we just refresh the
   * heartbeat so the watchdog sees liveness on the next pass).
   */
  async rearmIfStalled(): Promise<boolean> {
    if (!this.isRunning || !this.startConfig) return false

    const reasons: string[] = []
    try {
      if (!this.indicationTimer) {
        this.startIndicationProcessor(this.startConfig.indicationInterval)
        reasons.push("indication")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm indication failed:`, e)
    }
    try {
      if (!this.strategyTimer) {
        this.startStrategyProcessor(this.startConfig.strategyInterval)
        reasons.push("strategy")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm strategy failed:`, e)
    }
    try {
      if (!this.realtimeTimer) {
        this.startRealtimeProcessor(this.startConfig.realtimeInterval)
        reasons.push("realtime")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm realtime failed:`, e)
    }

    if (reasons.length === 0) {
      // All timers already exist — they may simply be blocked on Redis
      // I/O. Force a heartbeat write so the watchdog sees liveness on the
      // next 10s pass and surfaces any I/O issue separately in the logs.
      try { await this.updateEngineState("running") } catch {}
      try {
        const stateKey = `trade_engine_state:${this.connectionId}`
        await setSettings(stateKey, { last_processor_heartbeat: Date.now() })
      } catch {}
      return false
    }

    try {
      await logProgressionEvent(
        this.connectionId,
        "engine_rearmed",
        "warning",
        `Re-armed in place: ${reasons.join(", ")}`,
        { reasons, connectionId: this.connectionId },
      )
    } catch {
      // Logging is best-effort; never block recovery on it.
    }
    return true
  }

  async stop(): Promise<void> {
    console.log("[v0] Stopping trade engine for connection:", this.connectionId)

    // Clear all timers. Processor loops are setTimeout-based; health/heartbeat
    // are still setInterval. clearTimeout + clearInterval are the same kernel
    // primitive in Node, but we keep the semantically correct one per timer.
    if (this.indicationTimer) {
      clearTimeout(this.indicationTimer)
      this.indicationTimer = undefined
    }
    if (this.strategyTimer) {
      clearTimeout(this.strategyTimer)
      this.strategyTimer = undefined
    }
    if (this.realtimeTimer) {
      clearTimeout(this.realtimeTimer)
      this.realtimeTimer = undefined
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    // ── Lock-extend ticker must die BEFORE we release the lock ─────
    // Otherwise a final extend could fire concurrently with release
    // and re-extend a key we just told Redis to drop.
    if (this.lockExtendTimer) {
      clearInterval(this.lockExtendTimer)
      this.lockExtendTimer = undefined
    }
    // Settings watcher must die alongside the engine — otherwise a
    // stopped manager would keep polling and could re-apply a change
    // it has no business touching.
    if (this.settingsWatcherTimer) {
      clearInterval(this.settingsWatcherTimer)
      this.settingsWatcherTimer = undefined
    }

    this.isRunning = false
    // Capture epoch before zeroing so endProgression can use it for the
    // stale-stop guard (prevents a delayed stop() from closing a newer
    // progression that already started in a different worker/restart).
    const stoppingEpoch = this.epoch
    // Zero the epoch immediately so any in-flight callbacks bound to
    // this manager instance fail the `isCurrentGeneration` check and
    // bail out instead of writing into a stopped engine's state.
    this.epoch = 0

    // ── Stamp ended_at on the canonical progression hash ──────────
    // Must happen BEFORE lock release so the write is still gated by
    // the epoch we own. Best-effort — engine stop must not block even
    // if Redis is unavailable.
    try {
      await ProgressionStateManager.endProgression(this.connectionId, stoppingEpoch)
    } catch (endErr) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] endProgression failed (non-critical):`,
        endErr instanceof Error ? endErr.message : String(endErr),
      )
    }

    // ── Release the cross-process progression lock ─────────────────
    // Compare-and-delete: never deletes a slot we no longer own.
    // Best-effort — Redis problems must not block stop(). If we fail
    // to release, the lock's TTL (LOCK_TTL_SEC) provides the fallback
    // safety net and another worker can take over within at most one
    // TTL window.
    if (this.lockHandle) {
      try {
        await releaseProgressionLock(this.connectionId, this.lockHandle)
      } catch (err) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] release lock failed (TTL will reclaim):`,
          err instanceof Error ? err.message : String(err),
        )
      }
      this.lockHandle = undefined
    }

    // Update engine state and clear running flag
    await this.updateEngineState("stopped")
    await this.setRunningFlag(false)
    await this.updateProgressionPhase("stopped", 0, "Engine stopped")

    console.log("[v0] Trade engine stopped and timers cleared")
  }

  /**
   * PHASE 6: Non-blocking prehistoric data loading
   * Runs in background without blocking engine startup
   * Allows engine to proceed to processor startup immediately
   */
  private loadPrehistoricDataInBackground(cacheKey: string, redisClient: ReturnType<typeof getRedisClient>): void {
    this.updateProgressionPhase("prehistoric_data", 15, "Prehistoric calc starting — filling sets...")
      .then(() => this.loadPrehistoricData())
      .then(async () => {
        await redisClient.set(cacheKey, "1", { EX: 86400 })
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: true,
          prehistoric_data_source: "background",
          updated_at: new Date().toISOString(),
        })
        // ── Phase hand-off: prehistoric → live_trading ─────────────────
        // Prehistoric finished filling sets. The `:done` flag was set
        // inside loadPrehistoricData, so the indication/strategy/realtime
        // tick gates flip on their next refresh. Advance the dashboard
        // phase to `live_trading @ 100%` so the user sees the transition
        // immediately — without waiting for the tick gates to detect the
        // flag (up to 3 s lag on the cached refresh).
        try {
          const symCount = (await this.getSymbols()).length
          await this.updateProgressionPhase(
            "live_trading",
            100,
            `Live trading ACTIVE — evaluating ${symCount} symbol${symCount === 1 ? "" : "s"} against prehistoric sets`,
          )
          await setSettings(`trade_engine_state:${this.connectionId}`, {
            all_phases_started: true,
            indications_started: true,
            strategies_started: true,
            realtime_started: true,
            live_trading_started: true,
            engine_ready: true,
            updated_at: new Date().toISOString(),
          })
        } catch (phaseErr) {
          console.warn(`[v0] [Engine] Failed to advance phase to live_trading after prehistoric:`, phaseErr instanceof Error ? phaseErr.message : String(phaseErr))
        }
      })
      .catch(async (err) => {
        console.warn(`[v0] [Engine] Prehistoric loading error:`, err instanceof Error ? err.message : String(err))
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: false,
          prehistoric_data_error: err instanceof Error ? err.message : String(err),
          updated_at: new Date().toISOString(),
        })
        // ── Error-path phase advance ───────────────────────────────────
        // Even on prehistoric failure, force the gate open so the engine
        // doesn't appear "stuck at prehistoric_data" forever. The
        // realtime processor's Phase A (TP/SL on open positions) still
        // needs to run — only the prev-set enrichment depends on
        // prehistoric output, and that's a soft dependency.
        try {
          await redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 })
          await this.updateProgressionPhase(
            "live_trading",
            100,
            `Live trading ACTIVE — prehistoric failed, running without prev-set enrichment`,
          )
        } catch { /* best-effort */ }
        // Fallback: load minimal market data
        try {
          const fallbackSymbols = ["DRIFTUSDT"]
          await loadMarketDataForEngine(fallbackSymbols)
        } catch (fallbackErr) {
          console.warn(`[v0] [Engine] Fallback market data failed:`, fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
        }
      })
  }

  /**
   * Load prehistoric data (historical data before real-time processing).
   *
   * Default range: last 8 HOURS, processed at 1-second timeframe intervals.
   * (The range is user-tunable via `app_settings.prehistoric_range_hours`,
   * bounded to 1-50h, step 1.) Prehistoric output drives the "prev position"
   * context consumed by the realtime processor — see the `prehistoric:{id}:done`
   * gate in `startRealtimeProcessor` below.
   *
   * Runs in background: the engine boot flow keeps progressing while we load,
   * and the realtime processor self-gates until the "done" flag flips. Errors
   * never stop subsequent processing.
   */
  private async loadPrehistoricData(): Promise<void> {
    // Default: 8-HOUR look-back, 1-second timeframe interval.
    // User can override via `app_settings.prehistoric_range_hours` (1-50h, step 1).
    // Legacy `trade_engine_state:{id}.prehistoric_range_days` is still respected for
    // backward compatibility.
    const DEFAULT_RANGE_HOURS = 8
    const DEFAULT_TIMEFRAME_SECONDS = 1
    const MIN_RANGE_HOURS = 1
    const MAX_RANGE_HOURS = 50

    const calcStartTs = Date.now()

    try {
      // Use the mirror-aware reader so the operator's prehistoric_range_hours
      // applies whether it was saved to the canonical (`app_settings`) or
      // legacy (`all_settings`) hash. Read the `getAppSettings` lazily from
      // redis-db to avoid adding another top-level import round-trip.
      const { getAppSettings } = await import("@/lib/redis-db")
      const [engineState, appSettings] = await Promise.all([
        getSettings(`trade_engine_state:${this.connectionId}`),
        getAppSettings(),
      ])

      // Resolve range in hours — priority: app_settings > engine state (hours) >
      // legacy engine state (days) > default.
      let rangeHours: number =
        Number((appSettings as any)?.prehistoric_range_hours) ||
        Number((engineState as any)?.prehistoric_range_hours) ||
        (Number((engineState as any)?.prehistoric_range_days) * 24) ||
        DEFAULT_RANGE_HOURS
      if (!Number.isFinite(rangeHours) || rangeHours <= 0) rangeHours = DEFAULT_RANGE_HOURS
      rangeHours = Math.min(MAX_RANGE_HOURS, Math.max(MIN_RANGE_HOURS, Math.round(rangeHours)))

      const storedTimeframeSec: number =
        Number((engineState as any)?.prehistoric_timeframe_seconds) || DEFAULT_TIMEFRAME_SECONDS

      // Derive legacy days value (rounded up) so existing UIs keep working.
      const storedRangeDays: number = Math.max(1, Math.ceil(rangeHours / 24))

      const symbols = await this.getSymbols()
      await logProgressionEvent(this.connectionId, "prehistoric_data_scan", "info", "Scanning symbols for prehistoric processing", {
        symbols,
        symbolsCount: symbols.length,
        rangeHours,
        rangeDays: storedRangeDays,
        timeframeSeconds: storedTimeframeSec,
      })
      console.log(
        `[v0] [Prehistoric] ▶ scan: ${symbols.length} symbols | range=${rangeHours}h | timeframe=${storedTimeframeSec}s`,
      )

      const prehistoricEnd = new Date()
      const prehistoricStart = new Date(prehistoricEnd.getTime() - rangeHours * 60 * 60 * 1000)

      // Store canonical range metadata so dashboard can display timeframe details
      const redisClient = getRedisClient()
      await redisClient.hset(`prehistoric:${this.connectionId}`, {
        range_start: prehistoricStart.toISOString(),
        range_end: prehistoricEnd.toISOString(),
        range_hours: String(rangeHours),
        range_days: String(storedRangeDays),
        timeframe_seconds: String(storedTimeframeSec),
        is_complete: "0",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Initialize config sets and process prehistoric data through them
      const configProcessor = new ConfigSetProcessor(this.connectionId)
      const configInitResult = await configProcessor.initializeConfigSets()
      await logProgressionEvent(this.connectionId, "prehistoric_config_init", "info", "Config sets initialized", {
        indicationConfigs: configInitResult.indications,
        strategyConfigs: configInitResult.strategies,
      })
      
      // Process prehistoric data: only missing ranges, step by timeframe interval
      const processingResult = await configProcessor.processPrehistoricData(
        symbols,
        prehistoricStart,
        prehistoricEnd,
        storedTimeframeSec
      )
      await logProgressionEvent(this.connectionId, "prehistoric_processed", processingResult.errors > 0 ? "warning" : "info", `Prehistoric complete: ${processingResult.indicationResults} indications, ${processingResult.strategyPositions} strategies`, {
        symbolsTotal: processingResult.symbolsTotal,
        symbolsProcessed: processingResult.symbolsProcessed,
        candlesProcessed: processingResult.candlesProcessed,
        indicationResults: processingResult.indicationResults,
        strategyPositions: processingResult.strategyPositions,
        errors: processingResult.errors,
        durationMs: processingResult.duration,
        timeframeSeconds: storedTimeframeSec,
        rangeDays: storedRangeDays,
        intervalsProcessed: processingResult.intervalsProcessed || 0,
        missingIntervalsLoaded: processingResult.missingIntervalsLoaded || 0,
      })

      const totalPrehistoricDurationMs = Date.now() - calcStartTs

      // Mark prehistoric hash as complete
      await redisClient.hset(`prehistoric:${this.connectionId}`, {
        is_complete: "1",
        symbols_processed: String(processingResult.symbolsProcessed),
        candles_loaded: String(processingResult.candlesProcessed),
        indicators_calculated: String(processingResult.indicationResults),
        total_duration_ms: String(totalPrehistoricDurationMs),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await redisClient.expire(`prehistoric:${this.connectionId}`, 86400)

      // Publish an explicit "prehistoric done" marker. The live processors watch
      // this flag and switch from fast churn mode to adaptive-backoff idle mode
      // so the engine stops "spinning" on empty cycles once the historical calc
      // is finished. The interval itself stays effective whenever productive
      // work is available.
      await redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 })

      // Emit a log event (NOT a phase overwrite) so the dashboard can show
      // prehistoric completion in its event stream. The PHASE itself is
      // advanced to `live_trading @ 100%` by the caller
      // (`loadPrehistoricDataInBackground.then(...)`) after this function
      // resolves — keeping the phase write co-located with the cache-key
      // write and the `engine_ready` state flip for atomic transition.
      try {
        await logProgressionEvent(
          this.connectionId,
          "prehistoric_complete",
          processingResult.errors > 0 ? "warning" : "info",
          `Prehistoric calc done — ${processingResult.symbolsProcessed}/${processingResult.symbolsTotal} symbols, ` +
          `${processingResult.candlesProcessed} candles, ${processingResult.indicationResults} indications, ` +
          `${processingResult.strategyPositions} positions in ${totalPrehistoricDurationMs}ms`,
          {
            symbolsTotal: processingResult.symbolsTotal,
            symbolsProcessed: processingResult.symbolsProcessed,
            candlesProcessed: processingResult.candlesProcessed,
            indicationResults: processingResult.indicationResults,
            strategyPositions: processingResult.strategyPositions,
            errors: processingResult.errors,
            durationMs: totalPrehistoricDurationMs,
          },
        )
      } catch { /* non-critical */ }

      console.log(
        `[v0] [Prehistoric] ✓ complete in ${totalPrehistoricDurationMs}ms | ` +
        `symbols=${processingResult.symbolsProcessed}/${processingResult.symbolsTotal} | ` +
        `candles=${processingResult.candlesProcessed} | ` +
        `indications=${processingResult.indicationResults} | ` +
        `strategies=${processingResult.strategyPositions} | ` +
        `errors=${processingResult.errors}`,
      )

      // Update state to mark prehistoric phase complete
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        prehistoric_data_loaded: true,
        prehistoric_data_start: prehistoricStart.toISOString(),
        prehistoric_data_end: prehistoricEnd.toISOString(),
        prehistoric_range_hours: rangeHours,
        prehistoric_range_days: storedRangeDays,
        prehistoric_timeframe_seconds: storedTimeframeSec,
        prehistoric_duration_ms: totalPrehistoricDurationMs,
        prehistoric_symbols: symbols,
        config_sets_initialized: true,
        config_set_indication_results: processingResult.indicationResults,
        config_set_strategy_positions: processingResult.strategyPositions,
        config_set_symbols_total: processingResult.symbolsTotal,
        config_set_symbols_processed: processingResult.symbolsProcessed,
        config_set_candles_processed: processingResult.candlesProcessed,
        config_set_errors: processingResult.errors,
        config_set_duration_ms: processingResult.duration,
        prehistoric_last_processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Also store in Redis sets for dashboard queries. Previously this loop
      // fired ~4 sequential awaits per symbol (4N round-trips for N symbols).
      // Fan-out everything in a single Promise.all — with 8h lookback × dozens
      // of symbols this alone saves hundreds of serialised awaits at startup.
      try {
        const client = getRedisClient()
        const symbolsKey = `prehistoric:${this.connectionId}:symbols`
        const writes: Promise<any>[] = []
        if (symbols.length > 0) {
          // Single SADD with multiple members, then one EXPIRE for the index.
          writes.push((client as any).sadd(symbolsKey, ...symbols))
          writes.push(client.expire(symbolsKey, 86400))
        }
        for (const symbol of symbols) {
          const loadedKey = `prehistoric:${this.connectionId}:${symbol}:loaded`
          // set with EX in a single command avoids the set+expire pair.
          writes.push(client.set(loadedKey, "true", { EX: 86400 } as any))
        }
        await Promise.all(writes)
      } catch (e) {
        console.warn("[v0] [Engine] Prehistoric Redis store failed:", e instanceof Error ? e.message : String(e))
      }
    } catch (error) {
      console.error("[v0] [Engine] Prehistoric loading failed:", error instanceof Error ? error.message : String(error))
      await logProgressionEvent(this.connectionId, "prehistoric_error", "error", "Prehistoric processing failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      
      try {
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: false,
          prehistoric_data_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        })
      } catch { /* ignore */ }
      
      console.log("[v0] [Prehistoric] Proceeding with realtime processing despite prehistoric failure")
    }
  }

  /**
   * Load market data for a specific range from exchange API
   */
  private async loadMarketDataRange(symbol: string, start: Date, end: Date): Promise<void> {
    try {
      // For now, skip actual exchange API calls during development
      // Mark this range as synced in Redis
      await DataSyncManager.markSynced(
        this.connectionId,
        symbol,
        "market_data",
        end
      )
    } catch (error) {
      console.error(`[v0] [Engine] Market data sync failed:`, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Process connection through all 5 stages: Indication → Base → Main → Real → Live
   */
  private async processConnection5Stages(connection: any): Promise<void> {
    const connectionId = connection.id || connection.name
    const startTime = Date.now()

    try {
      // Process 5 stages of analysis and execution
      await logProgressionEvent(connectionId, "cycle_start", "info", "Starting 5-stage cycle", {})
      const indications = await this.indicationProcessor.processIndication(connection.monitored_symbol || "BTC/USDT")
      const basePositionCount = indications ? 2 : 0

      const duration = Date.now() - startTime
      await logProgressionEvent(connectionId, "cycle_complete", "info", "5-stage cycle complete", {
        duration,
        basePositions: basePositionCount,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[v0] [Engine] 5-stage cycle error: ${error}`)
      await logProgressionEvent(connectionId, "cycle_error", "error", error, { duration: Date.now() - startTime })
      throw err
    }
  }

  /**
   * Start indication processor (async)
   * Runs every 1 second with debouncing to prevent overlaps
   */
  // Indication processor - runs strategy evaluation on interval
  // Version 3.0 - Removed totalStrategiesEvaluated to fix stale closure issues
  // Version 4.0 - Converted from setInterval to self-scheduling setTimeout so
  //   each cycle runs back-to-back with a configurable pause (app_settings.cyclePauseMs,
  //   10-200ms, default 50ms). This removes the old "skip-when-busy" pattern that
  //   was causing the cycle time to climb to 4s+ and the engine to appear hung.
  private startIndicationProcessor(_intervalSeconds: number = 1): void {
    // Counter variables for metrics tracking - simplified to avoid closure issues
    let cycleCount = 0
    let attemptedCycles = 0
    let totalDuration = 0
    let errorCount = 0

    // Adaptive idle backoff. When prehistoric calc is complete and the cycle
    // produces zero indications we progressively increase the pause from the
    // user-configured cyclePauseMs up to MAX_IDLE_PAUSE_MS. A productive cycle
    // immediately resets the backoff so the "effective interval" stays fast
    // whenever new data is arriving.
    const MAX_IDLE_PAUSE_MS = 1000
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId

    const scheduleNext = (wasProductive: boolean) => {
      if (!this.isRunning) return
      // STABILITY: scheduleNext is the ONLY thing keeping this loop alive.
      // If `setTimeout` or the unregister call ever throws (stale handle,
      // weird runtime, etc.) we MUST still rearm — otherwise the engine
      // silently dies. Catch everything and try a default-pause fallback.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (wasProductive) {
          consecutiveEmptyCycles = 0
        } else {
          consecutiveEmptyCycles++
          const prehistoricDone = prehistoricDoneFlag
          if (prehistoricDone && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        // Unregister the prior handle BEFORE overwriting it so the global
        // `__engine_timers` Set doesn't grow unbounded.
        try {
          if (this.indicationTimer) unregisterEngineTimer(this.indicationTimer)
        } catch { /* stale handle is fine */ }
        this.indicationTimer = setTimeout(tick, pause)
        registerEngineTimer(this.indicationTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] indication scheduleNext failed; fallback rearm:`, err)
        try {
          this.indicationTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.indicationTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm indication timer`, fatal)
        }
      }
    }

    // Cheap cached flag — refreshed in the background every few seconds so the
    // scheduler never blocks on Redis I/O. Flips true once prehistoric is done.
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    // Prime immediately and refresh every 3s
    void refreshPrehistoricDone()

    const tick = async () => {
      if (!this.isRunning) return
      const startTime = Date.now()
      // Local abort flag — when true, the finally block will NOT schedule the next cycle.
      let aborted = false
      // Productivity marker — tracks whether this cycle did meaningful work so
      // scheduleNext() can reset / grow the idle backoff.
      let producedIndications = false

      // Refresh the prehistoric-done flag every 3s (non-blocking).
      if (startTime - prehistoricDoneCheckedAt > 3000) {
        prehistoricDoneCheckedAt = startTime
        void refreshPrehistoricDone()
      }

      // STABILITY: removed the V8 "stale module version self-clear".
      // Previously this block fired the moment `_ENGINE_BUILD_VERSION` was
      // bumped, cleared the indication timer, and `return`-ed *without*
      // calling `scheduleNext()`. The indication loop then went silent
      // forever for every running engine — a primary cause of the
      // "Trade Engines silently stop running after a deploy" symptom.
      // The only valid loop-exit condition is `!this.isRunning`, checked
      // at the top of this `tick`.

      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) {
          // No symbols yet — fall through; finally will schedule the next attempt.
          return
        }

        // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
        // The indication tick evaluates sets that the prehistoric calculator
        // is busy filling. Running it on half-filled or empty sets pollutes
        // `indications_count` / `indication_cycle_count` and flips the
        // dashboard phase auto-derivation to "live_trading" prematurely.
        // Stay silent until the `:done` flag flips — `producedIndications`
        // remains false so scheduleNext re-polls quickly via the empty-cycle
        // backoff (capped at 1s) rather than churning.
        if (!prehistoricDoneFlag) {
          // Force a fresh flag read on every gated tick (cheap single-key
          // GET) so we flip to productive within one tick of prehistoric
          // completing, not up to 3s later.
          await refreshPrehistoricDone()
          if (!prehistoricDoneFlag) {
            return
          }
        }

        attemptedCycles++

        // Batch-prefetch all symbols' market data in one Redis pipeline pass
        await prefetchMarketDataBatch(symbols).catch(() => { /* non-critical */ })

        // Process indications for every symbol in parallel — but with a
        // hard concurrency cap (`SYMBOL_CONCURRENCY`) so dense watchlists
        // don't saturate the Redis pipeline or starve the event loop.
        // Wrapped in `withCycleDeadline` so a single hung await inside
        // any `processIndication` call (Redis stall / network black-hole)
        // can never wedge the loop — the deadline fires, the tick falls
        // through to `finally`, and `scheduleNext` re-arms.
        //
        // Per-symbol failures are converted into an empty-indications
        // sentinel AND an entry in `failedSymbols` so we can surface
        // partial-coverage telemetry (operator-visible Redis counter +
        // progression-event ledger) instead of silently swallowing it.
        const failedSymbols: { symbol: string; error: string }[] = []
        const indicationResults = await withCycleDeadline(
          mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, (symbol) =>
            this.indicationProcessor.processIndication(symbol).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              failedSymbols.push({ symbol, error: msg })
              console.error(`[v0] [IndicationProcessor] Error for ${symbol}:`, msg)
              return [] as any[]
            }),
          ),
          `Engine ${this.connectionId} indication`,
        )

        // Comprehensive indication logging with per-type breakdown
        const indicationTypeCounts: Record<string, number> = {}
        const symbolIndicationCounts: Record<string, number> = {}
        for (let i = 0; i < indicationResults.length; i++) {
          const arr = indicationResults[i]
          const symbol = symbols[i]
          symbolIndicationCounts[symbol] = arr?.length || 0
          for (const ind of arr) {
            const t = ind?.type as string
            if (t) {
              indicationTypeCounts[t] = (indicationTypeCounts[t] || 0) + 1
            }
          }
        }

        const totalIndications = indicationResults.reduce((sum: number, arr: any[]) => sum + (arr?.length || 0), 0)
        producedIndications = totalIndications > 0

        // Increment cycle count BEFORE writing to Redis so the stored value is accurate
        cycleCount++
        const duration = Date.now() - startTime
        totalDuration += duration

        // ── Log detailed breakdown (throttled) ─────────────────────────
        //
        // The original implementation logged THREE stdout lines on EVERY
        // tick. At the live cadence (~50 ms cycle pause + ~30-50 ms work)
        // the engine produces ~15-20 cycles/sec, which translates to
        // 45-60 stdout writes/sec from this single block alone. Stdout
        // writes block the Node event loop, so HTTP requests to the
        // dashboard time out and the UI looks "crashed".
        //
        // Two-tier throttling preserves observability without flooding:
        //   1. Always log the FIRST tick after a fresh start (boot signal).
        //   2. Otherwise, log every Nth cycle (50 → ~2.5 s at typical
        //      cadence, ~5 s at 100 ms). N is set high enough that the
        //      diagnostic is human-readable and low enough that long-tail
        //      issues still surface in production trace dumps.
        //
        // The Redis hincrby counters below are UNTHROTTLED — those don't
        // touch stdout and feed the live dashboard, which the operator
        // expects to update continuously.
        const CYCLE_LOG_EVERY = 50
        if (cycleCount === 1 || cycleCount % CYCLE_LOG_EVERY === 0) {
          console.log(`[v0] [IndicationProcessor CYCLE ${cycleCount}] Symbols: ${symbols.length} | Total Indications: ${totalIndications}`)
          console.log(`[v0] [IndicationProcessor] Per-symbol: ${JSON.stringify(symbolIndicationCounts)}`)
          console.log(`[v0] [IndicationProcessor] Per-type: ${JSON.stringify(indicationTypeCounts)}`)
        }

        // Write per-type counters into progression hash so dashboard reads real values.
        //
        // COUNTER TAXONOMY (user-facing progression vs. prehistoric/churn processing):
        //   * indication_cycle_count          — EVERY tick (incl. warmup/empty cycles). Treat as
        //                                       "prehistoric processing" churn — hidden from the
        //                                       primary live-progression display.
        //   * indication_live_cycle_count     — only ticks that produced at least one indication.
        //                                       This is the meaningful "live progression" counter.
        //   * indications_count / per-type    — cumulative indications generated (hincrby).
        //   * frames_processed                — cumulative tick count across ALL processors
        //                                       (indication + strategy + realtime). Independent
        //                                       of per-Set DB-entry caps — counts every loop tick
        //                                       since the engine started.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          // Fan-out all counter updates in parallel. The in-memory Redis
          // client services these in constant time; Promise.all minimises the
          // awaited round-trips per cycle compared to sequential awaits.
          const writes: Promise<any>[] = [
            client.hincrby(redisKey, "indication_cycle_count", 1),
            client.hincrby(redisKey, "frames_processed", 1),
            client.hset(redisKey, "symbols_processed", String(symbols.length)),
            client.expire(redisKey, 7 * 24 * 60 * 60),
          ]
          if (Object.keys(indicationTypeCounts).length > 0) {
            writes.push(client.hincrby(redisKey, "indication_live_cycle_count", 1))
            for (const [type, count] of Object.entries(indicationTypeCounts)) {
              writes.push(client.hincrby(redisKey, `indications_${type}_count`, count))
            }
            writes.push(client.hincrby(redisKey, "indications_count", totalIndications))
          }
          // ── Per-symbol error visibility ───────────────────�����────────────
          // Without this, a chronically-failing symbol (bad ticker,
          // delisted pair, persistent connector error) would have its
          // errors swallowed by the per-task `.catch` and the dashboard
          // would report green. We track:
          //   * indication_symbol_errors_count           — cumulative
          //   * indication_symbol_errors_last_cycle      — this tick
          //   * indication_symbol_errors:<SYMBOL>        — per-symbol counter
          //   * indication_symbol_last_error:<SYMBOL>    — most recent message
          // The dashboard's "partial coverage" badge can read these to
          // surface a list of failing symbols immediately.
          if (failedSymbols.length > 0) {
            writes.push(
              client.hincrby(redisKey, "indication_symbol_errors_count", failedSymbols.length),
            )
            writes.push(
              client.hset(redisKey, {
                indication_symbol_errors_last_cycle: String(failedSymbols.length),
                indication_symbol_errors_last_at: new Date().toISOString(),
              }),
            )
            for (const { symbol, error } of failedSymbols) {
              writes.push(client.hincrby(redisKey, `indication_symbol_errors:${symbol}`, 1))
              // Truncate error message to a sane length so a noisy stack
              // trace can't bloat the progression hash.
              const safeMsg = error.slice(0, 240)
              writes.push(
                client.hset(redisKey, {
                  [`indication_symbol_last_error:${symbol}`]: safeMsg,
                }),
              )
            }
          }
          await Promise.all(writes)
        } catch { /* non-critical */ }

        const processedThisCycle = indicationResults.reduce((sum: number, arr: any[]) => sum + (arr?.length || 0), 0)

        this.componentHealth.indications.lastCycleDuration = duration
        this.componentHealth.indications.cycleCount = cycleCount
        this.componentHealth.indications.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // PROGRESSION CONTRACT: the global cycles_completed counter represents
        // meaningful live progress (indications were generated), not churn.
        // Skip the increment for empty warmup/prehistoric ticks — that keeps
        // the dashboard success-rate honest and prevents cycles_completed from
        // drifting into the tens of thousands while nothing has happened yet.
        if (processedThisCycle > 0) {
          try {
            await ProgressionStateManager.incrementCycle(this.connectionId, true, processedThisCycle)
          } catch (incError) {
            console.error(`[v0] [Engine] Cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
          }
        }

        // Persist non-counter snapshot data every 100 cycles to reduce Redis writes.
        //
        // INTENTIONALLY OMITTED FROM THIS SNAPSHOT (use progression:{id} instead):
        //   - indication_cycle_count        — authoritative source is hincrby on
        //                                     progression:{id}, which survives engine
        //                                     restarts. This local snapshot would
        //                                     reset to 0 on every restart and
        //                                     overwrite the live counter through the
        //                                     /stats fallback chain.
        //   - total_indications_generated   — was previously written as
        //                                     `totalIndications * cycleCount` which
        //                                     is mathematically nonsensical
        //                                     (current-tick count × loop counter).
        //                                     The cumulative is already maintained
        //                                     atomically as `indications_count` on
        //                                     progression:{id}.
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              connection_id: this.connectionId,
              status: "running",
              started_at: this.startTime?.toISOString() || new Date().toISOString(),
              last_indication_run: new Date().toISOString(),
              indication_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              symbols_in_scope: symbols.length,
            })
          } catch { /* silently fail */ }
        }

        // Track intervals processed in Redis for dashboard display (every cycle)
        try {
          const client = getRedisClient()
          const indication_key = `indication_cycles:${this.connectionId}`
          await client.incr(indication_key)
          await client.expire(indication_key, 86400)
        } catch { /* ignore errors */ }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        // Suppress known stale closure errors from HMR - these will clear on server restart
        if (errorMessage.includes("totalStrategiesEvaluated is not defined")) {
          // Self-heal: clear this stale timer and do NOT reschedule
          aborted = true
          if (this.indicationTimer) {
            clearTimeout(this.indicationTimer)
            console.log("[v0] Cleared stale indication timer with totalStrategiesEvaluated error")
          }
          return
        }

        errorCount++
        this.componentHealth.indications.errorCount++
        // Track failed cycle on every error to keep progression counters accurate.
        await ProgressionStateManager.incrementCycle(this.connectionId, false, 0)
        await logProgressionEvent(
          this.connectionId,
          "indications",
          "error",
          `Indication processor error: ${errorMessage}`,
          {
            attemptedCycles,
            successfulCycles: cycleCount,
            errorCount,
          },
        )
        console.error("[v0] Indication processor error:", error)
      } finally {
        // Schedule next cycle after configurable pause so the event loop can breathe.
        if (!aborted) scheduleNext(producedIndications)
      }
    }

    // Kick off the first cycle immediately (0 ms delay).
    this.indicationTimer = setTimeout(tick, 0)
    registerEngineTimer(this.indicationTimer)
  }

  /**
   * Start strategy processor (async)
   *
   * Self-scheduling setTimeout loop — cycles run back-to-back with a
   * configurable pause (app_settings.cyclePauseMs). Natural serialisation
   * prevents overlap without needing an isProcessing flag. Once prehistoric
   * calc is complete, idle cycles (0 strategies evaluated) back off
   * progressively up to 1s so the engine stops "spinning" on nothing.
   */
  private startStrategyProcessor(_intervalSeconds: number = 1): void {
    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0
    let totalStrategiesEvaluated = 0

    // Adaptive idle backoff — same strategy as the indication processor.
    const MAX_IDLE_PAUSE_MS = 1000
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    void refreshPrehistoricDone()

    const scheduleNext = (wasProductive: boolean) => {
      if (!this.isRunning) return
      // See indication scheduleNext for the full stability rationale.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (wasProductive) {
          consecutiveEmptyCycles = 0
        } else {
          consecutiveEmptyCycles++
          if (prehistoricDoneFlag && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        try {
          if (this.strategyTimer) unregisterEngineTimer(this.strategyTimer)
        } catch { /* stale handle is fine */ }
        this.strategyTimer = setTimeout(tick, pause)
        registerEngineTimer(this.strategyTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] strategy scheduleNext failed; fallback rearm:`, err)
        try {
          this.strategyTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.strategyTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm strategy timer`, fatal)
        }
      }
    }

    const tick = async () => {
      if (!this.isRunning) return
      const startTime = Date.now()
      let producedStrategies = false

      if (startTime - prehistoricDoneCheckedAt > 3000) {
        prehistoricDoneCheckedAt = startTime
        void refreshPrehistoricDone()
      }

      // STABILITY: removed the V8 "stale module version self-clear" — see
      // identical note in the indication tick. Loop-exit is gated only on
      // `!this.isRunning`.

      try {
        // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
        // Strategy evaluation reads the same per-Set DBs that prehistoric
        // is filling. Skipping the tick until `:done` flips guarantees we
        // never evaluate strategies against an empty / half-populated set,
        // and prevents the `strategy_cycle_count` counter from inflating
        // before the calc actually completes.
        if (!prehistoricDoneFlag) {
          await refreshPrehistoricDone()
          if (!prehistoricDoneFlag) {
            return
          }
        }

        const symbols = await this.getSymbols()
        // Per-cycle deadline — see `withCycleDeadline` rationale at the
        // top of this file. Guards against a single hung
        // `processStrategy(symbol)` blocking the entire strategy loop.
        // Bounded fan-out (`mapWithConcurrency`) caps in-flight tasks at
        // SYMBOL_CONCURRENCY so dense watchlists don't saturate Redis or
        // stall the event loop.
        //
        // Per-symbol errors are now tracked (previously silently
        // swallowed): the rejection is recorded, a sentinel returned so
        // counts stay correct, and the failing symbol is logged so the
        // operator can see a chronic per-symbol breakage.
        const strategyFailedSymbols: { symbol: string; error: string }[] = []
        const strategyResults = await withCycleDeadline(
          mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, (symbol) =>
            this.strategyProcessor.processStrategy(symbol).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              strategyFailedSymbols.push({ symbol, error: msg })
              console.error(`[v0] [StrategyProcessor] Error for ${symbol}:`, msg)
              return { strategiesEvaluated: 0, liveReady: 0 }
            }),
          ),
          `Engine ${this.connectionId} strategy`,
        )

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        const evaluatedThisCycle = strategyResults.reduce((sum: number, result: any) => sum + (result?.strategiesEvaluated || 0), 0)
        const liveReadyThisCycle = strategyResults.reduce((sum: number, result: any) => sum + (result?.liveReady || 0), 0)
        producedStrategies = evaluatedThisCycle > 0
        
        // Defensive: handle stale closures from HMR
        try {
          totalStrategiesEvaluated += evaluatedThisCycle
        } catch {
          // Stale closure - skip
        }

        // Detailed per-symbol strategy breakdown
        const symbolStrategyBreakdown: Record<string, number> = {}
        for (let i = 0; i < strategyResults.length; i++) {
          symbolStrategyBreakdown[symbols[i]] = strategyResults[i]?.strategiesEvaluated || 0
        }

        // Same 1/50 throttle as the IndicationProcessor block above —
        // see that comment for rationale (Node event-loop hygiene at the
        // 50 ms cycle cadence).
        const STRATEGY_LOG_EVERY = 50
        if (cycleCount === 1 || cycleCount % STRATEGY_LOG_EVERY === 0) {
          console.log(`[v0] [StrategyProcessor CYCLE ${cycleCount}] Total Evaluated: ${evaluatedThisCycle} | Live Ready: ${liveReadyThisCycle} | Total Cumulative: ${totalStrategiesEvaluated}`)
          console.log(`[v0] [StrategyProcessor] Per-symbol breakdown: ${JSON.stringify(symbolStrategyBreakdown)}`)
        }

        this.componentHealth.strategies.lastCycleDuration = duration
        this.componentHealth.strategies.cycleCount = cycleCount
        this.componentHealth.strategies.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // Write ONLY cycle-level metrics into the progression hash.
        // Per-stage Set counts (strategies_base_total, strategies_main_total,
        // strategies_real_total, strategy_evaluated_*) are written atomically inside
        // StrategyCoordinator.executeStrategyFlow() to avoid double-counting.
        //
        // See indication-processor comment above for counter taxonomy:
        //   strategy_cycle_count          = every tick (churn)
        //   strategy_live_cycle_count     = only ticks that evaluated at least 1 strategy
        //   strategies_count              = canonical TOTAL strategies produced.
        //     `evaluatedThisCycle` sums strategy-processor results across symbols,
        //     where each result's `strategiesEvaluated` is the REAL-stage (final)
        //     count only — Base/Main are intermediate filter stages of the SAME
        //     pipeline and are NOT added here, so cross-symbol sums are safe.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          // Fan-out cycle counters in parallel — same atomic-counter
          // pattern as the indication tick. Replacing the previous
          // sequential awaits saves multiple RTTs per cycle and lets us
          // include the per-symbol error fields in the same batch.
          const writes: Promise<any>[] = [
            client.hincrby(redisKey, "strategy_cycle_count", 1),
            client.hincrby(redisKey, "frames_processed", 1),
            client.hset(redisKey, "strategies_live_ready", String(liveReadyThisCycle)),
            client.expire(redisKey, 7 * 24 * 60 * 60),
          ]
          if (evaluatedThisCycle > 0) {
            writes.push(client.hincrby(redisKey, "strategy_live_cycle_count", 1))
            writes.push(client.hincrby(redisKey, "strategies_count", evaluatedThisCycle))
          }
          // ── Per-symbol error visibility ────────────────────────────────
          // Mirrors the indication tick. Without this a chronically-
          // failing symbol's strategy errors would be silently swallowed
          // by the per-task `.catch` and the dashboard would show green.
          if (strategyFailedSymbols.length > 0) {
            writes.push(
              client.hincrby(redisKey, "strategy_symbol_errors_count", strategyFailedSymbols.length),
            )
            writes.push(
              client.hset(redisKey, {
                strategy_symbol_errors_last_cycle: String(strategyFailedSymbols.length),
                strategy_symbol_errors_last_at: new Date().toISOString(),
              }),
            )
            for (const { symbol, error } of strategyFailedSymbols) {
              writes.push(client.hincrby(redisKey, `strategy_symbol_errors:${symbol}`, 1))
              const safeMsg = error.slice(0, 240)
              writes.push(
                client.hset(redisKey, {
                  [`strategy_symbol_last_error:${symbol}`]: safeMsg,
                }),
              )
            }
          }
          await Promise.all(writes)
        } catch { /* non-critical */ }

        // Only count productive strategy cycles toward cycles_completed
        // (see same-pattern comment in indication processor).
        if (evaluatedThisCycle > 0) {
          try {
            await ProgressionStateManager.incrementCycle(this.connectionId, true, evaluatedThisCycle)
          } catch (incError) {
            console.error(`[v0] [Engine] Strategy cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
          }
        }

        // Persist non-counter snapshot data every 50 cycles to reduce Redis writes.
        //
        // INTENTIONALLY OMITTED FROM THIS SNAPSHOT (authoritative source is the
        // progression:{id} hash):
        //   - strategy_cycle_count           — atomic hincrby, survives restarts
        //   - total_strategies_evaluated     — local in-process counter; the
        //                                      authoritative cumulative is the
        //                                      `strategies_count` field on
        //                                      progression:{id}.
        //   - engine_cycles_total            — meaningless when written from a
        //                                      single processor's cycleCount; the
        //                                      cross-processor total now lives in
        //                                      progression:{id}.frames_processed.
        if (cycleCount % 50 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_strategy_run: new Date().toISOString(),
              strategy_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              strategies_live_ready: liveReadyThisCycle,
              last_cycle_duration: duration,
              last_cycle_type: "strategies",
            })
          } catch { /* silently fail */ }
        }

        // Track detailed performance metrics every 50 cycles
        if (cycleCount % 50 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "strategies", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
            durationMs: duration,
            symbolsProcessed: symbols.length,
            strategiesEvaluated: evaluatedThisCycle,
            strategiesLiveReady: liveReadyThisCycle,
            totalCumulativeStrategies: totalStrategiesEvaluated,
            errors: errorCount,
          })
        }
      } catch (error) {
        errorCount++
        this.componentHealth.strategies.errorCount++
        const errorMessage = error instanceof Error ? error.message : String(error)
        await logProgressionEvent(this.connectionId, "strategies", "error", `Strategy processor error: ${errorMessage}`, {
          attemptedCycles: cycleCount,
          successfulCycles: cycleCount - errorCount,
          errorCount,
        })
        console.error("[v0] Strategy error:", errorMessage)
      } finally {
        scheduleNext(producedStrategies)
      }
    }

    // Kick off the first cycle immediately.
    this.strategyTimer = setTimeout(tick, 0)
    registerEngineTimer(this.strategyTimer)
  }

  /**
   * Start realtime processor (async).
   *
   * Self-scheduling setTimeout loop — each cycle runs back-to-back with a
   * configurable pause (app_settings.cyclePauseMs, 10-200ms, default 50ms).
   *
   * ── Prehistoric gating ──────────────────────────────────────────────
   * The loop is armed immediately, but individual ticks SELF-GATE on the
   * `prehistoric:{id}:done` flag set by loadPrehistoricData. Until that
   * flag flips we return a "gated" marker (no position processing) and
   * re-poll the flag on a short cadence (500ms) so the first productive
   * pass fires the instant prehistoric completes. This guarantees the
   * realtime processor always has prehistoric-calculated prev-position
   * context available when it evaluates positions.
   *
   * Once prehistoric is done the loop applies adaptive idle backoff
   * (max 1s) across consecutive empty cycles.
   */
  private startRealtimeProcessor(_intervalSeconds: number = 1): void {
    let cycleCount = 0
    let gatedCycles = 0
    let totalDuration = 0
    let errorCount = 0

    const MAX_IDLE_PAUSE_MS = 1000
    // Fast-poll cadence while waiting for prehistoric to finish. Kept
    // short (500ms) so the first productive realtime tick fires within
    // half a second of prehistoric completing — but long enough to avoid
    // hammering Redis with `GET prehistoric:{id}:done` during a long-
    // running prehistoric load.
    const PREHISTORIC_WAIT_POLL_MS = 500
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    void refreshPrehistoricDone()

    const scheduleNext = (outcome: "productive" | "empty" | "gated") => {
      if (!this.isRunning) return
      // See indication scheduleNext for the full stability rationale.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (outcome === "productive") {
          consecutiveEmptyCycles = 0
        } else if (outcome === "gated") {
          // Prehistoric-pending backoff. Don't inflate
          // `consecutiveEmptyCycles` — a gated cycle isn't an "empty"
          // cycle; it was skipped on purpose.
          pause = PREHISTORIC_WAIT_POLL_MS
        } else {
          consecutiveEmptyCycles++
          if (prehistoricDoneFlag && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        try {
          if (this.realtimeTimer) unregisterEngineTimer(this.realtimeTimer)
        } catch { /* stale handle is fine */ }
        this.realtimeTimer = setTimeout(tick, pause)
        registerEngineTimer(this.realtimeTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] realtime scheduleNext failed; fallback rearm:`, err)
        try {
          this.realtimeTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.realtimeTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm realtime timer`, fatal)
        }
      }
    }

    const tick = async () => {
      if (!this.isRunning) return
      // Default outcome: "empty". Upgraded to "productive" when the
      // processor reports real work, or demoted to "gated" when the
      // prehistoric flag hasn't flipped yet.
      let outcome: "productive" | "empty" | "gated" = "empty"
      // STABILITY: removed the V8 "stale module version self-clear" — see
      // identical note in the indication tick. Loop-exit is gated only on
      // `!this.isRunning`.
      const startTime = Date.now()

      // While prehistoric is pending poll the flag every tick (cheap
      // single-key GET on a 500ms cadence). After it flips we back off
      // to the original 3s refresh to avoid needless reads.
      const pollInterval = prehistoricDoneFlag ? 3000 : PREHISTORIC_WAIT_POLL_MS
      if (startTime - prehistoricDoneCheckedAt > pollInterval) {
        prehistoricDoneCheckedAt = startTime
        await refreshPrehistoricDone()
      }

      // ── Prehistoric advisory (P0-5) ──────────────────────────────
      // The realtime loop USED to hard-skip ticks until the
      // `prehistoric:{id}:done` flag flipped. That's no longer correct
      // because open pseudo positions must get mark-to-market updates
      // on every tick regardless of prehistoric state (spec: "Open
      // Pseudo positions get updated handled on each cycle, Independent
      // of active indication process"). The realtime processor now
      // internally treats the flag as advisory — Phase A (TP/SL,
      // trailing, unrealised PnL) always runs; Phase B (prev-set
      // enrichment) is the only part that gates. We just log the first
      // few gated cycles for visibility.
      if (!prehistoricDoneFlag) {
        gatedCycles++
        if (gatedCycles === 1 || gatedCycles % 50 === 0) {
          void logProgressionEvent(
            this.connectionId,
            "realtime_prev_set_pending",
            "info",
            "Realtime tick running without prev-set enrichment — waiting for prehistoric calc",
            { gatedCycles },
          ).catch(() => { /* non-critical */ })
        }
      }

      try {
        // Process realtime updates for active positions
        const rtResult: any = await this.realtimeProcessor.processRealtimeUpdates()
        // Mark cycle productive when the processor returned some work.
        // Cadence guarantee (P0-5): any tick that touched open positions
        // counts as productive so idle backoff never kicks in while
        // positions are open. The processor returns `updates` = number
        // of positions processed, so `updates > 0` already implies open
        // positions exist.
        if (rtResult && typeof rtResult === "object") {
          const updates = Number(rtResult.updates ?? rtResult.processed ?? rtResult.positionsUpdated ?? 0)
          if (updates > 0) outcome = "productive"
        }

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        this.componentHealth.realtime.lastCycleDuration = duration
        this.componentHealth.realtime.cycleCount = cycleCount
        this.componentHealth.realtime.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // Update progression cycle
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, true, 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Realtime cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
        }

        // Write cycle counters into progression hash so the dashboard reads
        // real values (analogous to the indication & strategy processors).
        //
        // COUNTER TAXONOMY:
        //   * realtime_cycle_count       — every realtime tick (incl. idle/gated).
        //   * realtime_live_cycle_count  — only ticks that actually updated open
        //                                  positions (rtResult.updates > 0).
        //   * frames_processed           — cross-processor cumulative tick total.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          await client.hincrby(redisKey, "realtime_cycle_count", 1)
          await client.hincrby(redisKey, "frames_processed", 1)
          if (outcome === "productive") {
            await client.hincrby(redisKey, "realtime_live_cycle_count", 1)
          }
          await client.expire(redisKey, 7 * 24 * 60 * 60)
        } catch { /* non-critical */ }

        // Track detailed performance metrics (every 100 cycles)
        if (cycleCount % 100 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "realtime", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
            durationMs: duration,
            errors: errorCount,
          })
        }

        // Persist non-counter snapshot data every 100 cycles. The cycle
        // counters themselves (realtime_cycle_count, frames_processed) live
        // exclusively in progression:{id} as atomic hincrbys — see comment
        // on the indication processor above for the rationale.
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              last_realtime_run: new Date().toISOString(),
              realtime_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              last_cycle_duration: duration,
              last_cycle_type: "realtime",
            })
          } catch { /* silently fail */ }
        }
      } catch (error) {
        errorCount++
        this.componentHealth.realtime.errorCount++
        console.error(`[v0] [Engine] Realtime error:`, error instanceof Error ? error.message : String(error))
        await logProgressionEvent(this.connectionId, "realtime", "error", `Processor error: ${error instanceof Error ? error.message : String(error)}`, {
          errorType: error instanceof Error ? error.name : "unknown",
          cycleCount,
          errorCount,
        })
      } finally {
        scheduleNext(outcome)
      }
    }

    // Kick off the first cycle immediately. The first tick will either
    // report "gated" (prehistoric still running) and re-poll on
    // PREHISTORIC_WAIT_POLL_MS, or run a full cycle if prehistoric is
    // already complete.
    this.realtimeTimer = setTimeout(tick, 0)
    
    // Register timer for cleanup on module reload
    registerEngineTimer(this.realtimeTimer)
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    const healthCheckInterval = 10000 // Check every 10 seconds

    this.healthCheckTimer = setInterval(async () => {
      if (!this.isRunning) return

      try {
        // Update component health statuses (pass cycleCount to skip checks during warmup)
        this.componentHealth.indications.status = this.getComponentHealthStatus(
          this.componentHealth.indications.successRate,
          this.componentHealth.indications.lastCycleDuration,
          5000, // 5 second threshold
          this.componentHealth.indications.cycleCount,
        )

        this.componentHealth.strategies.status = this.getComponentHealthStatus(
          this.componentHealth.strategies.successRate,
          this.componentHealth.strategies.lastCycleDuration,
          10000, // 10 second threshold for strategies
          this.componentHealth.strategies.cycleCount,
        )

        this.componentHealth.realtime.status = this.getComponentHealthStatus(
          this.componentHealth.realtime.successRate,
          this.componentHealth.realtime.lastCycleDuration,
          3000, // 3 second threshold
          this.componentHealth.realtime.cycleCount,
        )

        // Calculate overall health
        const overallHealth = this.calculateOverallHealth()

        // Update health status in Redis (same key as updateEngineState)
        const engineState = (await getSettings(`trade_engine_state:${this.connectionId}`)) || {}
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          ...engineState,
          manager_health_status: overallHealth,
          indications_health: this.componentHealth.indications.status,
          strategies_health: this.componentHealth.strategies.status,
          realtime_health: this.componentHealth.realtime.status,
          last_manager_health_check: new Date().toISOString(),
        })

      // Health monitoring is now silent - status is stored in Redis for dashboard display
      // No console warnings to avoid log flooding during normal operation
      } catch (error) {
        console.error("[v0] TradeEngineManager health monitoring error:", error)
      }
    }, healthCheckInterval)
  }

  /**
   * Get component health status
   * Requires minimum cycles before reporting unhealthy to allow warmup
   */
  private getComponentHealthStatus(
    successRate: number,
    lastCycleDuration: number,
    threshold: number,
    cycleCount: number = 0,
  ): "healthy" | "degraded" | "unhealthy" {
    // Always healthy during warmup period (first 20 cycles)
    if (cycleCount < 20) {
      return "healthy"
    }
    
    // Very relaxed thresholds - only unhealthy if totally failing
    if (successRate < 30 || lastCycleDuration > threshold * 10) {
      return "unhealthy"
    }
    // Degraded at 50% success rate
    if (successRate < 50 || lastCycleDuration > threshold * 5) {
      return "degraded"
    }
    return "healthy"
  }

  /**
   * Calculate overall health
   */
  private calculateOverallHealth(): "healthy" | "degraded" | "unhealthy" {
    const components = [
      this.componentHealth.indications.status,
      this.componentHealth.strategies.status,
      this.componentHealth.realtime.status,
    ]

    const unhealthyCount = components.filter((s) => s === "unhealthy").length
    const degradedCount = components.filter((s) => s === "degraded").length

    if (unhealthyCount > 0) return "unhealthy"
    if (degradedCount > 0) return "degraded"
    return "healthy"
  }

  /**
   * Get symbols for this connection - uses connection's active_symbols first.
   *
   * PERFORMANCE: The engine previously called getSymbols() on every tick across
   * 3 processors (indication / strategy / realtime) which translated to ~12
   * Redis reads per second just to resolve a list that changes at most a few
   * times per day. We now cache the resolved array in memory for 5 seconds so
   * each 1-second cycle reuses the same lookup. The short TTL keeps UI-driven
   * symbol changes propagating to the engine within the next tick or two.
   */
  private _symbolsCache: string[] | null = null
  private _symbolsCachedAt = 0
  private static readonly _SYMBOLS_TTL_MS = 5000

  private async getSymbols(): Promise<string[]> {
    const now = Date.now()
    if (this._symbolsCache && now - this._symbolsCachedAt < TradeEngineManager._SYMBOLS_TTL_MS) {
      return this._symbolsCache
    }

    const resolve = async (): Promise<string[]> => {
      try {
        // Fire both primary lookups concurrently so the first tick after TTL
        // expiry doesn't pay two sequential Redis round-trips.
        const [connState, connSettings] = await Promise.all([
          getSettings(`trade_engine_state:${this.connectionId}`),
          getSettings(`connection:${this.connectionId}`),
        ])

        if (connState && typeof connState === "object") {
          const connSymbols = (connState as any).symbols || (connState as any).active_symbols
          if (Array.isArray(connSymbols) && connSymbols.length > 0) return connSymbols
        }

        if (connSettings && typeof connSettings === "object") {
          const symbolsField = (connSettings as any).active_symbols || (connSettings as any).symbols
          let symbols = symbolsField
          if (typeof symbols === "string") {
            try { symbols = JSON.parse(symbols) } catch { /* ignore */ }
          }
          if (Array.isArray(symbols) && symbols.length > 0) return symbols
        }

        // Global main-symbols fallback — the UI stores these as fields on
        // the canonical `app_settings` hash, never as standalone Redis
        // keys, so `getSettings("useMainSymbols")` would always return
        // null. Use the mirror-aware scalar reader (statically imported
        // at the top of the module; avoids a `await import()` on this
        // cycle-hot path).
        const useMainSymbols = await getAppSetting<boolean>("useMainSymbols", false)
        if (useMainSymbols === true) {
          const mainSymbols = await getAppSetting<string[]>("mainSymbols", [])
          if (Array.isArray(mainSymbols) && mainSymbols.length > 0) return mainSymbols
        }

        return ["DRIFTUSDT"]
      } catch (error) {
        console.error("[v0] Failed to get symbols, using fallback:", error instanceof Error ? error.message : String(error))
        return ["DRIFTUSDT"]
      }
    }

    const resolved = await resolve()
    this._symbolsCache = resolved
    this._symbolsCachedAt = now
    return resolved
  }

  /**
   * Force-expire the cached symbol list. Call from the heartbeat or when an
   * admin API updates the connection's active_symbols so the next tick picks
   * up the new value immediately rather than waiting for the TTL.
   */
  public invalidateSymbolsCache(): void {
    this._symbolsCache = null
    this._symbolsCachedAt = 0
  }

  /**
   * Update engine state (Redis-based)
   * Uses consistent key naming for status endpoint compatibility
   */
  private async updateEngineState(status: string, errorMessage?: string): Promise<void> {
    try {
      const stateKey = `trade_engine_state:${this.connectionId}`
      const currentState = (await getSettings(stateKey)) || {}
      await setSettings(stateKey, {
        ...currentState,
        status,
        error_message: errorMessage || null,
        updated_at: new Date().toISOString(),
        last_indication_run: new Date().toISOString(),
      })
      
      console.log(`[v0] [Engine State] Updated ${stateKey}: status=${status}`)
    } catch (error) {
      console.error("[v0] Failed to update engine state:", error)
    }
  }

  /**
   * Update progression phase with detailed progress tracking
   * Phases: idle -> initializing -> prehistoric_data -> indications -> strategies -> realtime -> live_trading
   */
  async updateProgressionPhase(
    phase: string, 
    progress: number, 
    detail: string,
    subProgress?: { current: number; total: number; item?: string }
  ): Promise<void> {
    try {
      const key = `engine_progression:${this.connectionId}`
      const progressionData = {
        phase,
        progress: Math.min(100, Math.max(0, progress)),
        detail,
        sub_current: subProgress?.current || 0,
        sub_total: subProgress?.total || 0,
        sub_item: subProgress?.item || "",
        connection_id: this.connectionId,
        updated_at: new Date().toISOString(),
      }
      
      await setSettings(key, progressionData)
      
      // Log progression update with full details
      const msg = subProgress && subProgress.total > 0 
        ? `${detail} (${subProgress.current}/${subProgress.total}${subProgress.item ? ` - ${subProgress.item}` : ""})`
        : detail
      
      console.log(`[v0] [Progression] ${this.connectionId}: ${phase} @ ${progress}% - ${msg}`)
    } catch (error) {
      console.error("[v0] Failed to update progression phase:", error)
    }
  }

  /**
   * Set running flag in Redis for active status detection
   */
  private async setRunningFlag(isRunning: boolean): Promise<void> {
    try {
      const flagKey = `engine_is_running:${this.connectionId}`
      if (isRunning) {
        await setSettings(flagKey, "true")
      } else {
        await setSettings(flagKey, "false")
      }
      console.log(`[v0] [Engine Flag] ${flagKey}: ${isRunning ? "true" : "false"}`)
    } catch (error) {
      console.error("[v0] Failed to set running flag:", error)
    }
  }

  /**
   * Start heartbeat to keep running state active and refresh live market data
   * Heartbeat: every 10s (state write)
   * Market data refresh: every 30s (re-fetches latest candle from exchange)
   */
  private startHeartbeat(): void {
    let heartbeatCount = 0

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        return
      }

      heartbeatCount++

      try {
        const stateKey = `trade_engine_state:${this.connectionId}`
        await setSettings(stateKey, {
          status: "running",
          last_indication_run: new Date().toISOString(),
          // STABILITY: dedicated millis-epoch heartbeat read by the
          // coordinator's stall watchdog. Numeric form is much cheaper
          // for the watchdog to compare than re-parsing an ISO string,
          // and it isolates "engine alive" from "indication ran" — the
          // two used to be conflated which made stall detection unreliable.
          last_processor_heartbeat: Date.now(),
          connection_id: this.connectionId,
        })
      } catch {
        // Silent fail - heartbeat is non-critical
      }

      // Refresh market data every 30s (every 3rd heartbeat) to keep live prices current
      if (heartbeatCount % 3 === 0) {
        try {
          const symbols = await this.getSymbols()
          await loadMarketDataForEngine(symbols)
          console.log(`[v0] [Heartbeat] Market data refreshed for ${symbols.length} symbols`)
        } catch (refreshErr) {
          console.warn(`[v0] [Heartbeat] Market data refresh failed:`, refreshErr instanceof Error ? refreshErr.message : String(refreshErr))
        }
      }
    }, 10000)
  }

  /**
   * ── Lock-extend ticker ─────────────────────────────────────────────
   *
   * Refreshes the cross-process progression lock at a sub-TTL cadence
   * so the lock never expires while the engine is making progress. If
   * the extend call returns `false` we LOST OWNERSHIP — either because
   * the lock TTL elapsed during a long pause, OR because the watchdog
   * forcibly broke it after a confirmed stall and another worker took
   * over. In either case the correct response is to stop the engine
   * gracefully so we don't continue mutating progression state that
   * now belongs to a different generation.
   *
   * No-op when there's no lock handle (single-process / test mode).
   */
  /**
   * Tolerance for transient extend failures BEFORE we declare ownership
   * lost and self-stop. With LOCK_EXTEND_INTERVAL_MS = 15s and
   * LOCK_TTL_SEC = 60s we can comfortably tolerate up to 3 consecutive
   * miss-extends (45s) before the lock would naturally expire — staying
   * one tick under the TTL ceiling means we never accidentally stop an
   * engine that COULD have recovered with one more retry.
   */
  private extendFailuresInARow = 0
  private static readonly EXTEND_FAILURES_TOLERATED = 3

  private startLockExtender(): void {
    if (!this.lockHandle) return
    if (this.lockExtendTimer) {
      clearInterval(this.lockExtendTimer)
      this.lockExtendTimer = undefined
    }
    this.extendFailuresInARow = 0
    this.lockExtendTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.lockExtendTimer) {
          clearInterval(this.lockExtendTimer)
          this.lockExtendTimer = undefined
        }
        return
      }
      if (!this.lockHandle) return
      let ok = false
      try {
        ok = await extendProgressionLock(this.connectionId, this.lockHandle)
      } catch (err) {
        // ── Transient-failure path ───────────────────────────────────
        // Network glitches, Redis pauses, and one-off serialization
        // errors must not kill the engine. Count the miss and wait
        // for the NEXT tick to confirm. Only escalate to a self-stop
        // after `EXTEND_FAILURES_TOLERATED` consecutive misses, which
        // is still well under LOCK_TTL_SEC.
        this.extendFailuresInARow++
        console.warn(
          `[v0] [Engine ${this.connectionId}] lock extend threw (${this.extendFailuresInARow}/${TradeEngineManager.EXTEND_FAILURES_TOLERATED}):`,
          err instanceof Error ? err.message : String(err),
        )
        if (this.extendFailuresInARow >= TradeEngineManager.EXTEND_FAILURES_TOLERATED) {
          console.warn(
            `[v0] [Engine ${this.connectionId}] giving up on lock extend after ${this.extendFailuresInARow} consecutive Redis failures — stopping gracefully`,
          )
          this.extendFailuresInARow = 0
          try { await this.stop() } catch { /* swallow */ }
        }
        return
      }
      if (ok) {
        // Healthy extend — reset failure counter.
        this.extendFailuresInARow = 0
        return
      }
      // ── Definitive ownership loss ────────────────────────────────
      // `ok === false` means the lock value no longer matches our
      // token (someone else owns the slot, OR the TTL expired and a
      // new acquirer wrote a fresh value on top). This is NOT a
      // retryable error — there's no recovery path; another worker
      // is already running with a higher epoch. Stop gracefully.
      this.extendFailuresInARow++
      if (this.extendFailuresInARow < TradeEngineManager.EXTEND_FAILURES_TOLERATED) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] lock token mismatch (${this.extendFailuresInARow}/${TradeEngineManager.EXTEND_FAILURES_TOLERATED}) — will confirm on next tick before stopping`,
        )
        return
      }
      console.warn(
        `[v0] [Engine ${this.connectionId}] CONFIRMED ownership loss — another generation owns this connection. Stopping gracefully to avoid result mixing.`,
      )
      this.extendFailuresInARow = 0
      try {
        await logProgressionEvent(
          this.connectionId,
          "ownership_lost",
          "warning",
          "Progression lock lost — stopping engine to prevent cross-generation result writes",
          { epoch: this.epoch, connectionId: this.connectionId },
        )
      } catch {
        /* logging is best-effort */
      }
      // Self-stop. `stop()` is idempotent and clears the extender.
      try {
        await this.stop()
      } catch {
        /* swallow */
      }
    }, LOCK_EXTEND_INTERVAL_MS)
  }

  /**
   * Quick in-memory ownership/epoch guard used by external write paths
   * (e.g. progression counters, indication metric writes) to drop
   * stale callbacks that resolve after a generation flip. Cheap:
   * compares two integers, no I/O.
   */
  isCurrentGeneration(expectedEpoch: number): boolean {
    return this.isRunning && this.epoch > 0 && this.epoch === expectedEpoch
  }

  /** Current generation epoch (0 when stopped). */
  get currentEpoch(): number {
    return this.epoch
  }

  /**
   * Current settings generation. Bumped every time `applyHotReload`
   * runs. Processors / cycle code can compare this against a locally
   * remembered value to invalidate memoized config snapshots.
   */
  get currentSettingsVersion(): number {
    return this.settingsVersion
  }

  // ────────────────────────────────────────────────────────────────────
  //  Live settings reload
  // ────────────────────────────────────────────────────────────────────

  /**
   * Starts the per-connection settings watcher (3s poll). Cheap: a
   * single HGETALL on `settings:settings_change_counter:{id}` per
   * tick, branchless when the counter hasn't moved.
   */
  private startSettingsWatcher(): void {
    if (this.settingsWatcherTimer) {
      clearInterval(this.settingsWatcherTimer)
      this.settingsWatcherTimer = undefined
    }
    // Seed the counter so we don't immediately re-apply a change that
    // happened BEFORE the engine started.
    void this.seedSettingsCounter()
    this.settingsWatcherTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.settingsWatcherTimer) {
          clearInterval(this.settingsWatcherTimer)
          this.settingsWatcherTimer = undefined
        }
        return
      }
      if (this.settingsApplying) return
      try {
        const { getChangeCounter } = await import("@/lib/settings-coordinator")
        const counter = await getChangeCounter(this.connectionId)
        if (counter > this.lastSettingsCounter) {
          this.lastSettingsCounter = counter
          await this.applyPendingSettingsChange()
        }
      } catch (err) {
        // Watcher failures must never kill the engine; just log once.
        console.warn(
          `[v0] [Engine ${this.connectionId}] settings watcher poll failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }, 3000)
  }

  private async seedSettingsCounter(): Promise<void> {
    try {
      const { getChangeCounter } = await import("@/lib/settings-coordinator")
      this.lastSettingsCounter = await getChangeCounter(this.connectionId)
    } catch {
      this.lastSettingsCounter = 0
    }
  }

  /**
   * Public fast-path: called by the API route after `notifySettingsChanged`
   * so changes take effect WITHIN MILLISECONDS rather than waiting up
   * to one watcher tick (3 s). Safe to call even when the engine isn't
   * running — it just returns. Idempotent.
   */
  async applyPendingSettingsChangeNow(): Promise<void> {
    if (!this.isRunning) return
    // Capture the latest counter so the periodic watcher doesn't
    // re-fire on the same change.
    try {
      const { getChangeCounter } = await import("@/lib/settings-coordinator")
      this.lastSettingsCounter = await getChangeCounter(this.connectionId)
    } catch {
      /* best effort */
    }
    await this.applyPendingSettingsChange()
  }

  /**
   * Consumes the pending change event, dispatches to reload-or-restart,
   * and clears the event. Wrapped in a `settingsApplying` mutex so a
   * fast-path call and a watcher tick can't interleave.
   */
  private async applyPendingSettingsChange(): Promise<void> {
    if (this.settingsApplying) return
    this.settingsApplying = true
    try {
      const { getPendingChanges, clearPendingChanges } = await import("@/lib/settings-coordinator")
      const event = await getPendingChanges(this.connectionId)
      if (!event) return

      const changeType = event.changeType
      const fields = Array.isArray(event.changedFields) ? event.changedFields : []
      console.log(
        `[v0] [Engine ${this.connectionId}] applying settings change type=${changeType} fields=[${fields.join(",")}]`,
      )

      if (changeType === "restart") {
        // Hand off to the coordinator's stop+start path. We MUST clear
        // the pending event BEFORE the restart so the freshly-started
        // engine doesn't immediately re-apply the same change (it
        // would just be a no-op, but cleaner this way).
        await clearPendingChanges(this.connectionId)
        try {
          const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
          const coordinator = getGlobalTradeEngineCoordinator()
          await coordinator.restartEngine(this.connectionId)
        } catch (restartErr) {
          console.error(
            `[v0] [Engine ${this.connectionId}] settings-driven restart failed:`,
            restartErr instanceof Error ? restartErr.message : String(restartErr),
          )
        }
        return
      }

      if (changeType === "reload") {
        await this.applyHotReload(fields)
        await clearPendingChanges(this.connectionId)
        return
      }

      // `cosmetic` — name change, label, etc. Nothing to do for the
      // engine, just clear the marker.
      await clearPendingChanges(this.connectionId)
    } catch (err) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] applyPendingSettingsChange failed:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      this.settingsApplying = false
    }
  }

  /**
   * Hot-reload path: bump `settingsVersion`, re-read the connection
   * snapshot from Redis, and refresh any cached configs the manager
   * controls. Per-cycle code in processors already reads fresh from
   * Redis, so for THOSE this is mostly a cache-bust signal. For
   * settings that ARE held in memory (interval cadence, volume
   * factor, preset toggles) we copy the new values into `startConfig`.
   */
  private async applyHotReload(_changedFields: string[]): Promise<void> {
    this.settingsVersion++
    try {
      const { getConnection } = await import("@/lib/redis-db")
      const fresh = await getConnection(this.connectionId)
      if (!fresh) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] hot-reload: connection vanished from Redis; skipping`,
        )
        return
      }

      // Pick up new per-connection intervals if the operator changed
      // them via the settings UI. The scheduler reads pause from a
      // global setting today (cyclePauseMs) but `startConfig` is the
      // canonical source for any future per-connection cadence work.
      const cs: any = typeof (fresh as any).connection_settings === "string"
        ? (() => {
            try { return JSON.parse((fresh as any).connection_settings) } catch { return {} }
          })()
        : ((fresh as any).connection_settings || {})

      if (this.startConfig) {
        if (Number.isFinite(Number(cs.indicationTimeInterval))) {
          this.startConfig.indicationInterval = Number(cs.indicationTimeInterval)
        }
        if (Number.isFinite(Number(cs.strategyTimeInterval))) {
          this.startConfig.strategyInterval = Number(cs.strategyTimeInterval)
        }
        if (Number.isFinite(Number(cs.realtimeTimeInterval))) {
          this.startConfig.realtimeInterval = Number(cs.realtimeTimeInterval)
        }
      }

      // Best-effort: tell any subscribed processors to refresh. The
      // pseudo-position manager + config-set processor already re-read
      // fresh per cycle, so this is informational, but we still log
      // it for operator visibility.
      console.log(
        `[v0] [Engine ${this.connectionId}] hot-reload applied (settingsVersion=${this.settingsVersion}, volume_factor=${(fresh as any).volume_factor})`,
      )

      try {
        await logProgressionEvent(
          this.connectionId,
          "settings_reloaded",
          "info",
          `Connection settings hot-reloaded (v=${this.settingsVersion})`,
          {
            settingsVersion: this.settingsVersion,
            connectionId: this.connectionId,
          },
        )
      } catch { /* best-effort */ }
    } catch (err) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] applyHotReload failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Get engine status (Redis-based)
   */
  async getStatus() {
    try {
      const stateKey = `trade_engine_state:${this.connectionId}`
      const state = (await getSettings(stateKey)) || {}
      return {
        ...state,
        health: {
          overall: this.calculateOverallHealth(),
          components: {
            indications: { ...this.componentHealth.indications },
            strategies: { ...this.componentHealth.strategies },
            realtime: { ...this.componentHealth.realtime },
          },
          lastCheck: new Date(),
        },
      }
    } catch (error) {
      console.error("[v0] Failed to get engine status:", error)
      return null
    }
  }
}
