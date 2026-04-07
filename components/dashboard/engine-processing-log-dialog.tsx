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

interface ProcessingLogEntry {
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
    isActive: boolean
  }
  realtime: {
    intervalsProcessed: number
    indicationsGenerated: number
    strategiesEvaluated: number
    positionsCreated: number
    isActive: boolean
    lastCycleTime: number
  }
  performance: {
    avgCycleTimeMs: number
    successRatePercent: number
    cyclesPerMinute: number
    errorsLastHour: number
  }
}

export function EngineProcessingLogDialog({ connectionId }: { connectionId?: string }) {
  const { selectedConnectionId } = useExchange()
  const activeConnectionId = connectionId || selectedConnectionId || "default-bingx-001"
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<ProcessingLogEntry[]>([])
  const [stats, setStats] = useState<ProcessingStats | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: ProcessingLogEntry["type"], message: string, details?: any) => {
    setLogs(prev => [
      { timestamp: new Date().toISOString(), type, message, details },
      ...prev.slice(0, 499)
    ])
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const [monitorRes, connLogRes, engineRes] = await Promise.all([
        fetch('/api/system/monitoring', { cache: 'no-store' }),
        fetch(`/api/settings/connections/${activeConnectionId}/log`, { cache: 'no-store' }),
        fetch('/api/engine/verify', { cache: 'no-store' })
      ])

      const monitor = await monitorRes.json()
      const connLog = await connLogRes.json()
      const engine = await engineRes.json()

      const newStats: ProcessingStats = {
        prehistoric: {
          symbolsLoaded: connLog.summary?.prehistoricData?.symbolsProcessed || 0,
          symbolsTotal: 128,
          candlesProcessed: connLog.summary?.prehistoricData?.candlesProcessed || 0,
          cyclesCompleted: connLog.summary?.prehistoricData?.cyclesCompleted || 0,
          progressPercent: Math.min((connLog.summary?.prehistoricData?.symbolsProcessed || 0) / 128 * 100, 100),
          isActive: connLog.summary?.prehistoricData?.phaseActive || false
        },
        realtime: {
          intervalsProcessed: connLog.summary?.enginePerformance?.cyclesCompleted || 0,
          indicationsGenerated: Object.values(connLog.summary?.indicationsCounts || {}).reduce((a: number, b: number) => a + b, 0),
          strategiesEvaluated: Object.values(connLog.summary?.strategyCounts || {}).reduce((a: number, b: any) => a + (b?.evaluated || 0), 0),
          positionsCreated: connLog.summary?.enginePerformance?.totalTrades || 0,
          isActive: engine.components?.[0]?.phases?.realtime?.processing || false,
          lastCycleTime: connLog.summary?.enginePerformance?.cycleTimeMs || 0
        },
        performance: {
          avgCycleTimeMs: connLog.summary?.enginePerformance?.cycleTimeMs || 0,
          successRatePercent: connLog.summary?.enginePerformance?.cycleSuccessRate || 0,
          cyclesPerMinute: 60000 / Math.max(connLog.summary?.enginePerformance?.cycleTimeMs || 1000, 100),
          errorsLastHour: connLog.summary?.errors || 0
        }
      }

      setStats(newStats)

      if (newStats.prehistoric.isActive) {
        addLog("prehistoric", `Prehistoric loading: ${newStats.prehistoric.symbolsLoaded}/${newStats.prehistoric.symbolsTotal} symbols | ${newStats.prehistoric.candlesProcessed.toLocaleString()} candles`)
      }

      if (newStats.realtime.isActive) {
        addLog("realtime", `Realtime active | Cycle: ${newStats.realtime.lastCycleTime}ms | Indications: ${newStats.realtime.indicationsGenerated} | Strategies: ${newStats.realtime.strategiesEvaluated}`)
      }

    } catch (err) {
      addLog("error", "Failed to fetch engine stats", err)
    }
  }, [addLog])

  const startPolling = useCallback(() => {
    setIsPolling(true)
    addLog("info", "Engine processing log polling started")

    pollIntervalRef.current = setInterval(() => {
      fetchStats()
    }, 2000)

    fetchStats()
  }, [fetchStats, addLog])

  const stopPolling = useCallback(() => {
    setIsPolling(false)
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    addLog("info", "Engine processing log polling stopped")
  }, [addLog])

  useEffect(() => {
    if (open) {
      startPolling()
    } else {
      stopPolling()
    }

    return () => {
      stopPolling()
    }
  }, [open, startPolling, stopPolling])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const getLogBadge = (type: ProcessingLogEntry["type"]) => {
    switch (type) {
      case "prehistoric": return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-[10px]">PREHISTORIC</Badge>
      case "realtime": return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-[10px]">REALTIME</Badge>
      case "indication": return <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 text-[10px]">INDICATION</Badge>
      case "strategy": return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px]">STRATEGY</Badge>
      case "error": return <Badge variant="destructive" className="text-[10px]">ERROR</Badge>
      default: return <Badge variant="outline" className="text-[10px]">INFO</Badge>
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1 text-xs">
          <Activity className="w-3.5 h-3.5" />
          Engine Log
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-4xl max-h-[82vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Engine Processing Log
            </div>
            <div className="flex items-center gap-2">
              {isPolling ? (
                <Badge variant="default" className="bg-green-600">● LIVE</Badge>
              ) : (
                <Badge variant="outline">PAUSED</Badge>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid grid-cols-3">
            <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="prehistoric" className="text-xs">Prehistoric Data</TabsTrigger>
            <TabsTrigger value="logs" className="text-xs">Live Log</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            {stats && (
              <>
                {/* Prehistoric Progress */}
                <Card className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Database className="w-4 h-4 text-blue-500" />
                      Prehistoric Data Loading
                    </div>
                    <Badge variant={stats.prehistoric.isActive ? "default" : "outline"}>
                      {stats.prehistoric.isActive ? "ACTIVE" : "COMPLETED"}
                    </Badge>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Progress</span>
                      <span>{stats.prehistoric.symbolsLoaded} / {stats.prehistoric.symbolsTotal} symbols</span>
                    </div>
                    <Progress value={stats.prehistoric.progressPercent} className="h-2" />
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs mt-2">
                    <div className="bg-blue-50 rounded p-2">
                      <div className="font-semibold">{stats.prehistoric.cyclesCompleted}</div>
                      <div className="text-muted-foreground">Cycles</div>
                    </div>
                    <div className="bg-blue-50 rounded p-2">
                      <div className="font-semibold">{stats.prehistoric.candlesProcessed.toLocaleString()}</div>
                      <div className="text-muted-foreground">Candles</div>
                    </div>
                    <div className="bg-blue-50 rounded p-2">
                      <div className="font-semibold">{Math.round(stats.prehistoric.progressPercent)}%</div>
                      <div className="text-muted-foreground">Complete</div>
                    </div>
                  </div>
                </Card>

                {/* Realtime Processing */}
                <Card className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      <Activity className="w-4 h-4 text-green-500" />
                      Realtime Processing
                    </div>
                    <Badge variant={stats.realtime.isActive ? "default" : "outline"}>
                      {stats.realtime.isActive ? "RUNNING" : "IDLE"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-center text-xs mt-2">
                    <div className="bg-green-50 rounded p-2">
                      <div className="font-semibold">{stats.realtime.intervalsProcessed}</div>
                      <div className="text-muted-foreground">Intervals</div>
                    </div>
                    <div className="bg-green-50 rounded p-2">
                      <div className="font-semibold">{stats.realtime.indicationsGenerated}</div>
                      <div className="text-muted-foreground">Indications</div>
                    </div>
                    <div className="bg-green-50 rounded p-2">
                      <div className="font-semibold">{stats.realtime.strategiesEvaluated}</div>
                      <div className="text-muted-foreground">Strategies</div>
                    </div>
                    <div className="bg-green-50 rounded p-2">
                      <div className="font-semibold">{stats.realtime.positionsCreated}</div>
                      <div className="text-muted-foreground">Positions</div>
                    </div>
                  </div>
                </Card>

                {/* Performance */}
                <Card className="p-4 space-y-2">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <BarChart2 className="w-4 h-4 text-purple-500" />
                    Performance
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-purple-50 rounded p-2">
                      <div className="font-semibold">{stats.performance.avgCycleTimeMs}ms</div>
                      <div className="text-muted-foreground">Cycle Time</div>
                    </div>
                    <div className="bg-purple-50 rounded p-2">
                      <div className="font-semibold">{stats.performance.successRatePercent.toFixed(1)}%</div>
                      <div className="text-muted-foreground">Success Rate</div>
                    </div>
                    <div className="bg-purple-50 rounded p-2">
                      <div className="font-semibold">{stats.performance.cyclesPerMinute.toFixed(1)}</div>
                      <div className="text-muted-foreground">Cycles/min</div>
                    </div>
                    <div className="bg-purple-50 rounded p-2">
                      <div className="font-semibold">{stats.performance.errorsLastHour}</div>
                      <div className="text-muted-foreground">Errors</div>
                    </div>
                  </div>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="prehistoric" className="mt-4">
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Prehistoric data processing status will appear here when active. Detailed symbol loading progress, candle counts, and phase timings are logged in realtime.</p>
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="mt-4">
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-2">
                {logs.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Waiting for engine data...</p>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs p-2 bg-muted/30 rounded">
                      {getLogBadge(log.type)}
                      <span className="flex-1 font-mono text-[10px] text-muted-foreground">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex-1">{log.message}</span>
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <Separator />

        <div className="flex justify-between items-center">
          <div className="text-xs text-muted-foreground">
            Polling every 2 seconds • Maximum 500 log entries
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setLogs([])}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Clear Log
            </Button>

            {isPolling ? (
              <Button size="sm" variant="destructive" onClick={stopPolling}>
                <StopCircle className="w-3.5 h-3.5 mr-1" />
                Stop
              </Button>
            ) : (
              <Button size="sm" onClick={startPolling}>
                <Play className="w-3.5 h-3.5 mr-1" />
                Start
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
