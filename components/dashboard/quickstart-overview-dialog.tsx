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

interface EngineStats {
  indicationCycleCount: number
  strategyCycleCount: number
  cyclesCompleted: number
  cycleSuccessRate: number
  totalIndicationsCount: number
  indicationsByType: Record<string, number>
  baseStrategyCount: number
  mainStrategyCount: number
  realStrategyCount: number
  liveStrategyCount: number
  totalStrategyCount: number
  positionsCount: number
  totalProfit: number
}

interface ProgressionLogs {
  logs: Array<{ timestamp: string; level: string; phase: string; message: string; details?: any }>
  progressionState: {
    cyclesCompleted: number
    successfulCycles: number
    failedCycles: number
    cycleSuccessRate: number
    indicationsCount: number
    strategiesCount: number
    realtimeCycleCount: number
    prehistoricCyclesCompleted: number
    prehistoricSymbolsProcessedCount: number
    prehistoricCandlesProcessed: number
    setsBaseCount: number
    setsMainCount: number
    setsRealCount: number
    indicationEvaluatedDirection: number
    indicationEvaluatedMove: number
    indicationEvaluatedActive: number
    indicationEvaluatedOptimal: number
    processingCompleteness: {
      prehistoricLoaded: boolean
      indicationsRunning: boolean
      strategiesRunning: boolean
      realtimeRunning: boolean
      hasErrors: boolean
    }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function QuickstartOverviewDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const connectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || connectionId

  const [isOpen, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [engineStats, setEngineStats] = useState<EngineStats | null>(null)
  const [progLogs, setProgLogs] = useState<ProgressionLogs | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/trading/engine-stats?connection_id=${connectionId}`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (statsRes.ok) {
        const data = await statsRes.json()
        setEngineStats(data)
      }
      if (logsRes.ok) {
        const data = await logsRes.json()
        setProgLogs(data)
      }
      setLastRefresh(new Date())
    } catch (err) {
      console.error("[v0] [QuickstartOverview] load error:", err)
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  // Load on open, and auto-refresh every 3s while open
  useEffect(() => {
    if (!isOpen) return
    load()
    const interval = setInterval(load, 3000)
    return () => clearInterval(interval)
  }, [isOpen, load])

  const ps = progLogs?.progressionState
  const es = engineStats
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n)

  const indicationTypeRows = [
    { label: "Direction", value: ps?.indicationEvaluatedDirection || 0, color: "bg-blue-500" },
    { label: "Move",      value: ps?.indicationEvaluatedMove      || 0, color: "bg-violet-500" },
    { label: "Active",    value: ps?.indicationEvaluatedActive    || 0, color: "bg-green-500" },
    { label: "Optimal",   value: ps?.indicationEvaluatedOptimal   || 0, color: "bg-amber-500" },
  ]
  const totalIndByType = indicationTypeRows.reduce((s, r) => s + r.value, 0) || 1

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { setOpen(v) }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Main / Log overview">
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
            </p>
          )}
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 grid grid-cols-4">
            <TabsTrigger value="overview"  className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="prehistoric" className="text-xs">Prehistoric</TabsTrigger>
            <TabsTrigger value="indications" className="text-xs">Indications</TabsTrigger>
            <TabsTrigger value="logs"      className="text-xs">Logs</TabsTrigger>
          </TabsList>

          {/* ── Overview ── */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto space-y-3 mt-3">
            {/* Cycle counts */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: "Indication Cycles", value: fmt(es?.indicationCycleCount || 0), accent: "text-blue-600 dark:text-blue-400" },
                { label: "Strategy Cycles",   value: fmt(es?.strategyCycleCount   || 0), accent: "text-violet-600 dark:text-violet-400" },
                { label: "Total Indications", value: fmt(es?.totalIndicationsCount || ps?.indicationsCount || 0), accent: "text-green-600 dark:text-green-400" },
                { label: "Open Positions",    value: fmt(es?.positionsCount        || 0), accent: "text-amber-600 dark:text-amber-400" },
              ].map(({ label, value, accent }) => (
                <div key={label} className="rounded-lg border bg-card p-3 text-center">
                  <div className={`text-2xl font-bold tabular-nums ${accent}`}>{value}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Strategies breakdown */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Zap className="w-4 h-4 text-amber-500" />
                Strategies
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {[
                  { label: "Base",  value: es?.baseStrategyCount  || 0 },
                  { label: "Main",  value: es?.mainStrategyCount  || 0 },
                  { label: "Real",  value: es?.realStrategyCount  || 0 },
                  { label: "Total", value: es?.totalStrategyCount || 0 },
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
                  { label: "Historical Data", done: ps?.processingCompleteness?.prehistoricLoaded },
                  { label: "Indications",     done: ps?.processingCompleteness?.indicationsRunning },
                  { label: "Strategies",      done: ps?.processingCompleteness?.strategiesRunning },
                  { label: "Realtime",        done: ps?.processingCompleteness?.realtimeRunning },
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
                <span className="tabular-nums font-bold">
                  {(es?.cycleSuccessRate || ps?.cycleSuccessRate || 0).toFixed(1)}%
                </span>
              </div>
              <Progress value={es?.cycleSuccessRate || ps?.cycleSuccessRate || 0} className="h-1.5" />
            </div>
          </TabsContent>

          {/* ── Prehistoric ── */}
          <TabsContent value="prehistoric" className="flex-1 overflow-y-auto space-y-3 mt-3">
            <div className="rounded-lg border bg-card p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database className="w-4 h-4 text-blue-500" />
                Historical Data Processing
                <Badge
                  variant={ps?.processingCompleteness?.prehistoricLoaded ? "default" : "secondary"}
                  className="ml-auto text-[10px]"
                >
                  {ps?.processingCompleteness?.prehistoricLoaded ? "Loaded" : "Pending"}
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {[
                  { label: "Symbols Processed", value: fmt(ps?.prehistoricSymbolsProcessedCount || 0) },
                  { label: "Candles Loaded",     value: fmt(ps?.prehistoricCandlesProcessed      || 0) },
                  { label: "Prehistoric Cycles", value: fmt(ps?.prehistoricCyclesCompleted        || 0) },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded bg-blue-50 dark:bg-blue-950/30 p-2.5">
                    <div className="text-lg font-bold tabular-nums text-blue-700 dark:text-blue-400">{value}</div>
                    <div className="text-muted-foreground mt-0.5">{label}</div>
                  </div>
                ))}
              </div>

              {/* Sets breakdown */}
              <div className="space-y-2 pt-1 border-t">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Strategy Sets Created</div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  {[
                    { label: "Base Sets",  value: ps?.setsBaseCount || 0 },
                    { label: "Main Sets",  value: ps?.setsMainCount || 0 },
                    { label: "Real Sets",  value: ps?.setsRealCount || 0 },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded bg-muted/50 p-2">
                      <div className="font-semibold tabular-nums">{fmt(value)}</div>
                      <div className="text-muted-foreground">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── Indications ── */}
          <TabsContent value="indications" className="flex-1 overflow-y-auto space-y-3 mt-3">
            <div className="rounded-lg border bg-card p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Activity className="w-4 h-4 text-violet-500" />
                Indication Breakdown
              </div>

              <div className="space-y-2">
                {indicationTypeRows.map(({ label, value, color }) => (
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
                  <span className="font-medium tabular-nums">{fmt(es?.indicationCycleCount || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Evaluated</span>
                  <span className="font-medium tabular-nums">{fmt(es?.totalIndicationsCount || ps?.indicationsCount || 0)}</span>
                </div>
              </div>
            </div>

            {/* Strategies per type */}
            <div className="rounded-lg border bg-card p-3 space-y-2">
              <div className="text-sm font-medium">Strategy Hierarchy</div>
              <div className="space-y-2 text-xs">
                {[
                  { label: "Base Strategies",  value: es?.baseStrategyCount  || ps?.setsBaseCount || 0, desc: "All initial strategy sets" },
                  { label: "Main Strategies",  value: es?.mainStrategyCount  || ps?.setsMainCount || 0, desc: "Filtered top performers" },
                  { label: "Real Strategies",  value: es?.realStrategyCount  || ps?.setsRealCount || 0, desc: "Highest confidence only" },
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
          </TabsContent>

          {/* ── Logs ── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 mt-3">
            <ScrollArea className="flex-1 rounded border">
              <div className="p-2 space-y-1">
                {(progLogs?.logs || []).length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground py-8">No logs available yet.</p>
                ) : (
                  (progLogs?.logs || []).slice(0, 150).map((log, idx) => (
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
