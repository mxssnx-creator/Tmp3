import { TradeEngineManager, type EngineConfig } from "./trade-engine/engine-manager"
import { getSettings, setSettings } from "./redis-db"

// Re-export TradeEngine class and config from subdirectory for convenient imports
export { TradeEngine, type TradeEngineConfig, TRADE_SERVICE_NAME } from "./trade-engine/trade-engine"
export { TradeEngineManager, type EngineConfig } from "./trade-engine/engine-manager"

export interface EngineStatus {
  status: "idle" | "running" | "stopped" | "paused" | "error"
  startedAt?: Date
  stoppedAt?: Date
  errorMessage?: string
}

export interface ConnectionStatus {
  connectionId: string
  status: "active" | "inactive" | "error"
  lastActivity?: Date
  errorCount: number
}

export interface HealthStatus {
  overall: "healthy" | "degraded" | "unhealthy"
  components: Record<string, ComponentHealth>
  lastCheck: Date
}

export interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
}

/**
 * GlobalTradeEngineCoordinator
 *
 * Manages TradeEngineManagers for all connections system-wide.
 * Acts as the central coordinator for trade processing across multiple exchanges.
 */
export class GlobalTradeEngineCoordinator {
  private engineManagers: Map<string, TradeEngineManager> = new Map()
  private startingEngines = new Set<string>()  // PHASE 1 FIX: Startup lock to prevent duplicate starts
  private stoppingEngines = new Set<string>()  // PHASE 2 FIX: Stop lock to prevent race conditions
  private isGloballyRunning = false
  private isPaused = false
  private healthCheckTimer?: NodeJS.Timeout
  private coordinationMetricsTimer?: NodeJS.Timeout
  private coordinationMetrics: {
    totalSymbolsProcessed: number
    totalCycles: number
    avgCycleDuration: number
    lastMetricsUpdate: Date
  } = {
    totalSymbolsProcessed: 0,
    totalCycles: 0,
    avgCycleDuration: 0,
    lastMetricsUpdate: new Date(),
  }

  constructor() {
    console.log("[v0] GlobalTradeEngineCoordinator initialized with advanced coordination")
  }

  /**
   * Initialize engine for a specific connection
   */
  async initializeEngine(connectionId: string, config: EngineConfig): Promise<TradeEngineManager> {
    console.log(`[v0] Initializing TradeEngine for connection: ${connectionId}`)

    // Check if engine already exists
    if (this.engineManagers.has(connectionId)) {
      console.log(`[v0] Engine already exists for connection: ${connectionId}`)
      return this.engineManagers.get(connectionId)!
    }

    // Create new engine manager
    const manager = new TradeEngineManager(config)
    this.engineManagers.set(connectionId, manager)

    // Initialize database state
    try {
      await this.ensureEngineState(connectionId)
    } catch (error) {
      console.error(`[v0] Failed to initialize engine state for ${connectionId}:`, error)
    }

    console.log(`[v0] TradeEngine initialized for connection: ${connectionId}`)
    return manager
  }

  /**
   * Start engine for a specific connection
   * PHASE 1 FIX: Added startup lock to prevent duplicate engines
   */
  async startEngine(connectionId: string, config: EngineConfig): Promise<void> {
    // Step 1: Check if already starting
    if (this.startingEngines.has(connectionId)) {
      console.log(`[v0] [STARTUP LOCK] Engine already starting for ${connectionId}, skipping duplicate start request`)
      return
    }

    // Step 2: Check if already running (check in-memory manager first, then Redis hint)
    try {
      const { getSettings } = await import("@/lib/redis-db")
      const runningFlag = await getSettings(`engine_is_running:${connectionId}`)
      const manager = this.engineManagers.get(connectionId)
      const managerRunning = !!manager?.isEngineRunning

      if (runningFlag === "true" || runningFlag === true || runningFlag === "1") {
        if (managerRunning) {
          console.log(`[v0] [STARTUP LOCK] Engine already running for ${connectionId}, skipping...`)
          return
        }
        // Redis flag can become stale across crashes/restarts; clear stale state and continue startup.
        console.warn(`[v0] [STARTUP LOCK] Stale running flag detected for ${connectionId}; continuing with startup`)
      }
    } catch (e) {
      console.log(`[v0] [STARTUP LOCK] Could not check running status: ${e}`)
    }

    // Step 3: Add to lock set
    this.startingEngines.add(connectionId)
    console.log(`[v0] [STARTUP LOCK] Added ${connectionId} to startup lock`)

    try {
      // Step 4: Initialize engine if needed
      let manager = this.engineManagers.get(connectionId)
      if (!manager) {
        console.log(`[v0] Starting TradeEngine for connection: ${connectionId}`)
        manager = await this.initializeEngine(connectionId, config)
      } else {
        console.log(`[v0] [STARTUP LOCK] Reusing existing engine manager for: ${connectionId}`)
      }

      // Step 5: Start the engine
      await manager.start(config)
      console.log(`[v0] [STARTUP LOCK] TradeEngine successfully started for connection: ${connectionId}`)
    } finally {
      // Step 6: Remove from lock set (always, even on error)
      this.startingEngines.delete(connectionId)
      console.log(`[v0] [STARTUP LOCK] Removed ${connectionId} from startup lock`)
    }
  }

