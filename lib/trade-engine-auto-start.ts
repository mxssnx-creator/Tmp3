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
import { hasConnectionCredentials, isConnectionMainProcessing } from "./connection-state-utils"

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
 */
function startConnectionMonitoring(): void {
  if (autoStartTimer) {
    return
  }

  let lastEnabledCount = 0
  let lastEnabledSignature = ""
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

      // Filter for main-assigned + dashboard-enabled connections with valid API keys only.
      const enabledConnections = connections.filter((c) => {
        const isMainProcessing = isConnectionMainProcessing(c)
        const hasValidCredentials = hasConnectionCredentials(c, 20, false)
        return isMainProcessing && hasValidCredentials
      })

      const enabledSignature = enabledConnections
        .map((connection) => connection.id)
        .sort()
        .join(",")

      // If enabled connection set changed, log it (but don't auto-start)
      if (enabledSignature !== lastEnabledSignature) {
        console.log(`[v0] [Monitor] Enabled connections changed: ${lastEnabledCount} -> ${enabledConnections.length} (manual start required)`)
        lastEnabledCount = enabledConnections.length
        lastEnabledSignature = enabledSignature
      }

      // Load settings ONCE per interval, not per connection
      let settings = cachedSettings
      if (!settings || Date.now() - settingsCacheTime > SETTINGS_CACHE_TTL) {
        settings = await loadSettingsAsync()
        cachedSettings = settings
        settingsCacheTime = Date.now()
      }

      // Ensure coordinator engine map matches currently enabled+assigned connections.
      // This recovers from missed toggle events, service restarts, or stale state.
      try {
        const coordinator = getGlobalTradeEngineCoordinator()
        await coordinator.refreshEngines()
      } catch (syncError) {
        console.warn("[v0] [Monitor] Failed to refresh coordinator engines:", syncError)
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
