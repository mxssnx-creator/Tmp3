/**
 * Indication Evaluator
 * Type-based evaluation counting and metrics tracking for all indication types
 */

import { getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"

export interface IndicationResult {
  id: string
  type: string
  symbol: string
  timestamp: string
  value: number
  confidence: number
  strength: number
  passed: boolean
  direction: 'up' | 'down' | 'neutral'
  parameters: Record<string, any>
}

export interface IndicationTypeStats {
  type: string
  totalEvaluations: number
  passed: number
  failed: number
  passRate: number
  avgConfidence: number
  avgStrength: number
  avgValue: number
  lastEvaluated: string | null
  symbols: Record<string, number> // symbol -> count
}

export class IndicationEvaluator {
  private connectionId: string
  private progressManager: EngineProgressManager
  private typeStats: Map<string, IndicationTypeStats> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
  }

  /**
   * Evaluate an indication and track metrics
   */
  async evaluateIndication(indication: IndicationResult): Promise<void> {
    // Update type stats
    this.updateTypeStats(indication)
    
    // Store in Redis
    await this.storeIndication(indication)
    
    // Update progress manager
    await this.progressManager.updateIndicationMetrics(
      indication.type,
      indication.passed,
      indication.confidence,
      indication.strength
    )
    
    // Log evaluation
    await this.progressManager.incrementIndicationCycle(indication.symbol)
  }

  /**
   * Evaluate multiple indications in batch
   */
  async evaluateBatch(indications: IndicationResult[]): Promise<void> {
    const typeGroups = new Map<string, IndicationResult[]>()
    
    for (const ind of indications) {
      if (!typeGroups.has(ind.type)) {
        typeGroups.set(ind.type, [])
      }
      typeGroups.get(ind.type)!.push(ind)
    }

    for (const [type, group] of typeGroups) {
      for (const ind of group) {
        await this.evaluateIndication(ind)
      }
    }
  }

  /**
   * Get statistics for a specific indication type
   */
  getTypeStats(type: string): IndicationTypeStats | undefined {
    return this.typeStats.get(type)
  }

  /**
   * Get all type statistics
   */
  getAllTypeStats(): Map<string, IndicationTypeStats> {
    return this.typeStats
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalEvaluations: number
    typesTracked: number
    overallPassRate: number
    avgConfidence: number
    avgStrength: number
    typeBreakdown: Array<{
      type: string
      evaluations: number
      passed: number
      passRate: number
      avgConfidence: number
      avgStrength: number
    }>
  } {
    let totalEvaluations = 0
    let totalPassed = 0
    let totalConfidence = 0
    let totalStrength = 0

    const typeBreakdown: Array<{
      type: string
      evaluations: number
      passed: number
      passRate: number
      avgConfidence: number
      avgStrength: number
    }> = []

    for (const [type, stats] of this.typeStats) {
      totalEvaluations += stats.totalEvaluations
      totalPassed += stats.passed
      totalConfidence += stats.avgConfidence * stats.totalEvaluations
      totalStrength += stats.avgStrength * stats.totalEvaluations

      typeBreakdown.push({
        type,
        evaluations: stats.totalEvaluations,
        passed: stats.passed,
        passRate: stats.passRate,
        avgConfidence: stats.avgConfidence,
        avgStrength: stats.avgStrength,
      })
    }

    return {
      totalEvaluations,
      typesTracked: this.typeStats.size,
      overallPassRate: totalEvaluations > 0 ? (totalPassed / totalEvaluations) * 100 : 0,
      avgConfidence: totalEvaluations > 0 ? totalConfidence / totalEvaluations : 0,
      avgStrength: totalEvaluations > 0 ? totalStrength / totalEvaluations : 0,
      typeBreakdown,
    }
  }

  /**
   * Update type statistics for an indication
   */
  private updateTypeStats(indication: IndicationResult): void {
    if (!this.typeStats.has(indication.type)) {
      this.typeStats.set(indication.type, {
        type: indication.type,
        totalEvaluations: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        avgConfidence: 0,
        avgStrength: 0,
        avgValue: 0,
        lastEvaluated: null,
        symbols: {},
      })
    }

    const stats = this.typeStats.get(indication.type)!
    stats.totalEvaluations++
    if (indication.passed) {
      stats.passed++
    } else {
      stats.failed++
    }
    stats.passRate = (stats.passed / stats.totalEvaluations) * 100
    stats.avgConfidence = ((stats.avgConfidence * (stats.totalEvaluations - 1)) + indication.confidence) / stats.totalEvaluations
    stats.avgStrength = ((stats.avgStrength * (stats.totalEvaluations - 1)) + indication.strength) / stats.totalEvaluations
    stats.avgValue = ((stats.avgValue * (stats.totalEvaluations - 1)) + indication.value) / stats.totalEvaluations
    stats.lastEvaluated = indication.timestamp

    if (!stats.symbols[indication.symbol]) {
      stats.symbols[indication.symbol] = 0
    }
    stats.symbols[indication.symbol]++
  }

  /**
   * Store indication in Redis
   */
  private async storeIndication(indication: IndicationResult): Promise<void> {
    try {
      const client = getRedisClient()
      
      // Store in type-specific list
      const typeKey = `indications:${this.connectionId}:${indication.type}`
      await client.lpush(typeKey, JSON.stringify(indication))
      await client.ltrim(typeKey, 0, 999) // Keep last 1000 per type

      // Store in symbol-specific list
      const symbolKey = `indications:${this.connectionId}:${indication.symbol}`
      await client.lpush(symbolKey, JSON.stringify(indication))
      await client.ltrim(symbolKey, 0, 499) // Keep last 500 per symbol

      // Store latest by type
      const latestKey = `indications:${this.connectionId}:latest:${indication.type}`
      await client.set(latestKey, JSON.stringify(indication), { EX: 3600 })

    } catch (error) {
      await this.progressManager.addError(
        'indication_store',
        error instanceof Error ? error.message : 'Failed to store indication',
        indication.symbol
      )
    }
  }

  /**
   * Get recent indications by type
   */
  async getRecentByType(type: string, limit: number = 50): Promise<IndicationResult[]> {
    try {
      const client = getRedisClient()
      const key = `indications:${this.connectionId}:${type}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Get recent indications by symbol
   */
  async getRecentBySymbol(symbol: string, limit: number = 50): Promise<IndicationResult[]> {
    try {
      const client = getRedisClient()
      const key = `indications:${this.connectionId}:${symbol}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.typeStats.clear()
  }
}
