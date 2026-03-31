"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, RefreshCw, Copy, Download } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface ProgressionLogEntry {
  timestamp: string
  level: "info" | "warning" | "error" | "debug"
  phase: string
  message: string
  details?: Record<string, any>
  connectionId: string
}

interface QuickstartLogsPanelProps {
  connectionId?: string
  className?: string
}

interface ProgressionState {
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  successfulTrades: number
  totalProfit: number
  tradeSuccessRate?: number
  lastUpdate: Date
  prehistoricCyclesCompleted?: number
  prehistoricSymbolsProcessed?: string[]
  prehistoricPhaseActive?: boolean
  engine_cycles_total?: number
  lastCycleTime?: Date | null
  cycleTimeMs?: number
  intervalsProcessed?: number
  indicationsCount?: number
  strategiesCount?: number
  strategyEvaluatedBase?: number
  strategyEvaluatedMain?: number
  strategyEvaluatedReal?: number
  prehistoricSymbolsProcessedCount?: number
  prehistoricCandlesProcessed?: number
  prehistoricDataSize?: number
  indicationEvaluatedDirection?: number
  indicationEvaluatedMove?: number
  indicationEvaluatedActive?: number
  indicationEvaluatedOptimal?: number
  setsBaseCount?: number
  setsMainCount?: number
  setsRealCount?: number
  setsTotalCount?: number
  redisDbEntries?: number
  redisDbSizeMb?: number
}

