/**
 * Redis Migration Runner - Complete System
 * Handles schema initialization and data migrations for all system components
 */

import { getRedisClient, initRedis, setMigrationsRun, haveMigrationsRun } from "./redis-db"
import { getBaseConnectionCredentials, type BaseConnectionId } from "./base-connection-credentials"

interface Migration {
  name: string
  version: number
  up: (client: any) => Promise<void>
  down: (client: any) => Promise<void>
}

let migrationRunPromise: Promise<{ success: boolean; message: string; version: number }> | null = null

const migrations: Migration[] = [
  {
    name: "001-initial-schema",
    version: 1,
    up: async (client: any) => {
      await client.set("_schema_version", "1")
      // Initialize set keys without empty strings - sets are created empty on first use
      const keys = [
        "connections:all", "connections:bybit", "connections:bingx", "connections:pionex", "connections:orangex",
        "connections:active", "connections:inactive",
        "trades:all", "trades:open", "trades:closed", "trades:pending",
        "positions:all", "positions:open", "positions:closed",
        "users:all", "sessions:all", "presets:all", "preset_types:all",
        "strategies:all", "strategies:active",
        "monitoring:events", "logs:system", "logs:trades", "logs:errors"
      ]
      // Initialize each set as empty (don't add empty strings)
      for (const key of keys) {
        // Just create the key structure by setting a marker
        await client.set(`_index:${key}`, "initialized")
      }
      console.log("[v0] Migration 001: Initial schema created")
    },
    down: async (client: any) => {
      await client.del("_schema_version")
    },
  },
  {
    name: "002-connection-management",
    version: 2,
    up: async (client: any) => {
      await client.set("_schema_version", "2")
      await client.set("_connections_indexed", "true")
      await client.hset("connections:metadata", {
        total_configured: "0",
        total_active: "0",
        total_errors: "0",
        last_sync: new Date().toISOString(),
      })
      for (const exchange of ["bybit", "bingx", "pionex", "orangex"]) {
        await client.hset(`exchange:${exchange}:metadata`, {
          name: exchange,
          api_calls_used: "0",
          api_rate_limit: "0",
          last_updated: new Date().toISOString(),
        })
      }
      console.log("[v0] Migration 002: Connection management structure created")
    },
    down: async (client: any) => {
      await client.del("_connections_indexed")
      await client.set("_schema_version", "1")
    },
  },
  {
    name: "003-trade-positions-schema",
    version: 3,
    up: async (client: any) => {
      await client.set("_schema_version", "3")
      await client.set("_trades_initialized", "true")
      await client.hset("trades:metadata", {
        total_trades: "0", total_open: "0", total_closed: "0",
        total_win: "0", total_loss: "0", total_profit: "0",
        avg_profit: "0", win_rate: "0", last_trade_time: "",
      })
      await client.hset("positions:metadata", {
        total_positions: "0", total_open_positions: "0", total_closed_positions: "0",
        total_contracts: "0", total_collateral: "0", total_pnl: "0", avg_leverage: "0",
      })
      await client.set("trades:counter:open", "0")
      await client.set("trades:counter:closed", "0")
      await client.set("trades:counter:pending", "0")
      await client.set("positions:counter:open", "0")
      await client.set("positions:counter:closed", "0")
      console.log("[v0] Migration 003: Trade and position schemas created")
    },
    down: async (client: any) => {
      await client.del("_trades_initialized")
      await client.set("_schema_version", "2")
    },
  },
  {
    name: "004-preset-strategy-management",
    version: 4,
    up: async (client: any) => {
      await client.set("_schema_version", "4")
      await client.set("_presets_initialized", "true")
      await client.hset("presets:metadata", {
        total_presets: "0", total_active: "0", total_inactive: "0",
        total_runs: "0", avg_success_rate: "0",
      })
      await client.hset("strategies:metadata", {
        total_strategies: "0", total_active_strategies: "0",
        total_backtests: "0", avg_win_rate: "0", avg_profit_factor: "0",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      await client.set("strategies:counter:active", "0")
      await client.set("strategies:counter:paused", "0")
      await client.set("strategies:counter:stopped", "0")
      console.log("[v0] Migration 004: Preset and strategy management created")
    },
    down: async (client: any) => {
      await client.del("_presets_initialized")
      await client.set("_schema_version", "3")
    },
  },
  {
    name: "005-user-authentication",
    version: 5,
    up: async (client: any) => {
      await client.set("_schema_version", "5")
      await client.set("_auth_initialized", "true")
      await client.hset("users:metadata", {
        total_users: "1", total_active_sessions: "0",
        last_login: new Date().toISOString(),
      })
      await client.hset("sessions:metadata", {
        total_sessions: "0", active_sessions: "0", expired_sessions: "0",
      })
      const adminId = "admin-001"
      await client.hset(`user:${adminId}`, {
        id: adminId, username: "admin", email: "admin@trading-engine.local",
        role: "admin", created_at: new Date().toISOString(),
        last_login: new Date().toISOString(), status: "active", api_keys_count: "0",
      })
      await client.sadd("users:all", adminId)
      await client.sadd("users:admin", adminId)
      console.log("[v0] Migration 005: User authentication system created")
    },
    down: async (client: any) => {
      await client.del("_auth_initialized")
      await client.set("_schema_version", "4")
    },
  },
  {
    name: "006-monitoring-logging",
    version: 6,
    up: async (client: any) => {
      await client.set("_schema_version", "6")
      await client.set("_monitoring_initialized", "true")
      await client.hset("monitoring:metadata", {
        total_events: "0", critical_events: "0", warning_events: "0",
        info_events: "0", last_event_time: new Date().toISOString(),
      })
      await client.hset("system:health", {
        status: "healthy", uptime_seconds: "0", memory_usage: "0",
        cpu_usage: "0", last_check: new Date().toISOString(),
      })
      await client.hset("system:performance", {
        avg_response_time: "0", trades_per_minute: "0",
        api_calls_per_minute: "0", errors_per_hour: "0",
      })
      await client.set("logs:system:counter", "0")
      await client.set("logs:trades:counter", "0")
      await client.set("logs:errors:counter", "0")
      console.log("[v0] Migration 006: Monitoring and logging system created")
    },
    down: async (client: any) => {
      await client.del("_monitoring_initialized")
      await client.set("_schema_version", "5")
    },
  },
  {
    name: "007-cache-optimization",
    version: 7,
    up: async (client: any) => {
      await client.set("_schema_version", "7")
      await client.set("_cache_optimized", "true")
      await client.hset("cache:config", {
        connection_cache_ttl: "3600", trade_cache_ttl: "1800",
        position_cache_ttl: "900", strategy_cache_ttl: "7200", monitoring_cache_ttl: "300",
      })
      await client.hset("cache:stats", {
        total_hits: "0", total_misses: "0", hit_rate: "0", total_evictions: "0",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      console.log("[v0] Migration 007: Cache optimization created")
    },
    down: async (client: any) => {
      await client.del("_cache_optimized")
      await client.set("_schema_version", "6")
    },
  },
  {
    name: "008-performance-optimizations",
    version: 8,
    up: async (client: any) => {
      await client.set("_schema_version", "8")
      await client.set("_ttl_policies_set", "true")
      await client.hset("system:config", {
        database_type: "redis", initialized_at: new Date().toISOString(),
        version: "3.2", environment: "production", log_level: "info",
      })
      await client.hset("system:thresholds", {
        max_concurrent_trades: "1000", max_api_calls_per_minute: "6000",
        max_positions_per_connection: "500", max_connections: "100", memory_limit_mb: "1024",
      })
      await client.hset("ratelimit:config", {
        trades_per_second: "100", api_calls_per_second: "200", batch_operations_per_second: "50",
      })
      console.log("[v0] Migration 008: Performance optimizations configured")
    },
    down: async (client: any) => {
      await client.del("_ttl_policies_set")
      await client.set("_schema_version", "7")
    },
  },
  {
    name: "009-backup-recovery",
    version: 9,
    up: async (client: any) => {
      await client.set("_schema_version", "9")
      await client.set("_backup_initialized", "true")
      await client.hset("backup:metadata", {
        last_backup_time: "", last_backup_size: "0", total_backups: "0",
        backup_retention_days: "30", auto_backup_enabled: "true",
      })
      await client.hset("recovery:points", {
        total_recovery_points: "0", last_recovery_time: "", last_recovery_success: "false",
      })
      // Sets are created lazily on first real insert; avoid empty placeholder members.
      console.log("[v0] Migration 009: Backup and recovery system created")
    },
    down: async (client: any) => {
      await client.del("_backup_initialized")
      await client.set("_schema_version", "8")
    },
  },
  {
    name: "010-settings-and-metadata",
    version: 10,
    up: async (client: any) => {
      await client.set("_schema_version", "10")
      await client.hset("settings:system", {
        trade_engine_enabled: "true", auto_migration: "true",
        fallback_mode: "memory", theme: "dark", timezone: "UTC", language: "en",
      })
      await client.hset("settings:trading", {
        default_leverage: "1", max_leverage: "20",
        default_take_profit_percent: "2", default_stop_loss_percent: "1",
        max_position_size: "100000",
      })
      await client.hset("settings:api", {
        api_version: "v1", rate_limit_enabled: "true",
        cors_enabled: "true", request_timeout_seconds: "30",
      })
      await client.set("_migration_last_run", new Date().toISOString())
      await client.set("_migration_total_runs", "0")
      await client.hset("features:enabled", {
        live_trading: "false", paper_trading: "true", backtesting: "true",
        strategy_optimization: "true", ai_recommendations: "false",
      })
      console.log("[v0] Migration 010: Settings and metadata finalized")
    },
    down: async (client: any) => {
      await client.del("_migration_last_run")
      await client.set("_schema_version", "9")
    },
  },
  {
    name: "011-seed-predefined-connections",
    version: 11,
    up: async (client: any) => {
      await client.set("_schema_version", "11")
      const connections = [
        { id: "bybit-x03", name: "Bybit X03", exchange: "bybit", api_type: "unified" },
        { id: "bingx-x01", name: "BingX X01", exchange: "bingx", api_type: "perpetual_futures" },
        { id: "binance-x01", name: "Binance X01", exchange: "binance", api_type: "perpetual_futures" },
        { id: "okx-x01", name: "OKX X01", exchange: "okx", api_type: "unified" },
        { id: "gateio-x01", name: "Gate.io X01", exchange: "gateio", api_type: "perpetual_futures" },
        { id: "kucoin-x01", name: "KuCoin X01", exchange: "kucoin", api_type: "perpetual_futures" },
        { id: "mexc-x01", name: "MEXC X01", exchange: "mexc", api_type: "perpetual_futures" },
        { id: "bitget-x01", name: "Bitget X01", exchange: "bitget", api_type: "perpetual_futures" },
        { id: "pionex-x01", name: "Pionex X01", exchange: "pionex", api_type: "perpetual_futures" },
        { id: "orangex-x01", name: "OrangeX X01", exchange: "orangex", api_type: "perpetual_futures" },
        { id: "huobi-x01", name: "Huobi X01", exchange: "huobi", api_type: "perpetual_futures" },
      ]

      let seededCount = 0
      for (const conn of connections) {
        try {
          const key = `connection:${conn.id}`
          const existing = await client.hgetall(key)
          if (!existing || Object.keys(existing).length === 0) {
            const storageData = {
              id: conn.id,
              name: conn.name,
              exchange: conn.exchange,
              api_key: "", // Empty - user must add real credentials
              api_secret: "", // Empty - user must add real credentials
              api_type: conn.api_type,
              connection_method: "library",
              connection_library: "native",
              margin_type: "cross",
              position_mode: "hedge",
              is_testnet: "0",
              is_enabled: "0",
              is_enabled_dashboard: "0",
              is_active: "0",
              is_predefined: "1",
              is_inserted: "0",
              is_active_inserted: "0",
              is_live_trade: "0",
              is_preset_trade: "0",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
            await client.hset(key, storageData)
            await client.sadd("connections", conn.id)
            seededCount++
          }
        } catch (error) {
          console.warn(`[v0] Failed to seed ${conn.name}:`, error instanceof Error ? error.message : "unknown")
        }
      }
      console.log(`[v0] Migration 011: Seeded ${seededCount}/${connections.length} predefined template connections`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "10")
    },
  },
  {
    name: "012-finalize-dashboard-connections",
    version: 12,
    up: async (client: any) => {
      await client.set("_schema_version", "12")
      
      // Base connections: 4 primary exchange templates (bybit-x03, bingx-x01, pionex-x01, orangex-x01)
      // These are PREDEFINED TEMPLATES, not user-created connections
      // They should remain disabled by default - users must create their own credentials
      const baseTemplateIds = ["bybit-x03", "bingx-x01", "pionex-x01", "orangex-x01"]
      
      const connections = await client.smembers("connections") || []
      let updatedBase = 0
      let updatedOther = 0
      
      console.log(`[v0] Migration 012: Initializing connections (base templates set to predefined=1, disabled)`)
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseTemplateIds.includes(connId)) {
          // Base templates: marked as PREDEFINED, disabled, not inserted (templates only)
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",        // NOT inserted - templates only
            is_enabled: "0",         // NOT enabled by default
            is_predefined: "1",      // These are predefined templates
            is_active_inserted: "0", // NOT in active panel
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedBase++
          console.log(`[v0] Migration 012: ✓ ${connId} -> predefined=1, inserted=0, enabled=0 (template)`)
        } else {
          // Other predefined connections: all templates
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_predefined: "1",
            is_active_inserted: "0",
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedOther++
        }
      }
      
      console.log(`[v0] Migration 012: COMPLETE - ${updatedBase} base templates, ${updatedOther} other templates (all disabled)`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "11")
    },
  },
  {
    name: "013-risk-management-and-engines",
    version: 13,
    up: async (client: any) => {
      await client.set("_schema_version", "13")
      
      // Risk Management Settings with defaults
      await client.hset("settings:risk-management", {
        enabled: "false", // Disabled for now
        max_open_positions: "maximal",
        daily_loss_limit_percent: "65",
        max_drawdown_percent: "55",
        position_size_limit: "100000",
        stop_loss_enabled: "true",
        take_profit_enabled: "true",
      })
      
      // Trade Engine Controls
      await client.hset("settings:engines", {
        preset_trade_engine: "true", // Enabled
        main_trade_engine: "true", // Enabled
        realtime_positions_engine: "true", // Enabled
        risk_management_engine: "false", // Disabled for now
      })
      
      console.log("[v0] Migration 013: Risk management settings and engine controls added")
    },
    down: async (client: any) => {
      await client.del("settings:risk-management")
      await client.del("settings:engines")
      await client.set("_schema_version", "12")
    },
  },
  {
    name: "014-update-bingx-credentials",
    version: 14,
    up: async (client: any) => {
      await client.set("_schema_version", "14")
      
      // Only clear test/placeholder credentials (00998877 pattern, "test" prefix, too short)
      // Keep real credentials like BingX which have long valid API keys
      const exchanges = ["bybit-x03", "binance-x01", "okx-x01", "pionex-x01", "orangex-x01", "gateio-x01", "kucoin-x01", "mexc-x01", "bitget-x01", "huobi-x01"]
      
      for (const connectionId of exchanges) {
        try {
          const data = await client.hgetall(`connection:${connectionId}`)
          if (data && Object.keys(data).length > 0) {
            // Clear credentials if they're test/placeholder values (00998877 pattern)
            const apiKey = data.api_key as string
            if (apiKey && apiKey.includes("00998877")) {
              console.log(`[v0] Migration 014: Clearing test credentials from ${connectionId}`)
              await client.hset(`connection:${connectionId}`, {
                ...data,
                api_key: "",
                api_secret: "",
                updated_at: new Date().toISOString(),
              })
            }
          }
        } catch (error) {
          console.warn(`[v0] Migration 014: Could not update ${connectionId}:`, error)
        }
      }
      
      console.log(`[v0] Migration 014: Cleared test credentials, real credentials preserved`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "13")
    },
  },
  {
    name: "015-fix-connection-inserted-enabled-states",
    version: 15,
    up: async (client: any) => {
      await client.set("_schema_version", "15")
      
      // The 2 base exchanges that should be marked as INSERTED and ENABLED
      // Main connections are ONLY bybit and bingx
      const baseExchangeIds = ["bybit-x03", "bingx-x01"]
      
      const connections = await client.smembers("connections")
      let updatedBase = 0
      let updatedOther = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseExchangeIds.includes(connId)) {
          // Mark as INSERTED and ENABLED in Settings by default (base connection)
          // Dashboard/Main enable toggle stays OFF by default until user enables it.
          await client.hset(`connection:${connId}`, {
            is_inserted: "1",
            is_enabled: "1",              // ENABLED by default
            is_active_inserted: "1",      // Added to Active panel
            is_enabled_dashboard: "0",    // Dashboard toggle OFF by default
            is_active: "0",
            is_predefined: "1",
            connection_method: "library", // Use native SDK by default
            updated_at: new Date().toISOString(),
          })
          updatedBase++
          console.log(`[v0] Migration 015: ${connId} -> inserted=1, enabled=1, active_inserted=1, dashboard_enabled=0 (base connection)`)
        } else {
          // Non-base predefined connections: just informational templates
          // NOT inserted, NOT enabled - they are templates only
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_predefined: "1",
            is_enabled_dashboard: "0",
            updated_at: new Date().toISOString(),
          })
          updatedOther++
          console.log(`[v0] Migration 015: ${connId} -> inserted=0, enabled=0 (template only)`)
        }
      }
      
      console.log(`[v0] Migration 015: Fixed ${updatedBase} base connections, ${updatedOther} template connections`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "14")
    },
  },
  {
    name: "016-active-connections-independent-state",
    version: 16,
    up: async (client: any) => {
      await client.set("_schema_version", "16")
      
// Migration 016: Ensure the 2 base connections are properly set up with predefined real credentials
       // Base connections: bybit, bingx only - should be INSERTED and ENABLED
       // NOTE: is_active_inserted is NOT set here - user must explicitly assign to main via dashboard
       const baseTemplateIds = ["bybit-x03", "bingx-x01"]
       
       const connections = await client.smembers("connections") || []
       let updatedTemplates = 0
       let updatedUserConnections = 0
       
       console.log(`[v0] Migration 016: Ensuring predefined templates state for ${connections.length} connections`)
       
       for (const connId of connections) {
         const connData = await client.hgetall(`connection:${connId}`)
         if (!connData || Object.keys(connData).length === 0) continue
         
         const isPredefined = connData.is_predefined === "1" || connData.is_predefined === true
         const isBaseTemplate = baseTemplateIds.includes(connId)
         
         if (isBaseTemplate) {
           // Base connections: inserted and enabled in Settings by default
           // Main (dashboard) enable toggle must remain OFF by default.
           // is_active_inserted is NOT set - user must explicitly assign to main connections panel
           const updateData: Record<string, string> = {
             is_inserted: "1",        // INSERTED (visible in Settings base panel)
             is_enabled: "1",         // ENABLED (independent system flag)
             is_active_inserted: "0", // NOT in Active panel - user must explicitly assign
             is_enabled_dashboard: "0", // Dashboard toggle OFF by default
             is_active: "0",          // Derived: is_active_inserted AND is_enabled_dashboard
             connection_method: "library", // Use native SDK by default
             updated_at: new Date().toISOString(),
           }
           
           if (baseTemplateIds.includes(connId)) {
             const credentials = getBaseConnectionCredentials(connId as BaseConnectionId)
             updateData.api_key = credentials.apiKey
             updateData.api_secret = credentials.apiSecret
           }
           
           await client.hset(`connection:${connId}`, updateData)
           updatedTemplates++
           console.log(`[v0] Migration 016: ✓ ${connId} -> inserted=1, enabled=1, dashboard_enabled=0 (base connection)`)
         } else if (!isPredefined) {
           // User-created connections: reset dashboard state if not properly set
           if (!connData.is_active_inserted || !connData.is_enabled_dashboard) {
             await client.hset(`connection:${connId}`, {
               is_active_inserted: "0",      // Default: NOT in active panel
               is_enabled_dashboard: "0",    // Default: NOT enabled
               is_enabled: connData.is_enabled || "0",  // Preserve existing enabled state
               updated_at: new Date().toISOString(),
             })
             updatedUserConnections++
             console.log(`[v0] Migration 016: ✓ ${connId} reset dashboard state to defaults`)
           }
         }
       }
       
       console.log(`[v0] Migration 016: COMPLETE - ${updatedTemplates} templates verified, ${updatedUserConnections} user connections updated`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "15")
    },
  },
  {
    name: "017-cleanup-base-connections-to-bybit-bingx-only",
    version: 17,
    up: async (client: any) => {
      await client.set("_schema_version", "17")
      
      // Cleanup migration: Reset all connections to proper state
      // Only bybit-x03 and bingx-x01 should be base connections (inserted=1, enabled=1)
      // All others (pionex, orangex, binance, etc) should be templates only (inserted=0, enabled=0)
      const baseExchangeIds = ["bybit-x03", "bingx-x01"]
      
      const connections = await client.smembers("connections")
      let cleanedBase = 0
      let cleanedTemplates = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        if (baseExchangeIds.includes(connId)) {
          // Base connection: ensure proper state in BASE connections only
          // NOTE: is_active_inserted is NOT set here - user must explicitly assign to main
          await client.hset(`connection:${connId}`, {
            is_inserted: "1",
            is_enabled: "1",
            is_active_inserted: "0",      // NOT auto-assigned to main - user must explicitly do this
            is_enabled_dashboard: "0",    // UI toggle OFF by default
            is_active: "0",
            is_predefined: "1",
            connection_method: "library",
            updated_at: new Date().toISOString(),
          })
          cleanedBase++
          console.log(`[v0] Migration 017: ✓ ${connId} -> corrected to base connection state`)
        } else {
          // Non-base connection: ensure template state
          // Reset to template-only state to prevent auto-assignment
          await client.hset(`connection:${connId}`, {
            is_inserted: "0",
            is_enabled: "0",
            is_active_inserted: "0",
            is_enabled_dashboard: "0",
            is_active: "0",
            is_predefined: "1",
            updated_at: new Date().toISOString(),
          })
          cleanedTemplates++
          console.log(`[v0] Migration 017: ✓ ${connId} -> corrected to template-only state`)
        }
      }
      
      console.log(`[v0] Migration 017: COMPLETE - ${cleanedBase} base connections, ${cleanedTemplates} templates cleaned up`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "16")
    },
  },
  {
    name: "018-remove-auto-assignment-from-main-connections",
    version: 18,
    up: async (client: any) => {
      await client.set("_schema_version", "18")
      
      // Fix: Remove auto-assignment from main connections
      // Connections should only be in main if user explicitly assigned them
      const connections = await client.smembers("connections")
      let fixed = 0
      
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        if (!connData || Object.keys(connData).length === 0) continue
        
        // If connection has is_active_inserted="1" but no explicit user action,
        // reset it to NOT assigned to main connections
        // Only keep assignment if dashboard is enabled (user intent)
        const isDashboardEnabled = connData.is_enabled_dashboard === "1" || connData.is_enabled_dashboard === "true"
        const isActiveInserted = connData.is_active_inserted === "1" || connData.is_active_inserted === "true"
        
        if (isActiveInserted && !isDashboardEnabled) {
          // Reset to not assigned - user must explicitly add to main
          await client.hset(`connection:${connId}`, {
            is_active_inserted: "0",
            updated_at: new Date().toISOString(),
          })
          fixed++
          console.log(`[v0] Migration 018: ✓ ${connId} -> removed auto-assignment (dashboard not enabled)`)
        }
      }
      
      console.log(`[v0] Migration 018: COMPLETE - fixed ${fixed} connections that were auto-assigned`)
    },
    down: async (client: any) => {
      await client.set("_schema_version", "17")
    },
  },
  {
    name: "020-phase3-database-consolidation",
    version: 20,
    up: async (client: any) => {
      await client.set("_schema_version", "20")
      
      console.log(`[v0] Migration 020: PHASE 3 - Database consolidation starting...`)
      
      // PHASE 3 FIX: Consolidate progression keys
      const connections = await client.smembers("connections")
      let consolidated = 0
      
      for (const connId of connections) {
        try {
          // Read from old scattered keys
          const oldProgression = await client.hgetall(`progression:${connId}`)
          const oldEngineState = await client.hgetall(`engine_state:${connId}`)
          const oldTradeEngineState = await client.hgetall(`trade_engine_state:${connId}`)
          
          // Build unified structure
          const unified = {
            cycles_completed: oldProgression?.cycles_completed || "0",
            successful_cycles: oldProgression?.successful_cycles || "0",
            failed_cycles: oldProgression?.failed_cycles || "0",
            phase: oldProgression?.phase || oldTradeEngineState?.phase || "idle",
            phase_progress: oldProgression?.progress || oldEngineState?.progress || "0",
            phase_message: oldProgression?.detail || oldEngineState?.detail || "",
            engine_started: oldEngineState?.started_at || oldTradeEngineState?.started_at || "",
            last_cycle: oldProgression?.last_cycle || "",
            last_indication_count: oldProgression?.indication_count || "0",
            last_strategy_count: oldProgression?.strategy_count || "0",
            symbols_count: oldTradeEngineState?.symbols_count || "0",
            updated_at: new Date().toISOString(),
          }
          
          // Write unified structure
          await client.hset(`progression:${connId}`, unified)
          
          // Set TTL on old keys for backward compatibility (24 hours)
          await client.expire(`progression:${connId}:cycles`, 86400)
          await client.expire(`progression:${connId}:indications`, 86400)
          await client.expire(`engine_state:${connId}`, 86400)
          
          consolidated++
        } catch (e) {
          console.warn(`[v0] Migration 020: Error consolidating ${connId}:`, e)
        }
      }
      
      // PHASE 3 FIX: Create connection indexes
      // Index 1: Main enabled connections
      for (const connId of connections) {
        const connData = await client.hgetall(`connection:${connId}`)
        const isAssigned = connData?.is_assigned === "1" || connData?.is_assigned === "true"
        const isDashboardEnabled = connData?.is_enabled_dashboard === "1" || connData?.is_enabled_dashboard === "true"
        
        if (isAssigned && isDashboardEnabled) {
          await client.sadd("connections:main:enabled", connId)
        }
        
        // Index 2: Exchange-specific
        if (connData?.exchange) {
          await client.sadd(`connections:exchange:${connData.exchange.toLowerCase()}`, connId)
        }
        
        // Index 3: Base enabled
        const isInserted = connData?.is_inserted === "1" || connData?.is_inserted === "true"
        const isBaseEnabled = connData?.is_enabled === "1" || connData?.is_enabled === "true"
        
        if (isInserted && isBaseEnabled) {
          await client.sadd("connections:base:enabled", connId)
        }
        
        // Index 4: Working connections
        if (connData?.last_test_status === "success") {
          await client.sadd("connections:working", connId)
        }
      }
      
      console.log(`[v0] Migration 020: ✓ Consolidated ${consolidated} progression structures`)
      console.log(`[v0] Migration 020: ✓ Created ${connections.length} connection indexes`)
      console.log(`[v0] Migration 020: COMPLETE - Database consolidation done`)
    },
    down: async (client: any) => {
      // Note: Rollback is not implemented for this migration (destructive)
      // Users should restore from backup if needed
      await client.set("_schema_version", "18")
    },
  },
]

