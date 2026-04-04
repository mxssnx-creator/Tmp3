"use client"

import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { BarChart3, RefreshCw } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

export function QuickstartOverviewDialog() {
  const { exchangeId } = useExchange()
  const [isOpen, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [grouped, setGrouped] = useState<any>({ overall: [], data: [], engine: [], errors: [] })

  const resolvedConnectionId = exchangeId || "default"

  const load = async () => {
    if (!resolvedConnectionId || resolvedConnectionId === "default") {
      return
    }
    
    setLoading(true)
    try {
      // Fetch stats
      const statsRes = await fetch(`/api/exchange-positions/symbols-stats?connection_id=${resolvedConnectionId}`)
      if (statsRes.ok) {
        const statsData = await statsRes.json()
        setStats(statsData)
      }

      // Fetch logs
      const logsRes = await fetch(`/api/logs/export?connection_id=${resolvedConnectionId}&limit=500`)
      if (logsRes.ok) {
        const logsData = await logsRes.json()
        const allLogs = Array.isArray(logsData) ? logsData : logsData.logs || []
        setLogs(allLogs)

        // Group logs
        const overall: any[] = []
        const data: any[] = []
        const engine: any[] = []
        const errors: any[] = []

        for (const log of allLogs) {
          const category = (log.category || log.type || "").toLowerCase()
          if (category.includes("error")) {
            errors.push(log)
          } else if (category.includes("data") || category.includes("market")) {
            data.push(log)
          } else if (category.includes("engine") || category.includes("trade")) {
            engine.push(log)
          } else {
            overall.push(log)
          }
        }

        setGrouped({ overall, data, engine, errors })
      }
    } catch (error) {
      console.error("Failed to load overview:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      load()
    }
  }, [isOpen])

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { setOpen(v); if (v) void load() }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Main / Log overview">
          <BarChart3 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span>Quickstart Overview</span>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          <div className="text-xs text-muted-foreground">Connection: {resolvedConnectionId}</div>
        </DialogHeader>

        <Tabs defaultValue="main" className="space-y-3">
          <TabsList>
            <TabsTrigger value="main">Main</TabsTrigger>
            <TabsTrigger value="log">Log</TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Badge variant="outline">Symbols: {stats?.total_symbols || 0}</Badge>
              <Badge variant="outline">Positions: {stats?.total_open || 0}</Badge>
              <Badge variant="outline">Closed: {stats?.total_closed || 0}</Badge>
              <Badge variant="outline">Win Rate: {stats?.win_rate || "0"}%</Badge>
            </div>
            <div className="text-xs text-muted-foreground">Real-time overview of connected exchange data, indications, and strategy evaluations.</div>
          </TabsContent>

          <TabsContent value="log">
            <ScrollArea className="h-[56vh] rounded border p-2">
              <div className="space-y-2 text-xs">
                {(["overall", "data", "engine", "errors"] as const).map((section) => (
                  <details key={section} open={section === "errors"} className="rounded border bg-muted/20 px-2 py-1">
                    <summary className="cursor-pointer font-medium capitalize">{section} ({grouped[section].length})</summary>
                    <div className="mt-2 space-y-1">
                      {grouped[section].slice(0, 120).map((log, idx) => (
                        <details key={`${section}-${idx}`} className="rounded border bg-background px-2 py-1">
                          <summary className="cursor-pointer truncate">
                            [{new Date(log.timestamp || Date.now()).toLocaleTimeString()}] {log.engine || log.phase || "event"} - {log.action || log.message || "log"}
                          </summary>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{JSON.stringify(log, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
