/**
 * Connection-specific settings management
 * Each connection has its own isolated settings configuration
 * Defaults are applied when connection is first used
 */

import { getRedisClient } from "./redis-db"

export interface ConnectionSettings {
  connectionId: string
  
  // Strategy settings
  strategy: {
    takeProfit: number
    stopLoss: number
    leverage: number
    volumeMultiplier: number
  }
  
  // Indication settings
  indication: {
    mainType: string
    commonType: string
    autoType: string
    optimalType: string
  }
  
  // Trading settings
  trading: {
    maxPositions: number
    riskPerTrade: number
    dailyLossLimit: number
    autoStopAfterLoss: boolean
  }
  
  // Advanced settings
  advanced: {
    slippageTolerance: number
    executionSpeed: "fast" | "normal" | "slow"
    useTrailingStop: boolean
    enableAutoExit: boolean
  }
}

const DEFAULT_SETTINGS: Omit<ConnectionSettings, "connectionId"> = {
  strategy: {
    takeProfit: 8,
    stopLoss: 0.5,
    leverage: 5,
    volumeMultiplier: 1,
  },
  indication: {
    mainType: "Direction",
    commonType: "Momentum",
    autoType: "Volatility",
    optimalType: "Mean Reversion",
  },
  trading: {
    maxPositions: 10,
    riskPerTrade: 2,
    dailyLossLimit: 5,
    autoStopAfterLoss: true,
  },
  advanced: {
    slippageTolerance: 0.1,
    executionSpeed: "normal",
    useTrailingStop: true,
    enableAutoExit: false,
  },
}

/**
 * Get settings for a specific connection
 * Returns defaults if connection settings don't exist
 */
export async function getConnectionSettings(connectionId: string): Promise<ConnectionSettings> {
  try {
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    
    const existing = await client.get(key)
    if (existing) {
      return JSON.parse(existing)
    }

    // Initialize with defaults for this connection
    const newSettings: ConnectionSettings = {
      connectionId,
      ...DEFAULT_SETTINGS,
    }
    
    await client.set(key, JSON.stringify(newSettings))
    return newSettings
  } catch (error) {
    console.error(`Failed to get connection settings for ${connectionId}:`, error)
    return {
      connectionId,
      ...DEFAULT_SETTINGS,
    }
  }
}

/**
 * Update settings for a specific connection
 */
export async function updateConnectionSettings(
  connectionId: string,
  settings: Partial<ConnectionSettings>
): Promise<ConnectionSettings> {
  try {
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    
    // Get current settings
    const current = await getConnectionSettings(connectionId)
    
    // Merge with updates
    const updated: ConnectionSettings = {
      ...current,
      ...settings,
      connectionId, // Ensure connectionId stays correct
    }
    
    // Save to Redis
    await client.set(key, JSON.stringify(updated))
    
    return updated
  } catch (error) {
    console.error(`Failed to update connection settings for ${connectionId}:`, error)
    throw error
  }
}

/**
 * Get strategy-specific settings for a connection
 */
export async function getConnectionStrategySettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.strategy
}

/**
 * Get indication-specific settings for a connection
 */
export async function getConnectionIndicationSettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.indication
}

/**
 * Get trading-specific settings for a connection
 */
export async function getConnectionTradingSettings(connectionId: string) {
  const settings = await getConnectionSettings(connectionId)
  return settings.trading
}

/**
 * Reset connection settings to defaults
 */
export async function resetConnectionSettings(connectionId: string): Promise<ConnectionSettings> {
  const newSettings: ConnectionSettings = {
    connectionId,
    ...DEFAULT_SETTINGS,
  }
  
  try {
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    await client.set(key, JSON.stringify(newSettings))
  } catch (error) {
    console.error(`Failed to reset connection settings for ${connectionId}:`, error)
  }
  
  return newSettings
}

/**
 * Delete all settings for a connection
 */
export async function deleteConnectionSettings(connectionId: string): Promise<void> {
  try {
    const client = await getRedisClient()
    const key = `settings:connection:${connectionId}`
    await client.del(key)
  } catch (error) {
    console.error(`Failed to delete connection settings for ${connectionId}:`, error)
    throw error
  }
}

/**
 * Validate connection settings
 */
export function validateConnectionSettings(settings: Partial<ConnectionSettings>): boolean {
  if (settings.strategy) {
    if (settings.strategy.takeProfit <= 0 || settings.strategy.stopLoss <= 0 || settings.strategy.leverage <= 0) {
      return false
    }
  }
  
  if (settings.trading) {
    if (settings.trading.maxPositions <= 0 || settings.trading.riskPerTrade <= 0) {
      return false
    }
  }
  
  if (settings.advanced) {
    if (settings.advanced.slippageTolerance < 0 || settings.advanced.slippageTolerance > 1) {
      return false
    }
  }
  
  return true
}
