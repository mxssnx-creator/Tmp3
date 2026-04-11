"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { FileText, Activity, BarChart3, RefreshCw, Database, Zap, TrendingUp } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface StatsResponse {
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
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string; lastUpdate: string }
}

interface LogEntry {
  timestamp: Date
  level: "info" | "success" | "warning" | "error"
  message: string
  phase?: string
}

// ─── component ────────────────────────────────────────────────────────────────

export function QuickstartComprehensiveLogDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const activeConnectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || activeConnectionId

  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    if (!activeConnectionId) return
    setIsLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${activeConnectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${activeConnectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (statsRes.ok) {
        setStats(await statsRes.json())
      }

      if (logsRes.ok) {
        const data = await logsRes.json()
        const rawLogs = data.logs || data.recentLogs || []
        const mapped: LogEntry[] = rawLogs.slice(0, 150).map((log: any) => ({
          timestamp: new Date(log.timestamp || Date.now()),
          level: (log.level === "error" ? "error" : log.level === "warning" ? "warning" : "info") as LogEntry["level"],
          message: log.message || "",
          phase: log.phase || "",
        }))
        setLogs(mapped)
      }
    } catch {
      // non-critical
    } finally {
      setIsLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // Poll when dialog is open; re-run whenever the selected connection changes
  useEffect(() => {
    if (!open) return
    fetchData()
    const interval = setInterval(fetchData, 2000)
    return () => clearInterval(interval)
  }, [open, fetchData])

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(1)}K`
    : String(n)

  const levelCls = (level: string) => {
    switch (level) {
      case "error":   return "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950"
      case "warning": return "text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950"
      case "success": return "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950"
      default:        return "text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-950"
    }
  }

  const rt  = stats?.realtime
  const h   = stats?.historic
  const bd  = stats?.breakdown
  const meta = stats?.metadata

  const indTypes = [
    { label: "Direction", key: "direction" as const },
    { label: "Move",      key: "move"      as const },
    { label: "Active",    key: "active"    as const },
    { label: "Optimal",   key: "optimal"   as const },
    { label: "Auto",      key: "auto"      as const },
  ]
  const totalIndByType = (bd?.indications.total || 0) || 1

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <FileText className="w-4 h-4" />
          Logs & Data
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Engine Data & Logs
            {connectionLabel && (
              <Badge variant="secondary" className="text-xs font-normal">
                {connectionLabel}
              </Badge>
            )}
            {meta?.engineRunning && (
              <Badge className="bg-green-600 text-[10px]">Running</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="overall" className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="overall" className="gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="breakdown" className="gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              Breakdown
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              Logs
            </TabsTrigger>
          </TabsList>

          {/* ── Overview Tab ── */}
          <TabsContent value="overall" className="flex-1 overflow-y-auto space-y-3 pt-1">
            {!stats ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                Loading data for {connectionLabel}...
              </div>
            ) : (
              <>
                {/* Phase / Status */}
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-sm">Engine Status</h3>
                    <div className="flex gap-1.5">
                      <Badge variant={meta?.engineRunning ? "default" : "secondary"} className="text-[10px]">
                        {meta?.engineRunning ? "Running" : "Stopped"}
                      </Badge>
                      {meta?.phase && (
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {meta.phase.replace(/_/g, " ")}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {meta?.progress !== undefined && (
                    <div className="space-y-1">
                      <Progress value={meta.progress} className="h-1.5" />
                      {meta?.message && (
                        <p className="text-[11px] text-muted-foreground">{meta.message}</p>
                      )}
                    </div>
                  )}
                </Card>

                {/* Historic */}
                <Card className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Database className="w-4 h-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Historical Data</h3>
                    {h?.isComplete && (
                      <Badge className="bg-green-600 text-[10px]">Complete</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Symbols",  value: h?.symbolsProcessed ?? 0 },
                      { label: "Candles",  value: h?.candlesLoaded     ?? 0 },
                      { label: "H-Cycles", value: h?.cyclesCompleted   ?? 0 },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-muted rounded p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className="text-lg font-bold tabular-nums">{fmt(value)}</p>
                      </div>
                    ))}
                  </div>
                  {h?.progressPercent !== undefined && !h.isComplete && (
                    <div className="mt-2 space-y-1">
                      <Progress value={h.progressPercent} className="h-1" />
                      <p className="text-[10px] text-muted-foreground text-right">{h.progressPercent.toFixed(0)}%</p>
                    </div>
                  )}
                </Card>

                {/* Realtime */}
                <Card className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-4 h-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Live Processing</h3>
                    {rt?.isActive && (
                      <Badge className="bg-blue-600 text-[10px]">Active</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: "Ind. Cycles",  value: rt?.indicationCycles ?? 0, color: "text-blue-600" },
                      { label: "Indications",  value: rt?.indicationsTotal  ?? 0, color: "text-purple-600" },
                      { label: "Strategies",   value: rt?.strategiesTotal   ?? 0, color: "text-orange-600" },
                      { label: "Positions",    value: rt?.positionsOpen     ?? 0, color: "text-green-600" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-muted rounded p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className={`text-xl font-bold tabular-nums ${color}`}>{fmt(value)}</p>
                      </div>
                    ))}
                  </div>
                  {(rt?.avgCycleTimeMs ?? 0) > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      Avg cycle: {rt!.avgCycleTimeMs.toFixed(0)}ms
                      {(rt?.successRate ?? 0) > 0 && ` · Success rate: ${(rt!.successRate * 100).toFixed(0)}%`}
                    </p>
                  )}
                </Card>
              </>
            )}
          </TabsContent>

          {/* ── Breakdown Tab ── */}
          <TabsContent value="breakdown" className="flex-1 overflow-y-auto space-y-3 pt-1">
            {!stats ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                Loading breakdown for {connectionLabel}...
              </div>
            ) : (
              <>
                {/* Indications by type */}
                <Card className="p-4">
                  <h3 className="font-semibold text-sm mb-3">Indications by Type</h3>
                  <div className="space-y-2">
                    {indTypes.map(({ label, key }) => {
                      const val = bd?.indications[key] ?? 0
                      const pct = Math.round((val / totalIndByType) * 100)
                      return (
                        <div key={key} className="space-y-0.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-semibold tabular-nums">{fmt(val)} ({pct}%)</span>
                          </div>
                          <Progress value={pct} className="h-1" />
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2 text-right">
                    Total: {fmt(bd?.indications.total ?? 0)}
                  </p>
                </Card>

                {/* Strategies by type */}
                <Card className="p-4">
                  <h3 className="font-semibold text-sm mb-3">Strategies by Level</h3>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    {[
                      { label: "Base",  value: bd?.strategies.base ?? 0, evaluated: bd?.strategies.baseEvaluated ?? 0 },
                      { label: "Main",  value: bd?.strategies.main ?? 0, evaluated: bd?.strategies.mainEvaluated ?? 0 },
                      { label: "Real",  value: bd?.strategies.real ?? 0, evaluated: bd?.strategies.realEvaluated ?? 0 },
                    ].map(({ label, value, evaluated }) => (
                      <div key={label} className="bg-muted rounded p-2.5">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className="text-lg font-bold tabular-nums">{fmt(value)}</p>
                        {evaluated > 0 && (
                          <p className="text-[9px] text-muted-foreground">eval: {fmt(evaluated)}</p>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground text-right">
                    Total: {fmt(bd?.strategies.total ?? 0)}
                    {(bd?.strategies.live ?? 0) > 0 && ` · Live: ${fmt(bd!.strategies.live)}`}
                  </p>
                </Card>
              </>
            )}
          </TabsContent>

          {/* ── Logs Tab ── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 pt-1">
            <div className="flex items-center justify-between pb-2">
              <span className="text-xs text-muted-foreground">
                {logs.length} entries {isLoading && "· updating..."}
              </span>
              <Button size="sm" variant="outline" onClick={fetchData} disabled={isLoading} className="gap-1.5 h-7 text-xs">
                <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            <ScrollArea className="flex-1 border rounded-md">
              {logs.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  No logs yet for {connectionLabel}
                </div>
              ) : (
                <div className="space-y-px p-2">
                  {logs.map((log, idx) => (
                    <div key={idx} className={`text-[11px] px-2 py-1.5 rounded font-mono ${levelCls(log.level)}`}>
                      <span className="opacity-60 mr-2">{log.timestamp.toLocaleTimeString()}</span>
                      {log.phase && <span className="mr-2 opacity-70">[{log.phase}]</span>}
                      <span>{log.message}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
