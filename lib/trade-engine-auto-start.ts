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
   * One-shot startup synchronization (no longer interval-driven).
   *
   * Per spec ("Disable intervaled connection reassignments. Do use only
   * on Startup."): we now run a SINGLE assignment pass on cold start
   * and do not poll for connection changes thereafter.
   *
   * After this initial sweep, engines are added or removed only by:
   *   1. The dashboard toggle (`/api/settings/connections/[id]/toggle-dashboard`)
   *      which directly calls `coordinator.toggleEngine()`.
   *   2. Explicit Start/Stop buttons in the global engine controls.
   *   3. The next cold-start of the serverless function (Vercel) — at
   *      which point this same one-shot sweep runs again.
   *
   * Why an interval was wrong here: in serverless / Vercel the
   * interval timers don't survive hibernation anyway, AND every wake
   * was creating unnecessary reassignment churn that the operator
   * didn't ask for. The cold-start one-shot is the natural fit:
   * Vercel serverless functions get a fresh init on every cold boot,
   * so engines self-recover without us polling.
   */
  function startConnectionMonitoring(): void {
    if (autoStartTimer) {
      return
    }

    // 2-second deferred startup sweep. The deferral lets ensureBaseConnections
    // finish its bootstrap write (`trade_engine:global.status = "running"`)
    // before we read the flag, which prevents the very first cold-boot from
    // bailing out with "Global engine not running".
    autoStartTimer = setTimeout(async () => {
      try {
        await initRedis()
        const monClient = getRedisClient()
        const monGlobalState = await monClient.hgetall("trade_engine:global")
        if (monGlobalState?.status !== "running") {
          console.log(
            "[v0] [AutoStart] One-shot sweep skipped: global engine not running. " +
            "Engines will be started by explicit user toggle.",
          )
          return
        }

        const connections = await getAllConnections()
        if (!Array.isArray(connections)) {
          console.warn("[v0] [AutoStart] Connections not array, skipping sweep")
          return
        }

        const connectionsThatShouldBeRunning = connections.filter((c) => {
          const isFullyEnabled = isConnectionMainProcessing(c)
          if (!isFullyEnabled) return false
          const hasAnyCredentials = hasConnectionCredentials(c, 5, true)
          const isPredefined = isTruthyFlag(c.is_predefined)
          const isTestnet = isTruthyFlag(c.is_testnet) || isTruthyFlag(c.demo_mode)
          return hasAnyCredentials || isPredefined || isTestnet
        })

        // Settings load is best-effort; engines that need it consult Redis
        // on each tick anyway, so a stale snapshot here is harmless.
        try { await loadSettingsAsync() } catch { /* non-critical */ }

        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)
          console.log(
            `[v0] [AutoStart] One-shot sweep complete: ${startedCount} engines started ` +
            `(${connectionsThatShouldBeRunning.length} connections eligible)`,
          )
        } catch (startError) {
          console.warn("[v0] [AutoStart] Failed to start missing engines:", startError)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Redis credentials")) {
          console.warn("[v0] [AutoStart] Redis not configured - skipping startup sweep")
        } else {
          console.warn(
            "[v0] [AutoStart] Error during startup sweep:",
            error instanceof Error ? error.message : String(error),
          )
        }
      } finally {
        // Drop the handle so a subsequent restart of monitoring (e.g.
        // operator-triggered) is allowed to re-arm. The one-shot has
        // fulfilled its purpose by now.
        autoStartTimer = null
      }
    }, 2000)

    autoStartTimer.unref?.()
  }

/**
 * Cancel the pending one-shot startup sweep.
 *
 * After the sweep fires (~2s after init) the timer self-clears and
 * this becomes a no-op. Useful only when the engine is being shut
 * down before the sweep had a chance to run.
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    // setTimeout handle works with both clearTimeout and clearInterval
    // in Node, but use clearTimeout for clarity now that this is a
    // one-shot (was setInterval pre-2026-05-03).
    clearTimeout(autoStartTimer)
    autoStartTimer = null
  }
}
