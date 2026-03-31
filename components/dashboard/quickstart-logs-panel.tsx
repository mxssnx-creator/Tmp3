"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, RefreshCw, Copy, Download, ChevronDown, ChevronRight } from "lucide-react"
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
  cycleTimeMs?: number
  intervalsProcessed?: number
  indicationsCount?: number
  strategiesCount?: number
  strategyEvaluatedBase?: number
  strategyEvaluatedMain?: number
  strategyEvaluatedReal?: number
  prehistoricCyclesCompleted?: number
  prehistoricPhaseActive?: boolean
  prehistoricSymbolsProcessed?: number
  prehistoricSymbolsTotal?: number
  prehistoricCandlesProcessed?: number
  prehistoricDbEntries?: number
  dbWritesPerSec?: number
  dbSizeMb?: number
  setCounts?: { base?: number; main?: number; real?: number; total?: number }
  indicationByType?: { direction?: number; move?: number; active?: number; optimal?: number; auto?: number; total?: number }
  strategyStats?: {
    base?: { total?: number; evaluated?: number; evaluationRatePercent?: number; avgProfitFactor?: number; avgDrawdownTime?: number }
    main?: { total?: number; evaluated?: number; evaluationRatePercent?: number; avgProfitFactor?: number; avgDrawdownTime?: number }
    real?: { total?: number; evaluated?: number; evaluationRatePercent?: number; avgProfitFactor?: number; avgDrawdownTime?: number }
  }
}

