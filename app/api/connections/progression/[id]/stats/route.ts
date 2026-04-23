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
 *               cyclesCompleted, isComplete, progressPercent }
 *   realtime: { indicationCycles, strategyCycles, realtimeCycles, indicationsTotal,
 *               strategiesTotal, positionsOpen, isActive, successRate, avgCycleTimeMs }
 *               ↑ strategiesTotal = Real-stage output (NOT sum of stages)
 *   breakdown: {
 *     indications: { direction, move, active, optimal, auto, total }
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
    ] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => null),
      client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
      client.hgetall(`realtime:${connectionId}`).catch(() => null),
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`engine_progression:${connectionId}`).catch(() => ({})),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
    ])

    const progHash: Record<string, string>       = progHashRaw       || {}
    const prehistoricHash: Record<string, string> = prehistoricHashRaw || {}
    const realtimeHash: Record<string, string>   = realtimeHashRaw   || {}

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

    const realtimeIndicationCycles = liveIndicationCycles || churnIndicationCycles
    const realtimeStrategyCycles   = liveStrategyCycles   || churnStrategyCycles
    const realtimeCycles = pick(
      n(progHash.realtime_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.realtime_cycle_count)
    )

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
    let pseudoVolumeUsd = 0
    let pseudoRunningSets = 0
    const pseudoSetAgg = new Map<string, { count: number; volumeUsd: number }>()
    // ── Symbol+direction → setKey lookup index ───────────────────────
    // Built during the pseudo-position scan so the live-stage
    // Set-relation join below can identify which Set an exchange
    // position was spawned from WITHOUT requiring new fields on the
    // LivePosition schema. Keyed as `SYMBOL:direction` (upper-cased
    // symbol, lowercase direction). Value is the list of candidate
    // setKeys currently holding open pseudo exposure for that pair,
    // with the per-set share so the UI can rank them. In practice a
    // live position maps to exactly one Set (the one whose Real
    // promotion triggered the exchange order) — we expose candidates
    // regardless so the operator sees the relationship even when
    // multiple Sets overlap on the same symbol/direction.
    const pseudoSymDirIdx = new Map<
      string,
      Array<{ setKey: string; count: number; volumeUsd: number }>
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

        // Prefer the pre-computed position_cost written at creation;
        // fall back to qty * entry for defensive compatibility with
        // older rows that may not have it.
        let cost = Number(hh.position_cost)
        if (!Number.isFinite(cost) || cost <= 0) {
          const qty = Number(hh.quantity) || 0
          const px  = Number(hh.entry_price) || 0
          cost = qty * px
        }
        if (Number.isFinite(cost) && cost > 0) pseudoVolumeUsd += cost

        const setKey = String(hh.config_set_key || "").trim()
        if (setKey) {
          const prev = pseudoSetAgg.get(setKey) || { count: 0, volumeUsd: 0 }
          prev.count++
          prev.volumeUsd += (Number.isFinite(cost) && cost > 0 ? cost : 0)
          pseudoSetAgg.set(setKey, prev)

          // Populate symbol+direction → setKey join index for live
          // position coordination (see openPositions.live.positions
          // downstream). Same per-hash pass — no extra Redis work.
          const sym = String(hh.symbol || "").trim().toUpperCase()
          const dir = String(hh.direction || "").trim().toLowerCase()
          if (sym && (dir === "long" || dir === "short")) {
            const joinKey = `${sym}:${dir}`
            const arr = pseudoSymDirIdx.get(joinKey) || []
            const existing = arr.find((e) => e.setKey === setKey)
            if (existing) {
              existing.count++
              existing.volumeUsd += (Number.isFinite(cost) && cost > 0 ? cost : 0)
            } else {
              arr.push({
                setKey,
                count: 1,
                volumeUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
              })
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

    // Top-5 per-Set rollup sorted by USD exposure so the UI can show
    // the heaviest Sets at a glance. We keep the full payload small
    // (setKey trimmed, numbers rounded) — this is polled every 5s.
    const pseudoTopSets = Array.from(pseudoSetAgg.entries())
      .map(([setKey, agg]) => ({
        setKey,
        count: agg.count,
        volumeUsd: Math.round(agg.volumeUsd * 100) / 100,
      }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)
      .slice(0, 5)

    // ── Real-stage open positions + accumulated volume ──────────────────
    //
    // Unlike Base/Main (which are evaluation tiers with no per-position
    // quantity), Real positions carry `{ quantity, entryPrice, status }`.
    // We scan the namespace once and sum notional for all non-closed
    // rows. Bounded by a 500-key safety ceiling — anything beyond that
    // is a data-hygiene issue the operator needs to fix independently.
    let realOpen = 0
    let realVolumeUsd = 0
    // ── Symbol+direction → candidate Real positions index ─────────
    // Populated alongside the real scan so live-position resolution
    // can fall back to Real when the pseudo ledger has no matching
    // entry (e.g. Set was closed before the exchange position did).
    const realSymDirIdx = new Map<
      string,
      Array<{ realPositionId: string; volumeUsd: number }>
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
            const qty = Number(pos.quantity)  || 0
            const px  = Number(pos.entryPrice) || 0
            const volume = qty > 0 && px > 0 ? qty * px : 0
            if (volume > 0) realVolumeUsd += volume
            // Index for live position join
            const sym = String(pos.symbol || "").trim().toUpperCase()
            const dir = String(pos.direction || "").trim().toLowerCase()
            if (sym && (dir === "long" || dir === "short") && pos.id) {
              const joinKey = `${sym}:${dir}`
              const arr = realSymDirIdx.get(joinKey) || []
              arr.push({ realPositionId: String(pos.id), volumeUsd: volume })
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
      volumeUsd: number
      unrealizedPnl: number
      entryPrice: number
      markPrice: number
      status: string
      createdAt: number
      realPositionId?: string
      setKeys: Array<{ setKey: string; count: number; volumeUsd: number }>
      // `resolution` lets the UI say exactly HOW the Set was identified:
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
            let setKeys: Array<{ setKey: string; count: number; volumeUsd: number }> = []
            let resolution: "pseudo" | "real-fallback" | "unresolved" = "unresolved"

            const pseudoMatches = pseudoSymDirIdx.get(joinKey)
            if (pseudoMatches && pseudoMatches.length > 0) {
              setKeys = [...pseudoMatches]
                .sort((a, b) => b.volumeUsd - a.volumeUsd)
                .slice(0, 3)
                .map((s) => ({
                  setKey: s.setKey,
                  count: s.count,
                  volumeUsd: Math.round(s.volumeUsd * 100) / 100,
                }))
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
                  volumeUsd: Math.round(
                    realMatches.reduce((s, m) => s + m.volumeUsd, 0) * 100,
                  ) / 100,
                }]
              }
            }

            livePositionSetRelations.push({
              id: String(pos.id || ""),
              symbol: sym,
              direction: dir as "long" | "short",
              volumeUsd,
              unrealizedPnl: Math.round(
                (Number(pos.exchangeData?.unrealizedPnl ?? pos.exchangeData?.unrealizedPnL) || 0) * 100,
              ) / 100,
              entryPrice: Math.round(px * 1e8) / 1e8,
              markPrice:  Math.round(
                (Number(pos.exchangeData?.markPrice) || 0) * 1e8,
              ) / 1e8,
              status,
              createdAt: Number(pos.createdAt) || 0,
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

    const indTypes = ["direction", "move", "active", "optimal", "auto"] as const
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
    const variantKeys = ["default", "trailing", "block", "dca"] as const
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
        indications: {
          direction: indCounts.direction || 0,
          move:      indCounts.move      || 0,
          active:    indCounts.active    || 0,
          optimal:   indCounts.optimal   || 0,
          auto:      indCounts.auto      || 0,
          total:     indTotal,
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
        }
      })(),

      // ��─ Live Exchange Execution metrics ─────────────────────────────────
      // Read directly from progression hash counters written by the live-stage
      // pipeline (see lib/trade-engine/stages/live-stage.ts). Every stage of
      // the pipeline increments one of these so the UI can show a real-time
      // picture of exchange-level activity.
      // ── OPEN POSITIONS & ACCUMULATED VOLUME ─────────────────────────────
      // Comprehensive "what's currently holding exposure" snapshot so the
      // UI can show Overall, per-stage, and per-Set breakdowns in one
      // place without having to stitch data from multiple endpoints.
      //
      //   • pseudo  — PseudoPositionManager rows (the authoritative
      //                  Base-stage volume-aware namespace with full
      //                  sizing + `config_set_key`). Includes a top-5
      //                  per-Set rollup sorted by USD exposure so the
      //                  operator can see which Sets are carrying the
      //                  heaviest weight at a glance.
      //   • real    — Real-stage promotions that survived Main filtering,
      //                  with accumulated (quantity * entryPrice) notional.
      //   • live    — Exchange-side positions (derived from progHash
      //                  counters — already cumulative-volume-tracked
      //                  by live-stage.ts).
      //   • overall — Single-number roll-up across ALL namespaces so
      //                  the dashboard can render a top-line
      //                  "Accumulated" strip without doing the math
      //                  client-side.
      openPositions: (() => {
        const liveOpen = Math.max(
          0,
          n(progHash.live_positions_created_count) -
            n(progHash.live_positions_closed_count),
        )
        const liveVolumeUsd = n(progHash.live_volume_usd_total)
        const pseudoVolumeUsdR = Math.round(pseudoVolumeUsd * 100) / 100
        const realVolumeUsdR   = Math.round(realVolumeUsd   * 100) / 100
        const liveVolumeUsdR   = Math.round(liveVolumeUsd   * 100) / 100
        // Total accumulated USD across every "currently holding"
        // bucket. Pseudo + Real are independent ledgers (Pseudo =
        // Base-stage volume-aware; Real = Main→Real promotions) and
        // they do NOT overlap, so summing them is semantically
        // correct. Live is the true exchange position, additive as
        // well.
        const totalVolumeUsd = Math.round(
          (pseudoVolumeUsd + realVolumeUsd + liveVolumeUsd) * 100,
        ) / 100
        return {
          pseudo: {
            open:         pseudoOpen,
            volumeUsd:    pseudoVolumeUsdR,
            runningSets:  pseudoRunningSets,
            topSets:      pseudoTopSets,
          },
          real: {
            open:         realOpen,
            volumeUsd:    realVolumeUsdR,
          },
          live: {
            // progHash counters are cumulative and the fastest
            // source of truth for simple "how many are open" UI.
            open:         liveOpen,
            volumeUsd:    liveVolumeUsdR,
            // Scan-derived count ("right now" from live:position:*
            // rows). May differ by ±1 from `open` when the progHash
            // counter lags a fresh create/close — the UI can surface
            // drift if needed.
            openScanned:  liveOpenScanned,
            // ── Set-relation coordination ─────────────────────
            // Per live exchange position, a compact record with:
            //   • symbol, direction, volume, unrealized PnL
            //   • best-candidate setKeys (top-3 by exposure)
            //   • resolution source: "pseudo" | "real-fallback" |
            //     "unresolved" — tells the operator exactly how the
            //     Set was identified (via pseudo ledger, via Real
            //     fallback, or no upstream match).
            // Bounded to 50 entries — the UI paginates on demand.
            positions: livePositionSetRelations.slice(0, 50),
            resolution: {
              pseudo:       liveResolvedViaPseudo,
              realFallback: liveResolvedViaReal,
              unresolved:   liveUnresolvedCount,
            },
          },
          overall: {
            // Distinct "running" positions across ALL ledgers. Pseudo
            // + Live are the two source-of-truth ledgers; Real sits
            // inside the pseudo-pipeline but has its own namespace, so
            // we expose it separately rather than double-counting.
            totalOpenPositions: pseudoOpen + liveOpen,
            pseudoVolumeUsd:    pseudoVolumeUsdR,
            realVolumeUsd:      realVolumeUsdR,
            liveVolumeUsd:      liveVolumeUsdR,
            totalVolumeUsd,
            runningSetsCount:   pseudoRunningSets,
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
        // Positions
        positionsCreated: n(progHash.live_positions_created_count),
        positionsClosed:  n(progHash.live_positions_closed_count),
        positionsOpen:    Math.max(
          0,
          n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)
        ),
        wins:             n(progHash.live_wins_count),
        // Volume
        volumeUsdTotal:   n(progHash.live_volume_usd_total),
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
