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
  // ── Accumulation tracking ──────────────────────────────────────────
  // When multiple upstream Sets (or the same Set firing repeatedly via
  // DCA / pyramiding) want to enter on the same symbol+direction, we
  // ADD their computed volumes into a single exchange position instead
  // of rejecting duplicates. These fields document the consolidation
  // history so the UI can show "this 1 exchange order absorbed N Set
  // signals" and so reconcile knows the SL/TP levels need to track the
  // weighted-average entry, not just the very first fill.
  accumulationCount?: number               // number of Set signals merged in (1 = single entry)
  lastAccumulatedAt?: number               // timestamp of the most recent merge
  accumulatedRealPositionIds?: string[]    // upstream Real position ids that contributed
  // ── Set lineage (optional, threaded from Main → Real → Live) ────────
  // These fields preserve the *Set Type* context that produced this
  // exchange position. They let post-trade statistics dimensionalise
  // realised PnL by:
  //   - variant         (default / trailing / block / dca / pause)
  //   - axisWindows     (which prev/last/cont/pause window was active)
  //   - parentSetKey    (the Base Set the Main variant was derived from)
  //   - setKey          (the materialised Main Set's identifier)
  //
  // All optional so legacy code paths that don't have lineage info
  // (manual exchange operations, reconciliation) still work. When
  // present, accumulation merges *do not* overwrite the original
  // lineage — the first Set that opened the position keeps authorship,
  // and subsequent absorbed Sets are appended into `accumulatedSetKeys`.
  setKey?: string
  parentSetKey?: string
  setVariant?: "default" | "trailing" | "block" | "dca" | "pause"
  axisWindows?: { prev: number; last: number; cont: number; pause: number }
  /** All upstream Set ids that contributed to this exchange position
   *  (initial entry plus every accumulation). Useful for "which Sets
   *  realised this PnL" stats. */
  accumulatedSetKeys?: string[]
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
 * Find the existing open live position (if any) for a given symbol +
 * direction on a connection. Returns the most recently created one if
 * multiple are somehow in the open index (defensive — should not happen
 * given the dedup lock, but indices can drift after restarts/migrations).
 *
 * Used by `executeLivePosition` to merge incoming Set signals into the
 * already-running exchange order rather than rejecting them.
 */
async function findOpenLivePositionByDir(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
): Promise<LivePosition | null> {
  try {
    const all = await getLivePositions(connectionId)
    const candidates = all.filter(
      (p) =>
        p.symbol === symbol &&
        p.direction === direction &&
        // "open" is the steady state; "placed" / "partially_filled" / "filled"
        // also count as live for accumulation purposes (entry order in flight
        // or partially executed — we still want to add to it). We do NOT
        // accumulate into "pending" because that means the entry order itself
        // hasn't been placed yet — better to let the original call finish.
        ["open", "placed", "partially_filled", "filled"].includes(p.status),
    )
    if (candidates.length === 0) return null
    // Most recent first — defensive against stale duplicates.
    candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return candidates[0]
  } catch (err) {
    console.warn(`${LOG_PREFIX} findOpenLivePositionByDir error:`, err)
    return null
  }
}

/**
 * Merge a new Set signal (RealPosition) into an existing live exchange
 * position. Places an additional market entry on the exchange so the
 * position size grows by the newly computed volume, then re-arms SL/TP
 * at the new weighted-average entry price.
 *
 * Result invariants after this returns successfully:
 *   • `existing.executedQuantity` = sum of all fills (old + new).
 *   • `existing.averageExecutionPrice` = qty-weighted mean of all fills.
 *   • `existing.volumeUsd`            = sum of (fillQty × fillPrice) per fill.
 *   • `existing.fills[]`              = old fills + new fill appended.
 *   • `existing.stopLossPrice` / `takeProfitPrice` recomputed from the
 *     new average via `updateProtectionOrders` (cancel-old → place-new
 *     at the correct level AND the new total quantity).
 *   • `existing.accumulationCount`     incremented.
 *   • `existing.accumulatedRealPositionIds` includes `realPosition.id`.
 *
 * Returns the updated LivePosition. Never throws — failures are recorded
 * as a failed `accumulate` progression step and the position is left
 * untouched (the new Set's volume simply isn't added).
 */