export function QuickstartLogsPanel({ connectionId, className = "" }: QuickstartLogsPanelProps) {
  const [logs, setLogs] = useState<ProgressionLogEntry[]>([])
  const [progressionState, setProgressionState] = useState<ProgressionState | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  const fetchLogs = async () => {
    if (!connectionId) return

    setLoading(true)
    try {
      const res = await fetch(`/api/connections/progression/${connectionId}/logs`)
      const data = await res.json()

      setLogs(data.logs || [])
      setProgressionState(data.progressionState || null)
    } catch (error) {
      console.error("Failed to fetch logs:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [connectionId])

  const logsForDisplay = useMemo(() => logs.slice(-150).reverse(), [logs])

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

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
        <div className="flex items-center justify-between gap-2">
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
        {progressionState && (
          <>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-3 text-xs md:grid-cols-4 lg:grid-cols-8">
              <div><div className="font-semibold">{progressionState.cyclesCompleted || 0}</div><div className="text-muted-foreground">Cycles</div></div>
              <div><div className="font-semibold text-green-600">{progressionState.successfulCycles || 0}</div><div className="text-muted-foreground">Successful</div></div>
              <div><div className="font-semibold text-red-600">{progressionState.failedCycles || 0}</div><div className="text-muted-foreground">Failed</div></div>
              <div><div className="font-semibold">{(progressionState.cycleSuccessRate || 0).toFixed(1)}%</div><div className="text-muted-foreground">Success %</div></div>
              <div><div className="font-semibold">{progressionState.indicationsCount || 0}</div><div className="text-muted-foreground">Indications</div></div>
              <div><div className="font-semibold">{progressionState.strategiesCount || 0}</div><div className="text-muted-foreground">Strategies</div></div>
              <div><div className="font-semibold">{progressionState.intervalsProcessed || 0}</div><div className="text-muted-foreground">Intervals</div></div>
              <div><div className="font-semibold">{progressionState.cycleTimeMs || 0}ms</div><div className="text-muted-foreground">Cycle Time</div></div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded border bg-background p-2 text-xs">
                <div className="mb-1 font-medium">Prehistoric / DB</div>
                <div className="grid grid-cols-2 gap-1">
                  <div>Symbols: <span className="font-semibold">{progressionState.prehistoricSymbolsProcessed || 0}/{progressionState.prehistoricSymbolsTotal || 0}</span></div>
                  <div>Candles: <span className="font-semibold">{progressionState.prehistoricCandlesProcessed || 0}</span></div>
                  <div>DB entries: <span className="font-semibold">{progressionState.prehistoricDbEntries || 0}</span></div>
                  <div>DB size: <span className="font-semibold">{(progressionState.dbSizeMb || 0).toFixed(2)} MB</span></div>
                  <div>DB writes/s: <span className="font-semibold">{(progressionState.dbWritesPerSec || 0).toFixed(2)}</span></div>
                  <div>Prehistoric cycles: <span className="font-semibold">{progressionState.prehistoricCyclesCompleted || 0}</span></div>
                </div>
              </div>

              <div className="rounded border bg-background p-2 text-xs">
                <div className="mb-1 font-medium">Indications / Sets</div>
                <div className="grid grid-cols-2 gap-1">
                  <div>Direction: <span className="font-semibold">{progressionState.indicationByType?.direction || 0}</span></div>
                  <div>Move: <span className="font-semibold">{progressionState.indicationByType?.move || 0}</span></div>
                  <div>Active: <span className="font-semibold">{progressionState.indicationByType?.active || 0}</span></div>
                  <div>Optimal: <span className="font-semibold">{progressionState.indicationByType?.optimal || 0}</span></div>
                  <div>Auto: <span className="font-semibold">{progressionState.indicationByType?.auto || 0}</span></div>
                  <div>Total indications: <span className="font-semibold">{progressionState.indicationByType?.total || 0}</span></div>
                  <div>Sets Base/Main/Real: <span className="font-semibold">{progressionState.setCounts?.base || 0}/{progressionState.setCounts?.main || 0}/{progressionState.setCounts?.real || 0}</span></div>
                  <div>Sets Total: <span className="font-semibold">{progressionState.setCounts?.total || 0}</span></div>
                </div>
              </div>
            </div>

            <div className="rounded border bg-background p-2 text-xs">
              <div className="mb-1 font-medium">Strategy Evaluation Overview</div>
              <div className="grid gap-2 md:grid-cols-3">
                {(["base", "main", "real"] as const).map((type) => {
                  const stats = progressionState.strategyStats?.[type]
                  return (
                    <div key={type} className="rounded bg-muted/40 p-2">
                      <div className="mb-1 font-semibold uppercase">{type}</div>
                      <div>Total sets: {stats?.total || 0}</div>
                      <div>Evaluated: {stats?.evaluated || 0}</div>
                      <div>Eval rate: {(stats?.evaluationRatePercent || 0).toFixed(1)}%</div>
                      <div>Avg PF: {(stats?.avgProfitFactor || 0).toFixed(3)}</div>
                      <div>Avg DD time: {(stats?.avgDrawdownTime || 0).toFixed(1)}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">No logs yet</div>
        ) : (
          <ScrollArea className="h-[340px] w-full rounded-md border bg-muted/40 p-2">
            <div className="space-y-1">
              {logsForDisplay.map((log, idx) => {
                const rowId = `${log.timestamp}-${idx}`
                const expanded = expandedRows.has(rowId)
                return (
                  <div key={rowId} className="rounded border bg-background p-2 text-xs">
                    <button className="flex w-full items-start gap-2 text-left" onClick={() => toggleRow(rowId)}>
                      <Badge className={`mt-0.5 px-1 text-[10px] ${getLevelColor(log.level)}`}>{log.level.toUpperCase()}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-muted-foreground">{new Date(log.timestamp).toLocaleString()}</div>
                        <div className="truncate text-[11px] font-medium">[{log.phase}] {log.message}</div>
                      </div>
                      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                    {expanded && (
                      <div className="mt-2 rounded bg-muted/50 p-2 text-[10px]">
                        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(log.details || {}, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}

        <div className="border-t pt-2">
          <Badge variant="outline" className="text-[10px]">Manual refresh</Badge>
        </div>
      </CardContent>
    </Card>
  )
}