  /**
   * Stop engine for a specific connection
   * PHASE 2 FIX: Added stop lock to prevent concurrent stop requests and race conditions
   */
  async stopEngine(connectionId: string): Promise<void> {
    // Step 1: Check if already stopping
    if (this.stoppingEngines.has(connectionId)) {
      console.log(`[v0] [STOP LOCK] Engine already stopping for ${connectionId}, skipping duplicate stop request`)
      return
    }

    // Step 2: Add to stop lock set
    this.stoppingEngines.add(connectionId)
    console.log(`[v0] [STOP LOCK] Added ${connectionId} to stop lock`)

    try {
      console.log(`[v0] Stopping TradeEngine for connection: ${connectionId}`)

      const manager = this.engineManagers.get(connectionId)

      if (!manager) {
        console.log(`[v0] No engine found for connection: ${connectionId}`)
        return
      }

      await manager.stop()
      this.engineManagers.delete(connectionId)

      console.log(`[v0] ✓ TradeEngine stopped for connection: ${connectionId}`)
    } finally {
      // Step 3: Remove from stop lock set (always, even on error)
      this.stoppingEngines.delete(connectionId)
      console.log(`[v0] [STOP LOCK] Removed ${connectionId} from stop lock`)
    }
  }

  /**
   * Toggle engine state with proper synchronization
   * PHASE 2 FIX: Ensures safe enable/disable by waiting for any ongoing state changes
   */
  async toggleEngine(connectionId: string, enabled: boolean, config?: EngineConfig): Promise<void> {
    // Wait for any ongoing state changes to complete
    const maxWaits = 100 // 5 seconds max
    let waits = 0
    while (
      (this.startingEngines.has(connectionId) || this.stoppingEngines.has(connectionId)) &&
      waits < maxWaits
    ) {
      await new Promise((r) => setTimeout(r, 50))
      waits++
    }

    if (waits >= maxWaits) {
      console.warn(
        `[v0] [TOGGLE] Timeout waiting for engine state change for ${connectionId}, proceeding anyway`
      )
    }

    if (enabled) {
      if (config) {
        await this.startEngine(connectionId, config)
      } else {
        console.warn(`[v0] [TOGGLE] Cannot start engine ${connectionId} - missing config`)
      }
    } else {
      await this.stopEngine(connectionId)
    }
  }

  /**
   * Check if engine is currently running
   */
  isEngineRunning(connectionId: string): boolean {
    const manager = this.engineManagers.get(connectionId)
    return manager ? manager.isEngineRunning : false
  }

