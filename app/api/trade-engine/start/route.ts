import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"

// Clear ALL stale engine timers on startup
// This fixes ReferenceError from stale closures after code updates
function clearStaleEngineTimers() {
  const engineGlobal = globalThis as unknown as {
    __engine_timers?: Set<ReturnType<typeof setInterval>>
  }
  
  if (engineGlobal.__engine_timers && engineGlobal.__engine_timers.size > 0) {
    console.log(`[v0] [Trade Engine] Clearing ${engineGlobal.__engine_timers.size} stale engine timers...`)
    for (const timer of engineGlobal.__engine_timers) {
      try {
        clearInterval(timer)
      } catch {}
    }
    engineGlobal.__engine_timers.clear()
  }
}

// RUNTIME FIX: Patch IndicationProcessor cache on every API call
// This fixes the "Cannot read properties of undefined (reading 'get')" error
function patchIndicationProcessorCaches(coordinator: any) {
  if (!coordinator) return
  
  try {
    // Access all engine managers and patch their indication processors
    const engines = coordinator.engines || coordinator._engines || new Map()
    for (const [, manager] of engines) {
      if (manager?.indicationProcessor) {
        const proc = manager.indicationProcessor
        if (!proc.marketDataCache || !(proc.marketDataCache instanceof Map)) {
          proc.marketDataCache = new Map()
          console.log("[v0] [CacheFix] Patched marketDataCache for indication processor")
        }
        if (!proc.settingsCache) {
          proc.settingsCache = { data: null, timestamp: 0 }
        }
        if (!proc.CACHE_TTL) {
          proc.CACHE_TTL = 500
        }
      }
    }
  } catch (e) {
    console.warn("[v0] [CacheFix] Error patching caches:", e)
  }
}

/**
 * POST /api/trade-engine/start
 * Start the Global Trade Engine Coordinator (independent of any connections)
 * 
 * The Global Coordinator is the overall control system.
 * Individual connection engines (Main and Preset) are controlled separately via:
 * - /api/settings/connections/[id]/live-trade (Main Engine)
 * - /api/settings/connections/[id]/preset-toggle (Preset Engine)
 */
