import { NextResponse } from "next/server"
import { getAllConnections, initRedis, updateConnection, setSettings, getSettings, getRedisClient,
  buildMainConnectionEnableUpdate } from "@/lib/redis-db"
import { API_VERSIONS } from "@/lib/system-version"
import { logProgressionEvent, getProgressionLogs } from "@/lib/engine-progression-logs"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

// RUNTIME FIX: Patch IndicationProcessor cache
// This fixes the "Cannot read properties of undefined (reading 'get')" error
function patchIndicationProcessorCaches(coordinator: any) {
  if (!coordinator) return
  try {
    const engines = coordinator.engines || coordinator._engines || new Map()
    for (const [, manager] of engines) {
      if (manager?.indicationProcessor) {
        const proc = manager.indicationProcessor
        if (!proc.marketDataCache || !(proc.marketDataCache instanceof Map)) {
          proc.marketDataCache = new Map()
        }
        if (!proc.settingsCache) {
          proc.settingsCache = { data: null, timestamp: 0 }
        }
        if (!proc.CACHE_TTL) {
          proc.CACHE_TTL = 500
        }
      }
    }
  } catch (e) { /* ignore */ }
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const API_VERSION = API_VERSIONS.tradeEngine
const LOG_PREFIX = `[v0] [QuickStart] ${API_VERSION}`

// Default trading symbol (single symbol for quickstart - DRIFTUSDT for live testing)
const DEFAULT_SYMBOLS = ["DRIFTUSDT"]

/**
 * POST /api/trade-engine/quick-start
 * Quick-start endpoint with direct function calls (no HTTP fetch):
 * 1. Tests connection using createExchangeConnector directly
 * 2. Auto-retrieves top symbols or uses defaults
 * 3. Sets up connection with these symbols
 * 4. Logs all progression events
 */
export async function POST(request: Request) {
  const startTime = Date.now()
  
  try {
    const body = await request.json().catch(() => ({}))
    const action = body.action || "enable"
    
    await initRedis()
    const client = getRedisClient()
    const allConnections = await getAllConnections()
    
    console.log(`${LOG_PREFIX}: === QUICKSTART ${action.toUpperCase()} ===`)
    console.log(`${LOG_PREFIX}: Scanning ${allConnections.length} connections...`)
    
    // Log initial progress
    await logProgressionEvent("global", "quickstart_scan", "info", `Scanning ${allConnections.length} connections`, {
      action,
      totalConnections: allConnections.length,
      timestamp: new Date().toISOString(),
    })
    
    // Find connections with credentials OR any base connection for setup
    // PREFER BINGX - it's the primary exchange for quickstart
    let connection = allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const hasCredentials = !!(c.api_key && c.api_secret && c.api_key.length >= 10 && c.api_secret.length >= 10)
      const isUserCreated = !(c.is_predefined === true || c.is_predefined === "1" || c.is_predefined === "true")
      return exch === "bingx" && isUserCreated && hasCredentials
    }) || allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const hasCredentials = !!(c.api_key && c.api_secret && c.api_key.length >= 10 && c.api_secret.length >= 10)
      const isUserCreated = !(c.is_predefined === true || c.is_predefined === "1" || c.is_predefined === "true")
      return exch === "bybit" && isUserCreated && hasCredentials
    }) || allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const hasCredentials = !!(c.api_key && c.api_secret && c.api_key.length >= 10 && c.api_secret.length >= 10)
      return exch === "bingx" && hasCredentials
    }) || allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const hasCredentials = !!(c.api_key && c.api_secret && c.api_key.length >= 10 && c.api_secret.length >= 10)
      return exch === "bybit" && hasCredentials
    }) || allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      // QuickStart startup relies on Main Connections assignment state.
      const isAssigned = c.is_assigned === "1" || c.is_assigned === true
      const isBase = exch === "bingx" || exch === "bybit" || exch === "pionex" || exch === "orangex"
      return isBase && isAssigned
    })
    
    if (!connection) {
      console.log(`${LOG_PREFIX}: No BingX/Bybit connections found in Main Connections`)
      
      await logProgressionEvent("global", "quickstart_no_connection", "warning", "No BingX/Bybit connections in Main Connections", {
        totalConnections: allConnections.length,
        availableExchanges: [...new Set(allConnections.map((c: any) => c.exchange))],
      })
      
      return NextResponse.json(
        { 
          success: false,
          error: "No BingX/Bybit connections found in Main Connections",
          message: "Add a BingX or Bybit connection to Main Connections first, then add API credentials in Settings",
          availableConnections: allConnections.map((c: any) => ({ 
            name: c.name,
            id: c.id,
            exchange: c.exchange,
            hasCredentials: !!(c.api_key && c.api_secret && c.api_key.length >= 10),
            isMainAssigned: c.is_assigned === "1" || c.is_assigned === true,
          })),
          logs: await getProgressionLogs("global"),
        },
        { status: 400 }
      )
    }
    
    const hasCredentials = !!(connection.api_key && connection.api_secret && 
      connection.api_key.length >= 10 && connection.api_secret.length >= 10)
    
    const exchangeName = (connection.exchange || "").toLowerCase()
    const connectionId = connection.id
    console.log(`${LOG_PREFIX}: Found ${connection.name} (${connectionId}) on ${exchangeName}`)
    
    // DISABLE ACTION
    if (action === "disable") {
      console.log(`${LOG_PREFIX}: Disabling ${connection.name}...`)
      const disabled = {
        ...connection,
        is_dashboard_inserted: "0",
        is_enabled_dashboard: "0",
        is_assigned: "0",
        is_enabled: "0",
        updated_at: new Date().toISOString(),
      }
      await updateConnection(connectionId, disabled)
      
      await logProgressionEvent(connectionId, "quickstart_disabled", "info", "Connection disabled via QuickStart", {
        connectionName: connection.name,
      })
      
      console.log(`${LOG_PREFIX}: Disabled ${connection.name}`)
      const disableLogs = await getProgressionLogs(connectionId)
      
      return NextResponse.json({
        success: true,
        action: "disable",
        connection: { id: connectionId, name: connection.name, exchange: exchangeName },
        logs: disableLogs,
        logsCount: disableLogs.length,
        version: API_VERSION,
      })
    }
    
    // ENABLE ACTION
    await logProgressionEvent(connectionId, "quickstart_started", "info", "QuickStart enable flow initiated", {
      connectionId,
      connectionName: connection.name,
      exchange: exchangeName,
      hasCredentials,
    })
    
    // Step 1: Test connection (only if credentials exist)
    console.log(`${LOG_PREFIX}: [1/4] Testing connection...`)
    let testPassed = false
    let testError = ""
    let testBalance = null
    let testDuration = 0
    
    if (!hasCredentials) {
      console.log(`${LOG_PREFIX}: [1/4] SKIPPED - No API credentials configured`)
      testError = "No API credentials configured. Add credentials in Settings to enable trading."
      await logProgressionEvent(connectionId, "quickstart_test_skipped", "warning", "Test skipped - no credentials", {
        message: "Add API key and secret in Settings to enable trading",
      })
    } else {
      try {
        const testStart = Date.now()
        const connector = await createExchangeConnector(exchangeName, {
          apiKey: connection.api_key,
          apiSecret: connection.api_secret,
          apiPassphrase: connection.api_passphrase || "",
          isTestnet: false,
          apiType: connection.api_type || "perpetual_futures",
        })
        
        const testResult = await Promise.race([
          connector.testConnection(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Test timeout (30s)")), 30000))
        ]) as any
        
        testDuration = Date.now() - testStart
        testPassed = testResult.success !== false
        testBalance = testResult.balance
        testError = testResult.error || ""
        
        console.log(`${LOG_PREFIX}: [1/4] Test ${testPassed ? "PASSED" : "FAILED"} (${testDuration}ms)${testBalance ? ` Balance: ${testBalance}` : ""}`)
        
        await logProgressionEvent(connectionId, "quickstart_test", testPassed ? "info" : "warning", 
          `Connection test ${testPassed ? "passed" : "failed"}`, {
            testPassed,
            testError: testError || undefined,
            balance: testBalance,
            duration: testDuration,
          })
      } catch (testErr) {
        testDuration = Date.now() - startTime
        testError = testErr instanceof Error ? testErr.message : String(testErr)
        console.log(`${LOG_PREFIX}: [1/4] Test ERROR: ${testError}`)
        
        await logProgressionEvent(connectionId, "quickstart_test_error", "error", "Connection test failed", {
          error: testError,
          duration: testDuration,
        })
      }
    }
    
    // Step 2: Get symbols (single symbol for quickstart)
    console.log(`${LOG_PREFIX}: [2/4] Configuring symbol...`)
    let symbols = body.symbols || [...DEFAULT_SYMBOLS]
    
    if (testPassed) {
      try {
        const connector = await createExchangeConnector(exchangeName, {
          apiKey: connection.api_key,
          apiSecret: connection.api_secret,
          isTestnet: false,
        })
        
        if (typeof connector.getTopSymbols === "function") {
          const topSymbols = await connector.getTopSymbols(1) // Get only 1 symbol
          if (topSymbols && topSymbols.length > 0) {
            symbols = topSymbols
            console.log(`${LOG_PREFIX}: [2/4] Retrieved top symbol from exchange: ${symbols.join(", ")}`)
          }
        }
      } catch {
        // Use defaults if retrieval fails
      }
    }
    console.log(`${LOG_PREFIX}: [2/4] Symbol: ${symbols.join(", ")}`)
    
    await logProgressionEvent(connectionId, "quickstart_symbols", "info", "Trading symbols configured", {
      symbols,
      count: symbols.length,
    })
    
     // Step 3: QuickStart must assign + enable connection flow
     console.log(`${LOG_PREFIX}: [3/4] Updating connection state...`)
     
     const updated = {
       ...connection,
       // Explicit quickstart assignment/enabling for engine processing
       is_active_inserted: "1",
       is_dashboard_inserted: "1",
       is_enabled_dashboard: "1",
       is_assigned: "1",
       is_active: "1",
       active_symbols: JSON.stringify(symbols),
       last_test_status: testPassed ? "success" : "failed",
       last_test_balance: testBalance,
       last_test_at: new Date().toISOString(),
       updated_at: new Date().toISOString(),
     }
     
     await updateConnection(connectionId, updated)
     console.log(`${LOG_PREFIX}: [3/4] Connection state updated (assigned+enabled for quickstart).`)
    
    // ALSO store in trade_engine_state for engine to find
    await setSettings(`trade_engine_state:${connectionId}`, {
      connection_id: connectionId,
      symbols: symbols,
      active_symbols: symbols,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    console.log(`${LOG_PREFIX}: [3/4] Stored symbols in trade_engine_state: ${symbols.join(", ")}`)
    
     const isAssigned = updated.is_assigned === "1" || updated.is_assigned === true
     const isMainEnabled = updated.is_enabled_dashboard === "1" || updated.is_enabled_dashboard === true
     
     await logProgressionEvent(connectionId, "quickstart_updated", "info", "Connection state updated", {
       symbols,
       isAssigned,
       isMainEnabled,
       testPassed,
     })
     
      // Step 4: Start engine - FIRST ensure Global Coordinator is running
      console.log(`${LOG_PREFIX}: [4/4] Starting Global Trade Engine Coordinator first...`)
      await setSettings(`engine_progression:${connectionId}`, {
        phase: "initializing",
        progress: 5,
        connectionId,
        connectionName: connection.name,
        exchange: exchangeName,
        symbols,
        testPassed,
        detail: "Starting Global Trade Engine Coordinator...",
        updated_at: new Date().toISOString(),
      })
      
      try {
        // ALWAYS start global coordinator - ensures all workers and progression systems are active
        const coordinator = getGlobalTradeEngineCoordinator()
        await coordinator.startAll()
        await coordinator.refreshEngines()
        
        // CRITICAL: Apply cache fix to all indication processors after engines are started
        patchIndicationProcessorCaches(coordinator)
        
        // Set global engine state to running
        await client.hset("trade_engine:global", { 
          status: "running", 
          started_at: new Date().toISOString(),
          coordinator_ready: "true"
        })
        
        console.log(`${LOG_PREFIX} ✓ Global Coordinator started successfully with cache fix applied`)
        await logProgressionEvent("global", "global_coordinator_started", "info", "Global Trade Engine Coordinator started via QuickStart")
        
      } catch (globalStartError) {
        console.warn(`${LOG_PREFIX} Global Coordinator start warning (already running?):`, globalStartError)
      }
      
      if (isAssigned && isMainEnabled) {
        console.log(`${LOG_PREFIX}: [4/4] Connection is explicitly enabled - initializing Main Engine...`)
        await setSettings(`engine_progression:${connectionId}`, {
          phase: "starting",
          progress: 15,
          connectionId,
          connectionName: connection.name,
          exchange: exchangeName,
          symbols,
          testPassed,
          detail: testPassed 
            ? "Starting Main Trade Engine..."
            : `Connection test failed: ${testError}. Fix credentials and retry.`,
          updated_at: new Date().toISOString(),
        })
        
        try {
          const settings = await loadSettingsAsync()
          const coordinator = getGlobalTradeEngineCoordinator()
          
          await coordinator.startEngine(connectionId, {
            connectionId,
            connection_name: connection.name,
            exchange: exchangeName,
            engine_type: "main",
            indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 3,
          })
          
          // Ensure connection is marked as live trade enabled
          await updateConnection(connectionId, {
            ...connection,
            is_live_trade: "1",
            updated_at: new Date().toISOString(),
          })
          
          console.log(`${LOG_PREFIX} ✓ Main Engine started for ${connection.name}`)
          await logProgressionEvent(connectionId, "engine_started", "info", "Main Trade Engine started via QuickStart", {
            connectionId,
            connectionName: connection.name,
            exchange: exchangeName,
            testPassed,
          })
        } catch (engineError) {
          console.error(`${LOG_PREFIX} Failed to start engine:`, engineError)
          await logProgressionEvent(connectionId, "engine_start_error", "error", "Failed to start engine", {
            error: engineError instanceof Error ? engineError.message : String(engineError),
          })
        }
      }
    
    // Store in global quickstart state
    await client.set("quickstart:last_run", JSON.stringify({
      connectionId,
      connectionName: connection.name,
      exchange: exchangeName,
      testPassed,
      testError: testError || undefined,
      symbols,
      timestamp: new Date().toISOString(),
    }), { EX: 86400 })
    
    await logProgressionEvent(connectionId, "quickstart_complete", "info", "QuickStart completed successfully", {
      testPassed,
      symbols,
      totalDuration: Date.now() - startTime,
    })
    
    const totalDuration = Date.now() - startTime
    console.log(`${LOG_PREFIX}: === QUICKSTART COMPLETE ===`)
    console.log(`${LOG_PREFIX}: Connection: ${connection.name}`)
    console.log(`${LOG_PREFIX}: Test: ${testPassed ? "PASSED" : "FAILED"}`)
    console.log(`${LOG_PREFIX}: Symbols: ${symbols.join(", ")}`)
    console.log(`${LOG_PREFIX}: Duration: ${totalDuration}ms`)
    
    // Get all logs for response
    const allLogs = await getProgressionLogs(connectionId)
    
    // Calculate comprehensive engine counts from Redis
    const startStatsTime = Date.now()
    
    const engineState = (await getSettings(`trade_engine_state:${connectionId}`)) || {}

    // Basic counts
    const indicationsCount = toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0))
    const strategiesCount = toNumber(await client.get(`strategies:${connectionId}:count`).catch(() => 0))
    const positionsCount = await client.scard(`positions:${connectionId}`).catch(() => 0)
    const tradesCount = await client.scard(`trades:${connectionId}`).catch(() => 0)
    
    // Detailed indication counts by type
    const directionIndications = toNumber(await client.get(`indications:${connectionId}:direction:count`).catch(() => 0))
    const moveIndications = toNumber(await client.get(`indications:${connectionId}:move:count`).catch(() => 0))
    const activeIndications = toNumber(await client.get(`indications:${connectionId}:active:count`).catch(() => 0))
    const optimalIndications = toNumber(await client.get(`indications:${connectionId}:optimal:count`).catch(() => 0))
    const autoIndications = toNumber(await client.get(`indications:${connectionId}:auto:count`).catch(() => 0))

    const strategyCounts = {
      base: toNumber(await client.get(`strategies:${connectionId}:base:count`).catch(() => 0)),
      main: toNumber(await client.get(`strategies:${connectionId}:main:count`).catch(() => 0)),
      real: toNumber(await client.get(`strategies:${connectionId}:real:count`).catch(() => 0)),
    }
    const strategyEvaluated = {
      base: toNumber(await client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0)),
      main: toNumber(await client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0)),
      real: toNumber(await client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0)),
    }
    
    // Pseudo positions by type
    const basePseudoPositions = await client.scard(`base_pseudo:${connectionId}`).catch(() => 0)
    const mainPseudoPositions = await client.scard(`main_pseudo:${connectionId}`).catch(() => 0)
    const realPseudoPositions = await client.scard(`real_pseudo:${connectionId}`).catch(() => 0)
    
    // Live positions (real exchange positions)
    const livePositionsCount = await client.scard(`positions:${connectionId}:live`).catch(() => 0)
    
    // Get prehistoric data info
    const prehistoricSymbols = await client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0)
    let prehistoricDataSize = 0
    try {
      const keys = await client.keys(`prehistoric:${connectionId}:*`)
      prehistoricDataSize = keys.length
    } catch { /* ignore */ }
    
    // Get intervals processed
    const intervalsProcessed = toNumber(await client.get(`intervals:${connectionId}:processed_count`).catch(() => 0))
    
    // Get cycle duration from settings
    const progressionState = await client.hgetall(`progression:${connectionId}`).catch(() => ({} as Record<string, string>)) || {}
    const cycleDuration = Number(engineState?.last_cycle_duration || progressionState?.last_cycle_duration || progressionState?.cycle_duration || 0)
    const totalCycleDuration = Date.now() - startStatsTime
    
    // Build comprehensive stats object
    const overallStats = {
      // Symbols
      symbolsCount: symbols.length,
      symbolsProcessing: symbols,
      prehistoricSymbolsLoaded: prehistoricSymbols,
      prehistoricDataSize,
      
      // Intervals
      intervalsProcessed,
      
      // Indications by type
       indicationsByType: {
         direction: directionIndications,
         move: moveIndications,
         active: activeIndications,
         optimal: optimalIndications,
         auto: autoIndications,
         total: indicationsCount || directionIndications + moveIndications + activeIndications + optimalIndications + autoIndications,
       },
       strategyCounts,
       strategyEvaluated,
      
      // Pseudo positions by type
      pseudoPositions: {
        base: basePseudoPositions,
        baseByIndicationType: {
          direction: await client.scard(`base_pseudo:${connectionId}:direction`).catch(() => 0),
          move: await client.scard(`base_pseudo:${connectionId}:move`).catch(() => 0),
          active: await client.scard(`base_pseudo:${connectionId}:active`).catch(() => 0),
          optimal: await client.scard(`base_pseudo:${connectionId}:optimal`).catch(() => 0),
        },
        main: mainPseudoPositions,
        real: realPseudoPositions,
        total: basePseudoPositions + mainPseudoPositions + realPseudoPositions,
      },
      
      // Live positions
      livePositions: livePositionsCount,
      
      // Timing
      cycleDurationMs: cycleDuration,
      statsCollectionDurationMs: totalCycleDuration,
      totalDuration,
    }
    
    console.log(`${LOG_PREFIX}: === COMPREHENSIVE STATS ===`)
    console.log(`${LOG_PREFIX}: Symbols: ${symbols.length}, Prehistoric: ${prehistoricSymbols}`)
    console.log(`${LOG_PREFIX}: Indications - Direction: ${directionIndications}, Move: ${moveIndications}, Active: ${activeIndications}, Optimal: ${optimalIndications}`)
    console.log(`${LOG_PREFIX}: Pseudo Positions - Base: ${basePseudoPositions}, Main: ${mainPseudoPositions}, Real: ${realPseudoPositions}`)
    console.log(`${LOG_PREFIX}: Live Positions: ${livePositionsCount}, Cycle Duration: ${cycleDuration}ms`)
    
    return NextResponse.json({
      success: true,
      action: "enable",
      connection: { 
        id: connectionId, 
        name: connection.name, 
        exchange: exchangeName,
        symbols,
        testPassed,
        testError: testError || undefined,
        testBalance,
      },
      engineCounts: {
        indications: indicationsCount,
        strategies: strategiesCount,
        positions: positionsCount,
        trades: tradesCount,
      },
      // Comprehensive overall statistics
      overallStats: {
        symbols: {
          count: overallStats.symbolsCount,
          processing: overallStats.symbolsProcessing,
          prehistoricLoaded: overallStats.prehistoricSymbolsLoaded,
          prehistoricDataSize: overallStats.prehistoricDataSize,
        },
        intervalsProcessed: overallStats.intervalsProcessed,
        indicationsByType: overallStats.indicationsByType,
        strategyCounts: overallStats.strategyCounts,
        strategyEvaluated: overallStats.strategyEvaluated,
        pseudoPositions: overallStats.pseudoPositions,
        livePositions: overallStats.livePositions,
        cycleTimeMs: overallStats.cycleDurationMs,
        totalDurationMs: overallStats.totalDuration,
      },
      status: hasCredentials ? "ready_with_credentials" : "ready_without_credentials",
      nextSteps: hasCredentials 
        ? "Connection assigned and enabled in Main Connections. Engine startup initiated."
        : "Connection assigned and enabled for quickstart, but credentials are missing/invalid for live exchange operations.",
      duration: totalDuration,
      logs: allLogs.slice(0, 50),
      logsCount: allLogs.length,
      version: API_VERSION,
    })
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`${LOG_PREFIX}: FATAL ERROR:`, errorMsg)
    
    await logProgressionEvent("global", "quickstart_error", "error", "QuickStart failed with exception", {
      error: errorMsg,
      duration: Date.now() - startTime,
    })
    
    const errorLogs = await getProgressionLogs("global")
    
    return NextResponse.json(
      { 
        success: false, 
        error: "Quick start failed", 
        details: errorMsg,
        logs: errorLogs,
        logsCount: errorLogs.length,
        version: API_VERSION 
      },
      { status: 500 }
    )
  }
}
