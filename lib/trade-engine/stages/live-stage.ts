/**
 * Stage 5: Live Exchange Position Creation Progression
 *
 * Complete end-to-end pipeline for creating and tracking a live position on a
 * real exchange. Mirrors a qualifying Real set into an executable exchange
 * position, with:
 *
 *   1. Pre-flight validation (live_trade flag, input sanity, dedup lock)
 *   2. Current price fetch from Redis market data
 *   3. Volume calculation via VolumeCalculator (respecting balance, leverage,
 *      position cost, and exchange minimum volume)
 *   4. Leverage + margin type configuration on the exchange
 *   5. Market entry order placement with exponential-backoff retry
 *   6. Order fill confirmation polling
 *   7. Reduce-only Stop Loss and Take Profit order placement
 *   8. Position sync from exchange (liquidation price, margin type, mark price)
 *   9. Progression logging at every stage (engine_logs:{connId})
 *  10. Metrics counters in progression:{connId} hash (live orders placed,
 *      filled, failed; live positions open; total volume USD)
 *
 * Disabling is_live_trade on the connection short-circuits the pipeline and
 * records a "simulated" live position without touching the exchange.
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { SystemLogger } from "@/lib/system-logger"
import type { RealPosition } from "./real-stage"

const LOG_PREFIX = "[v0] [LivePositionStage]"

// ── Types ────────────────────────────────────────────────────────────────────

export interface LivePosition {
  id: string
  connectionId: string
  symbol: string
  direction: "long" | "short"
  realPositionId: string
  // Sizing & pricing
  quantity: number
  executedQuantity: number
  remainingQuantity: number
  entryPrice: number
  averageExecutionPrice: number
  volumeUsd: number
  leverage: number
  marginType: "cross" | "isolated"
  // Risk management
  stopLoss: number
  takeProfit: number
  stopLossPrice?: number
  takeProfitPrice?: number
  // Exchange references
  orderId?: string
  stopLossOrderId?: string
  takeProfitOrderId?: string
  status:
    | "pending"
    | "placed"
    | "open"
    | "partially_filled"
    | "filled"
    | "closed"
    | "error"
    | "simulated"
    | "rejected"
  statusReason?: string
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
    unrealizedPnL?: number   // alias; some code-paths write either casing
    roi?: number
    syncedAt?: number        // last reconciliation timestamp
  }
  // Close / terminal state
  closedAt?: number
  realizedPnL?: number
  closeReason?: string       // "sl_hit" | "tp_hit" | "manual" | "exchange_reconciliation" | ...
  progression: {
    step: string
    timestamp: number
    success: boolean
    details?: string
  }[]
  createdAt: number
  updatedAt: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushStep(pos: LivePosition, step: string, success: boolean, details?: string): void {
  pos.progression.push({ step, timestamp: Date.now(), success, details })
  pos.updatedAt = Date.now()
}

// In-memory set of ids already registered in the Redis index this runtime.
// Avoids a roundtrip GET on every intermediate savePosition() call. Cleared
// on serverless cold start, which is correct because Redis dedup marker
// (`live:positions:{connId}:indexed:{id}`) is the ultimate source of truth.
const _indexedInMemory = new Set<string>()

async function savePosition(pos: LivePosition): Promise<void> {
  try {
    const client = getRedisClient()
    const key = `live:position:${pos.id}`
    const openIndexKey   = `live:positions:${pos.connectionId}`
    const closedIndexKey = `live:positions:${pos.connectionId}:closed`
    const indexedMarker  = `live:positions:${pos.connectionId}:indexed:${pos.id}`

    // 1. Write the position snapshot
    await client.setex(key, 604800, JSON.stringify(pos))

    // 2. Register id in the open index exactly once per lifetime. When the
    // marker isn't set yet the four follow-up writes are independent, so we
    // collapse them into a single Promise.all round-trip window.
    if (!_indexedInMemory.has(pos.id)) {
      const alreadyIndexed = await client.get(indexedMarker).catch(() => null)
      if (!alreadyIndexed) {
        await Promise.all([
          client.lpush(openIndexKey, pos.id).catch(() => {}),
          client.setex(indexedMarker, 604800, "1").catch(() => {}),
          client.ltrim(openIndexKey, 0, 1999).catch(() => {}),
          client.expire(openIndexKey, 604800).catch(() => {}),
        ])
      }
      _indexedInMemory.add(pos.id)
    }

    // 3. When a position reaches a terminal status, move it out of the open
    // index and into the closed archive so getLivePositions() only scans
    // currently-active records (major performance win for long-running apps).
    const isTerminal =
      pos.status === "closed" ||
      pos.status === "error" ||
      pos.status === "rejected"

    if (isTerminal) {
      const movedMarker = `live:positions:${pos.connectionId}:moved:${pos.id}`
      const alreadyMoved = await client.get(movedMarker).catch(() => null)
      if (!alreadyMoved) {
        // These five writes are independent — lrem + lpush + ltrim + two
        // expiries. Parallelising halves the per-close latency.
        await Promise.all([
          client.lrem(openIndexKey, 0, pos.id).catch(() => {}),
          client.lpush(closedIndexKey, pos.id).catch(() => {}),
          client.ltrim(closedIndexKey, 0, 4999).catch(() => {}),
          client.expire(closedIndexKey, 30 * 24 * 60 * 60).catch(() => {}),
          client.setex(movedMarker, 604800, "1").catch(() => {}),
        ])
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to save position:`, err)
  }
}

async function incrementMetric(connectionId: string, field: string, by = 1): Promise<void> {
  // Fire the counter bump and the TTL refresh in parallel — the expire is
  // independent of the hincrby result and would otherwise force a second
  // round-trip for every live-stage metric update.
  try {
    const client = getRedisClient()
    const key = `progression:${connectionId}`
    await Promise.all([
      client.hincrby(key, field, by),
      client.expire(key, 7 * 24 * 60 * 60),
    ])
  } catch {
    /* non-critical */
  }
}

