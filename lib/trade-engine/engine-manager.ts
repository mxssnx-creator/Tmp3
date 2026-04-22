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

// Force clear ALL old timers when module version changes
if (engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
  console.log(`[v0] Engine version change: ${engineGlobal.__engine_version} -> ${_ENGINE_BUILD_VERSION}, clearing stale timers...`)
  
  // Clear any registered timers from old version
  if (engineGlobal.__engine_timers) {
    for (const timer of engineGlobal.__engine_timers) {
      clearInterval(timer)
    }
    engineGlobal.__engine_timers.clear()
    console.log(`[v0] Cleared stale engine timers`)
  }
  
  // Clear old engine instances
  if (engineGlobal.__engine_instances) {
    engineGlobal.__engine_instances.clear()
  }
  
  engineGlobal.__engine_version = _ENGINE_BUILD_VERSION
}

// Initialize timer set for this version
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
 * [10, 200]. Default 50 ms. Cached in-memory for 10 s to avoid hitting Redis
 * on every cycle of every loop. A synchronous getter (`getCyclePauseMsSync`)
 * returns the last-known value and triggers an async refresh when the cache
 * has expired, so cycle scheduling never blocks on Redis I/O.
 */
const DEFAULT_CYCLE_PAUSE_MS = 50
const CYCLE_PAUSE_MIN = 10
const CYCLE_PAUSE_MAX = 200
const CYCLE_PAUSE_CACHE_TTL_MS = 10_000

let _cyclePauseMsCached: number = DEFAULT_CYCLE_PAUSE_MS
let _cyclePauseMsFetchedAt = 0
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
      const { getSettings } = await import("@/lib/redis-db")
      const s = (await getSettings("app_settings")) || {}
      if (s && typeof s === "object" && "cyclePauseMs" in s) {
        _cyclePauseMsCached = clampCyclePauseMs((s as any).cyclePauseMs)
      }
      _cyclePauseMsFetchedAt = Date.now()
    } catch {
      // Keep last-known value on error
      _cyclePauseMsFetchedAt = Date.now()
    } finally {
      _cyclePauseMsRefreshing = false
    }
  })()
}

function getCyclePauseMsSync(): number {
  if (Date.now() - _cyclePauseMsFetchedAt > CYCLE_PAUSE_CACHE_TTL_MS) {
    // Fire-and-forget refresh; return the cached value immediately.
    refreshCyclePauseMsAsync()
  }
  return _cyclePauseMsCached
}

// Prime the cache on module load so the first cycle uses a recent value.
refreshCyclePauseMsAsync()

