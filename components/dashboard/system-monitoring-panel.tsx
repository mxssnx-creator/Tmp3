"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity } from "lucide-react"

interface CompactMonitor {
  engineCycles: number
  activePositions: number
  cpu: number
  memory: number
  redisKeys: number
  lastUpdate: string
}

export function SystemMonitoringPanel() {
  const [data, setData] = useState<CompactMonitor | null>(null)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 8000)
    return () => clearInterval(interval)
  }, [])

  const loadData = async () => {
    try {
      const res = await fetch("/api/system/monitoring", { cache: "no-store" })
      if (res.ok) {
        const mon = await res.json()
        setData({
          engineCycles: mon.cycles_total || 0,
          activePositions: mon.active_positions || 0,
          cpu: mon.cpu || 0,
          memory: mon.memory || 0,
          redisKeys: mon.redis_keys || 0,
          lastUpdate: new Date().toLocaleTimeString(),
        })
      }
    } catch (err) {
      console.error("[Monitor] Error:", err)
    }
  }

  if (!data) return null

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-0.5">
            <Activity className="w-3 h-3 text-green-500" />
            <span className="text-muted-foreground">Engine</span>
            <span className="font-bold text-blue-600">{data.engineCycles}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Pos</span>
            <span className="font-bold text-purple-600">{data.activePositions}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">CPU</span>
            <span className={`font-bold ${data.cpu > 80 ? "text-red-600" : data.cpu > 60 ? "text-orange-600" : "text-green-600"}`}>
              {data.cpu}%
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Mem</span>
            <span className={`font-bold ${data.memory > 80 ? "text-red-600" : data.memory > 60 ? "text-orange-600" : "text-green-600"}`}>
              {data.memory}%
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Redis</span>
            <span className="font-bold text-slate-600">{data.redisKeys}</span>
          </div>

          <Badge variant="outline" className="text-xs h-5">{data.lastUpdate}</Badge>
        </div>
      </CardContent>
    </Card>
  )
}
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Modules Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(monitor.modules).map(([module, status]) => (
              <div key={module} className="flex items-center justify-between p-2 bg-secondary/50 rounded">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${status ? "bg-green-500" : "bg-red-500"}`}></div>
                  <span className="text-sm capitalize font-medium">
                    {module.replace(/([A-Z])/g, " $1").trim()}
                  </span>
                </div>
                <Badge variant={status ? "outline" : "destructive"} className="text-xs">
                  {status ? "Active" : "Inactive"}
                </Badge>
              </div>
            ))}
            <Button
              size="sm"
              className="w-full mt-2"
              onClick={() => handleRestartService("all-modules")}
              disabled={restarting === "all-modules"}
              variant="outline"
            >
              <RotateCw className="h-3 w-3 mr-1" />
              {restarting === "all-modules" ? "Restarting..." : "Restart All"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Engines Status */}
      {monitor.engines && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Indications Engine
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between p-2 bg-secondary/50 rounded">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${monitor.engines.indications.running ? "bg-green-500" : "bg-red-500"}`}></div>
                  <span className="text-sm font-medium">Status</span>
                </div>
                <Badge variant={monitor.engines.indications.running ? "outline" : "destructive"} className="text-xs">
                  {monitor.engines.indications.running ? "Running" : "Stopped"}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Cycles</span>
                <span className="font-medium">{monitor.engines.indications.cycleCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Results</span>
                <span className="font-medium">{monitor.engines.indications.resultsCount}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Strategies Engine
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between p-2 bg-secondary/50 rounded">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${monitor.engines.strategies.running ? "bg-green-500" : "bg-red-500"}`}></div>
                  <span className="text-sm font-medium">Status</span>
                </div>
                <Badge variant={monitor.engines.strategies.running ? "outline" : "destructive"} className="text-xs">
                  {monitor.engines.strategies.running ? "Running" : "Stopped"}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Cycles</span>
                <span className="font-medium">{monitor.engines.strategies.cycleCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Results</span>
                <span className="font-medium">{monitor.engines.strategies.resultsCount}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Alert if critical */}
      {(monitor.cpu > 90 || monitor.memory > 90) && (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
              <div>
                <p className="font-medium text-sm">
                  {monitor.cpu > 90 && "CPU usage critically high. "}
                  {monitor.memory > 90 && "Memory usage critically high. "}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Consider restarting services or optimizing active connections.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