async function accumulateIntoLivePosition(
  connectionId: string,
  existing: LivePosition,
  realPosition: RealPosition,
  currentPrice: number,
  exchangeConnector: any,
): Promise<LivePosition> {
  const symbol = realPosition.symbol
  const exchangeSide: "buy" | "sell" = realPosition.direction === "long" ? "buy" : "sell"

  try {
    // ── 1. Compute additional volume (always honors min) ───────────────
    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      symbol,
      currentPrice,
    ).catch((err) => {
      console.error(`${LOG_PREFIX} accumulate volume calc error:`, err)
      return null
    })

    let addQty = volumeResult?.finalVolume || volumeResult?.volume || 0
    if (addQty <= 0 || !Number.isFinite(addQty)) {
      const FALLBACK_NOTIONAL_USD = 5
      addQty = currentPrice > 0 ? FALLBACK_NOTIONAL_USD / currentPrice : 0
    }
    if (addQty <= 0) {
      pushStep(existing, "accumulate", false, "additional volume could not be computed")
      await savePosition(existing)
      return existing
    }

    // ── 2. Place additional entry on the exchange ─────────────────────
    const orderResult: any = await retry(
      () =>
        exchangeConnector.placeOrder(
          symbol,
          exchangeSide,
          addQty,
          undefined,
          "market",
          { positionSide: realPosition.direction === "long" ? "LONG" : "SHORT" },
        ),
      (r) => !!r?.success && !!(r.orderId || r.id),
      "accumulatePlaceOrder",
    )

    if (!orderResult?.success || !(orderResult.orderId || orderResult.id)) {
      pushStep(
        existing,
        "accumulate",
        false,
        `additional order failed: ${orderResult?.error || "unknown"}`,
      )
      await savePosition(existing)
      await incrementMetric(connectionId, "live_orders_failed_count")
      // Same cooldown trigger as the primary entry-order path —
      // accumulation orders also count toward the margin-error gate.
      if (isNonRecoverableExchangeError(orderResult)) {
        recordMarginError(connectionId)
      }
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Accumulation entry failed for ${symbol} — kept existing position untouched`,
        {
          existingId: existing.id,
          additionalQty: addQty,
          error: orderResult?.error,
        },
      )
      return existing
    }

    const addOrderId: string = orderResult.orderId || orderResult.id
    pushStep(existing, "accumulate_place", true, `addQty=${addQty.toFixed(6)} orderId=${addOrderId}`)

    // ── 3. Poll the new fill ──────────────────────────────────────────
    const fill = await pollOrderFill(exchangeConnector, symbol, addOrderId)
    if (!fill.filled || fill.filledQty <= 0) {
      pushStep(existing, "accumulate_fill", false, `fill not confirmed (status=${fill.status})`)
      await savePosition(existing)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Accumulation fill not confirmed for ${symbol}`,
        { addOrderId, status: fill.status },
      )
      return existing
    }

    const newFillQty = fill.filledQty
    const newFillPrice = fill.filledPrice || currentPrice

    // ── 4. Recompute weighted-average entry + cumulative volume ──────
    // Compute against the running totals so this is correct whether the
    // existing position has had 1 fill or already accumulated N times.
    const oldQty = existing.executedQuantity || 0
    const oldAvg = existing.averageExecutionPrice || existing.entryPrice || 0
    const oldNotional = oldQty * oldAvg
    const newNotional = newFillQty * newFillPrice
    const totalQty = oldQty + newFillQty
    const newAvg = totalQty > 0 ? (oldNotional + newNotional) / totalQty : newFillPrice

    existing.executedQuantity = totalQty
    existing.remainingQuantity = 0
    existing.averageExecutionPrice = newAvg
    // volumeUsd is the cumulative notional summed across all fills —
    // the authoritative real-money exposure on the exchange. We add the
    // *new* fill's notional to whatever was already accumulated.
    existing.volumeUsd = (existing.volumeUsd || 0) + newNotional
    existing.fills.push({
      timestamp: Date.now(),
      quantity: newFillQty,
      price: newFillPrice,
      fee: 0,
      feeAsset: "USDT",
    })
    existing.accumulationCount = (existing.accumulationCount || 1) + 1
    existing.lastAccumulatedAt = Date.now()
    existing.accumulatedRealPositionIds = [
      ...(existing.accumulatedRealPositionIds || []),
      realPosition.id,
    ].slice(-50) // cap to last 50 to bound payload size
    // Track which Set keys contributed to this exchange position so
    // post-trade stats can attribute realised PnL across every Set Type
    // that absorbed into it. Same 50-entry cap as the realPositionIds
    // ledger above; the original setKey is preserved on the position
    // header (`existing.setKey`) so we never lose authorship.
    if (realPosition.setKey) {
      existing.accumulatedSetKeys = [
        ...(existing.accumulatedSetKeys || []),
        realPosition.setKey,
      ].slice(-50)
    }
    existing.updatedAt = Date.now()
    if (existing.status === "filled" || existing.status === "partially_filled") {
      existing.status = "open"
    }

    pushStep(
      existing,
      "accumulate_fill",
      true,
      `+${newFillQty.toFixed(6)} @ ${newFillPrice.toFixed(8)} → totalQty=${totalQty.toFixed(6)} avgEntry=${newAvg.toFixed(8)} accCount=${existing.accumulationCount}`,
    )
    await incrementMetric(connectionId, "live_orders_filled_count")
    await incrementMetric(connectionId, "live_orders_accumulated_count")
    await incrementMetric(connectionId, "live_volume_usd_total", Math.round(newNotional))
    // ── Used-balance (margin) counter ──────────────────────────────
    // Spec: every "USDT" surface in the UI must show the *used balance*
    // (margin actually committed) and NOT the leveraged notional. The
    // leveraged figure is `newNotional` (qty × price); the matching
    // margin figure is `newNotional / leverage`. We persist it as a
    // sibling of `live_volume_usd_total` so the dashboard can switch
    // surfaces over without losing the historical notional series.
    {
      const lev = Math.max(1, Number(existing.leverage) || 1)
      const newMargin = newNotional / lev
      if (Number.isFinite(newMargin) && newMargin > 0) {
        await incrementMetric(connectionId, "live_margin_usd_total", Math.round(newMargin))
      }
    }

    // ── 5. Re-arm SL/TP at NEW weighted-avg entry + NEW total qty ────
    // updateProtectionOrders will:
    //   - detect the SL/TP price drift caused by the new avg entry
    //   - cancel the old reduce-only orders
    //   - place new ones at the correct level AND the new total qty
    // Drift tolerance is 0.25%; for typical accumulation merges the
    // average moves more than that, so this almost always fires.
    try {
      await updateProtectionOrders(exchangeConnector, existing, "accumulation")
    } catch (slTpErr) {
      console.warn(
        `${LOG_PREFIX} accumulation SL/TP rearm error:`,
        slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
      )
    }

    await savePosition(existing)
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "info",
      `Accumulated into existing ${symbol} ${realPosition.direction} position`,
      {
        existingId: existing.id,
        addedQty: newFillQty,
        addedNotionalUsd: Math.round(newNotional * 100) / 100,
        newTotalQty: totalQty,
        newAvgEntry: newAvg,
        newSlPrice: existing.stopLossPrice,
        newTpPrice: existing.takeProfitPrice,
        accumulationCount: existing.accumulationCount,
        realPositionId: realPosition.id,
      },
    )

    console.log(
      `${LOG_PREFIX} ACCUMULATED ${symbol} ${realPosition.direction}: +${newFillQty} @ ${newFillPrice} → total=${totalQty} avg=${newAvg.toFixed(8)} count=${existing.accumulationCount}`,
    )

    return existing
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`${LOG_PREFIX} accumulateIntoLivePosition error:`, errMsg)
    pushStep(existing, "accumulate", false, errMsg)
    await savePosition(existing).catch(() => {})
    return existing
  }
}