  /**
   * Start all engines for enabled connections (modern Redis-based)
   */
  async startAll(): Promise<void> {
    try {
      console.log("[v0] [Coordinator] Starting global trade engine...")
      
      // Import Redis functions
      const { initRedis, getAssignedAndEnabledConnections, getAllConnections } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")
      
      // Initialize Redis and get connections
      await initRedis()
      const allConnections = await getAllConnections()
      
      // NOTE: Removed auto-enable logic
      // Connections must be explicitly:
      // 1. Created in base connections
      // 2. Assigned to main connections via add-to-active flow
      // 3. Enabled via dashboard toggle
      // This ensures user control over which connections are processed
      
      // Get assigned + enabled connections (user must explicitly assign to main)
      const connections = await getAssignedAndEnabledConnections()
      
      console.log(`[v0] [Coordinator] Connection audit: total=${allConnections.length}, inserted+enabled=${connections.length}`)
      
      // Show which connections would be processed
      if (connections.length > 0) {
        connections.slice(0, 5).forEach((c: any) => {
          console.log(`  - ${c.name || c.id}: exchange=${c.exchange}, inserted=${c.is_inserted}, dashboard_enabled=${c.is_enabled_dashboard}`)
        })
      }
      
      if (!Array.isArray(connections)) {
        console.error("[v0] [Coordinator] ERROR: connections is not an array")
        return
      }
      
      // Only process connections that have credentials
      const validConnections = connections.filter((c) => {
        const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
        const hasValidCredentials = hasCredentials && 
          (c.api_key || c.apiKey || "").length > 5 && 
          (c.api_secret || c.apiSecret || "").length > 5
        return hasValidCredentials
      })
      
      console.log(`[v0] [Coordinator] Filtered to ${validConnections.length} connections with valid credentials`)
      
      if (validConnections.length === 0) {
        console.log("[v0] [Coordinator] ⚠ No eligible connections to process. No connections with valid credentials found.")
        console.log(`[v0] [Coordinator] Help: Add connections via Settings > Active with valid API credentials`)
        this.isGloballyRunning = true // Mark as running, ready for connections
        return
      }
      
      const settings = await loadSettingsAsync()
      let successCount = 0
      
      for (const connection of validConnections) {
        try {
          const config: EngineConfig = {
            connectionId: connection.id,
            indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 3,
          }
          
          await this.startEngine(connection.id, config)
          successCount++
          console.log(`[v0] [Coordinator] ✓ Started: ${connection.name}`)
        } catch (error) {
          console.error(`[v0] [Coordinator] ✗ Failed to start ${connection.name}:`, error)
        }
      }
      
      this.isGloballyRunning = true
      console.log(`[v0] [Coordinator] ✓ Global engine started: ${successCount}/${validConnections.length} connections active`)
    } catch (error) {
      console.error("[v0] [Coordinator] Failed to start global engine:", error)
    }
  }

  /**
   * Refresh engines - detect and start/stop engines based on current enabled connections
   * Called periodically or when connections toggle
   */
  async refreshEngines(): Promise<void> {
    try {
      console.log("[v0] [Coordinator] === REFRESH ENGINES START ===")
      
      const { initRedis, getAssignedAndEnabledConnections, getAllConnections } = await import("@/lib/redis-db")
      const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
      
      await initRedis()
      const enabledConnections = await getAssignedAndEnabledConnections()
      const allConnections = await getAllConnections()
      
      const enabledIds = new Set(enabledConnections.map(c => c.id))
      const runningIds = new Set(this.engineManagers.keys())
      
      console.log(`[v0] [Coordinator] State: enabled=${enabledConnections.length}, running=${runningIds.size}`)
      
      // Start engines for newly enabled connections
      let started = 0
      let skipped = 0
      for (const connection of enabledConnections) {
        if (!runningIds.has(connection.id)) {
          try {
            const hasCredentials = (connection.api_key || connection.apiKey) && (connection.api_secret || connection.apiSecret)
            if (!hasCredentials) {
              console.log(`[v0] [Coordinator] SKIP: ${connection.name} - no credentials`)
              await logProgressionEvent(connection.id, "engine_skip", "warning", "Engine start skipped - missing credentials", {
                connectionId: connection.id,
                connectionName: connection.name,
              })
              skipped++
              continue
            }
            
            console.log(`[v0] [Coordinator] START: ${connection.name} (${connection.exchange})`)
            await logProgressionEvent(connection.id, "engine_starting", "info", "Coordinator starting engine", {
              connectionId: connection.id,
              connectionName: connection.name,
              exchange: connection.exchange,
            })
            
            const { loadSettingsAsync } = await import("@/lib/settings-storage")
            const settings = await loadSettingsAsync()
            
            const config: EngineConfig = {
              connectionId: connection.id,
              engine_type: "main", // Main Trade Engine for indications, strategies, pseudo positions
              indicationInterval: settings.mainEngineIntervalMs ? Math.max(1, settings.mainEngineIntervalMs / 1000) : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? Math.max(1, settings.strategyUpdateIntervalMs / 1000) : 10,
              realtimeInterval: settings.realtimeIntervalMs ? Math.max(1, settings.realtimeIntervalMs / 1000) : 3,
            }
            
            await this.startEngine(connection.id, config)
            started++
            
            await logProgressionEvent(connection.id, "engine_started", "info", "Main Trade Engine started for progression", {
              connectionId: connection.id,
              engineType: "main",
              config,
            })
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            console.error(`[v0] [Coordinator] ERROR starting ${connection.name}:`, errorMsg)
            await logProgressionEvent(connection.id, "engine_start_error", "error", "Coordinator failed to start engine", {
              error: errorMsg,
            })
          }
        }
      }
      
      // Stop engines for disabled connections
      let stopped = 0
      for (const connectionId of runningIds) {
        if (!enabledIds.has(connectionId)) {
          try {
            const conn = allConnections.find(c => c.id === connectionId)
            console.log(`[v0] [Coordinator] STOP: ${conn?.name || connectionId}`)
            
            await logProgressionEvent(connectionId, "engine_stopping", "info", "Coordinator stopping engine", {
              connectionId,
              connectionName: conn?.name,
            })
            
            await this.stopEngine(connectionId)
            stopped++
            
            await logProgressionEvent(connectionId, "engine_stopped", "info", "Engine stopped by coordinator", {
              connectionId,
            })
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            console.error(`[v0] [Coordinator] ERROR stopping ${connectionId}:`, errorMsg)
          }
        }
      }
      
      console.log(`[v0] [Coordinator] === REFRESH COMPLETE: started=${started}, stopped=${stopped}, skipped=${skipped} ===`)
    } catch (error) {
      console.error("[v0] [Coordinator] Error refreshing engines:", error)
    }
  }