async function fetchCurrentPrice(symbol: string): Promise<number> {
  try {
    const client = getRedisClient()
    const mdhash = await client.hgetall(`market_data:${symbol}`)
    const price = parseFloat(String(mdhash?.close ?? mdhash?.price ?? mdhash?.last ?? "0"))
    if (price > 0) return price
    const raw = await client.get(`market_data:${symbol}:1m`)
    if (raw) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        return parseFloat(String(parsed?.close ?? parsed?.price ?? 0)) || 0
      } catch {
        /* ignore */
      }
    }
    return 0
  } catch {
    return 0
  }
}

async function hasOpenLivePosition(
  connectionId: string,
  symbol: string,
  direction: "long" | "short"
): Promise<boolean> {
  try {
    const client = getRedisClient()
    const lockKey = `live:lock:${connectionId}:${symbol}:${direction}`
    const locked = await client.get(lockKey)
    return !!locked
  } catch {
    return false
  }
}

async function acquireLock(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  ttlSeconds = 3600
): Promise<void> {
  try {
    const client = getRedisClient()
    const lockKey = `live:lock:${connectionId}:${symbol}:${direction}`
    await client.setex(lockKey, ttlSeconds, "1")
  } catch {
    /* non-critical */
  }
}

async function releaseLock(
  connectionId: string,
  symbol: string,
  direction: "long" | "short"
): Promise<void> {
  try {
    const client = getRedisClient()
    const lockKey = `live:lock:${connectionId}:${symbol}:${direction}`
    await client.del(lockKey)
  } catch {
    /* non-critical */
  }
}

/**
 * Retry a promise-returning function with exponential backoff.
 */
async function retry<T>(
  fn: () => Promise<T>,
  isSuccess: (r: T) => boolean,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastResult: T | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn()
      lastResult = result
      if (isSuccess(result)) return result
      console.warn(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} unsuccessful`)
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} error:`, err)
      lastResult = undefined as unknown as T
    }
    if (attempt < maxAttempts) {
      const backoff = Math.pow(2, attempt - 1) * 500
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  return lastResult as T
}

/**
 * Poll an order until it reaches a terminal fill state or the timeout elapses.
 */
