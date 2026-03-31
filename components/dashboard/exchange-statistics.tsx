"use client"

import { useState, useEffect, memo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { AlertCircle, TrendingUp, Activity, Zap } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface ExchangeStatisticsProps {
  connectionId: string
  connectionName: string
}

const ExchangeStatisticsComponent = ({ connectionId, connectionName }: ExchangeStatisticsProps) => {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadStats = async () => {
      try {
        setLoading(true)
        const res = await fetch(`/api/settings/connections/${connectionId}/statistics`)
        if (!res.ok) throw new Error("Failed to fetch statistics")
        const data = await res.json()
        setStats(data)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }

    loadStats()
    const interval = setInterval(loadStats, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [connectionId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading Statistics...</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="h-4 w-4 animate-spin" />
            <span>Fetching {connectionName} statistics...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error || !stats) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error || "Failed to load statistics"}</AlertDescription>
      </Alert>
    )
  }

  const { prehistoric, symbols, metrics, progression } = stats

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{connectionName} Statistics</CardTitle>
              <CardDescription>Prehistoric analysis and trading metrics</CardDescription>
            </div>
            <Badge variant="outline" className="gap-1">
              <TrendingUp className="h-3 w-3" />
              {new Date(stats.timestamp).toLocaleTimeString()}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      {/* Prehistoric Data Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Prehistoric Data (30-Day Historical Analysis)
          </CardTitle>
          <CardDescription>Historical market and strategy analysis</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Symbols Analyzed</p>
              <p className="text-2xl font-bold">{prehistoric.symbols_analyzed}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Total Indications</p>
              <p className="text-2xl font-bold">{prehistoric.total_indications}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Avg Profit Factor</p>
              <p className="text-2xl font-bold">{prehistoric.avg_profit_factor.toFixed(2)}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Data Points</p>
              <p className="text-2xl font-bold">{prehistoric.data_points_loaded}</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">Winning Signals</p>
              <p className="text-xl font-semibold text-green-600">{prehistoric.winning_signals}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">Losing Signals</p>
              <p className="text-xl font-semibold text-red-600">{prehistoric.losing_signals}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mt-4">
            Last updated: {new Date(prehistoric.last_updated).toLocaleString()}
          </p>
        </CardContent>
      </Card>

      {/* Trading Metrics */}
      <Card>
        <CardHeader>
          <CardTitle>Trading Metrics</CardTitle>
          <CardDescription>Live trading performance</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Total Trades</p>
              <p className="text-2xl font-bold">{metrics.total_trades}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Win Rate</p>
              <p className="text-2xl font-bold text-green-600">{metrics.win_rate.toFixed(1)}%</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Total Profit</p>
              <p className={`text-2xl font-bold ${metrics.total_profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                {metrics.total_profit.toFixed(2)} USDT
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Winning Trades</p>
              <p className="text-xl font-semibold text-green-600">{metrics.winning_trades}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Losing Trades</p>
              <p className="text-xl font-semibold text-red-600">{metrics.losing_trades}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Max Drawdown</p>
              <p className="text-xl font-semibold">{metrics.max_drawdown.toFixed(2)}%</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Symbols by Performance */}
      {symbols && symbols.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top Performing Symbols</CardTitle>
            <CardDescription>Symbol-level statistics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left font-semibold p-2">Symbol</th>
                    <th className="text-right font-semibold p-2">Volatility</th>
                    <th className="text-right font-semibold p-2">Volume (24h)</th>
                    <th className="text-right font-semibold p-2">Price Change</th>
                    <th className="text-right font-semibold p-2">Indications</th>
                  </tr>
                </thead>
                <tbody>
                  {symbols.slice(0, 10).map((symbol: any, idx: number) => (
                    <tr key={idx} className="border-b hover:bg-muted/50">
                      <td className="p-2 font-medium">{symbol.symbol}</td>
                      <td className="text-right p-2">{symbol.volatility.toFixed(2)}%</td>
                      <td className="text-right p-2">{(symbol.volume_24h / 1e6).toFixed(2)}M</td>
                      <td className={`text-right p-2 ${symbol.price_change_percent >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {symbol.price_change_percent.toFixed(2)}%
                      </td>
                      <td className="text-right p-2">{symbol.indications_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Progression Data */}
      {progression && Object.keys(progression).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Engine Progression</CardTitle>
            <CardDescription>Current processing state</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Phase</span>
                <Badge>{progression.phase || "idle"}</Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Progress</span>
                <span className="text-sm font-bold">{progression.progress || 0}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${progression.progress || 0}%` }}
                />
              </div>
              {progression.message && (
                <p className="text-xs text-muted-foreground mt-4 italic">{progression.message}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export const ExchangeStatistics = memo(ExchangeStatisticsComponent)
