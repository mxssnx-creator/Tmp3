"use client"

import React, { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { BarChart3, RefreshCw, Database, Activity, Zap, TrendingUp, ChevronRight } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface StatsResponse {
  historic: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    indicatorsCalculated: number
    cyclesCompleted: number
    isComplete: boolean
    progressPercent: number
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    realtimeCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    isActive: boolean
    successRate: number
    avgCycleTimeMs: number
  }
  breakdown: {
    indications: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
    strategies: { base: number; main: number; real: number; live: number; total: number }
  }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string; lastUpdate: string }
}

interface LogEntry {
  timestamp: string
  level: string
  phase: string
  message: string
  details?: any
}

// ─── component ────────────────────────────────────────────────────────────────

export function QuickstartOverviewDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const connectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || connectionId

  const [isOpen, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      // Single canonical /stats call covers historic + realtime + breakdown in one response.
      // Logs are fetched separately — they are large and only rendered in the Logs tab.
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (logsRes.ok) {
        const d = await logsRes.json()
        setLogs(d.logs || d.recentLogs || [])
      }
      setLastRefresh(new Date())
    } catch (err) {
      console.error("[v0] [QuickstartOverview] load error:", err)
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  // Load on open, then poll every 3s while open
  useEffect(() => {
    if (!isOpen) return
    load()
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [isOpen, load])

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n)

  const h  = stats?.historic
  const rt = stats?.realtime
  const bd = stats?.breakdown

  const indTypeRows = [
    { label: "Direction", value: bd?.indications.direction || 0, color: "bg-blue-500" },
    { label: "Move",      value: bd?.indications.move      || 0, color: "bg-violet-500" },
    { label: "Active",    value: bd?.indications.active    || 0, color: "bg-green-500" },
    { label: "Optimal",   value: bd?.indications.optimal   || 0, color: "bg-amber-500" },
    { label: "Auto",      value: bd?.indications.auto      || 0, color: "bg-rose-500" },
  ]
  const totalIndByType = indTypeRows.reduce((s, r) => s + r.value, 0) || 1

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Engine overview">
          <BarChart3 className="h-4 w-4" />
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Engine Overview
            {connectionLabel && (
              <Badge variant="secondary" className="text-xs font-normal">{connectionLabel}</Badge>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto h-7 w-7"
              onClick={load}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          {lastRefresh && (
            <p className="text-[11px] text-muted-foreground">
              Updated {lastRefresh.toLocaleTimeString()}
              {stats?.metadata?.phase && (
                <> &bull; Phase: <span className="font-medium">{stats.metadata.phase}</span></>
              )}
            </p>
          )}
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 grid grid-cols-4">
            <TabsTrigger value="overview"    className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="historic"    className="text-xs">Historic</TabsTrigger>
            <TabsTrigger value="realtime"    className="text-xs">Realtime</TabsTrigger>
            <TabsTrigger value="logs"        className="text-xs">Logs</TabsTrigger>
          </TabsList>

          {/* ── Overview ── */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto space-y-3 mt-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: "Indication Cycles", value: fmt(rt?.indicationCycles || 0), accent: "text-blue-600 dark:text-blue-400" },
                { label: "Strategy Cycles",   value: fmt(rt?.strategyCycles   || 0), accent: "text-violet-600 dark:text-violet-400" },
                { label: "Total Indications", value: fmt(rt?.indicationsTotal || 0), accent: "text-green-600 dark:text-green-400" },
                { label: "Open Positions",    value: fmt(rt?.positionsOpen    || 0), accent: "text-amber-600 dark:text-amber-400" },
              ].map(({ label, value, accent }) => (
                <div key={label} className="rounded-lg border bg-card p-3 text-center">
                  <div className={`text-2xl font-bold tabular-nums ${accent}`}>{value}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Strategies */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Zap className="w-4 h-4 text-amber-500" />
                Strategies
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {[
                  { label: "Base",  value: bd?.strategies.base  || 0 },
                  { label: "Main",  value: bd?.strategies.main  || 0 },
                  { label: "Real",  value: bd?.strategies.real  || 0 },
                  { label: "Total", value: bd?.strategies.total || 0 },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded bg-muted/50 p-2">
                    <div className="font-semibold tabular-nums">{fmt(value)}</div>
                    <div className="text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Processing status */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Activity className="w-4 h-4 text-green-500" />
                Processing Status
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                {[
                  { label: "Historical Data", done: h?.isComplete },
                  { label: "Indications",     done: (rt?.indicationCycles || 0) > 0 },
                  { label: "Strategies",      done: (rt?.strategyCycles   || 0) > 0 },
                  { label: "Realtime",        done: rt?.isActive },
                ].map(({ label, done }) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <Badge variant={done ? "default" : "secondary"} className="text-[10px] h-5 px-1.5">
                      {done ? "Active" : "Pending"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>

            {/* Cycle success */}
            <div className="rounded-lg border bg-card p-3 space-y-1.5">
              <div className="flex items-center justify-between text-sm font-medium">
                <span className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-blue-500" />
                  Cycle Success Rate
                </span>
                <span className="tabular-nums font-bold">{(rt?.successRate || 0).toFixed(1)}%</span>
              </div>
              <Progress value={rt?.successRate || 0} className="h-1.5" />
            </div>
          </TabsContent>

          {/* ── Historic ── */}
          <TabsContent value="historic" className="flex-1 overflow-y-auto space-y-3 mt-3">
            <div className="rounded-lg border bg-card p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database className="w-4 h-4 text-blue-500" />
                Historical Data Processing
                <Badge
                  variant={h?.isComplete ? "default" : "secondary"}
                  className="ml-auto text-[10px]"
                >
                  {h?.isComplete ? "Loaded" : "Pending"}
                </Badge>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Symbols: {h?.symbolsProcessed || 0} / {h?.symbolsTotal || 0}</span>
                  <span>{h?.progressPercent || 0}%</span>
                </div>
                <Progress value={h?.progressPercent || 0} className="h-2" />
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {[
                  { label: "Symbols",       value: fmt(h?.symbolsProcessed      || 0), bg: "bg-blue-50 dark:bg-blue-950/30", txt: "text-blue-700 dark:text-blue-400" },
                  { label: "Candles",       value: fmt(h?.candlesLoaded          || 0), bg: "bg-sky-50 dark:bg-sky-950/30",   txt: "text-sky-700 dark:text-sky-400" },
                  { label: "Preh. Cycles",  value: fmt(h?.cyclesCompleted        || 0), bg: "bg-indigo-50 dark:bg-indigo-950/30", txt: "text-indigo-700 dark:text-indigo-400" },
                ].map(({ label, value, bg, txt }) => (
                  <div key={label} className={`rounded ${bg} p-2.5`}>
                    <div className={`text-lg font-bold tabular-nums ${txt}`}>{value}</div>
                    <div className="text-muted-foreground mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── Realtime ── */}
          <TabsContent value="realtime" className="flex-1 overflow-y-auto space-y-3 mt-3">
            {/* Indication breakdown */}
            <div className="rounded-lg border bg-card p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Activity className="w-4 h-4 text-violet-500" />
                Indication Breakdown
                <span className="ml-auto text-xs text-muted-foreground">
                  Total: {fmt(bd?.indications.total || 0)}
                </span>
              </div>
              <div className="space-y-2">
                {indTypeRows.map(({ label, value, color }) => (
                  <div key={label} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium tabular-nums">{fmt(value)}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full ${color} rounded-full transition-all`}
                        style={{ width: `${Math.min(100, (value / totalIndByType) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t pt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Indication Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.indicationCycles || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Realtime Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.realtimeCycles || 0)}</span>
                </div>
              </div>
            </div>

            {/* Strategy hierarchy */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="text-sm font-medium">Strategy Hierarchy</div>
              <div className="space-y-2 text-xs">
                {[
                  { label: "Base Strategies", value: bd?.strategies.base || 0, desc: "All initial strategy sets" },
                  { label: "Main Strategies", value: bd?.strategies.main || 0, desc: "Filtered top performers" },
                  { label: "Real Strategies", value: bd?.strategies.real || 0, desc: "Highest confidence only" },
                ].map(({ label, value, desc }) => (
                  <div key={label} className="flex items-center gap-2 p-2 rounded bg-muted/40">
                    <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                      <div className="font-medium">{label}</div>
                      <div className="text-muted-foreground">{desc}</div>
                    </div>
                    <div className="font-bold tabular-nums">{fmt(value)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Perf row */}
            <div className="rounded-lg border bg-card p-3 grid grid-cols-3 gap-2 text-center text-xs">
              {[
                { label: "Success Rate", value: `${(rt?.successRate || 0).toFixed(1)}%` },
                { label: "Avg Cycle",    value: `${rt?.avgCycleTimeMs || 0}ms` },
                { label: "Positions",    value: fmt(rt?.positionsOpen || 0) },
              ].map(({ label, value }) => (
                <div key={label} className="rounded bg-muted/50 p-2">
                  <div className="font-semibold tabular-nums">{value}</div>
                  <div className="text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* ── Logs ── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 mt-3">
            <ScrollArea className="flex-1 rounded border">
              <div className="p-2 space-y-1">
                {logs.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground py-8">No logs available yet.</p>
                ) : (
                  logs.slice(0, 150).map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs py-1 px-1.5 rounded hover:bg-muted/40">
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] h-4 px-1 shrink-0 ${
                          log.level === "error"   ? "border-red-400 text-red-600" :
                          log.level === "warning" ? "border-amber-400 text-amber-600" :
                          "border-border text-muted-foreground"
                        }`}
                      >
                        {log.phase}
                      </Badge>
                      <span className="flex-1 text-foreground break-words">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
