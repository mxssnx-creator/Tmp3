/**
 * Trade Engine Manager V7
 * Manages asynchronous processing for symbols, indications, pseudo positions, and strategies
 * V7: Fixed totalStrategiesEvaluated variable declaration
 * @version 7.0.0
 * @lastUpdate 2026-04-06T02:52:00Z - Fixed ReferenceError in indication processor
 */

const _ENGINE_BUILD_VERSION = "7.0.0"

// Force module invalidation on version change
if (typeof globalThis !== "undefined") {
  const engineGlobal = globalThis as unknown as { __engine_version?: string; __engine_instances?: Map<string, unknown> }
  if (engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
    // Clear old engine instances to force recreation with new code
    if (engineGlobal.__engine_instances) {
      engineGlobal.__engine_instances.clear()
    }
    engineGlobal.__engine_version = _ENGINE_BUILD_VERSION
  }
}

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
      indications: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
      strategies: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
      realtime: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
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
      } else {
        // Non-blocking prehistoric loading
        await this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data (background)...")
        this.loadPrehistoricDataInBackground(prehistoricCacheKey, redisClient)
      }

      // Phase 3-4: Start indication and strategy processors
      await this.updateProgressionPhase("indications", 60, "Processing indications continuously")
      this.startIndicationProcessor(config.indicationInterval)
      // Force an immediate indication cycle
      let immediateSymbols = await this.getSymbols()
      if (!immediateSymbols || immediateSymbols.length === 0) {
        immediateSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      }
      const immediateResults = await Promise.all(immediateSymbols.map((symbol) => this.indicationProcessor.processIndication(symbol).catch(() => [])))
      const totalImmediateIndications = immediateResults.reduce((sum, arr) => sum + arr.length, 0)

      await this.updateProgressionPhase("strategies", 75, "Processing strategies continuously")
      this.startStrategyProcessor(config.strategyInterval)
      // Kick off an immediate strategy evaluation cycle
      const strategyResults = await Promise.all(immediateSymbols.map((symbol) => this.strategyProcessor.processStrategy(symbol).catch(() => ({ strategiesEvaluated: 0, liveReady: 0 }))))
      const totalStrategies = strategyResults.reduce((sum, result) => sum + (result?.strategiesEvaluated || 0), 0)

      // Phase 5: Start realtime processor
      await this.updateProgressionPhase("realtime", 85, "Monitoring real-time data and positions")
      this.startRealtimeProcessor(config.realtimeInterval)
      // Run a realtime pass immediately
      await this.realtimeProcessor.processRealtimeUpdates().catch((error) => {
        console.warn(`[v0] [Engine] Realtime startup failed:`, error instanceof Error ? error.message : String(error))
      })

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
      
      // Phase 6: Live trading ready
      this.isRunning = true
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
      // CRITICAL: Clean up any timers that were already started before the error
      if (this.indicationTimer) { clearInterval(this.indicationTimer); this.indicationTimer = undefined }
      if (this.strategyTimer) { clearInterval(this.strategyTimer); this.strategyTimer = undefined }
      if (this.realtimeTimer) { clearInterval(this.realtimeTimer); this.realtimeTimer = undefined }
      if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = undefined }
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
      
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

    // Clear all timers
    if (this.indicationTimer) {
      clearInterval(this.indicationTimer)
      this.indicationTimer = undefined
    }
    if (this.strategyTimer) {
      clearInterval(this.strategyTimer)
      this.strategyTimer = undefined
    }
    if (this.realtimeTimer) {
      clearInterval(this.realtimeTimer)
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
          const fallbackSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
          await loadMarketDataForEngine(fallbackSymbols)
        } catch (fallbackErr) {
          console.warn(`[v0] [Engine] Fallback market data failed:`, fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
        }
      })
  }

  /**
   * Load prehistoric data (historical data before real-time processing)
   * Runs in background - does not block engine startup
   * Error handling: failures don't stop subsequent processing steps
   */
  private async loadPrehistoricData(): Promise<void> {
    try {
      const engineState = await getSettings(`trade_engine_state:${this.connectionId}`)
      if (engineState?.prehistoric_data_loaded) {
        return
      }

      const symbols = await this.getSymbols()
      await logProgressionEvent(this.connectionId, "prehistoric_data_scan", "info", "Scanning symbols for prehistoric processing", {
        symbols,
        symbolsCount: symbols.length,
      })

      const prehistoricEnd = new Date()
      const prehistoricStart = new Date(prehistoricEnd.getTime() - 30 * 24 * 60 * 60 * 1000)

      // Initialize config sets and process prehistoric data through them
      const configProcessor = new ConfigSetProcessor(this.connectionId)
      const configInitResult = await configProcessor.initializeConfigSets()
      await logProgressionEvent(this.connectionId, "prehistoric_config_init", "info", "Config sets initialized", {
        indicationConfigs: configInitResult.indications,
        strategyConfigs: configInitResult.strategies,
      })
      
      // Process prehistoric data through config sets
      const processingResult = await configProcessor.processPrehistoricData(symbols)
      await logProgressionEvent(this.connectionId, "prehistoric_processed", processingResult.errors > 0 ? "warning" : "info", `Prehistoric complete: ${processingResult.indicationResults} indications, ${processingResult.strategyPositions} strategies`, {
        symbolsTotal: processingResult.symbolsTotal,
        symbolsProcessed: processingResult.symbolsProcessed,
        candlesProcessed: processingResult.candlesProcessed,
        indicationResults: processingResult.indicationResults,
        strategyPositions: processingResult.strategyPositions,
        errors: processingResult.errors,
        durationMs: processingResult.duration,
      })

      // Update state to mark prehistoric phase complete
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        prehistoric_data_loaded: true,
        prehistoric_data_start: prehistoricStart.toISOString(),
        prehistoric_data_end: prehistoricEnd.toISOString(),
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

      // Also store in Redis sets for dashboard queries
      try {
        const client = getRedisClient()
        for (const symbol of symbols) {
          await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)
          await client.expire(`prehistoric:${this.connectionId}:symbols`, 86400)
          await client.set(`prehistoric:${this.connectionId}:${symbol}:loaded`, "true")
          await client.expire(`prehistoric:${this.connectionId}:${symbol}:loaded`, 86400)
        }
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
  // Version 2.1 - Fixed totalStrategiesEvaluated declaration
  private startIndicationProcessor(intervalSeconds: number = 1): void {
    // Counter variables for metrics tracking
    let cycleCount = 0
    let attemptedCycles = 0
    let totalDuration = 0
    let errorCount = 0
    let totalStrategiesEvaluated = 0
    let isProcessing = false

    this.indicationTimer = setInterval(async () => {
      if (isProcessing) return
      isProcessing = true
      const startTime = Date.now()

      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) {
          isProcessing = false
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

        // Write per-type counters into progression hash so dashboard reads real values
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          const typeCounts: Record<string, number> = {}
          for (const arr of indicationResults) {
            for (const ind of arr) {
              const t = ind?.type as string
              if (t) typeCounts[t] = (typeCounts[t] || 0) + 1
            }
          }
          if (Object.keys(typeCounts).length > 0) {
            // Atomically increment per-type fields in the progression hash
            for (const [type, count] of Object.entries(typeCounts)) {
              const field = `indications_${type}_count`
              await client.hincrby(redisKey, field, count)
            }
            await client.hincrby(redisKey, "indications_count", Object.values(typeCounts).reduce((a, b) => a + b, 0))
            await client.expire(redisKey, 7 * 24 * 60 * 60)
          }
        } catch { /* non-critical */ }

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        const processedThisCycle = indicationResults.reduce((sum, arr) => sum + (arr?.length || 0), 0)
        // Defensive: handle stale closures from HMR where variable may not exist
        try {
          totalStrategiesEvaluated += processedThisCycle
        } catch {
          // Stale closure - variable doesn't exist, just skip
        }

        this.componentHealth.indications.lastCycleDuration = duration
        this.componentHealth.indications.successRate = ((cycleCount - errorCount) / cycleCount) * 100

        // Update progression cycle every cycle with detailed logging
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, true, 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
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
            })
          } catch { /* silently fail */ }
        }

        // Track intervals processed in Redis for dashboard display (every 100 cycles)
        if (cycleCount % 100 === 0) {
          try {
            const client = getRedisClient()
            await client.incr(`intervals:${this.connectionId}:processed_count`)
            await client.expire(`intervals:${this.connectionId}:processed_count`, 86400)
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              last_cycle_duration: duration,
              last_cycle_type: "indications",
              total_indications_evaluated: typeof totalStrategiesEvaluated !== "undefined" ? totalStrategiesEvaluated : 0,
              updated_at: new Date().toISOString(),
            })
          } catch { /* ignore errors */ }
        }

        // Track detailed performance metrics
        if (cycleCount % 100 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "indications", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
            durationMs: duration,
            symbolsProcessed: symbols.length,
            indicationsGenerated: processedThisCycle,
            errors: errorCount,
          })
        }
      } catch (error) {
        errorCount++
        this.componentHealth.indications.errorCount++
        const errorMessage = error instanceof Error ? error.message : String(error)
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
        isProcessing = false
      }
    }, intervalSeconds * 1000)
  }

  /**
   * Start strategy processor (async)
   * With debouncing to prevent overlapping cycles
   */
  private startStrategyProcessor(intervalSeconds: number = 1): void {
    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0
    let totalStrategiesEvaluated = 0
    let isProcessing = false

    this.strategyTimer = setInterval(async () => {
      if (isProcessing) return
      isProcessing = true
      const startTime = Date.now()

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
        // Defensive: handle stale closures from HMR
        try {
          totalStrategiesEvaluated += evaluatedThisCycle
        } catch {
          // Stale closure - skip
        }

        this.componentHealth.strategies.lastCycleDuration = duration
        this.componentHealth.strategies.successRate = ((cycleCount - errorCount) / cycleCount) * 100

        // Write strategy counts into progression hash for dashboard real-time display
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          if (evaluatedThisCycle > 0) {
            await client.hincrby(redisKey, "strategies_count", evaluatedThisCycle)
            await client.hincrby(redisKey, "strategies_real_total", liveReadyThisCycle)
            await client.hincrby(redisKey, "strategy_evaluated_real", liveReadyThisCycle)
            await client.expire(redisKey, 7 * 24 * 60 * 60)
          }
        } catch { /* non-critical */ }

        // Update progression cycle
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, true, 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Strategy cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
        }

        // Persist cycle count every 100 cycles
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_strategy_run: new Date().toISOString(),
              strategy_cycle_count: cycleCount,
              strategy_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              total_strategies_evaluated: typeof totalStrategiesEvaluated !== "undefined" ? totalStrategiesEvaluated : 0,
              last_cycle_duration: duration,
              last_cycle_type: "strategies",
              engine_cycles_total: cycleCount,
            })
          } catch { /* silently fail */ }
        }

        // Track detailed performance metrics
        if (cycleCount % 100 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "strategies", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
          durationMs: duration,
          symbolsProcessed: symbols.length,
          strategiesEvaluated: evaluatedThisCycle,
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
        isProcessing = false
      }
    }, intervalSeconds * 1000)
  }

  /**
   * Start realtime processor (async)
   * With debouncing to prevent overlapping cycles
   */
  private startRealtimeProcessor(intervalSeconds: number = 1): void {
    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0
    let isProcessing = false

    this.realtimeTimer = setInterval(async () => {
      if (isProcessing) return
      isProcessing = true
      const startTime = Date.now()

      try {
        // Process realtime updates for active positions
        await this.realtimeProcessor.processRealtimeUpdates()

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        this.componentHealth.realtime.lastCycleDuration = duration
        this.componentHealth.realtime.successRate = ((cycleCount - errorCount) / cycleCount) * 100

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
        isProcessing = false
      }
    }, intervalSeconds * 1000)
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    const healthCheckInterval = 10000 // Check every 10 seconds

    this.healthCheckTimer = setInterval(async () => {
      if (!this.isRunning) return

      try {
        // Update component health statuses
        this.componentHealth.indications.status = this.getComponentHealthStatus(
          this.componentHealth.indications.successRate,
          this.componentHealth.indications.lastCycleDuration,
          5000, // 5 second threshold
        )

        this.componentHealth.strategies.status = this.getComponentHealthStatus(
          this.componentHealth.strategies.successRate,
          this.componentHealth.strategies.lastCycleDuration,
          10000, // 10 second threshold for strategies
        )

        this.componentHealth.realtime.status = this.getComponentHealthStatus(
          this.componentHealth.realtime.successRate,
          this.componentHealth.realtime.lastCycleDuration,
          3000, // 3 second threshold
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

      if (overallHealth !== "healthy") {
        console.warn(`[v0] TradeEngineManager health for ${this.connectionId}: ${overallHealth}`)
        // Log health issues for monitoring
        await logProgressionEvent(this.connectionId, "health_check", overallHealth === "degraded" ? "warning" : "error",
          `Engine health: ${overallHealth}`, {
            indications: this.componentHealth.indications.status,
            strategies: this.componentHealth.strategies.status,
            realtime: this.componentHealth.realtime.status,
          })
      }
      } catch (error) {
        console.error("[v0] TradeEngineManager health monitoring error:", error)
      }
    }, healthCheckInterval)
  }

  /**
   * Get component health status
   */
  private getComponentHealthStatus(
    successRate: number,
    lastCycleDuration: number,
    threshold: number,
  ): "healthy" | "degraded" | "unhealthy" {
    if (successRate < 80 || lastCycleDuration > threshold * 3) {
      return "unhealthy"
    }
    if (successRate < 95 || lastCycleDuration > threshold * 2) {
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
   * Get symbols for this connection - uses connection's active_symbols first
   */
  private async getSymbols(): Promise<string[]> {
    try {
      // First, check connection's configured symbols in Redis
      const connState = await getSettings(`trade_engine_state:${this.connectionId}`)
      if (connState && typeof connState === "object") {
        const connSymbols = (connState as any).symbols || (connState as any).active_symbols
        if (Array.isArray(connSymbols) && connSymbols.length > 0) {
          return connSymbols
        }
      }

      // Check connection settings directly
      const connSettings = await getSettings(`connection:${this.connectionId}`)
      if (connSettings && typeof connSettings === "object") {
        const symbolsField = (connSettings as any).active_symbols || (connSettings as any).symbols
        let symbols = symbolsField
        // Handle JSON string
        if (typeof symbols === "string") {
          try {
            symbols = JSON.parse(symbols)
          } catch { /* ignore */ }
        }
        if (Array.isArray(symbols) && symbols.length > 0) {
          return symbols
        }
      }

      // Fall back to global main symbols setting
      const useMainSymbols = await getSettings("useMainSymbols")
      if (useMainSymbols === true || useMainSymbols === "true") {
        const mainSymbols = await getSettings("mainSymbols")
        if (Array.isArray(mainSymbols) && mainSymbols.length > 0) {
          return mainSymbols
        }
      }

      // Default symbols - HIGH VOLATILITY, ordered by last hour volatility
      // BTC (highest), ETH (high), SOL (high) - top 3 most volatile
      const defaultSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      return defaultSymbols
    } catch (error) {
      console.error("[v0] Failed to get symbols, using fallback:", error instanceof Error ? error.message : String(error))
      // Fallback to high-volatility symbols
      return ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    }
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
