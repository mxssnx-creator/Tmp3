"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Activity, BarChart2, Clock, Database, Play, RefreshCw, StopCircle, Zap } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string
  type: "prehistoric" | "realtime" | "indication" | "strategy" | "error" | "info"
  message: string
  details?: any
}

interface ProcessingStats {
  prehistoric: {
    symbolsLoaded: number
    symbolsTotal: number
    candlesProcessed: number
    cyclesCompleted: number
    progressPercent: number
    isLoaded: boolean
  }
  realtime: {
    indicationCycles: number
    strategyCycles: number
    indicationsTotal: number
    strategiesTotal: number
    positionsOpen: number
    isActive: boolean
    cycleTimeMs: number
    successRate: number
  }
  performance: {
    avgCycleTimeMs: number
    successRatePercent: number
    realtimeCycles: number
    hasErrors: boolean
  }
  byType: {
    indications: Record<string, number>
    strategies: { base: number; main: number; real: number }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function EngineProcessingLogDialog({ connectionId: propConnectionId }: { connectionId?: string }) {
  const { selectedConnectionId } = useExchange()
  const activeConnectionId = propConnectionId || selectedConnectionId || "default-bingx-001"

  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<ProcessingStats | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry["type"], message: string, details?: any) => {
    setLogs(prev => [
      { timestamp: new Date().toISOString(), type, message, details },
      ...prev.slice(0, 499),
    ])
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      // Two real endpoints: engine-stats for live cycle counts, progression/logs for state details
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/trading/engine-stats?connection_id=${activeConnectionId}`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${activeConnectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])

      if (!statsRes.ok && !logsRes.ok) {
        addLog("error", "Failed to fetch engine stats from both endpoints")
        return
      }

      const es = statsRes.ok ? await statsRes.json() : {}
      const pl = logsRes.ok  ? await logsRes.json()  : {}

      const pstate = pl.progressionState || {}
      const completeness = pstate.processingCompleteness || {}

      const symbolsProcessed = pstate.prehistoricSymbolsProcessedCount || 0
      const symbolsTotal     = Math.max(symbolsProcessed, pstate.prehistoricSymbolsTotal || 3)
      const candlesProcessed = pstate.prehistoricCandlesProcessed || 0
      const prehistoricDone  = completeness.prehistoricLoaded === true

      const indicationCycles = es.indicationCycleCount || 0
      const strategyCycles   = es.strategyCycleCount   || 0
      const cycleTimeMs      = pstate.cycleTimeMs || 0
      const successRate      = pstate.cycleSuccessRate || es.cycleSuccessRate || 0

      const newStats: ProcessingStats = {
        prehistoric: {
          symbolsLoaded:   symbolsProcessed,
          symbolsTotal,
          candlesProcessed,
          cyclesCompleted: pstate.prehistoricCyclesCompleted || 0,
          progressPercent: symbolsTotal > 0 ? Math.min(100, Math.round((symbolsProcessed / symbolsTotal) * 100)) : (prehistoricDone ? 100 : 0),
          isLoaded:        prehistoricDone,
        },
        realtime: {
          indicationCycles,
          strategyCycles,
          indicationsTotal: es.totalIndicationsCount || pstate.indicationsCount || 0,
          strategiesTotal:  es.totalStrategyCount    || pstate.strategiesCount   || 0,
          positionsOpen:    es.positionsCount || 0,
          isActive:         completeness.realtimeRunning === true || indicationCycles > 0,
          cycleTimeMs,
          successRate,
        },
        performance: {
          avgCycleTimeMs:     cycleTimeMs,
          successRatePercent: successRate,
          realtimeCycles:     pstate.realtimeCycleCount || 0,
          hasErrors:          completeness.hasErrors === true,
        },
        byType: {
          indications: {
            Direction: pstate.indicationEvaluatedDirection || 0,
            Move:      pstate.indicationEvaluatedMove      || 0,
            Active:    pstate.indicationEvaluatedActive    || 0,
            Optimal:   pstate.indicationEvaluatedOptimal   || 0,
          },
          strategies: {
            base: es.baseStrategyCount || pstate.setsBaseCount || 0,
            main: es.mainStrategyCount || pstate.setsMainCount || 0,
            real: es.realStrategyCount || pstate.setsRealCount || 0,
          },
        },
      }

      setStats(newStats)

      // Emit a summary log entry so the "Live Log" tab shows activity
      if (newStats.prehistoric.isLoaded && newStats.realtime.isActive) {
        addLog("realtime",
          `Cycle ${indicationCycles} | Indications: ${newStats.realtime.indicationsTotal} | ` +
          `Strategies: ${newStats.realtime.strategiesTotal} | Positions: ${newStats.realtime.positionsOpen} | ` +
          `${successRate.toFixed(1)}% success`)
      } else if (!newStats.prehistoric.isLoaded && symbolsProcessed > 0) {
        addLog("prehistoric",
          `Historical data: ${symbolsProcessed}/${symbolsTotal} symbols | ${candlesProcessed.toLocaleString()} candles`)
      } else if (newStats.prehistoric.isLoaded && !newStats.realtime.isActive) {
        addLog("info", "Historical data loaded — awaiting first realtime cycle")
      }

    } catch (err) {
      addLog("error", "Failed to fetch engine stats", { error: String(err) })
    }
  }, [activeConnectionId, addLog])

  const startPolling = useCallback(() => {
    setIsPolling(true)
    addLog("info", `Started monitoring: ${activeConnectionId}`)
    fetchStats()
    pollIntervalRef.current = setInterval(fetchStats, 2000)
  }, [fetchStats, addLog, activeConnectionId])

  const stopPolling = useCallback(() => {
    setIsPolling(false)
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    addLog("info", "Monitoring paused")
  }, [addLog])

  useEffect(() => {
    if (open) {
      startPolling()
    } else {
      stopPolling()
    }
    return () => stopPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Re-start polling when connection changes while open
  useEffect(() => {
    if (!open) return
    stopPolling()
    startPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  const getLogBadge = (type: LogEntry["type"]) => {
    const map: Record<string, string> = {
      prehistoric: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400",
      realtime:    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400",
      indication:  "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-400",
      strategy:    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400",
      error:       "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400",
      info:        "bg-muted text-muted-foreground",
    }
    return (
      <Badge variant="outline" className={`text-[10px] px-1.5 h-4 shrink-0 ${map[type] || map.info}`}>
        {type.toUpperCase()}
      </Badge>
    )
  }

  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1.5 text-xs">
          <Activity className="w-3.5 h-3.5" />
          Engine Log
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Engine Processing Log
              <span className="text-sm font-normal text-muted-foreground">{activeConnectionId}</span>
            </div>
            <Badge variant={isPolling ? "default" : "outline"} className={isPolling ? "bg-green-600" : ""}>
              {isPolling ? "● LIVE" : "PAUSED"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid grid-cols-4 shrink-0">
            <TabsTrigger value="overview"   className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="prehistoric" className="text-xs">Prehistoric</TabsTrigger>
            <TabsTrigger value="breakdown"  className="text-xs">Breakdown</TabsTrigger>
            <TabsTrigger value="logs"       className="text-xs">Live Log</TabsTrigger>
          </TabsList>

          {/* ── Overview ── */}
          <TabsContent value="overview" className="mt-3 space-y-3 overflow-y-auto flex-1">
            {stats ? (
              <>
                {/* Prehistoric */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Database className="w-4 h-4 text-blue-500" />
                      Prehistoric Data Loading
                    </div>
                    <Badge variant={stats.prehistoric.isLoaded ? "default" : "secondary"}>
                      {stats.prehistoric.isLoaded ? "LOADED" : "LOADING"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Symbols: {stats.prehistoric.symbolsLoaded}/{stats.prehistoric.symbolsTotal}</span>
                      <span>{stats.prehistoric.progressPercent}%</span>
                    </div>
                    <Progress value={stats.prehistoric.progressPercent} className="h-2" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.prehistoric.cyclesCompleted)}</div>
                      <div className="text-muted-foreground">Cycles</div>
                    </div>
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.prehistoric.candlesProcessed)}</div>
                      <div className="text-muted-foreground">Candles</div>
                    </div>
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <div className="font-semibold">{stats.prehistoric.symbolsLoaded}</div>
                      <div className="text-muted-foreground">Symbols</div>
                    </div>
                  </div>
                </Card>

                {/* Realtime */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Activity className="w-4 h-4 text-green-500" />
                      Realtime Processing
                    </div>
                    <Badge variant={stats.realtime.isActive ? "default" : "secondary"}>
                      {stats.realtime.isActive ? "RUNNING" : "IDLE"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.realtime.indicationCycles)}</div>
                      <div className="text-muted-foreground">Ind. Cycles</div>
                    </div>
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.realtime.indicationsTotal)}</div>
                      <div className="text-muted-foreground">Indications</div>
                    </div>
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.realtime.strategiesTotal)}</div>
                      <div className="text-muted-foreground">Strategies</div>
                    </div>
                    <div className="bg-green-50 dark:bg-green-950/30 rounded p-2">
                      <div className="font-semibold">{stats.realtime.positionsOpen}</div>
                      <div className="text-muted-foreground">Positions</div>
                    </div>
                  </div>
                </Card>

                {/* Performance */}
                <Card className="p-4 space-y-2.5">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <BarChart2 className="w-4 h-4 text-violet-500" />
                    Performance
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{stats.performance.avgCycleTimeMs}ms</div>
                      <div className="text-muted-foreground">Cycle Time</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{stats.performance.successRatePercent.toFixed(1)}%</div>
                      <div className="text-muted-foreground">Success Rate</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className="font-semibold">{fmt(stats.realtime.strategyCycles)}</div>
                      <div className="text-muted-foreground">Strat. Cycles</div>
                    </div>
                    <div className="bg-violet-50 dark:bg-violet-950/30 rounded p-2">
                      <div className={`font-semibold ${stats.performance.hasErrors ? "text-red-600" : "text-green-600"}`}>
                        {stats.performance.hasErrors ? "Yes" : "None"}
                      </div>
                      <div className="text-muted-foreground">Errors</div>
                    </div>
                  </div>
                </Card>
              </>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-12">Starting engine monitor...</p>
            )}
          </TabsContent>

          {/* ── Prehistoric detail ── */}
          <TabsContent value="prehistoric" className="mt-3 flex-1 overflow-y-auto">
            <Card className="p-4 space-y-3">
              {stats ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Database className="w-4 h-4 text-blue-500" />
                      Detailed Prehistoric Status
                    </div>
                    <Badge variant={stats.prehistoric.isLoaded ? "default" : "secondary"}>
                      {stats.prehistoric.isLoaded ? "COMPLETE" : "IN PROGRESS"}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm">
                      <span>Overall Progress</span>
                      <span className="font-medium">{stats.prehistoric.progressPercent}%</span>
                    </div>
                    <Progress value={stats.prehistoric.progressPercent} className="h-2.5" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
                    {[
                      { label: "Symbols Processed", value: `${stats.prehistoric.symbolsLoaded} / ${stats.prehistoric.symbolsTotal}` },
                      { label: "Candles Loaded",    value: stats.prehistoric.candlesProcessed.toLocaleString() },
                      { label: "Prehistoric Cycles", value: stats.prehistoric.cyclesCompleted.toLocaleString() },
                      { label: "Status",             value: stats.prehistoric.isLoaded ? "Complete" : "Loading..." },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between border-b border-border/50 pb-1.5">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium">{value}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-center text-sm text-muted-foreground py-8">Waiting for prehistoric data...</p>
              )}
            </Card>
          </TabsContent>

          {/* ── Breakdown ── */}
          <TabsContent value="breakdown" className="mt-3 space-y-3 flex-1 overflow-y-auto">
            {stats ? (
              <>
                <Card className="p-4 space-y-2">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Activity className="w-4 h-4 text-violet-500" />
                    Indications by Type
                  </div>
                  <div className="space-y-2 text-xs">
                    {Object.entries(stats.byType.indications).map(([type, count]) => {
                      const total = Object.values(stats.byType.indications).reduce((s, v) => s + v, 0) || 1
                      return (
                        <div key={type} className="space-y-0.5">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{type}</span>
                            <span className="font-medium tabular-nums">{fmt(count)}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-violet-500 rounded-full"
                              style={{ width: `${Math.min(100, (count / total) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </Card>

                <Card className="p-4 space-y-2">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-500" />
                    Strategies by Stage
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    {Object.entries(stats.byType.strategies).map(([stage, count]) => (
                      <div key={stage} className="rounded bg-amber-50 dark:bg-amber-950/30 p-2.5">
                        <div className="text-lg font-bold tabular-nums">{fmt(count)}</div>
                        <div className="text-muted-foreground capitalize">{stage}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              </>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-12">Waiting for data...</p>
            )}
          </TabsContent>

          {/* ── Live Log ── */}
          <TabsContent value="logs" className="mt-3 flex-1 flex flex-col min-h-0">
            <ScrollArea className="flex-1 border rounded-md p-2">
              {logs.length === 0 ? (
                <p className="text-center text-sm text-muted-foreground py-8">Waiting for engine data...</p>
              ) : (
                <div className="space-y-1">
                  {logs.map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs p-1.5 rounded hover:bg-muted/30">
                      {getLogBadge(log.type)}
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex-1 text-foreground break-words">{log.message}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <Separator className="shrink-0 mt-2" />

        <div className="flex items-center justify-between shrink-0 pt-1">
          <p className="text-xs text-muted-foreground">
            Polling every 2s &bull; Max 500 entries &bull; {activeConnectionId}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setLogs([])}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Clear
            </Button>
            {isPolling ? (
              <Button size="sm" variant="destructive" onClick={stopPolling}>
                <StopCircle className="w-3.5 h-3.5 mr-1" />
                Pause
              </Button>
            ) : (
              <Button size="sm" onClick={startPolling}>
                <Play className="w-3.5 h-3.5 mr-1" />
                Resume
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
