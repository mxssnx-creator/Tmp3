"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Loader2, Zap, TrendingUp, Clock, AlertCircle, RefreshCw, Trash2, Database, Activity } from "lucide-react"
import { toast } from "@/lib/simple-toast"

// ─── interfaces ────────────────────────────────────────────────────────────────

interface ProgressionLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
  progression?: any
}

interface ProgressionLog {
  timestamp: string
  level: string
  phase: string
  message: string
  details?: any
}

// Stats shape from /stats endpoint
interface StatsShape {
  historic: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
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
    strategies: { base: number; main: number; real: number; live: number; total: number; baseEvaluated: number; mainEvaluated: number; realEvaluated: number }
  }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string }
  // Legacy fields from /logs for trading activity
  progressionState?: {
    totalTrades?: number
    successfulTrades?: number
    tradeSuccessRate?: number
    totalProfit?: number
    processingCompleteness?: {
      prehistoricLoaded?: boolean
      indicationsRunning?: boolean
      strategiesRunning?: boolean
      realtimeRunning?: boolean
    }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function ProgressionLogsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
}: ProgressionLogsDialogProps) {
  const [logs, setLogs] = useState<ProgressionLog[]>([])
  const [stats, setStats] = useState<StatsShape | null>(null)
  const [tradingState, setTradingState] = useState<StatsShape["progressionState"] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<"log" | "info" | "breakdown">("log")
  // Category filter for the log list — "all" by default, otherwise by level
  const [logFilter, setLogFilter] = useState<"all" | "info" | "warning" | "error" | "debug">("all")

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      // Primary: /stats endpoint (canonical historic + realtime + breakdown)
      // Secondary: /logs endpoint (for actual log entries + trading activity from progressionState)
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (statsRes.ok) setStats(await statsRes.json())

      if (logsRes.ok) {
        const logsData = await logsRes.json()
        const logsArr: ProgressionLog[] = (logsData.logs || logsData.recentLogs || []).slice(0, 150)
        setLogs(logsArr)
        // Trading activity fields come from /logs progressionState
        if (logsData.progressionState) {
          setTradingState(logsData.progressionState)
        }
      }
    } catch {
      // non-critical
    } finally {
      setIsLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (!open) return
    loadData()
    const interval = setInterval(loadData, 2000)
    return () => clearInterval(interval)
  }, [open, loadData])

  const handleClearLogs = async () => {
    if (!confirm("Clear all logs for this connection?")) return
    try {
      const res = await fetch(`/api/connections/progression/${connectionId}/logs`, { method: "DELETE" })
      if (res.ok) {
        setLogs([])
        toast.success("Logs cleared")
      } else {
        toast.error("Failed to clear logs")
      }
    } catch {
      toast.error("Failed to clear logs")
    }
  }

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n)

  const levelCls = (level: string) => {
    switch (level?.toLowerCase()) {
      case "error":   return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400"
      case "warning": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400"
      case "debug":   return "bg-muted text-muted-foreground"
      default:        return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-400"
    }
  }

  const rt = stats?.realtime
  const h  = stats?.historic
  const bd = stats?.breakdown

  const indTypes = [
    { label: "Direction", value: bd?.indications.direction || 0 },
    { label: "Move",      value: bd?.indications.move      || 0 },
    { label: "Active",    value: bd?.indications.active    || 0 },
    { label: "Optimal",   value: bd?.indications.optimal   || 0 },
    { label: "Auto",      value: bd?.indications.auto      || 0 },
  ]
  const totalIndByType = indTypes.reduce((s, r) => s + r.value, 0) || 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[82vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            {connectionName} — Engine Progression
            {(rt?.indicationCycles || 0) > 0 && (
              <Badge variant="default" className="bg-green-600 text-[11px]">
                {fmt(rt?.indicationCycles || 0)} cycles
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="log">Logs</TabsTrigger>
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
          </TabsList>

          {/* ── Logs ── */}
          <TabsContent value="log" className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {logs.length} entries {isLoading && "(updating...)"}
                </span>
                {/* Live auto-refresh indicator */}
                <Badge variant="outline" className="text-[10px] gap-1 h-5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                  </span>
                  2s
                </Badge>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {/* Category filter */}
                {(["all", "info", "warning", "error", "debug"] as const).map((f) => (
                  <Button
                    key={f}
                    variant={logFilter === f ? "default" : "outline"}
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setLogFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </Button>
                ))}
                <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading} className="h-6 w-6 p-0">
                  <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="outline" size="sm" onClick={handleClearLogs} disabled={logs.length === 0} className="h-6 w-6 p-0">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1">
              {isLoading && logs.length === 0 ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
                  <AlertCircle className="w-5 h-5" />
                  <span className="text-sm">No logs yet. Enable connection to start logging.</span>
                </div>
              ) : (
                <div className="space-y-px p-3">
                  {logs
                    .filter(l => logFilter === "all" || (l.level || "info").toLowerCase() === logFilter)
                    .map((log, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[auto_auto_auto_1fr] gap-2 text-xs p-2 rounded hover:bg-muted/40"
                    >
                      <span className="text-muted-foreground min-w-fit whitespace-nowrap">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      <Badge className={`${levelCls(log.level)} text-[10px] h-4 px-1`} variant="outline">
                        {log.level?.toUpperCase()}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] h-4 px-1 min-w-fit">
                        {log.phase}
                      </Badge>
                      <span className="break-words">{log.message}</span>
                      {log.details && (
                        <div className="col-span-4 mt-0.5 p-1.5 rounded bg-muted/30 font-mono text-[10px]">
                          <pre className="overflow-auto max-h-20">{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* ── Info ── */}
          <TabsContent value="info" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4">
                {/* Engine Cycles — from realtime section of /stats */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    <h3 className="font-semibold">Engine Cycles</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Indication Cycles", value: fmt(rt?.indicationCycles || 0), cls: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
                      { label: "Strategy Cycles",   value: fmt(rt?.strategyCycles   || 0), cls: "text-green-700 dark:text-green-400",   bg: "bg-green-50 dark:bg-green-950" },
                      { label: "Realtime Cycles",   value: fmt(rt?.realtimeCycles   || 0), cls: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
                      { label: "Success Rate",      value: `${(rt?.successRate || 0).toFixed(1)}%`, cls: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Historic Data — from historic section of /stats */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    <h3 className="font-semibold">Historical Data</h3>
                    <Badge
                      variant={h?.isComplete ? "default" : "secondary"}
                      className="ml-auto text-[11px]"
                    >
                      {h?.isComplete ? "Loaded" : "Pending"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{h?.symbolsProcessed || 0} / {h?.symbolsTotal || 0} symbols</span>
                      <span>{h?.progressPercent || 0}%</span>
                    </div>
                    <Progress value={h?.progressPercent || 0} className="h-1.5" />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Symbols",        value: fmt(h?.symbolsProcessed || 0), cls: "text-sky-700 dark:text-sky-400",     bg: "bg-sky-50 dark:bg-sky-950" },
                      { label: "Candles",        value: fmt(h?.candlesLoaded    || 0), cls: "text-teal-700 dark:text-teal-400",   bg: "bg-teal-50 dark:bg-teal-950" },
                      { label: "Preh. Cycles",   value: fmt(h?.cyclesCompleted  || 0), cls: "text-indigo-700 dark:text-indigo-400", bg: "bg-indigo-50 dark:bg-indigo-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg} text-center`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trading Activity — from /logs progressionState */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    <h3 className="font-semibold">Trading Activity</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total Trades",  value: fmt(tradingState?.totalTrades     || 0), cls: "text-slate-700 dark:text-slate-400",   bg: "bg-slate-50 dark:bg-slate-900" },
                      { label: "Profitable",    value: fmt(tradingState?.successfulTrades || 0), cls: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
                      { label: "Win Rate",      value: `${(tradingState?.tradeSuccessRate || 0).toFixed(1)}%`, cls: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950" },
                      { label: "Total Profit",  value: `$${(tradingState?.totalProfit || 0).toFixed(2)}`, cls: "text-cyan-700 dark:text-cyan-400", bg: "bg-cyan-50 dark:bg-cyan-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-muted-foreground text-center">
                  Refreshes every 2s &bull; {new Date().toLocaleTimeString()}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── Breakdown ── */}
          <TabsContent value="breakdown" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4">
                {/* Indications by type — from /stats breakdown.indications */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-violet-500" />
                    <h3 className="font-semibold">Indications by Type</h3>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Total: {fmt(bd?.indications.total || rt?.indicationsTotal || 0)}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {indTypes.map(({ label, value }) => (
                      <div key={label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{label}</span>
                          <span className="font-medium tabular-nums">{fmt(value)}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-violet-500 rounded-full transition-all"
                            style={{ width: `${Math.min(100, (value / totalIndByType) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Strategies by stage — from /stats breakdown.strategies
                    Base → Main → Real → Live is a CASCADE FILTER (eval → filter
                    → adjust). Each stage counts the SAME logical strategy as it
                    survives the previous filter. The header "Total" shows the
                    Real-stage output only (the canonical strategy count) —
                    never Base+Main+Real summed. */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    <h3 className="font-semibold">Strategies — Pipeline Stages</h3>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Final (Real): {fmt(bd?.strategies.total || rt?.strategiesTotal || 0)}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground -mt-1">
                    Cascade filter: Base → Main → Real → Live. Stages are NOT added together —
                    each value is the count of the SAME strategies that survived the previous filter.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center text-xs">
                    {[
                      { label: "Base", value: bd?.strategies.base || 0, eval: bd?.strategies.baseEvaluated || 0, cls: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
                      { label: "Main", value: bd?.strategies.main || 0, eval: bd?.strategies.mainEvaluated || 0, cls: "text-yellow-700 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-950" },
                      { label: "Real", value: bd?.strategies.real || 0, eval: bd?.strategies.realEvaluated || 0, cls: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
                      // Live = exchange-side tracked locally (no exchange-history fetch)
                      { label: "Live", value: bd?.strategies.live || 0, eval: 0,                                   cls: "text-amber-700 dark:text-amber-400",  bg: "bg-amber-50 dark:bg-amber-950" },
                    ].map(({ label, value, eval: evaluated, cls, bg }) => (
                      <div key={label} className={`rounded-lg ${bg} p-3`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{fmt(value)}</div>
                        <div className="text-muted-foreground">{label}</div>
                        {evaluated > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">{fmt(evaluated)} passed</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Processing completeness */}
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="text-sm font-semibold">Processing Status</div>
                  <div className="space-y-1.5 text-xs">
                    {[
                      { label: "Historic Data Loaded",  done: h?.isComplete },
                      { label: "Indications Running",    done: (rt?.indicationCycles || 0) > 0 },
                      { label: "Strategies Running",     done: (rt?.strategyCycles   || 0) > 0 },
                      { label: "Realtime Active",        done: rt?.isActive },
                    ].map(({ label, done }) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <Badge variant={done ? "default" : "secondary"} className="text-[10px] h-5 px-1.5">
                          {done ? "Yes" : "No"}
                        </Badge>
                      </div>
                    ))}
                  </div>

                  {(rt?.successRate || 0) > 0 && (
                    <div className="pt-2 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Cycle Success Rate</span>
                        <span className="font-medium">{(rt?.successRate || 0).toFixed(1)}%</span>
                      </div>
                      <Progress value={rt?.successRate || 0} className="h-1.5" />
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
