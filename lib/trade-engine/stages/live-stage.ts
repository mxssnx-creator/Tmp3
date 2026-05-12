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
  //
  // `stopLoss` / `takeProfit` are the *current* assigned percentages
  // honored by the exchange protection orders. They can be mutated by
  // `recalculateAndApplySLTP()` when an operator edits SL/TP mid-trade.
  //
  // `assignedStopLoss` / `assignedTakeProfit` are an IMMUTABLE snapshot
  // of the values originally assigned by the upstream Set/strategy at
  // position creation. They never change for the lifetime of the
  // position — even after overrides — so post-trade analysis and the
  // progression panel can always answer "what did the strategy
  // originally specify?". Optional for back-compat with positions
  // opened before this field existed.
  stopLoss: number
  takeProfit: number
  assignedStopLoss?: number
  assignedTakeProfit?: number
  // `stopLossPrice` / `takeProfitPrice` are the latest absolute
  // trigger prices placed on the exchange — they are recomputed by
  // `updateProtectionOrders()` whenever the average execution price
  // shifts (accumulation merges) or the current `stopLoss` /
  // `takeProfit` percentages change. They mirror the prices the
  // exchange's reduce-only orders are armed at.
  stopLossPrice?: number
  takeProfitPrice?: number
  // `protectionArmedQuantity` is the `executedQuantity` value that was
  // in effect when SL/TP were last (re-)placed on the exchange. We
  // compare against the current `executedQuantity` every reconcile
  // cycle: if they differ by more than 0.25% we re-arm. This closes a
  // bug where accumulation merges or delayed partial fills grew the
  // position but the original SL/TP order on the exchange still only
  // protected the *original* volume — leaving the additional volume
  // unprotected. Optional for back-compat with existing positions.
  protectionArmedQuantity?: number
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

    // 1. Primary: hgetall market_data:{symbol} hash
    const mdhash = await client.hgetall(`market_data:${symbol}`)
    const price = parseFloat(String(mdhash?.close ?? mdhash?.price ?? mdhash?.last ?? "0"))
    if (price > 0) return price

    // 2. Fallback: candle envelope. Spec §7 — the loader now writes
    //    `:1s` exclusively, but old runs may still have `:1m` data
    //    in Redis. Try the new key first, then the legacy one.
    const envelopeRaw =
      (await client.get(`market_data:${symbol}:1s`)) ??
      (await client.get(`market_data:${symbol}:1m`))
    if (envelopeRaw) {
      try {
        const parsed = typeof envelopeRaw === "string" ? JSON.parse(envelopeRaw) : envelopeRaw
        const p = parseFloat(String(parsed?.close ?? parsed?.price ?? parsed?.last ?? 0))
        if (p > 0) return p
      } catch { /* ignore */ }
    }

    // 3. Fallback: ticker key (some connectors write here)
    const rawTicker = await client.get(`ticker:${symbol}`)
    if (rawTicker) {
      try {
        const parsed = typeof rawTicker === "string" ? JSON.parse(rawTicker) : rawTicker
        const p = parseFloat(String(parsed?.last ?? parsed?.close ?? parsed?.price ?? 0))
        if (p > 0) return p
      } catch { /* ignore */ }
    }

    // 4. Fallback: latest candle string key
    const rawLatest = await client.get(`market_data:${symbol}:latest`)
    if (rawLatest) {
      try {
        const parsed = typeof rawLatest === "string" ? JSON.parse(rawLatest) : rawLatest
        const p = parseFloat(String(parsed?.close ?? parsed?.price ?? parsed?.last ?? 0))
        if (p > 0) return p
      } catch { /* ignore */ }
    }

    return 0
  } catch {
    return 0
  }
}

// `hasOpenLivePosition` was removed — it was a non-atomic GET-only test
// that produced the check-then-act race in `executeLivePosition`. The
// dedup gate is now driven by `tryAcquireLock` (atomic SET NX EX), which
// returns the slot's ownership directly. Existence-only checks were never
// safe for guarding new entries; if a future caller needs to peek without
// acquiring (e.g. a UI status query), they should read the open-positions
// index (`live:positions:{connId}`) — the lock key is now reserved for
// mutual exclusion only.

async function tryAcquireLock(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  ttlSeconds = 300,
): Promise<boolean> {
  try {
    const client = getRedisClient()
    const lockKey = `live:lock:${connectionId}:${symbol}:${direction}`
    // `client.set` with NX returns `"OK"` on success or `null` when the
    // key already existed (Redis-standard). The `!= null` check covers
    // both `null` and `undefined` (some adapters return undefined on
    // pipeline failures); any other value (i.e. the truthy "OK"
    // response) means we acquired the slot.
    const ok = await client.set(lockKey, String(Date.now()), { NX: true, EX: ttlSeconds })
    return ok != null
  } catch {
    return false
  }
}

/**
 * Legacy non-atomic acquire — preserved for the post-fill heartbeat
 * refresh in `closeLivePosition`'s reverse path. **Do NOT use for new
 * call sites**; build dedup gates on `tryAcquireLock` instead.
 *
 * Re-stamps the lock unconditionally so a long-running entry can
 * extend its TTL (the safety expiry would otherwise fire mid-trade if
 * the position stays open longer than `ttlSeconds`).
 */
