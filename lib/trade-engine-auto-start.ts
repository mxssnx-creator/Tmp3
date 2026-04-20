/**
 * Trade Engine Auto-Start Service
 * Automatically starts trade engines for enabled connections via their toggles
 * 
 * Keeps engine lifecycle synchronized with current main-enabled connections.
 * Engines are still user-controlled via dashboard toggles; monitor only ensures
 * enabled connections are actually running when global coordinator is running.
 */

import { getGlobalTradeEngineCoordinator } from "./trade-engine"
import { getAllConnections, getRedisClient, initRedis } from "./redis-db"
import { loadSettingsAsync } from "./settings-storage"
import { hasConnectionCredentials, isConnectionMainProcessing, isTruthyFlag } from "./connection-state-utils"

let autoStartInitialized = false
let autoStartTimer: NodeJS.Timeout | null = null

export function isAutoStartInitialized(): boolean {
  return autoStartInitialized
}

/**
 * Initialize trade engine monitor for auto-recovery/synchronization.
 */
export async function initializeTradeEngineAutoStart(): Promise<void> {
  if (autoStartInitialized) {
    console.log("[v0] [Auto-Start] Already initialized, skipping")
    if (!autoStartTimer) {
      console.log("[v0] [Auto-Start] Monitor missing after init; restarting monitor")
      startConnectionMonitoring()
    }
    return
  }

  try {
    console.log("[v0] [Auto-Start] Starting trade engine auto-initialization (sync mode)...")
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Check if Global Trade Engine Coordinator is running
    await initRedis()
    const client = getRedisClient()
    const globalState = await client.hgetall("trade_engine:global")
    const globalRunning = globalState?.status === "running"
    
    if (!globalRunning) {
      console.log("[v0] [Auto-Start] Global Trade Engine is not running - monitor initialized, waiting for global start.")
      autoStartInitialized = true
      startConnectionMonitoring()
      return
    }
    
    console.log("[v0] [Auto-Start] Monitoring initialized - enabled connections will be synchronized")
    autoStartInitialized = true
    startConnectionMonitoring()
  } catch (error) {
    console.error("[v0] [Auto-Start] Initialization failed:", error)
    autoStartInitialized = true
    startConnectionMonitoring()
  }
}

  /**
   * Monitor for connection changes and synchronize coordinator engine state.
   * Only starts missing engines - does not stop engines to avoid interfering with explicit user actions.
   */
  function startConnectionMonitoring(): void {
    if (autoStartTimer) {
      return
    }

    let lastStartAttemptCount = 0
    let cachedSettings: any = null
    let settingsCacheTime = 0
    let monitorCycleInFlight = false
    const SETTINGS_CACHE_TTL = 60000 // 60 seconds

    autoStartTimer = setInterval(async () => {
      if (monitorCycleInFlight) {
        return
      }

      monitorCycleInFlight = true
      try {
        // Always check global engine status first
        await initRedis()
        const monClient = getRedisClient()
        const monGlobalState = await monClient.hgetall("trade_engine:global")
        if (monGlobalState?.status !== "running") {
          // Global engine not running - don't auto-start any connections
          return
        }

        const connections = await getAllConnections()

        // Ensure connections is an array before filtering
        if (!Array.isArray(connections)) {
          console.warn("[v0] [Monitor] Connections not array")
          return
        }

        // STABILITY RULE: the "Enable" slider on the connection card is the
        // authoritative gate for whether a connection's engine should be
        // running. This monitor must ONLY start engines for connections where
        // the user has explicitly enabled them (is_enabled_dashboard=1) AND
        // the connection is assigned to the main panel. Previously the filter
        // also accepted is_active_inserted alone, which caused engines to be
        // re-started for connections the user had just toggled off — making
        // the Enable slider feel non-functional and creating drift between
        // the UI and the actual engine state.
        const connectionsThatShouldBeRunning = connections.filter((c) => {
          const isFullyEnabled = isConnectionMainProcessing(c)
          if (!isFullyEnabled) return false
          // Allow placeholder/predefined credentials — engine handles auth failures gracefully
          const hasAnyCredentials = hasConnectionCredentials(c, 5, true)
          const isPredefined = isTruthyFlag(c.is_predefined)
          const isTestnet = isTruthyFlag(c.is_testnet) || isTruthyFlag(c.demo_mode)
          return hasAnyCredentials || isPredefined || isTestnet
        })

        // Load settings ONCE per interval, not per connection
        let settings = cachedSettings
        if (!settings || Date.now() - settingsCacheTime > SETTINGS_CACHE_TTL) {
          settings = await loadSettingsAsync()
          cachedSettings = settings
          settingsCacheTime = Date.now()
        }

        // Start engines for connections that should be running but don't have engines
        // Do NOT stop engines - leave that to explicit user actions via dashboard toggles
        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)
          if (startedCount > 0) {
            console.log(`[v0] [Monitor] Started ${startedCount} missing engines`)
          }
        } catch (startError) {
          console.warn("[v0] [Monitor] Failed to start missing engines:", startError)
        }
        
      } catch (error) {
        // Log but don't crash - gracefully handle Redis errors
        if (error instanceof Error && error.message.includes("Redis credentials")) {
          // Only log once per interval to avoid spam
          if (Math.random() < 0.1) {
            console.warn("[v0] [Monitor] Redis not configured - skipping auto-start check")
          }
        } else {
          console.warn("[v0] [Monitor] Error during connection monitoring:", error instanceof Error ? error.message : String(error))
        }
      } finally {
        monitorCycleInFlight = false
      }
    }, 10000) // Check every 10 seconds for new enabled connections

    autoStartTimer.unref?.()
  }

/**
 * Stop the connection monitoring timer
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    clearInterval(autoStartTimer)
    autoStartTimer = null
  }
}