/**
 * Recognise exchange errors that CANNOT be fixed by retrying. For these
 * the operator must take an out-of-band action (top up margin, fix
 * leverage, restore symbol availability). Retrying just slams the
 * exchange and burns event-loop time on hopeless attempts.
 *
 * Currently catches:
 *   • BingX 101204 — Insufficient margin (top-up required)
 *   • BingX 80012  — Symbol not available for trading
 *   • Any error containing "insufficient margin" / "insufficient balance"
 *     / "not enough" (cross-exchange variants we may encounter)
 */
function isNonRecoverableExchangeError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    text = String(obj.error ?? obj.message ?? "")
  } else {
    text = String(payload)
  }
  if (!text) return false
  const lc = text.toLowerCase()
  return (
    /\bcode\s*=?\s*101204\b/.test(text) ||
    /\bcode\s*=?\s*80012\b/.test(text) ||
    lc.includes("insufficient margin") ||
    lc.includes("insufficient balance") ||
    lc.includes("not enough margin") ||
    lc.includes("not enough balance")
  )
}

/**
 * Retry a promise-returning function with exponential backoff.
 *
 * Short-circuits on non-recoverable exchange errors (insufficient margin,
 * symbol not tradable, etc.) — see `isNonRecoverableExchangeError`. This
 * stops the engine from making 3 hopeless API calls per signal cycle when
 * the user has no balance, which was producing ~20 failed exchange calls
 * per second under the observed cycle cadence.
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
      // The connector returned `{ success: false, error: "…" }` — check
      // whether that error is non-recoverable and bail early if so.
      if (isNonRecoverableExchangeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return result
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} error:`, err)
      // Thrown error variant — check the same predicate.
      if (isNonRecoverableExchangeError(err)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      lastResult = undefined as unknown as T
    }
    if (attempt < maxAttempts) {
      const backoff = Math.pow(2, attempt - 1) * 500
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  return lastResult as T
}

// ── Per-connection cooldown after non-recoverable margin errors ──────
//
// When `executeLivePosition` fails with `code=101204` (Insufficient margin)
// the operator's account literally has no funds — nothing the engine can
// do programmatically will help. Without a cooldown, every Set evaluation
// on the next cycle re-attempts the order, generating a continuous
// stream of failed exchange API calls (~20/sec at observed cadence).
//
// We track the last margin-error timestamp PER CONNECTION in this
// module-level Map and short-circuit `executeLivePosition` for
// `MARGIN_ERROR_COOLDOWN_MS` after a hit. The skipped attempt is logged
// once per cycle and recorded as a `warning` progression event so the
// operator sees it in the dashboard.
//
// 60 s is the sweet spot: long enough to stop the API flood, short
// enough that the system resumes promptly after a top-up. Operators
// typically deposit and refresh within that window.
const MARGIN_ERROR_COOLDOWN_MS = 60_000
const marginErrorCooldownByConnection: Map<string, number> = new Map()

function isMarginCooldownActive(connectionId: string): boolean {
  const ts = marginErrorCooldownByConnection.get(connectionId)
  if (!ts) return false
  if (Date.now() - ts < MARGIN_ERROR_COOLDOWN_MS) return true
  marginErrorCooldownByConnection.delete(connectionId)
  return false
}

function recordMarginError(connectionId: string): void {
  marginErrorCooldownByConnection.set(connectionId, Date.now())
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
 * Cancel an SL/TP order on the exchange. Tolerates "order not found" and
 * other recoverable errors silently — the typical reason this is called
 * is that the position is being closed or the protection order is being
 * replaced, both of which mean we don't care if it's already gone.
 *
 * Returns `true` only when we actively confirmed cancellation (or that
 * the connector accepted the request); returns `false` for any error so
 * callers can decide whether to retry or fall through to a market exit.
 */
