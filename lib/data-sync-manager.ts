/**
 * Data Sync Manager
 * Manages data synchronization to avoid recalculating existing data
 * NOW: Redis-based, no SQL
 */

import { getSettings, setSettings } from "@/lib/redis-db"

interface SyncRange {
  start: Date
  end: Date
}

interface SyncStatus {
  needsSync: boolean
  missingRanges: SyncRange[]
  lastSyncEnd?: Date
}

export class DataSyncManager {
  /**
   * Check if data needs to be synced for a connection and symbol
   */
  static async checkSyncStatus(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    requestedStart: Date,
    requestedEnd: Date,
  ): Promise<SyncStatus> {
    try {
      // Get sync status from Redis
      const syncKey = `sync_status:${connectionId}:${symbol}:${dataType}`
      const syncData = (await getSettings(syncKey)) || { lastSyncEnd: null }

      // If no previous sync, all data is missing
      if (!syncData.lastSyncEnd) {
        return {
          needsSync: true,
          missingRanges: [{ start: requestedStart, end: requestedEnd }],
        }
      }

      const lastSyncDate = new Date(syncData.lastSyncEnd)

      // If requested data is after last sync, need to sync new range
      if (requestedEnd > lastSyncDate) {
        return {
          needsSync: true,
          missingRanges: [{ start: lastSyncDate, end: requestedEnd }],
          lastSyncEnd: lastSyncDate,
        }
      }

      // All requested data already synced
      return {
        needsSync: false,
        missingRanges: [],
        lastSyncEnd: lastSyncDate,
      }
    } catch (error) {
      console.error("[v0] Error checking sync status:", error)
      // Default to syncing if there's an error
      return {
        needsSync: true,
        missingRanges: [{ start: requestedStart, end: requestedEnd }],
      }
    }
  }

  /**
   * Mark data as synced
   */
  static async markSynced(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    syncEnd: Date,
  ): Promise<void> {
    try {
      const syncKey = `sync_status:${connectionId}:${symbol}:${dataType}`
      await setSettings(syncKey, {
        lastSyncEnd: syncEnd.toISOString(),
        updatedAt: new Date().toISOString(),
      })
      console.log(`[v0] Marked ${dataType} as synced for ${symbol} until ${syncEnd.toISOString()}`)
    } catch (error) {
      console.error("[v0] Error marking data as synced:", error)
    }
  }

  /**
   * Log a sync operation (Redis-based)
   */
  static async logSync(
    connectionId: string,
    symbol: string,
    dataType: "market_data" | "indication" | "position",
    syncStart: Date,
    syncEnd: Date,
    recordsSynced: number,
    status: "success" | "partial" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    try {
      const logKey = `sync_log:${connectionId}`
      const logs = ((await getSettings(logKey)) as any[] | null) || []

      logs.push({
        symbol,
        dataType,
        syncStart: syncStart.toISOString(),
        syncEnd: syncEnd.toISOString(),
        recordsSynced,
        status,
        errorMessage: errorMessage || null,
        timestamp: new Date().toISOString(),
      })

      // Keep only last 100 sync logs per connection
      const trimmed = logs.slice(-100)
      await setSettings(logKey, trimmed)

      if (status === "success") {
        await DataSyncManager.markSynced(connectionId, symbol, dataType, syncEnd)
      }
    } catch (error) {
      console.error("[v0] Failed to log sync:", error)
    }
  }

  /**
   * Validate connection exists (Redis-based)
   */
  static async validateConnection(connectionId: string): Promise<boolean> {
    try {
      const connections = ((await getSettings("connections")) as any[] | null) || []
      return connections.some((c: any) => c.id === connectionId)
    } catch (error) {
      console.error("[v0] Failed to validate connection:", error)
      return false
    }
  }

  /**
   * Get sync statistics for a connection (Redis-based)
   */
  static async getSyncStats(connectionId: string) {
    try {
      const logKey = `sync_log:${connectionId}`
      const logs = ((await getSettings(logKey)) as any[] | null) || []

      const statsByType: Record<string, any> = {}
      for (const log of logs) {
        if (!statsByType[log.dataType]) {
          statsByType[log.dataType] = {
            data_type: log.dataType,
            total_syncs: 0,
            successful_syncs: 0,
            total_records: 0,
            last_sync: null,
          }
        }
        const s = statsByType[log.dataType]
        s.total_syncs++
        if (log.status === "success") s.successful_syncs++
        s.total_records += log.recordsSynced || 0
        if (!s.last_sync || log.syncEnd > s.last_sync) {
          s.last_sync = log.syncEnd
        }
      }

      return Object.values(statsByType)
    } catch (error) {
      console.error("[v0] Failed to get sync stats:", error)
      return []
    }
  }
}
