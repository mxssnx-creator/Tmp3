"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { FileText, Trash2, RefreshCw } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface ProgressionLogEntry {
  timestamp: string
  level: string
  phase: string
  message: string
  details?: any
}

interface ProgressionLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
  progression?: any
}

export function ProgressionLogsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
  progression,
}: ProgressionLogsDialogProps) {
  const [logs, setLogs] = useState<ProgressionLogEntry[]>([])
  const [progressionState, setProgressionState] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (open) {
      loadLogs()
    }
  }, [open, connectionId])

  const loadLogs = async () => {
    setIsLoading(true)
    try {
      // Fetch from progression endpoint which has comprehensive data including state
      const response = await fetch(`/api/connections/progression/${connectionId}?t=${Date.now()}`)
      if (response.ok) {
        const data = await response.json()
        // Extract logs from the new endpoint format (recentLogs array)
        const logs = data.recentLogs || []
        setLogs(logs)
        // Extract progression state from the new endpoint format (state object)
        const state = data.state || {}
        setProgressionState({
          cyclesCompleted: state.cyclesCompleted || 0,
          successfulCycles: state.successfulCycles || 0,
          failedCycles: state.failedCycles || 0,
          cycleSuccessRate: state.cycleSuccessRate || 0,
          totalTrades: state.totalTrades || 0,
          successfulTrades: state.successfulTrades || 0,
          totalProfit: state.totalProfit || 0,
          tradeSuccessRate: state.tradeSuccessRate || 0,
          // Add stage counts from metrics if available
          stageMetrics: data.metrics || {},
        })
      } else {
        // Fallback: try legacy progression/logs endpoint
        const logsResponse = await fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`)
        if (logsResponse.ok) {
          const logsData = await logsResponse.json()
          setLogs(logsData.logs || [])
          setProgressionState(logsData.progressionState || null)
        }
      }
    } catch (error) {
      console.error("[v0] Failed to load progression logs:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleClearLogs = async () => {
    if (!confirm("Clear all logs for this connection? This cannot be undone.")) return

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

  const getLevelBadgeColor = (level: string) => {
    switch (level) {
      case "error":
        return "bg-red-100 text-red-800"
      case "warning":
        return "bg-yellow-100 text-yellow-800"
      case "debug":
        return "bg-gray-100 text-gray-800"
      default:
        return "bg-blue-100 text-blue-800"
    }
  }

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader>
          <DialogTitle className="px-6 pt-6">Progression Logs - {connectionName}</DialogTitle>
          <DialogDescription className="px-6">
            Detailed logs of all engine operations and phase transitions. Use this to debug progression issues.
          </DialogDescription>
        </DialogHeader>

        {/* Progression State Summary */}
        {progressionState && (
          <div className="mx-6 mb-4 space-y-3 rounded-lg bg-muted p-4">
            {/* Row 1: Main Metrics */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="text-center">
                <div className="text-lg font-semibold">{progressionState.cyclesCompleted || 0}</div>
                <div className="text-xs text-muted-foreground">Total Cycles</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-green-600">{progressionState.successfulCycles || 0}</div>
                <div className="text-xs text-muted-foreground">Successful</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-red-600">{progressionState.failedCycles || 0}</div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold">{(progressionState.cycleSuccessRate || 0).toFixed(1)}%</div>
                <div className="text-xs text-muted-foreground">Success Rate</div>
              </div>
            </div>
            
            {/* Row 2: Trade Metrics */}
            <div className="grid grid-cols-2 gap-3 border-t pt-3 md:grid-cols-4">
              <div className="text-center">
                <div className="text-lg font-semibold">{progressionState.totalTrades || 0}</div>
                <div className="text-xs text-muted-foreground">Total Trades</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-green-600">{progressionState.successfulTrades || 0}</div>
                <div className="text-xs text-muted-foreground">Profitable</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold">{(progressionState.tradeSuccessRate || 0).toFixed(1)}%</div>
                <div className="text-xs text-muted-foreground">Trade Win Rate</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-blue-600">${(progressionState.totalProfit || 0).toFixed(2)}</div>
                <div className="text-xs text-muted-foreground">Total Profit</div>
              </div>
            </div>
            
            {/* Row 3: Stage Processing Counts */}
            {progressionState.stageMetrics && (
              <div className="grid grid-cols-2 gap-3 border-t pt-3 md:grid-cols-4 text-xs">
                <div className="text-center">
                  <div className="font-semibold">{progressionState.stageMetrics.indicationsCount || 0}</div>
                  <div className="text-muted-foreground">Indications</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold">{progressionState.stageMetrics.strategiesCount || 0}</div>
                  <div className="text-muted-foreground">Strategies</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold">{progressionState.stageMetrics.totalStrategiesEvaluated || 0}</div>
                  <div className="text-muted-foreground">Evaluated</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold">{progressionState.stageMetrics.realtimeCycleCount || 0}</div>
                  <div className="text-muted-foreground">Realtime Cycles</div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mb-4 flex items-center justify-between px-6">
          <div className="text-sm text-muted-foreground">
            {logs.length} log entries {isLoading && "(refreshing...)"}
          </div>
          <div className="flex gap-2">
            <Badge variant="outline" className="text-[10px]">Manual refresh only</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={loadLogs}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              className="gap-2"
              disabled={logs.length === 0}
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>

        <ScrollArea className="mx-6 h-[52vh] w-auto rounded-md border bg-muted/20 px-3 py-2 font-mono text-xs">
          {isLoading ? (
            <div className="text-muted-foreground">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="text-muted-foreground">No logs yet. Enable the connection to start logging.</div>
          ) : (
            <div className="space-y-2">
              {logs.map((log, idx) => {
                const time = new Date(log.timestamp).toLocaleTimeString()
                return (
                  <div key={idx} className="grid grid-cols-[auto_auto_auto_1fr] items-start gap-2 text-xs">
                    <span className="text-gray-500 min-w-fit">[{time}]</span>
                    <Badge className={`min-w-fit ${getLevelBadgeColor(log.level)}`}>
                      {log.level.toUpperCase()}
                    </Badge>
                    <Badge variant="outline" className="min-w-fit">
                      {log.phase}
                    </Badge>
                    <div className="min-w-0 space-y-1">
                      <p className="break-words leading-relaxed text-foreground">{log.message}</p>
                    {log.details && (
                      <pre className="max-h-32 overflow-auto rounded bg-background p-2 text-[11px] text-muted-foreground">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="mt-4 border-t px-6 pb-6 pt-3 text-xs text-muted-foreground">
          <p>Logs are retained for 24 hours and show all engine operations including errors, phase transitions, and performance metrics.</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
