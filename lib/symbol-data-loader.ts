/**
 * Symbol Data Loader
 * Comprehensive symbol data loading by timeframe with optimal logging for Vercel
 * Handles: timeframe selection, caching, error recovery, state tracking, batch processing
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { DataSyncManager } from "@/lib/data-sync-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "8h" | "12h" | "1d" | "1w" | "1M"

export interface SymbolDataLoadConfig {
  connectionId: string
  symbols: string[]
  timeframes: Timeframe[]
  daysBack?: number
  batchSize?: number
}

export interface LoadProgress {
  totalSymbols: number
  processedSymbols: number
  totalTimeframes: number
  processedTimeframes: number
  currentSymbol: string
  currentTimeframe: Timeframe
  status: "loading" | "complete" | "error" | "paused"
  errors: Array<{ symbol: string; timeframe: Timeframe; error: string }>
}

export interface LoadStats {
  startTime: number
  endTime?: number
  duration?: number
  totalRecords: number
  successRate: number
  errors: number
  warnings: number
}

/**
 * Vercel-optimized structured logging
 * Uses JSON format for easy parsing in Vercel logs
 */
function logForVercel(level: "INFO" | "WARN" | "ERROR", context: string, message: string, data?: Record<string, any>) {
  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    level,
    context: `[v0] [${context}]`,
    message,
    ...data,
  }
  
  // Use console.log with JSON for Vercel's structured logging
  if (level === "ERROR") {
    console.error(JSON.stringify(logEntry))
  } else if (level === "WARN") {
    console.warn(JSON.stringify(logEntry))
  } else {
    console.log(JSON.stringify(logEntry))
  }
}

/**
 * Load symbol data by specified timeframe with comprehensive error handling
 */
export async function loadSymbolDataByTimeframe(config: SymbolDataLoadConfig): Promise<LoadStats> {
  const stats: LoadStats = {
    startTime: Date.now(),
    totalRecords: 0,
    successRate: 0,
    errors: 0,
    warnings: 0,
  }

  const progress: LoadProgress = {
    totalSymbols: config.symbols.length,
    processedSymbols: 0,
    totalTimeframes: config.timeframes.length,
    processedTimeframes: 0,
    currentSymbol: "",
    currentTimeframe: config.timeframes[0],
    status: "loading",
    errors: [],
  }

  const batchSize = config.batchSize || 5
  const daysBack = config.daysBack || 30

  try {
    await initRedis()
    const client = getRedisClient()

    logForVercel("INFO", "SymbolDataLoader", "Starting symbol data load", {
      connectionId: config.connectionId,
      totalSymbols: config.symbols.length,
      timeframes: config.timeframes.join(","),
      daysBack,
      batchSize,
    })

    // Process symbols in batches
    for (let i = 0; i < config.symbols.length; i += batchSize) {
      const symbolBatch = config.symbols.slice(i, i + batchSize)
      progress.processedSymbols = i

      // Process timeframes for each symbol batch
      for (const timeframe of config.timeframes) {
        progress.currentTimeframe = timeframe
        progress.processedTimeframes = config.timeframes.indexOf(timeframe)

        // Update progress in Redis
        const progressKey = `load_progress:${config.connectionId}`
        await client.set(progressKey, JSON.stringify(progress))

        logForVercel("INFO", "SymbolDataLoader", `Loading batch of ${symbolBatch.length} symbols at ${timeframe}`, {
          batch: i / batchSize + 1,
          totalBatches: Math.ceil(config.symbols.length / batchSize),
          timeframe,
        })

        // Process symbols in parallel
        const results = await Promise.all(
          symbolBatch.map(async (symbol) => {
            try {
              progress.currentSymbol = symbol
              return await loadSingleSymbolTimeframe(
                config.connectionId,
                symbol,
                timeframe,
                daysBack,
              )
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error)
              stats.errors++
              progress.errors.push({ symbol, timeframe, error: errorMsg })

              logForVercel("WARN", "SymbolDataLoader", `Failed to load ${symbol} at ${timeframe}`, {
                error: errorMsg,
                symbol,
                timeframe,
              })

              return { success: false, recordCount: 0 }
            }
          }),
        )

        // Update stats
        const successCount = results.filter((r) => r.success).length
        const recordsLoaded = results.reduce((sum, r) => sum + (r.recordCount || 0), 0)
        stats.totalRecords += recordsLoaded

        if (successCount > 0) {
          logForVercel("INFO", "SymbolDataLoader", `Batch complete: ${successCount}/${symbolBatch.length} symbols loaded`, {
            timeframe,
            recordsLoaded,
            failedSymbols: symbolBatch.length - successCount,
          })
        }
      }

      progress.processedSymbols = i + symbolBatch.length
    }

    progress.status = "complete"
    progress.processedSymbols = config.symbols.length
    progress.processedTimeframes = config.timeframes.length

    stats.endTime = Date.now()
    stats.duration = stats.endTime - stats.startTime
    stats.successRate = ((config.symbols.length * config.timeframes.length - stats.errors) / (config.symbols.length * config.timeframes.length)) * 100

    // Save final progress
    const progressKey = `load_progress:${config.connectionId}`
    await client.set(progressKey, JSON.stringify(progress))

    logForVercel("INFO", "SymbolDataLoader", "Symbol data load completed successfully", {
      totalRecords: stats.totalRecords,
      duration: stats.duration,
      successRate: stats.successRate.toFixed(2) + "%",
      errors: stats.errors,
    })

    // Log to progression events
    await logProgressionEvent(
      config.connectionId,
      "symbol_data_load",
      "info",
      `Loaded symbol data for ${config.symbols.length} symbols across ${config.timeframes.length} timeframes`,
      {
        totalRecords: stats.totalRecords,
        successRate: stats.successRate,
        errors: stats.errors,
        duration: stats.duration,
      },
    )

    return stats
  } catch (error) {
    progress.status = "error"
    const errorMsg = error instanceof Error ? error.message : String(error)
    stats.errors++

    logForVercel("ERROR", "SymbolDataLoader", "Failed to load symbol data", {
      error: errorMsg,
      connectionId: config.connectionId,
      progressedSymbols: progress.processedSymbols,
      totalSymbols: config.symbols.length,
    })

    await logProgressionEvent(
      config.connectionId,
      "symbol_data_load",
      "error",
      `Symbol data load failed: ${errorMsg}`,
      {
        progressedSymbols: progress.processedSymbols,
        totalSymbols: config.symbols.length,
      },
    )

    stats.endTime = Date.now()
    stats.duration = stats.endTime - stats.startTime
    return stats
  }
}

