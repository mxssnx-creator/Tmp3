"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PositionBreakdown } from "@/components/analysis/position-breakdown"
import { PositionCalculator } from "@/lib/position-calculator"
import type { SymbolAnalysis } from "@/lib/position-calculator"
import { CalculationDemo } from "@/components/analysis/calculation-demo"
import { TrendingUp, TrendingDown, Activity, DollarSign, Clock, Target } from "lucide-react"

interface ActivePosition {
  id: string
  symbol: string
  direction: "long" | "short"
  entry_price: number
  current_price: number
  quantity: number
  leverage: number
  unrealized_pnl: number
  unrealized_pnl_percent: number
  status: string
  created_at: string
  connection_id: string
}

interface PositionStats {
  total_positions: number
  active_positions: number
  closed_positions: number
  total_pnl: number
  win_rate: number
  avg_profit: number
  avg_loss: number
}

export default function AnalysisPage() {
  const [calculator] = useState(new PositionCalculator())
  const [selectedSymbol, setSelectedSymbol] = useState("XRPUSDT")
  const [symbolAnalysis, setSymbolAnalysis] = useState<SymbolAnalysis | null>(null)
  const [activePositions, setActivePositions] = useState<ActivePosition[]>([])
  const [positionStats, setPositionStats] = useState<PositionStats | null>(null)
  const [connections, setConnections] = useState<any[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>("all")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchConnections()
  }, [])

  useEffect(() => {
    fetchActivePositions()
    fetchPositionStats()
    const interval = setInterval(() => {
      fetchActivePositions()
      fetchPositionStats()
    }, 5000) // Update every 5 seconds
    return () => clearInterval(interval)
  }, [selectedConnection])

  useEffect(() => {
    const analysis = calculator.calculateSymbolPositions(selectedSymbol)
    setSymbolAnalysis(analysis)
  }, [selectedSymbol, calculator])

  const fetchConnections = async () => {
    try {
      const res = await fetch("/api/settings/connections")
      if (res.ok) {
        const data = await res.json()
        setConnections(data.connections || [])
      }
    } catch (error) {
      console.error("[v0] Failed to fetch connections:", error)
    }
  }

  const fetchActivePositions = async () => {
    try {
      const url = selectedConnection === "all" ? "/api/positions" : `/api/positions/${selectedConnection}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setActivePositions(data.positions || [])
      }
    } catch (error) {
      console.error("[v0] Failed to fetch positions:", error)
    } finally {
      setLoading(false)
    }
  }

  const fetchPositionStats = async () => {
    try {
      const url = selectedConnection === "all" ? "/api/positions/stats" : `/api/positions/${selectedConnection}/stats`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setPositionStats(data.stats)
      }
    } catch (error) {
      console.error("[v0] Failed to fetch stats:", error)
    }
  }

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat().format(num)
  }

  const formatCurrency = (num: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)
  }

  const formatPercent = (num: number) => {
    return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Position Analysis</h1>
          <p className="text-muted-foreground">Real-time position tracking and theoretical calculations</p>
        </div>
        <Badge variant="outline" className="text-lg px-4 py-2">
          <Activity className="w-4 h-4 mr-2" />
          Live Data
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter by Connection</CardTitle>
          <CardDescription>View positions for specific exchange connections</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedConnection} onValueChange={setSelectedConnection}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select connection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Connections</SelectItem>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name} ({conn.exchange})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {positionStats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Active Positions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{formatNumber(positionStats.active_positions)}</div>
              <p className="text-xs text-muted-foreground">{formatNumber(positionStats.total_positions)} total</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <DollarSign className="w-4 h-4" />
                Total P&L
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${positionStats.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(positionStats.total_pnl)}
              </div>
              <p className="text-xs text-muted-foreground">Unrealized profit/loss</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Target className="w-4 h-4" />
                Win Rate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-600">{positionStats.win_rate.toFixed(1)}%</div>
              <p className="text-xs text-muted-foreground">Closed positions</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Avg Profit/Loss
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Profit:</span>
                  <span className="font-semibold text-green-600">{formatCurrency(positionStats.avg_profit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Loss:</span>
                  <span className="font-semibold text-red-600">{formatCurrency(positionStats.avg_loss)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="active" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="active">Active Positions</TabsTrigger>
          <TabsTrigger value="theoretical">Theoretical Analysis</TabsTrigger>
          <TabsTrigger value="demo">Calculation Demo</TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Active Positions ({activePositions.length})</CardTitle>
              <CardDescription>Real-time position tracking with P&L updates</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8 text-muted-foreground">Loading positions...</div>
              ) : activePositions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No active positions</div>
              ) : (
                <div className="space-y-3">
                  {activePositions.map((position) => (
                    <div
                      key={position.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className={`p-2 rounded ${position.direction === "long" ? "bg-green-100" : "bg-red-100"}`}>
                          {position.direction === "long" ? (
                            <TrendingUp className="w-5 h-5 text-green-600" />
                          ) : (
                            <TrendingDown className="w-5 h-5 text-red-600" />
                          )}
                        </div>
                        <div>
                          <div className="font-semibold">{position.symbol}</div>
                          <div className="text-sm text-muted-foreground">
                            {position.direction.toUpperCase()} • {position.leverage}x leverage
                          </div>
                        </div>
                      </div>

                      <div className="text-right space-y-1">
                        <div className="flex items-center gap-4">
                          <div className="text-sm">
                            <div className="text-muted-foreground">Entry</div>
                            <div className="font-medium">${position.entry_price.toFixed(4)}</div>
                          </div>
                          <div className="text-sm">
                            <div className="text-muted-foreground">Current</div>
                            <div className="font-medium">${position.current_price.toFixed(4)}</div>
                          </div>
                          <div className="text-sm">
                            <div className="text-muted-foreground">Quantity</div>
                            <div className="font-medium">{position.quantity}</div>
                          </div>
                        </div>
                        <div
                          className={`text-lg font-bold ${position.unrealized_pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {formatCurrency(position.unrealized_pnl)} ({formatPercent(position.unrealized_pnl_percent)})
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="theoretical" className="space-y-6">
          {symbolAnalysis && <PositionBreakdown analysis={symbolAnalysis} />}
        </TabsContent>

        <TabsContent value="demo" className="space-y-6">
          <CalculationDemo />
        </TabsContent>
      </Tabs>
    </div>
  )
}
