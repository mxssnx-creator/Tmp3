"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { BarChart3, RefreshCw } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

interface Props {
  connectionId?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function QuickstartOverviewDialog({ 
  connectionId: propConnectionId, 
  open: controlledOpen, 
  onOpenChange 
}: Props) {
  const { selectedConnectionId } = useExchange()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [resolvedConnectionId, setResolvedConnectionId] = useState(propConnectionId || selectedConnectionId || "bingx-x01")
  
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen

  // Use exchange context's selected connection, but allow prop override
  const actualConnectionId = propConnectionId || selectedConnectionId || resolvedConnectionId

  const setOpen = (value: boolean) => {
    if (isControlled) {
      onOpenChange?.(value)
    } else {
      setUncontrolledOpen(value)
    }
  }

  useEffect(() => {
    setResolvedConnectionId(actualConnectionId)
  }, [actualConnectionId])

  useEffect(() => {
    if (isOpen) {
      void load()
    }
  }, [isOpen, actualConnectionId])

  const load = async () => {
    setLoading(true)
    try {
      const candidates = [actualConnectionId, actualConnectionId.startsWith("conn-") ? actualConnectionId.replace(/^conn-/, "") : `conn-${actualConnectionId}`]
      let chosenId = actualConnectionId
      let statsPayload: any = {}
      let logsPayload: any = {}

      for (const candidate of candidates) {
        const [statsRes, logsRes] = await Promise.all([
          fetch(`/api/connections/progression/${candidate}/logs`),
          fetch(`/api/trade-engine/structured-logs?connectionId=${candidate}&limit=150`),
        ])
        const s = await statsRes.json().catch(() => ({}))
        const l = await logsRes.json().catch(() => ({}))
        if (statsRes.ok || (Array.isArray(l?.logs) && l.logs.length > 0)) {
          chosenId = candidate
          statsPayload = s
          logsPayload = l
          break
        }
      }

      setResolvedConnectionId(chosenId)
      setStats(statsPayload?.progressionState || null)
      setLogs(Array.isArray(logsPayload?.logs) ? logsPayload.logs : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!isOpen) return
    const timer = setInterval(() => {
      void load()
    }, 15000)
    return () => clearInterval(timer)
  }, [isOpen, actualConnectionId])

  const grouped = useMemo(() => {
    const overall = logs.filter((l) => ["system", "coordinator"].includes(String(l.engine || "").toLowerCase()))
    const data = logs.filter((l) => ["prehistoric", "realtime", "market-data"].some((k) => String(l.phase || l.engine || "").toLowerCase().includes(k)))
    const engine = logs.filter((l) => ["indications", "strategies", "database"].some((k) => String(l.engine || l.phase || "").toLowerCase().includes(k)))
    const errors = logs.filter((l) => String(l.status || l.level || "").toLowerCase().includes("error"))
    return { overall, data, engine, errors }
  }, [logs])

  return (
     <Dialog open={isOpen} onOpenChange={(v) => { setOpen(v); if (v) void load() }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" title="Quickstart / Overview dialog">
          <BarChart3 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span>Quickstart Overview - {resolvedConnectionId}</span>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          <div className="text-xs text-muted-foreground">Selected Connection: {resolvedConnectionId} | Auto-refresh every 15s</div>
        </DialogHeader>

        <Tabs defaultValue="main" className="space-y-3">
          <TabsList>
            <TabsTrigger value="main">Main</TabsTrigger>
            <TabsTrigger value="log">Log</TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Badge variant="outline">Cycles: {stats?.cyclesCompleted || 0}</Badge>
              <Badge variant="outline">Intervals: {stats?.intervalsProcessed || 0}</Badge>
              <Badge variant="outline">Prehistoric data: {stats?.prehistoricDataSize || 0}</Badge>
              <Badge variant="outline">DB entries: {stats?.redisDbEntries || 0}</Badge>
              <Badge variant="outline">Ind dir/move: {stats?.indicationEvaluatedDirection || 0}/{stats?.indicationEvaluatedMove || 0}</Badge>
              <Badge variant="outline">Ind active/opt: {stats?.indicationEvaluatedActive || 0}/{stats?.indicationEvaluatedOptimal || 0}</Badge>
              <Badge variant="outline">Sets base/main: {stats?.setsBaseCount || 0}/{stats?.setsMainCount || 0}</Badge>
              <Badge variant="outline">Sets real/total: {stats?.setsRealCount || 0}/{stats?.setsTotalCount || 0}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">Compact workflow overview (overall/data/engine/errors) is available in the Log tab with expandable rows. All data is for the selected connection: <strong>{resolvedConnectionId}</strong></div>
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
                            [{new Date(log.timestamp || Date.now()).toLocaleTimeString()}] {log.engine || log.phase || "engine"} - {log.action || log.message || "event"}
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