async function pollOrderFill(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 10000,
  intervalMs = 800
): Promise<{ filled: boolean; filledQty: number; filledPrice: number; status: string }> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = "pending"
  while (Date.now() < deadline) {
    try {
      const order = await connector.getOrder(symbol, orderId)
      if (order) {
        lastStatus = order.status
        if (order.status === "filled") {
          return {
            filled: true,
            filledQty: order.filledQty || 0,
            filledPrice: order.filledPrice || 0,
            status: "filled",
          }
        }
        if (order.status === "cancelled") {
          return { filled: false, filledQty: 0, filledPrice: 0, status: "cancelled" }
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} poll error:`, err)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return { filled: false, filledQty: 0, filledPrice: 0, status: lastStatus }
}

/**
 * Place a protection order (SL or TP) as a limit order at triggerPrice.
 * Returns order id on success, null on failure.
 */
async function placeProtectionOrder(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  quantity: number,
  triggerPrice: number,
  orderLabel: string
): Promise<string | null> {
  try {
    if (typeof connector.placeOrder !== "function") return null
    const result = await connector.placeOrder(symbol, closeSide, quantity, triggerPrice, "limit")
    if (result?.success && (result.orderId || result.id)) {
      console.log(`${LOG_PREFIX} ${orderLabel} placed: ${result.orderId || result.id} @ ${triggerPrice}`)
      return result.orderId || result.id
    }
    console.warn(`${LOG_PREFIX} ${orderLabel} placement failed: ${result?.error || "unknown"}`)
    return null
  } catch (err) {
    console.warn(`${LOG_PREFIX} ${orderLabel} error:`, err)
    return null
  }
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

/**
 * Execute a real position on exchange as a live position with the full
 * progression pipeline.
 */
export async function executeLivePosition(
  connectionId: string,
  realPosition: RealPosition,
  exchangeConnector: any
): Promise<LivePosition> {
  await initRedis()
  const client = getRedisClient()

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
    volumeUsd: 0,
    leverage: realPosition.leverage,
    marginType: "cross",
    stopLoss: realPosition.stopLoss,
    takeProfit: realPosition.takeProfit,
    status: "pending",
    fills: [],
    progression: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  try {
    // ── Step 1: Pre-flight validation ──────────────────────────────────────
    if (!realPosition.direction || !realPosition.symbol) {
      livePosition.status = "rejected"
      livePosition.statusReason = `Invalid inputs: symbol=${realPosition.symbol}, direction=${realPosition.direction}`
      pushStep(livePosition, "preflight", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_rejected_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order rejected — invalid inputs", {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
      })
      return livePosition
    }

    // CRITICAL: Upstash returns values as strings OR native types depending on adapter.
    // Use getConnection() to get the parsed hash (parseHashValue coerces "1"/"true"/true -> true).
    // Raw hgetall followed by string-only equality was silently failing when the value
    // came back as a boolean, causing every real order to become a "simulated" order
    // despite the strategy-coordinator correctly detecting live_trade=true just one
    // function call upstream.
    const { getConnection: _getConn } = await import("@/lib/redis-db")
    const { isTruthyFlag } = await import("@/lib/connection-state-utils")
    const connSettings = (await _getConn(connectionId)) || {}
    const isLiveTradeEnabled =
      isTruthyFlag(connSettings.is_live_trade) ||
      isTruthyFlag(connSettings.live_trade_enabled)

    pushStep(livePosition, "preflight", true, `live_trade=${isLiveTradeEnabled}`)
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "info",
      `Live pipeline start ${realPosition.symbol} ${realPosition.direction}`,
      { liveTrade: isLiveTradeEnabled, realPositionId: realPosition.id }
    )

    // Deduplication: skip if same symbol+direction already in-flight.
    if (await hasOpenLivePosition(connectionId, realPosition.symbol, realPosition.direction)) {
      livePosition.status = "rejected"
      livePosition.statusReason = "A live position is already open for this symbol+direction"
      pushStep(livePosition, "dedup", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_rejected_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `Skipped duplicate live order for ${realPosition.symbol} ${realPosition.direction}`,
        {}
      )
      return livePosition
    }

    // Short-circuit on simulation mode — still record the intent.
    if (!isLiveTradeEnabled) {
      livePosition.status = "simulated"
      livePosition.statusReason = "live_trade disabled — no exchange execution"
      pushStep(livePosition, "simulate", true)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_simulated_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `Simulated live order (live_trade disabled) ${realPosition.symbol}`,
        { direction: realPosition.direction, quantity: realPosition.quantity }
      )
      console.log(`${LOG_PREFIX} SIMULATION: ${realPosition.symbol} ${realPosition.direction} (live_trade disabled)`)
      return livePosition
    }

    if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
      livePosition.status = "error"
      livePosition.statusReason = "Exchange connector not available or missing placeOrder"
      pushStep(livePosition, "connector_check", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no connector", {
        symbol: realPosition.symbol,
      })
      return livePosition
    }

    // ── Step 2: Fetch current market price ─────────────────────────────────
    let currentPrice = realPosition.entryPrice
    if (!currentPrice || currentPrice <= 0) {
      currentPrice = await fetchCurrentPrice(realPosition.symbol)
    }
    if (!currentPrice || currentPrice <= 0) {
      livePosition.status = "error"
      livePosition.statusReason = `No current price available for ${realPosition.symbol}`
      pushStep(livePosition, "price_fetch", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no market price", {
        symbol: realPosition.symbol,
      })
      return livePosition
    }
    livePosition.entryPrice = currentPrice
    pushStep(livePosition, "price_fetch", true, `price=${currentPrice}`)

    // ── Step 3: Volume calculation ─────────────────────────────────────────
    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    const computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    if (!volumeResult || computedVolume <= 0) {
      livePosition.status = "rejected"
      livePosition.statusReason =
        volumeResult?.adjustmentReason ||
        `Computed volume is zero or below exchange minimum for ${realPosition.symbol}`
      pushStep(livePosition, "volume_calc", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_rejected_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Live order rejected — volume too small for ${realPosition.symbol}`,
        {
          reason: livePosition.statusReason,
          calculatedVolume: volumeResult?.calculatedVolume,
        }
      )
      return livePosition
    }

    livePosition.quantity = computedVolume
    livePosition.remainingQuantity = computedVolume
    livePosition.volumeUsd = computedVolume * currentPrice
    livePosition.leverage = volumeResult.leverage || livePosition.leverage
    pushStep(
      livePosition,
      "volume_calc",
      true,
      `qty=${computedVolume.toFixed(6)} usd=${livePosition.volumeUsd.toFixed(2)} lev=${livePosition.leverage}x`
    )
    await VolumeCalculator.logVolumeCalculation(connectionId, realPosition.symbol, volumeResult).catch(() => {})

    // ── Step 4: Configure leverage + margin type on exchange ───────────────
    if (typeof exchangeConnector.setLeverage === "function") {
      try {
        const lev = await exchangeConnector.setLeverage(realPosition.symbol, livePosition.leverage)
        pushStep(livePosition, "set_leverage", !!lev?.success, lev?.error || `leverage=${livePosition.leverage}`)
      } catch (err) {
        pushStep(livePosition, "set_leverage", false, String(err))
      }
    } else {
      pushStep(livePosition, "set_leverage", true, "connector does not expose setLeverage — skipping")
    }

    const marginTypeSetting = (connSettings.margin_type as "cross" | "isolated") || "cross"
    livePosition.marginType = marginTypeSetting
    if (typeof exchangeConnector.setMarginType === "function") {
      try {
        const m = await exchangeConnector.setMarginType(realPosition.symbol, marginTypeSetting)
        pushStep(livePosition, "set_margin_type", !!m?.success, m?.error || `margin=${marginTypeSetting}`)
      } catch (err) {
        pushStep(livePosition, "set_margin_type", false, String(err))
      }
    } else {
      pushStep(livePosition, "set_margin_type", true, "connector does not expose setMarginType — skipping")
    }

    // ── Step 5: Place entry order with retry ───────────────────────────────
    const exchangeSide: "buy" | "sell" = realPosition.direction === "long" ? "buy" : "sell"

    console.log(
      `${LOG_PREFIX} EXECUTING REAL: ${realPosition.symbol} ${realPosition.direction} → ${exchangeSide} qty=${computedVolume.toFixed(
        6
      )} @ ${currentPrice}`
    )

    const orderResult: any = await retry(
      () => exchangeConnector.placeOrder(realPosition.symbol, exchangeSide, computedVolume, undefined, "market"),
      r => !!r?.success && !!(r.orderId || r.id),
      "placeOrder"
    )

    if (!orderResult?.success || !(orderResult.orderId || orderResult.id)) {
      livePosition.status = "error"
      livePosition.statusReason = `Entry order failed: ${orderResult?.error || "unknown"}`
      pushStep(livePosition, "place_order", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")

      // Per-connection progression log (for the UI Progression panel).
      await logProgressionEvent(connectionId, "live_trading", "error", `Entry order failed for ${realPosition.symbol}`, {
        error: orderResult?.error,
        side: exchangeSide,
        quantity: computedVolume,
        price: currentPrice,
        leverage: livePosition.leverage,
      })

      // Systemwide error log — makes this visible in the global error view
      // alongside API errors so one place shows both UI + exchange failures.
      // Wrapped in try/catch because we never block the main return on logging.
      try {
        await SystemLogger.logError(
          new Error(
            `Exchange entry order failed: ${orderResult?.error || "unknown"} [symbol=${realPosition.symbol}, side=${exchangeSide}, qty=${computedVolume}]`,
          ),
          connectionId,
          "live-stage.placeOrder",
        )
      } catch {
        /* logging must never throw */
      }
      return livePosition
    }

    livePosition.orderId = orderResult.orderId || orderResult.id
    livePosition.status = "placed"
    pushStep(livePosition, "place_order", true, `orderId=${livePosition.orderId}`)
    await incrementMetric(connectionId, "live_orders_placed_count")
    await acquireLock(connectionId, realPosition.symbol, realPosition.direction)
    await logProgressionEvent(connectionId, "live_trading", "info", `Entry order placed for ${realPosition.symbol}`, {
      orderId: livePosition.orderId,
      side: exchangeSide,
      quantity: computedVolume,
      price: currentPrice,
      leverage: livePosition.leverage,
    })

    // Persist intermediate state so UI can show "placed" even during poll.
    await savePosition(livePosition)

    // ── Step 6: Poll for fill confirmation ─────────────────────────────────
    const fill = await pollOrderFill(exchangeConnector, realPosition.symbol, livePosition.orderId!)
    if (fill.filled && fill.filledQty > 0) {
      livePosition.executedQuantity = fill.filledQty
      livePosition.remainingQuantity = Math.max(0, computedVolume - fill.filledQty)
      livePosition.averageExecutionPrice = fill.filledPrice || currentPrice
      livePosition.fills.push({
        timestamp: Date.now(),
        quantity: fill.filledQty,
        price: fill.filledPrice || currentPrice,
        fee: 0,
        feeAsset: "USDT",
      })
      livePosition.status = livePosition.remainingQuantity <= 0 ? "filled" : "partially_filled"
      pushStep(livePosition, "poll_fill", true, `filled=${fill.filledQty} @ ${fill.filledPrice}`)
      await incrementMetric(connectionId, "live_orders_filled_count")
      await logProgressionEvent(connectionId, "live_trading", "info", `Entry filled for ${realPosition.symbol}`, {
        orderId: livePosition.orderId,
        filledQty: fill.filledQty,
        filledPrice: fill.filledPrice,
      })
    } else {
      pushStep(livePosition, "poll_fill", false, `fill not confirmed within timeout — status=${fill.status}`)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Entry fill not confirmed within timeout for ${realPosition.symbol}`,
        { orderId: livePosition.orderId, status: fill.status }
      )
    }

    // ── Step 7: Place Stop Loss and Take Profit orders ─────────────────────
    if (livePosition.executedQuantity > 0) {
      const fillPrice = livePosition.averageExecutionPrice
      const sideClose: "buy" | "sell" = realPosition.direction === "long" ? "sell" : "buy"
      const slPct = Math.max(0, livePosition.stopLoss) / 100
      const tpPct = Math.max(0, livePosition.takeProfit) / 100
      const slPrice =
        realPosition.direction === "long" ? fillPrice * (1 - slPct) : fillPrice * (1 + slPct)
      const tpPrice =
        realPosition.direction === "long" ? fillPrice * (1 + tpPct) : fillPrice * (1 - tpPct)

      livePosition.stopLossPrice = slPrice
      livePosition.takeProfitPrice = tpPrice

      const slOrderId = await placeProtectionOrder(
        exchangeConnector,
        realPosition.symbol,
        sideClose,
        livePosition.executedQuantity,
        slPrice,
        "StopLoss"
      )
      const tpOrderId = await placeProtectionOrder(
        exchangeConnector,
        realPosition.symbol,
        sideClose,
        livePosition.executedQuantity,
        tpPrice,
        "TakeProfit"
      )
      if (slOrderId) livePosition.stopLossOrderId = slOrderId
      if (tpOrderId) livePosition.takeProfitOrderId = tpOrderId
      pushStep(
        livePosition,
        "place_sl_tp",
        !!(slOrderId || tpOrderId),
        `SL=${slOrderId || "—"} (${slPrice.toFixed(4)}) TP=${tpOrderId || "—"} (${tpPrice.toFixed(4)})`
      )
      await logProgressionEvent(connectionId, "live_trading", "info", `SL/TP placed for ${realPosition.symbol}`, {
        slOrderId,
        slPrice,
        tpOrderId,
        tpPrice,
      })
    } else {
      pushStep(livePosition, "place_sl_tp", false, "skipped — no fill yet")
    }

    // ── Step 8: Sync with exchange for position data ───────────────────────
    if (typeof exchangeConnector.getPosition === "function") {
      try {
        const exPos = await exchangeConnector.getPosition(realPosition.symbol)
        if (exPos) {
          livePosition.exchangeData = {
            marginType: (exPos as any).marginType,
            markPrice: (exPos as any).markPrice,
            liquidationPrice: (exPos as any).liquidationPrice,
            unrealizedPnl: (exPos as any).unrealizedPnl,
            roi: (exPos as any).roi,
          }
          pushStep(
            livePosition,
            "exchange_sync",
            true,
            `liqPrice=${(exPos as any).liquidationPrice} markPrice=${(exPos as any).markPrice}`
          )
        } else {
          pushStep(livePosition, "exchange_sync", false, "no position returned")
        }
      } catch (err) {
        pushStep(livePosition, "exchange_sync", false, String(err))
      }
    }

    if (livePosition.status === "filled") livePosition.status = "open"

    await savePosition(livePosition)
    await incrementMetric(connectionId, "live_positions_created_count")
    await incrementMetric(connectionId, "live_volume_usd_total", Math.round(livePosition.volumeUsd))
    await logProgressionEvent(connectionId, "live_trading", "info", `Live position created ${realPosition.symbol}`, {
      status: livePosition.status,
      orderId: livePosition.orderId,
      executedQuantity: livePosition.executedQuantity,
      volumeUsd: livePosition.volumeUsd,
    })

    return livePosition
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? err.stack : undefined
    console.error(`${LOG_PREFIX} Unhandled error:`, errMsg, errStack || "")
    livePosition.status = "error"
    livePosition.statusReason = errMsg
    pushStep(livePosition, "unhandled_error", false, errMsg)
    await savePosition(livePosition)
    await incrementMetric(connectionId, "live_orders_failed_count")
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "error",
      `Live pipeline unhandled error for ${realPosition.symbol}`,
      { error: errMsg, stack: errStack }
    )

    // Surface unhandled live-pipeline failures into the systemwide log too,
    // not just the per-connection progression view.
    try {
      await SystemLogger.logError(
        err instanceof Error ? err : new Error(errMsg),
        connectionId,
        `live-stage.executeLivePosition[${realPosition.symbol}/${realPosition.direction}]`,
      )
    } catch {
      /* logging must never throw */
    }
    await releaseLock(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
    return livePosition
  }
}

/**
 * Update live position with order fills (used by webhooks / syncs).
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
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    position.fills.push(fill)
    position.executedQuantity += fill.quantity
    position.remainingQuantity = position.quantity - position.executedQuantity

    const totalCost = position.fills.reduce((sum, f) => sum + f.price * f.quantity, 0)
    position.averageExecutionPrice = totalCost / position.executedQuantity

    if (position.remainingQuantity <= 0) {
      position.status = "filled"
    } else if (position.executedQuantity > 0) {
      position.status = "partially_filled"
    }
    position.updatedAt = Date.now()

    await client.setex(key, 604800, JSON.stringify(position))
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error updating fill:`, err)
    return null
  }
}

