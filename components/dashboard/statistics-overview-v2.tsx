"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { useExchange } from "@/lib/exchange-context"

interface CompactStats {
  indicationCycles: number
  indicationsTotal: number
  strategiesTotal: number
  positionsOpen: number
  successRate: number
  avgCycleMs: number
  stratBase: number
  stratMain: number
  stratReal: number
  stratLive: number
  // ── Main-stage breakdown ──────────────────────────────────────────
  // Three sub-counts that let the operator see *why* Main is the size
  // it is:
  //   • mainEvaluated       — Base Sets that entered Main evaluation
  //                           (every promoted Base slot is counted here)
  //   • mainCoordCreated    — extra related variant Sets created at
  //                           Main by position coordination (trailing /
  //                           block / dca) on top of the default set
  //   • mainBlockDcaSets    — subset of coord-created Sets that carry a
  //                           Block or DCA variant tag
  mainEvaluated: number
  mainCoordCreated: number
  mainBlockDcaSets: number
  // ── OPEN POSITIONS through the MIRRORING pipeline ────────────────
  // Pseudo (Base-stage strategy evaluation) → Real (Main→Real
  // promotions) → Live (actual exchange orders). These are the SAME
  // signal mirrored through stages — not independent pools — so only
  // the Live stage carries meaningful USD volume (real exchange
  // exposure). Pseudo / Real surface counts only.
  pseudoOpen: number
  pseudoRunningSets: number
  realOpen: number
  liveOpen: number
  liveVolumeUsd: number
  liveFilled: number
  liveClosed: number
  liveWinRate: number
  liveFillRate: number
  // ── Portfolio-wide exchange aggregates (scan-derived) ────────────
  // Summed across every open exchange position. Optional because the
  // server may lag behind schema changes; defaults to 0 via setStats
  // normalization so the Live strip always renders deterministically.
  liveUnrealizedPnl: number
  liveMarginUsd: number
  livePortfolioRoiPct: number
  liveInProfit: number
  liveInLoss: number
  liveNearLiquidation: number
  liveStaleSync: number
  liveConsolidatedSetsTotal: number
  // ── Per-position exchange details + mirroring coordination ───────
  // Each entry carries the FULL exchange Position Details (leverage,
  // margin at risk, liquidation distance, SL/TP levels, ROI) plus
  // the list of equivalent upstream Sets mirrored into it. Every
  // numeric field is guaranteed to be a finite number (normalized
  // in setStats) so render logic can read directly without `??`.
  livePositions: Array<{
    id: string
    symbol: string
    direction: "long" | "short"
    // Exchange exposure
    volumeUsd: number
    quantity: number
    leverage: number
    marginType: "cross" | "isolated"
    marginUsd: number
    // Prices
    entryPrice: number
    markPrice: number
    liquidationPrice: number
    liquidationDistancePct: number
    // PnL
    unrealizedPnl: number
    roiPct: number
    // Risk management levels
    stopLossPrice: number
    takeProfitPrice: number
    // Exchange references (optional — may not be surfaced by all connectors)
    orderId?: string
    stopLossOrderId?: string
    takeProfitOrderId?: string
    // Lifecycle
    status: string
    createdAt: number
    updatedAt: number
    syncedAt: number
    realPositionId?: string
    // Coordination fan-in
    mirroredSetCount: number
    mirroredSets: Array<{ setKey: string; count: number }>
    resolution: "pseudo" | "real-fallback" | "unresolved"
  }>
  liveResolution: { pseudo: number; realFallback: number; unresolved: number }
  phase: string
  isActive: boolean
}