  /**
   * Start all engines - alias for startAll()
   */
  async startAllEngines(): Promise<void> {
    return this.startAll()
  }

  /**
   * Stop all engines
   */
  async stopAll(): Promise<void> {
    console.log("[v0] Stopping all TradeEngines...")

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
    if (this.coordinationMetricsTimer) {
      clearInterval(this.coordinationMetricsTimer)
      this.coordinationMetricsTimer = undefined
    }

    for (const [connectionId, manager] of this.engineManagers.entries()) {
      try {
        await manager.stop()
        console.log(`[v0] Stopped engine: ${connectionId}`)
      } catch (error) {
        console.error(`[v0] Failed to stop engine for connection ${connectionId}:`, error)
      }
    }

    this.engineManagers.clear()
    this.isGloballyRunning = false
    this.isPaused = false

    console.log("[v0] All TradeEngines stopped")
  }

  // Alias for backward compat
  async stopAllEngines(): Promise<void> {
    return this.stopAll()
  }

  /**
   * Pause all engines
   */
  async pause(): Promise<void> {
    console.log("[v0] [Coordinator] PAUSING global trade engine - stopping ALL engines...")

    this.isPaused = true
    this.isGloballyRunning = false

    // Stop ALL engine managers immediately
    const allConnectionIds = Array.from(this.engineManagers.keys())
    console.log(`[v0] [Coordinator] Stopping ${allConnectionIds.length} trade engine(s)...`)

    for (const connectionId of allConnectionIds) {
      try {
        const manager = this.engineManagers.get(connectionId)
        if (manager) {
          await manager.stop()
          console.log(`[v0] [Coordinator] ✓ Stopped engine for connection: ${connectionId}`)
        }
      } catch (error) {
        console.error(`[v0] [Coordinator] Failed to stop engine for connection ${connectionId}:`, error)
      }
    }

    console.log("[v0] [Coordinator] ✓ Global trade engine PAUSED - all engines stopped")
  }

