import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const revalidate = 0

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? x : 0
}

function pick(...values: unknown[]): number {
  for (const v of values) {
    const x = n(v)
    if (x > 0) return x
  }
  return 0
}

/**
 * GET /api/connections/progression/[id]/stats
 *
 * Canonical statistics endpoint consumed by all dashboard UIs.
 * Reads from three dedicated Redis namespaces so historic vs realtime
 * processing metrics are always cleanly separated:
 *
 *   prehistoric:{connId}              – written by trackPrehistoricStats()
 *   realtime:{connId}                 – written by trackRealtimeCycle()
 *   progression:{connId}              – written every cycle by ProgressionStateManager
 *                                       and statistics-tracker (hincrby)
 *
 * Falls back to trade_engine_state:{connId} (flushed every 50-100 cycles)
 * only when the primary sources return zero.
 *
 * ── IMPORTANT: Pipeline semantics (applies to every stage total below) ─
 * Base → Main → Real → Live is a CASCADE FILTER pipeline:
 *   Base  = initial Set enumeration (eval)
 *   Main  = Base Sets that survived the Main PF/DDT filter
 *   Real  = Main Sets that survived the strict Real filter (adjust)
 *   Live  = Real Sets promoted to the exchange (runtime subset of Real)
 * Each downstream stage contains the SAME logical strategies that survived
 * the upstream stage — it is NOT a separate population. Therefore:
 *
 *   canonical "strategies total" = Real-stage count (final filtered output)
 *
 * and stage counters MUST NEVER be summed together. Ratios between adjacent
 * stages (e.g. main/base) express pass-through rate, not additive totals.
 * The same rule applies to pseudo-position base/main/real counts.
 *
 * Response shape:
 * {
 *   historic: { symbolsProcessed, symbolsTotal, candlesLoaded, indicatorsCalculated,
 *               cyclesCompleted, isComplete, progressPercent,
 *               processing: { indicationChurnCycles, strategyChurnCycles } }
 *   realtime: { indicationCycles, strategyCycles, realtimeCycles, indicationsTotal,
 *               strategiesTotal, positionsOpen, isActive, successRate, avgCycleTimeMs,
 *               cycleCounters: {                            // per-processor cumulative
 *                 indication, indicationLive,               // (every tick / live only)
 *                 strategy, strategyLive,
 *                 realtime, realtimeLive
 *               },
 *               framesProcessed                              // cross-processor tick total
 *                                                            // — independent of 250 cap }
 *               ↑ strategiesTotal = Real-stage output (NOT sum of stages)
 *   breakdown: {
 *     indications: { direction, move, active, activeAdvanced, optimal, auto, total }
 *     strategies:  { base, main, real, live, total,
 *                    baseEvaluated, mainEvaluated, realEvaluated }
 *                    ↑ `total` = Real-stage count only, per pipeline rule above
 *   }
 *   metadata: { engineRunning, phase, progress, message, lastUpdate, redisDbEntries }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: connectionId } = await params

    await initRedis()
    const client = getRedisClient()
    if (!client) {
      return NextResponse.json({ error: "Redis not available" }, { status: 503 })
    }

    // ── Read all namespaces in parallel ──────────────────────────────────────
    // NOTE: hgetall returns null (not throws) when the key doesn't exist — always coerce to {}
    const [
      progHashRaw,
      prehistoricHashRaw,
      realtimeHashRaw,
      engineState,
      engineProgression,
      prehistoricSymbolCount,
      axisWindowsHashRaw,
    ] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => null),
      client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
      client.hgetall(`realtime:${connectionId}`).catch(() => null),
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`engine_progression:${connectionId}`).catch(() => ({})),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      // Per-axis-window cumulative counters written by createMainSets in
      // strategy-coordinator.ts. Hash fields are `${axis}_${N}_sets` /
      // `${axis}_${N}_pos` for axis ∈ {prev, last, cont, pause} and the
      // step-1 windows documented in StrategySet.axisWindows.
      client.hgetall(`axis_windows:${connectionId}`).catch(() => null),
    ])

    const progHash: Record<string, string>       = progHashRaw       || {}
    const prehistoricHash: Record<string, string> = prehistoricHashRaw || {}
    const realtimeHash: Record<string, string>   = realtimeHashRaw   || {}
    const axisWindowsHash: Record<string, string> = axisWindowsHashRaw || {}

    const es = (engineState as Record<string, any>) || {}
    const ep = (engineProgression as Record<string, any>) || {}

    // ── HISTORIC section ─────────────────────────────────────────────────────
    // Primary: prehistoric:{connId} hash (written by trackPrehistoricStats)
    // Secondary: progression hash mirror fields
    // Tertiary: trade_engine_state fields (config_set_*)
    const historicSymbolsProcessed = pick(
      n(prehistoricHash.symbols_processed),
      prehistoricSymbolCount,
      n(progHash.prehistoric_symbols_processed_count),
      n(es.config_set_symbols_processed)
    )

    // Total user-selected symbols: canonical source is
    //   prehistoric:{id}.symbols_total  (written by quickstart + engine)
    //   trade_engine_state:{id}.config_set_symbols_total
    //   length of the symbols array actually stored for the engine
    // We DO NOT default to a magic "3" anymore — that caused the UI to
    // display misleading totals (e.g. "1/3") when the user selected 1
    // symbol in the Quickstart slot. Fall back to `processed || 1` only
    // when we genuinely have no other source.
    let symbolsFromArray = 0
    if (Array.isArray((es as any).symbols)) {
      symbolsFromArray = (es as any).symbols.length
    } else if (Array.isArray((es as any).active_symbols)) {
      symbolsFromArray = (es as any).active_symbols.length
    } else if (typeof (es as any).active_symbols === "string") {
      try {
        const parsed = JSON.parse((es as any).active_symbols)
        if (Array.isArray(parsed)) symbolsFromArray = parsed.length
      } catch { /* ignore */ }
    }
    const historicSymbolsTotal = Math.max(
      historicSymbolsProcessed,
      n(prehistoricHash.symbols_total),
      n(es.config_set_symbols_total),
      symbolsFromArray,
      1
    )
    const historicCandlesLoaded = pick(
      n(prehistoricHash.candles_loaded),
      n(progHash.prehistoric_candles_processed),
      n(es.config_set_candles_processed)
    )
    const historicIndicatorsCalculated = pick(
      n(prehistoricHash.indicators_calculated),
      n(es.config_set_indication_results)
    )
    const historicCyclesCompleted = pick(
      n(progHash.prehistoric_cycles_completed),
      n(es.config_set_symbols_processed)
    )
    const historicIsComplete =
      prehistoricHash.is_complete === "1" ||
      progHash.prehistoric_phase_active === "false" && historicSymbolsProcessed > 0 ||
      es.prehistoric_data_loaded === true ||
      es.prehistoric_data_loaded === "1"
    const historicProgressPercent = historicIsComplete
      ? 100
      : historicSymbolsTotal > 0
        ? Math.min(99, Math.round((historicSymbolsProcessed / historicSymbolsTotal) * 100))
        : 0

    // ── REALTIME section ─────────────────────────────────────────────────────
    // Primary:   live_*_cycle_count    — only ticks that produced real work
    //                                     (indications generated / strategies evaluated).
    //                                     This is the user-facing "live progression" metric.
    // Secondary: *_cycle_count         — every tick incl. warmup/empty. Prehistoric processing
    //                                     churn, surfaced under historic.processing below,
    //                                     kept calculatively hidden from the main display.
    //
    // If the live counter is still zero (first few moments after start), fall back to the
    // churn counter so the UI doesn't render a misleading 0 while the engine spins up.
    const churnIndicationCycles = pick(
      n(progHash.indication_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.indication_cycle_count)
    )
    const churnStrategyCycles = pick(
      n(progHash.strategy_cycle_count),
      n(es.strategy_cycle_count)
    )
    const liveIndicationCycles = n(progHash.indication_live_cycle_count)
    const liveStrategyCycles   = n(progHash.strategy_live_cycle_count)
    const liveRealtimeCycles   = n(progHash.realtime_live_cycle_count)

    const realtimeIndicationCycles = liveIndicationCycles || churnIndicationCycles
    const realtimeStrategyCycles   = liveStrategyCycles   || churnStrategyCycles
    // realtimeCycles = total realtime ticks (churn). This is now actually
    // populated because EngineManager.startRealtimeProcessor writes
    // `realtime_cycle_count` on every tick via hincrby (previously this key
    // was never written, so this counter was permanently 0).
    const realtimeCycles = pick(
      n(progHash.realtime_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.realtime_cycle_count)
    )

    // Cross-processor cumulative tick counter — sum of every tick across
    // indication + strategy + realtime processors since the engine started.
    // INDEPENDENT of the per-Set 250-entry DB cap. This is the "Frames /
    // Total Ticks" metric on the dashboard.
    const framesProcessed = n(progHash.frames_processed)

    // Cycle time average from realtime hash
    const realtimeCycleTimeSum = n(realtimeHash.cycle_time_sum_ms)
    const realtimeCycleCount   = n(realtimeHash.cycle_count) || 1  // avoid div-by-zero
    const avgCycleTimeMs = realtimeCycleTimeSum > 0
      ? Math.round(realtimeCycleTimeSum / realtimeCycleCount)
      : n(es.last_cycle_duration)

    const successRate = parseFloat(progHash.cycle_success_rate || String(es.cycle_success_rate || "100"))

    // Total indications/strategies evaluated — prefer progression hash
    const indicationsTotal = pick(
      n(progHash.indications_count),
      n(realtimeHash.total_indications),
      n(es.total_indications_evaluated)
    )
    const strategiesTotal = pick(
      n(progHash.strategies_count),
      n(realtimeHash.total_strategies),
      n(es.total_strategies_evaluated)
    )

    // ── OPEN POSITIONS + ACCUMULATED VOLUME (per-Set rollup) ────────────
    //
    // We track *two* independent open-position namespaces because they
    // answer different questions:
    //
    //   1. PseudoPositionManager rows at `pseudo_position:{connId}:{id}`
    //      — every live Base-stage pseudo position carries its full
    //      sizing (`position_cost`, `quantity`, `entry_price`) plus the
    //      `config_set_key` that identifies which strategy Set created
    //      it. Summing `position_cost` gives the accumulated notional
    //      USD across every *running* pseudo position, and grouping by
    //      `config_set_key` gives a per-Set rollup so the operator can
    //      see "Set X currently has 3 positions worth $1,200".
    //      Running Sets = SCARD of `pseudo_positions:{connId}:active_config_keys`.
    //
    //   2. Real-stage positions at `real:position:real:{connId}:*` —
    //      these carry `quantity * entryPrice` notional but no
    //      per-Set key; they represent Main → Real promotions that
    //      survived ratio gating. We report count + accumulated USD
    //      volume so the Strategies → Real tile can show the same
    //      "currently holding" picture as Main/Live.
    //
    // Live exchange accumulated volume is already exposed via
    // progHash.live_volume_usd_total (cumulative) and derived into
    // `openPositions.live` below.
    let pseudoOpen = 0
    let pseudoRunningSets = 0
    // Per-Set open-position counts (pseudo evaluation stage).
    // Volume is intentionally NOT tracked here — pseudo is a
    // simulated-sizing evaluation stage, not real exchange exposure.
    // Count is the only meaningful metric for the mirroring pipeline
    // health view.
    const pseudoSetAgg = new Map<string, { count: number }>()
    // ── Symbol+direction → setKey lookup index ───────────────────────
    // Built during the pseudo-position scan so the live-stage
    // Set-relation join below can identify which Set an exchange
    // position was mirrored from WITHOUT requiring new fields on the
    // LivePosition schema. Keyed as `SYMBOL:direction` (upper-cased
    // symbol, lowercase direction). Value = candidate setKeys
    // currently holding open pseudo positions for that pair; ranking
    // is by pseudo-position count (how many eval positions the Set
    // carries). In practice a live position maps to exactly one Set
    // (the one whose Real promotion triggered the exchange order) —
    // we expose candidates regardless so the operator sees the
    // relationship even when multiple equivalent Sets overlap on the
    // same symbol/direction (the consolidation case).
    const pseudoSymDirIdx = new Map<
      string,
      Array<{ setKey: string; count: number }>
    >()

    try {
      const posIds = (await client
        .smembers(`pseudo_positions:${connectionId}`)
        .catch(() => [] as string[])) || []
      // Parallel hgetall for every id — matches the fan-out pattern in
      // stages/real-stage.ts etc. A sequential loop here dominated
      // /stats latency when pseudo positions accumulated.
      const hashes = await Promise.all(
        posIds.slice(0, 500).map((id) =>
          client.hgetall(`pseudo_position:${connectionId}:${id}`).catch(() => null),
        ),
      )
      for (const h of hashes) {
        if (!h) continue
        const hh = h as Record<string, any>
        const status = hh.status ?? "active"
        // Only "open" rows count — status="active" (PseudoPositionManager
        // default) and status="open" (legacy) are both live; everything
        // else (closed, cancelled, rejected) is excluded.
        if (status !== "active" && status !== "open") continue
        pseudoOpen++

        const setKey = String(hh.config_set_key || "").trim()
        if (setKey) {
          const prev = pseudoSetAgg.get(setKey) || { count: 0 }
          prev.count++
          pseudoSetAgg.set(setKey, prev)

          // Populate symbol+direction → setKey join index for live
          // position coordination (see openPositions.live.positions
          // downstream). Same per-hash pass — no extra Redis work.
          // Equivalent upstream Sets sharing the same symbol+direction
          // appear in this list and will be consolidated into a single
          // exchange position downstream (the mirroring principle).
          const sym = String(hh.symbol || "").trim().toUpperCase()
          const dir = String(hh.direction || "").trim().toLowerCase()
          if (sym && (dir === "long" || dir === "short")) {
            const joinKey = `${sym}:${dir}`
            const arr = pseudoSymDirIdx.get(joinKey) || []
            const existing = arr.find((e) => e.setKey === setKey)
            if (existing) {
              existing.count++
            } else {
              arr.push({ setKey, count: 1 })
            }
            pseudoSymDirIdx.set(joinKey, arr)
          }
        }
      }

      // Running Sets = distinct config_set_keys currently active. This
      // is the set PseudoPositionManager maintains for O(1) duplicate
      // detection; it's the ground truth for "valid Running Sets".
      pseudoRunningSets = Number(
        await client
          .scard(`pseudo_positions:${connectionId}:active_config_keys`)
          .catch(() => 0),
      ) || 0
    } catch { /* non-critical */ }

    // Back-compat: the historic `positionsOpen` field always referred
    // to the pseudo total, so keep that contract.
    const positionsOpen = pseudoOpen

    // Top-5 per-Set rollup sorted by POSITION COUNT — pseudo positions
    // are evaluation-stage exposure, not real money, so sorting by count
    // (how many eval positions the Set carries) is the meaningful metric.
    // Volume is intentionally NOT surfaced here; it would conflate
    // simulated-sizing eval with actual exchange exposure. Real USD
    // exposure lives on the live branch below.
    const pseudoTopSets = Array.from(pseudoSetAgg.entries())
      .map(([setKey, agg]) => ({ setKey, count: agg.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // ── Real-stage open positions ────────────────────────────────────
    //
    // Real positions are Main→Real promotions awaiting mirror into
    // exchange orders. Count only — USD volume is NOT tracked here
    // either; Real is still a pipeline stage, not the exchange. The
    // only authoritative USD exposure is live.volumeUsd below.
    // Bounded by a 500-key safety ceiling — anything beyond that
    // is a data-hygiene issue the operator needs to fix independently.
    let realOpen = 0
    // ── Symbol+direction → candidate Real positions index ─────────
    // Populated alongside the Real scan so live-position resolution
    // can fall back to Real when the pseudo ledger has no matching
    // entry (e.g. Set was closed before the exchange position did).
    // No volume tracked — resolution just needs existence + id.
    const realSymDirIdx = new Map<
      string,
      Array<{ realPositionId: string }>
    >()
    try {
      const realKeys = await client.keys(`real:position:real:${connectionId}:*`)
      if (realKeys.length > 0) {
        const caps = realKeys.slice(0, 500)
        const raws = await Promise.all(
          caps.map((k: string) => client.get(k).catch(() => null)),
        )
        for (const raw of raws) {
          if (!raw) continue
          try {
            const pos = JSON.parse(raw as string)
            if (pos.status === "closed") continue
            realOpen++
            // Index for live position join (fallback path)
            const sym = String(pos.symbol || "").trim().toUpperCase()
            const dir = String(pos.direction || "").trim().toLowerCase()
            if (sym && (dir === "long" || dir === "short") && pos.id) {
              const joinKey = `${sym}:${dir}`
              const arr = realSymDirIdx.get(joinKey) || []
              arr.push({ realPositionId: String(pos.id) })
              realSymDirIdx.set(joinKey, arr)
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-critical */ }

    // ── Live-stage OPEN positions + Set-relation join ────────────────
    //
    // The operator asked for a coordination view that identifies which
    // Set each live exchange position came from. The live-stage
    // persists positions at `live:position:{id}` with
    // `{ symbol, direction, realPositionId, quantity, entryPrice,
    //    exchangeData: { unrealizedPnl, markPrice }, status, ... }`.
    //
    // The live ledger does NOT natively carry `config_set_key` (the
    // Set identifier lives on pseudo rows upstream). We resolve the
    // relationship here, server-side, by joining on
    // `symbol + direction` against the pseudoSymDirIdx built during
    // the Base scan above. For any live position whose pseudo join
    // returns no candidates, we fall back to the Real-stage index —
    // useful when the Set closed its pseudo row between order
    // placement and the stats request. Each live position is exposed
    // with its top-3 candidate setKeys (ordered by per-set USD
    // exposure), giving the UI everything it needs to render a
    // "which Set does this live position belong to?" tooltip without
    // extra API round-trips.
    const livePositionSetRelations: Array<{
      id: string
      symbol: string
      direction: "long" | "short"
      // ── Exchange exposure (the ONLY authoritative real-money figures) ──
      volumeUsd: number
      quantity: number
      leverage: number
      marginType: "cross" | "isolated"
      marginUsd: number               // volumeUsd / leverage — actual capital at risk
      // ── Price tracking ────────────────────────────────────────────────
      entryPrice: number
      markPrice: number
      liquidationPrice: number        // from exchange sync (critical safety info)
      liquidationDistancePct: number  // % distance mark → liq (negative = dangerous)
      // ── PnL ──────────────────────────────────────────────────────────
      unrealizedPnl: number
      roiPct: number                  // unrealizedPnl / marginUsd × 100 (matches ROE)
      // ── Risk-management levels ───────────────────────────────────────
      stopLossPrice: number
      takeProfitPrice: number
      // ── Exchange order references ────────────────────────────────────
      orderId?: string
      stopLossOrderId?: string
      takeProfitOrderId?: string
      // ── Lifecycle ────────────────────────────────────────────────────
      status: string
      createdAt: number
      updatedAt: number
      syncedAt: number                // last exchange reconciliation (staleness check)
      realPositionId?: string
      // ── Coordination (mirroring fan-in) ──────────────────────────────
      // Equivalent upstream Sets mirrored into this ONE exchange order.
      // Count = how many pseudo eval positions that Set is currently
      // holding. No per-Set USD (eval-stage notionals are NOT real
      // exposure and would be misleading).
      setKeys: Array<{ setKey: string; count: number }>
      // `resolution` tells the UI exactly HOW the Set was identified:
      //   • "pseudo"        — exact pseudo row exists for this symbol+dir
      //   • "real-fallback" — no pseudo match; resolved via Real ledger
      //   • "unresolved"    — nothing upstream matched (stale or manual)
      resolution: "pseudo" | "real-fallback" | "unresolved"
    }> = []
    try {
      const liveOpenIds = ((await client
        .lrange(`live:positions:${connectionId}`, 0, 499)
        .catch(() => [])) || []) as string[]

      if (liveOpenIds.length > 0) {
        const rawList = await Promise.all(
          liveOpenIds.map((id) =>
            client.get(`live:position:${id}`).catch(() => null),
          ),
        )
        for (const raw of rawList) {
          if (!raw) continue
          try {
            const pos = JSON.parse(raw as string)
            // Exclude closed/cancelled; accept every in-flight state
            // where exchange exposure is still on the books.
            const status = String(pos.status || "").toLowerCase()
            if (status === "closed" || status === "cancelled" || status === "error") continue

            const sym = String(pos.symbol || "").trim().toUpperCase()
            const dir = String(pos.direction || "").trim().toLowerCase()
            if (!sym || (dir !== "long" && dir !== "short")) continue

            const qty = Number(pos.executedQuantity || pos.quantity) || 0
            const px  = Number(pos.averageExecutionPrice || pos.entryPrice) || 0
            const volumeUsd = qty > 0 && px > 0 ? Math.round(qty * px * 100) / 100 : 0

            const joinKey = `${sym}:${dir}`
            let setKeys: Array<{ setKey: string; count: number }> = []
            let resolution: "pseudo" | "real-fallback" | "unresolved" = "unresolved"

            const pseudoMatches = pseudoSymDirIdx.get(joinKey)
            if (pseudoMatches && pseudoMatches.length > 0) {
              // Rank by pseudo-position count (how many eval positions
              // the Set is holding) — count is the only meaningful
              // eval-stage metric, since USD notionals at this stage
              // are simulated-sizing not real exposure. All equivalent
              // Sets on the same symbol+dir are surfaced so the UI can
              // render "N Sets → 1 exchange order" consolidation.
              setKeys = [...pseudoMatches]
                .sort((a, b) => b.count - a.count)
                .slice(0, 3)
                .map((s) => ({ setKey: s.setKey, count: s.count }))
              resolution = "pseudo"
            } else {
              const realMatches = realSymDirIdx.get(joinKey)
              if (realMatches && realMatches.length > 0) {
                // Real-stage fallback: we don't have the setKey itself,
                // only that one exists upstream. Surface a synthetic
                // marker so the UI can distinguish "no Set found" from
                // "Set existed but Base row already closed".
                resolution = "real-fallback"
                setKeys = [{
                  setKey: `real:${realMatches[0].realPositionId}`,
                  count: realMatches.length,
                }]
              }
            }

            // ── Enrich the per-position row with complete exchange-
            //    side details so the UI can render full Position
            //    Details (leverage, margin at risk, liq distance,
            //    SL/TP levels, ROI) WITHOUT a second API round-trip.
            const leverage = Math.max(1, Number(pos.leverage) || 1)
            const marginType: "cross" | "isolated" =
              (pos.exchangeData?.marginType as "cross" | "isolated") ||
              (pos.marginType as "cross" | "isolated") ||
              "cross"
            const markPrice = Math.round(
              (Number(pos.exchangeData?.markPrice) || 0) * 1e8,
            ) / 1e8
            const liquidationPrice = Math.round(
              (Number(pos.exchangeData?.liquidationPrice) || 0) * 1e8,
            ) / 1e8
            const unrealizedPnl = Math.round(
              (Number(pos.exchangeData?.unrealizedPnl ?? pos.exchangeData?.unrealizedPnL) || 0) * 100,
            ) / 100
            // Actual margin at risk = exposure / leverage (not
            // notional). This is what the operator has skin in the
            // game for; ROI is computed against it to match exchange
            // ROE semantics.
            const marginUsd = leverage > 0
              ? Math.round((volumeUsd / leverage) * 100) / 100
              : 0
            const roiPct = marginUsd > 0
              ? Math.round((unrealizedPnl / marginUsd) * 10000) / 100
              : 0
            // Liquidation distance: +% = safe headroom, −% = mark
            // already past liq (auto-close imminent / processing).
            let liquidationDistancePct = 0
            if (markPrice > 0 && liquidationPrice > 0) {
              const raw =
                dir === "long"
                  ? (markPrice - liquidationPrice) / markPrice
                  : (liquidationPrice - markPrice) / markPrice
              liquidationDistancePct = Math.round(raw * 10000) / 100
            }

            livePositionSetRelations.push({
              id: String(pos.id || ""),
              symbol: sym,
              direction: dir as "long" | "short",
              volumeUsd,
              quantity: Math.round(qty * 1e8) / 1e8,
              leverage,
              marginType,
              marginUsd,
              entryPrice: Math.round(px * 1e8) / 1e8,
              markPrice,
              liquidationPrice,
              liquidationDistancePct,
              unrealizedPnl,
              roiPct,
              stopLossPrice:   Math.round((Number(pos.stopLossPrice)   || 0) * 1e8) / 1e8,
              takeProfitPrice: Math.round((Number(pos.takeProfitPrice) || 0) * 1e8) / 1e8,
              orderId:            pos.orderId            ? String(pos.orderId)            : undefined,
              stopLossOrderId:    pos.stopLossOrderId    ? String(pos.stopLossOrderId)    : undefined,
              takeProfitOrderId:  pos.takeProfitOrderId  ? String(pos.takeProfitOrderId)  : undefined,
              status,
              createdAt: Number(pos.createdAt) || 0,
              updatedAt: Number(pos.updatedAt) || 0,
              syncedAt:  Number(pos.exchangeData?.syncedAt) || 0,
              realPositionId: pos.realPositionId ? String(pos.realPositionId) : undefined,
              setKeys,
              resolution,
            })
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-critical */ }

    // Derived aggregates for the openPositions.live branch below.
    // Kept separate from progHash counters because the hash is
    // write-heavy and occasionally lags the actual live:position:* rows
    // by a few seconds. These scan-derived values are the authoritative
    // "right now" view for the coordination UI.
    const liveOpenScanned = livePositionSetRelations.length
    const liveResolvedViaPseudo = livePositionSetRelations.filter(
      (p) => p.resolution === "pseudo",
    ).length
    const liveResolvedViaReal = livePositionSetRelations.filter(
      (p) => p.resolution === "real-fallback",
    ).length
    const liveUnresolvedCount = livePositionSetRelations.filter(
      (p) => p.resolution === "unresolved",
    ).length

    // ── Exchange-wide aggregates for the Live summary strip ──────────
    // Computed from the SAME scan-derived snapshot that drives the
    // per-position rows — guarantees the summary totals always equal
    // the sum of what's visible in the coordination panel. These are
    // the authoritative portfolio figures the operator needs to make
    // risk decisions.
    let liveAggTotalUnrealizedPnl = 0
    let liveAggTotalMarginUsd = 0
    let liveAggTotalVolumeUsd = 0
    let liveAggInProfit = 0
    let liveAggInLoss = 0
    let liveAggNearLiquidation = 0   // mark within ≤ 5% of liq price
    let liveAggStaleSync = 0         // no exchange sync in >60s
    const liveAggConsolidatedSets = livePositionSetRelations.reduce(
      (sum, p) => sum + (p.setKeys?.length || 0),
      0,
    )
    const nowMsAgg = Date.now()
    for (const p of livePositionSetRelations) {
      liveAggTotalUnrealizedPnl += p.unrealizedPnl || 0
      liveAggTotalMarginUsd     += p.marginUsd || 0
      liveAggTotalVolumeUsd     += p.volumeUsd || 0
      if ((p.unrealizedPnl || 0) > 0) liveAggInProfit++
      else if ((p.unrealizedPnl || 0) < 0) liveAggInLoss++
      if (
        p.liquidationPrice > 0 &&
        p.markPrice > 0 &&
        p.liquidationDistancePct !== 0 &&
        p.liquidationDistancePct <= 5
      ) {
        liveAggNearLiquidation++
      }
      if (p.syncedAt > 0 && nowMsAgg - p.syncedAt > 60_000) liveAggStaleSync++
    }
    liveAggTotalUnrealizedPnl = Math.round(liveAggTotalUnrealizedPnl * 100) / 100
    liveAggTotalMarginUsd     = Math.round(liveAggTotalMarginUsd * 100) / 100
    liveAggTotalVolumeUsd     = Math.round(liveAggTotalVolumeUsd * 100) / 100
    const liveAggPortfolioRoiPct = liveAggTotalMarginUsd > 0
      ? Math.round((liveAggTotalUnrealizedPnl / liveAggTotalMarginUsd) * 10000) / 100
      : 0

    const realtimeIsActive =
      realtimeIndicationCycles > 0 ||
      ep?.phase === "live_trading" ||
      ep?.phase === "realtime" ||
      es.status === "running"

    // ── BREAKDOWN section ────────────────────────────────���───────────────────
    // Indication per-type counts live in two places:
    //   1. progression hash: indications_{type}_count  (written by statistics-tracker hincrby)
    //   2. standalone key:   indications:{connId}:{type}:count  (also by statistics-tracker incr)
    // We read both and take the higher.

    // Indication types tracked. MUST stay in sync with `DEFAULT_LIMITS`
    // in `lib/indication-sets-processor.ts`. Each type has:
    //   - its own per-Set 250-entry pool (per config)
    //   - its own cumulative counter `indications_{type}_count` on progression:{id}
    //   - its own per-cycle increment via hincrby in EngineManager.startIndicationProcessor
    // `auto` is a synthetic legacy alias retained for back-compat with old runs.
    const indTypes = ["direction", "move", "active", "active_advanced", "optimal", "auto"] as const
    const indCounts: Record<string, number> = {}
    await Promise.all(
      indTypes.map(async (type) => {
        const fromHash  = n(progHash[`indications_${type}_count`])
        const fromKey   = n(await client.get(`indications:${connectionId}:${type}:count`).catch(() => 0))
        const fromEval  = n(await client.get(`indications:${connectionId}:${type}:evaluated`).catch(() => 0))
        indCounts[type] = Math.max(fromHash, fromKey, fromEval)
      })
    )
    const indTotal = Object.values(indCounts).reduce((s, v) => s + v, 0) || indicationsTotal

    // ── ACTIVE-NOW aggregation: indications + strategies ───────────────
    // The cumulative `indCounts` / `stratCounts` above answer "how many
    // were ever created since the run started". The dashboard Overview
    // also needs "how many are alive RIGHT NOW" — i.e. passing their
    // thresholds on the latest cycle. The engine writes per-cycle
    // overwrites into:
    //
    //   indications_active:{connId} hash (fields: "{symbol}:{type}")
    //   strategies_active:{connId}  hash (fields: "{symbol}:{stage}")
    //
    // We hgetall both, then aggregate by type / stage. If the engine
    // never wrote (e.g. fresh run, no symbols yet) the hashes are empty
    // and all activeCounts come back zero — exactly the right "nothing
    // alive" semantic for the UI.
    const activeIndByType: Record<string, number> = {
      direction: 0, move: 0, active: 0, active_advanced: 0, optimal: 0, auto: 0,
    }
    const activeStratByStage: Record<string, number> = {
      base: 0, main: 0, real: 0,
    }
    try {
      const [indActiveHash, stratActiveHash] = await Promise.all([
        client.hgetall(`indications_active:${connectionId}`).catch(() => null),
        client.hgetall(`strategies_active:${connectionId}`).catch(() => null),
      ])
      if (indActiveHash && typeof indActiveHash === "object") {
        for (const [field, val] of Object.entries(indActiveHash)) {
          // field shape: "{symbol}:{type}" — split on the LAST colon so
          // symbols containing colons (none today, but future-proof) survive.
          const idx = field.lastIndexOf(":")
          if (idx <= 0) continue
          const type = field.slice(idx + 1)
          if (type in activeIndByType) {
            activeIndByType[type] += n(val)
          }
        }
      }
      if (stratActiveHash && typeof stratActiveHash === "object") {
        for (const [field, val] of Object.entries(stratActiveHash)) {
          const idx = field.lastIndexOf(":")
          if (idx <= 0) continue
          const stage = field.slice(idx + 1)
          if (stage in activeStratByStage) {
            activeStratByStage[stage] += n(val)
          }
        }
      }
    } catch { /* non-critical: dashboard falls back to cumulative */ }
    const activeIndTotal = Object.values(activeIndByType).reduce((s, v) => s + v, 0)
    const activeStratTotal = activeStratByStage.base + activeStratByStage.main + activeStratByStage.real

    // Strategy per-stage counts
    const stratTypes = ["base", "main", "real", "live"] as const
    const stratCounts: Record<string, number> = {}
    const stratEvaluated: Record<string, number> = {}
    await Promise.all(
      stratTypes.map(async (type) => {
        const fromHash  = n(progHash[`strategies_${type}_total`])
        const fromKey   = n(await client.get(`strategies:${connectionId}:${type}:count`).catch(() => 0))
        stratCounts[type] = Math.max(fromHash, fromKey)

        const evalFromHash = n(progHash[`strategies_${type}_evaluated`])
        const evalFromKey  = n(await client.get(`strategies:${connectionId}:${type}:evaluated`).catch(() => 0))
        stratEvaluated[type] = Math.max(evalFromHash, evalFromKey)
      })
    )
    // ── Pipeline-aware "total strategies" ────────────────────────────────
    // Base → Main → Real → Live is a CASCADE FILTER (eval → filter → adjust).
    // Each stage operates on the output of the previous stage, so the SAME
    // logical strategy exists at every stage it survives. Summing the four
    // stage counters would triple/quadruple-count the same strategy.
    //
    // The canonical total is the REAL-stage count (the final filtered output
    // before live promotion). Live is a runtime-only subset derived from Real
    // and is shown separately in the breakdown; it is NOT part of the total.
    // Fall back to `strategies_count` (which is written with the same
    // pipeline-aware semantic by the engine & cron) if Real is zero.
    const stratTotal = stratCounts.real || strategiesTotal

    // ── STRATEGY VARIANT breakdown ───────────────────────────────────────────
    // The Main stage expands each promoted Base Set into position-variant
    // entries (default / trailing / block / dca). StrategyCoordinator writes
    // per-variant aggregates to `strategy_variant:{connId}:{variant}` hash
    // fields:
    //   created_sets, passed_sets, entries_count, avg_profit_factor,
    //   avg_drawdown_time, avg_pos_per_set, pass_rate, updated_at
    //
    // We surface these alongside the stage-level detail so the dashboard can
    // show "Avg PF / Avg DDT per variant" over the lifetime of the run.
    // ── PAUSE VARIANT ────────────────────────────────────────────────
    // The Real stage and StrategyCoordinator both write a 5th variant
    // bucket — `pause` — for entries placed under the global pause-axis
    // ratio config. The previous `variantKeys` list dropped this row so
    // the dashboard quietly missed the count. Adding it here surfaces
    // those entries in `strategyVariants.pause` of the response.
    const variantKeys = ["default", "trailing", "block", "dca", "pause"] as const
    const variantDetail: Record<string, Record<string, number>> = {}
    await Promise.all(
      variantKeys.map(async (variant) => {
        const h = ((await client.hgetall(`strategy_variant:${connectionId}:${variant}`).catch(() => null)) || {}) as Record<string, string>
        const createdSets      = n(h.created_sets)
        const passedSets       = n(h.passed_sets)
        const entriesCount     = n(h.entries_count)
        const avgPosPerSet     = parseFloat(h.avg_pos_per_set   || "0")
        const avgProfitFactor  = parseFloat(h.avg_profit_factor || "0")
        const avgDrawdownTime  = parseFloat(h.avg_drawdown_time || "0")
        const passRateRaw      = parseFloat(h.pass_rate         || "0")
        variantDetail[variant] = {
          createdSets,
          passedSets,
          entriesCount,
          avgPosPerSet:     isFinite(avgPosPerSet)    ? Math.round(avgPosPerSet * 100) / 100      : 0,
          avgProfitFactor:  isFinite(avgProfitFactor) ? Math.round(avgProfitFactor * 1000) / 1000 : 0,
          avgDrawdownTime:  isFinite(avgDrawdownTime) ? Math.round(avgDrawdownTime * 10) / 10     : 0,
          passRate:         passRateRaw > 0
            ? Math.round(passRateRaw * 1000) / 10
            : createdSets > 0
              ? Math.round((passedSets / createdSets) * 1000) / 10
              : 0,
        }
      })
    )
    // Totals across variants for an "Overall" row
    const variantTotals = variantKeys.reduce(
      (acc, v) => {
        acc.createdSets     += variantDetail[v].createdSets
        acc.passedSets      += variantDetail[v].passedSets
        acc.entriesCount    += variantDetail[v].entriesCount
        // Weighted averages across variants using createdSets as the weight
        const w = variantDetail[v].createdSets
        if (w > 0) {
          acc.weightedPF  += variantDetail[v].avgProfitFactor * w
          acc.weightedDDT += variantDetail[v].avgDrawdownTime * w
          acc.weightSum   += w
        }
        return acc
      },
      { createdSets: 0, passedSets: 0, entriesCount: 0, weightedPF: 0, weightedDDT: 0, weightSum: 0 },
    )
    const variantOverall = {
      createdSets:    variantTotals.createdSets,
      passedSets:     variantTotals.passedSets,
      entriesCount:   variantTotals.entriesCount,
      avgProfitFactor: variantTotals.weightSum > 0
        ? Math.round((variantTotals.weightedPF / variantTotals.weightSum) * 1000) / 1000
        : 0,
      avgDrawdownTime: variantTotals.weightSum > 0
        ? Math.round((variantTotals.weightedDDT / variantTotals.weightSum) * 10) / 10
        : 0,
      passRate: variantTotals.createdSets > 0
        ? Math.round((variantTotals.passedSets / variantTotals.createdSets) * 1000) / 10
        : 0,
    }

    // ── STRATEGY DETAIL fields ───────────────────────────────────────────────
    // Per-stage avg positions per set, created sets, avg profit factor, avg processing time
    // Written by strategy-processor as HSET strategy_detail:{connId}:{stage} ...
    // Note: "live" stats are derived below from progression counters + closed
    // position archive (local Redis only — no exchange history round-trip).
    const stratDetailKeys = ["base", "main", "real"] as const
    // Shared shape for base/main/real/live. `Record<string, any>` keeps the
    // structure flexible for tier-specific extras (win rate, total PnL, etc.
    // live only) without needing a discriminated union on every write site.
    const stratDetail: Record<string, Record<string, number>> = {}

    await Promise.all(
      stratDetailKeys.map(async (stage) => {
        const dh = ((await client.hgetall(`strategy_detail:${connectionId}:${stage}`).catch(() => null)) || {}) as Record<string, string>
        const createdSets       = n(dh.created_sets      || progHash[`strategy_${stage}_created_sets`])
        const avgPosPerSet      = parseFloat(dh.avg_pos_per_set      || progHash[`strategy_${stage}_avg_pos_per_set`]      || "0")
        const avgProfitFactor   = parseFloat(dh.avg_profit_factor    || progHash[`strategy_${stage}_avg_profit_factor`]    || "0")
        const avgProcessingMs   = parseFloat(dh.avg_processing_ms    || progHash[`strategy_${stage}_avg_processing_ms`]    || "0")
        // Average position evaluation score for Real stage (stored by strategy-coordinator)
        const avgPosEvalReal    = parseFloat(dh.avg_pos_eval_real    || progHash[`strategy_${stage}_avg_pos_eval_real`]    || "0")
        // Count of positions that contributed to avgPosEvalReal (only meaningful for Real stage)
        const countPosEval      = n(dh.count_pos_eval || progHash[`strategy_${stage}_count_pos_eval`])
        // Drawdown time (avg minutes from strategy sets)
        const avgDrawdownTime   = parseFloat(dh.avg_drawdown_time    || progHash[`strategy_${stage}_avg_drawdown_time`]    || "0")

        // Eval percentage: main = evaluated/base, real = evaluated/main
        let evalPct = 0
        if (stage === "main") {
          const base = stratCounts.base || 1
          evalPct = base > 0 ? Math.round((stratEvaluated.main / base) * 1000) / 10 : 0
        } else if (stage === "real") {
          const main = stratCounts.main || 1
          evalPct = main > 0 ? Math.round((stratEvaluated.real / main) * 1000) / 10 : 0
        }

        // Pass ratio = passed/evaluated for this stage — prefer detail hash's pass_rate
        const stageEvaluated = n(dh.evaluated) || stratEvaluated[stage] || 0
        const stagePassed    = n(dh.passed_sets || progHash[`strategy_${stage}_passed`])
        const passRatioRaw   = parseFloat(dh.pass_rate || "0")
        const passRatio      = passRatioRaw > 0
          ? Math.round(passRatioRaw * 1000) / 10   // convert 0-1 fraction → percent
          : stageEvaluated > 0
            ? Math.round((stagePassed / stageEvaluated) * 1000) / 10
            : 0

        stratDetail[stage] = {
          avgPosPerSet:        isFinite(avgPosPerSet)    ? Math.round(avgPosPerSet * 100) / 100      : 0,
          createdSets,
          avgProfitFactor:     isFinite(avgProfitFactor) ? Math.round(avgProfitFactor * 1000) / 1000 : 0,
          avgProcessingTimeMs: isFinite(avgProcessingMs) ? Math.round(avgProcessingMs * 10) / 10     : 0,
          avgPosEvalReal:      isFinite(avgPosEvalReal)  ? Math.round(avgPosEvalReal * 1000) / 1000  : 0,
          countPosEval:        countPosEval,
          avgDrawdownTime:     isFinite(avgDrawdownTime) ? Math.round(avgDrawdownTime * 10) / 10     : 0,
          evalPct,
          passRatio,
          evaluated: stageEvaluated,
          passed: stagePassed,
          failed: Math.max(0, stageEvaluated - stagePassed),
        }
      })
    )

    // ── LIVE STAGE DETAIL (4th tier — mirrors Real but from real exchange) ───
    // Sourced entirely from local Redis — the progression hash (counters) and
    // the closed-position archive written by the live-stage pipeline. No
    // exchange history calls required.
    {
      const livePlaced    = n(progHash.live_orders_placed_count)
      const liveFilled    = n(progHash.live_orders_filled_count)
      const liveCreated   = n(progHash.live_positions_created_count)
      const liveClosed    = n(progHash.live_positions_closed_count)
      const liveWins      = n(progHash.live_wins_count)
      const liveVolumeUsd = n(progHash.live_volume_usd_total)

      // Sample the closed archive (already bounded to the 5000 most recent
      // ids by live-stage) to derive PF, hold time, realised PnL, etc.
      let sumPnl = 0
      let sumGrossProfit = 0
      let sumGrossLoss = 0
      let sumHoldMs = 0
      let sumRoi = 0
      let countSampled = 0

      try {
        const closedIds = ((await client
          .lrange(`live:positions:${connectionId}:closed`, 0, 199)
          .catch(() => [])) || []) as string[]

        for (const id of closedIds) {
          const raw = await client.get(`live:position:${id}`).catch(() => null)
          if (!raw) continue
          try {
            const pos = JSON.parse(raw as string)
            const pnl = Number(pos.realizedPnL) || 0
            sumPnl += pnl
            if (pnl > 0) sumGrossProfit += pnl
            if (pnl < 0) sumGrossLoss += Math.abs(pnl)

            const created = Number(pos.createdAt) || 0
            const closedAt = Number(pos.closedAt) || Number(pos.updatedAt) || 0
            if (created > 0 && closedAt > created) sumHoldMs += closedAt - created

            const qty  = Number(pos.executedQuantity || pos.quantity) || 0
            const avgP = Number(pos.averageExecutionPrice || pos.entryPrice) || 0
            const notional = qty * avgP
            if (notional > 0) sumRoi += pnl / notional

            countSampled++
          } catch { /* skip malformed */ }
        }
      } catch { /* archive empty */ }

      const avgHoldMin  = countSampled > 0 ? (sumHoldMs / countSampled) / 60_000 : 0
      const avgPnl      = countSampled > 0 ? sumPnl / countSampled : 0
      const avgRoi      = countSampled > 0 ? sumRoi / countSampled : 0
      const profitFactor = sumGrossLoss > 0
        ? sumGrossProfit / sumGrossLoss
        : sumGrossProfit > 0 ? 999 : 0
      const passRate   = livePlaced > 0 ? liveFilled / livePlaced : 0
      const winRate    = liveClosed > 0 ? liveWins / liveClosed : 0
      const avgPosSize = liveCreated > 0 ? liveVolumeUsd / liveCreated : 0

      stratDetail.live = {
        // Same shape as base/main/real so the UI can reuse its row renderer:
        avgPosPerSet:        Math.round(avgPosSize * 100) / 100,        // avg position notional (USD)
        createdSets:         liveCreated,                               // positions actually created on exchange
        avgProfitFactor:     Math.round(profitFactor * 1000) / 1000,    // PF from realised PnL
        avgProcessingTimeMs: 0,                                         // not tracked for live — handled inline
        avgPosEvalReal:      Math.round(avgRoi * 10000) / 10000,        // avg ROI fraction
        countPosEval:        countSampled,
        avgDrawdownTime:     Math.round(avgHoldMin * 10) / 10,          // avg hold time in minutes
        evalPct: n(progHash.strategies_real_total) > 0
          ? Math.round((liveCreated / n(progHash.strategies_real_total)) * 1000) / 10
          : 0,                                                          // how many Real sets became Live positions
        passRatio: Math.round(passRate * 1000) / 10,                    // fill rate %
        evaluated: livePlaced,
        passed:    liveFilled,
        failed:    Math.max(0, livePlaced - liveFilled),
        // Live-exclusive fields for richer UI display:
        winRate:        Math.round(winRate * 1000) / 10,
        totalPnl:       Math.round(sumPnl * 100) / 100,
        avgPnl:         Math.round(avgPnl * 100) / 100,
        openPositions:  Math.max(0, liveCreated - liveClosed),
        volumeUsdTotal: Math.round(liveVolumeUsd * 100) / 100,
      }
    }

    // --- Prehistoric metadata (range, timeframe, interval progress) ---
    const prehistoricMeta = {
      rangeStart:              prehistoricHash.range_start          || null,
      rangeEnd:                prehistoricHash.range_end            || null,
      rangeDays:               n(prehistoricHash.range_days)        || 1,
      timeframeSeconds:        n(prehistoricHash.timeframe_seconds) || 1,
      intervalsProcessed:      n(prehistoricHash.intervals_processed) || n(progHash.prehistoric_intervals_processed),
      missingIntervalsLoaded:  n(prehistoricHash.missing_intervals)   || n(progHash.prehistoric_missing_loaded),
      currentSymbol:           prehistoricHash.current_symbol         || progHash.prehistoric_current_symbol || "",
      isComplete:              prehistoricHash.is_complete === "1",
      // Aggregate profit factor across every closed prehistoric position
      // — written by `ConfigSetProcessor` after each prehistoric run
      // (`historic_avg_profit_factor` field on the `prehistoric:{id}`
      // hash). Surfaced here so the dashboard tile + Overall Summary can
      // render it without computing PF client-side. 0 when no closed
      // positions yet, so the UI can render "—" for empty states.
      historicAvgProfitFactor: parseFloat(prehistoricHash.historic_avg_profit_factor || "0") || 0,
      historicAvgProfitFactorCount: n(prehistoricHash.historic_avg_profit_factor_count),
    }

    // ── WINDOW DATA (last 5min / 60min) ──────────────────────────────────────
    // Stored in sorted sets: indications:{connId}:window  scored by unix ms timestamp
    // If not present fall back to estimating from cycle counts using elapsed time
    const nowMs = Date.now()
    const ago5m  = nowMs - 5  * 60 * 1000
    const ago60m = nowMs - 60 * 60 * 1000

    let indWindow5m  = 0
    let indWindow60m = 0
    let stratWindow5m  = 0
    let stratWindow60m = 0

    try {
      // ZRANGEBYSCORE on indications window zset (score = timestamp ms, value = count increment)
      const ind5m  = await client.zrangebyscore(`indications:${connectionId}:window`,  ago5m,  "+inf").catch(() => [])
      const ind60m = await client.zrangebyscore(`indications:${connectionId}:window`,  ago60m, "+inf").catch(() => [])
      const str5m  = await client.zrangebyscore(`strategies:${connectionId}:window`,   ago5m,  "+inf").catch(() => [])
      const str60m = await client.zrangebyscore(`strategies:${connectionId}:window`,   ago60m, "+inf").catch(() => [])
      indWindow5m  = ind5m.length
      indWindow60m = ind60m.length
      stratWindow5m  = str5m.length
      stratWindow60m = str60m.length
    } catch { /* non-critical; fall back to zero */ }

    // If window sets are empty, estimate from rate: total / elapsed_minutes * window
    if (indWindow5m === 0 && indTotal > 0) {
      const startedAtMs = n(progHash.started_at) || (nowMs - 3600_000)
      const elapsedMin = (nowMs - startedAtMs) / 60_000 || 1
      const ratePerMin = indTotal / elapsedMin
      indWindow5m  = Math.round(ratePerMin * 5)
      indWindow60m = Math.round(ratePerMin * Math.min(60, elapsedMin))
    }

    // ── METADATA section ─────────────────────────────────────────────────────
    const phase    = ep?.phase || "unknown"
    const progress = n(ep?.progress)
    const message  = ep?.detail || ep?.message || ""
    const lastUpdate = progHash.last_update || realtimeHash.last_cycle_at || new Date().toISOString()

    let redisDbEntries = 0
    try { redisDbEntries = await client.dbSize() } catch { /* non-critical */ }

    // ── Build response ─────────────────────────────────────────────���─────────
    return NextResponse.json({
      success: true,
      connectionId,

      historic: {
        symbolsProcessed:       historicSymbolsProcessed,
        symbolsTotal:           historicSymbolsTotal,
        candlesLoaded:          historicCandlesLoaded,
        indicatorsCalculated:   historicIndicatorsCalculated,
        cyclesCompleted:        historicCyclesCompleted,
        isComplete:             historicIsComplete,
        progressPercent:        historicProgressPercent,

        // Frame/interval counters — at 1-second timeframes the source market
        // data only holds ~480 candles per 8-hour window, so `candlesLoaded`
        // stays small. The real "processed data units" count lives under
        // `framesProcessed` (= intervalsProcessed from the config-set
        // processor, one frame per timeframe tick across the range).
        framesProcessed:        n(prehistoricMeta.intervalsProcessed),
        framesMissingLoaded:    n(prehistoricMeta.missingIntervalsLoaded),
        timeframeSeconds:       n(prehistoricMeta.timeframeSeconds) || 1,

        // ── Historic profit factor + executed positions ────────────────
        // Two operator-requested overview metrics that previously lived
        // only inside the per-stage `strategyDetail` block (PF) or the
        // `liveExecution` block (positions created/closed). Surfaced
        // alongside the prehistoric counters so the QuickStart card and
        // the Overall Summary can render them without re-deriving from
        // multiple fields.
        //
        //   * `avgProfitFactor` — historic-wide PF (all closed
        //     prehistoric positions, sum(+pct) / |sum(-pct)|, capped at
        //     9.999). 0 ⇒ no closed positions yet.
        //   * `avgProfitFactorCount` — sample count behind the average.
        //   * `executedPositions` — cumulative live exchange positions
        //     created since engine start (`live_positions_created_count`).
        //     This is the canonical "Executed Positions" metric the spec
        //     refers to: every Real→Live promotion that resulted in an
        //     actual exchange order.
        avgProfitFactor:        Math.round(prehistoricMeta.historicAvgProfitFactor * 1000) / 1000,
        avgProfitFactorCount:   prehistoricMeta.historicAvgProfitFactorCount,
        executedPositions:      n(progHash.live_positions_created_count),

        // Prehistoric-processing churn counters — tick every time the engine spins
        // through its evaluation loop, incl. idle/warmup ticks. Kept here so the UI
        // can hide them from the primary live-progression display while still
        // exposing them for debugging / operations dashboards.
        processing: {
          indicationChurnCycles: churnIndicationCycles,
          strategyChurnCycles:   churnStrategyCycles,
        },
      },


      realtime: {
        indicationCycles: realtimeIndicationCycles,
        strategyCycles:   realtimeStrategyCycles,
        realtimeCycles,
        // ── Per-processor cycle counters (cumulative, hincrby-backed) ──
        // Each processor maintains TWO independent counters:
        //   *_cycle_count       — every tick (incl. idle/empty/gated)
        //   *_live_cycle_count  — only ticks that produced actual work
        // The dashboard surfaces both so the operator can spot imbalances
        // (e.g. realtime ticking but never doing live work = no positions).
        cycleCounters: {
          indication:       churnIndicationCycles,
          indicationLive:   liveIndicationCycles,
          strategy:         churnStrategyCycles,
          strategyLive:     liveStrategyCycles,
          realtime:         realtimeCycles,
          realtimeLive:     liveRealtimeCycles,
        },
        // ── Pseudo-position mark-to-market visibility ────────────────
        // Cumulative counters written by RealtimeProcessor.processRealtimeUpdates
        // on every tick that touched ≥1 open pseudo-position. Lets the
        // dashboard prove the "open positions are recalculated INDEPENDENT
        // of indication/strategy" invariant — independent of indication/
        // strategy cycle counters above.
        pseudoPositionUpdates: {
          totalUpdates:     n(progHash.pseudo_positions_updated_count),
          updateCycles:     n(progHash.pseudo_positions_update_cycles),
          lastUpdateAt:     progHash.pseudo_positions_last_update_at || null,
          lastBatchSize:    n(progHash.pseudo_positions_last_count),
        },
        // Cross-processor cumulative tick total — independent of the
        // per-Set 250-entry DB cap. Counts every loop tick across all
        // three processors since the engine started.
        framesProcessed,
        indicationsTotal,
        strategiesTotal,
        positionsOpen,
        // Sets + Positions are the canonical "continuous live progression" anchors
        // the user relies on. These come straight from atomic hincrby writes
        // inside StrategyCoordinator (sets) and live-stage (positions/orders).
        setsCreated: {
          base:  stratCounts.base  || 0,
          main:  stratCounts.main  || 0,
          real:  stratCounts.real  || 0,
          // `total` is the pipeline's final-stage output (Real), NOT a sum of
          // Base+Main+Real. See `stratTotal` derivation above — Base and Main
          // are intermediate filter stages of the SAME logical strategy, so
          // they must not be summed with Real.
          total: stratCounts.real || 0,
        },
        positions: {
          opened:    n(progHash.live_positions_created_count),
          closed:    n(progHash.live_positions_closed_count),
          open:      Math.max(
            0,
            n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)
          ),
          ordersPlaced: n(progHash.live_orders_placed_count),
          ordersFilled: n(progHash.live_orders_filled_count),
        },
        isActive:         realtimeIsActive,
        successRate:      Math.round(successRate * 10) / 10,
        avgCycleTimeMs,
      },

      breakdown: {
        // EVERY indication type tracked by `IndicationSetsProcessor` is
        // surfaced here — `active_advanced` was previously silently
        // dropped from this response despite the engine generating it.
        // Each value is the cumulative count since run start.
        indications: {
          direction:      indCounts.direction      || 0,
          move:           indCounts.move           || 0,
          active:         indCounts.active         || 0,
          activeAdvanced: indCounts.active_advanced || 0,
          optimal:        indCounts.optimal        || 0,
          auto:           indCounts.auto           || 0,
          total:          indTotal,
        },
        strategies: {
          base: stratCounts.base || 0,
          main: stratCounts.main || 0,
          real: stratCounts.real || 0,
          live: stratCounts.live || 0,
          total: stratTotal,
          baseEvaluated: stratEvaluated.base || 0,
          mainEvaluated: stratEvaluated.main || 0,
          realEvaluated: stratEvaluated.real || 0,
        },
      },

      // ── CURRENTLY-ACTIVE counts (per cycle, not cumulative) ───────────
      // The Overview surfaces these as the headline numbers because the
      // operator wants to see what's alive RIGHT NOW — not "how many
      // were ever created since boot". Engine writers overwrite the
      // backing hashes once per cycle so these values track live state.
      // See engine writers in:
      //   - lib/indication-sets-processor.ts → indications_active:{id}
      //   - lib/strategy-coordinator.ts      → strategies_active:{id}
      activeCounts: {
        indications: {
          direction:      activeIndByType.direction        || 0,
          move:           activeIndByType.move             || 0,
          active:         activeIndByType.active           || 0,
          activeAdvanced: activeIndByType.active_advanced  || 0,
          optimal:        activeIndByType.optimal          || 0,
          auto:           activeIndByType.auto             || 0,
          total:          activeIndTotal,
        },
        strategies: {
          base:  activeStratByStage.base  || 0,
          main:  activeStratByStage.main  || 0,
          real:  activeStratByStage.real  || 0,
          total: activeStratTotal,
        },
      },

      // Per-stage strategy detail — avg positions per set, created sets, avg profit factor, avg processing time,
      // avg pos eval for Real, pass ratios, drawdown time
      strategyDetail: {
        base: stratDetail.base,
        main: stratDetail.main,
        real: stratDetail.real,
        // 4th tier — computed from local Redis (progression + closed archive).
        // Mirrors Real's shape but reflects true exchange-side outcomes.
        live: stratDetail.live,
      },

      // Per-variant strategy breakdown (Default / Trailing / Block / DCA).
      // Written by StrategyCoordinator.createMainSets based on each entry's
      // positionState + leverage + size profile. The `overall` row is a
      // weighted aggregate so the UI can show one canonical PF/DDT alongside
      // the four variant rows. These counts are cumulative since run start.
      strategyVariants: {
        default:  variantDetail.default,
        trailing: variantDetail.trailing,
        block:    variantDetail.block,
        dca:      variantDetail.dca,
        overall:  variantOverall,
      },

      // ── Main-stage COORDINATION snapshot ─────────────────────────────────
      // Answers "is the Main stage coordinating correctly?" at a glance:
      //   • activeVariants           — names of variants gated ACTIVE this cycle
      //                                (default is always on; trailing/block/dca
      //                                require matching position context).
      //   • lastCreated / lastReused — how many variant Sets were built fresh
      //                                vs. reused from the fingerprint cache
      //                                last cycle. High reuse = cache working.
      //   • totalCreated / totalReused — cumulative counters over the run.
      //   • reuseRate                — totalReused / (totalCreated + totalReused)
      //                                as a percent. Higher is better.
      //   • positionContext          — live snapshot of the pseudo-position
      //                                state that gates variant selection.
      mainCoordination: (() => {
        const activeVariantsStr = progHash.strategies_main_active_variants || "default"
        const totalCreated = n(progHash.strategies_main_related_created)
        const totalReused  = n(progHash.strategies_main_related_reused)
        const totalCycles  = n(progHash.strategies_main_cycles)
        const reuseDenom   = totalCreated + totalReused

        // ── Build per-axis-window arrays from `axis_windows:{id}` ─────────
        //
        // Spec mapping:
        //   prev  : N ∈ 0..12 (closed lookback window)
        //   last  : N ∈ 0..4  (last-N wins/losses magnitude)
        //   cont  : N ∈ 0..8  (open continuous positions)
        //   pause : N ∈ 0..8  (last-N validation window)
        //
        // For each axis we emit an array of `{ window, sets, pos }` so the
        // dashboard can render a compact 0..N strip without re-deriving
        // positional offsets. `sets` = cumulative Sets that landed under
        // window N; `pos` = total entries (≈ "position configurations")
        // those Sets carried. 0-bucket is included so consumers can show
        // "axis was inactive N times" without special-casing the absence.
        const buildAxis = (axis: "prev" | "last" | "cont" | "pause", maxN: number) => {
          const out: Array<{ window: number; sets: number; pos: number }> = []
          for (let i = 0; i <= maxN; i++) {
            out.push({
              window: i,
              sets: n(axisWindowsHash[`${axis}_${i}_sets`]),
              pos:  n(axisWindowsHash[`${axis}_${i}_pos`]),
            })
          }
          return out
        }

        return {
          activeVariants:       activeVariantsStr.split(",").filter(Boolean),
          activeVariantCount:   n(progHash.strategies_main_active_variant_count),
          lastCreated:          n(progHash.strategies_main_last_created),
          lastReused:           n(progHash.strategies_main_last_reused),
          totalCreated,
          totalReused,
          totalCycles,
          reuseRate: reuseDenom > 0 ? Math.round((totalReused / reuseDenom) * 1000) / 10 : 0,
          positionContext: {
            continuous:  n(progHash.strategies_main_ctx_continuous),
            lastWins:    n(progHash.strategies_main_ctx_last_wins),
            lastLosses:  n(progHash.strategies_main_ctx_last_losses),
            prevLosses:  n(progHash.strategies_main_ctx_prev_losses),
            prevTotal:   n(progHash.strategies_main_ctx_prev_total),
            updatedAt:   n(progHash.strategies_main_ctx_updated_at),
          },
          // ── Per-axis Position-Count windows (cumulative across run) ─────
          // Spec: *"step 1 previous 1-12; Last (of previous) 1-4;
          // continuous 1-8 and Pause 1-8"*. Each axis emits its full 0..N
          // bucket strip, suitable for a compact "axis summary" UI row.
          axisWindows: {
            prev:   buildAxis("prev",  12),
            last:   buildAxis("last",  4),
            cont:   buildAxis("cont",  8),
            pause:  buildAxis("pause", 8),
            updatedAt: n(axisWindowsHash.updated_at),
          },
        }
      })(),

      // ��─ Live Exchange Execution metrics ─────────────────────────────────
      // Read directly from progression hash counters written by the live-stage
      // pipeline (see lib/trade-engine/stages/live-stage.ts). Every stage of
      // the pipeline increments one of these so the UI can show a real-time
      // picture of exchange-level activity.
      // ── OPEN POSITIONS & ACCUMULATED VOLUME ─────────────────────────────
      // Snapshot of every "currently holding exposure" layer of the
      // mirroring pipeline. CRITICAL semantics — pseudo/real/live are
      // NOT independent pools: they represent the SAME trading signal
      // being mirrored down through evaluation stages before finally
      // becoming an exchange order. Therefore:
      //
      //   • Volume is a LIVE-ONLY concept. The only USD exposure that
      //     matters is what actually sits on the exchange. Pseudo and
      //     Real positions carry evaluation-only notionals that MUST
      //     NOT be summed with live volume — doing so would grossly
      //     overstate real exposure. We surface counts for pseudo/
      //     real (pipeline health), and volume only for live.
      //
      //   • Layers:
      //       pseudo — Strategy-level continuous evaluation (Base).
      //                Count only. Running-sets index feeds the live
      //                coordination join.
      //       real   — Main→Real promotions that cleared gating.
      //                Count only.
      //       live   — Actual exchange positions. Count + USD volume
      //                (progHash.live_volume_usd_total is the single
      //                authoritative exposure figure).
      //
      //   • Coordination principle: multiple equivalent Sets that
      //     share the same Base + ranges produce ONE consolidated
      //     exchange position, not N duplicate orders. The
      //     `live.positions[].mirroredSets` array carries those
      //     equivalent Sets so the UI can render "N Sets → 1 Order".
      openPositions: (() => {
        const liveOpen = Math.max(
          0,
          n(progHash.live_positions_created_count) -
            n(progHash.live_positions_closed_count),
        )
        const liveVolumeUsd = n(progHash.live_volume_usd_total)
        const liveVolumeUsdR = Math.round(liveVolumeUsd * 100) / 100
        // Used-balance (margin) cumulative counter — incremented in
        // lock-step with `live_volume_usd_total` by live-stage.ts at both
        // creation and accumulation points. This is the canonical "USDT
        // used balance" surface the UI should prefer over the leveraged
        // notional figure (per the operator's spec). Falls back to the
        // current portfolio aggregate when the cumulative counter is
        // empty (legacy connection that started before margin tracking).
        // Prefer the new cent-precision counter so sub-dollar margins
        // (a $5 fill at 125x leverage = $0.04 margin) survive integer
        // truncation. Falls back to the legacy dollar counter, then
        // to the open-portfolio aggregate.
        const liveMarginCents = n(progHash.live_margin_cents_total)
        const liveMarginUsdR = liveMarginCents > 0
          ? Math.round(liveMarginCents) / 100
          : (() => {
              const dollars = n(progHash.live_margin_usd_total)
              return dollars > 0
                ? Math.round(dollars * 100) / 100
                : Math.round(liveAggTotalMarginUsd * 100) / 100
            })()

        // Full Exchange Position Details per live position. Contains
        // everything the operator needs to evaluate trade health
        // (leverage, margin at risk, liquidation distance, SL/TP,
        // ROI) WITHOUT having to hit /api/trading/live-positions
        // separately. Also carries the mirroring coordination payload
        // (`mirroredSets`) so the UI can render "N equivalent Sets
        // consolidated into this 1 exchange order" without a second
        // join against the pseudo ledger.
        const liveMirroring = livePositionSetRelations
          .slice(0, 50)
          .map((p) => ({
            id:            p.id,
            symbol:        p.symbol,
            direction:     p.direction,
            // Exchange exposure
            volumeUsd:     p.volumeUsd,
            quantity:      p.quantity,
            leverage:      p.leverage,
            marginType:    p.marginType,
            marginUsd:     p.marginUsd,
            // Prices
            entryPrice:    p.entryPrice,
            markPrice:     p.markPrice,
            liquidationPrice:       p.liquidationPrice,
            liquidationDistancePct: p.liquidationDistancePct,
            // PnL
            unrealizedPnl: p.unrealizedPnl,
            roiPct:        p.roiPct,
            // Risk management
            stopLossPrice:   p.stopLossPrice,
            takeProfitPrice: p.takeProfitPrice,
            // Exchange references
            orderId:            p.orderId,
            stopLossOrderId:    p.stopLossOrderId,
            takeProfitOrderId:  p.takeProfitOrderId,
            // Lifecycle
            status:        p.status,
            createdAt:     p.createdAt,
            updatedAt:     p.updatedAt,
            syncedAt:      p.syncedAt,
            realPositionId: p.realPositionId,
            // Coordination fan-in
            mirroredSetCount: p.setKeys.length,
            mirroredSets:     p.setKeys.map((s) => ({
              setKey: s.setKey,
              count:  s.count,
            })),
            resolution: p.resolution,
          }))

        return {
          pseudo: {
            open:         pseudoOpen,                // count only
            runningSets:  pseudoRunningSets,
            topSets:      pseudoTopSets,             // { setKey, count }
          },
          real: {
            open:         realOpen,                  // count only
          },
          live: {
            open:         liveOpen,                  // count
            volumeUsd:    liveVolumeUsdR,            // exchange USD notional (qty × price, leveraged exposure)
            // Used-balance / margin USDT — the value of the *capital
            // committed* to live exchange positions, NOT the leveraged
            // notional. This is what the dashboard should display under
            // "USDT" labels per operator spec. Equals the cumulative
            // sum of (notional / leverage) across every live fill +
            // accumulation, with a fallback to the live portfolio
            // aggregate when no historical counter exists.
            marginUsd:    liveMarginUsdR,
            openScanned:  liveOpenScanned,
            positions:    liveMirroring,
            resolution: {
              pseudo:       liveResolvedViaPseudo,
              realFallback: liveResolvedViaReal,
              unresolved:   liveUnresolvedCount,
            },
            // ── Portfolio-wide exchange aggregates ──────────────
            // Sum of `positions[]` — guarantees the Live strip
            // totals always equal what's visible in the rows.
            aggregate: {
              totalUnrealizedPnl: liveAggTotalUnrealizedPnl,
              totalMarginUsd:     liveAggTotalMarginUsd,
              totalVolumeUsd:     liveAggTotalVolumeUsd,
              portfolioRoiPct:    liveAggPortfolioRoiPct,
              inProfit:           liveAggInProfit,
              inLoss:             liveAggInLoss,
              nearLiquidation:    liveAggNearLiquidation,
              staleSync:          liveAggStaleSync,
              consolidatedSetsTotal: liveAggConsolidatedSets,
            },
          },
          overall: {
            // Pipeline-health counters. Semantically distinct from
            // each other — do NOT sum.
            pipelineEvalOpen: pseudoOpen,   // strategies evaluating
            exchangeOpen:     liveOpen,     // orders actually on exchange
            exchangeVolumeUsd: liveVolumeUsdR,
            exchangeUnrealizedPnl: liveAggTotalUnrealizedPnl,
            exchangeMarginUsd:     liveAggTotalMarginUsd,
            runningSetsCount: pseudoRunningSets,
          },
        }
      })(),

      liveExecution: {
        // Orders
        ordersPlaced:     n(progHash.live_orders_placed_count),
        ordersFilled:     n(progHash.live_orders_filled_count),
        ordersFailed:     n(progHash.live_orders_failed_count),
        ordersRejected:   n(progHash.live_orders_rejected_count),
        ordersSimulated:  n(progHash.live_orders_simulated_count),
        // Accumulated entries (extra fills merged into an existing
        // exchange position because multiple Real-stage Set signals
        // for the same symbol+direction landed on a still-open live
        // position). This is the canonical "Pos Accumulated" metric
        // the user wants surfaced at Real → Live: it's how many
        // upstream Set signals were absorbed without spawning new
        // exchange orders, keeping the live exposure consolidated.
        ordersAccumulated: n(progHash.live_orders_accumulated_count),
        // Positions
        positionsCreated: n(progHash.live_positions_created_count),
        positionsClosed:  n(progHash.live_positions_closed_count),
        positionsOpen:    Math.max(
          0,
          n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)
        ),
        wins:             n(progHash.live_wins_count),
        // Volume — leveraged notional (cumulative qty × price across all fills)
        volumeUsdTotal:   n(progHash.live_volume_usd_total),
        // Used-balance margin (cumulative notional/leverage). This is
        // the canonical "USDT" figure the dashboard should display:
        // the actual capital committed, not the leveraged exposure.
        //
        // PRIORITY ORDER:
        //   1. `live_margin_cents_total` — cent-precision counter
        //      (added 2026-05-03). Survives the rounding that wiped out
        //      sub-dollar margins (e.g. $5 notional / 125x = $0.04
        //      margin) on the legacy dollar counter.
        //   2. `live_margin_usd_total` — legacy dollar counter, still
        //      written in lock-step for backward-compat dashboards.
        //   3. Current open-portfolio margin aggregate, for connections
        //      that started before either counter existed.
        marginUsdTotal:   (() => {
          const cents = n(progHash.live_margin_cents_total)
          if (cents > 0) return Math.round(cents) / 100
          const dollars = n(progHash.live_margin_usd_total)
          if (dollars > 0) return dollars
          return Math.round(liveAggTotalMarginUsd * 100) / 100
        })(),
        // Derived
        fillRate: (() => {
          const placed = n(progHash.live_orders_placed_count)
          const filled = n(progHash.live_orders_filled_count)
          return placed > 0 ? Math.round((filled / placed) * 1000) / 10 : 0
        })(),
        winRate: (() => {
          const closed = n(progHash.live_positions_closed_count)
          const wins   = n(progHash.live_wins_count)
          return closed > 0 ? Math.round((wins / closed) * 1000) / 10 : 0
        })(),
      },

      // Prehistoric processing metadata — range, timeframe, interval progress
      prehistoricMeta,

      // Rolling time-window indication and strategy counts
      windows: {
        indications: { last5m: indWindow5m, last60m: indWindow60m },
        strategies:  { last5m: stratWindow5m, last60m: stratWindow60m },
      },

      metadata: {
        engineRunning: realtimeIsActive,
        phase,
        progress,
        message,
        lastUpdate,
        redisDbEntries,
      },

      // Legacy flat fields kept for backward compat with existing components
      // that still read engine-stats shape directly
      indicationCycleCount:  realtimeIndicationCycles,
      strategyCycleCount:    realtimeStrategyCycles,
      cyclesCompleted:       realtimeIndicationCycles,
      cycleSuccessRate:      Math.round(successRate * 10) / 10,
      totalIndicationsCount: indTotal,
      indicationsByType:     indCounts,
      baseStrategyCount:     stratCounts.base || 0,
      mainStrategyCount:     stratCounts.main || 0,
      realStrategyCount:     stratCounts.real || 0,
      liveStrategyCount:     stratCounts.live || 0,
      totalStrategyCount:    stratTotal,
      positionsCount:        positionsOpen,
    })
  } catch (error) {
    console.error("[v0] [/stats] Error:", error)
    const { id } = await params
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error", connectionId: id },
      { status: 500 }
    )
  }
}
