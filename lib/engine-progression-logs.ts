/**
 * Engine Progression Logs - Stores detailed logs of all engine operations
 * Uses simple Redis lists (not sorted sets) for compatibility with Upstash
 */

import { getRedisClient } from "@/lib/redis-db"

export interface ProgressionLogEntry {
  timestamp: string
  level: "info" | "warning" | "error" | "debug"
  phase: string
  message: string
  details?: Record<string, any>
  connectionId: string
}

const LOG_RETENTION_HOURS = 24
const MAX_LOGS_PER_CONNECTION = 500

// In-memory buffer for batch logging (reduces Redis writes significantly)
const logBuffer: Map<string, string[]> = new Map()
const BUFFER_FLUSH_SIZE = 10 // Flush every 10 logs (reduced for more responsive logging)
const BUFFER_FLUSH_INTERVAL = 3000 // Or every 3 seconds (reduced for more responsive logging)
let flushTimerStarted = false
let flushTimer: NodeJS.Timeout | null = null

// Important phases that should flush immediately
const IMMEDIATE_FLUSH_PHASES = [
  "initializing", "prehistoric_data", "indications", "strategies", 
  "realtime", "live_trading", "error", "engine_started", "engine_stopped",
  "engine_starting", "engine_error", "quickstart"
]

/**
 * Log a progression event for a connection
 * OPTIMIZED: Uses in-memory buffering with immediate flush for important events
 */
export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error" | "debug",
  message: string,
  details?: Record<string, any>
): Promise<void> {
  try {
    const timestamp = new Date().toISOString()
    const logKey = `engine_logs:${connectionId}`
    
    // Format: "timestamp|level|phase|message|details_json"
    const logEntry = `${timestamp}|${level}|${phase}|${message}|${JSON.stringify(details || {})}`
    
    // Add to buffer instead of writing immediately
    if (!logBuffer.has(logKey)) {
      logBuffer.set(logKey, [])
    }
    const buffer = logBuffer.get(logKey)!
    buffer.push(logEntry)
    
    // Start flush timer if not started
    if (!flushTimerStarted) {
      flushTimerStarted = true
      flushTimer = setInterval(flushAllLogBuffers, BUFFER_FLUSH_INTERVAL)
      // Avoid preventing process exit in scripts/tests.
      flushTimer.unref?.()
    }
    
    // Immediate flush for important phases or errors
    const isImportant = IMMEDIATE_FLUSH_PHASES.some(p => phase.includes(p)) || level === "error" || level === "warning"
    if (isImportant || buffer.length >= BUFFER_FLUSH_SIZE) {
      await flushLogBuffer(logKey)
    }

    // Console log for important events (info for important phases, always for errors/warnings)
    if (level === "error" || level === "warning" || isImportant) {
      console.log(`[v0] [${level.toUpperCase()}] [${phase}] ${message}`, details ? JSON.stringify(details).slice(0, 200) : "")
    }
  } catch (error) {
    // Silent fail - logging should never block main operations
    console.error("[v0] [LogError] Failed to log:", error)
  }
}

/**
 * Flush log buffer for a specific key
 */
async function flushLogBuffer(logKey: string): Promise<void> {
  const buffer = logBuffer.get(logKey)
  if (!buffer || buffer.length === 0) return
  
  // Copy and clear buffer immediately to prevent duplicate writes
  const toFlush = [...buffer]
  logBuffer.set(logKey, [])
  
  try {
    const client = getRedisClient()
    
    // Use lpush for efficient prepend (native Redis list operation)
    await client.lpush(logKey, ...toFlush.reverse())
    
    // Trim to max size
    await client.ltrim(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
  } catch (error) {
    // Put entries back if flush failed
    const currentBuffer = logBuffer.get(logKey) || []
    logBuffer.set(logKey, [...toFlush, ...currentBuffer])
  }
}

/**
 * Flush all log buffers
 */
export async function flushAllLogBuffers(): Promise<void> {
  const keys = Array.from(logBuffer.keys())
  await Promise.all(keys.map(key => flushLogBuffer(key).catch(() => {})))
}

/**
 * Force flush logs for a specific connection
 */
export async function forceFlushLogs(connectionId: string): Promise<void> {
  const logKey = `engine_logs:${connectionId}`
  await flushLogBuffer(logKey)
}

/**
 * Get all progression logs for a connection
 * OPTIMIZED: Uses native Redis list operations and forces flush first
 */
export async function getProgressionLogs(connectionId: string): Promise<ProgressionLogEntry[]> {
  try {
    // Force flush all pending logs first to ensure we get the latest entries
    await flushAllLogBuffers()
    
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`

    // Use lrange for efficient list retrieval
    const logs = await client.lrange(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
    if (!logs || logs.length === 0) return []

    // Parse each log entry from "timestamp|level|phase|message|details_json"
    return logs
      .map((entry) => {
        try {
          const parts = entry.split("|")
          if (parts.length < 4) return null
          
          const [timestamp, level, phase, message, ...detailsParts] = parts
          const detailsJson = detailsParts.join("|") // Rejoin in case details contained |
          let details: Record<string, any> = {}
          try {
            details = JSON.parse(detailsJson || "{}")
          } catch {
            details = {}
          }
          
          return {
            timestamp,
            level: (level as any) || "info",
            phase,
            message,
            details,
            connectionId,
          } as ProgressionLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is ProgressionLogEntry => entry !== null)
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to retrieve logs:", error instanceof Error ? error.message : String(error))
    return []
  }
}

/**
 * Clear logs for a connection
 */
export async function clearProgressionLogs(connectionId: string): Promise<void> {
  try {
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`
    await client.del(logKey)
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to clear logs:", error instanceof Error ? error.message : String(error))
  }
}

/**
 * Format logs for display
 */
export function formatLogsForDisplay(logs: ProgressionLogEntry[]): string {
  if (logs.length === 0) {
    return "No logs yet. Enable the connection to start logging."
  }

  return logs
    .map((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString()
      const level = log.level.toUpperCase().padEnd(7)
      const details = log.details && Object.keys(log.details).length > 0 ? ` | ${JSON.stringify(log.details)}` : ""
      return `[${time}] ${level} | ${log.phase.padEnd(20)} | ${log.message}${details}`
    })
    .join("\n")
}