  /**
   * Resume all engines
   */
  async resume(): Promise<void> {
    console.log("[v0] [Coordinator] RESUMING global trade engine - restarting all engines...")

    if (!this.isPaused) {
      console.log("[v0] [Coordinator] TradeEngines are not paused, nothing to resume")
      return
    }

    this.isPaused = false
    this.isGloballyRunning = true

    try {
      const { initRedis, getAllConnections } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")

      await initRedis()
      const connections = await getAllConnections()
      
      if (!Array.isArray(connections)) {
        console.error("[v0] [Coordinator] ERROR: connections is not an array during resume")
        return
      }

      // Get all connections with valid credentials
      const validConnections = connections.filter((c) => {
        const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
        return hasCredentials
      })

      console.log(`[v0] [Coordinator] Found ${validConnections.length} connections to resume`)

      const settings = await loadSettingsAsync()
      let resumedCount = 0

      // Restart engine for each connection
      for (const connection of validConnections) {
        try {
          const config: EngineConfig = {
            connectionId: connection.id,
            indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 3,
          }

          await this.startEngine(connection.id, config)
          resumedCount++
          console.log(`[v0] [Coordinator] ✓ Resumed: ${connection.name}`)
        } catch (error) {
          console.error(`[v0] [Coordinator] Failed to resume engine for connection ${connection.id}:`, error)
        }
      }

      console.log(`[v0] [Coordinator] ✓ Global trade engine RESUMED: ${resumedCount} engines restarted`)
    } catch (error) {
      console.error("[v0] [Coordinator] Failed to resume engines:", error)
      throw error
    }
  }

  /**
   * Get engine manager for a specific connection
   */
  getEngineManager(connectionId: string): TradeEngineManager | null {
    return this.engineManagers.get(connectionId) || null
  }

  /**
   * Get status of all engines
   */
  async getAllEnginesStatus(): Promise<Record<string, any>> {
    const status: Record<string, any> = {}

    for (const [connectionId, manager] of this.engineManagers.entries()) {
      try {
        status[connectionId] = await manager.getStatus()
      } catch (error) {
        status[connectionId] = { error: error instanceof Error ? error.message : "Unknown error" }
      }
    }

    return status
  }

  /**
   * Get status of a specific engine
   */
  async getEngineStatus(connectionId: string): Promise<any | null> {
    const manager = this.engineManagers.get(connectionId)
    if (!manager) return null

    return manager.getStatus()
  }

  /**
   * Get global system health
   */
  async getGlobalHealth(): Promise<HealthStatus> {
    const allStatus = await this.getAllEnginesStatus()
    const components: Record<string, ComponentHealth> = {}

    let healthyCount = 0
    let degradedCount = 0
    let unhealthyCount = 0

    for (const [connectionId, status] of Object.entries(allStatus)) {
      if (status.health) {
        components[connectionId] = {
          status: status.health.overall,
          lastCycleDuration: 0,
          errorCount: 0,
          successRate: 100,
        }

        if (status.health.overall === "healthy") healthyCount++
        else if (status.health.overall === "degraded") degradedCount++
        else unhealthyCount++
      }
    }

    let overall: "healthy" | "degraded" | "unhealthy" = "healthy"
    if (unhealthyCount > 0) overall = "unhealthy"
    else if (degradedCount > 0) overall = "degraded"

    return {
      overall,
      components,
      lastCheck: new Date(),
    }
  }