async function refreshLockTTL(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  ttlSeconds = 300,
): Promise<void> {
  try {
    const client = getRedisClient()
    const lockKey = `live:lock:${connectionId}:${symbol}:${direction}`
    await client.setex(lockKey, ttlSeconds, String(Date.now()))
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
    //
    // Accumulation is a LIVE-execution path — it places real exchange
    // orders to merge into an existing position. Per spec, this MUST
    // calculate "indeed volume" using the per-engine ratio. We resolve
    // the trade mode from the connection's flags exactly the same way
    // `executeLivePosition` does (Preset iff is_preset_trade=true AND
    // is_live_trade=false, otherwise Main). A failure to load the
    // connection here falls back to "main" which is the conservative
    // default — Preset's factor is often the more aggressive one and
    // we don't want a transient Redis blip to silently up-size the
    // accumulated order.
    let accTradeMode: "main" | "preset" = "main"
    try {
      const { getConnection: _getConn } = await import("@/lib/redis-db")
      const { isTruthyFlag } = await import("@/lib/connection-state-utils")
      const accConn = (await _getConn(connectionId)) || {}
      if (isTruthyFlag(accConn.is_preset_trade) && !isTruthyFlag(accConn.is_live_trade)) {
        accTradeMode = "preset"
      }
    } catch { /* fall back to "main" — see comment above */ }

    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      symbol,
      currentPrice,
      { tradeMode: accTradeMode },
    ).catch((err) => {
      console.error(`${LOG_PREFIX} accumulate volume calc error:`, err)
      return null
    })

    let addQty = volumeResult?.finalVolume || volumeResult?.volume || 0
    if (addQty <= 0 || !Number.isFinite(addQty)) {
      // Fallback when volume calc fails: use the per-pair exchange minimum
      // from trading-pair metadata when available, otherwise $5 notional.
      // Kept minimal — the exchange min enforcement in VolumeCalculator
      // already clamps up to the pair minimum under normal operation;
      // this path only fires when the calculator itself returns nothing.
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
      (r: any) => !!r?.success && !!(r.orderId || r.id),
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
      // Distinguish circuit-breaker (109400) from genuine margin failures.
      // Circuit-breaker gates the symbol only; margin errors gate the connection.
      if (isCircuitBreakerError(orderResult)) {
        recordCircuitBreaker(symbol)
      } else if (isNonRecoverableExchangeError(orderResult)) {
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
    // Count the accumulation entry as an "order placed" — without
    // this, Fill Rate (filled/placed) goes nonsense whenever an
    // accumulation lands successfully (we'd bump filled at line ~510
    // without ever bumping placed). The dedicated
    // `live_orders_accumulated_count` still tracks accumulation as
    // a separate metric for operators who want to break it out.
    await incrementMetric(connectionId, "live_orders_placed_count")

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
        // Cents counter — preserves sub-dollar margins (a $5 fill at
        // 125x leverage is $0.04 margin → 4 cents, not 0). Reader
        // divides by 100. The legacy `live_margin_usd_total` counter
        // is no longer written (it would have to be inflated to avoid
        // truncating to 0, which would lie about the true margin) —
        // legacy connections without cents data fall back gracefully
        // in the stats route.
        await incrementMetric(connectionId, "live_margin_cents_total", Math.round(newMargin * 100))
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
// Exponential backoff: each consecutive failure doubles the cooldown
// (60s → 120s → 240s → 300s cap). This prevents the re-arm loop where
// a 60s cooldown expires, the next attempt fails again (same root cause),
// and immediately re-arms for another 60s — making recovery appear stuck.
// After the operator tops up, the next successful order resets the counter.
//
// A `clearMarginCooldown(connectionId)` export allows the /api/engine/reconnect
// endpoint to forcibly release a stuck cooldown.
//
// NOTE: Exchange circuit-breaker errors (BingX code 109400 — "API orders
// temporarily disabled due to market volatility") are NOT margin errors.
// They have their own per-symbol gate (`circuitBreakerBySymbol`) with a
// 5-minute TTL and do NOT increment the margin failure counter.
const MARGIN_COOLDOWN_STEPS_MS = [60_000, 120_000, 240_000, 300_000]
const MARGIN_COOLDOWN_MAX_MS = 300_000

interface MarginCooldownEntry {
  lastErrorAt: number
  consecutiveFailures: number
}
const marginErrorCooldownByConnection: Map<string, MarginCooldownEntry> = new Map()

function isMarginCooldownActive(connectionId: string): boolean {
  const entry = marginErrorCooldownByConnection.get(connectionId)
  if (!entry) return false
  const stepIdx = Math.min(entry.consecutiveFailures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
  const cooldownMs = MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS
  if (Date.now() - entry.lastErrorAt < cooldownMs) return true
  // Cooldown expired — clear so the next attempt runs fresh.
  marginErrorCooldownByConnection.delete(connectionId)
  return false
}

function recordMarginError(connectionId: string): void {
  const existing = marginErrorCooldownByConnection.get(connectionId)
  marginErrorCooldownByConnection.set(connectionId, {
    lastErrorAt: Date.now(),
    consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
  })
}

/** Exported so the /api/engine/reconnect endpoint can forcibly clear a stuck cooldown. */
export function clearMarginCooldown(connectionId: string): void {
  marginErrorCooldownByConnection.delete(connectionId)
  console.log(`${LOG_PREFIX} Margin cooldown cleared for ${connectionId}`)
}

// ── Per-symbol exchange circuit-breaker gate ──────────────────────────
// BingX code 109400 means the exchange has TEMPORARILY disabled API
// trading for that symbol due to extreme volatility. This is NOT a
// margin/balance issue — the account is fine, the exchange re-enables
// trading automatically (typically within 1–5 minutes). We skip the
// symbol for 5 minutes then resume WITHOUT touching the margin counter,
// preventing one volatile symbol from blocking all orders on the connection.
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000 // 5 minutes
const circuitBreakerBySymbol: Map<string, number> = new Map()

function isCircuitBreakerActive(symbol: string): boolean {
  const ts = circuitBreakerBySymbol.get(symbol)
  if (!ts) return false
  if (Date.now() - ts < CIRCUIT_BREAKER_COOLDOWN_MS) return true
  circuitBreakerBySymbol.delete(symbol)
  return false
}

function recordCircuitBreaker(symbol: string): void {
  circuitBreakerBySymbol.set(symbol, Date.now())
}

function isCircuitBreakerError(payload: unknown): boolean {
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
  return (
    /\bcode\s*=?\s*109400\b/.test(text) ||
    /api orders? (?:are )?temporarily disabled/i.test(text) ||
    /large market fluctuations/i.test(text)
  )
}

/**
 * Poll an order until it reaches a terminal fill state or the timeout elapses.
 */
async function pollOrderFill(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 15000,
  intervalMs = 800
): Promise<{ filled: boolean; filledQty: number; filledPrice: number; status: string }> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = "pending"
  // Track the best partial result seen so far — return it on timeout rather
  // than returning filled=false when we know some qty was actually transacted.
  let bestPartialQty = 0
  let bestPartialPrice = 0
  while (Date.now() < deadline) {
    try {
      const order = await connector.getOrder(symbol, orderId)
      if (order) {
        lastStatus = order.status || order.orderStatus || "unknown"
        const statusLower = String(lastStatus).toLowerCase().trim()
        const rawFilledQty  = parseFloat(String(order.filledQty  ?? order.executedQty ?? order.cumQty    ?? "0")) || 0
        const rawFilledPrice = parseFloat(String(order.filledPrice ?? order.avgPrice   ?? order.price     ?? "0")) || 0

        // Any of these status strings mean the exchange has fully transacted the order.
        const isFilled =
          statusLower === "filled" ||
          statusLower === "deal" ||        // BingX historical alias
          statusLower === "complete" ||
          statusLower === "completed" ||
          order.status === "FILLED"

        // Partial fills: qty > 0 even if status isn't fully "filled" yet.
        // Accept as usable — protection orders should be sized to filledQty,
        // not the requested qty. Remaining qty will be covered by reconcile.
        const isPartialFill =
          (statusLower === "partially_filled" || statusLower === "partial_fill") &&
          rawFilledQty > 0

        if (rawFilledQty > bestPartialQty) {
          bestPartialQty  = rawFilledQty
          bestPartialPrice = rawFilledPrice
        }

        if ((isFilled || isPartialFill) && rawFilledQty > 0) {
          return {
            filled: true,
            filledQty: rawFilledQty,
            filledPrice: rawFilledPrice || 0,
            status: isFilled ? "filled" : "partially_filled",
          }
        }
        if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
          return { filled: false, filledQty: 0, filledPrice: 0, status: statusLower }
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} poll error:`, err instanceof Error ? err.message : String(err))
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  // Timeout — return whatever partial qty we managed to see rather than zero.
  // A non-zero bestPartialQty means the exchange has transacted at least some
  // volume; returning it lets the caller place SL/TP for the confirmed portion.
  if (bestPartialQty > 0) {
    return { filled: true, filledQty: bestPartialQty, filledPrice: bestPartialPrice, status: "partially_filled" }
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
  orderLabel: "StopLoss" | "TakeProfit",
  positionDirection: "long" | "short",
): Promise<string | null> {
  try {
    // Prefer the connector's CONDITIONAL-order path
    // (`placeStopOrder`) over a regular `placeOrder`. The legacy code
    // here used `placeOrder(..., "limit")` at the trigger price — which
    // for SL on a long is a sell-limit BELOW market and gets rejected
    // by most exchanges as an aggressive reduce-only, leaving the
    // position unprotected. `placeStopOrder` lands a real STOP_MARKET /
    // TAKE_PROFIT_MARKET (BingX) or `triggerPrice`-based market reduce
    // (Bybit), and falls back to the limit-as-trigger behaviour on
    // connectors that haven't been upgraded yet (see `BaseExchangeConnector`).
    if (typeof connector?.placeStopOrder !== "function") {
      console.warn(`${LOG_PREFIX} connector has no placeStopOrder — protection unavailable`)
      return null
    }

    const kind: "stop_loss" | "take_profit" =
      orderLabel === "StopLoss" ? "stop_loss" : "take_profit"

    // NOTE: We do NOT pass `hedgeMode` here. The BingX connector defaults to
    // hedgeMode=true (sends `positionSide`) and includes a built-in one-way
    // fallback retry that fires when BingX returns code=80014. Passing
    // hedgeMode:false would suppress `positionSide` entirely — which works
    // on one-way accounts but breaks hedge accounts (BingX requires
    // positionSide there, and the retry path only handles the inverse
    // hedge→one-way case). Letting the connector default to hedge-mode +
    // auto-retry covers both account types correctly.
    const result = await connector.placeStopOrder(
      symbol,
      closeSide,
      quantity,
      triggerPrice,
      kind,
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
  if (!connector) return result
  // Use executedQuantity when confirmed; fall back to quantity (the original
  // order size) so SL/TP can be placed even when fill-detection lagged.
  // Protection orders are reduce-only — they cannot add new risk.
  const effectiveQty = pos.executedQuantity > 0 ? pos.executedQuantity : (pos.quantity ?? 0)
  if (effectiveQty <= 0) return result

  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(pos)
  const closeSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"

  // ── Quantity drift detection ──────────────────────────────────────────
  // When more volume joins the position (delayed partial fills, accumulation
  // merges, post-fill sync detection) the SL/TP order on the exchange is
  // still armed for the *original* qty, leaving the delta unprotected.
  // Compare the current executed qty against the qty that was armed at
  // last placement; >0.25% drift triggers a cancel-and-replace on each
  // leg even if the trigger price hasn't moved. This is the missing
  // fix the user reported as "TP/SL not working" after partial fills.
  const armedQty = pos.protectionArmedQuantity ?? 0
  const qtyDrifted =
    pos.executedQuantity > 0 &&
    (armedQty <= 0 ||
      Math.abs(pos.executedQuantity - armedQty) / Math.max(armedQty, 1e-12) > 0.0025)

  // ── Stop-Loss leg ────────────────────────────────────────────────────
  if (desiredSl <= 0 && pos.stopLossOrderId) {
    // SL was turned off — yank the existing order.
    await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
    pos.stopLossOrderId = undefined
    pos.stopLossPrice = 0
    result.changed = true
  } else if (
    desiredSl > 0 &&
    (!pos.stopLossOrderId || priceDrifted(pos.stopLossPrice, desiredSl) || qtyDrifted)
  ) {
    if (pos.stopLossOrderId) {
      await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
    }
    const id = await placeProtectionOrder(
      connector,
      pos.symbol,
      closeSide,
      effectiveQty,
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
  } else if (
    desiredTp > 0 &&
    (!pos.takeProfitOrderId || priceDrifted(pos.takeProfitPrice, desiredTp) || qtyDrifted)
  ) {
    if (pos.takeProfitOrderId) {
      await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit")
    }
    const id = await placeProtectionOrder(
      connector,
      pos.symbol,
      closeSide,
      effectiveQty,
      desiredTp,
      "TakeProfit",
      pos.direction,
    )
    pos.takeProfitOrderId = id || undefined
    pos.takeProfitPrice = desiredTp
    result.changed = true
    result.tpPlaced = !!id
  }

  // After (re-)placement record the qty we armed for so the next pass
  // can detect further drift accurately.
  if (result.changed) {
    pos.protectionArmedQuantity = effectiveQty
  }

  if (result.changed) {
    pushStep(
      pos,
      "update_sl_tp",
      true,
      `[${reason}] SL ${pos.stopLoss}% → ${pos.stopLossPrice ? pos.stopLossPrice.toFixed(6) : "—"} (${pos.stopLossOrderId || "—"}) | ` +
      `TP ${pos.takeProfit}% → ${pos.takeProfitPrice ? pos.takeProfitPrice.toFixed(6) : "—"} (${pos.takeProfitOrderId || "—"})`,
    )
    await logProgressionEvent(
      pos.connectionId,
      "live_trading",
      "info",
      `SL/TP updated for ${pos.symbol} (${reason})`,
      {
        // Both the originally-assigned percentages (immutable contract)
        // and the currently-active percentages (mutable, override-aware).
        // On the steady state these are equal; after an operator override
        // they diverge — the assigned pair makes the override audit-trail
        // self-documenting in the dashboard's progression panel.
        assignedStopLossPct: pos.assignedStopLoss,
        assignedTakeProfitPct: pos.assignedTakeProfit,
        stopLossPct: pos.stopLoss,
        takeProfitPct: pos.takeProfit,
        slOrderId: pos.stopLossOrderId,
        slPrice: pos.stopLossPrice,
        tpOrderId: pos.takeProfitOrderId,
        tpPrice: pos.takeProfitPrice,
        fillPrice: pos.averageExecutionPrice,
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

  // ── Exchange circuit-breaker gate (per-symbol) ───────────────────────
  // BingX code 109400 — "API orders temporarily disabled due to market
  // volatility" — affects a specific symbol for ~1-5 minutes. Skip it
  // silently rather than counting it as a margin/balance failure.
  if (isCircuitBreakerActive(realPosition.symbol)) {
    const cbSkipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
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
      assignedStopLoss: realPosition.stopLoss,
      assignedTakeProfit: realPosition.takeProfit,
      status: "rejected",
      statusReason: `Skipped — exchange circuit breaker active for ${realPosition.symbol} (market volatility, resumes in <5min)`,
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
    pushStep(cbSkipped, "preflight", false, cbSkipped.statusReason)
    logProgressionEvent(connectionId, "live_trading", "warning", cbSkipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
    }).catch(() => {})
    return cbSkipped
  }

  // ── Non-recoverable-error cooldown gate ──
  //
  // If we hit `code=101204` (Insufficient margin) within the exponential
  // backoff window (60s → 120s → 240s → 300s), skip this attempt and return
  // a synthetic "rejected" LivePosition. Prevents API flood on no-balance.
  //
  // The skip is silent at console level after the first occurrence so
  // logs stay readable; the progression event still records it for the
  // dashboard. Operator tops up → next successful order resets counter.
  if (isMarginCooldownActive(connectionId)) {
    const entry = marginErrorCooldownByConnection.get(connectionId)
    const failures = entry?.consecutiveFailures ?? 1
    const stepIdx = Math.min(failures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
    const cooldownSec = Math.round((MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS) / 1000)
    const skipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
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
      // Immutable snapshot of the originally-assigned values — survives
      // any later override via `recalculateAndApplySLTP`. See type def.
      assignedStopLoss: realPosition.stopLoss,
      assignedTakeProfit: realPosition.takeProfit,
      status: "rejected",
      statusReason:
        `Skipped — margin-error cooldown active (attempt ${failures}, cooldown=${cooldownSec}s). Top up exchange balance to resume.`,
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
      consecutiveFailures: failures,
      cooldownSec,
    }).catch(() => {})
    return skipped
  }

  const livePosition: LivePosition = {
    id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
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
    // Immutable assignment snapshot — preserved across overrides so the
    // progression panel and post-trade stats can always recover what the
    // upstream Set originally specified. Mirrors `stopLoss`/`takeProfit`
    // at creation; never mutated thereafter.
    assignedStopLoss: realPosition.stopLoss,
    assignedTakeProfit: realPosition.takeProfit,
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
    // ── Step 1: Pre-flight validation ───────────────��──────────────────────
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

    // ── Atomic dedup gate (P0-4 race fix) ──────────────────────────────
    //
    // Spec: "Active Pseudo Position Limit for each direction Long, short
    // maximal 1." The previous implementation was a check-then-act
    // sequence:
    //
    //   if (await hasOpenLivePosition(...)) { merge-or-release-stale }
    //   ... place order ...
    //   await acquireLock(...)            // overwrites unconditionally
    //
    // — racy under any concurrency. Two ticks could both pass the
    // `hasOpenLivePosition` check, both place exchange orders, and both
    // belatedly stamp the lock. The exchange ended up with two
    // duplicate positions for the same symbol+direction; reconcile then
    // had to figure out which one to track.
    //
    // We now atomically `tryAcquireLock` at the very top of the
    // live-trade branch:
    //
    //   • acquired → we own the slot, fresh-entry path runs. No
    //                separate `acquireLock` call later in this function.
    //   • not acquired → there is either an open position to merge into
    //                    (our preferred outcome) OR an in-flight entry
    //                    from a parallel tick that hasn't yet saved its
    //                    position. We DEFER in the second case rather
    //                    than racing — the 5-minute TTL guarantees a
    //                    crashed lock self-clears, so deferred signals
    //                    will succeed on a subsequent cycle.
    //
    // This is the only writer of `live:lock:{conn}:{sym}:{dir}` on the
    // critical path, so the race window is closed at its source.
    if (isLiveTradeEnabled) {
      const acquired = await tryAcquireLock(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
      )
      if (!acquired) {
        // Slot is held — try to merge into the existing exchange
        // position. If we can't (in-flight entry from another tick),
        // defer this signal cleanly.
        const existing = await findOpenLivePositionByDir(
          connectionId,
          realPosition.symbol,
          realPosition.direction,
        )

        if (!existing) {
          // Lock present, no position visible yet → another tick is
          // mid-flight. DO NOT release the lock here (the previous
          // implementation did, which let two ticks both place exchange
          // orders). Surface a deferral and let the next cycle retry.
          livePosition.status = "rejected"
          livePosition.statusReason =
            `Dedup lock held — another entry in flight for ${realPosition.symbol} ${realPosition.direction}; will retry next cycle`
          pushStep(livePosition, "preflight", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_deferred_count")
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "info",
            livePosition.statusReason,
            { symbol: realPosition.symbol, direction: realPosition.direction },
          ).catch(() => {})
          return livePosition
        }

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
        // Refresh the existing slot's TTL — the position is still open
        // on the exchange and we want the safety expiry pushed forward
        // by the 300 s window. Lock value remains the original entry's
        // timestamp (intentional — debuggers see the original entry's
        // wall-clock, not the accumulation's).
        await refreshLockTTL(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
        return merged
      }
      // acquired === true: we own the slot. Continue to fresh-entry
      // path below. The historical `await acquireLock(...)` after order
      // placement is now redundant and has been removed (see Step 5).
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
      // Release the dedup lock we acquired at the top of this function so
      // the next signal isn't blocked for the full 5-min TTL on a non-
      // recoverable connector failure (operator likely didn't configure a
      // connector — they need to be able to retry once they do).
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
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
      // Release the dedup lock — a missing market price is a transient
      // condition (typically a fresh symbol whose ticker hasn't streamed
      // yet). Without releasing, the next cycle's signal would defer for
      // 5 minutes even though the price arrives within seconds.
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
      return livePosition
    }
    livePosition.entryPrice = currentPrice
    pushStep(livePosition, "price_fetch", true, `price=${currentPrice}`)

    // ── Step 3: Volume calculation ─────────────────────────────────────────
    // POLICY: minimum volume is ALWAYS enforced �� we never reject a live
    // order for "qty too small". If the calculator returns null or a
    // non-positive quantity (e.g. balance fetch failed, NaN math) we
    // synthesize a fallback at the universal $5-notional floor and
    // continue. This keeps the operator's signal flow uninterrupted
    // and matches the documented behavior of `VolumeCalculator`.
    //
    // ── Trade-mode resolution for the engine volume factor ────────
    // The live-stage IS the live-execution path by definition — it
    // MUST tell `VolumeCalculator` which engine is asking for sizing so
    // the per-engine multiplier (Main vs. Preset) is applied. We reuse
    // the already-loaded `connSettings` to derive the mode without a
    // second Redis round-trip:
    //   - Preset engine: `is_preset_trade=true` AND `is_live_trade=false`
    //   - Main   engine: otherwise (the conservative default — when
    //                    both flags happen to be true during a UI
    //                    toggle transition we don't want to silently
    //                    apply Preset's typically-more-aggressive
    //                    multiplier).
    // Strategy / pseudo-position callers (in pseudo-position-manager)
    // do NOT pass `tradeMode` — they remain ratio-only per spec.
    const liveTradeMode: "main" | "preset" =
      isTruthyFlag(connSettings.is_preset_trade) && !isTruthyFlag(connSettings.is_live_trade)
        ? "preset"
        : "main"

    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice,
      { tradeMode: liveTradeMode },
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    let computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    let volumeNote = ""
    if (computedVolume <= 0 || !Number.isFinite(computedVolume)) {
      // Synthesize at the minimal fallback ($5 notional) when the
      // VolumeCalculator returns nothing. The per-pair exchange minimum
      // from trading-pair metadata (stored in Redis) normally takes over
      // as the hard floor inside VolumeCalculator — this path is a last-
      // resort for pairs with no metadata or calculator failures. Kept
      // at $5 to match the quickstart minimal-volume policy.
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
    let orderResult: any = await retry(
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
      (r: any) => !!r?.success && !!(r.orderId || r.id),
      "placeOrder"
    )

    // ── Leverage auto-reduce on 101204 (Insufficient margin) ─────────
    // When the exchange rejects with "Insufficient margin" the account
    // likely does not have enough funds at the current leverage. Halve
    // the leverage and retry ONCE — this is often enough to get the
    // minimum margin requirement below the available balance.
    if (!orderResult?.success && isNonRecoverableExchangeError(orderResult)) {
      const reducedLev = Math.max(1, Math.floor(livePosition.leverage / 2))
      if (reducedLev < livePosition.leverage) {
        console.warn(
          `${LOG_PREFIX} 101204 on ${realPosition.symbol} — retrying with halved leverage ` +
          `${livePosition.leverage}x → ${reducedLev}x`,
        )
        try {
          if (typeof exchangeConnector.setLeverage === "function") {
            await exchangeConnector.setLeverage(realPosition.symbol, reducedLev)
          }
        } catch { /* non-critical; the order might still succeed */ }

        const retryResult: any = await retry(
          () => exchangeConnector.placeOrder(
            realPosition.symbol,
            exchangeSide,
            computedVolume,
            undefined,
            "market",
            { positionSide: realPosition.direction === "long" ? "LONG" : "SHORT" },
          ),
          (r: any) => !!r?.success && !!(r.orderId || r.id),
          "placeOrder-reducedLev",
          1 // single retry attempt — we already tried 3× above
        )

        if (retryResult?.success && (retryResult.orderId || retryResult.id)) {
          // Succeeded with reduced leverage — update livePosition and continue.
          livePosition.leverage = reducedLev
          orderResult = retryResult
          console.log(
            `${LOG_PREFIX} Entry succeeded after leverage reduction to ${reducedLev}x for ${realPosition.symbol}`,
          )
        } else {
          // Still failing — record margin error and give up.
          recordMarginError(connectionId)
          orderResult = retryResult ?? orderResult
        }
      } else {
        // Leverage already at 1x — cannot reduce further.
        recordMarginError(connectionId)
      }
    }

    // ── Exchange circuit-breaker (109400) detection ───────────────────
    // Code 109400 = exchange temporarily halted API trading for this
    // symbol due to volatility. This is NOT a margin issue — record a
    // per-symbol circuit-breaker and let the connection continue placing
    // orders on other symbols without triggering the margin cooldown.
    if (!orderResult?.success && isCircuitBreakerError(orderResult)) {
      recordCircuitBreaker(realPosition.symbol)
      livePosition.status = "error"
      livePosition.statusReason = `Exchange circuit breaker active for ${realPosition.symbol} — retrying in <5min`
      pushStep(livePosition, "place_order", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "warning", livePosition.statusReason, {
        symbol: realPosition.symbol,
        error: orderResult?.error,
      })
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
      return livePosition
    }

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
      // Release the dedup lock — the order failed (rejection / API error /
      // margin shortfall), no exchange position will exist for this slot.
      // Without releasing, a transient failure would block the next signal
      // for the full 5-min TTL even though the entry never opened. The
      // margin-cooldown gate above still prevents a stampede of retries
      // when the failure is non-recoverable (insufficient balance).
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction).catch(() => {})
      return livePosition
    }

    livePosition.orderId = orderResult.orderId || orderResult.id
    livePosition.status = "placed"
    pushStep(livePosition, "place_order", true, `orderId=${livePosition.orderId}`)
    await incrementMetric(connectionId, "live_orders_placed_count")
    // Successful placement — reset the margin error consecutive-failure counter
    // so the backoff resets to the shortest cooldown on the next failure.
    marginErrorCooldownByConnection.delete(connectionId)
    // Lock was already acquired ATOMICALLY at the top of this function via
    // `tryAcquireLock` (see the dedup-gate block). The legacy
    // `await acquireLock(...)` here was redundant — it just re-stamped a
    // lock we already owned. Keeping the order here would also paper over
    // any future regression where the gate atomicity is removed: removing
    // it makes the contract obvious — "fresh-entry path runs IFF we own
    // the lock". A long-running entry's TTL is refreshed by the
    // accumulation path (`refreshLockTTL`) and by `closeLivePosition`'s
    // explicit `releaseLock`.
    await logProgressionEvent(connectionId, "live_trading", "info", `Entry order placed for ${realPosition.symbol}`, {
      orderId: livePosition.orderId,
      side: exchangeSide,
      quantity: computedVolume,
      price: currentPrice,
      leverage: livePosition.leverage,
    })

    // Persist intermediate state so UI can show "placed" even during poll.
    await savePosition(livePosition)

    // ── Step 6: Fill confirmation ──────────────────────────────────────────
    // Three-layer strategy:
    //  A) Inline: Many exchanges (BingX, Bybit) return immediate fill data in
    //     the placeOrder response itself. Extract it before polling to avoid
    //     a full 15s wait on fast-fill venues.
    //  B) Poll: Standard path — repeatedly call getOrder() until filled or
    //     timeout. Extended timeout (15s vs old 10s) to handle slow networks.
    //  C) getPosition() fallback: If poll times out with no fill data, ask the
    //     exchange for the *position* (not the order). On perp exchanges a
    //     successfully-opened position IS the proof of fill; its size and
    //     entry price are reliable even when getOrder() lags.
    //
    // After all three layers, if executedQty is still 0 we use computedVolume
    // as a last-resort quantity so SL/TP can be placed on the exchange. The
    // protection order itself being "reduce-only" ensures it can't add new
    // risk; the reconcile cycle will correct the stored qty on next tick.
    const inlineFillQty   = parseFloat(String(orderResult.filledQty  ?? orderResult.executedQty ?? orderResult.cumQty   ?? "0")) || 0
    const inlineFillPrice = parseFloat(String(orderResult.filledPrice ?? orderResult.avgPrice   ?? orderResult.price    ?? "0")) || 0
    const inlineStatus    = String(orderResult.status ?? "").toLowerCase()
    const inlineFilled    = (inlineStatus === "filled" || inlineFillQty >= computedVolume * 0.99) && inlineFillQty > 0

    let fill: { filled: boolean; filledQty: number; filledPrice: number; status: string }

    if (inlineFilled) {
      // A) placeOrder response already contains fill confirmation — skip poll.
      fill = { filled: true, filledQty: inlineFillQty, filledPrice: inlineFillPrice, status: "filled" }
      console.log(`${LOG_PREFIX} Inline fill detected for ${realPosition.symbol}: qty=${inlineFillQty} @ ${inlineFillPrice}`)
    } else {
      // B) Standard poll path.
      fill = await pollOrderFill(exchangeConnector, realPosition.symbol, livePosition.orderId!)
    }

    // C) getPosition() fallback when poll timed out without fill data.
    if (!fill.filled || fill.filledQty <= 0) {
      if (typeof exchangeConnector.getPosition === "function") {
        try {
          const exPos = await exchangeConnector.getPosition(realPosition.symbol)
          const exSize = parseFloat(String(exPos?.size ?? exPos?.positionAmt ?? exPos?.quantity ?? "0")) || 0
          const exEntry = parseFloat(String(exPos?.entryPrice ?? exPos?.avgPrice ?? "0")) || 0
          if (exSize > 0) {
            console.log(`${LOG_PREFIX} getPosition() fallback fill for ${realPosition.symbol}: size=${exSize} entry=${exEntry}`)
            fill = { filled: true, filledQty: exSize, filledPrice: exEntry || currentPrice, status: "filled_via_position" }
          }
        } catch {
          /* best-effort — fall through to computedVolume guard below */
        }
      }
    }

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
      livePosition.status = livePosition.remainingQuantity <= 0.000001 ? "filled" : "partially_filled"
      pushStep(livePosition, "poll_fill", true, `filled=${fill.filledQty} @ ${fill.filledPrice} via=${fill.status}`)
      await incrementMetric(connectionId, "live_orders_filled_count")
      await logProgressionEvent(connectionId, "live_trading", "info", `Entry filled for ${realPosition.symbol}`, {
        orderId: livePosition.orderId,
        filledQty: fill.filledQty,
        filledPrice: fill.filledPrice,
        via: fill.status,
      })
    } else {
      // D) Final guard: fill unconfirmed but order was accepted — treat as filled
      // with computedVolume so SL/TP can be placed. The position is "open" on the
      // exchange (order went to market); protection orders are reduce-only so no
      // new risk is added. Reconcile will correct executedQty on next tick.
      console.warn(
        `${LOG_PREFIX} Fill unconfirmed for ${realPosition.symbol} after all detection layers — ` +
        `using computedVolume=${computedVolume} as protection qty. Reconcile will sync.`
      )
      livePosition.executedQuantity = computedVolume
      livePosition.remainingQuantity = 0
      livePosition.averageExecutionPrice = currentPrice
      livePosition.fills.push({
        timestamp: Date.now(),
        quantity: computedVolume,
        price: currentPrice,
        fee: 0,
        feeAsset: "USDT",
      })
      livePosition.status = "filled" // treat as filled so SL/TP proceeds
      pushStep(livePosition, "poll_fill", false, `fill unconfirmed — using computedVolume=${computedVolume} as fallback qty for SL/TP`)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Entry fill unconfirmed for ${realPosition.symbol} — SL/TP will use order qty as fallback`,
        { orderId: livePosition.orderId, status: fill.status, fallbackQty: computedVolume }
      )
    }

    // ── Step 7: Place Stop Loss and Take Profit orders ─────────────────────
    //
    // Single source of truth for SL/TP price derivation:
    // `computeDesiredProtectionPrices()` is also what the accumulation
    // and reconcile paths use. By routing the initial placement through
    // the same helper we guarantee that an exchange-side order will
    // ALWAYS be armed at the same price the strategy assigned (rounded
    // identically), with no duplicate inline computation that could
    // drift out of sync with the rest of the file.
    if (livePosition.executedQuantity > 0) {
      const sideClose: "buy" | "sell" = realPosition.direction === "long" ? "sell" : "buy"
      const { desiredSl: slPrice, desiredTp: tpPrice } =
        computeDesiredProtectionPrices(livePosition)

      livePosition.stopLossPrice = slPrice
      livePosition.takeProfitPrice = tpPrice

      const [slOrderId, tpOrderId] = await Promise.all([
        slPrice > 0
          ? placeProtectionOrder(
              exchangeConnector,
              realPosition.symbol,
              sideClose,
              livePosition.executedQuantity,
              slPrice,
              "StopLoss",
              realPosition.direction,
            )
          : Promise.resolve(null),
        tpPrice > 0
          ? placeProtectionOrder(
              exchangeConnector,
              realPosition.symbol,
              sideClose,
              livePosition.executedQuantity,
              tpPrice,
              "TakeProfit",
              realPosition.direction,
            )
          : Promise.resolve(null),
      ])

      if (slOrderId) livePosition.stopLossOrderId = slOrderId
      if (tpOrderId) livePosition.takeProfitOrderId = tpOrderId
      // Record the qty SL/TP were armed for so the next reconcile
      // pass can detect quantity drift (delayed partial fills,
      // accumulation merges) and re-arm. Without this the drift
      // detector in `updateProtectionOrders` would see an undefined
      // baseline and re-arm on every cycle even when nothing changed.
      if (slOrderId || tpOrderId) {
        livePosition.protectionArmedQuantity = livePosition.executedQuantity
      }

      // Step record + progression log carry BOTH the assigned percent
      // and the resulting absolute trigger price, so an operator
      // reading the timeline never has to mentally reconstruct one
      // from the other. `assignedStopLoss`/`assignedTakeProfit` and
      // `stopLoss`/`takeProfit` are equal at this point (initial
      // placement); on later overrides the message will show both.
      pushStep(
        livePosition,
        "place_sl_tp",
        !!(slOrderId || tpOrderId),
        `SL ${livePosition.stopLoss}% → ${slPrice ? slPrice.toFixed(6) : "—"} (${slOrderId || "—"}) | ` +
        `TP ${livePosition.takeProfit}% → ${tpPrice ? tpPrice.toFixed(6) : "—"} (${tpOrderId || "—"})`
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `SL/TP placed for ${realPosition.symbol} at assigned values`,
        {
          // Assigned (immutable strategy contract) and current
          // (mutable, override-aware) percent pairs — equal on first
          // placement, can diverge after `recalculateAndApplySLTP`.
          assignedStopLossPct: livePosition.assignedStopLoss,
          assignedTakeProfitPct: livePosition.assignedTakeProfit,
          stopLossPct: livePosition.stopLoss,
          takeProfitPct: livePosition.takeProfit,
          slOrderId,
          slPrice,
          tpOrderId,
          tpPrice,
          fillPrice: livePosition.averageExecutionPrice,
        },
      )
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

    // Only count this as a real "position created" when the entry
    // order actually filled on the exchange. Previously we bumped this
    // counter unconditionally — including when pollOrderFill timed
    // out — which caused the dashboard to show ghost positions
    // (`Positions Created` > zero with `Orders Filled` still 0). The
    // user explicitly reported this asymmetry. Use executedQuantity as
    // the source of truth: it's only set once the fill is confirmed
    // (line 1450) or sync-confirmed (executeLivePosition exchange
    // sync block above).
    const hasRealFill = (livePosition.executedQuantity || 0) > 0
    if (hasRealFill) {
      await incrementMetric(connectionId, "live_positions_created_count")
      await incrementMetric(connectionId, "live_volume_usd_total", Math.round(livePosition.volumeUsd))
      // Used-balance (margin) cumulative counter — track in CENTS so
      // small margins (e.g. $5 notional / 125x leverage = $0.04)
      // survive integer rounding. Reader divides by 100 to display USD.
      // The legacy `live_margin_usd_total` counter is no longer
      // written: rounding any tiny margin to a whole dollar (or to 0)
      // produced a misleading number, and the stats reader now prefers
      // `live_margin_cents_total`.
      const lev = Math.max(1, Number(livePosition.leverage) || 1)
      const newMargin = (livePosition.volumeUsd || 0) / lev
      if (Number.isFinite(newMargin) && newMargin > 0) {
        await incrementMetric(connectionId, "live_margin_cents_total", Math.round(newMargin * 100))
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
    // CHECK the moved-marker BEFORE savePosition() runs so we know
    // whether THIS close is the first terminal write or a re-entry.
    // Without this guard `closeLivePosition` and the reconcile loop
    // could BOTH bump `live_positions_closed_count` for the same
    // position — that's exactly the "Positions Closed (6) >
    // Positions Created (4)" asymmetry the operator reported.
    const movedMarker = `live:positions:${connectionId}:moved:${position.id}`
    const wasAlreadyClosed = await client.get(movedMarker).catch(() => null)
    await savePosition(position)

    // ── 5. Release dedup lock + counters + audit log ──────────────�����──
    await releaseLock(connectionId, position.symbol, position.direction)
    if (!wasAlreadyClosed) {
      await incrementMetric(connectionId, "live_positions_closed_count")
      if (pnl > 0) await incrementMetric(connectionId, "live_wins_count")
    }

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
 * Detect whether the latest mark price has crossed the position's
 * desired SL or TP threshold and — if so — force-close the position
 * via `closeLivePosition`. Returns the cross reason ("sl_hit" / "tp_hit")
 * when a close was triggered (whether or not it succeeded), otherwise
 * `null`.
 *
 * This is the safety net the user described as "check pos if to be
 * updated or closed also independent of the control orders". Even if
 * the exchange-placed reduce-only SL/TP orders fail to fire (illiquid
 * pair gap, exchange order cancelled by the user, network race), this
 * comparison guarantees we close the position once mark price has
 * actually crossed the configured level.
 *
 * Used by:
 *   - `reconcileLivePositions` (cron, full reconcile sweep)
 *   - `syncWithExchange`        (engine loop, lighter mark-price refresh)
 *   - `recalculateAndApplySLTP` (immediate check after operator override —
 *     a tightened SL might already be breached at the new percentage)
 *
 * Pure side-effect helper: the caller decides what to do with `null`
 * (typically: persist the mark refresh and continue) or with a non-null
 * return (typically: skip further processing because the position was
 * archived by `closeLivePosition`).
 */
async function checkAndForceCloseOnSltpCross(
  connectionId: string,
  pos: LivePosition,
  markPrice: number,
  exchangeConnector: any,
): Promise<"sl_hit" | "tp_hit" | null> {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null
  if (pos.executedQuantity <= 0) return null
  // Skip positions whose entry order has not confirmed yet — using entryPrice
  // as a proxy for the fill price would produce incorrect SL/TP cross signals.
  if (pos.status === "closed" || pos.status === "rejected" || pos.status === "error" || pos.status === "placed") return null

  const fillPrice = pos.averageExecutionPrice
  // Require a confirmed fill price — entryPrice is an estimate and can be
  // stale. If averageExecutionPrice is missing the position has not been
  // confirmed filled yet; skip until it is.
  if (!fillPrice || fillPrice <= 0) return null

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

  let crossReason: "sl_hit" | "tp_hit" | null = null
  if (pos.direction === "long") {
    if (desiredSl > 0 && markPrice <= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice >= desiredTp) crossReason = "tp_hit"
  } else {
    if (desiredSl > 0 && markPrice >= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice <= desiredTp) crossReason = "tp_hit"
  }

  if (!crossReason) return null

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
      // Useful for the operator audit trail: was the cross because the
      // exchange-placed control order failed to fire, or because the
      // operator just tightened the band such that the position was
      // already past it?
      hadStopLossOrder: !!pos.stopLossOrderId,
      hadTakeProfitOrder: !!pos.takeProfitOrderId,
    },
  )

  try {
    await closeLivePosition(connectionId, pos.id, markPrice, exchangeConnector, crossReason)
  } catch (closeErr) {
    console.warn(
      `${LOG_PREFIX} force-close on ${crossReason} failed for ${pos.id}:`,
      closeErr instanceof Error ? closeErr.message : String(closeErr),
    )
  }
  return crossReason
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
 *
 * ── Hedge-Net Reconciliation Hook (operator spec, Position-Count axis) ──────
 * `strategy-coordinator.evaluateRealSets` writes per-bucket net targets to
 * the Redis hash `live_net_target:{connectionId}`. Each field is keyed by
 *
 *   `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
 *
 * (the axis-Cartesian triple + last-axis outcome) and its value encodes the
 * dominant-direction target:
 *
 *   `long:N`   → keep N net-long axis OPEN positions in this bucket
 *   `short:N`  → keep N net-short axis OPEN positions in this bucket
 *   `flat:0`   → perfect long/short cancellation; close any open in bucket
 *
 * The `cont` component is the OPEN-position accumulation count per spec
 * ("continuous 3: add actual and next 2 positions"). Each reconcile tick
 * advances the bucket toward `N = cont` open positions in the net direction.
 * As completed positions close out under the bucket the next coordinator
 * cycle re-evaluates the prev/last PF gates (closed-only) over the now-
 * larger completed sample and either:
 *   (a) keep bucket alive at same magnitude  → no exchange op
 *   (b) flip outcome (pos ↔ neg)             → close + reopen
 *   (c) flip dominant direction (long ↔ short) → close + reopen
 *   (d) drop bucket from net targets         → close all in bucket
 *
 * Reconciliation reuses the existing `closeLivePosition` and
 * `executeLivePosition` paths — no new exchange-call surface.
 */

/**
 * Orphan-close all open positions for a connection that have exceeded the
 * max hold time, writing `orphan_no_connector` or `orphan_exchange_error`
 * as the close reason. Called when the exchange connector is unavailable or
 * `getPositions()` throws, so positions are never left open in Redis
 * indefinitely even when the exchange cannot be reached.
 *
 * @param connectionId  Redis connection ID
 * @param connector     Exchange connector (null when unavailable)
 * @param summary       Mutable reconcile summary to increment counters
 */
async function orphanCloseExpiredPositions(
  connectionId: string,
  connector: any,
  summary: { reconciled: number; closed: number; errors: number; updated: number },
): Promise<void> {
  const MAX_HOLD_TIME_MS = Number(process.env.MAX_POSITION_HOLD_MS ?? 4 * 60 * 60 * 1000)
  if (MAX_HOLD_TIME_MS <= 0) return

  try {
    const allOpen = await getLivePositions(connectionId)
    const expired = allOpen.filter((p) => {
      if (p.status !== "open" && p.status !== "filled" && p.status !== "partially_filled") return false
      if ((p.executedQuantity ?? 0) <= 0) return false
      const openedAt = p.createdAt || p.updatedAt || 0
      return openedAt > 0 && Date.now() - openedAt > MAX_HOLD_TIME_MS
    })

    for (const pos of expired) {
      summary.reconciled++
      const heldMin = Math.round((Date.now() - (pos.createdAt || pos.updatedAt || 0)) / 60000)
      // Same exit-price resolution chain as reconcileLivePositions:
      // markPrice → averageExecutionPrice → Redis market_data → entryPrice
      let exitPrice = pos.exchangeData?.markPrice || pos.averageExecutionPrice || 0
      if (exitPrice <= 0) {
        try {
          const orphanRedis = getRedisClient()
          const mdHash = await orphanRedis.hgetall(`market_data:${pos.symbol}`)
          const mdPrice = parseFloat(String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0"))
          if (mdPrice > 0) exitPrice = mdPrice
        } catch { /* ignore */ }
      }
      if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
      const reason = connector ? "orphan_exchange_error" : "orphan_no_connector"

      console.warn(
        `${LOG_PREFIX} [orphan-close] ${pos.symbol} held ${heldMin}min, connector=${connector ? "error" : "missing"} — marking closed`,
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Orphan-close ${pos.symbol} (held ${heldMin}min, ${reason})`,
        { positionId: pos.id, heldMin, exitPrice, reason },
      )

      // Best-effort cancel protection orders first (connector may be partially working)
      if (connector) {
        const cancels: Promise<any>[] = []
        if (pos.stopLossOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss").catch(() => {}))
        if (pos.takeProfitOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit").catch(() => {}))
        if (cancels.length) await Promise.all(cancels).catch(() => {})
      }

      await closeLivePosition(connectionId, pos.id, exitPrice, connector, reason).catch((err) => {
        console.warn(`${LOG_PREFIX} [orphan-close] closeLivePosition failed for ${pos.id}:`, err instanceof Error ? err.message : String(err))
        summary.errors++
      })
      summary.closed++
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} [orphan-close] sweep error:`, err instanceof Error ? err.message : String(err))
    summary.errors++
  }
}

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
    // No connector — we cannot reach the exchange to confirm position state.
    // Run the orphan-close sweep so positions that have been sitting open
    // past the max hold time are at least marked closed in Redis. The
    // close reason "orphan_no_connector" distinguishes them from normal
    // closes in the audit trail.
    await orphanCloseExpiredPositions(connectionId, null, summary)
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
      // Exchange unreachable — still run the orphan-close sweep so positions
      // that exceeded max hold time are not stranded open in Redis indefinitely.
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }

    // Normalise a raw exchange symbol for map-key comparison.
    // BingX (and several other venues) return "BTC-USDT" or "BTC_USDT"
    // while Redis stores the normalised form "BTCUSDT". Strip all
    // separators before building / querying the key so a BingX position
    // is never mistaken for "externally closed" simply because the symbol
    // format differs.
    const normSym = (raw: string) => raw.toUpperCase().replace(/[-_]/g, "")

    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = normSym(String(ep.symbol || ep.Symbol || ""))
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
        const mapKey = `${normSym(pos.symbol)}|${pos.direction}`
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

          // ── Entry-order fill detection (reconcile path) ───────────────
          // Two-layer detection so a position is never stuck as "placed"
          // even when getOrder() lags or returns a stale status:
          //
          // Layer 1 — Exchange position present in exchangeMap: The
          //   exchange returned this symbol+direction in getPositions(),
          //   which is definitive proof the entry filled. Sync qty/price
          //   from the exchange position data directly without needing getOrder().
          //
          // Layer 2 — getOrder() polling: Confirms via the order status
          //   and provides more precise filledQty/avgPrice. Also handles
          //   the rejected/cancelled case so stale records are cleaned up.
          let justFilled = false
          if (pos.status === "placed") {
            // Layer 1: exchange position proves fill — use it directly.
            const exSize  = parseFloat(String(exPos.size ?? exPos.positionAmt ?? exPos.quantity ?? "0")) || 0
            const exEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? exPos.markPrice ?? "0")) || 0
            if (exSize > 0) {
              if (pos.executedQuantity <= 0) {
                pos.executedQuantity = exSize
                pos.remainingQuantity = 0
                pos.averageExecutionPrice = exEntry || pos.entryPrice
              }
              pos.status = "open"
              pos.updatedAt = Date.now()
              justFilled = true
              await incrementMetric(connectionId, "live_orders_filled_count")
            }

            // Layer 2: try getOrder() for more precise data and to catch rejections.
            if (pos.orderId) {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                const statusLower = String(order?.status ?? "").toLowerCase()
                const orderFilledQty = parseFloat(String(order?.filledQty ?? order?.executedQty ?? "0")) || 0
                if (order && (statusLower === "filled" || statusLower === "partially_filled" || orderFilledQty > 0)) {
                  // Prefer getOrder data (more precise) over exchangeMap position data.
                  if (orderFilledQty > 0) {
                    pos.executedQuantity = orderFilledQty
                    pos.remainingQuantity = Math.max(0, pos.quantity - pos.executedQuantity)
                    pos.averageExecutionPrice = parseFloat(String(order.filledPrice ?? order.avgPrice ?? "0")) || pos.averageExecutionPrice || pos.entryPrice
                  }
                  pos.status = "open"
                  pos.updatedAt = Date.now()
                  if (!justFilled) {
                    justFilled = true
                    await incrementMetric(connectionId, "live_orders_filled_count")
                  }
                } else if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
                  // Entry order was cancelled/rejected — close the position record.
                  pos.status = "rejected"
                  pos.closeReason = `entry_order_${statusLower}`
                  pos.closedAt = Date.now()
                  pos.updatedAt = Date.now()
                  await savePosition(pos)
                  summary.updated++
                  continue
                }
              } catch {
                /* getOrder() may fail transiently — Layer 1 result stands */
              }
            }
          }

          // ── SL/TP self-healing ──────────────────────────────────────────
          // Every reconcile cycle we verify protection orders match the
          // desired levels. updateProtectionOrders() is no-op when nothing
          // drifted — only fires real REST calls when something changed.
          //
          // Skip for positions still awaiting entry fill AND not yet
          // confirmed by the exchange — placing SL/TP before the position
          // exists on the exchange will fail with "position not found".
          if (pos.status === "placed") {
            await savePosition(pos)
            summary.updated++
            continue
          }
          try {
            await updateProtectionOrders(exchangeConnector, pos, justFilled ? "reconcile_fill_detected" : "reconcile")
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} reconcile SL/TP heal error for ${pos.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }

          // ── Proactive close-in-time safety check ───────────────────
          // Even when the exchange-placed reduce-only SL/TP orders are
          // armed, on a sharp price gap (illiquid pair / news / slow
          // fill) the exchange may not fire them in time — leaving the
          // position open past the configured threshold. We compare
          // mark price vs. desired SL/TP and force-close if breached.
          //
          // Implementation lives in `checkAndForceCloseOnSltpCross` so
          // the same logic runs from `syncWithExchange` (engine loop)
          // and `recalculateAndApplySLTP` (operator override) too —
          // the user explicitly asked for the close to happen
          // "independent of the control orders".
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice,
            exchangeConnector,
          )
          if (crossed) {
            summary.closed++
            continue // close already persisted by helper
          }

          // ── Max-hold-time safety closer (reconcile path) ────────────
          const MAX_HOLD_TIME_MS = Number(process.env.MAX_POSITION_HOLD_MS ?? 4 * 60 * 60 * 1000)
          const openedAt = pos.createdAt || pos.updatedAt || 0
          const heldMs = Date.now() - openedAt
          if (
            MAX_HOLD_TIME_MS > 0 &&
            heldMs > MAX_HOLD_TIME_MS &&
            pos.executedQuantity > 0 &&
            (pos.status === "open" || pos.status === "filled")
          ) {
            const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
            console.warn(
              `${LOG_PREFIX} [reconcile] MAX HOLD TIME exceeded for ${pos.symbol} (held ${Math.round(heldMs / 60000)}min) — force-closing`,
            )
            await logProgressionEvent(
              connectionId,
              "live_trading",
              "warning",
              `Max hold time exceeded for ${pos.symbol} — force-closing (reconcile)`,
              { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
            )
            await closeLivePosition(connectionId, pos.id, exitPrice, exchangeConnector, "max_hold_time_exceeded")
            summary.closed++
            continue
          }

          await savePosition(pos)
          summary.updated++
        } else {
          // Position closed externally — compute PnL, move to archive.
          // Exit-price resolution order:
          //   1. Last markPrice the reconcile loop refreshed from the exchange
          //   2. averageExecutionPrice (confirmed fill price from original entry)
          //   3. Redis market_data hash for the symbol (most-recent tick price)
          //   4. entryPrice as last resort (PnL will read 0 but position is closed)
          let exitPrice = pos.exchangeData?.markPrice || pos.averageExecutionPrice || 0
          if (exitPrice <= 0) {
            try {
              const mdHash = await client.hgetall(`market_data:${pos.symbol}`)
              const mdPrice = parseFloat(
                String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0")
              )
              if (mdPrice > 0) exitPrice = mdPrice
            } catch { /* ignore — fall through to entryPrice */ }
          }
          if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
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

          // Best-effort market-close on the exchange for positions that
          // disappeared without a known SL/TP order (e.g. a partial fill
          // that then stalled, or a network partition that left the entry
          // order orphaned). If the position is truly gone (SL/TP already
          // fired) the connector's closePosition() will get a "position
          // not found" error which is silently swallowed — the only side-
          // effect is one extra REST call per such reconcile cycle.
          if (pos.executedQuantity > 0 && pos.status !== "placed") {
            try {
              await exchangeConnector.closePosition(pos.symbol, pos.direction)
            } catch {
              /* already gone — this is expected when SL/TP fired normally */
            }
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
          await savePosition(pos)
          const alreadyMoved = await client.get(movedMarker).catch(() => null)

          const progKey = `progression:${connectionId}`
          // Lock + TTL refresh always run (idempotent operations).
          const writes: Promise<any>[] = [
            client.expire(progKey, 7 * 24 * 60 * 60).catch(() => {}),
            client.del(`live:lock:${connectionId}:${pos.symbol}:${pos.direction}`).catch(() => {}),
          ]
          // Counter increments + index move ONLY when this iteration
          // is the first one to terminalise the position. The moved
          // marker is shared with `closeLivePosition()` and
          // `savePosition()` so an external close → reconcile sweep
          // never double-counts. This is what was producing the
          // operator's reported `Positions Closed > Positions Created`
          // skew (counters drifted on every reconcile re-entry).
          if (!alreadyMoved) {
            writes.push(
              client.hincrby(progKey, "live_positions_closed_count", 1).catch(() => {}),
              client.lrem(openIndexKey, 0, pos.id).catch(() => {}),
              client.lpush(closedIndexKey, pos.id).catch(() => {}),
              client.ltrim(closedIndexKey, 0, 4999).catch(() => {}),
              client.expire(closedIndexKey, 30 * 24 * 60 * 60).catch(() => {}),
              client.setex(movedMarker, 604800, "1").catch(() => {}),
            )
            if (realizedPnl > 0) {
              writes.push(client.hincrby(progKey, "live_wins_count", 1).catch(() => {}))
            }
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
        }

        // ── Delayed-fill SL/TP arming ─────────────────────────���───────
        // If the entry order was still pending when `executeLivePosition`
        // tried to place SL/TP, that step pushed `place_sl_tp = skipped`
        // and the position ended up `placed` with no protection orders.
        // When this loop now detects the order has filled, we transition
        // to `open` AND must arm SL/TP — otherwise the operator gets
        // an open exchange position with zero stop-loss / take-profit
        // protection. This was a real bug the user reported as
        // "TP/SL control orders are not working".
        let justFilled = false
        if (position.status === "placed" && position.orderId) {
          try {
            const order = await exchangeConnector.getOrder(position.symbol, position.orderId)
            if (order?.status === "filled") {
              position.executedQuantity = order.filledQty || position.quantity
              position.remainingQuantity = Math.max(0, position.quantity - position.executedQuantity)
              position.averageExecutionPrice = order.filledPrice || position.entryPrice
              position.status = "open"
              position.updatedAt = Date.now()
              justFilled = true
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
            /* ignore — next sync cycle will retry */
          }
        }

        // Arm or refresh protection orders. `updateProtectionOrders` is
        // a no-op when nothing has drifted (price + qty stable, both
        // legs already armed at correct levels) so this is cheap on the
        // steady state. After a delayed fill (`justFilled`) it's a real
        // place; after accumulation it re-arms for the new total qty;
        // after an operator-cancelled SL on the exchange it re-places.
        if (position.executedQuantity > 0) {
          try {
            await updateProtectionOrders(
              exchangeConnector,
              position,
              justFilled ? "sync_fill_detected" : "sync_heal",
            )
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} sync SL/TP heal error for ${position.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }
        }

        // ── Proactive close-in-time SL/TP check ───────────────────────
        // Same safety net `reconcileLivePositions` runs, applied here
        // so the engine loop catches crosses between cron ticks. If a
        // cross fires we skip the per-position setex below — the close
        // helper already persisted the terminal state and moved the
        // index entry to the closed archive.
        const markPrice = Number(position.exchangeData?.markPrice ?? 0)
        if (markPrice > 0) {
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            position,
            markPrice,
            exchangeConnector,
          )
          if (crossed) continue
        }

        // ── Max-hold-time safety closer ────────────────────────────────
        // If the position has been open longer than MAX_HOLD_TIME_MS,
        // force-close it regardless of whether SL/TP levels were
        // crossed. This is the "orders not closing in time" safety net —
        // even if the exchange-placed SL/TP orders fail to fire (e.g.
        // network issue, illiquid gap, operator manual cancel), the
        // position will not be held indefinitely.
        //
        // Default: 4 hours. Override via env MAX_POSITION_HOLD_MS.
        const MAX_HOLD_TIME_MS = Number(process.env.MAX_POSITION_HOLD_MS ?? 4 * 60 * 60 * 1000)
        const openedAt = position.createdAt || position.updatedAt || 0
        const heldMs = Date.now() - openedAt
        if (
          MAX_HOLD_TIME_MS > 0 &&
          heldMs > MAX_HOLD_TIME_MS &&
          position.executedQuantity > 0 &&
          (position.status === "open" || position.status === "filled")
        ) {
          const exitPrice = markPrice || position.averageExecutionPrice || position.entryPrice
          console.warn(
            `${LOG_PREFIX} MAX HOLD TIME exceeded for ${position.symbol} (held ${Math.round(heldMs / 60000)}min > ${Math.round(MAX_HOLD_TIME_MS / 60000)}min) — force-closing`,
          )
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Max hold time exceeded for ${position.symbol} — force-closing`,
            { positionId: position.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
          )
          await closeLivePosition(connectionId, position.id, exitPrice, exchangeConnector, "max_hold_time_exceeded")
          continue
        }

        const key = `live:position:${position.id}`
        await client.setex(key, 604800, JSON.stringify(position))
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

    // Capture pre-override values so we can audit the diff in progression.
    // Note: we deliberately do NOT touch `assignedStopLoss` /
    // `assignedTakeProfit` — those are the immutable strategy-contract
    // snapshot. After this call they remain equal to their creation-time
    // values while `stopLoss` / `takeProfit` carry the operator override.
    const prevStopLossPct = position.stopLoss
    const prevTakeProfitPct = position.takeProfit
    if (overrides?.stopLossPct !== undefined) position.stopLoss = overrides.stopLossPct
    if (overrides?.takeProfitPct !== undefined) position.takeProfit = overrides.takeProfitPct

    const slChanged = position.stopLoss !== prevStopLossPct
    const tpChanged = position.takeProfit !== prevTakeProfitPct
    if (slChanged || tpChanged) {
      // Single audit-trail event per override. The progression panel
      // shows it as a `live_trading info` row alongside the subsequent
      // `update_sl_tp` step pushed by `updateProtectionOrders`. Together
      // they tell the full story: "operator changed SL from X% to Y%,
      // exchange order re-armed at price Z".
      await logProgressionEvent(
        position.connectionId,
        "live_trading",
        "info",
        `SL/TP override applied to ${position.symbol}`,
        {
          assignedStopLossPct: position.assignedStopLoss,
          assignedTakeProfitPct: position.assignedTakeProfit,
          previousStopLossPct: prevStopLossPct,
          previousTakeProfitPct: prevTakeProfitPct,
          newStopLossPct: position.stopLoss,
          newTakeProfitPct: position.takeProfit,
          slChanged,
          tpChanged,
        },
      )
    }

    await updateProtectionOrders(exchangeConnector, position, "manual_recalc")
    position.updatedAt = Date.now()
    await savePosition(position)

    // ── Immediate post-override cross check ────────────────────────────
    // If the operator just tightened SL or TP to a level the position
    // is already past, the exchange-placed reduce-only order may take
    // a moment to fire (or be rejected outright as "trigger price
    // already breached"). Run the same proactive close helper used by
    // the engine loop so the position is reconciled to closed within
    // the same call rather than waiting for the next cron tick.
    try {
      const markPrice = Number(position.exchangeData?.markPrice ?? 0)
      if (markPrice > 0) {
        await checkAndForceCloseOnSltpCross(
          position.connectionId,
          position,
          markPrice,
          exchangeConnector,
        )
      }
    } catch (crossErr) {
      console.warn(
        `${LOG_PREFIX} post-override cross check error for ${position.id}:`,
        crossErr instanceof Error ? crossErr.message : String(crossErr),
      )
    }
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} recalculateAndApplySLTP error:`, err)
    return null
  }
}

/**
 * ── syncLiveFromPseudo (spec §6) ─────────────────────────────────────
 *
 * Copy SL/TP percentages from a pseudo (strategy-side virtual) position
 * onto matching live (exchange-side real) positions on the same
 * symbol + direction, then re-arm the exchange protection orders so
 * the new levels are actually enforced.
 *
 * Operator: "pseudo pos updates with trailing, steps etc is working
 * completely correct and live pos are correctly synchron". That's the
 * target — this helper closes the gap between strategy-side trailing
 * and exchange-side SL/TP by piping percent updates through to
 * `recalculateAndApplySLTP`, which already does
 * cancel-old → place-new → persist + audit.
 *
 * Inputs:
 *   - `pseudoPos.symbol` (string, required) and `pseudoPos.side`
 *     ("long" | "short") — match key against live positions.
 *   - `pseudoPos.stoploss_ratio` / `pseudoPos.takeprofit_factor`
 *     (ratio form, e.g. 0.02 = 2%) OR `pseudoPos.stopLoss` /
 *     `pseudoPos.takeProfit` (percent form). Auto-detected by
 *     magnitude — anything < 1 is treated as ratio and multiplied by
 *     100, anything ≥ 1 is treated as already-percent.
 *
 * Idempotent: if percentages unchanged `recalculateAndApplySLTP`
 * no-ops on the diff. Per-position errors are swallowed.
 *
 * Caller contract: fire-and-forget. Returns `Promise<void>` and never
 * throws past this boundary — the realtime hot path must NEVER await
 * on exchange round-trips.
 */
export async function syncLiveFromPseudo(
  connectionId: string,
  pseudoPos: any,
  exchangeConnector: any,
): Promise<void> {
  try {
    const symbol = String(pseudoPos?.symbol || "").toUpperCase()
    const side: "long" | "short" = pseudoPos?.side === "short" ? "short" : "long"
    if (!symbol) return

    const rawSL = Number(pseudoPos?.stoploss_ratio ?? pseudoPos?.stopLoss ?? NaN)
    const rawTP = Number(pseudoPos?.takeprofit_factor ?? pseudoPos?.takeProfit ?? NaN)
    if (!Number.isFinite(rawSL) && !Number.isFinite(rawTP)) return

    // Ratio (< 1) → percent; already-percent (≥ 1) → keep as-is.
    const slPct = Number.isFinite(rawSL) ? (Math.abs(rawSL) < 1 ? rawSL * 100 : rawSL) : undefined
    const tpPct = Number.isFinite(rawTP) ? (Math.abs(rawTP) < 1 ? rawTP * 100 : rawTP) : undefined

    const livePositions = await getLivePositions(connectionId)
    const matches = livePositions.filter((p: any) => {
      const liveSide: "long" | "short" =
        p.direction === "short" || p.side === "short" ? "short" : "long"
      return String(p.symbol || "").toUpperCase() === symbol && liveSide === side && p.status !== "closed"
    })
    if (matches.length === 0) return

    for (const livePos of matches) {
      try {
        await recalculateAndApplySLTP(connectionId, livePos.id, exchangeConnector, {
          stopLossPct: slPct,
          takeProfitPct: tpPct,
        })
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} syncLiveFromPseudo: failed for ${livePos.id} (${symbol}/${side}):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} syncLiveFromPseudo top-level error:`, err instanceof Error ? err.message : String(err))
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
  syncLiveFromPseudo,
  getClosedLivePositions,
}
