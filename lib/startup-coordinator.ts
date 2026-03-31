/**
 * Startup Coordinator
 * PHASE 4 FIX: Clean startup sequence with no auto-enablement
 * 
 * Goals:
 * 1. Clear sequential startup
 * 2. No automatic engine start (user must enable manually)
 * 3. Validation only - no data mutation unless necessary
 * 4. Clear logging of what happened
 */

import {
  initRedis,
  getAllConnections,
  getRedisClient,
  getSettings,
  setSettings,
} from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"
import { validateDatabase } from "@/lib/database-validator"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { consolidateDatabase } from "@/lib/database-consolidation"

/**
 * PHASE 4 FIX 4.1: Clean up orphaned progress from incomplete shutdowns
 */
export async function cleanupOrphanedProgress() {
  try {
    const client = getRedisClient()

    console.log(`[v0] [Startup] Cleaning up orphaned progress...`)

    // Find connections with is_running=1 but no active manager
    const allConnections = await getAllConnections()
    const coordinator = getGlobalTradeEngineCoordinator()

    let cleanedUp = 0

    for (const conn of allConnections) {
      const runningFlag = await getSettings(`engine_is_running:${conn.id}`)

      // If marked as running but coordinator doesn't have it, clean up
      if (runningFlag === "true" || runningFlag === "1") {
        if (!coordinator.isEngineRunning(conn.id)) {
          console.log(`[v0] [Startup] Cleaning orphaned running flag for ${conn.id}`)

          // Clear orphaned flags
          await setSettings(`engine_is_running:${conn.id}`, "false")
          await setSettings(`engine_progression:${conn.id}`, {
            phase: "idle",
            progress: 0,
            detail: "Cleaned up after unclean shutdown",
            updated_at: new Date().toISOString(),
          })

          cleanedUp++
        }
      }
    }

    console.log(`[v0] [Startup] ✓ Cleaned up ${cleanedUp} orphaned progress flags`)
  } catch (error) {
    console.warn(`[v0] [Startup] Warning during cleanup: ${error}`)
    // Don't fail startup on cleanup errors
  }
}

/**
 * PHASE 4 FIX 4.1: Complete startup sequence (no auto-start)
 */
export async function completeStartup() {
  console.log(`[v0] [Startup] ========================================`)
  console.log(`[v0] [Startup] Beginning pre-startup sequence...`)
  console.log(`[v0] [Startup] ========================================\n`)

  try {
    // Step 1: Initialize Redis
    console.log(`[v0] [Startup] Step 1/7: Initializing Redis...`)
    await initRedis()
    console.log(`[v0] [Startup] ✓ Redis initialized\n`)

    // Step 2: Run migrations
    console.log(`[v0] [Startup] Step 2/7: Running database migrations...`)
    const migResult = await runMigrations()
    console.log(`[v0] [Startup] ✓ Migrations complete (v${migResult.version})\n`)

    // Step 3: Validate database integrity
    console.log(`[v0] [Startup] Step 3/7: Validating database integrity...`)
    try {
      await validateDatabase()
      console.log(`[v0] [Startup] ✓ Database validation passed\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database validation warning: ${e}`)
      console.log(`[v0] [Startup] ✓ Continuing with warnings\n`)
    }

    // Step 4: Load base connections (no start)
    console.log(`[v0] [Startup] Step 4/7: Loading base connections...`)
    const allConnections = await getAllConnections()
    console.log(`[v0] [Startup] ✓ Loaded ${allConnections.length} base connections\n`)

    // Step 5: Consolidate database (Phase 3)
    console.log(`[v0] [Startup] Step 5/7: Consolidating database structures...`)
    try {
      await consolidateDatabase()
      console.log(`[v0] [Startup] ✓ Database consolidation complete\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database consolidation warning: ${e}`)
    }

    // Step 6: Initialize coordinator (don't start engines)
    console.log(`[v0] [Startup] Step 6/7: Initializing engine coordinator...`)
    const coordinator = getGlobalTradeEngineCoordinator()
    console.log(`[v0] [Startup] ✓ Engine coordinator initialized (ready for manual start)\n`)

    // Step 7: Clean up orphaned progress
    console.log(`[v0] [Startup] Step 7/7: Cleaning up orphaned state...`)
    await cleanupOrphanedProgress()
    console.log(`[v0] [Startup] ✓ Cleanup complete\n`)

    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] ✓ Pre-startup sequence complete`)
    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] Ready for user interaction`)
    console.log(`[v0] [Startup] Engines will NOT start automatically`)
    console.log(`[v0] [Startup] User must enable connections in Dashboard`)
    console.log(`[v0] [Startup] ========================================\n`)
  } catch (error) {
    console.error(`[v0] [Startup] ✗ Fatal error during startup:`, error)
    throw error
  }
}

/**
 * PHASE 4: Get startup status for diagnostics
 */
export async function getStartupStatus() {
  try {
    const client = getRedisClient()

    const redisReachable = await client.ping()
    const schemaVersion = await client.get("_schema_version")
    const connections = await getAllConnections()
    const migrationsRun = await client.get("_migrations_run")

    return {
      redis_reachable: redisReachable === "PONG",
      schema_version: schemaVersion,
      connections_count: connections.length,
      migrations_run: migrationsRun === "1",
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    return {
      redis_reachable: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }
  }
}
