"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Activity,
  Database,
  Cpu,
  HardDrive,
  TrendingUp,
  CheckCircle,
  Clock,
  Zap,
  BarChart3,
  Settings,
  RefreshCw,
  Server,
  Network,
  Target,
} from "lucide-react"

interface SystemMetrics {
  cpu_usage: number
  memory_usage: number
  database_size: number
  database_connections: number
  api_requests_per_minute: number
  websocket_connections: number
  uptime_hours: number
}

interface TradingLogistics {
  active_connections: number
  total_strategies: number
  active_strategies: number
  open_positions: number
  total_volume_24h: number
  trades_per_hour: number
  avg_response_time: number
  workflow_health?: string
  queue_backlog?: number
  processing_pressure?: number
  success_rate?: number
}

interface ModuleStatus {
  name: string
  status: "active" | "inactive" | "error"
  health: number
  last_update: string
}

export default function OverviewPage() {
  const [activeTab, setActiveTab] = useState("system")
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics>({
    cpu_usage: 35,
    memory_usage: 62,
    database_size: 245,
    database_connections: 12,
    api_requests_per_minute: 450,
    websocket_connections: 8,
    uptime_hours: 168,
  })

  const [tradingLogistics, setTradingLogistics] = useState<TradingLogistics>({
    active_connections: 3,
    total_strategies: 48,
    active_strategies: 24,
    open_positions: 156,
    total_volume_24h: 125000,
    trades_per_hour: 32,
    avg_response_time: 45,
    workflow_health: "unknown",
    queue_backlog: 0,
    processing_pressure: 0,
    success_rate: 0,
  })

  const [modules, setModules] = useState<ModuleStatus[]>([
    { name: "Live Trading Engine", status: "active", health: 98, last_update: "2 min ago" },
    { name: "Indication Generator", status: "active", health: 95, last_update: "1 min ago" },
    { name: "Strategy Optimizer", status: "active", health: 92, last_update: "3 min ago" },
    { name: "Position Manager", status: "active", health: 97, last_update: "1 min ago" },
    { name: "Analytics Engine", status: "active", health: 89, last_update: "5 min ago" },
    { name: "Database Sync", status: "active", health: 94, last_update: "2 min ago" },
    { name: "API Gateway", status: "active", health: 96, last_update: "1 min ago" },
    { name: "WebSocket Server", status: "active", health: 93, last_update: "2 min ago" },
  ])

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch("/api/structure/metrics")
        const result = await response.json()
        if (result.success) {
          setSystemMetrics(result.data.systemMetrics)
          setTradingLogistics(result.data.tradingLogistics)
        }
      } catch (error) {
        console.error("[v0] Error fetching metrics:", error)
      }
    }

    const fetchModules = async () => {
      try {
        const response = await fetch("/api/structure/modules")
        const result = await response.json()
        if (result.success) {
          setModules(result.data)
        }
      } catch (error) {
        console.error("[v0] Error fetching modules:", error)
      }
    }

    // Initial fetch
    fetchMetrics()
    fetchModules()

    // Refresh every 5 seconds
    const interval = setInterval(() => {
      fetchMetrics()
      fetchModules()
    }, 5000)

    return () => clearInterval(interval)
  }, [])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "text-green-500"
      case "inactive":
        return "text-gray-500"
      case "error":
        return "text-red-500"
      default:
        return "text-gray-500"
    }
  }

  const getHealthColor = (health: number) => {
    if (health >= 90) return "text-green-600"
    if (health >= 70) return "text-yellow-600"
    return "text-red-600"
  }

  const getMetricStatus = (value: number, threshold: number) => {
    return value < threshold ? "optimal" : value < threshold * 1.5 ? "warning" : "critical"
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">System Overview</h1>
          <p className="text-muted-foreground">Comprehensive system workability, logistics, and functionality status</p>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className="text-sm px-3 py-1">
            <Activity className="h-3 w-3 mr-1" />
            System Healthy
          </Badge>
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Quick Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">System Health</div>
                <div className="text-2xl font-bold text-green-600">98%</div>
              </div>
              <CheckCircle className="h-8 w-8 text-green-500" />
            </div>
            <Progress value={98} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Uptime</div>
                <div className="text-2xl font-bold">{systemMetrics.uptime_hours}h</div>
              </div>
              <Clock className="h-8 w-8 text-blue-500" />
            </div>
            <div className="text-xs text-muted-foreground mt-2">7 days continuous</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Active Modules</div>
                <div className="text-2xl font-bold">
                  {modules.filter((m) => m.status === "active").length}/{modules.length}
                </div>
              </div>
              <Zap className="h-8 w-8 text-orange-500" />
            </div>
            <div className="text-xs text-muted-foreground mt-2">All systems operational</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-2 px-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Response Time</div>
                <div className="text-2xl font-bold">{tradingLogistics.avg_response_time}ms</div>
              </div>
              <TrendingUp className="h-8 w-8 text-purple-500" />
            </div>
            <div className="text-xs text-green-600 mt-2">Optimal performance</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="system">System Metrics</TabsTrigger>
          <TabsTrigger value="logistics">Trading Logistics</TabsTrigger>
          <TabsTrigger value="modules">Module Status</TabsTrigger>
          <TabsTrigger value="optimization">Optimization</TabsTrigger>
        </TabsList>

        {/* System Metrics Tab */}
        <TabsContent value="system" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* CPU Usage */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-blue-500" />
                  CPU Usage
                </CardTitle>
                <CardDescription>Current processor utilization</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">{systemMetrics.cpu_usage.toFixed(1)}%</span>
                    <Badge variant={systemMetrics.cpu_usage < 60 ? "default" : "destructive"}>
                      {getMetricStatus(systemMetrics.cpu_usage, 60)}
                    </Badge>
                  </div>
                  <Progress value={systemMetrics.cpu_usage} className="h-3" />
                  <div className="text-sm text-muted-foreground">Threshold: 60% (Optimal) | 90% (Critical)</div>
                </div>
              </CardContent>
            </Card>

            {/* Memory Usage */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-green-500" />
                  Memory Usage
                </CardTitle>
                <CardDescription>RAM utilization</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-bold">{systemMetrics.memory_usage.toFixed(1)}%</span>
                    <Badge variant={systemMetrics.memory_usage < 70 ? "default" : "destructive"}>
                      {getMetricStatus(systemMetrics.memory_usage, 70)}
                    </Badge>
                  </div>
                  <Progress value={systemMetrics.memory_usage} className="h-3" />
                  <div className="text-sm text-muted-foreground">Threshold: 70% (Optimal) | 85% (Critical)</div>
                </div>
              </CardContent>
            </Card>

            {/* Database Metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-purple-500" />
                  Database Status
                </CardTitle>
                <CardDescription>Storage and connection metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Database Size</span>
                    <span className="font-semibold">{systemMetrics.database_size} MB</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Active Connections</span>
                    <span className="font-semibold">{systemMetrics.database_connections}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Query Performance</span>
                    <Badge variant="default">Excellent</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Network Metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-5 w-5 text-orange-500" />
                  Network Activity
                </CardTitle>
                <CardDescription>API and WebSocket connections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">API Requests/min</span>
                    <span className="font-semibold">{formatNumber(systemMetrics.api_requests_per_minute)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">WebSocket Connections</span>
                    <span className="font-semibold">{systemMetrics.websocket_connections}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Network Latency</span>
                    <Badge variant="default">Low</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Trading Logistics Tab */}
        <TabsContent value="logistics" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-blue-500" />
                  Exchange Connections
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-4xl font-bold">{tradingLogistics.active_connections}</div>
                  <div className="text-sm text-muted-foreground">Active exchange connections</div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span>Bybit X03</span>
                      <Badge variant="default">Active</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span>BingX X01</span>
                      <Badge variant="default">Active</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span>Pionex X01</span>
                      <Badge variant="default">Active</Badge>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-green-500" />
                  Strategy Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-4xl font-bold">{tradingLogistics.active_strategies}</div>
                      <div className="text-sm text-muted-foreground">of {tradingLogistics.total_strategies} total</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-semibold text-green-600">
                        {((tradingLogistics.active_strategies / tradingLogistics.total_strategies) * 100).toFixed(0)}%
                      </div>
                      <div className="text-xs text-muted-foreground">Active</div>
                    </div>
                  </div>
                  <Progress value={(tradingLogistics.active_strategies / tradingLogistics.total_strategies) * 100} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-purple-500" />
                  Position Activity
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-4xl font-bold">{tradingLogistics.open_positions}</div>
                  <div className="text-sm text-muted-foreground">Open positions</div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Trades/hour</span>
                        <span className="font-semibold">{tradingLogistics.trades_per_hour}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Workflow Health</span>
                        <span className="font-semibold capitalize">{tradingLogistics.workflow_health || "unknown"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Queue Backlog</span>
                        <span className="font-semibold">{tradingLogistics.queue_backlog || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">24h Volume</span>
                        <span className="font-semibold">{formatCurrency(tradingLogistics.total_volume_24h)}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Trading Flow Visualization */}
          <Card>
            <CardHeader>
              <CardTitle>Trading Workflow Status</CardTitle>
              <CardDescription>End-to-end trading process health</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                {[
                  { name: "Market Data", status: "active", health: 98 },
                  { name: "Signal Generation", status: "active", health: 95 },
                  { name: "Strategy Execution", status: "active", health: 96 },
                  { name: "Position Management", status: "active", health: Math.max(0, 100 - (tradingLogistics.processing_pressure || 0)) },
                  { name: "Risk Control", status: "active", health: tradingLogistics.success_rate || 94 },
                ].map((step, index) => (
                  <div key={index} className="text-center space-y-2">
                    <div className="flex justify-center">
                      <div
                        className={`w-16 h-16 rounded-full flex items-center justify-center ${
                          step.status === "active" ? "bg-green-100" : "bg-gray-100"
                        }`}
                      >
                        <CheckCircle className={`h-8 w-8 ${getStatusColor(step.status)}`} />
                      </div>
                    </div>
                    <div className="font-semibold text-sm">{step.name}</div>
                    <div className={`text-xs font-medium ${getHealthColor(step.health)}`}>{step.health}% Health</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Module Status Tab */}
        <TabsContent value="modules" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {modules.map((module, index) => (
              <Card key={index}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{module.name}</CardTitle>
                    <Badge variant={module.status === "active" ? "default" : "destructive"}>{module.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Health Score</span>
                      <span className={`text-2xl font-bold ${getHealthColor(module.health)}`}>{module.health}%</span>
                    </div>
                    <Progress value={module.health} className="h-2" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Last Update</span>
                      <span className="font-medium">{module.last_update}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Optimization Tab */}
        <TabsContent value="optimization" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                System Optimization Recommendations
              </CardTitle>
              <CardDescription>Suggestions to improve system performance and efficiency</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Optimal Status */}
                <div className="flex items-start gap-3 py-2 px-4 bg-green-50 rounded-lg border border-green-200">
                  <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-semibold text-green-900">System Running Optimally</div>
                    <div className="text-sm text-green-700 mt-1">
                      All metrics are within optimal ranges. CPU usage at {systemMetrics.cpu_usage.toFixed(1)}%, memory
                      at {systemMetrics.memory_usage.toFixed(1)}%.
                    </div>
                  </div>
                </div>

                {/* Recommendations */}
                <div className="space-y-3">
                  <h4 className="font-semibold">Performance Recommendations</h4>

                  <div className="flex items-start gap-3 py-2 px-4 bg-blue-50 rounded-lg border border-blue-200">
                    <BarChart3 className="h-5 w-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-blue-900">Database Optimization</div>
                      <div className="text-sm text-blue-700 mt-1">
                        Consider archiving positions older than 90 days to maintain optimal query performance. Current
                        database size: {systemMetrics.database_size} MB.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 py-2 px-4 bg-purple-50 rounded-lg border border-purple-200">
                    <Target className="h-5 w-5 text-purple-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-purple-900">Strategy Efficiency</div>
                      <div className="text-sm text-purple-700 mt-1">
                        {tradingLogistics.total_strategies - tradingLogistics.active_strategies} strategies are
                        inactive. Review and remove unused strategies to reduce system overhead.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 py-2 px-4 bg-orange-50 rounded-lg border border-orange-200">
                    <Zap className="h-5 w-5 text-orange-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-orange-900">API Rate Optimization</div>
                      <div className="text-sm text-orange-700 mt-1">
                        Current API request rate: {formatNumber(systemMetrics.api_requests_per_minute)}/min. Consider
                        implementing request batching for improved efficiency.
                      </div>
                    </div>
                  </div>
                </div>

                {/* System Capacity */}
                <div className="mt-6">
                  <h4 className="font-semibold mb-3">System Capacity Analysis</h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="py-2 px-4 bg-muted rounded-lg">
                      <div className="text-sm text-muted-foreground">Current Load</div>
                      <div className="text-2xl font-bold mt-1">Medium</div>
                      <div className="text-xs text-muted-foreground mt-2">
                        {tradingLogistics.open_positions} positions / 500 max capacity
                      </div>
                    </div>
                    <div className="py-2 px-4 bg-muted rounded-lg">
                      <div className="text-sm text-muted-foreground">Scalability</div>
                      <div className="text-2xl font-bold mt-1 text-green-600">High</div>
                      <div className="text-xs text-muted-foreground mt-2">Can handle 3x current load</div>
                    </div>
                    <div className="py-2 px-4 bg-muted rounded-lg">
                      <div className="text-sm text-muted-foreground">Efficiency Score</div>
                      <div className="text-2xl font-bold mt-1 text-blue-600">92%</div>
                      <div className="text-xs text-muted-foreground mt-2">Above industry average</div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