import { getSettings, setSettings, getAllConnections, getRedisClient, initRedis } from "@/lib/redis-db"
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

  private indicationProcessor: IndicationProcessor
  private strategyProcessor: StrategyProcessor
  private pseudoPositionManager: PseudoPositionManager
  private realtimeProcessor: RealtimeProcessor
  private startTime?: Date

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
   * Start the trade engine
   */
  async start(config: EngineConfig): Promise<void> {
    if (this.isRunning || this.isStarting) {
      return
    }
    this.isStarting = true

    try {
      // Ensure Redis is initialized before using it
      await initRedis()
      
      // Initialize progression state in Redis if not exists
      try {
        const client = getRedisClient()
        const existingProgression = await client.hgetall(`progression:${this.connectionId}`)
        if (!existingProgression || Object.keys(existingProgression).length === 0) {
          // First time initialization - set all counters to 0
          await client.hset(`progression:${this.connectionId}`, {
            cycles_completed: "0",
            successful_cycles: "0",
            failed_cycles: "0",
            connection_id: this.connectionId,
            last_update: new Date().toISOString(),
            engine_started: "true",
          })
        } else {
          // Engine restarted - preserve existing counters, only update metadata
          await client.hset(`progression:${this.connectionId}`, {
            last_update: new Date().toISOString(),
            engine_started: "true",
          })
        }
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

      // Phase 3-4: Start indication and strategy processors
      await this.updateProgressionPhase("indications", 60, "Processing indications continuously")
      this.startIndicationProcessor(config.indicationInterval)
      // Force an immediate indication cycle
      let immediateSymbols = await this.getSymbols()
      if (!immediateSymbols || immediateSymbols.length === 0) {
        immediateSymbols = ["DRIFTUSDT"]
      }
      const immediateResults = await Promise.all(immediateSymbols.map((symbol) => this.indicationProcessor.processIndication(symbol).catch(() => [])))
      const totalImmediateIndications = immediateResults.reduce((sum, arr) => sum + arr.length, 0)

      await this.updateProgressionPhase("strategies", 75, "Processing strategies continuously")
      this.startStrategyProcessor(config.strategyInterval)
      // Kick off an immediate strategy evaluation cycle
      const strategyResults = await Promise.all(immediateSymbols.map((symbol) => this.strategyProcessor.processStrategy(symbol).catch(() => ({ strategiesEvaluated: 0, liveReady: 0 }))))
      const totalStrategies = strategyResults.reduce((sum, result) => sum + (result?.strategiesEvaluated || 0), 0)

      // Phase 5: Start realtime processor
      //
      // IMPORTANT: The realtime processor is STARTED here (timer loop is
      // armed immediately so the dashboard reports an active processor),
      // but individual ticks SELF-GATE on the `prehistoric:{id}:done` flag
      // written at the end of `loadPrehistoricData`. Until that flag is
      // set the tick returns early with zero updates so the realtime logic
      // never runs against an empty previous-position context.
      //
      // We deliberately DO NOT run a warm-up pass here: firing
      // `processRealtimeUpdates()` before prehistoric is finished would
      // evaluate live positions without any prehistoric-calculated prev-
      // position context, producing TP/SL decisions on cold state. The
      // self-gated loop will run the first productive pass the instant
      // prehistoric completes.
      await this.updateProgressionPhase(
        "realtime",
        85,
        "Realtime processor armed — waiting for prehistoric calc to finish",
      )
      this.startRealtimeProcessor(config.realtimeInterval)

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
      
      // Phase 6: Live trading ready (isRunning was set earlier before processors started)
      this.isStarting = false
      this.startTime = new Date()
      await this.updateProgressionPhase("live_trading", 100, `Live trading ACTIVE - monitoring ${symbols.length} symbols`)
      
      // Log final initialization success
      await logProgressionEvent(this.connectionId, "live_trading", "info", `Engine initialized with ${totalImmediateIndications} indications and ${totalStrategies} strategies`, {
        symbols: symbols.length,
        indicationInterval: config.indicationInterval,
        strategyInterval: config.strategyInterval,
        realtimeInterval: config.realtimeInterval,
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
   * Graceful error recovery - catches errors in processors and logs them
   */
  private setupErrorRecovery() {
    // Processors already have internal error handling
    // This ensures we log and recover from any unhandled errors
    process.on("unhandledRejection", (reason, promise) => {
      if (this.isRunning) {
        console.error("[v0] Unhandled rejection in trade engine:", reason)
        // Update engine state to degraded but keep running
        this.updateEngineState("error", `Unhandled rejection: ${reason}`)
      }
    })
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

    this.isRunning = false

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
    this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data in background...")
      .then(() => this.loadPrehistoricData())
      .then(async () => {
        await redisClient.set(cacheKey, "1", { EX: 86400 })
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: true,
          prehistoric_data_source: "background",
          updated_at: new Date().toISOString(),
        })
      })
      .catch(async (err) => {
        console.warn(`[v0] [Engine] Prehistoric loading error:`, err instanceof Error ? err.message : String(err))
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: false,
          prehistoric_data_error: err instanceof Error ? err.message : String(err),
          updated_at: new Date().toISOString(),
        })
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
      const [engineState, appSettings] = await Promise.all([
        getSettings(`trade_engine_state:${this.connectionId}`),
        getSettings("app_settings"),
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
      // prehistoric completion in its event stream without clobbering the
      // main `engine_progression:{id}` phase hash — which by this point has
      // already advanced to `live_trading @ 100%` (set during boot while
      // prehistoric was running in the background). Rolling the phase
      // backward would be confusing UX; an explicit event is the right
      // channel for this one-shot milestone.
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
      const base = getCyclePauseMsSync()
      let pause = base
      if (wasProductive) {
        consecutiveEmptyCycles = 0
      } else {
        consecutiveEmptyCycles++
        // Only back off once prehistoric is done — during warmup keep the fast
        // cycle pause so we don't stall the initial data pipeline.
        const prehistoricDone = prehistoricDoneFlag
        if (prehistoricDone && consecutiveEmptyCycles > 2) {
          // Exponential-ish: 2x, 4x, 8x base capped at MAX_IDLE_PAUSE_MS
          const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
          pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
        }
      }
      // Unregister the prior handle BEFORE overwriting it — otherwise the
      // global `__engine_timers` Set grows by one entry every cycle and
      // stale handles accumulate forever (memory leak + slow HMR reloads).
      if (this.indicationTimer) unregisterEngineTimer(this.indicationTimer)
      this.indicationTimer = setTimeout(tick, pause)
      registerEngineTimer(this.indicationTimer)
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

      // V8: Early exit if this timer is from a stale module version
      if (engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
        console.log(`[v0] Stale timer detected (version mismatch), self-clearing...`)
        if (this.indicationTimer) {
          clearTimeout(this.indicationTimer)
          unregisterEngineTimer(this.indicationTimer)
        }
        return
      }

      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) {
          // No symbols yet — fall through; finally will schedule the next attempt.
          return
        }

        attemptedCycles++

        // Batch-prefetch all symbols' market data in one Redis pipeline pass
        await prefetchMarketDataBatch(symbols).catch(() => { /* non-critical */ })

        // Process indications for every symbol in parallel.
        const indicationResults = await Promise.all(
          symbols.map((symbol) =>
            this.indicationProcessor.processIndication(symbol).catch((err) => {
              console.error(`[v0] [IndicationProcessor] Error for ${symbol}:`, err instanceof Error ? err.message : String(err))
              return [] as any[]
            })
          )
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

        const totalIndications = indicationResults.reduce((sum, arr) => sum + (arr?.length || 0), 0)
        producedIndications = totalIndications > 0

        // Increment cycle count BEFORE writing to Redis so the stored value is accurate
        cycleCount++
        const duration = Date.now() - startTime
        totalDuration += duration

        // Log detailed breakdown
        console.log(`[v0] [IndicationProcessor CYCLE ${cycleCount}] Symbols: ${symbols.length} | Total Indications: ${totalIndications}`)
        console.log(`[v0] [IndicationProcessor] Per-symbol: ${JSON.stringify(symbolIndicationCounts)}`)
        console.log(`[v0] [IndicationProcessor] Per-type: ${JSON.stringify(indicationTypeCounts)}`)

        // Write per-type counters into progression hash so dashboard reads real values.
        //
        // COUNTER TAXONOMY (user-facing progression vs. prehistoric/churn processing):
        //   * indication_cycle_count          — EVERY tick (incl. warmup/empty cycles). Treat as
        //                                       "prehistoric processing" churn — hidden from the
        //                                       primary live-progression display.
        //   * indication_live_cycle_count     �� only ticks that produced at least one indication.
        //                                       This is the meaningful "live progression" counter.
        //   * indications_count / per-type    — cumulative indications generated (hincrby).
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          // Fan-out all counter updates in parallel. The in-memory Redis
          // client services these in constant time; Promise.all minimises the
          // awaited round-trips per cycle compared to sequential awaits.
          const writes: Promise<any>[] = [
            client.hincrby(redisKey, "indication_cycle_count", 1),
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
          await Promise.all(writes)
        } catch { /* non-critical */ }

        const processedThisCycle = indicationResults.reduce((sum, arr) => sum + (arr?.length || 0), 0)

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

        // Persist cycle count every 100 cycles to reduce Redis writes
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              connection_id: this.connectionId,
              status: "running",
              started_at: this.startTime?.toISOString() || new Date().toISOString(),
              last_indication_run: new Date().toISOString(),
              indication_cycle_count: cycleCount,
              indication_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              engine_cycles_total: cycleCount,
              total_indications_generated: totalIndications * cycleCount,
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
      // See indication processor: unregister the previous handle so the
      // global timer Set doesn't grow unbounded.
      if (this.strategyTimer) unregisterEngineTimer(this.strategyTimer)
      this.strategyTimer = setTimeout(tick, pause)
      registerEngineTimer(this.strategyTimer)
    }

    const tick = async () => {
      if (!this.isRunning) return
      const startTime = Date.now()
      let producedStrategies = false

      if (startTime - prehistoricDoneCheckedAt > 3000) {
        prehistoricDoneCheckedAt = startTime
        void refreshPrehistoricDone()
      }

      // V8: Early exit if this timer is from a stale module version
      if (engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
        console.log(`[v0] Stale strategy timer detected, self-clearing...`)
        if (this.strategyTimer) {
          clearTimeout(this.strategyTimer)
          unregisterEngineTimer(this.strategyTimer)
        }
        return
      }

      try {
        const symbols = await this.getSymbols()
        const strategyResults = await Promise.all(
          symbols.map((symbol) =>
            this.strategyProcessor.processStrategy(symbol).catch(() => ({ strategiesEvaluated: 0, liveReady: 0 }))
          )
        )

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        const evaluatedThisCycle = strategyResults.reduce((sum, result) => sum + (result?.strategiesEvaluated || 0), 0)
        const liveReadyThisCycle = strategyResults.reduce((sum, result) => sum + (result?.liveReady || 0), 0)
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

        console.log(`[v0] [StrategyProcessor CYCLE ${cycleCount}] Total Evaluated: ${evaluatedThisCycle} | Live Ready: ${liveReadyThisCycle} | Total Cumulative: ${totalStrategiesEvaluated}`)
        console.log(`[v0] [StrategyProcessor] Per-symbol breakdown: ${JSON.stringify(symbolStrategyBreakdown)}`)

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
          await client.hincrby(redisKey, "strategy_cycle_count", 1)
          if (evaluatedThisCycle > 0) {
            await client.hincrby(redisKey, "strategy_live_cycle_count", 1)
            await client.hincrby(redisKey, "strategies_count", evaluatedThisCycle)
          }
          await client.hset(redisKey, "strategies_live_ready", String(liveReadyThisCycle))
          await client.expire(redisKey, 7 * 24 * 60 * 60)
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

        // Persist cycle count every 50 cycles (faster update rate for strategies)
        if (cycleCount % 50 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_strategy_run: new Date().toISOString(),
              strategy_cycle_count: cycleCount,
              strategy_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              total_strategies_evaluated: typeof totalStrategiesEvaluated !== "undefined" ? totalStrategiesEvaluated : 0,
              strategies_live_ready: liveReadyThisCycle,
              last_cycle_duration: duration,
              last_cycle_type: "strategies",
              engine_cycles_total: cycleCount,
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
      const base = getCyclePauseMsSync()
      let pause = base
      if (outcome === "productive") {
        consecutiveEmptyCycles = 0
      } else if (outcome === "gated") {
        // Prehistoric-pending backoff. Don't inflate `consecutiveEmpty-
        // Cycles` — a gated cycle isn't an "empty" cycle; it was skipped
        // on purpose. We just wait the fixed short interval so we pick
        // up the done-flag flip promptly.
        pause = PREHISTORIC_WAIT_POLL_MS
      } else {
        consecutiveEmptyCycles++
        if (prehistoricDoneFlag && consecutiveEmptyCycles > 2) {
          const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
          pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
        }
      }
      // See indication processor: unregister the previous handle so the
      // global timer Set doesn't grow unbounded.
      if (this.realtimeTimer) unregisterEngineTimer(this.realtimeTimer)
      this.realtimeTimer = setTimeout(tick, pause)
      registerEngineTimer(this.realtimeTimer)
    }

    const tick = async () => {
      if (!this.isRunning) return
      // Default outcome: "empty". Upgraded to "productive" when the
      // processor reports real work, or demoted to "gated" when the
      // prehistoric flag hasn't flipped yet.
      let outcome: "productive" | "empty" | "gated" = "empty"
      // V8: Early exit if this timer is from a stale module version
      if (engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
        if (this.realtimeTimer) {
          clearTimeout(this.realtimeTimer)
          unregisterEngineTimer(this.realtimeTimer)
        }
        return
      }
      const startTime = Date.now()

      // While prehistoric is pending poll the flag every tick (cheap
      // single-key GET on a 500ms cadence). After it flips we back off
      // to the original 3s refresh to avoid needless reads.
      const pollInterval = prehistoricDoneFlag ? 3000 : PREHISTORIC_WAIT_POLL_MS
      if (startTime - prehistoricDoneCheckedAt > pollInterval) {
        prehistoricDoneCheckedAt = startTime
        await refreshPrehistoricDone()
      }

      // ── Prehistoric gate ──────────────────────────────────────────
      // Realtime processing MUST NOT run until prehistoric has produced
      // the per-symbol Set calculations that provide the "prev position"
      // context. Skip the cycle with a lightweight log and let
      // scheduleNext() re-poll on the short cadence.
      if (!prehistoricDoneFlag) {
        gatedCycles++
        // Emit a progression log at a very low rate so the dashboard can
        // surface the wait state without drowning the log list.
        if (gatedCycles === 1 || gatedCycles % 20 === 0) {
          void logProgressionEvent(
            this.connectionId,
            "realtime_gated",
            "info",
            "Realtime tick skipped — waiting for prehistoric calculation to finish",
            { gatedCycles },
          ).catch(() => { /* non-critical */ })
        }
        outcome = "gated"
        scheduleNext(outcome)
        return
      }

      try {
        // Process realtime updates for active positions
        const rtResult: any = await this.realtimeProcessor.processRealtimeUpdates()
        // Mark cycle productive when the processor returned some work.
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

        // Update Redis every 100 cycles
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              last_realtime_run: new Date().toISOString(),
              realtime_cycle_count: cycleCount,
              realtime_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              last_cycle_duration: duration,
              last_cycle_type: "realtime",
              engine_cycles_total: cycleCount,
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

        // Global main-symbols fallback
        const useMainSymbols = await getSettings("useMainSymbols")
        if (useMainSymbols === true || useMainSymbols === "true") {
          const mainSymbols = await getSettings("mainSymbols")
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
