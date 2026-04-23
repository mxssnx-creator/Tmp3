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
  liveFilled: number
  liveClosed: number
  liveWinRate: number
  liveFillRate: number
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
  liveFilled: 0,
  liveClosed: 0,
  liveWinRate: 0,
  liveFillRate: 0,
  phase: "",
  isActive: false,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
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
          liveFilled:       liveExec.ordersFilled     || 0,
          liveClosed:       liveExec.positionsClosed  || 0,
          liveWinRate:      liveExec.winRate          || liveDetail.winRate  || 0,
          liveFillRate:     liveExec.fillRate         || liveDetail.passRatio || 0,
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

          <div className="flex flex-col gap-0.5">
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

        {/* Main-stage breakdown strip — shown whenever Main has any
            evaluated Sets so the operator can see the cascade from
            Base → Main broken into: how many Base Sets were evaluated,
            how many additional related Sets position coordination
            contributed on top of the default variant, and how many of
            those carry a Block or DCA tag. Mirrors the Live strip
            pattern below for visual consistency. */}
        {(stats.mainEvaluated > 0 || stats.mainCoordCreated > 0 || stats.mainBlockDcaSets > 0) && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-2 text-[10px]">
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
          </div>
        )}

        {/* Live exchange metrics strip — only shown when there is live activity */}
        {stats.stratLive > 0 && (
          <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-4 gap-2 text-[10px]">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Filled</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveFilled)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Closed</span>
              <span className="font-semibold text-amber-700 tabular-nums">{fmt(stats.liveClosed)}</span>
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
