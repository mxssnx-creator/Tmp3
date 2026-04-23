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
  // ── OPEN POSITIONS + ACCUMULATED VOLUME ──────────────────────────
  // Sourced from `/stats`'s new `openPositions` branch. Two parallel
  // ledgers: Pseudo (Base-stage volume-aware; has per-Set rollup) and
  // Real (Main→Real promotions; count + notional). Live comes from
  // the exchange progression counters. Overall roll-up is server-
  // computed so the dashboard never has to sum it client-side.
  pseudoOpen: number
  pseudoVolumeUsd: number
  pseudoRunningSets: number
  pseudoTopSets: Array<{ setKey: string; count: number; volumeUsd: number }>
  realOpen: number
  realVolumeUsd: number
  liveOpen: number
  liveVolumeUsd: number
  totalOpenPositions: number
  totalVolumeUsd: number
  liveFilled: number
  liveClosed: number
  liveWinRate: number
  liveFillRate: number
  // ── Live-exchange position → Set relation coordination ───────────
  // Per-position breakdown emitted by `/stats` (openPositions.live.
  // positions). The server joins each live exchange position against
  // the pseudo-position ledger by symbol+direction, so the UI can
  // surface the exact Set a live order was spawned from (Exchange
  // Position Info → Set coordination). Each entry carries top-3
  // candidate setKeys ranked by USD exposure, plus a `resolution`
  // tag that tells us how the match was made (pseudo | real-fallback
  // | unresolved).
  livePositions: Array<{
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
  pseudoVolumeUsd: 0,
  pseudoRunningSets: 0,
  pseudoTopSets: [],
  realOpen: 0,
  realVolumeUsd: 0,
  liveOpen: 0,
  liveVolumeUsd: 0,
  totalOpenPositions: 0,
  totalVolumeUsd: 0,
  liveFilled: 0,
  liveClosed: 0,
  liveWinRate: 0,
  liveFillRate: 0,
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

        // ── Open positions + accumulated volume ─────────────────────
        // Full shape lives at d.openPositions:
        //   { pseudo: { open, volumeUsd, runningSets, topSets[] },
        //     real:   { open, volumeUsd },
        //     live:   { open, volumeUsd },
        //     overall:{ totalOpenPositions, pseudoVolumeUsd,
        //               realVolumeUsd, liveVolumeUsd,
        //               totalVolumeUsd, runningSetsCount } }
        // All numeric values are already rounded server-side so the UI
        // can render them directly without further math.
        const op = d.openPositions || {}
        const opPseudo = op.pseudo  || {}
        const opReal   = op.real    || {}
        const opLive   = op.live    || {}
        const opAll    = op.overall || {}

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
          pseudoVolumeUsd:      Number(opPseudo.volumeUsd)   || 0,
          pseudoRunningSets:    Number(opPseudo.runningSets) || 0,
          pseudoTopSets:        Array.isArray(opPseudo.topSets) ? opPseudo.topSets : [],
          realOpen:             Number(opReal.open)          || 0,
          realVolumeUsd:        Number(opReal.volumeUsd)     || 0,
          liveOpen:             Number(opLive.open)          || 0,
          liveVolumeUsd:        Number(opLive.volumeUsd)     || 0,
          totalOpenPositions:   Number(opAll.totalOpenPositions) || 0,
          totalVolumeUsd:       Number(opAll.totalVolumeUsd)     || 0,
          liveFilled:       liveExec.ordersFilled     || 0,
          liveClosed:       liveExec.positionsClosed  || 0,
          liveWinRate:      liveExec.winRate          || liveDetail.winRate  || 0,
          liveFillRate:     liveExec.fillRate         || liveDetail.passRatio || 0,
          // Live-exchange → Set coordination payload (scan-derived).
          // Values come from openPositions.live.positions / .resolution
          // server-side. Guard against legacy responses that don't
          // include the branch yet.
          livePositions:    Array.isArray(opLive.positions) ? opLive.positions : [],
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
              `• Accumulated volume: ${fmtUsd(stats.realVolumeUsd)}\n` +
              `(Real = Main→Real promotions that passed ratio gating)`
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

        {/* Main-stage breakdown strip — shown whenever Main has any
            evaluated Sets so the operator can see the cascade from
            Base → Main broken into: how many Base Sets were evaluated,
            how many additional related Sets position coordination
            contributed on top of the default variant, and how many of
            those carry a Block or DCA tag. Mirrors the Live strip
            pattern below for visual consistency. */}
        {(stats.mainEvaluated > 0 || stats.mainCoordCreated > 0 || stats.mainBlockDcaSets > 0) && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-5">
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
            {/* Real-stage accumulation — shows the downstream "what
                actually reached real trading size" picture right next
                to the Main breakdown so the operator can eyeball the
                Base → Main → Real funnel on one strip. */}
            <div
              className="flex flex-col gap-0.5"
              title={`${fmt(stats.realOpen)} currently open Real positions (status ≠ closed)`}
            >
              <span className="text-muted-foreground">Real Open</span>
              <span className="font-semibold text-emerald-700 tabular-nums">{fmt(stats.realOpen)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title={`Sum of quantity × entryPrice across open Real positions: ${fmtUsd(stats.realVolumeUsd)}`}
            >
              <span className="text-muted-foreground">Real Accum.</span>
              <span className="font-semibold text-emerald-700 tabular-nums">{fmtUsd(stats.realVolumeUsd)}</span>
            </div>
          </div>
        )}

        {/* Live exchange metrics strip — only shown when there is live activity */}
        {stats.stratLive > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-2 text-[10px] sm:grid-cols-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Filled</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveFilled)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Closed</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveClosed)}</span>
            </div>
            <div className="flex flex-col gap-0.5" title="Live positions currently open on the exchange (created − closed)">
              <span className="text-muted-foreground">Live Open</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveOpen)}</span>
            </div>
            <div
              className="flex flex-col gap-0.5"
              title="Cumulative exchange-side trading volume in USD (progHash.live_volume_usd_total)"
            >
              <span className="text-muted-foreground">Live Vol</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmtUsd(stats.liveVolumeUsd)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Fill %</span>
              <span className="font-semibold text-amber-700 tabular-nums">{stats.liveFillRate.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Win %</span>
              <span className={`font-semibold tabular-nums ${stats.liveWinRate >= 50 ? "text-green-600" : "text-amber-700"}`}>{stats.liveWinRate.toFixed(1)}%</span>
            </div>
          </div>
        )}

        {/* ── Live Exchange Orders → Set Coordination panel ──────────────
            For every OPEN exchange position on the live ledger, shows
            exactly which Set it belongs to (resolved server-side by
            joining symbol+direction against the pseudo-position
            ledger). This is the "coord to be identified for
            statistics — by Exchange Position Info values" view the
            operator asked for. Columns, per row:
              • symbol/direction — Exchange Position Info identifier
              • volume + PnL     — exposure & current unrealized P&L
              • Set              — top-ranked setKey (truncated) with
                                    resolution badge: pseudo / real-
                                    fallback / unresolved
              • tooltip lists the top-3 candidate setKeys with their
                per-Set counts and USD share, plus the resolution
                reason so the operator can trust the relationship. */}
        {stats.livePositions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              <span>Live Orders — Set Coordination</span>
              <span
                className="text-[9px] tabular-nums"
                title={
                  `Resolution sources:\n` +
                  `• pseudo:        ${stats.liveResolution.pseudo} (exact Base-ledger match)\n` +
                  `• real-fallback: ${stats.liveResolution.realFallback} (Base row closed — resolved via Real)\n` +
                  `• unresolved:    ${stats.liveResolution.unresolved} (no upstream match — investigate)`
                }
              >
                {stats.liveResolution.pseudo}p / {stats.liveResolution.realFallback}r / {stats.liveResolution.unresolved}u
              </span>
            </div>
            <div className="space-y-1">
              {stats.livePositions.slice(0, 8).map((lp) => {
                const primarySet = lp.setKeys[0]
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
                const tooltip = [
                  `${lp.symbol} ${lp.direction.toUpperCase()}  ·  ${fmtUsd(lp.volumeUsd)} exposure`,
                  `Unrealized PnL: ${lp.unrealizedPnl >= 0 ? "+" : ""}${fmtUsd(lp.unrealizedPnl)}`,
                  `Entry: ${lp.entryPrice}  ·  Mark: ${lp.markPrice || "—"}`,
                  ``,
                  `Resolution: ${lp.resolution}`,
                  lp.realPositionId ? `RealPositionId: ${lp.realPositionId}` : "",
                  ``,
                  lp.setKeys.length > 0
                    ? `Candidate Set${lp.setKeys.length > 1 ? "s" : ""} (by USD exposure):`
                    : `No upstream Set matched — position is orphaned.`,
                  ...lp.setKeys.map(
                    (s, i) =>
                      `  ${i + 1}. ${s.setKey}  (${s.count}× · ${fmtUsd(s.volumeUsd)})`,
                  ),
                ].filter(Boolean).join("\n")
                return (
                  <div
                    key={lp.id}
                    className="grid grid-cols-12 items-center gap-2 rounded px-2 py-1 bg-muted/30 hover:bg-muted/50 transition-colors text-[10px]"
                    title={tooltip}
                  >
                    <div className="col-span-3 flex items-center gap-1">
                      <span className="font-semibold text-foreground truncate">{lp.symbol}</span>
                      <span
                        className={`px-1 rounded text-[8px] uppercase font-semibold ${
                          lp.direction === "long"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                            : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                        }`}
                      >
                        {lp.direction}
                      </span>
                    </div>
                    <div className="col-span-2 tabular-nums text-right font-semibold text-amber-700">
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
                    >
                      {lp.unrealizedPnl > 0 ? "+" : ""}
                      {fmtUsd(lp.unrealizedPnl)}
                    </div>
                    <div className={`col-span-4 truncate font-mono text-[9px] ${resTone}`}>
                      {setLabel}
                    </div>
                    <div className="col-span-1 text-right">
                      <span
                        className={`px-1 rounded text-[8px] font-semibold ${
                          lp.resolution === "pseudo"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                            : lp.resolution === "real-fallback"
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {lp.resolution === "pseudo"
                          ? "P"
                          : lp.resolution === "real-fallback"
                            ? "R"
                            : "?"}
                      </span>
                    </div>
                  </div>
                )
              })}
              {stats.livePositions.length > 8 && (
                <div className="text-[9px] text-muted-foreground text-center pt-0.5">
                  +{stats.livePositions.length - 8} more live position{stats.livePositions.length - 8 === 1 ? "" : "s"} (truncated)
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
