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

    const load = async () => {
      try {
        const res = await fetch(
          `/api/connections/progression/${connectionId}/stats`,
          { cache: "no-store" }
        )
        if (!res.ok || !mounted) return
        const d = await res.json()

        // Live execution metrics are exposed at `liveExecution` (preferred)
        // and `strategyDetail.live` (extra fields) by the /stats endpoint.
        const liveExec   = d.liveExecution       || {}
        const liveDetail = d.strategyDetail?.live || {}
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
          liveFilled:       liveExec.ordersFilled     || 0,
          liveClosed:       liveExec.positionsClosed  || 0,
          liveWinRate:      liveExec.winRate          || liveDetail.winRate  || 0,
          liveFillRate:     liveExec.fillRate         || liveDetail.passRatio || 0,
          phase:            d.metadata?.phase || "",
          isActive:         d.metadata?.engineRunning || false,
        })
      } catch {
        // non-critical
      }
    }

    load()
    const interval = setInterval(load, 5000)
    return () => {
      mounted = false
      clearInterval(interval)
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

          <div className="flex flex-col gap-0.5">
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
