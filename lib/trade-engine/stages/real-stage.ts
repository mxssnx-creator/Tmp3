/**
 * Stage 4: Real Position Trading
 * Apply trading ratios and thresholds to determine final tradeable positions
 * Evaluates if main positions meet real trading criteria
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { MainPosition } from "./main-stage"

const LOG_PREFIX = "[v0] [RealPositionStage]"

export interface RealPosition {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  quantity: number
  leverage: number
  riskAmount: number
  rewardTarget: number
  stopLoss: number
  takeProfit: number
  mainPositionCount: number
  evaluationScore: number // 0-1, final trading score
  ratioMet: boolean // Whether all ratio checks passed
  timestamp: number
  ratios: {
    profitabilityRatio: number // Risk:Reward ratio
    accountRiskRatio: number // Risk as % of account
    successRateRatio: number // Historical success rate
    consistencyRatio: number // Consistency score
  }
  status: "pending" | "ready" | "trading" | "closed"
}

/**
 * Evaluate main positions to real trading positions
 * Applies thresholds and ratios for actual trading
 */
export async function evaluateToRealPositions(
  connectionId: string,
  mainPositions: MainPosition[],
  accountBalance: number,
  config?: {
    minEvaluationScore?: number // Default 0.65
    maxAccountRiskPerTrade?: number // Default 0.02 (2%)
    minProfitabilityRatio?: number // Default 2 (2:1)
    minSuccessRate?: number // Default 0.55 (55%)
    minConsistency?: number // Default 0.6
  }
): Promise<RealPosition[]> {
  await initRedis()
  const client = getRedisClient()
  const realPositions: RealPosition[] = []

  const minScore = config?.minEvaluationScore || 0.65
  const maxRisk = config?.maxAccountRiskPerTrade || 0.02
  const minProfit = config?.minProfitabilityRatio || 2
  const minSuccess = config?.minSuccessRate || 0.55
  const minConsist = config?.minConsistency || 0.6

  console.log(
    `${LOG_PREFIX} Evaluating ${mainPositions.length} main positions to real trading positions`
  )
  console.log(
    `${LOG_PREFIX} Config: minScore=${minScore}, maxRisk=${maxRisk * 100}%, minProfit=${minProfit}:1`
  )

  try {
    for (const mainPos of mainPositions) {
      // Check ratio criteria
      const profitRatio = calculateProfitabilityRatio(mainPos)
      const accountRisk = (maxRisk * accountBalance) / mainPos.entryPrice
      const successRate = mainPos.metrics.successRate
      const consistency = mainPos.metrics.consistencyScore

      const ratiosMet =
        profitRatio >= minProfit &&
        accountRisk <= maxRisk * accountBalance &&
        successRate >= minSuccess &&
        consistency >= minConsist

      // Calculate overall evaluation score
      const evaluationScore = calculateEvaluationScore(
        mainPos,
        profitRatio,
        successRate,
        consistency
      )

      console.log(
        `${LOG_PREFIX} Evaluating ${mainPos.symbol} ${mainPos.direction}:`
      )
      console.log(
        `${LOG_PREFIX}   Score: ${evaluationScore.toFixed(2)} (threshold: ${minScore})`
      )
      console.log(
        `${LOG_PREFIX}   Profit: ${profitRatio.toFixed(2)}:1 (min: ${minProfit}:1)`
      )
      console.log(
        `${LOG_PREFIX}   Success: ${(successRate * 100).toFixed(0)}% (min: ${minSuccess * 100}%)`
      )
      console.log(
        `${LOG_PREFIX}   Consistency: ${consistency.toFixed(2)} (min: ${minConsist})`
      )

      // If meets criteria, create real position
      if (evaluationScore >= minScore && ratiosMet) {
        const realPosition = createRealPosition(
          connectionId,
          mainPos,
          accountBalance,
          {
            profitRatio,
            successRate,
            consistency,
            accountRisk: accountRisk / (maxRisk * accountBalance),
          }
        )

        realPositions.push(realPosition)

        // Store real position
        const key = `real:position:${realPosition.id}`
        await client.setex(key, 604800, JSON.stringify(realPosition))

        console.log(
          `${LOG_PREFIX} ✓ APPROVED: ${mainPos.symbol} ${mainPos.direction} (score: ${evaluationScore.toFixed(2)})`
        )
      } else {
        console.log(
          `${LOG_PREFIX} ✗ REJECTED: ${mainPos.symbol} ${mainPos.direction} (score: ${evaluationScore.toFixed(2)}, ratios: ${ratiosMet})`
        )
      }
    }

    console.log(
      `${LOG_PREFIX} Created ${realPositions.length} real trading positions from ${mainPositions.length} main positions`
    )
    return realPositions
  } catch (err) {
    console.error(`${LOG_PREFIX} Error evaluating real positions:`, err)
    throw err
  }
}

