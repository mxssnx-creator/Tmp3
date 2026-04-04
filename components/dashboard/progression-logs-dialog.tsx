"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Loader2, Zap, TrendingUp, Clock, AlertCircle, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "@/lib/simple-toast"

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
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  successfulTrades: number
  tradeSuccessRate: number
  totalProfit: number
  indicationsCount: number
  strategiesCount: number
  totalStrategiesEvaluated: number
  realtimeCycleCount: number
  prehistoricCyclesCompleted: number
}

export function ProgressionLogsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
}: ProgressionLogsDialogProps) {
  const [logs, setLogs] = useState<ProgressionLog[]>([])
  const [progressionState, setProgressionState] = useState<Partial<ProgressionState> | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<"log" | "info">("log")

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/connections/progression/${connectionId}?t=${Date.now()}`, {
        cache: "no-store",
      })
      if (response.ok) {
        const data = await response.json()
        
        // Extract and set logs
        const logsArray = (data.logs || data.recentLogs || []).slice(0, 100)
        setLogs(logsArray)
        
        // Extract progression state with proper field mapping
        const progState = data.progressionState || {}
        setProgressionState({
          cyclesCompleted: parseInt(progState.cyclesCompleted || progState.cycles_completed || "0"),
          successfulCycles: parseInt(progState.successfulCycles || progState.successful_cycles || "0"),
          failedCycles: parseInt(progState.failedCycles || progState.failed_cycles || "0"),
          cycleSuccessRate: parseFloat(progState.cycleSuccessRate || progState.cycle_success_rate || "0"),
          totalTrades: parseInt(progState.totalTrades || progState.total_trades || "0"),
          successfulTrades: parseInt(progState.successfulTrades || progState.successful_trades || "0"),
          tradeSuccessRate: parseFloat(progState.tradeSuccessRate || progState.trade_success_rate || "0"),
          totalProfit: parseFloat(progState.totalProfit || progState.total_profit || "0"),
          indicationsCount: parseInt(progState.indicationsCount || progState.indications_count || "0"),
          strategiesCount: parseInt(progState.strategiesCount || progState.strategies_count || "0"),
          totalStrategiesEvaluated: parseInt(progState.totalStrategiesEvaluated || "0"),
          realtimeCycleCount: parseInt(progState.realtimeCycleCount || progState.realtime_cycle_count || "0"),
          prehistoricCyclesCompleted: parseInt(progState.prehistoricCyclesCompleted || progState.prehistoric_cycles_completed || "0"),
        })
      }
    } catch (error) {
      console.error("[v0] Failed to load progression data:", error)
    } finally {
      setIsLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (open) {
      loadData()
      // Auto-refresh every 2 seconds while dialog is open
      const interval = setInterval(loadData, 2000)
      return () => clearInterval(interval)
    }
  }, [open, loadData])

  const handleClearLogs = async () => {
    if (!confirm("Clear all logs for this connection?")) return
    try {
      const response = await fetch(`/api/connections/progression/${connectionId}/logs`, {
        method: "DELETE",
      })
      if (response.ok) {
        setLogs([])
        toast.success("Logs cleared")
      } else {
        toast.error("Failed to clear logs")
      }
    } catch (error) {
      console.error("[v0] Failed to clear logs:", error)
      toast.error("Failed to clear logs")
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M"
    if (num >= 1000) return (num / 1000).toFixed(1) + "K"
    return num.toString()
  }

  const getLevelColor = (level: string) => {
    switch (level?.toLowerCase()) {
      case "error": return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400"
      case "warning": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-400"
      case "debug": return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400"
      default: return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-400"
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            {connectionName} - Engine Progression
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "log" | "info")} className="flex-1 flex flex-col min-h-0">
          {/* Tab Menu */}
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="log">Logs</TabsTrigger>
            <TabsTrigger value="info">Info</TabsTrigger>
          </TabsList>

          {/* Logs Tab */}
          <TabsContent value="log" className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="text-sm text-muted-foreground">
                {logs.length} log entries {isLoading && "(updating...)"}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadData}
                  disabled={isLoading}
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearLogs}
                  disabled={logs.length === 0}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            <ScrollArea className="flex-1">
              {isLoading && logs.length === 0 ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : logs.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-muted-foreground">
                  <AlertCircle className="w-5 h-5 mr-2" />
                  No logs yet. Enable connection to start logging.
                </div>
              ) : (
                <div className="space-y-1 p-3">
                  {logs.map((log, idx) => (
                    <div key={idx} className="grid grid-cols-[auto_auto_auto_1fr] gap-2 text-xs p-2 rounded hover:bg-muted/50">
                      <span className="text-muted-foreground min-w-fit whitespace-nowrap">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      <Badge className={getLevelColor(log.level)} variant="outline">
                        {log.level.toUpperCase()}
                      </Badge>
                      <Badge variant="outline" className="min-w-fit">
                        {log.phase}
                      </Badge>
                      <span className="break-words">{log.message}</span>
                      {log.details && (
                        <div className="col-span-4 mt-1 p-2 rounded bg-muted/30 font-mono text-[10px]">
                          <pre className="overflow-auto max-h-20">{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Info Tab */}
          <TabsContent value="info" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-4 p-4">
                {/* Cycles Section */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    <h3 className="font-semibold">Engine Cycles</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950">
                      <div className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                        {formatNumber(progressionState?.cyclesCompleted || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Total Cycles</div>
                    </div>
                    <div className="p-3 rounded-lg bg-green-50 dark:bg-green-950">
                      <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                        {formatNumber(progressionState?.successfulCycles || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Successful</div>
                    </div>
                    <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950">
                      <div className="text-2xl font-bold text-red-700 dark:text-red-400">
                        {formatNumber(progressionState?.failedCycles || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Failed</div>
                    </div>
                    <div className="p-3 rounded-lg bg-purple-50 dark:bg-purple-950">
                      <div className="text-2xl font-bold text-purple-700 dark:text-purple-400">
                        {(progressionState?.cycleSuccessRate || 0).toFixed(1)}%
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Success Rate</div>
                    </div>
                  </div>
                </div>

                {/* Trading Activity Section */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    <h3 className="font-semibold">Trading Activity</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
                      <div className="text-2xl font-bold">
                        {formatNumber(progressionState?.totalTrades || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Total Trades</div>
                    </div>
                    <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950">
                      <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                        {formatNumber(progressionState?.successfulTrades || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Profitable</div>
                    </div>
                    <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950">
                      <div className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                        {(progressionState?.tradeSuccessRate || 0).toFixed(1)}%
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Win Rate</div>
                    </div>
                    <div className="p-3 rounded-lg bg-cyan-50 dark:bg-cyan-950">
                      <div className="text-2xl font-bold text-cyan-700 dark:text-cyan-400">
                        ${(progressionState?.totalProfit || 0).toFixed(2)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Total Profit</div>
                    </div>
                  </div>
                </div>

                {/* Processing Metrics Section */}
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4" />
                    <h3 className="font-semibold">Processing Metrics</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-indigo-50 dark:bg-indigo-950">
                      <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">
                        {formatNumber(progressionState?.indicationsCount || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Indications Generated</div>
                    </div>
                    <div className="p-3 rounded-lg bg-violet-50 dark:bg-violet-950">
                      <div className="text-2xl font-bold text-violet-700 dark:text-violet-400">
                        {formatNumber(progressionState?.strategiesCount || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Strategies Created</div>
                    </div>
                    <div className="p-3 rounded-lg bg-fuchsia-50 dark:bg-fuchsia-950">
                      <div className="text-2xl font-bold text-fuchsia-700 dark:text-fuchsia-400">
                        {formatNumber(progressionState?.totalStrategiesEvaluated || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Total Evaluated</div>
                    </div>
                    <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950">
                      <div className="text-2xl font-bold text-rose-700 dark:text-rose-400">
                        {formatNumber(progressionState?.realtimeCycleCount || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">Realtime Cycles</div>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground p-3 rounded-lg bg-muted/50">
                  Data refreshes automatically every 2 seconds. Last updated: {new Date().toLocaleTimeString()}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