/**
 * Close a live position (market exit) and release its dedup lock.
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
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)

    if (exchangeConnector && typeof exchangeConnector.closePosition === "function") {
      try {
        await exchangeConnector.closePosition(position.symbol, position.direction)
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error closing on exchange:`, err)
      }
    }

    position.status = "closed"
    position.updatedAt = Date.now()
    pushStep(position, "close", true, `close @ ${closePrice}`)
    await client.setex(key, 604800, JSON.stringify(position))

    await releaseLock(connectionId, position.symbol, position.direction)

    const pnl =
      position.executedQuantity *
      (position.direction === "long"
        ? closePrice - position.averageExecutionPrice
        : position.averageExecutionPrice - closePrice)
    const notional = position.averageExecutionPrice * position.executedQuantity
    const roi = notional > 0 ? (pnl / notional) * 100 : 0

    await incrementMetric(connectionId, "live_positions_closed_count")
    if (pnl > 0) await incrementMetric(connectionId, "live_wins_count")
    await logProgressionEvent(connectionId, "live_trading", "info", `Closed live position ${position.symbol}`, {
      pnl,
      roi,
      closePrice,
    })

    console.log(`${LOG_PREFIX} Closed ${position.symbol} P&L=${pnl.toFixed(2)} ROI=${roi.toFixed(2)}%`)

    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error closing live position:`, err)
    return null
  }
}

/**
 * Get all live positions for a connection.
 */