export function QuickstartLogsPanel({ connectionId, className = "" }: QuickstartLogsPanelProps) {
  const [logs, setLogs] = useState<ProgressionLogEntry[]>([])
  const [progressionState, setProgressionState] = useState<ProgressionState | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchLogs = async () => {
    if (!connectionId) return

    setLoading(true)
    try {
      const res = await fetch(`/api/connections/progression/${connectionId}/logs`)
      const data = await res.json()

      if (data.logs) {
        setLogs(data.logs)
      }
      if (data.progressionState) {
        setProgressionState(data.progressionState)
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [connectionId])

  const copyLogs = () => {
    const logText = logs
      .map((log) => `[${log.timestamp}] ${log.level.toUpperCase()} [${log.phase}] ${log.message}`)
      .join("\n")
    navigator.clipboard.writeText(logText)
    toast.success("Logs copied to clipboard")
  }

  const downloadLogs = () => {
    const logText = logs
      .map((log) => `[${log.timestamp}] ${log.level.toUpperCase()} [${log.phase}] ${log.message}`)
      .join("\n")
    const blob = new Blob([logText], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `progression-logs-${connectionId}.txt`
    a.click()
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "bg-red-100 text-red-800"
      case "warning":
        return "bg-yellow-100 text-yellow-800"
      case "info":
        return "bg-blue-100 text-blue-800"
      case "debug":
        return "bg-gray-100 text-gray-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  if (!connectionId) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-sm">Progression Logs</CardTitle>
          <CardDescription>Select a connection to view logs</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">Progression Logs</CardTitle>
            <CardDescription>{logs.length} log entries</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={fetchLogs} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={copyLogs} disabled={logs.length === 0}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={downloadLogs} disabled={logs.length === 0}>
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

        <CardContent className="space-y-3">
          {/* Comprehensive Progression State Summary */}
          {progressionState && (
            <>
              {/* Main Metrics - Extended Display */}
              {(progressionState.cyclesCompleted > 0 || progressionState.engine_cycles_total > 0) && (
                <div className="grid grid-cols-3 md:grid-cols-6 gap-2 p-3 bg-muted rounded-lg text-xs mb-4">
                  <div className="text-center">
                    <div className="font-semibold text-lg">{progressionState.cyclesCompleted + (progressionState.engine_cycles_total || 0)}</div>
                    <div className="text-muted-foreground">Cycles</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-green-600 text-lg">{progressionState.successfulCycles}</div>
                    <div className="text-muted-foreground">Successful</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-red-600 text-lg">{progressionState.failedCycles}</div>
                    <div className="text-muted-foreground">Failed</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-lg">{(progressionState.cycleSuccessRate || 0).toFixed(1)}%</div>
                    <div className="text-muted-foreground">Success Rate</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-lg">{progressionState.totalTrades}</div>
                    <div className="text-muted-foreground">Total Trades</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-green-600 text-lg">{progressionState.successfulTrades}</div>
                    <div className="text-muted-foreground">Wins</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-lg">{(progressionState.tradeSuccessRate || 0).toFixed(1)}%</div>
                    <div className="text-muted-foreground">Trade Win%</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold text-lg">${(progressionState.totalProfit || 0).toFixed(2)}</div>
                    <div className="text-muted-foreground">Profit</div>
                  </div>
                  {progressionState.cycleTimeMs !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold">{progressionState.cycleTimeMs}ms</div>
                      <div className="text-muted-foreground">Cycle Time</div>
                    </div>
                  )}
                  {progressionState.intervalsProcessed !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold">{progressionState.intervalsProcessed}</div>
                      <div className="text-muted-foreground">Intervals</div>
                    </div>
                  )}
                  {progressionState.indicationsCount !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold text-blue-600">{progressionState.indicationsCount}</div>
                      <div className="text-muted-foreground">Indications</div>
                    </div>
                  )}
                  {progressionState.strategiesCount !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold text-orange-600">{progressionState.strategiesCount}</div>
                      <div className="text-muted-foreground">Strategies</div>
                    </div>
                  )}
                </div>
              )}
                  {progressionState.intervalsProcessed !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold">{progressionState.intervalsProcessed}</div>
                      <div className="text-muted-foreground">Intervals</div>
                    </div>
                  )}
                  {progressionState.indicationsCount !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold">{progressionState.indicationsCount}</div>
                      <div className="text-muted-foreground">Indications</div>
                    </div>
                  )}
                  {progressionState.strategiesCount !== undefined && (
                    <div className="text-center">
                      <div className="font-semibold">{progressionState.strategiesCount}</div>
                      <div className="text-muted-foreground">Strategies</div>
                    </div>
                  )}
                  {/* Comprehensive Strategy Evaluations by Type */}
                  {(progressionState.strategyEvaluatedBase || 0) > 0 && (
                    <div className="text-center">
                      <div className="font-semibold text-blue-600">{progressionState.strategyEvaluatedBase}</div>
                      <div className="text-muted-foreground">Base Eval</div>
                    </div>
                  )}
                  {(progressionState.strategyEvaluatedMain || 0) > 0 && (
                    <div className="text-center">
                      <div className="font-semibold text-green-600">{progressionState.strategyEvaluatedMain}</div>
                      <div className="text-muted-foreground">Main Eval</div>
                    </div>
                  )}
                  {(progressionState.strategyEvaluatedReal || 0) > 0 && (
                    <div className="text-center">
                      <div className="font-semibold text-purple-600">{progressionState.strategyEvaluatedReal}</div>
                      <div className="text-muted-foreground">Real Eval</div>
                    </div>
                  )}
                </div>
             )}
             
             {/* Prehistoric Data Processing Info */}
             {progressionState.prehistoricCyclesCompleted !== undefined && progressionState.prehistoricCyclesCompleted > 0 && (
               <div className="bg-blue-50 rounded-lg p-3 mb-4">
                 <div className="flex items-center justify-between mb-2">
                   <div className="font-medium">Prehistoric Data Processing</div>
                   <div className="text-xs text-blue-600">
                     {progressionState.prehistoricPhaseActive ? "Active" : "Completed"}
                   </div>
                 </div>
                 <div className="grid grid-cols-2 gap-2 text-sm">
                   <div>
                     <div className="font-semibold">{progressionState.prehistoricCyclesCompleted}</div>
                     <div className="text-xs text-muted-foreground">Cycles</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.prehistoricSymbolsProcessedCount || 0}</div>
                     <div className="text-xs text-muted-foreground">Symbols</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.prehistoricCandlesProcessed || 0}</div>
                     <div className="text-xs text-muted-foreground">Candles</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.prehistoricDataSize || 0}</div>
                     <div className="text-xs text-muted-foreground">Data Keys</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.strategyEvaluatedBase || 0}</div>
                     <div className="text-xs text-muted-foreground">Base Eval</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.strategyEvaluatedMain || 0}</div>
                     <div className="text-xs text-muted-foreground">Main Eval</div>
                   </div>
                   <div>
                     <div className="font-semibold">{progressionState.strategyEvaluatedReal || 0}</div>
                     <div className="text-xs text-muted-foreground">Real Eval</div>
                   </div>
                 </div>
               </div>
             )}

             {/* Cascading indication/strategy/db overview */}
             <div className="rounded-lg border bg-background p-3 mb-3">
               <div className="mb-2 text-xs font-medium text-muted-foreground">Cascading overview (under indications)</div>
               <div className="flex flex-wrap gap-1 mb-2">
                 <Badge variant="secondary">Indications</Badge>
                 <Badge variant="outline">Dir: {progressionState.indicationEvaluatedDirection || 0}</Badge>
                 <Badge variant="outline">Move: {progressionState.indicationEvaluatedMove || 0}</Badge>
                 <Badge variant="outline">Active: {progressionState.indicationEvaluatedActive || 0}</Badge>
                 <Badge variant="outline">Optimal: {progressionState.indicationEvaluatedOptimal || 0}</Badge>
               </div>
               <div className="flex flex-wrap gap-1 mb-2">
                 <Badge variant="secondary">Strategies</Badge>
                 <Badge variant="outline">Base sets: {progressionState.setsBaseCount || 0}</Badge>
                 <Badge variant="outline">Main sets: {progressionState.setsMainCount || 0}</Badge>
                 <Badge variant="outline">Real sets: {progressionState.setsRealCount || 0}</Badge>
                 <Badge variant="outline">Total sets: {progressionState.setsTotalCount || 0}</Badge>
               </div>
               <div className="flex flex-wrap gap-1">
                 <Badge variant="secondary">Database</Badge>
                 <Badge variant="outline">Entries: {progressionState.redisDbEntries || 0}</Badge>
                 <Badge variant="outline">Size: {(progressionState.redisDbSizeMb || 0).toFixed(2)} MB</Badge>
               </div>
             </div>
             
             {/* Detailed Logs Section */}
              {loading && logs.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading logs...
                </div>
              ) : logs.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">No logs yet</div>
              ) : (
                <ScrollArea className="h-[300px] w-full border rounded-md p-3 bg-muted/50 overflow-hidden">
                  <div className="space-y-1">
                    {logs.slice(-100).map((log, idx) => (
                      <div key={idx} className="text-xs font-mono hover:bg-muted/50 rounded px-1 py-0.5 -mx-1">
                        <div className="flex items-start gap-1">
                          <Badge className={`flex-shrink-0 mt-0.5 text-[10px] px-1 ${getLevelColor(log.level)}`}>
                            {log.level.charAt(0).toUpperCase()}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <div className="text-[10px] text-muted-foreground">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </div>
                            <div className="text-[11px] break-words leading-tight">[{log.phase}] {log.message}</div>
                            {log.details && Object.keys(log.details).length > 0 && (
                              <details className="mt-0.5">
                                <summary className="cursor-pointer text-[10px] text-blue-600 hover:underline">
                                  + details
                                </summary>
                                <div className="text-[10px] text-muted-foreground mt-1 break-words bg-background p-1 rounded">
                                  {JSON.stringify(log.details, null, 2)}
                                </div>
                              </details>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
             
             <div className="flex items-center gap-2 pt-2 border-t">
               <Badge variant="outline" className="text-[10px]">Manual refresh only</Badge>
             </div>
           </>
         )}
       </CardContent>
    </Card>
  )
}