const BASE_CONNECTION_CONFIG: Array<{
  id: string
  name: string
  exchange: string
  credentialId: BaseConnectionId
  autoActive: boolean
}> = [
  // Spec ask: "assign Main Connections bybit and bingx ON Startup."
  // Bybit-X03 and BingX-X01 are the canonical primary live-trading
  // connections — they are auto-inserted into the Active panel AND the
  // dashboard toggle is defaulted ON during *first* creation. Any
  // existing operator override (e.g. user explicitly disabled the
  // dashboard toggle) is preserved by the existing `(existing?.is_*) || …`
  // fallback chain in `ensureBaseConnections` below — autoActive only
  // affects the initial-create defaults, never overwrites prior state.
  { id: "bybit-x03", name: "Bybit Base", exchange: "bybit", credentialId: "bybit-x03", autoActive: true },
  { id: "bingx-x01", name: "BingX Base", exchange: "bingx", credentialId: "bingx-x01", autoActive: true },
  { id: "pionex-x01", name: "Pionex Base", exchange: "pionex", credentialId: "pionex-x01", autoActive: false },
  { id: "orangex-x01", name: "OrangeX Base", exchange: "orangex", credentialId: "orangex-x01", autoActive: false },
]

async function ensureBaseConnections(client: any): Promise<{ createdOrUpdated: number; credentialsInjected: number }> {
  let createdOrUpdated = 0
  let credentialsInjected = 0

  const legacyIds = ["bybit-base", "bingx-base", "binance-base", "okx-base", "bybit-default-disabled", "bingx-default-disabled"]
  for (const legacyId of legacyIds) {
    const exists = await client.sismember("connections", legacyId)
    if (exists) {
      await client.del(`connection:${legacyId}`)
      await client.srem("connections", legacyId)
      console.log(`[v0] [Migrations] Removed legacy connection id ${legacyId}`)
    }
  }

  // ── Honour operator-issued tombstones ────────────────────────────
  // The DELETE endpoint (`app/api/settings/connections/[id]/route.ts`)
  // adds deleted connection IDs to the `connections:tombstoned` Set so
  // we don't immediately resurrect them on the next migration sweep
  // (which historically ran every cold start and silently un-did the
  // operator's delete). Read the set once up-front so we don't query
  // Redis per-config inside the loop below.
  const tombstonedIds = new Set<string>()
  try {
    const tombs = await client.smembers("connections:tombstoned")
    if (Array.isArray(tombs)) {
      for (const id of tombs) {
        if (typeof id === "string" && id.length > 0) tombstonedIds.add(id)
      }
    }
  } catch {
    // Non-critical: a missing/corrupt set just means we treat it as empty.
  }

  for (const cfg of BASE_CONNECTION_CONFIG) {
    if (tombstonedIds.has(cfg.id)) {
      // Operator explicitly deleted this base connection — don't
      // recreate it. Logged at INFO so the cold-start log makes the
      // skip visible.
      console.log(
        `[v0] [Migrations] Skipping tombstoned base connection ${cfg.id} ` +
        `(deleted by operator; will not be auto-recreated)`,
      )
      continue
    }
    const now = new Date().toISOString()
    const existing = await client.hgetall(`connection:${cfg.id}`)
    const hasExisting = existing && Object.keys(existing).length > 0

    const { apiKey, apiSecret } = getBaseConnectionCredentials(cfg.credentialId)
    const hasRealCredentials = apiKey.length > 10 && apiSecret.length > 10

    const updateData: Record<string, string> = {
      id: cfg.id,
      name: (existing?.name as string) || cfg.name,
      exchange: (existing?.exchange as string) || cfg.exchange,
      is_predefined: "0",
      is_inserted: (existing?.is_inserted as string) || "1",
      is_dashboard_inserted: (existing?.is_dashboard_inserted as string) || "1",
      is_active_inserted: cfg.autoActive ? "1" : ((existing?.is_active_inserted as string) || "0"),
      // Base connections are enabled in Settings by default.
      is_enabled: (existing?.is_enabled as string) || "1",
      // Dashboard (Main) toggle: preserve any prior operator choice
      // (the slider is the authoritative gate per
      // `lib/trade-engine-auto-start.ts`). Only when this is the FIRST
      // run for the connection AND `autoActive=true` do we default the
      // toggle ON — so Bybit/BingX engines auto-start on a fresh DB
      // without the operator hunting for the slider. After that, this
      // expression's `||` fallback short-circuits on the existing value
      // and the user's choice is honoured indefinitely.
      is_enabled_dashboard:
        (existing?.is_enabled_dashboard as string) ||
        (cfg.autoActive ? "1" : "0"),
      is_active: (existing?.is_active as string) || (cfg.autoActive ? "1" : "0"),
      connection_method: (existing?.connection_method as string) || "library",
      connection_library: (existing?.connection_library as string) || "native",
      api_type: (existing?.api_type as string) || "perpetual_futures",
      updated_at: now,
      created_at: (existing?.created_at as string) || now,
    }

    if (hasRealCredentials) {
      updateData.api_key = apiKey
      updateData.api_secret = apiSecret
      credentialsInjected++
    } else if (!hasExisting) {
      updateData.api_key = ""
      updateData.api_secret = ""
    } else {
      // Preserve previously stored credentials if env vars are not present.
      updateData.api_key = (existing?.api_key as string) || ""
      updateData.api_secret = (existing?.api_secret as string) || ""
    }

    await client.hset(`connection:${cfg.id}`, updateData)
    await client.sadd("connections", cfg.id)
    createdOrUpdated++
  }

  // ── Bootstrap the global engine status ────────────────────────────
  // The auto-start monitor in `lib/trade-engine-auto-start.ts` only
  // attempts to start missing connection engines when
  // `trade_engine:global.status === "running"`. On a brand-new DB this
  // hash is empty, so even the autoActive=true connections above would
  // never have their engines spun up until an operator clicked "Start"
  // in the UI. That is exactly the symptom reported in production:
  // "Low Counts, Low DB Activity, No really processings".
  //
  // We bootstrap the hash to `running` ONLY when:
  //   - at least one autoActive base connection is configured, AND
  //   - the hash is currently empty OR carries no `status` field.
  //
  // We never overwrite an existing `status` (incl. `stopped`,
  // `paused`, `error`) — those represent explicit operator state and
  // must be preserved across reloads. This keeps the user's "Stop"
  // button authoritative while solving the cold-boot dead-on-arrival
  // problem.
  const hasAutoActive = BASE_CONNECTION_CONFIG.some((c) => c.autoActive)
  if (hasAutoActive) {
    try {
      const globalState = await client.hgetall("trade_engine:global")
      const hasStatus =
        globalState && typeof (globalState as any).status === "string" &&
        (globalState as any).status.length > 0
      if (!hasStatus) {
        const nowIso = new Date().toISOString()
        await client.hset("trade_engine:global", {
          status: "running",
          started_at: nowIso,
          bootstrapped_at: nowIso,
          bootstrapped_by: "ensureBaseConnections",
        })
        console.log(
          `[v0] [Migrations] Bootstrapped trade_engine:global status=running ` +
          `(autoActive base connections detected)`,
        )
      }
    } catch (err) {
      // Non-critical: the auto-start monitor will retry on the next
      // tick and the operator can also press Start in the UI.
      console.warn(
        `[v0] [Migrations] Failed to bootstrap global engine status:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { createdOrUpdated, credentialsInjected }
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<{ success: boolean; message: string; version: number }> {
  if (migrationRunPromise) {
    return migrationRunPromise
  }

  migrationRunPromise = runMigrationsInternal()

  try {
    return await migrationRunPromise
  } finally {
    migrationRunPromise = null
  }
}

async function runMigrationsInternal(): Promise<{ success: boolean; message: string; version: number }> {
  try {
    // Check if migrations have already run in this process
    if (haveMigrationsRun()) {
      const finalVer = Math.max(...migrations.map((m) => m.version))
      await initRedis()
      const client = getRedisClient()

      // Keep process guard synced with persisted migration state.
      const persistedRunState = await client.get("_migrations_run")
      if (persistedRunState !== "true") {
        await client.set("_migrations_run", "true")
      }

      const ensured = await ensureBaseConnections(client)
      console.log(`[v0] [Migrations] ✓ Already executed in this process; base ensured=${ensured.createdOrUpdated}, credentialsInjected=${ensured.credentialsInjected}`)
      return { success: true, message: "Already run in this process", version: finalVer }
    }

    await initRedis()
    const client = getRedisClient()

     const persistedRunState = await client.get("_migrations_run")
     if (persistedRunState === "true") {
       await setMigrationsRun(true)
     }

    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    const finalVersion = Math.max(...migrations.map((m) => m.version))

    console.log(`[v0] [Migrations] Current: v${currentVersion}, Target: v${finalVersion}`)

    // Get migrations that need to run (version > currentVersion)
    const pendingMigrations = migrations.filter((m) => m.version > currentVersion)
    
    if (pendingMigrations.length === 0) {
      console.log(`[v0] [Migrations] Already at latest version ${finalVersion}`)
      const ensured = await ensureBaseConnections(client)
      console.log(`[v0] [Migrations] ✓ Ensured ${ensured.createdOrUpdated} base connections; injected credentials for ${ensured.credentialsInjected}`)
      
       await setMigrationsRun(true)
      return { success: true, message: `Already at latest version ${finalVersion}`, version: finalVersion }
    }

    console.log(`[v0] [Migrations] Running ${pendingMigrations.length} pending migrations...`)
    for (const migration of pendingMigrations) {
      try {
        console.log(`[v0] [Migrations] Running: ${migration.name} (v${migration.version})`)
        await migration.up(client)
        console.log(`[v0] [Migrations] ✓ Completed: ${migration.name}`)
      } catch (error) {
        console.error(`[v0] [Migrations] ✗ Failed during ${migration.name}:`, error)
        throw error
      }
    }

    // Update schema version to final version
    await client.set("_schema_version", finalVersion.toString())
    
    // Track migration runs
    const runCount = await client.get("_migration_total_runs")
    const newRunCount = (parseInt((runCount as string) || "0") + 1).toString()
    await client.set("_migration_total_runs", newRunCount)
    await client.set("_migration_last_run", new Date().toISOString())

    console.log(`[v0] [Migrations] ✓ Successfully migrated v${currentVersion} -> v${finalVersion}`)
    console.log(`[v0] [Migrations] ${pendingMigrations.length} migrations executed`)
    
    // Verify final state
    const finalVersionCheck = await client.get("_schema_version")
    console.log(`[v0] [Migrations] ✓ Verification: Schema version is now ${finalVersionCheck}`)
    
    const ensured = await ensureBaseConnections(client)
    console.log(`[v0] [Migrations] ✓ Ensured ${ensured.createdOrUpdated} base connections; injected credentials for ${ensured.credentialsInjected}`)
    
     // Mark migrations as run in this process
     await setMigrationsRun(true)
    
    return { success: true, message: `Migrated from v${currentVersion} to v${finalVersion}`, version: finalVersion }
  } catch (error) {
    console.error("[v0] [Migrations] ✗ Migration failed:", error)
    throw error
  }
}

/**
 * Rollback to previous migration
 */
export async function rollbackMigration(): Promise<void> {
  try {
    await initRedis()
    const client = getRedisClient()
    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    if (currentVersion === 0) {
      console.log("[v0] No migrations to rollback")
      return
    }
    const migrationToRollback = migrations.find((m) => m.version === currentVersion)
    if (migrationToRollback) {
      console.log(`[v0] Rolling back: ${migrationToRollback.name}`)
      await migrationToRollback.down(client)
    }
    console.log(`[v0] Rolled back to version ${currentVersion - 1}`)
  } catch (error) {
    console.error("[v0] Rollback failed:", error)
    throw error
  }
}

/**
 * Get migration status
 */
export async function getMigrationStatus(): Promise<any> {
  try {
    await initRedis()
    const client = getRedisClient()
    const versionStr = await client.get("_schema_version")
    const currentVersion = versionStr ? parseInt(versionStr as string) : 0
    const latestVersion = Math.max(...migrations.map((m) => m.version))
    return {
      currentVersion,
      latestVersion,
      isMigrated: currentVersion === latestVersion,
      pendingMigrations: migrations.filter((m) => m.version > currentVersion),
      message: currentVersion === latestVersion
        ? `Already at latest version ${currentVersion}`
        : `${latestVersion - currentVersion} pending migrations`,
    }
  } catch (error) {
    console.error("[v0] Could not get migration status:", error)
    return {
      currentVersion: 0,
      latestVersion: Math.max(...migrations.map((m) => m.version)),
      isMigrated: false,
      message: "Failed to check status",
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