export async function getLivePositions(connectionId: string): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}`, 0, 500).catch(() => [])) || []) as string[]

    // Deduplicate while preserving order — the open index may contain stale
    // duplicates from retried writes.
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    // Batch all GETs into a single concurrent fan-out. Previously each id
    // paid a full Redis round-trip; with 500 open positions that was ~500
    // sequential awaits. Promise.all collapses them into one RTT window.
    const positions: LivePosition[] = []
    if (uniqueIds.length > 0) {
      const rawValues = await Promise.all(
        uniqueIds.map((id) => client.get(`live:position:${id}`).catch(() => null)),
      )
      for (const data of rawValues) {
        if (!data) continue
        try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
      }
    }
    if (positions.length > 0) return positions

    // Fallback scan if the index is empty.
    const keys = ((await client.keys(`live:position:live:${connectionId}:*`).catch(() => [])) || []) as string[]
    if (keys.length === 0) return positions

    const rawFallback = await Promise.all(keys.map((k) => client.get(k).catch(() => null)))
    for (const data of rawFallback) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting live positions:`, err)
    return []
  }
}

/**
 * Get live positions filtered by status.
 */
export async function getLivePositionsByStatus(
  connectionId: string,
  status: LivePosition["status"]
  ): Promise<LivePosition[]> {
  const allPositions = await getLivePositions(connectionId)
  return allPositions.filter(p => p.status === status)
  }