export async function POST(request: NextRequest) {
  try {
    console.log("[v0] [Trade Engine] Starting Global Trade Engine Coordinator (independent of connections)")
    
    // CRITICAL: Clear any stale timers from previous code versions first
    clearStaleEngineTimers()
    
    await SystemLogger.logTradeEngine(`Starting Global Coordinator`, "info")

    const coordinator = getGlobalTradeEngineCoordinator()
    
    if (!coordinator) {
      return NextResponse.json({ error: "Coordinator not initialized" }, { status: 503 })
    }

    // Initialize Redis
    await initRedis()
    const client = getRedisClient()
    
    // Set global state in Redis (write-through to Upstash via persistent key prefix)
    await client.hset("trade_engine:global", { 
      status: "running", 
      started_at: new Date().toISOString(),
      coordinator_ready: "true"
    })
    
    console.log("[v0] [Trade Engine] Global Coordinator state saved to Redis + Upstash: status=running")

    // Start/refresh coordinator workers immediately so progression/logging begins without delay.
    try {
      await coordinator.startAll()
      await coordinator.refreshEngines()
      
      // CRITICAL: Apply cache fix to all indication processors after engines are started
      patchIndicationProcessorCaches(coordinator)
      
      console.log("[v0] [Trade Engine] Coordinator workers started and refreshed with cache fix applied")
    } catch (engineStartError) {
      console.warn("[v0] [Trade Engine] Coordinator worker startup warning:", engineStartError)
    }

    // Auto-resume connections AND enable ALL assigned main connections
    let resumedConnections: string[] = []
    let startedConnections: string[] = []
    try {
      const { getConnection, updateConnection, getAllConnections } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")
      const settings = await loadSettingsAsync()
      
      // First resume paused connections
      const pausedRaw = await client.get("trade_engine:paused_connections")
      if (pausedRaw) {
        const pausedIds: string[] = JSON.parse(String(pausedRaw))
        
        for (const connId of pausedIds) {
          try {
            const conn = await getConnection(connId)
            if (conn && conn.paused_by_global === "1") {
              // Re-enable live trade
              await updateConnection(connId, {
                ...conn,
                is_live_trade: "1",
                paused_by_global: "0",
                updated_at: new Date().toISOString(),
              })
              
              // Restart the engine
              await coordinator.startEngine(connId, {
                connectionId: connId,
                connection_name: conn.name,
                exchange: conn.exchange,
                indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
                strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
                realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.2,
              })
              
              resumedConnections.push(connId)
              console.log("[v0] [Trade Engine] Resumed paused connection:", connId, conn.name)
            }
          } catch (resumeErr) {
            console.warn("[v0] [Trade Engine] Failed to resume connection:", connId, resumeErr)
          }
        }
        
        // Clear the paused main list
        await client.del("trade_engine:paused_connections")
      }
      
      // ALSO: Explicitly start ALL assigned main connections that are enabled (quickstart fixes)
      const allConnections = await getAllConnections()
      for (const conn of allConnections) {
        // Only handle assigned main connections that are enabled
        if (conn.is_assigned === "1" && conn.is_enabled_dashboard === "1" && conn.is_active === "1" && 
            !resumedConnections.includes(conn.id)) {
          try {
            // Ensure live trade is enabled
            const updatedConn = {
              ...conn,
              is_live_trade: "1",
              updated_at: new Date().toISOString(),
            }
            await updateConnection(conn.id, updatedConn)
            
            // Start the engine for this connection
            await coordinator.startEngine(conn.id, {
              connectionId: conn.id,
              connection_name: conn.name,
              exchange: conn.exchange,
              indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1,
              strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1,
              realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.2,
            })
            
            startedConnections.push(conn.id)
            console.log("[v0] [Trade Engine] Started assigned connection:", conn.id, conn.name)
          } catch (startErr) {
            console.warn("[v0] [Trade Engine] Failed to start assigned connection:", conn.id, startErr)
          }
        }
      }
      
      // Also resume preset engines that were paused
      const pausedPresetRaw = await client.get("trade_engine:paused_preset_connections")
      if (pausedPresetRaw) {
        const pausedPresetIds: string[] = JSON.parse(String(pausedPresetRaw))
        const { getConnection: getConn2, updateConnection: updateConn2 } = await import("@/lib/redis-db")
        
        for (const connId of pausedPresetIds) {
          try {
            const conn = await getConn2(connId)
            if (conn && conn.paused_preset_by_global === "1") {
              await updateConn2(connId, {
                ...conn,
                is_preset_trade: "1",
                paused_preset_by_global: "0",
                updated_at: new Date().toISOString(),
              })
              
              // Update preset engine state in Redis
              if (conn.preset_type_id) {
                await client.hset(`preset_engine:${connId}:${conn.preset_type_id}`, {
                  status: "running",
                  updated_at: new Date().toISOString(),
                })
              }
              
              resumedConnections.push(connId + " (preset)")
              console.log("[v0] [Trade Engine] Resumed paused preset connection:", connId, conn.name)
            }
          } catch (resumeErr) {
            console.warn("[v0] [Trade Engine] Failed to resume preset connection:", connId, resumeErr)
          }
        }
        
        await client.del("trade_engine:paused_preset_connections")
      }
    } catch (resumeError) {
      console.warn("[v0] [Trade Engine] Failed to check paused connections:", resumeError)
    }

    const resumeMsg = resumedConnections.length > 0
      ? ` Resumed ${resumedConnections.length} previously paused connection(s).`
      : ""
    const startedMsg = startedConnections.length > 0
      ? ` Started ${startedConnections.length} assigned connection(s).`
      : ""
    
    console.log("[v0] [Trade Engine] Global Coordinator is running and ready." + resumeMsg + startedMsg)
    await SystemLogger.logTradeEngine(
      `Global Coordinator started.${resumeMsg}${startedMsg}`,
      "info",
      { resumedConnections, startedConnections }
    )

    return NextResponse.json({
      success: true,
      message: `Global Trade Engine Coordinator started and ready.${resumeMsg}${startedMsg}`,
      coordinator_status: "running",
      resumedConnections,
      startedConnections,
    })

  } catch (error) {
    console.error("[v0] Failed to start Global Coordinator:", error)
    await SystemLogger.logError(error, "trade-engine", "POST /api/trade-engine/start")

    return NextResponse.json(
      {
        error: "Failed to start Global Coordinator",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
