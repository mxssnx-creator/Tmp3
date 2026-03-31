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
      // Use the API route instead of direct Redis access
      const response = await fetch(`/api/connections/progression/${connectionId}/logs`)
      if (response.ok) {
        const data = await response.json()
        setLogs(data.logs || [])
        setProgressionState(data.progressionState || null)
      } else {
        // Fallback: try to get logs from progression endpoint
        const progResponse = await fetch(`/api/connections/progression/${connectionId}`)
        if (progResponse.ok) {
          const progData = await progResponse.json()
          setLogs(progData.recentLogs || [])
          setProgressionState(progData.state || null)
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
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Progression Logs - {connectionName}</DialogTitle>
          <DialogDescription>
            Detailed logs of all engine operations and phase transitions. Use this to debug progression issues.
          </DialogDescription>
        </DialogHeader>

        {/* Progression State Summary */}
        {progressionState && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 p-3 bg-muted rounded-lg text-xs">
            <div className="text-center">
              <div className="text-lg font-semibold">{progressionState.cyclesCompleted || 0}</div>
              <div className="text-xs text-muted-foreground">Cycles</div>
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
        )}

        <div className="flex items-center justify-between mb-4">
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

        <ScrollArea className="w-full h-[50vh] border rounded-md bg-slate-50 p-3 font-mono text-xs">
          {isLoading ? (
            <div className="text-muted-foreground">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="text-muted-foreground">No logs yet. Enable the connection to start logging.</div>
          ) : (
            <div className="space-y-2">
              {logs.map((log, idx) => {
                const time = new Date(log.timestamp).toLocaleTimeString()
                return (
                  <div key={idx} className="flex gap-2 text-xs items-start">
                    <span className="text-gray-500 min-w-fit">[{time}]</span>
                    <Badge className={`min-w-fit ${getLevelBadgeColor(log.level)}`}>
                      {log.level.toUpperCase()}
                    </Badge>
                    <Badge variant="outline" className="min-w-fit">
                      {log.phase}
                    </Badge>
                    <span className="flex-1 min-w-0 break-words text-gray-700 leading-relaxed">{log.message}</span>
                    {log.details && (
                      <span className="text-gray-500 max-w-xs break-words whitespace-pre-wrap">
                        {JSON.stringify(log.details, null, 2)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="mt-4 text-xs text-muted-foreground border-t pt-3">
          <p>Logs are retained for 24 hours and show all engine operations including errors, phase transitions, and performance metrics.</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