async function cancelProtectionOrder(
  connector: any,
  symbol: string,
  orderId: string | undefined,
  label: string,
): Promise<boolean> {
  if (!orderId) return false
  try {
    if (typeof connector?.cancelOrder !== "function") return false
    const res = await connector.cancelOrder(symbol, orderId)
    if (res?.success) {
      console.log(`${LOG_PREFIX} ${label} cancelled: ${orderId}`)
      return true
    }
    // Treat "not found" / "already filled" / "already cancelled" as success
    // for our purposes — the exchange-side state is already what we wanted.
    const errStr = String(res?.error || "").toLowerCase()
    if (
      errStr.includes("not found") ||
      errStr.includes("not exist") ||
      errStr.includes("already") ||
      errStr.includes("filled") ||
      errStr.includes("cancelled") ||
      errStr.includes("canceled")
    ) {
      console.log(`${LOG_PREFIX} ${label} already gone: ${orderId} (${res?.error})`)
      return true
    }
    console.warn(`${LOG_PREFIX} ${label} cancel failed: ${orderId} — ${res?.error}`)
    return false
  } catch (err) {
    console.warn(`${LOG_PREFIX} ${label} cancel error:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Place a protection order (SL or TP) as a reduce-only limit order at
 * `triggerPrice` that *closes* (never opens) a position.
 *
 * On hedge-mode perp accounts the connector needs to know the positionSide
 * of the OPEN position (LONG/SHORT), which is independent of the order's
 * close side. Passing `reduceOnly=true` + the correct `positionSide` is
 * what prevents the exchange from treating this as a new opposite-side
 * entry and hedging against the real position.
 */
async function placeProtectionOrder(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  quantity: number,
  triggerPrice: number,
  orderLabel: string,
  positionDirection: "long" | "short",
): Promise<string | null> {
  try {
    if (typeof connector.placeOrder !== "function") return null
    const result = await connector.placeOrder(
      symbol,
      closeSide,
      quantity,
      triggerPrice,
      "limit",
      {
        reduceOnly: true,
        positionSide: positionDirection === "long" ? "LONG" : "SHORT",
      },
    )
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

/**
 * Derive the desired SL/TP trigger prices from a live position's current
 * percentage settings and average execution price. Returns `0` for either
 * leg when the corresponding percentage is non-positive (i.e. SL/TP is
 * disabled for that side). Pure function — does NOT touch the exchange.
 */
function computeDesiredProtectionPrices(pos: LivePosition): {
  desiredSl: number
  desiredTp: number
} {
  const fillPrice = pos.averageExecutionPrice || pos.entryPrice
  if (!fillPrice || fillPrice <= 0) return { desiredSl: 0, desiredTp: 0 }

  const slPct = Math.max(0, pos.stopLoss || 0) / 100
  const tpPct = Math.max(0, pos.takeProfit || 0) / 100

  const desiredSl =
    slPct > 0
      ? pos.direction === "long"
        ? fillPrice * (1 - slPct)
        : fillPrice * (1 + slPct)
      : 0
  const desiredTp =
    tpPct > 0
      ? pos.direction === "long"
        ? fillPrice * (1 + tpPct)
        : fillPrice * (1 - tpPct)
      : 0

  return { desiredSl, desiredTp }
}

/**
 * Has the desired protection price drifted enough from the currently
 * placed one to warrant cancelling and re-placing? We use 0.25% as the
 * tolerance — tighter than that and we'd thrash the exchange API on
 * every tiny rounding diff. Looser and we'd leave stale levels in place
 * after a real strategy adjustment.
 */
function priceDrifted(current: number | undefined, desired: number): boolean {
  if (!desired || desired <= 0) return false
  if (!current || current <= 0) return true // never placed or lost
  return Math.abs(current - desired) / desired > 0.0025
}

/**
 * Reconcile the SL/TP exchange orders against the live position's current
 * desired levels. Three cases per leg (SL and TP independently):
 *
 *   1. Desired = 0 (disabled) and an order is still on the exchange:
 *      cancel it. Common after an operator turns off SL or TP mid-trade.
 *   2. No order recorded (or order id stale) and desired > 0:
 *      place a fresh protection order.
 *   3. Order id present BUT price drifted (>0.25%) from desired:
 *      cancel old → place new at correct level. Cancel-first guarantees
 *      we never accidentally double-protect (which would produce two
 *      reduce-only fills against the same exchange position).
 *
 * Updates `pos.stopLossOrderId`, `pos.takeProfitOrderId`, `pos.stopLossPrice`,
 * `pos.takeProfitPrice` to reflect what's now actually live on the exchange.
 *
 * Returns a boolean indicating whether anything changed (so callers can
 * decide whether to persist the position).
 */
async function updateProtectionOrders(
  connector: any,
  pos: LivePosition,
  reason: string,
): Promise<{ changed: boolean; slPlaced: boolean; tpPlaced: boolean }> {
  const result = { changed: false, slPlaced: false, tpPlaced: false }
  if (!connector || pos.executedQuantity <= 0) return result

  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(pos)
  const closeSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"

  // ── Stop-Loss leg ────────────────────────────────────────────────────
  if (desiredSl <= 0 && pos.stopLossOrderId) {
    // SL was turned off — yank the existing order.
    await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
    pos.stopLossOrderId = undefined
    pos.stopLossPrice = 0
    result.changed = true
  } else if (desiredSl > 0 && (!pos.stopLossOrderId || priceDrifted(pos.stopLossPrice, desiredSl))) {
    if (pos.stopLossOrderId) {
      await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
    }
    const id = await placeProtectionOrder(
      connector,
      pos.symbol,
      closeSide,
      pos.executedQuantity,
      desiredSl,
      "StopLoss",
      pos.direction,
    )
    pos.stopLossOrderId = id || undefined
    pos.stopLossPrice = desiredSl
    result.changed = true
    result.slPlaced = !!id
  }

  // ── Take-Profit leg ──────────────────────────────────────────────────
  if (desiredTp <= 0 && pos.takeProfitOrderId) {
    await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit")
    pos.takeProfitOrderId = undefined
    pos.takeProfitPrice = 0
    result.changed = true
  } else if (desiredTp > 0 && (!pos.takeProfitOrderId || priceDrifted(pos.takeProfitPrice, desiredTp))) {
    if (pos.takeProfitOrderId) {
      await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit")
    }
    const id = await placeProtectionOrder(
      connector,
      pos.symbol,
      closeSide,
      pos.executedQuantity,
      desiredTp,
      "TakeProfit",
      pos.direction,
    )
    pos.takeProfitOrderId = id || undefined
    pos.takeProfitPrice = desiredTp
    result.changed = true
    result.tpPlaced = !!id
  }

  if (result.changed) {
    pushStep(
      pos,
      "update_sl_tp",
      true,
      `[${reason}] SL=${pos.stopLossPrice ? pos.stopLossPrice.toFixed(6) : "—"} (${pos.stopLossOrderId || "—"}) TP=${pos.takeProfitPrice ? pos.takeProfitPrice.toFixed(6) : "—"} (${pos.takeProfitOrderId || "—"})`,
    )
    await logProgressionEvent(
      pos.connectionId,
      "live_trading",
      "info",
      `SL/TP updated for ${pos.symbol} (${reason})`,
      {
        slOrderId: pos.stopLossOrderId,
        slPrice: pos.stopLossPrice,
        tpOrderId: pos.takeProfitOrderId,
        tpPrice: pos.takeProfitPrice,
      },
    )
  }

  return result
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

  // ── Non-recoverable-error cooldown gate ──
  //
  // If we hit `code=101204` (Insufficient margin) within the last
  // MARGIN_ERROR_COOLDOWN_MS, skip this attempt entirely and return a
  // synthetic "rejected" LivePosition. This prevents every Set evaluation
  // in a no-balance state from spamming the BingX API with hopeless
  // orders that just slow the event loop.
  //
  // Rationale: the operator must top up — there is no engine-side fix.
  // The skip is silent at console level after the first occurrence so
  // logs stay readable; the progression event still records it once per
  // skipped attempt for dashboard visibility.
  if (isMarginCooldownActive(connectionId)) {
    const skipped: LivePosition = {
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
      status: "rejected",
      statusReason:
        "Skipped — connection in margin-error cooldown (top up exchange balance to resume live trading)",
      fills: [],
      progression: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setKey: realPosition.setKey,
      parentSetKey: realPosition.parentSetKey,
      setVariant: realPosition.setVariant,
      axisWindows: realPosition.axisWindows,
      accumulatedSetKeys: realPosition.setKey ? [realPosition.setKey] : [],
    }
    pushStep(skipped, "preflight", false, skipped.statusReason)
    // Don't await — fire-and-forget is fine for the cooldown skip log.
    logProgressionEvent(connectionId, "live_trading", "warning", skipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
    }).catch(() => {})
    return skipped
  }

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
    // ── Set lineage propagation (Main → Real → Live) ──────────────────
    // Carry the Set Type metadata from the upstream RealPosition into
    // this LivePosition verbatim. The exchange-position storage layer
    // serialises the entire LivePosition, so these fields ride along
    // for free and become available to post-trade statistics queries.
    // `accumulatedSetKeys` is seeded with the originating setKey so
    // accumulation merges later append onto a non-empty list (rather
    // than having to special-case the first entry).
    setKey:        realPosition.setKey,
    parentSetKey:  realPosition.parentSetKey,
    setVariant:    realPosition.setVariant,
    axisWindows:   realPosition.axisWindows,
    accumulatedSetKeys: realPosition.setKey ? [realPosition.setKey] : [],
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

    // ── Coordination: accumulate instead of reject ──────────────────
    // When a Set tries to enter on a symbol+direction that already has
    // an open exchange position, we no longer drop the signal — we
    // ROUTE the new volume into the existing position so the exchange
    // exposure equals the SUM of every contributing Set's coordination-
    // derived volume. The accumulator places an additional market
    // order, recomputes the weighted-average entry, and re-arms SL/TP
    // at the new effective levels. Live-trade gating still applies:
    // if `live_trade=false` we fall through to the simulation branch
    // below (no exchange call, just records the intent).
    if (
      isLiveTradeEnabled &&
      (await hasOpenLivePosition(connectionId, realPosition.symbol, realPosition.direction))
    ) {
      // Resolve the actual existing position so we have its avg entry,
      // cumulative qty, and current SL/TP order ids to merge into.
      const existing = await findOpenLivePositionByDir(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
      )

      if (!existing) {
        // Lock says one is open but the index can't find it — likely a
        // stale lock from a previous crash. Release it and let this
        // call fall through to the normal new-position path below.
        console.warn(
          `${LOG_PREFIX} stale dedup lock for ${realPosition.symbol} ${realPosition.direction} — releasing and proceeding with fresh entry`,
        )
        await releaseLock(connectionId, realPosition.symbol, realPosition.direction)
      } else {
        // Need a price to compute additional volume + retain it for the
        // accumulator. Reuse fetchCurrentPrice with the realPosition
        // entry-price hint so we don't pay two fetches for the same tick.
        let accPrice = realPosition.entryPrice
        if (!accPrice || accPrice <= 0) accPrice = await fetchCurrentPrice(realPosition.symbol)

        // Skip-paths: when we can't accumulate right now (no market price
        // or no connector), we record the deferral on the EXISTING
        // position's progression rather than persisting the throw-away
        // `livePosition` placeholder into the open index. Reconcile will
        // pick up market data and a fresh signal on the next cycle.
        if (!accPrice || accPrice <= 0) {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            `no market price for ${realPosition.symbol} — accumulation deferred`,
          )
          await savePosition(existing)
          return existing
        }

        if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            "exchange connector unavailable — accumulation deferred",
          )
          await savePosition(existing)
          return existing
        }

        const merged = await accumulateIntoLivePosition(
          connectionId,
          existing,
          realPosition,
          accPrice,
          exchangeConnector,
        )
        // Return the (now updated) existing position. We do NOT save the
        // throw-away `livePosition` placeholder into the open index —
        // accumulateIntoLivePosition owns the persistence of `existing`.
        return merged
      }
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
    // POLICY: minimum volume is ALWAYS enforced — we never reject a live
    // order for "qty too small". If the calculator returns null or a
    // non-positive quantity (e.g. balance fetch failed, NaN math) we
    // synthesize a fallback at the universal $5-notional floor and
    // continue. This keeps the operator's signal flow uninterrupted
    // and matches the documented behavior of `VolumeCalculator`.
    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    let computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    let volumeNote = ""
    if (computedVolume <= 0 || !Number.isFinite(computedVolume)) {
      // Synthesize at $5 notional / currentPrice so the order still has a
      // valid size. Any subsequent exchange-side rejection (e.g. a venue
      // requiring a higher minimum) will then come back from the connector
      // with a real error, not from us pre-emptively dropping the signal.
      const FALLBACK_NOTIONAL_USD = 5
      computedVolume = currentPrice > 0
        ? FALLBACK_NOTIONAL_USD / currentPrice
        : 0
      volumeNote = ` [synthesized-min: $${FALLBACK_NOTIONAL_USD} notional fallback — calculator returned ${volumeResult?.finalVolume ?? "null"}]`
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `Live order volume synthesized to enforced minimum for ${realPosition.symbol}`,
        {
          reason: volumeResult?.adjustmentReason || "calculator returned no usable quantity",
          fallbackNotionalUsd: FALLBACK_NOTIONAL_USD,
          synthesizedQty: computedVolume,
        }
      )
    }

    livePosition.quantity = computedVolume
    livePosition.remainingQuantity = computedVolume
    livePosition.volumeUsd = computedVolume * currentPrice
    livePosition.leverage = volumeResult?.leverage || livePosition.leverage

    // If the volume calculator clamped the quantity UP to the exchange
    // minimum (or we synthesized a fallback above), surface that in the
    // progression step so the UI / logs show *why* the executed qty
    // differs from the coordination-derived qty rather than just a bare
    // number. The step is always recorded as successful because the
    // order itself is valid — minimum enforcement never fails the trade.
    const clampNote = volumeResult?.volumeAdjusted && volumeResult.adjustmentReason
      ? ` [clamped-to-min: ${volumeResult.adjustmentReason}]`
      : ""
    pushStep(
      livePosition,
      "volume_calc",
      true,
      `qty=${computedVolume.toFixed(6)} usd=${livePosition.volumeUsd.toFixed(2)} lev=${livePosition.leverage}x${clampNote}${volumeNote}`
    )
    if (volumeResult) {
      await VolumeCalculator.logVolumeCalculation(connectionId, realPosition.symbol, volumeResult).catch(() => {})
    }

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

    // For perp entries we pass the explicit positionSide matching the real
    // position direction so hedge-mode accounts route correctly. Connectors
    // that don't care about the options object simply ignore the 6th arg.
    // BingX's one-way-mode accounts auto-retry without positionSide if the
    // exchange rejects it (code 80014), so this is safe for both modes.
    const orderResult: any = await retry(
      () => exchangeConnector.placeOrder(
        realPosition.symbol,
        exchangeSide,
        computedVolume,
        undefined,
        "market",
        {
          positionSide: realPosition.direction === "long" ? "LONG" : "SHORT",
        },
      ),
      r => !!r?.success && !!(r.orderId || r.id),
      "placeOrder"
    )

    if (!orderResult?.success || !(orderResult.orderId || orderResult.id)) {
      livePosition.status = "error"
      livePosition.statusReason = `Entry order failed: ${orderResult?.error || "unknown"}`
      pushStep(livePosition, "place_order", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")

      // Arm the per-connection cooldown when the failure was a
      // non-recoverable margin/balance error. This stops the engine
      // from re-attempting on every subsequent cycle and lets the
      // operator top up without the API getting hammered.
      if (isNonRecoverableExchangeError(orderResult)) {
        recordMarginError(connectionId)
      }

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
        "StopLoss",
        realPosition.direction,
      )
      const tpOrderId = await placeProtectionOrder(
        exchangeConnector,
        realPosition.symbol,
        sideClose,
        livePosition.executedQuantity,
        tpPrice,
        "TakeProfit",
        realPosition.direction,
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
    // Used-balance (margin) cumulative counter — see accumulation
    // path above for the rationale. Always increment in lock-step
    // with `live_volume_usd_total` so the two series stay aligned.
    {
      const lev = Math.max(1, Number(livePosition.leverage) || 1)
      const newMargin = (livePosition.volumeUsd || 0) / lev
      if (Number.isFinite(newMargin) && newMargin > 0) {
        await incrementMetric(connectionId, "live_margin_usd_total", Math.round(newMargin))
      }
    }
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
 *
 * Order of operations is critical to avoid orphan orders & leaked indices:
 *   1. Cancel any open SL/TP orders FIRST so the exchange-side close
 *      doesn't race against a still-active reduce-only sitting in the
 *      book (which would either double-fire or leave a stale order
 *      glued to the user's account).
 *   2. Issue the actual close on the exchange (best-effort; if it fails
 *      we still mark the Redis record closed so reconcile picks it up
 *      next pass — better than leaking the lock).
 *   3. Compute realized PnL + margin-based ROI (matches exchange ROE).
 *   4. Persist via savePosition() — that helper already handles the
 *      open-index → closed-archive move idempotently. We do NOT touch
 *      Redis directly any more (which previously left the position in
 *      the open index forever on manual close).
 *   5. Release the dedup lock so a subsequent signal can re-enter.
 */
export async function closeLivePosition(
  connectionId: string,
  livePositionId: string,
  closePrice: number,
  exchangeConnector?: any,
  closeReason: string = "manual",
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)

    // ── 1. Cancel orphan SL/TP orders BEFORE the close ────────────────
    if (exchangeConnector) {
      const cancellations: Promise<boolean>[] = []
      if (position.stopLossOrderId) {
        cancellations.push(
          cancelProtectionOrder(exchangeConnector, position.symbol, position.stopLossOrderId, "StopLoss"),
        )
      }
      if (position.takeProfitOrderId) {
        cancellations.push(
          cancelProtectionOrder(exchangeConnector, position.symbol, position.takeProfitOrderId, "TakeProfit"),
        )
      }
      if (cancellations.length > 0) {
        const results = await Promise.all(cancellations)
        pushStep(
          position,
          "cancel_protection",
          results.every(Boolean),
          `cancelled SL=${!!position.stopLossOrderId} TP=${!!position.takeProfitOrderId}`,
        )
        // Clear local record regardless — orders that didn't cancel
        // cleanly will be reconciled away on next reconcile pass.
        position.stopLossOrderId = undefined
        position.takeProfitOrderId = undefined
      }
    }

    // ── 2. Issue the close on the exchange ────────────────────────────
    let exchangeCloseSuccess = false
    if (exchangeConnector && typeof exchangeConnector.closePosition === "function") {
      try {
        const r = await exchangeConnector.closePosition(position.symbol, position.direction)
        exchangeCloseSuccess = r?.success !== false
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error closing on exchange:`, err)
      }
    }

    // ── 3. Compute realized PnL & ROI (margin-based to match exchange ROE) ──
    const qty = position.executedQuantity || 0
    const avgEntry = position.averageExecutionPrice || position.entryPrice || 0
    const pnl =
      qty > 0 && avgEntry > 0 && closePrice > 0
        ? qty *
          (position.direction === "long"
            ? closePrice - avgEntry
            : avgEntry - closePrice)
        : 0
    const lev = Math.max(1, position.leverage || 1)
    const notional = avgEntry * qty
    const margin = notional > 0 ? notional / lev : 0
    const roi = margin > 0 ? (pnl / margin) * 100 : 0

    // ── 4. Persist with terminal state ────────────────────────────────
    position.status = "closed"
    position.closedAt = Date.now()
    position.updatedAt = Date.now()
    position.realizedPnL = Math.round(pnl * 100) / 100
    position.closeReason = closeReason
    pushStep(
      position,
      "close",
      true,
      `close @ ${closePrice} pnl=${pnl.toFixed(2)} roi=${roi.toFixed(2)}% reason=${closeReason}${exchangeConnector && !exchangeCloseSuccess ? " [exchange-close-uncertain]" : ""}`,
    )
    // savePosition() handles index move + idempotent archival.
    await savePosition(position)

    // ── 5. Release dedup lock + counters + audit log ──────────────────
    await releaseLock(connectionId, position.symbol, position.direction)
    await incrementMetric(connectionId, "live_positions_closed_count")
    if (pnl > 0) await incrementMetric(connectionId, "live_wins_count")

    await logProgressionEvent(connectionId, "live_trading", "info", `Closed live position ${position.symbol}`, {
      pnl,
      roi,
      closePrice,
      closeReason,
      executedQuantity: qty,
      averageEntry: avgEntry,
      leverage: lev,
      marginAtRisk: margin,
    })

    console.log(`${LOG_PREFIX} Closed ${position.symbol} P&L=${pnl.toFixed(2)} ROI=${roi.toFixed(2)}% reason=${closeReason}`)

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

          // ── SL/TP self-healing ──────────────────────────────────────
          // Every reconcile cycle (driven by the cron) we verify the
          // protection orders match the desired levels derived from the
          // position's current stopLoss / takeProfit percentages and
          // average execution price. This auto-heals four scenarios:
          //   • Operator manually cancelled SL or TP on the exchange.
          //   • Strategy update mutated the percentages mid-trade.
          //   • Partial fill changed executedQuantity without re-arming.
          //   • Accumulation merged new volume in (avg entry shifted).
          // updateProtectionOrders() is no-op when nothing drifted, so
          // this is cheap on the steady state — only fires real REST
          // calls when something actually needs to change.
          try {
            await updateProtectionOrders(exchangeConnector, pos, "reconcile")
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} reconcile SL/TP heal error for ${pos.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }

          // ── Proactive close-in-time safety check ───────────────────
          // The SL/TP orders we place are reduce-only LIMIT orders. On
          // a price gap (illiquid pairs, news events) the exchange may
          // skip past the limit price without filling, leaving the
          // position open and unprotected. We compare the just-fetched
          // mark price against the desired SL/TP levels and force-close
          // if breached. This is the safety net that guarantees timely
          // exits regardless of how the venue handled the limit fill.
          //
          // Only triggers when ALL of:
          //   • markPrice is fresh (just synced this cycle)
          //   • desired SL/TP price is non-zero (i.e. armed)
          //   • mark has actually crossed the level for the position's
          //     direction (long: price ≤ SL or ≥ TP; short: ≥ SL or ≤ TP)
          //
          // Closes via closeLivePosition() which cancels the orphan
          // protection order on the OTHER side and archives properly.
          if (markPrice > 0 && pos.executedQuantity > 0) {
            const fillPrice = pos.averageExecutionPrice || pos.entryPrice
            const slPct = Math.max(0, pos.stopLoss || 0) / 100
            const tpPct = Math.max(0, pos.takeProfit || 0) / 100
            const desiredSl =
              slPct > 0 && fillPrice > 0
                ? pos.direction === "long"
                  ? fillPrice * (1 - slPct)
                  : fillPrice * (1 + slPct)
                : 0
            const desiredTp =
              tpPct > 0 && fillPrice > 0
                ? pos.direction === "long"
                  ? fillPrice * (1 + tpPct)
                  : fillPrice * (1 - tpPct)
                : 0

            let crossReason: string | null = null
            if (pos.direction === "long") {
              if (desiredSl > 0 && markPrice <= desiredSl) crossReason = "sl_hit"
              else if (desiredTp > 0 && markPrice >= desiredTp) crossReason = "tp_hit"
            } else {
              // short
              if (desiredSl > 0 && markPrice >= desiredSl) crossReason = "sl_hit"
              else if (desiredTp > 0 && markPrice <= desiredTp) crossReason = "tp_hit"
            }

            if (crossReason) {
              console.log(
                `${LOG_PREFIX} ${crossReason.toUpperCase()} detected for ${pos.symbol} ${pos.direction} @ mark=${markPrice} (sl=${desiredSl} tp=${desiredTp}) — force-closing`,
              )
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "warning",
                `${crossReason === "sl_hit" ? "Stop-loss" : "Take-profit"} cross detected for ${pos.symbol} — force-closing`,
                {
                  positionId: pos.id,
                  markPrice,
                  desiredSl,
                  desiredTp,
                  direction: pos.direction,
                  averageEntry: pos.averageExecutionPrice,
                },
              )
              try {
                await closeLivePosition(connectionId, pos.id, markPrice, exchangeConnector, crossReason)
                summary.closed++
                continue // skip the per-cycle setex below — close already persisted
              } catch (closeErr) {
                console.warn(
                  `${LOG_PREFIX} force-close on ${crossReason} failed for ${pos.id}:`,
                  closeErr instanceof Error ? closeErr.message : String(closeErr),
                )
                summary.errors++
                // Fall through to the regular setex so the mark refresh
                // is still persisted; next cycle will retry the close.
              }
            }
          }

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

          // Best-effort orphan cleanup: if the position vanished from
          // the exchange because (e.g.) the TP fired, the SL is now an
          // orphan reduce-only order with no position to reduce. The
          // exchange will usually auto-reject any future fill, but the
          // order can still sit in the book and confuse the operator.
          // Cancelling here is silent on "already gone".
          if (pos.stopLossOrderId || pos.takeProfitOrderId) {
            const cancellations: Promise<boolean>[] = []
            if (pos.stopLossOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.stopLossOrderId, "StopLoss"),
              )
            }
            if (pos.takeProfitOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.takeProfitOrderId, "TakeProfit"),
              )
            }
            await Promise.all(cancellations).catch(() => {})
            pos.stopLossOrderId = undefined
            pos.takeProfitOrderId = undefined
          }

          pos.status = "closed"
          pos.closedAt = Date.now()
          pos.realizedPnL = Math.round(realizedPnl * 100) / 100
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