/**
 * Calculate profitability ratio (risk:reward)
 */
function calculateProfitabilityRatio(mainPos: MainPosition): number {
  const baseRatio = mainPos.metrics.averageRoi > 0 ? mainPos.metrics.averageRoi : 1
  const trendMultiplier = mainPos.trendScore
  return baseRatio * (1 + trendMultiplier)
}

/**
 * Calculate overall evaluation score (0-1)
 */
function calculateEvaluationScore(
  mainPos: MainPosition,
  profitRatio: number,
  successRate: number,
  consistency: number
): number {
  // Weighted components
  const strengthScore = mainPos.averageStrength // 30%
  const trendScore = mainPos.trendScore // 25%
  const profitScore = Math.min(1, profitRatio / 3) // 20%
  const successScore = successRate // 15%
  const consistencyScore = consistency // 10%

  return (
    strengthScore * 0.3 +
    trendScore * 0.25 +
    profitScore * 0.2 +
    successScore * 0.15 +
    consistencyScore * 0.1
  )
}

/**
 * Create real position from main position
 */
function createRealPosition(
  connectionId: string,
  mainPos: MainPosition,
  accountBalance: number,
  ratios: {
    profitRatio: number
    successRate: number
    consistency: number
    accountRisk: number
  }
): RealPosition {
  const riskPercentage = 0.02 // 2% risk per trade
  const riskAmount = accountBalance * riskPercentage
  const quantity = riskAmount / mainPos.entryPrice

  // Calculate stops based on volatility
  const stopDistance = mainPos.entryPrice * (1 - mainPos.volatilityScore * 0.1)
  const stopLoss =
    mainPos.direction === "long"
      ? mainPos.entryPrice - stopDistance
      : mainPos.entryPrice + stopDistance

  // Calculate take profit based on risk:reward
  const rewardDistance = stopDistance * ratios.profitRatio
  const takeProfit =
    mainPos.direction === "long"
      ? mainPos.entryPrice + rewardDistance
      : mainPos.entryPrice - rewardDistance

  const leverage = Math.min(
    Math.round(riskAmount / (mainPos.entryPrice * (1 - mainPos.riskScore))),
    10 // Max 10x
  )

  return {
    id: `real:${connectionId}:${mainPos.symbol}:${mainPos.direction}:${Date.now()}`,
    connectionId,
    symbol: mainPos.symbol,
    direction: mainPos.direction,
    entryPrice: mainPos.entryPrice,
    quantity,
    leverage: Math.max(1, leverage),
    riskAmount,
    rewardTarget: rewardDistance,
    stopLoss,
    takeProfit,
    mainPositionCount: mainPos.basePositionCount,
    evaluationScore: 0, // Will be set by caller
    ratioMet: true,
    timestamp: Date.now(),
    ratios: {
      profitabilityRatio: ratios.profitRatio,
      accountRiskRatio: ratios.accountRisk,
      successRateRatio: ratios.successRate,
      consistencyRatio: ratios.consistency,
    },
    status: "ready",
  }
}

/**
 * Get all real trading positions
 */
export async function getRealPositions(connectionId: string): Promise<RealPosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const keys = await client.keys(`real:position:real:${connectionId}:*`)
    const positions: RealPosition[] = []

    for (const key of keys) {
      const data = await client.get(key)
      if (data) {
        positions.push(JSON.parse(data))
      }
    }

    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting real positions:`, err)
    return []
  }
}

/**
 * Update real position status
 */
export async function updateRealPositionStatus(
  positionId: string,
  status: "pending" | "ready" | "trading" | "closed"
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `real:position:${positionId}`
    const data = await client.get(key)

    if (data) {
      const position: RealPosition = JSON.parse(data)
      position.status = status
      await client.setex(key, 604800, JSON.stringify(position))

      console.log(`${LOG_PREFIX} Updated position ${positionId} status to ${status}`)
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error updating position status:`, err)
  }
}

export default {
  evaluateToRealPositions,
  getRealPositions,
  updateRealPositionStatus,
}