/**
 * Fetch the most recent closed/terminal positions from the closed archive.
 * Closed positions are stored separately so the open index stays small.
 */
export async function getClosedLivePositions(
  connectionId: string,
  limit = 200
): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}:closed`, 0, limit - 1).catch(() => [])) || []) as string[]

    // Deduplicate + batch GETs concurrently (same rationale as getLivePositions).
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    const positions: LivePosition[] = []
    if (uniqueIds.length === 0) return positions

    const rawValues = await Promise.all(
      uniqueIds.map((id) => client.get(`live:position:${id}`).catch(() => null)),
    )
    for (const data of rawValues) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore malformed */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} getClosedLivePositions error:`, err)
    return []
  }
}

/**
 * Compute aggregate stats across all live positions.
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
  try {
    // Merge open (live) and closed (archive) indices so aggregate stats are
    // accurate across the position's full lifecycle, not just currently-open.
    const [openPositions, closedPositions] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, 1000),
    ])
    const allPositions = [...openPositions, ...closedPositions]
    const closed = allPositions.filter(p => p.status === "closed")
    const open = allPositions.filter(
      p => p.status === "open" || p.status === "filled" || p.status === "partially_filled"
    )

    let totalPnL = 0
    let winCount = 0
    for (const pos of closed) {
      const lastStep = pos.progression?.find(s => s.step === "close")
      const exitPx = lastStep ? parseFloat(lastStep.details?.split("@ ")[1] || "0") : 0
      if (exitPx > 0 && pos.averageExecutionPrice > 0) {
        const pnl =
          pos.executedQuantity *
          (pos.direction === "long"
            ? exitPx - pos.averageExecutionPrice
            : pos.averageExecutionPrice - exitPx)
        totalPnL += pnl
        if (pnl > 0) winCount++
      }
    }

    return {
      totalFilled: allPositions.filter(p => p.status === "filled" || p.status === "open").length,
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
 * Reconcile Redis-tracked live positions with the exchange.
 *
 * For every Redis-tracked open position:
 *   - If present on the exchange: refresh markPrice / liqPrice / unrealizedPnL
 *   - If NOT present on the exchange: it was closed externally (SL/TP hit,
 *     liquidated, or manually closed). Transition to "closed", compute realised
 *     PnL, move to the closed archive, increment metrics, release the lock.
 *
 * Returns a summary usable for logging / API responses.
 */