/**
 * Recalculate the desired SL/TP for a single live position and apply
 * the change to the exchange. Used by the strategy coordinator when an
 * operator edits SL/TP percentages on an active connection — without
 * this, the exchange-side levels stay glued to the original fill and
 * the change only affects newly-opened positions.
 *
 * Pass updated `stopLossPct` / `takeProfitPct` to override the values
 * stored on the live position; omit them to recompute from whatever
 * is currently on the LivePosition record (useful as a "force-heal"
 * after a missed reconcile).
 *
 * Returns `null` if the position doesn't exist or is already closed.
 */
export async function recalculateAndApplySLTP(
  connectionId: string,
  livePositionId: string,
  exchangeConnector: any,
  overrides?: { stopLossPct?: number; takeProfitPct?: number },
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    if (
      position.status === "closed" ||
      position.status === "rejected" ||
      position.status === "error" ||
      position.executedQuantity <= 0
    ) {
      return position
    }

    if (overrides?.stopLossPct !== undefined) position.stopLoss = overrides.stopLossPct
    if (overrides?.takeProfitPct !== undefined) position.takeProfit = overrides.takeProfitPct

    await updateProtectionOrders(exchangeConnector, position, "manual_recalc")
    position.updatedAt = Date.now()
    await savePosition(position)
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} recalculateAndApplySLTP error:`, err)
    return null
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
  reconcileLivePositions,
  recalculateAndApplySLTP,
  getClosedLivePositions,
}