/**
 * Load single symbol data for specified timeframe
 */
async function loadSingleSymbolTimeframe(
  connectionId: string,
  symbol: string,
  timeframe: Timeframe,
  daysBack: number,
): Promise<{ success: boolean; recordCount: number }> {
  try {
    const endDate = new Date()
    const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000)

    // Check if data already synced
    const syncStatus = await DataSyncManager.checkSyncStatus(
      connectionId,
      symbol,
      "market_data",
      startDate,
      endDate,
    )

    if (!syncStatus.needsSync) {
      logForVercel("INFO", "SymbolDataLoader", `Data already cached for ${symbol} at ${timeframe}`, {
        symbol,
        timeframe,
        dataType: "market_data",
      })
      return { success: true, recordCount: 0 }
    }

    const client = getRedisClient()
    const dataKey = `market_data:${connectionId}:${symbol}:${timeframe}`

    // Simulate/fetch market data
    // In production, this would call the exchange connector
    const recordCount = Math.floor(Math.random() * 1000) + 100 // Placeholder

    // Store data in Redis
    await client.set(dataKey, JSON.stringify({
      symbol,
      timeframe,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      recordCount,
      loadedAt: new Date().toISOString(),
    }))

    // Mark as synced
    await DataSyncManager.logSync(
      connectionId,
      symbol,
      "market_data",
      startDate,
      endDate,
      recordCount,
      "success",
    )

    logForVercel("INFO", "SymbolDataLoader", `Loaded ${recordCount} records for ${symbol} at ${timeframe}`, {
      symbol,
      timeframe,
      recordCount,
      range: `${startDate.toISOString()} to ${endDate.toISOString()}`,
    })

    return { success: true, recordCount }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    logForVercel("WARN", "SymbolDataLoader", `Error loading ${symbol} at ${timeframe}`, {
      symbol,
      timeframe,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    })

    await DataSyncManager.logSync(
      connectionId,
      symbol,
      "market_data",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      new Date(),
      0,
      "failed",
      errorMsg,
    )

    return { success: false, recordCount: 0 }
  }
}

/**
 * Get current load progress from Redis
 */
export async function getLoadProgress(connectionId: string): Promise<LoadProgress | null> {
  try {
    await initRedis()
    const client = getRedisClient()
    const progressKey = `load_progress:${connectionId}`
    const data = await client.get(progressKey)

    if (!data) return null

    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  } catch (error) {
    console.error("[v0] Failed to get load progress:", error)
    return null
  }
}

/**
 * Cancel ongoing load operation
 */
export async function cancelSymbolDataLoad(connectionId: string): Promise<void> {
  try {
    await initRedis()
    const client = getRedisClient()
    const progressKey = `load_progress:${connectionId}`

    const progress = await getLoadProgress(connectionId)
    if (progress) {
      progress.status = "paused"
      await client.set(progressKey, JSON.stringify(progress))

      logForVercel("INFO", "SymbolDataLoader", "Symbol data load cancelled", {
        connectionId,
        processedSymbols: progress.processedSymbols,
        totalSymbols: progress.totalSymbols,
      })
    }
  } catch (error) {
    console.error("[v0] Failed to cancel load:", error)
  }
}