const EMPTY: CompactStats = {
  indicationCycles: 0,
  indicationsTotal: 0,
  strategiesTotal: 0,
  positionsOpen: 0,
  successRate: 0,
  avgCycleMs: 0,
  stratBase: 0,
  stratMain: 0,
  stratReal: 0,
  stratLive: 0,
  mainEvaluated: 0,
  mainCoordCreated: 0,
  mainBlockDcaSets: 0,
  pseudoOpen: 0,
  pseudoRunningSets: 0,
  realOpen: 0,
  liveOpen: 0,
  liveVolumeUsd: 0,
  liveFilled: 0,
  liveClosed: 0,
  liveWinRate: 0,
  liveFillRate: 0,
  liveUnrealizedPnl: 0,
  liveMarginUsd: 0,
  livePortfolioRoiPct: 0,
  liveInProfit: 0,
  liveInLoss: 0,
  liveNearLiquidation: 0,
  liveStaleSync: 0,
  liveConsolidatedSetsTotal: 0,
  livePositions: [],
  liveResolution: { pseudo: 0, realFallback: 0, unresolved: 0 },
  phase: "",
  isActive: false,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// USD-formatter used for the accumulated-volume strips. Mirrors the
// short-form scale used by `fmt` (K/M) so the number stays readable
// on a single line on a 10-column strip. Always prefixed with `$`.
// Values < $1 show `0` to avoid visual clutter when an engine is idle.
function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

// ── Exchange position row (coordination panel) ───────────────────────
// One row per live exchange position. Collapsed view shows symbol /
// direction / exposure / PnL / mirrored Sets / resolution badge. Click
// the chevron to expand and see the FULL Position Details: leverage,
// margin at risk, liquidation distance, SL/TP levels, ROI, exchange
// order IDs, sync staleness. Everything comes from the single /stats
// payload — no additional API calls.
function ExchangePositionRow({
  lp,
}: {
  lp: CompactStats["livePositions"][number]
}) {
  const [expanded, setExpanded] = useState(false)
  const nSets = lp.mirroredSetCount || lp.mirroredSets.length
  const primarySet = lp.mirroredSets[0]
  const setLabel = primarySet
    ? primarySet.setKey.length > 32
      ? `${primarySet.setKey.slice(0, 32)}…`
      : primarySet.setKey
    : "—"
  const resTone =
    lp.resolution === "pseudo"
      ? "text-emerald-700"
      : lp.resolution === "real-fallback"
        ? "text-amber-700"
        : "text-muted-foreground"

  // Near-liquidation heuristic: mark within 5% of liq price is critical
  // — surface visually so operator notices at a glance.
  const nearLiq =
    lp.liquidationPrice > 0 &&
    lp.markPrice > 0 &&
    lp.liquidationDistancePct > 0 &&
    lp.liquidationDistancePct <= 5

  // Sync staleness: >60s without an exchange reconciliation hints that
  // the live polling loop is lagging or the connector is rate-limited.
  const nowMs = Date.now()
  const syncAgeSec = lp.syncedAt > 0 ? Math.round((nowMs - lp.syncedAt) / 1000) : -1
  const staleSync = syncAgeSec >= 60

  return (
    <div
      className={`rounded transition-colors text-[10px] ${
        expanded ? "bg-muted/50" : "bg-muted/30 hover:bg-muted/50"
      }`}
    >
      {/* ── Collapsed summary row ──────────────────────────────── */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full grid grid-cols-12 items-center gap-2 px-2 py-1 text-left"
        aria-expanded={expanded}
      >
        <div className="col-span-3 flex items-center gap-1 min-w-0">
          <span className="text-muted-foreground text-[8px] shrink-0" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
          <span className="font-semibold text-foreground truncate">{lp.symbol}</span>
          <span
            className={`px-1 rounded text-[8px] uppercase font-semibold shrink-0 ${
              lp.direction === "long"
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
            }`}
          >
            {lp.direction}
          </span>
          {lp.leverage > 1 && (
            <span
              className="px-1 rounded text-[8px] font-semibold tabular-nums bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300 shrink-0"
              title={`${lp.leverage}x leverage · ${lp.marginType} margin · ${fmtUsd(lp.marginUsd)} at risk`}
            >
              {lp.leverage}x
            </span>
          )}
          {nearLiq && (
            <span
              className="px-1 rounded text-[8px] font-bold bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 shrink-0 animate-pulse"
              title={`Near liquidation — mark price is within ${lp.liquidationDistancePct.toFixed(2)}% of liq @ ${lp.liquidationPrice}`}
            >
              LIQ
            </span>
          )}
        </div>
        <div
          className="col-span-2 tabular-nums text-right font-semibold text-amber-700"
          title={`Exchange exposure: ${fmtUsd(lp.volumeUsd)} (qty ${lp.quantity} @ ${lp.entryPrice})`}
        >
          {fmtUsd(lp.volumeUsd)}
        </div>
        <div
          className={`col-span-2 tabular-nums text-right font-semibold ${
            lp.unrealizedPnl > 0
              ? "text-emerald-600"
              : lp.unrealizedPnl < 0
                ? "text-red-600"
                : "text-muted-foreground"
          }`}
          title={`ROI ${lp.roiPct > 0 ? "+" : ""}${lp.roiPct.toFixed(2)}% on ${fmtUsd(lp.marginUsd)} margin`}
        >
          {lp.unrealizedPnl > 0 ? "+" : ""}
          {fmtUsd(lp.unrealizedPnl)}
          <span className="ml-1 text-[8px] font-normal opacity-75">
            ({lp.roiPct > 0 ? "+" : ""}{lp.roiPct.toFixed(1)}%)
          </span>
        </div>
        {/* Mirrored-Sets column */}
        <div className="col-span-4 flex items-center gap-1 min-w-0">
          {nSets > 0 && (
            <span
              className={`px-1 rounded text-[8px] font-semibold tabular-nums shrink-0 ${
                nSets > 1
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
              title={
                nSets > 1
                  ? `${nSets} equivalent Sets consolidated into 1 exchange order (avoids ${nSets - 1} duplicate order${nSets - 1 > 1 ? "s" : ""})`
                  : `1 Set mirrored into this exchange order`
              }
            >
              {nSets}&times; Set{nSets === 1 ? "" : "s"}
            </span>
          )}
          <span className={`truncate font-mono text-[9px] ${resTone}`}>
            {setLabel}
          </span>
        </div>
        <div className="col-span-1 text-right flex items-center justify-end gap-1">
          {staleSync && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
              title={`Exchange sync is ${syncAgeSec}s stale`}
            />
          )}
          <span
            className={`px-1 rounded text-[8px] font-semibold ${
              lp.resolution === "pseudo"
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : lp.resolution === "real-fallback"
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  : "bg-muted text-muted-foreground"
            }`}
            title={
              lp.resolution === "pseudo"
                ? "Resolved via pseudo ledger (exact Base-stage match)"
                : lp.resolution === "real-fallback"
                  ? "Resolved via Real stage (Base row already closed)"
                  : "No upstream Set matched — investigate orphaned position"
            }
          >
            {lp.resolution === "pseudo"
              ? "P"
              : lp.resolution === "real-fallback"
                ? "R"
                : "?"}
          </span>
        </div>
      </button>

      {/* ── Expanded Position Details ──────────────────────────── */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-border/40 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] sm:grid-cols-4">
          {/* Exposure & sizing */}
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Quantity</span>
            <span className="font-mono tabular-nums">{lp.quantity}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Margin at Risk</span>
            <span className="font-semibold tabular-nums">
              {fmtUsd(lp.marginUsd)}{" "}
              <span className="text-[9px] font-normal text-muted-foreground">
                ({lp.marginType})
              </span>
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Leverage</span>
            <span className="font-semibold tabular-nums">{lp.leverage}x</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">ROI (ROE)</span>
            <span
              className={`font-semibold tabular-nums ${
                lp.roiPct > 0 ? "text-emerald-600" : lp.roiPct < 0 ? "text-red-600" : ""
              }`}
            >
              {lp.roiPct > 0 ? "+" : ""}
              {lp.roiPct.toFixed(2)}%
            </span>
          </div>
          {/* Price levels */}
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Entry</span>
            <span className="font-mono tabular-nums">{lp.entryPrice || "—"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Mark</span>
            <span className="font-mono tabular-nums">{lp.markPrice || "—"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Liquidation</span>
            <span
              className={`font-mono tabular-nums ${nearLiq ? "text-red-600 font-bold" : ""}`}
              title={
                lp.liquidationPrice > 0
                  ? `${lp.liquidationDistancePct.toFixed(2)}% distance from mark`
                  : "Liquidation price not yet synced from exchange"
              }
            >
              {lp.liquidationPrice || "—"}
              {lp.liquidationPrice > 0 && (
                <span className="ml-1 text-[9px] font-normal opacity-75">
                  ({lp.liquidationDistancePct > 0 ? "" : ""}{lp.liquidationDistancePct.toFixed(1)}%)
                </span>
              )}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">
              TP{lp.takeProfitOrderId && " ✓"}
            </span>
            <span className="font-mono tabular-nums text-emerald-700">
              {lp.takeProfitPrice || "—"}
            </span>
          </div>
          {/* SL */}
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">
              SL{lp.stopLossOrderId && " ✓"}
            </span>
            <span className="font-mono tabular-nums text-red-700">
              {lp.stopLossPrice || "—"}
            </span>
          </div>
          {/* Exchange refs */}
          <div className="flex flex-col col-span-1 min-w-0">
            <span className="text-muted-foreground text-[9px]">Order ID</span>
            <span className="font-mono text-[9px] truncate" title={lp.orderId || ""}>
              {lp.orderId || "—"}
            </span>
          </div>
          <div className="flex flex-col col-span-1 min-w-0">
            <span className="text-muted-foreground text-[9px]">Real Position</span>
            <span
              className="font-mono text-[9px] truncate"
              title={lp.realPositionId || ""}
            >
              {lp.realPositionId || "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground text-[9px]">Status</span>
            <span className="font-semibold uppercase text-[9px]">
              {lp.status}
              {staleSync && (
                <span
                  className="ml-1 px-1 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  title={`Last exchange sync: ${syncAgeSec}s ago`}
                >
                  {syncAgeSec}s stale
                </span>
              )}
            </span>
          </div>
          {/* Mirrored Sets full list */}
          {lp.mirroredSets.length > 0 && (
            <div className="col-span-2 sm:col-span-4 border-t border-border/40 pt-1 mt-1">
              <div className="text-muted-foreground text-[9px] mb-0.5">
                Mirrored Sets ({lp.mirroredSets.length} equivalent
                {lp.mirroredSets.length > 1
                  ? `s consolidated into 1 order)`
                  : ")"}
              </div>
              <ul className="space-y-0.5">
                {lp.mirroredSets.map((s, i) => (
                  <li
                    key={`${s.setKey}-${i}`}
                    className="flex items-center gap-2 font-mono text-[9px]"
                  >
                    <span className="text-muted-foreground w-3 text-right tabular-nums">
                      {i + 1}.
                    </span>
                    <span className="truncate flex-1" title={s.setKey}>
                      {s.setKey}
                    </span>
                    <span
                      className="tabular-nums px-1 rounded bg-muted text-muted-foreground shrink-0"
                      title={`${s.count} pseudo eval position${s.count === 1 ? "" : "s"} on this Set`}
                    >
                      {s.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function StatisticsOverviewV2() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId || "default-bingx-001"
  const [stats, setStats] = useState<CompactStats>(EMPTY)

  useEffect(() => {
    let mounted = true

    // Single canonical loader — fetches the per-connection stats
    // endpoint, parses the `liveExecution` / `strategyDetail.live` /
    // `realtime` / `breakdown` / `metadata` branches, and pushes into
    // local state. Called on mount, every 5s, and on global engine /
    // connection / live-trade toggle events for immediate refresh.
    const load = async () => {
      try {
        const res = await fetch(
          `/api/connections/progression/${connectionId}/stats`,
          { cache: "no-store" },
        )
        if (!res.ok || !mounted) return
        const d = await res.json()

        // Live execution metrics are exposed at `liveExecution`
        // (preferred) and `strategyDetail.live` (extra fields) by the
        // /stats endpoint.
        const liveExec = d.liveExecution || {}
        const liveDetail = d.strategyDetail?.live || {}

        // ── Main-stage breakdown sources ────────────────────────────
        // Three distinct backend namespaces, all exposed by /stats:
        //   • breakdown.strategies.mainEvaluated   — Base Sets that
        //       reached Main evaluation (hincrby counter
        //       `strategies_main_evaluated`).
        //   • mainCoordination.totalCreated        — cumulative count
        //       of related variant Sets created by Main-stage position
        //       coordination on top of the default Set (hincrby
        //       `strategies_main_related_created`).
        //   • strategyVariants.block.createdSets +
        //     strategyVariants.dca.createdSets     — cumulative Sets
        //       carrying a Block or DCA variant tag (from the
        //       `strategy_variant:{id}:{block|dca}` hashes).
        const mainBreakdownEval   = d.breakdown?.strategies?.mainEvaluated
          ?? d.strategyDetail?.main?.evaluated
          ?? 0
        const mainCoordCreated    = d.mainCoordination?.totalCreated ?? 0
        const blockSets = d.strategyVariants?.block?.createdSets ?? 0
        const dcaSets   = d.strategyVariants?.dca?.createdSets   ?? 0
        const mainBlockDcaSets    = blockSets + dcaSets

        // ── Open positions through the mirroring pipeline ──────────
        // Shape: d.openPositions = {
        //   pseudo: { open, runningSets, topSets[{setKey,count}] },
        //   real:   { open },
        //   live:   { open, volumeUsd, positions[], resolution },
        //   overall:{ pipelineEvalOpen, exchangeOpen,
        //             exchangeVolumeUsd, runningSetsCount }
        // }
        // Only live.volumeUsd carries real exchange exposure.
        const op = d.openPositions || {}
        const opPseudo = op.pseudo || {}
        const opReal   = op.real   || {}
        const opLive   = op.live   || {}

        if (!mounted) return
        setStats({
          indicationCycles: d.realtime?.indicationCycles || 0,
          indicationsTotal: d.realtime?.indicationsTotal || 0,
          strategiesTotal:  d.realtime?.strategiesTotal  || 0,
          positionsOpen:    d.realtime?.positionsOpen    || 0,
          successRate:      d.realtime?.successRate      || 0,
          avgCycleMs:       d.realtime?.avgCycleTimeMs   || 0,
          stratBase:        d.breakdown?.strategies?.base || 0,
          stratMain:        d.breakdown?.strategies?.main || 0,
          stratReal:        d.breakdown?.strategies?.real || 0,
          stratLive:        d.breakdown?.strategies?.live || liveExec.positionsCreated || 0,
          mainEvaluated:    mainBreakdownEval,
          mainCoordCreated,
          mainBlockDcaSets,
          pseudoOpen:           Number(opPseudo.open)        || 0,
          pseudoRunningSets:    Number(opPseudo.runningSets) || 0,
          realOpen:             Number(opReal.open)          || 0,
          liveOpen:             Number(opLive.open)          || 0,
          liveVolumeUsd:        Number(opLive.volumeUsd)     || 0,
          liveFilled:       liveExec.ordersFilled     || 0,
          liveClosed:       liveExec.positionsClosed  || 0,
          liveWinRate:      liveExec.winRate          || liveDetail.winRate  || 0,
          liveFillRate:     liveExec.fillRate         || liveDetail.passRatio || 0,
          // Exchange-wide aggregates (scan-derived on the server).
          // Each field falls back to 0 when the server hasn't emitted
          // it yet (e.g. during a staged schema rollout), keeping the
          // Live strip render deterministic and crash-free.
          liveUnrealizedPnl:         Number(opLive.aggregate?.totalUnrealizedPnl) || 0,
          liveMarginUsd:             Number(opLive.aggregate?.totalMarginUsd)     || 0,
          livePortfolioRoiPct:       Number(opLive.aggregate?.portfolioRoiPct)    || 0,
          liveInProfit:              Number(opLive.aggregate?.inProfit)           || 0,
          liveInLoss:                Number(opLive.aggregate?.inLoss)             || 0,
          liveNearLiquidation:       Number(opLive.aggregate?.nearLiquidation)    || 0,
          liveStaleSync:             Number(opLive.aggregate?.staleSync)          || 0,
          liveConsolidatedSetsTotal: Number(opLive.aggregate?.consolidatedSetsTotal) || 0,
          // Mirroring coordination payload: each live position row
          // normalized to a COMPLETE shape (every numeric field
          // coerced to a finite number, optional strings kept as-is).
          // This is the crash-immune invariant — render code can read
          // `lp.leverage.toFixed(...)` without any defensive guard,
          // even when the server omits newer fields.
          livePositions: Array.isArray(opLive.positions)
            ? opLive.positions.map((p: any) => {
                const leverage = Math.max(1, Number(p.leverage) || 1)
                const volumeUsd = Number(p.volumeUsd) || 0
                // Derive margin at risk if server didn't compute it
                const marginUsd = Number(p.marginUsd) > 0
                  ? Number(p.marginUsd)
                  : leverage > 0
                    ? Math.round((volumeUsd / leverage) * 100) / 100
                    : 0
                const unrealizedPnl = Number(p.unrealizedPnl) || 0
                const roiPct = Number(p.roiPct) !== 0
                  ? Number(p.roiPct)
                  : marginUsd > 0
                    ? Math.round((unrealizedPnl / marginUsd) * 10000) / 100
                    : 0
                return {
                  id:                    String(p.id || ""),
                  symbol:                String(p.symbol || ""),
                  direction:             (p.direction === "short" ? "short" : "long") as "long" | "short",
                  volumeUsd,
                  quantity:              Number(p.quantity) || 0,
                  leverage,
                  marginType:            (p.marginType === "isolated" ? "isolated" : "cross") as "cross" | "isolated",
                  marginUsd,
                  entryPrice:            Number(p.entryPrice) || 0,
                  markPrice:             Number(p.markPrice)  || 0,
                  liquidationPrice:      Number(p.liquidationPrice) || 0,
                  liquidationDistancePct: Number(p.liquidationDistancePct) || 0,
                  unrealizedPnl,
                  roiPct,
                  stopLossPrice:         Number(p.stopLossPrice)   || 0,
                  takeProfitPrice:       Number(p.takeProfitPrice) || 0,
                  orderId:               p.orderId ? String(p.orderId) : undefined,
                  stopLossOrderId:       p.stopLossOrderId ? String(p.stopLossOrderId) : undefined,
                  takeProfitOrderId:     p.takeProfitOrderId ? String(p.takeProfitOrderId) : undefined,
                  status:                String(p.status || "open"),
                  createdAt:             Number(p.createdAt) || 0,
                  updatedAt:             Number(p.updatedAt) || 0,
                  syncedAt:              Number(p.syncedAt)  || 0,
                  realPositionId:        p.realPositionId ? String(p.realPositionId) : undefined,
                  mirroredSetCount:      Number(p.mirroredSetCount) || (Array.isArray(p.mirroredSets) ? p.mirroredSets.length : 0),
                  mirroredSets:          Array.isArray(p.mirroredSets) ? p.mirroredSets : [],
                  resolution:            (p.resolution === "real-fallback" || p.resolution === "unresolved" ? p.resolution : "pseudo") as "pseudo" | "real-fallback" | "unresolved",
                }
              })
            : [],
          liveResolution: {
            pseudo:       Number(opLive.resolution?.pseudo)       || 0,
            realFallback: Number(opLive.resolution?.realFallback) || 0,
            unresolved:   Number(opLive.resolution?.unresolved)   || 0,
          },
          phase:            d.metadata?.phase || "",
          isActive:         d.metadata?.engineRunning || false,
        })
      } catch {
        // Non-critical polling — swallow silently so a blip doesn't
        // blank the dashboard strip.
      }
    }

    load()
    const interval = setInterval(load, 5000)

    // Event-driven refresh so toggles surface immediately rather than
    // waiting up to 5 seconds for the next interval tick.
    const handleEngineStateChanged = () => { load() }
    if (typeof window !== "undefined") {
      window.addEventListener("engine-state-changed", handleEngineStateChanged)
      window.addEventListener("connection-toggled", handleEngineStateChanged)
      window.addEventListener("live-trade-toggled", handleEngineStateChanged)
    }

    return () => {
      mounted = false
      clearInterval(interval)
      if (typeof window !== "undefined") {
        window.removeEventListener("engine-state-changed", handleEngineStateChanged)
        window.removeEventListener("connection-toggled", handleEngineStateChanged)
        window.removeEventListener("live-trade-toggled", handleEngineStateChanged)
      }
    }
  }, [connectionId])

  const allZero =
    stats.indicationCycles === 0 &&
    stats.indicationsTotal === 0 &&
    stats.strategiesTotal === 0

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-10 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Ind Cycles</span>
            <span className="font-bold text-blue-600 tabular-nums">{fmt(stats.indicationCycles)}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Indications</span>
            <span className="font-bold text-violet-600 tabular-nums">{fmt(stats.indicationsTotal)}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Strategies</span>
            <span className="font-bold text-amber-600 tabular-nums">{fmt(stats.strategiesTotal)}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Positions</span>
            <span className="font-bold text-green-600 tabular-nums">{fmt(stats.positionsOpen)}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Success %</span>
            <span className={`font-bold tabular-nums ${stats.successRate >= 80 ? "text-green-600" : stats.successRate >= 50 ? "text-blue-600" : "text-muted-foreground"}`}>
              {allZero ? "—" : `${stats.successRate.toFixed(0)}%`}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Avg ms</span>
            <span className={`font-bold tabular-nums ${stats.avgCycleMs > 0 && stats.avgCycleMs <= 1000 ? "text-green-600" : stats.avgCycleMs > 1000 ? "text-orange-600" : "text-muted-foreground"}`}>
              {stats.avgCycleMs > 0 ? stats.avgCycleMs : "—"}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Base</span>
            <span className="font-bold text-orange-600 tabular-nums">{fmt(stats.stratBase)}</span>
          </div>

          <div
            className="flex flex-col gap-0.5"
            title={
              `Main Sets — ${fmt(stats.stratMain)} total\n` +
              `• Evaluated (from Base): ${fmt(stats.mainEvaluated)}\n` +
              `• Pos.coord. additionally created: ${fmt(stats.mainCoordCreated)}\n` +
              `• Block + DCA Sets: ${fmt(stats.mainBlockDcaSets)}`
            }
          >
            <span className="text-muted-foreground">Main</span>
            <span className="font-bold text-yellow-600 tabular-nums">{fmt(stats.stratMain)}</span>
          </div>

          <div
            className="flex flex-col gap-0.5"
            title={
              `Real Sets — ${fmt(stats.stratReal)} total\n` +
              `• Currently open positions: ${fmt(stats.realOpen)}\n` +
              `(Real = Main→Real promotions that passed ratio gating.\n` +
              ` Volume is tracked only at the Live exchange stage —\n` +
              ` see Live strip below for actual USD exposure.)`
            }
          >
            <span className="text-muted-foreground">Real</span>
            <span className="font-bold text-emerald-600 tabular-nums">{fmt(stats.stratReal)}</span>
          </div>

          <div className="flex flex-col gap-0.5" title={`Live positions created on exchange — Fill ${stats.liveFillRate.toFixed(1)}% · WR ${stats.liveWinRate.toFixed(1)}%`}>
            <span className="text-muted-foreground">Live</span>
            <span className="font-bold text-amber-600 tabular-nums flex items-center gap-1">
              {fmt(stats.stratLive)}
              {stats.stratLive > 0 && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
                </span>
              )}
            </span>
          </div>
        </div>

        {/* NOTE: The Overall Strategies processing block above is
            deliberately independent of the accumulation view. Open-
            position accumulation belongs only to the downstream
            stages that actually hold exposure — Real (see main-
            breakdown strip below) and Live Exchange Orders (see Live
            strip further down). Pseudo-position aggregates are still
            captured by the /stats API for the per-stage tooltips and
            the Running-Sets coordination tooltip on Live, but are not
            surfaced here to avoid conflating cross-stage totals with
            evaluation processing. */}

        {/* Main-stage breakdown strip — Base → Main → Real funnel
            showing counts at each mirroring stage. No volume metrics
            here; volume is a Live-only figure and appears on the Live
            strip further down. */}
        {(stats.mainEvaluated > 0 ||
          stats.mainCoordCreated > 0 ||
          stats.mainBlockDcaSets > 0 ||
          stats.realOpen > 0) && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
            <div className="flex flex-col gap-0.5" title="Base Sets that reached Main-stage evaluation">
              <span className="text-muted-foreground">Main Eval (Base)</span>
              <span className="font-semibold text-yellow-700 tabular-nums">{fmt(stats.mainEvaluated)}</span>
            </div>
            <div className="flex flex-col gap-0.5" title="Additional related variant Sets created by Main-stage position coordination on top of the default Set">
              <span className="text-muted-foreground">Pos.coord. add&apos;l</span>
              <span className="font-semibold text-yellow-700 tabular-nums">{fmt(stats.mainCoordCreated)}</span>
            </div>
            <div className="flex flex-col gap-0.5" title="Cumulative Sets carrying a Block or DCA variant tag">
              <span className="text-muted-foreground">Block + DCA</span>
              <span className="font-semibold text-yellow-700 tabular-nums">{fmt(stats.mainBlockDcaSets)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title={
                `${fmt(stats.realOpen)} currently open Real positions (status ≠ closed).\n` +
                `These are Main→Real promotions that cleared ratio gating,\n` +
                `awaiting mirror-out to the live exchange stage.`
              }
            >
              <span className="text-muted-foreground">Real Open</span>
              <span className="font-semibold text-emerald-700 tabular-nums">{fmt(stats.realOpen)}</span>
            </div>
          </div>
        )}

        {/* Live exchange metrics strip — shown whenever live activity
            has occurred (stratLive > 0) OR anything is currently open.
            Six-column portfolio view: Live Open / Live Vol / Unr. PnL /
            Margin / ROI / Win·Fill. The PnL / Margin / ROI triplet is
            the authoritative real-money picture derived from the same
            per-position snapshot used in the coordination panel below
            — guarantees summary totals equal the sum of visible rows. */}
        {(stats.stratLive > 0 || stats.livePositions.length > 0) && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-6">
            <div
              className="flex flex-col gap-0.5"
              title="Live positions currently open on the exchange (created − closed)"
            >
              <span className="text-muted-foreground">Live Open</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveOpen)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title="Cumulative exchange-side trading volume in USD (progHash.live_volume_usd_total). The single authoritative notional figure."
            >
              <span className="text-muted-foreground">Live Vol</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmtUsd(stats.liveVolumeUsd)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title={
                `Portfolio unrealized PnL across ${stats.livePositions.length} open exchange position${stats.livePositions.length === 1 ? "" : "s"}\n` +
                `${stats.liveInProfit} in profit · ${stats.liveInLoss} in loss`
              }
            >
              <span className="text-muted-foreground">Unr. PnL</span>
              <span
                className={`font-semibold tabular-nums ${
                  stats.liveUnrealizedPnl > 0
                    ? "text-green-600"
                    : stats.liveUnrealizedPnl < 0
                      ? "text-red-600"
                      : "text-muted-foreground"
                }`}
              >
                {stats.liveUnrealizedPnl > 0 ? "+" : ""}
                {fmtUsd(stats.liveUnrealizedPnl)}
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title="Total margin at risk across all open exchange positions (sum of volumeUsd / leverage per position). This is the actual capital committed, not the notional exposure."
            >
              <span className="text-muted-foreground">Margin</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmtUsd(stats.liveMarginUsd)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title="Portfolio ROI = totalUnrealizedPnl / totalMargin × 100 (matches exchange ROE semantics)"
            >
              <span className="text-muted-foreground">ROI</span>
              <span
                className={`font-semibold tabular-nums ${
                  stats.livePortfolioRoiPct > 0
                    ? "text-green-600"
                    : stats.livePortfolioRoiPct < 0
                      ? "text-red-600"
                      : "text-muted-foreground"
                }`}
              >
                {stats.livePortfolioRoiPct > 0 ? "+" : ""}
                {stats.livePortfolioRoiPct.toFixed(2)}%
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title={`Win rate: ${stats.liveWinRate.toFixed(1)}% · Fill rate: ${stats.liveFillRate.toFixed(1)}% · Filled: ${fmt(stats.liveFilled)} · Closed: ${fmt(stats.liveClosed)}`}
            >
              <span className="text-muted-foreground">Win / Fill</span>
              <span className="font-semibold text-amber-700 tabular-nums">
                <span className={stats.liveWinRate >= 50 ? "text-green-600" : "text-amber-700"}>
                  {stats.liveWinRate.toFixed(0)}%
                </span>
                <span className="text-muted-foreground mx-0.5">/</span>
                {stats.liveFillRate.toFixed(0)}%
              </span>
            </div>
          </div>
        )}

        {/* Risk-alert row — surfaces near-liquidation + stale-sync
            situations the operator needs to act on immediately. Only
            rendered when there's something to warn about. */}
        {(stats.liveNearLiquidation > 0 || stats.liveStaleSync > 0 ||
          (stats.liveConsolidatedSetsTotal > stats.livePositions.length && stats.livePositions.length > 0)) && (
          <div className="mt-1 flex items-center gap-3 flex-wrap text-[9px]">
            {stats.liveNearLiquidation > 0 && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 font-semibold"
                title={`${stats.liveNearLiquidation} exchange position${stats.liveNearLiquidation === 1 ? " is" : "s are"} within 5% of the liquidation price — reduce leverage or add margin`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                {stats.liveNearLiquidation} near-liq
              </span>
            )}
            {stats.liveStaleSync > 0 && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                title={`${stats.liveStaleSync} position${stats.liveStaleSync === 1 ? "" : "s"} not reconciled with the exchange in >60s — sync may be lagging`}
              >
                {stats.liveStaleSync} stale sync
              </span>
            )}
            {stats.liveConsolidatedSetsTotal > stats.livePositions.length && stats.livePositions.length > 0 && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/15 text-primary"
                title={`Across ${stats.livePositions.length} exchange order${stats.livePositions.length === 1 ? "" : "s"}, ${stats.liveConsolidatedSetsTotal} equivalent Sets were consolidated — ${stats.liveConsolidatedSetsTotal - stats.livePositions.length} duplicate exchange orders avoided.`}
              >
                {stats.liveConsolidatedSetsTotal} Sets &rarr; {stats.livePositions.length} order{stats.livePositions.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        {/* ── Exchange Positions ← Mirrored Sets (consolidation view) ─
            Every live exchange position is the deduplicated mirror of
            one-or-more equivalent upstream Sets (same base + same
            ranges). This panel answers, per exchange position, "which
            Sets is this order consolidating?" Columns:
              • symbol/direction — Exchange Position Info identifier
              • exposure         — USD on the exchange (real money)
              • unrealized PnL   — live P&L
              • mirrored Sets    — N equivalent Sets → 1 exchange order
                                    (hover for the full list with per-
                                    Set pseudo-position count)
              • resolution badge — where the Set match came from:
                                    P (pseudo, exact) /
                                    R (real-fallback) /
                                    ? (unresolved). */}
        {stats.livePositions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              <span>Exchange Positions &mdash; Mirroring Coordination</span>
              <span
                className="text-[9px] tabular-nums"
                title={
                  `Set-resolution provenance:\n` +
                  `• P ${stats.liveResolution.pseudo} pseudo       (exact Base-ledger match — authoritative)\n` +
                  `• R ${stats.liveResolution.realFallback} real-fallback (Base row closed — resolved via Real-stage)\n` +
                  `• ? ${stats.liveResolution.unresolved} unresolved  (no upstream match — investigate)`
                }
              >
                P {stats.liveResolution.pseudo} &middot; R {stats.liveResolution.realFallback} &middot; ? {stats.liveResolution.unresolved}
              </span>
            </div>
            <div className="space-y-1">
              {stats.livePositions.slice(0, 8).map((lp) => (
                <ExchangePositionRow key={lp.id} lp={lp} />
              ))}
              {stats.livePositions.length > 8 && (
                <div className="text-[9px] text-muted-foreground text-center pt-0.5">
                  +{stats.livePositions.length - 8} more exchange position{stats.livePositions.length - 8 === 1 ? "" : "s"} (truncated)
                </div>
              )}
            </div>
          </div>
        )}

        {stats.phase && stats.phase !== "—" && (
          <div className="mt-2 pt-2 border-t border-border/40 flex items-center gap-2">
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${stats.isActive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
            <span className="text-[10px] text-muted-foreground capitalize">
              {stats.phase.replace(/_/g, " ")}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