export async function reconcileLivePositions(
  connectionId: string,
  exchangeConnector: any,
): Promise<{
  reconciled: number
  updated: number
  closed: number
  errors: number
}> {
  await initRedis()
  const client = getRedisClient()

  const summary = { reconciled: 0, updated: 0, closed: 0, errors: 0 }

  if (!exchangeConnector || typeof exchangeConnector.getPositions !== "function") {
    return summary
  }

  try {
    // One index scan instead of four — see identical fix in syncWithExchange().
    const allOpen = await getLivePositions(connectionId)
    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed",
    )

    if (openPositions.length === 0) return summary

    // Single batch fetch of ALL exchange positions rather than per-symbol
    // calls — dramatically fewer API hits when multiple positions are open.
    let exchangePositions: any[] = []
    try {
      exchangePositions = (await exchangeConnector.getPositions().catch(() => [])) || []
    } catch (err) {
      console.warn(`${LOG_PREFIX} reconcile getPositions failed:`, err instanceof Error ? err.message : String(err))
      return summary
    }

    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = String(ep.symbol || ep.Symbol || "").toUpperCase()
      if (!sym) continue
      const size = parseFloat(String(ep.size ?? ep.positionAmt ?? ep.quantity ?? "0"))
      if (!size) continue
      const sideRaw = String(ep.side ?? ep.positionSide ?? (size > 0 ? "long" : "short")).toLowerCase()
      const direction: "long" | "short" = (sideRaw.includes("short") || sideRaw === "sell") ? "short" : "long"
      exchangeMap.set(`${sym}|${direction}`, ep)
    }

    for (const pos of openPositions) {
      summary.reconciled++
      try {
        const mapKey = `${pos.symbol.toUpperCase()}|${pos.direction}`
        const exPos = exchangeMap.get(mapKey)

        if (exPos) {
          const markPrice = parseFloat(String(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice ?? "0"))
          const liqPrice  = parseFloat(String(exPos.liquidationPrice ?? exPos.liqPrice ?? "0"))
          const uPnl      = parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl ?? "0"))

          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice: markPrice || pos.exchangeData?.markPrice,
            liquidationPrice: liqPrice || pos.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl || pos.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          pos.updatedAt = Date.now()
          await client.setex(`live:position:${pos.id}`, 604800, JSON.stringify(pos)).catch(() => {})
          summary.updated++
        } else {
          // Position closed externally — compute PnL, move to archive.
          const exitPrice = pos.exchangeData?.markPrice || pos.averageExecutionPrice || pos.entryPrice
          const qty      = pos.executedQuantity || pos.quantity || 0
          const avgEntry = pos.averageExecutionPrice || pos.entryPrice || 0

          let realizedPnl = 0
          if (exitPrice > 0 && avgEntry > 0 && qty > 0) {
            realizedPnl = qty *
              (pos.direction === "long" ? exitPrice - avgEntry : avgEntry - exitPrice)
          }

          pos.status = "closed"
          pos.closedAt = Date.now()
          pos.realizedPnL = realizedPnl
          pos.closeReason = pos.closeReason || "exchange_reconciliation"
          pos.progression.push({
            step: "close",
            timestamp: Date.now(),
            success: true,
            details: `Reconciled @ ${exitPrice.toFixed(8)} PnL=${realizedPnl.toFixed(4)}`,
          })
          pos.updatedAt = Date.now()

          // Reuse the savePosition terminal-archival behaviour inline to
          // avoid a circular import / extra Redis GET.
          const openIndexKey   = `live:positions:${connectionId}`
          const closedIndexKey = `live:positions:${connectionId}:closed`
          const movedMarker    = `live:positions:${connectionId}:moved:${pos.id}`

          // Persist the updated position, then check the idempotent move
          // marker so we don't double-archive. Everything after the marker
          // check is independent — fan it out in a single Promise.all so each
          // reconciliation pays one RTT window instead of ~7 sequential ones.
          await client.setex(`live:position:${pos.id}`, 604800, JSON.stringify(pos)).catch(() => {})
          const alreadyMoved = await client.get(movedMarker).catch(() => null)

          const progKey = `progression:${connectionId}`
          const writes: Promise<any>[] = [
            client.hincrby(progKey, "live_positions_closed_count", 1).catch(() => {}),
            client.expire(progKey, 7 * 24 * 60 * 60).catch(() => {}),
            client.del(`live:lock:${connectionId}:${pos.symbol}:${pos.direction}`).catch(() => {}),
          ]
          if (realizedPnl > 0) {
            writes.push(client.hincrby(progKey, "live_wins_count", 1).catch(() => {}))
          }
          if (!alreadyMoved) {
            writes.push(
              client.lrem(openIndexKey, 0, pos.id).catch(() => {}),
              client.lpush(closedIndexKey, pos.id).catch(() => {}),
              client.ltrim(closedIndexKey, 0, 4999).catch(() => {}),
              client.expire(closedIndexKey, 30 * 24 * 60 * 60).catch(() => {}),
              client.setex(movedMarker, 604800, "1").catch(() => {}),
            )
          }
          await Promise.all(writes)

          summary.closed++
        }
      } catch (err) {
        summary.errors++
        console.warn(
          `${LOG_PREFIX} reconcile per-position error for ${pos.id}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (summary.closed > 0 || summary.updated > 0) {
      console.log(
        `${LOG_PREFIX} ${connectionId} reconciled=${summary.reconciled} updated=${summary.updated} closed=${summary.closed}`
      )
    }

    return summary
  } catch (err) {
    console.error(`${LOG_PREFIX} reconcileLivePositions fatal:`, err)
    return summary
  }
}

/**
 * Sync live positions with exchange data (mark price, liq price, unrealized PnL).
 * Called periodically by the engine monitoring loop.
 */
export async function syncWithExchange(connectionId: string, exchangeConnector: any): Promise<void> {
  await initRedis()
  const client = getRedisClient()

  try {
    // Previously each status filter triggered a full getLivePositions() scan,
    // meaning we fetched the same open-positions index from Redis FOUR times
    // just to bucket by status. Load once, then filter in memory.
    const allOpen = await getLivePositions(connectionId)
    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed",
    )

    if (openPositions.length === 0) {
      return
    }

    console.log(`${LOG_PREFIX} Syncing ${openPositions.length} open/placed positions with exchange`)

    for (const position of openPositions) {
      try {
        const exchangePos = await exchangeConnector.getPosition(position.symbol)
        if (exchangePos) {
          position.exchangeData = {
            marginType: (exchangePos as any).marginType,
            markPrice: (exchangePos as any).markPrice,
            liquidationPrice: (exchangePos as any).liquidationPrice,
            unrealizedPnl: (exchangePos as any).unrealizedPnl,
            roi: (exchangePos as any).roi,
          }
          position.updatedAt = Date.now()
          const key = `live:position:${position.id}`
          await client.setex(key, 604800, JSON.stringify(position))
        }

        if (position.status === "placed" && position.orderId) {
          try {
            const order = await exchangeConnector.getOrder(position.symbol, position.orderId)
            if (order?.status === "filled") {
              position.executedQuantity = order.filledQty || position.quantity
              position.remainingQuantity = Math.max(0, position.quantity - position.executedQuantity)
              position.averageExecutionPrice = order.filledPrice || position.entryPrice
              position.status = "open"
              position.updatedAt = Date.now()
              const key = `live:position:${position.id}`
              await client.setex(key, 604800, JSON.stringify(position))
              await incrementMetric(connectionId, "live_orders_filled_count")
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "info",
                `Sync detected fill for ${position.symbol}`,
                {
                  orderId: position.orderId,
                  filledQty: position.executedQuantity,
                }
              )
            }
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error syncing ${position.id}:`, err)
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
