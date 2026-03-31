"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { AlertCircle, Activity, Database, RotateCw, Cpu, HardDrive, Server, Gauge, Zap } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface SystemMonitor {
  cpu: number
  memory: number
  memoryUsed: number
  memoryTotal: number
  services: {
    tradeEngine: boolean
    indicationsEngine: boolean
    strategiesEngine: boolean
    websocket: boolean
  }
  modules: {
    redis: boolean
    persistence: boolean
    coordinator: boolean
    logger: boolean
  }
  database: {
    size: number
    keys: number
    sets: number
    positions1h: number
    entries1h: number
  }
  engines?: {
    indications: {
      running: boolean
      cycleCount: number
      resultsCount: number
    }
    strategies: {
      running: boolean
      cycleCount: number
      resultsCount: number
    }
  }
}

export function SystemMonitoringPanel() {
  const [monitor, setMonitor] = useState<SystemMonitor | null>(null)
  const [loading, setLoading] = useState(true)
  const [restarting, setRestarting] = useState<string | null>(null)

  const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    return fallback
  }

  const toBoolean = (value: unknown): boolean => {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value === 1
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (["true", "1", "yes", "on", "online", "running", "active", "healthy"].includes(normalized)) return true
      if (["false", "0", "no", "off", "offline", "stopped", "inactive", "down", "error"].includes(normalized)) return false
    }
    return false
  }

  const normalizeMonitorPayload = (raw: any): SystemMonitor => ({
    cpu: toNumber(raw?.cpu, 0),
    memory: toNumber(raw?.memory, 0),
    memoryUsed: toNumber(raw?.memoryUsed, 0),
    memoryTotal: Math.max(toNumber(raw?.memoryTotal, 1), 1),
    services: {
      tradeEngine: toBoolean(raw?.services?.tradeEngine),
      indicationsEngine: toBoolean(raw?.services?.indicationsEngine),
      strategiesEngine: toBoolean(raw?.services?.strategiesEngine),
      websocket: toBoolean(raw?.services?.websocket),
    },
    modules: {
      redis: toBoolean(raw?.modules?.redis),
      persistence: toBoolean(raw?.modules?.persistence),
      coordinator: toBoolean(raw?.modules?.coordinator),
      logger: toBoolean(raw?.modules?.logger),
    },
    database: {
      size: toNumber(raw?.database?.size, 0),
      keys: toNumber(raw?.database?.keys, 0),
      sets: toNumber(raw?.database?.sets, 0),
      positions1h: toNumber(raw?.database?.positions1h, 0),
      entries1h: toNumber(raw?.database?.entries1h, 0),
    },
    engines: raw?.engines ? {
      indications: {
        running: toBoolean(raw.engines?.indications?.running),
        cycleCount: toNumber(raw.engines?.indications?.cycleCount, 0),
        resultsCount: toNumber(raw.engines?.indications?.resultsCount, 0),
      },
      strategies: {
        running: toBoolean(raw.engines?.strategies?.running),
        cycleCount: toNumber(raw.engines?.strategies?.cycleCount, 0),
        resultsCount: toNumber(raw.engines?.strategies?.resultsCount, 0),
      },
    } : undefined,
  })

  const loadMonitoring = async () => {
    try {
      const response = await fetch("/api/system/monitoring", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      })
      if (response.ok) {
        const data = await response.json()
        const normalized = normalizeMonitorPayload(data)
        setMonitor(normalized)
        console.log("[v0] [Monitor] System metrics updated:", data)
      } else {
        console.warn("[v0] [Monitor] Monitoring endpoint returned non-OK status", response.status)
      }
    } catch (error) {
      console.error("[v0] [Monitor] Failed to load system monitoring:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMonitoring()
    // Optimized: Increased polling from 2s to 10s (system metrics don't need frequent updates)
    const interval = setInterval(loadMonitoring, 10000)
    return () => clearInterval(interval)
  }, [])

  const handleRestartService = async (service: string) => {
    setRestarting(service)
    try {
      console.log(`[v0] [Monitor] Restarting service: ${service}`)
      const response = await fetch("/api/system/restart-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      })
      const data = await response.json()
      if (response.ok) {
        toast.success(`${service} restarted successfully`)
        setTimeout(loadMonitoring, 500)
      } else {
        toast.error(`Failed to restart ${service}: ${data.error}`)
      }
    } catch (error) {
      console.error(`[v0] [Monitor] Failed to restart ${service}:`, error)
      toast.error(`Error restarting ${service}`)
    } finally {
      setRestarting(null)
    }
  }

  if (loading) {
    return <div className="text-center text-muted-foreground">Loading system metrics...</div>
  }

  if (!monitor) {
    return <div className="text-center text-destructive">Failed to load system monitoring</div>
  }

  const cpuStatus = monitor.cpu > 80 ? "destructive" : monitor.cpu > 60 ? "secondary" : "default"
  const memStatus = monitor.memory > 80 ? "destructive" : monitor.memory > 60 ? "secondary" : "default"

  return (
    <div className="space-y-4">
      {/* System Resources Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* CPU Usage */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Cpu className="h-4 w-4" />
                CPU Usage
              </CardTitle>
              <Badge variant={cpuStatus} className="text-xs">
                {monitor.cpu}%
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={monitor.cpu} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {monitor.cpu > 80 ? "Critical" : monitor.cpu > 60 ? "High" : "Normal"}
            </p>
          </CardContent>
        </Card>

        {/* Memory Usage */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Memory
              </CardTitle>
              <Badge variant={memStatus} className="text-xs">
                {monitor.memory}%
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={monitor.memory} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {(monitor.memoryUsed / 1024).toFixed(1)} MB / {(monitor.memoryTotal / 1024).toFixed(1)} MB
            </p>
          </CardContent>
        </Card>

        {/* Database Size */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Database className="h-4 w-4" />
                Database
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                {(monitor.database.size / 1024 / 1024).toFixed(2)} MB
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Keys:</span>
                <span className="font-medium">{monitor.database.keys}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sets:</span>
                <span className="font-medium">{monitor.database.sets}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Gauge className="h-4 w-4" />
                Last 1h
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                Live
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Positions:</span>
                <span className="font-medium">{monitor.database.positions1h}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Entries:</span>
                <span className="font-medium">{monitor.database.entries1h}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Services & Modules Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Services */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" />
              Services Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(monitor.services).map(([service, status]) => (
              <div key={service} className="flex items-center justify-between p-2 bg-secondary/50 rounded">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${status ? "bg-green-500" : "bg-red-500"}`}></div>
                  <span className="text-sm capitalize font-medium">
                    {service.replace(/([A-Z])/g, " $1").trim()}
                  </span>
                </div>
                <Badge variant={status ? "outline" : "destructive"} className="text-xs">
                  {status ? "Online" : "Offline"}
                </Badge>
              </div>
            ))}
            <Button
              size="sm"
              className="w-full mt-2"
              onClick={() => handleRestartService("all-services")}
              disabled={restarting === "all-services"}
              variant="outline"
            >
              <RotateCw className="h-3 w-3 mr-1" />
              {restarting === "all-services" ? "Restarting..." : "Restart All"}
            </Button>
          </CardContent>
        </Card>

        {/* Modules */}
        <Card>
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
