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

interface ProgressionState {
  // Cycle counts — from /logs endpoint (progressionState) AND /[id] endpoint (metrics)
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  realtimeCycleCount: number
  indicationCycleCount: number   // from /[id] metrics
  strategyCycleCount: number     // from /[id] metrics
  // Trading
  totalTrades: number
  successfulTrades: number
  tradeSuccessRate: number
  totalProfit: number
  // Processing
  indicationsCount: number
  strategiesCount: number
  // Prehistoric
  prehistoricCyclesCompleted: number
  prehistoricSymbolsProcessed: number
  prehistoricCandlesProcessed: number
  // By type — indications
  indicationEvaluatedDirection: number
  indicationEvaluatedMove: number
  indicationEvaluatedActive: number
  indicationEvaluatedOptimal: number
  // By stage — strategies
  setsBaseCount: number
  setsMainCount: number
  setsRealCount: number
  // Processing status flags
  processingCompleteness: {
    prehistoricLoaded: boolean
    indicationsRunning: boolean
    strategiesRunning: boolean
    realtimeRunning: boolean
    hasErrors: boolean
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
  const [progressionState, setProgressionState] = useState<Partial<ProgressionState> | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<"log" | "info" | "breakdown">("log")

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      // Fetch both endpoints in parallel:
      // - /logs  → progressionState (cycle counts, type breakdowns, prehistoric)
      // - /[id]  → metrics (indicationCycleCount, strategyCycleCount, current phase)
      const [logsRes, progressionRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}?t=${Date.now()}`, { cache: "no-store" }),
      ])

      let logsData: any = {}
      let progData: any = {}

      if (logsRes.ok) logsData = await logsRes.json()
      if (progressionRes.ok) progData = await progressionRes.json()

      // Merge logs from both sources
      const logsArr: ProgressionLog[] = (
        logsData.logs || logsData.recentLogs || progData.recentLogs || []
      ).slice(0, 150)
      setLogs(logsArr)

      // Merge state from both sources — /[id] metrics take priority for live cycle counts
      const ps  = logsData.progressionState || {}
      const pm  = progData.metrics          || {}
      const pst = progData.state            || {}

      setProgressionState({
        // Cycle counts — prefer live metrics from /[id] (more current than /logs)
        cyclesCompleted:     pm.indicationCycleCount || parseInt(ps.cyclesCompleted    || "0"),
        successfulCycles:    pm.strategyCycleCount   || parseInt(ps.successfulCycles   || "0"),
        failedCycles:                                   parseInt(ps.failedCycles        || "0"),
        cycleSuccessRate:    parseFloat(String(pm.cycleSuccessRate    || ps.cycleSuccessRate    || "0")),
        realtimeCycleCount:  pm.realtimeCycleCount   || parseInt(ps.realtimeCycleCount  || "0"),
        indicationCycleCount: pm.indicationCycleCount || 0,
        strategyCycleCount:   pm.strategyCycleCount   || 0,
        // Trading
        totalTrades:       pst.totalTrades       || parseInt(ps.totalTrades       || "0"),
        successfulTrades:  pst.successfulTrades  || parseInt(ps.successfulTrades  || "0"),
        tradeSuccessRate:  parseFloat(String(pst.tradeSuccessRate  || ps.tradeSuccessRate  || "0")),
        totalProfit:       parseFloat(String(pst.totalProfit       || ps.totalProfit       || "0")),
        // Processing
        indicationsCount: pm.totalIndicationsEvaluated || parseInt(ps.indicationsCount || "0"),
        strategiesCount:  pm.totalStrategiesEvaluated  || parseInt(ps.strategiesCount  || "0"),
        // Prehistoric
        prehistoricCyclesCompleted: pst.prehistoricCyclesCompleted || parseInt(ps.prehistoricCyclesCompleted || "0"),
        prehistoricSymbolsProcessed: pm.prehistoricSymbolsProcessed || parseInt(ps.prehistoricSymbolsProcessedCount || ps.prehistoricSymbolsProcessed || "0"),
        prehistoricCandlesProcessed: pm.prehistoricCandlesProcessed || parseInt(ps.prehistoricCandlesProcessed || "0"),
        // Indication types
        indicationEvaluatedDirection: parseInt(ps.indicationEvaluatedDirection || "0"),
        indicationEvaluatedMove:      parseInt(ps.indicationEvaluatedMove      || "0"),
        indicationEvaluatedActive:    parseInt(ps.indicationEvaluatedActive    || "0"),
        indicationEvaluatedOptimal:   parseInt(ps.indicationEvaluatedOptimal   || "0"),
        // Strategy stages
        setsBaseCount: parseInt(ps.setsBaseCount || ps.strategyEvaluatedBase || "0"),
        setsMainCount: parseInt(ps.setsMainCount || ps.strategyEvaluatedMain || "0"),
        setsRealCount: parseInt(ps.setsRealCount || ps.strategyEvaluatedReal || "0"),
        // Completeness
        processingCompleteness: ps.processingCompleteness || {
          prehistoricLoaded:  false,
          indicationsRunning: (pm.indicationCycleCount || 0) > 0,
          strategiesRunning:  (pm.strategyCycleCount   || 0) > 0,
          realtimeRunning:    (pm.realtimeCycleCount   || 0) > 0,
          hasErrors:          false,
        },
      })
    } catch (error) {
      console.error("[v0] Failed to load progression data:", error)
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

  const ps = progressionState

  const indTypes = [
    { label: "Direction", value: ps?.indicationEvaluatedDirection || 0 },
    { label: "Move",      value: ps?.indicationEvaluatedMove      || 0 },
    { label: "Active",    value: ps?.indicationEvaluatedActive    || 0 },
    { label: "Optimal",   value: ps?.indicationEvaluatedOptimal   || 0 },
  ]
  const totalIndByType = indTypes.reduce((s, r) => s + r.value, 0) || 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[82vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            {connectionName} — Engine Progression
            {(ps?.indicationCycleCount || 0) > 0 && (
              <Badge variant="default" className="bg-green-600 text-[11px]">
                ● {fmt(ps?.indicationCycleCount || 0)} cycles
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
            <div className="flex items-center justify-between px-4 py-2.5 border-b">
              <span className="text-sm text-muted-foreground">
                {logs.length} entries {isLoading && "(updating...)"}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="outline" size="sm" onClick={handleClearLogs} disabled={logs.length === 0}>
                  <Trash2 className="w-3.5 h-3.5" />
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
                  {logs.map((log, idx) => (
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
                {/* Cycles */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    <h3 className="font-semibold">Engine Cycles</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Indication Cycles", value: fmt(ps?.indicationCycleCount || ps?.cyclesCompleted || 0), cls: "text-blue-700 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950" },
                      { label: "Strategy Cycles",   value: fmt(ps?.strategyCycleCount   || ps?.successfulCycles  || 0), cls: "text-green-700 dark:text-green-400", bg: "bg-green-50 dark:bg-green-950" },
                      { label: "Realtime Cycles",   value: fmt(ps?.realtimeCycleCount   || 0),                         cls: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
                      { label: "Success Rate",      value: `${(ps?.cycleSuccessRate || 0).toFixed(1)}%`,               cls: "text-amber-700 dark:text-amber-400",  bg: "bg-amber-50 dark:bg-amber-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Prehistoric */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    <h3 className="font-semibold">Historical Data</h3>
                    <Badge
                      variant={ps?.processingCompleteness?.prehistoricLoaded ? "default" : "secondary"}
                      className="ml-auto text-[11px]"
                    >
                      {ps?.processingCompleteness?.prehistoricLoaded ? "Loaded" : "Pending"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Symbols",         value: fmt(ps?.prehistoricSymbolsProcessed || 0), cls: "text-sky-700 dark:text-sky-400", bg: "bg-sky-50 dark:bg-sky-950" },
                      { label: "Candles Loaded",  value: fmt(ps?.prehistoricCandlesProcessed  || 0), cls: "text-teal-700 dark:text-teal-400", bg: "bg-teal-50 dark:bg-teal-950" },
                      { label: "Preh. Cycles",    value: fmt(ps?.prehistoricCyclesCompleted   || 0), cls: "text-indigo-700 dark:text-indigo-400", bg: "bg-indigo-50 dark:bg-indigo-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg} text-center`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
                        <div className="text-xs text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trading Activity */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    <h3 className="font-semibold">Trading Activity</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total Trades",     value: fmt(ps?.totalTrades     || 0), cls: "text-slate-700 dark:text-slate-400",   bg: "bg-slate-50 dark:bg-slate-900" },
                      { label: "Profitable",        value: fmt(ps?.successfulTrades || 0), cls: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
                      { label: "Win Rate",          value: `${(ps?.tradeSuccessRate || 0).toFixed(1)}%`, cls: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950" },
                      { label: "Total Profit",      value: `$${(ps?.totalProfit || 0).toFixed(2)}`, cls: "text-cyan-700 dark:text-cyan-400", bg: "bg-cyan-50 dark:bg-cyan-950" },
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
                {/* Indications by type */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-violet-500" />
                    <h3 className="font-semibold">Indications by Type</h3>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Total: {fmt(ps?.indicationsCount || 0)}
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

                {/* Strategies by stage */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    <h3 className="font-semibold">Strategies by Stage</h3>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Total: {fmt((ps?.setsBaseCount || 0) + (ps?.setsMainCount || 0) + (ps?.setsRealCount || 0))}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center text-xs">
                    {[
                      { label: "Base",  value: ps?.setsBaseCount || 0, cls: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
                      { label: "Main",  value: ps?.setsMainCount || 0, cls: "text-amber-700 dark:text-amber-400",  bg: "bg-amber-50 dark:bg-amber-950" },
                      { label: "Real",  value: ps?.setsRealCount || 0, cls: "text-yellow-700 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-950" },
                    ].map(({ label, value, cls, bg }) => (
                      <div key={label} className={`p-3 rounded-lg ${bg}`}>
                        <div className={`text-xl font-bold tabular-nums ${cls}`}>{fmt(value)}</div>
                        <div className="text-muted-foreground mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Processing flags */}
                <div className="rounded-lg border p-4 space-y-2">
                  <h3 className="font-semibold text-sm">Processing Status</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                    {[
                      { label: "Historical Data", flag: ps?.processingCompleteness?.prehistoricLoaded },
                      { label: "Indications",     flag: ps?.processingCompleteness?.indicationsRunning },
                      { label: "Strategies",      flag: ps?.processingCompleteness?.strategiesRunning },
                      { label: "Realtime",        flag: ps?.processingCompleteness?.realtimeRunning },
                    ].map(({ label, flag }) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <Badge variant={flag ? "default" : "secondary"} className="text-[10px] h-5">
                          {flag ? "Active" : "Pending"}
                        </Badge>
                      </div>
                    ))}
                  </div>

                  {/* Success rate bar */}
                  <div className="pt-2 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Cycle Success Rate</span>
                      <span className="font-medium">{(ps?.cycleSuccessRate || 0).toFixed(1)}%</span>
                    </div>
                    <Progress value={ps?.cycleSuccessRate || 0} className="h-1.5" />
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
