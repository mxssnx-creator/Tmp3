/**
 * Stage 5: Live Exchange Position Tracking
 * Execute on exchange and track fills/orders separately from pseudo positions
 * Mirrors real pseudo positions to actual exchange orders and positions
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import type { RealPosition } from "./real-stage"

const LOG_PREFIX = "[v0] [LivePositionStage]"

export interface LivePosition {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  realPositionId: string // Link to real position
  quantity: number
  executedQuantity: number // Actual filled quantity
  remainingQuantity: number // Unfilled
  entryPrice: number
  averageExecutionPrice: number
  leverage: number
  stopLoss: number
  takeProfit: number
  orderId?: string // Exchange order ID
  status: "pending" | "open" | "partially_filled" | "filled" | "closed" | "error" | "simulated"
  fills: {
    timestamp: number
    quantity: number
    price: number
    fee: number
    feeAsset: string
  }[]
  exchangeData?: {
    exchangePositionId?: string
    marginType?: "cross" | "isolated"
    markPrice?: number
    liquidationPrice?: number
    unrealizedPnl?: number
    roi?: number
  }
  createdAt: number
  updatedAt: number
}

/**
 * Execute real position on exchange as live position
 * Only executes REAL exchange trading if is_live_trade is enabled
 * Otherwise returns pseudo position tracking without exchange execution
 */
export async function executeLivePosition(
  connectionId: string,
  realPosition: RealPosition,
  exchangeConnector: any // Exchange API connector
): Promise<LivePosition> {
  await initRedis()
  const client = getRedisClient()

  // Check if live trading is actually enabled for this connection
  const connSettings = await client?.hgetall(`connection:${connectionId}`) || {}
  const isLiveTradeEnabled = connSettings.is_live_trade === "1" || connSettings.is_live_trade === "true"
  
  console.log(`${LOG_PREFIX} ${realPosition.symbol}: live_trade enabled=${isLiveTradeEnabled}`)

  const livePosition: LivePosition = {
    id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}`,
    connectionId,
    symbol: realPosition.symbol,
    direction: realPosition.direction,
    realPositionId: realPosition.id,
    quantity: realPosition.quantity,
    executedQuantity: 0,
    remainingQuantity: realPosition.quantity,
    entryPrice: realPosition.entryPrice,
    averageExecutionPrice: 0,
    leverage: realPosition.leverage,
    stopLoss: realPosition.stopLoss,
    takeProfit: realPosition.takeProfit,
    status: isLiveTradeEnabled ? "pending" : "simulated", // Mark as simulated if live_trade disabled
    fills: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  try {
    if (isLiveTradeEnabled) {
      // REAL TRADING: Only execute on exchange when live_trade is enabled

      // Validate required fields BEFORE attempting to place order
      if (!realPosition.direction || !realPosition.symbol || !realPosition.quantity) {
        throw new Error(
          `Invalid realPosition for exchange order: symbol=${realPosition.symbol}, ` +
          `direction=${realPosition.direction}, quantity=${realPosition.quantity}`
        )
      }

      // Normalize direction ("long"/"short") → exchange-side ("buy"/"sell")
      const exchangeSide: "buy" | "sell" = realPosition.direction === "long" ? "buy" : "sell"

      console.log(
        `${LOG_PREFIX} EXECUTING REAL: ${realPosition.symbol} ${realPosition.direction} → ${exchangeSide} qty=${realPosition.quantity.toFixed(4)} on EXCHANGE`
      )

      // Check whether the connector exposes a positional signature (lib/exchange-connectors/*)
      // or the legacy object signature (lib/exchanges.ts). Dispatch accordingly.
      let order: any
      if (exchangeConnector && typeof exchangeConnector.placeOrder === "function") {
        // Use positional signature expected by lib/exchange-connectors/*
        // placeOrder(symbol, side, quantity, price?, orderType?)
        try {
          order = await exchangeConnector.placeOrder(
            realPosition.symbol,
            exchangeSide,
            realPosition.quantity,
            undefined,
            "market",
          )
        } catch (err) {
          console.error(`${LOG_PREFIX} placeOrder threw:`, err)
          throw err
        }
      } else {
        throw new Error(`${LOG_PREFIX} exchangeConnector.placeOrder is not a function`)
      }

      // Connectors return { success, orderId, error } — not { id }
      if (order && order.success && (order.orderId || order.id)) {
        livePosition.orderId = order.orderId || order.id
        livePosition.status = "open"

        console.log(
          `${LOG_PREFIX} Order placed on exchange: ${livePosition.orderId} for ${realPosition.symbol}`
        )
      } else if (order && !order.success) {
        console.warn(
          `${LOG_PREFIX} Exchange order failed for ${realPosition.symbol}: ${order.error || "unknown"}`
        )
        livePosition.status = "error"
      }
    } else {
      // SIMULATION MODE: Track pseudo position without exchange execution
      console.log(
        `${LOG_PREFIX} SIMULATION: ${realPosition.symbol} ${realPosition.direction} qty=${realPosition.quantity.toFixed(4)} (live_trade disabled)`
      )
      livePosition.status = "simulated"
    }

    // Store live position (whether real or simulated)
    const key = `live:position:${livePosition.id}`
    await client?.setex(key, 604800, JSON.stringify(livePosition))

    return livePosition
  } catch (err) {
    console.error(`${LOG_PREFIX} Error executing live position:`, err)
    livePosition.status = "error"
    throw err
  }
}

/**
 * Update live position with order fills
 */
export async function updateLivePositionFill(
  connectionId: string,
  livePositionId: string,
  fill: LivePosition["fills"][0]
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)

    if (!data) {
      console.warn(`${LOG_PREFIX} Live position not found: ${livePositionId}`)
      return null
    }

    const position: LivePosition = JSON.parse(data)

    // Add fill
    position.fills.push(fill)
    position.updatedAt = Date.now()

    // Calculate filled quantity and average price
    position.executedQuantity += fill.quantity
    position.remainingQuantity = position.quantity - position.executedQuantity

    // Update average execution price
    const totalCost = position.fills.reduce((sum, f) => sum + f.price * f.quantity, 0)
    position.averageExecutionPrice = totalCost / position.executedQuantity

    // Update status
    if (position.remainingQuantity <= 0) {
      position.status = "filled"
    } else if (position.executedQuantity > 0) {
      position.status = "partially_filled"
    }

    await client.setex(key, 604800, JSON.stringify(position))

    console.log(
      `${LOG_PREFIX} Updated live position: ${position.symbol} filled=${position.executedQuantity.toFixed(
        4
      )}, remaining=${position.remainingQuantity.toFixed(4)}`
    )

    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error updating fill:`, err)
    return null
  }
}

