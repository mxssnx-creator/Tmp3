"use client"

import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { FileText, Activity, BarChart3, RefreshCw } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

interface LogEntry {
  timestamp: Date
  level: "info" | "success" | "warning" | "error"
  message: string
  component?: string
}

interface EngineStats {
  cycles: number
  indications: number
  strategies: number
  positions: number
  profit: number
  successRate: number
}

interface OverallData {
  engineState: string
  totalCycles: number
  totalIndications: number
  totalStrategies: number
  openPositions: number
  totalPnL: number
  dailyPnL: number
  successRate: number
  uptime: string
  lastUpdate: string
}

export function QuickstartComprehensiveLogDialog() {
  // Use the global exchange context — driven by the top-page exchange selector
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const activeConnectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || activeConnectionId

  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [overallData, setOverallData] = useState<OverallData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // Fetch overall data
  const fetchOverallData = async () => {
    try {
      setIsLoading(true)
      const res = await fetch("/api/monitoring/stats", { cache: "no-store" })
      if (res.ok) {
        const data = await res.json()
        setOverallData({
          engineState: data.activeConnections > 0 ? "Running" : "Idle",
          totalCycles: data.statistics?.totalCycles || 0,
          totalIndications: data.statistics?.totalIndications || 0,
          totalStrategies: data.statistics?.totalStrategies || 0,
          openPositions: data.openPositions || 0,
          totalPnL: data.statistics?.totalProfit || data.totalBalance || 0,
          dailyPnL: data.dailyPnL || 0,
          successRate: (data.statistics?.winRate250 || 0.5) * 100,
          uptime: data.statistics?.uptime || "N/A",
          lastUpdate: new Date().toLocaleTimeString(),
        })
      }
    } catch (error) {
      console.error("[v0] Failed to fetch overall data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  // Fetch live logs
  const fetchLiveLogs = async () => {
    try {
      const res = await fetch(`/api/connections/progression/${activeConnectionId}/logs`, { cache: "no-store" })
      if (res.ok) {
        const data = await res.json()
        const newLogs: LogEntry[] = []

        if (Array.isArray(data)) {
          data.forEach((log: any) => {
            newLogs.push({
              timestamp: new Date(log.timestamp || Date.now()),
              level: log.level || "info",
              message: log.message || log.log || "",
              component: log.component || "Engine",
            })
          })
        } else if (data.logs && Array.isArray(data.logs)) {
          data.logs.forEach((log: any) => {
            newLogs.push({
              timestamp: new Date(log.timestamp || Date.now()),
              level: log.level || "info",
              message: log.message || log.log || "",
              component: log.component || "Engine",
            })
          })
        }

        setLogs(newLogs.slice(-100)) // Keep last 100 logs
      }
    } catch (error) {
      console.error("[v0] Failed to fetch logs:", error)
    }
  }

  // Poll when dialog is open; re-run whenever the selected connection changes
  useEffect(() => {
    if (!open) return
    fetchOverallData()
    fetchLiveLogs()
    const interval = setInterval(() => {
      fetchOverallData()
      fetchLiveLogs()
    }, 2000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeConnectionId])

  const getLogColor = (level: string) => {
    switch (level) {
      case "success":
        return "text-green-600 bg-green-50"
      case "error":
        return "text-red-600 bg-red-50"
      case "warning":
        return "text-amber-600 bg-amber-50"
      default:
        return "text-blue-600 bg-blue-50"
    }
  }

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
            Engine Processing Data & Logs
            {connectionLabel && (
              <Badge variant="secondary" className="text-xs font-normal">
                {connectionLabel}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="overall" className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="overall" className="gap-2">
              <BarChart3 className="w-4 h-4" />
              Overall
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-2">
              <FileText className="w-4 h-4" />
              Live Logs
            </TabsTrigger>
          </TabsList>

          {/* Overall Tab */}
          <TabsContent value="overall" className="flex-1 space-y-4 overflow-y-auto">
            {overallData ? (
              <div className="space-y-4">
                {/* Engine Status */}
                <Card className="p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Engine Status</h3>
                    <Badge
                      variant={overallData.engineState === "Running" ? "default" : "secondary"}
                    >
                      {overallData.engineState}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">Last updated: {overallData.lastUpdate}</p>
                </Card>

                {/* Processing Statistics */}
                <Card className="p-4">
                  <h3 className="font-semibold mb-3">Processing Statistics</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-muted p-3 rounded">
                      <p className="text-xs text-muted-foreground">Total Cycles</p>
                      <p className="text-2xl font-bold text-blue-600">{overallData.totalCycles}</p>
                    </div>
                    <div className="bg-muted p-3 rounded">
                      <p className="text-xs text-muted-foreground">Indications</p>
                      <p className="text-2xl font-bold text-purple-600">{overallData.totalIndications}</p>
                    </div>
                    <div className="bg-muted p-3 rounded">
                      <p className="text-xs text-muted-foreground">Strategies</p>
                      <p className="text-2xl font-bold text-orange-600">{overallData.totalStrategies}</p>
                    </div>
                    <div className="bg-muted p-3 rounded">
                      <p className="text-xs text-muted-foreground">Open Positions</p>
                      <p className="text-2xl font-bold text-green-600">{overallData.openPositions}</p>
                    </div>
                  </div>
                </Card>

                {/* Performance Metrics */}
                <Card className="p-4">
                  <h3 className="font-semibold mb-3">Performance Metrics</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center p-2 bg-muted rounded">
                      <span className="text-sm">Total P&L</span>
                      <span className={`font-bold ${overallData.totalPnL >= 0 ? "text-green-600" : "text-red-600"}`}>
                        ${overallData.totalPnL.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center p-2 bg-muted rounded">
                      <span className="text-sm">Daily P&L</span>
                      <span className={`font-bold ${overallData.dailyPnL >= 0 ? "text-green-600" : "text-red-600"}`}>
                        ${overallData.dailyPnL.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center p-2 bg-muted rounded">
                      <span className="text-sm">Win Rate</span>
                      <span className="font-bold text-blue-600">{overallData.successRate.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between items-center p-2 bg-muted rounded">
                      <span className="text-sm">Uptime</span>
                      <span className="font-bold">{overallData.uptime}</span>
                    </div>
                  </div>
                </Card>
              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <p className="text-muted-foreground">Loading overall data...</p>
              </div>
            )}
          </TabsContent>

          {/* Live Logs Tab */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0">
            <div className="flex gap-2 mb-2">
              <Button
                size="sm"
                onClick={() => fetchLiveLogs()}
                disabled={isLoading}
                className="gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <div className="text-xs text-muted-foreground ml-auto">
                {logs.length} entries • Auto-refresh: 2s
              </div>
            </div>

            <ScrollArea className="flex-1 border rounded-md p-3 space-y-1">
              {logs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No logs available yet</p>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`text-xs p-2 rounded font-mono mb-1 ${getLogColor(log.level)}`}
                  >
                    <div className="flex gap-2">
                      <span className="text-muted-foreground flex-shrink-0">
                        {log.timestamp.toLocaleTimeString()}
                      </span>
                      <span className="flex-shrink-0 font-bold">[{log.component}]</span>
                      <span className="flex-1">{log.message}</span>
                    </div>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