  /**
   * Ensure engine state exists in Redis
   */
  private async ensureEngineState(connectionId: string): Promise<void> {
    try {
      // Check if state exists in Redis (consistent with engine-manager's updateEngineState)
      const stateKey = `trade_engine_state:${connectionId}`
      const existing = await getSettings(stateKey)

      if (!existing) {
        // Create initial state in Redis
        const initialState = {
          connection_id: connectionId,
          status: "idle",
          prehistoric_data_loaded: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        await setSettings(stateKey, initialState)
        console.log(`[v0] Created engine state for connection: ${connectionId}`)
      }
    } catch (error) {
      console.error(`[v0] Failed to ensure engine state for ${connectionId}:`, error)
    }
  }

  /**
   * Start global health monitoring with connection refresh detection
   */
  private startGlobalHealthMonitoring(): void {
    const healthCheckInterval = 10000 // Check every 10 seconds for faster response

    console.log("[v0] Starting global trade engine health monitoring with refresh detection")

    this.healthCheckTimer = setInterval(async () => {
      try {
        // Check for refresh requests from toggle-dashboard
        const refreshRequest = await getSettings("engine_coordinator:refresh_requested")
        
        if (refreshRequest && refreshRequest.timestamp) {
          const requestTime = new Date(refreshRequest.timestamp).getTime()
          const now = Date.now()
          
          // Process refresh requests within the last 30 seconds
          if (now - requestTime < 30000) {
            console.log(`[v0] [Coordinator] Refresh requested for ${refreshRequest.connectionId}: ${refreshRequest.action}`)
            
            // Clear the request to prevent duplicate processing
            await setSettings("engine_coordinator:refresh_requested", {
              timestamp: null,
              connectionId: null,
              action: null,
              processed_at: new Date().toISOString(),
            })
            
            // Trigger engine refresh
            await this.refreshEngines()
          }
        }
        
        if (!this.isGloballyRunning) return

        const health = await this.getGlobalHealth()

        if (health.overall !== "healthy") {
          console.warn(`[v0] Global trade engine health: ${health.overall}`)
        }

        // Log unhealthy connections
        for (const [connectionId, component] of Object.entries(health.components)) {
          if (component.status !== "healthy") {
            console.warn(`[v0] Connection ${connectionId} is ${component.status}`)
          }
        }
      } catch (error) {
        console.error("[v0] Global health monitoring error:", error)
      }
    }, healthCheckInterval)
  }

  /**
   * Check if coordinator is running
   */
  isRunning(): boolean {
    return this.isGloballyRunning
  }

  /**
   * Check if coordinator is paused
   */
  isPausedState(): boolean {
    return this.isPaused
  }

  /**
   * Get count of active engines
   */
  getActiveEngineCount(): number {
    return this.engineManagers.size
  }

  private startCoordinationMetricsTracking(): void {
    if (this.coordinationMetricsTimer) {
      clearInterval(this.coordinationMetricsTimer)
    }
    const metricsInterval = 60000 // Update every 60 seconds

    this.coordinationMetricsTimer = setInterval(async () => {
      try {
        const allStatus = await this.getAllEnginesStatus()

        let totalSymbols = 0
        let totalCycles = 0
        let totalDuration = 0
        let engineCount = 0

        for (const status of Object.values(allStatus)) {
          if (status.preset_symbols_processed) {
            totalSymbols += status.preset_symbols_processed
            totalCycles += status.preset_cycle_count || 0
            totalDuration += status.preset_avg_duration_ms || 0
            engineCount++
          }
        }

        this.coordinationMetrics = {
          totalSymbolsProcessed: totalSymbols,
          totalCycles: totalCycles,
          avgCycleDuration: engineCount > 0 ? totalDuration / engineCount : 0,
          lastMetricsUpdate: new Date(),
        }

        console.log(
          `[v0] Coordination Metrics: ${totalSymbols} symbols, ${totalCycles} cycles, ${Math.round(this.coordinationMetrics.avgCycleDuration)}ms avg`,
        )
      } catch (error) {
        console.error("[v0] Coordination metrics tracking error:", error)
      }
    }, metricsInterval)
  }

  /**
   * Get coordination metrics
   */
  getCoordinationMetrics() {
    return { ...this.coordinationMetrics }
  }
}

/**
 * The global trade engine coordinator singleton instance
 */
let globalCoordinator: GlobalTradeEngineCoordinator | null = null

/**
 * Get the global trade engine coordinator singleton instance
 * @returns The GlobalTradeEngineCoordinator instance or null if not initialized
 */
export function getTradeEngine(): GlobalTradeEngineCoordinator | null {
  return globalCoordinator
}

/**
 * Initialize the global trade engine coordinator
 * This should be called once during application startup
 */
export function initializeGlobalCoordinator(): GlobalTradeEngineCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new GlobalTradeEngineCoordinator()
    console.log("[v0] Global trade engine coordinator initialized")
  }
  return globalCoordinator
}

export function getGlobalCoordinator(): GlobalTradeEngineCoordinator | null {
  return globalCoordinator
}

export function getGlobalTradeEngineCoordinator(): GlobalTradeEngineCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new GlobalTradeEngineCoordinator()
    console.log("[v0] Global trade engine coordinator auto-initialized")
  }
  return globalCoordinator
}

export async function getTradeEngineStatus(connectionId: string): Promise<any | null> {
  if (!globalCoordinator) {
    console.log("[v0] No global coordinator initialized yet")
    return null
  }

  return globalCoordinator.getEngineStatus(connectionId)
}

export function initializeTradeEngine(): GlobalTradeEngineCoordinator {
  return initializeGlobalCoordinator()
}

export type TradeEngineInterface = GlobalTradeEngineCoordinator
