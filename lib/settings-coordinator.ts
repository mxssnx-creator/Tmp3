import { initRedis, getSettings, setSettings, getConnection } from "@/lib/redis-db"

/**
 * Settings Coordinator
 * 
 * Manages the propagation of settings changes to running engines.
 * When a connection's settings are updated, this module:
 * 1. Writes a change event to Redis so engines know to reload
 * 2. Determines if the change requires an engine restart vs hot reload
 * 3. Provides a polling mechanism for engines to detect changes
 */

// Fields that require a full engine restart when changed
const RESTART_REQUIRED_FIELDS = [
  "api_key", "api_secret", "exchange", "is_testnet",
  "api_type", "api_subtype", "is_enabled",
]

// Fields that can be hot-reloaded without restart
const HOT_RELOAD_FIELDS = [
  "name", "volume_factor", "margin_type", "position_mode",
  "connection_settings", "strategies", "indications",
  "active_indications", "preset_type",
]

export type ChangeType = "restart" | "reload" | "cosmetic"

export interface SettingsChangeEvent {
  connectionId: string
  changedFields: string[]
  changeType: ChangeType
  timestamp: string
  previousValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
}

/**
 * Determine the type of change based on which fields were modified
 */
export function classifyChange(changedFields: string[]): ChangeType {
  if (changedFields.some(f => RESTART_REQUIRED_FIELDS.includes(f))) {
    return "restart"
  }
  if (changedFields.some(f => HOT_RELOAD_FIELDS.includes(f))) {
    return "reload"
  }
  return "cosmetic"
}

/**
 * Notify the system that a connection's settings have changed.
 * Writes a change event to Redis that running engines can detect.
 */
export async function notifySettingsChanged(
  connectionId: string,
  changedFields: string[],
  previousValues?: Record<string, unknown>,
  newValues?: Record<string, unknown>
): Promise<SettingsChangeEvent> {
  await initRedis()
  
  const changeType = classifyChange(changedFields)
  const event: SettingsChangeEvent = {
    connectionId,
    changedFields,
    changeType,
    timestamp: new Date().toISOString(),
    previousValues,
    newValues,
  }

  // Write the change event so running engines can detect it
  await setSettings(`settings_change:${connectionId}`, event)
  
  // Increment a global change counter for this connection
  const counter = await getSettings(`settings_change_counter:${connectionId}`)
  const newCounter = (Number(counter) || 0) + 1
  await setSettings(`settings_change_counter:${connectionId}`, String(newCounter))

  console.log(`[v0] [SettingsCoordinator] Change event for ${connectionId}: type=${changeType}, fields=[${changedFields.join(",")}]`)

  // If restart required, update engine state to signal restart needed
  if (changeType === "restart") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      await setSettings(`trade_engine_state:${connectionId}`, {
        ...engineState,
        restart_required: true,
        restart_reason: `Settings changed: ${changedFields.join(", ")}`,
        restart_requested_at: new Date().toISOString(),
      })
      console.log(`[v0] [SettingsCoordinator] Engine restart flagged for ${connectionId}`)
    }
  }

  // If hot-reload, update engine state to signal reload needed
  if (changeType === "reload") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      await setSettings(`trade_engine_state:${connectionId}`, {
        ...engineState,
        reload_required: true,
        reload_fields: changedFields,
        reload_requested_at: new Date().toISOString(),
      })
      console.log(`[v0] [SettingsCoordinator] Engine hot-reload flagged for ${connectionId}`)
    }
  }

  return event
}

/**
 * Check if a connection has pending settings changes that the engine hasn't processed yet.
 */
export async function getPendingChanges(connectionId: string): Promise<SettingsChangeEvent | null> {
  await initRedis()
  const event = await getSettings(`settings_change:${connectionId}`)
  return event as SettingsChangeEvent | null
}

/**
 * Clear pending changes after the engine has processed them.
 */
export async function clearPendingChanges(connectionId: string): Promise<void> {
  await initRedis()
  await setSettings(`settings_change:${connectionId}`, null)
  
  // Also clear restart/reload flags from engine state
  const engineState = await getSettings(`trade_engine_state:${connectionId}`)
  if (engineState) {
    const cleaned = { ...engineState }
    delete cleaned.restart_required
    delete cleaned.restart_reason
    delete cleaned.restart_requested_at
    delete cleaned.reload_required
    delete cleaned.reload_fields
    delete cleaned.reload_requested_at
    await setSettings(`trade_engine_state:${connectionId}`, cleaned)
  }
}

/**
 * Get the change counter for a connection (engines can poll this).
 */
export async function getChangeCounter(connectionId: string): Promise<number> {
  await initRedis()
  const counter = await getSettings(`settings_change_counter:${connectionId}`)
  return Number(counter) || 0
}

/**
 * Compute which fields changed between two connection objects.
 */
export function detectChangedFields(
  previous: Record<string, unknown>,
  updated: Record<string, unknown>
): string[] {
  const changed: string[] = []
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(updated)])
  
  for (const key of allKeys) {
    if (key === "updated_at" || key === "created_at") continue
    const prevVal = JSON.stringify(previous[key])
    const newVal = JSON.stringify(updated[key])
    if (prevVal !== newVal) {
      changed.push(key)
    }
  }
  
  return changed
}
