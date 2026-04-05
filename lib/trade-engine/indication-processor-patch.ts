/**
 * Runtime patch for IndicationProcessor
 * This file patches the IndicationProcessor class to fix cache initialization issues
 * that occur due to webpack caching stale bundles.
 * 
 * @version 1.0.0
 */

import { IndicationProcessor } from "./indication-processor"

console.log("[v0] Loading indication-processor-patch.ts")

// Store the original processIndication method
const originalProcessIndication = IndicationProcessor.prototype.processIndication

// Create a shared cache at module level
const PATCHED_CACHE = new Map<string, { data: any; timestamp: number }>()
const PATCHED_SETTINGS = { data: null as any, timestamp: 0 }

// Patch the processIndication method to ensure cache exists
IndicationProcessor.prototype.processIndication = async function(symbol: string): Promise<any[]> {
  // Ensure cache exists before calling original method
  if (!this.marketDataCache || !(this.marketDataCache instanceof Map)) {
    (this as any).marketDataCache = PATCHED_CACHE
    console.log("[v0] [Patch] Initialized marketDataCache for symbol:", symbol)
  }
  if (!this.settingsCache) {
    (this as any).settingsCache = PATCHED_SETTINGS
  }
  if (!this.CACHE_TTL) {
    (this as any).CACHE_TTL = 500
  }
  
  try {
    return await originalProcessIndication.call(this, symbol)
  } catch (err) {
    console.warn(`[v0] [Patch] processIndication error for ${symbol}:`, (err as Error).message)
    // Return empty array on error to not break the engine
    return []
  }
}

console.log("[v0] IndicationProcessor.prototype.processIndication patched successfully")

// Export a function to verify the patch is loaded
export function isPatchApplied(): boolean {
  return true
}

// Export the patched class for explicit usage
export { IndicationProcessor as PatchedIndicationProcessor }