/**
 * Close live position
 */
export async function closeLivePosition(
  connectionId: string,
  livePositionId: string,
  closePrice: number,
  exchangeConnector?: any
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)

    if (!data) {
      console.warn(`${LOG_PREFIX} Live position not found: ${livePositionId}`)
      return null
    }

    const position: LivePosition = JSON.parse(data)

    // Close on exchange if connector provided
    if (exchangeConnector && position.orderId) {
      try {
        await exchangeConnector.closePosition({
          orderId: position.orderId,
          symbol: position.symbol,
        })
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error closing position on exchange:`, err)
      }
    }

    position.status = "closed"
    position.updatedAt = Date.now()

    await client.setex(key, 604800, JSON.stringify(position))

    // Calculate P&L
    const pnl = position.executedQuantity * (closePrice - position.averageExecutionPrice)
    const roi = (pnl / (position.averageExecutionPrice * position.executedQuantity)) * 100

    console.log(
      `${LOG_PREFIX} Closed live position: ${position.symbol} P&L=${pnl.toFixed(
        2
      )}, ROI=${roi.toFixed(2)}%`
    )

    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error closing live position:`, err)
    return null
  }
}

/**
 * Get all live positions for connection
 */
export async function getLivePositions(connectionId: string): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()

  try {
    const keys = await client.keys(`live:position:live:${connectionId}:*`)
    const positions: LivePosition[] = []

    for (const key of keys) {
      const data = await client.get(key)
      if (data) {
        positions.push(JSON.parse(data))
      }
    }

    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting live positions:`, err)
    return []
  }
}

/**
 * Get live positions by status
 */
export async function getLivePositionsByStatus(
  connectionId: string,
  status: LivePosition["status"]
): Promise<LivePosition[]> {
  const allPositions = await getLivePositions(connectionId)
  return allPositions.filter((p) => p.status === status)
}

/**
 * Calculate PnL statistics for live positions
 */
export async function calculateLivePositionStats(
  connectionId: string
): Promise<{
  totalFilled: number
  totalOpen: number
  totalClosed: number
  totalPnL: number
  averageROI: number
  winRate: number
}> {
  await initRedis()
  const client = getRedisClient()

  try {
    const allPositions = await getLivePositions(connectionId)
    const closed = allPositions.filter((p) => p.status === "closed")
    const open = allPositions.filter((p) => p.status === "filled" || p.status === "open")

    let totalPnL = 0
    let winCount = 0

    for (const pos of closed) {
      const pnl = pos.fills.reduce((sum, f) => sum + f.quantity * f.price, 0)
      totalPnL += pnl
      if (pnl > 0) winCount++
    }

    return {
      totalFilled: allPositions.filter((p) => p.status === "filled").length,
      totalOpen: open.length,
      totalClosed: closed.length,
      totalPnL,
      averageROI: closed.length > 0 ? totalPnL / closed.length : 0,
      winRate: closed.length > 0 ? winCount / closed.length : 0,
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error calculating stats:`, err)
    return {
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    }
  }
}

/**
 * Sync live positions with exchange data
 */
export async function syncWithExchange(
  connectionId: string,
  exchangeConnector: any
): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    const openPositions = await getLivePositionsByStatus(connectionId, "open")

    console.log(
      `${LOG_PREFIX} Syncing ${openPositions.length} open positions with exchange`
    )

    for (const position of openPositions) {
      try {
        // Fetch latest data from exchange
        const exchangePos = await exchangeConnector.getPosition(
          position.symbol,
          position.direction
        )

        if (exchangePos) {
          position.exchangeData = {
            exchangePositionId: exchangePos.positionId,
            marginType: exchangePos.marginType,
            markPrice: exchangePos.markPrice,
            liquidationPrice: exchangePos.liquidationPrice,
            unrealizedPnl: exchangePos.unrealizedPnL,
            roi: exchangePos.roi,
          }

          // Update position
          const key = `live:position:${position.id}`
          await client.setex(key, 604800, JSON.stringify(position))

          console.log(
            `${LOG_PREFIX} Synced ${position.symbol} - pnl=${exchangePos.unrealizedPnL?.toFixed(
              2
            )}, roi=${exchangePos.roi?.toFixed(2)}%`
          )
        }
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} Error syncing position ${position.id}:`,
          err
        )
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error syncing with exchange:`, err)
  }
}

export default {
  executeLivePosition,
  updateLivePositionFill,
  closeLivePosition,
  getLivePositions,
  getLivePositionsByStatus,
  calculateLivePositionStats,
  syncWithExchange,
}
