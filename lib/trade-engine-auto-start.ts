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
   * Persistent self-healing monitor.
   *
   * Replaces the former one-shot `setTimeout`. Runs an initial sweep
   * 2 seconds after init (to let migrations settle) then repeats every
   * 30 seconds. On each tick it:
   *   1. Checks that the global engine is running.
   *   2. Re-applies `is_enabled_dashboard="1"` for base connections that
   *      were accidentally zeroed out (migration race, clear-progressions
   *      partial run, accidental toggle, etc.).
   *   3. Calls `coordinator.startMissingEngines()` to restart any enabled
   *      connection whose engine is not currently running.
   *
   * This makes the system self-healing: any accidental disable is
   * corrected within 30 seconds without a full cold-boot. The interval
   * does NOT reassign connections the operator deliberately stopped via
   * the dashboard — `isConnectionMainProcessing()` still gates that.
   */
  function startConnectionMonitoring(): void {
    if (autoStartTimer) {
      return
    }

    const BASE_CONNECTION_IDS = ["bingx-x01"]

    async function runHealingSweep(isStartup: boolean): Promise<void> {
      try {
        await initRedis()
        const monClient = getRedisClient()
        const monGlobalState = (await monClient.hgetall("trade_engine:global")) as Record<
          string,
          string
        > | null

        // CRITICAL FIX: re-assert "running" status when:
        //   - a base connection is configured AND eligible (autoActive), AND
        //   - the operator did NOT explicitly stop the engine
        //     (operator_stopped="1" is the sticky veto flag).
        //
        // Without this self-heal the engine stays "stopped" after a redeploy
        // / snapshot restore — even though no operator ever clicked Stop —
        // matching the reported "low counts, no progressions" symptom.
        const operatorStopped =
          monGlobalState?.operator_stopped === "1" || monGlobalState?.operator_stopped === "true"
        const currentStatus = monGlobalState?.status || ""

        if (currentStatus !== "running") {
          if (operatorStopped) {
            if (isStartup) {
              console.log(
                "[v0] [AutoStart] Startup sweep skipped: operator-stopped state detected. " +
                  "Engines remain stopped until operator clicks Start.",
              )
            }
            return
          }
          // Auto-resurrect: write status=running and continue the sweep so
          // the connection monitor can re-arm engines for autoActive base
          // connections. This matches the bootstrap path in
          // `redis-migrations.ts → ensureBaseConnections`.
          for (const connId of BASE_CONNECTION_IDS) {
            const exists = await monClient.hgetall(`connection:${connId}`).catch(() => null)
            if (exists && Object.keys(exists).length > 0) {
              const nowIso = new Date().toISOString()
              await monClient.hset("trade_engine:global", {
                status: "running",
                started_at: nowIso,
                bootstrapped_at: nowIso,
                bootstrapped_by: "auto-start-monitor",
              })
              console.log(
                `[v0] [AutoStart] Self-heal: resurrected trade_engine:global=running ` +
                  `(was "${currentStatus || "empty"}"; base connection ${connId} present)`,
              )
              break
            }
          }
          // Re-read after the potential write — if the bootstrap wasn't
          // applicable (no base connections), bail out cleanly.
          const reReadState = (await monClient.hgetall("trade_engine:global").catch(() => null)) as
            | Record<string, string>
            | null
          if (reReadState?.status !== "running") {
            if (isStartup) {
              console.log(
                "[v0] [AutoStart] Startup sweep skipped: global engine not running and no base connection to bootstrap.",
              )
            }
            return
          }
        }

        // ── Idempotent base-connection activation ───────────────────
        // Migrations 015–017 unconditionally reset is_enabled_dashboard to
        // "0" on every boot. Re-apply the correct value before the engine
        // sweep so the coordinator always sees the right flag.
        try {
          const activationClient = getRedisClient()
          for (const connId of BASE_CONNECTION_IDS) {
            const connData = await activationClient.hgetall(`connection:${connId}`)
            if (!connData) continue
            if (connData.is_enabled_dashboard === "1") continue // already correct
            await activationClient.hset(`connection:${connId}`, {
              is_enabled_dashboard: "1",
              is_active_inserted: "1",
              is_assigned: "1",
              is_enabled: "1",
              is_inserted: "1",
              is_active: "1",
            })
            await activationClient.sadd("connections:main:enabled", connId)
            console.log(`[v0] [AutoStart] Self-heal: restored dashboard_enabled=1 for ${connId}`)
          }
        } catch (activErr) {
          console.warn("[v0] [AutoStart] Failed to restore dashboard_enabled:", activErr)
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

        // Settings load is best-effort; engines consult Redis on each tick.
        try { await loadSettingsAsync() } catch { /* non-critical */ }

        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)
          if (startedCount > 0 || isStartup) {
            console.log(
              `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
              `(${connectionsThatShouldBeRunning.length} connections eligible)`,
            )
          }
        } catch (startError) {
          console.warn("[v0] [AutoStart] Failed to start missing engines:", startError)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Redis credentials")) {
          console.warn("[v0] [AutoStart] Redis not configured - skipping healing sweep")
        } else {
          console.warn(
            "[v0] [AutoStart] Error during healing sweep:",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }

    // 2-second deferred initial sweep lets ensureBaseConnections finish
    // its bootstrap write before we read the flag.
    const startupDelay = setTimeout(async () => {
      await runHealingSweep(true)

      // After startup sweep, arm the persistent interval.
      const intervalHandle = setInterval(async () => {
        await runHealingSweep(false)
      }, 30_000) // 30 seconds

      intervalHandle.unref?.()
      // Overwrite the module-level timer ref with the interval handle so
      // stopConnectionMonitoring() correctly cancels it.
      autoStartTimer = intervalHandle
    }, 2000)

    startupDelay.unref?.()
    // Point the module-level ref at the startup delay initially.
    autoStartTimer = startupDelay
  }

/**
 * Cancel the self-healing monitor.
 *
 * Clears both the startup delay (if still pending) and the repeating
 * interval (if already armed). Safe to call multiple times.
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    clearTimeout(autoStartTimer)   // works for both setTimeout and setInterval
    clearInterval(autoStartTimer)
    autoStartTimer = null
  }
}
