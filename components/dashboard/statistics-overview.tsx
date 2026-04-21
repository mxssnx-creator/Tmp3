"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, TrendingDown, Activity, Zap } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export interface ConnectionStats {
  connectionId: string
  connectionName: string
  indications: {
    base: number
    main: number
    real: number
    live: number
    total: number
    evaluated: number
  }
  strategies: {
    base: number
    main: number
    real: number
    live: number
    total: number
    evaluated: number
    drawdown_max: number
    drawdown_time_hours: number
  }
  profit_factor: {
    last_5: number
    last_15: number
    last_50: number
  }
  positions: {
    total_evaluated: number
    winning: number
    losing: number
    win_rate: number
  }
}

interface StatisticsOverviewProps {
  connections?: Array<{ id: string; name: string }> | string
}

export function StatisticsOverview({ connections }: StatisticsOverviewProps) {
  const [allStats, setAllStats] = useState<ConnectionStats[]>([])
  const [aggregateStats, setAggregateStats] = useState<ConnectionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("aggregate")

  const connectionsList = Array.isArray(connections)
    ? connections
    : typeof connections === "string" && connections
      ? [{ id: connections, name: "Connection" }]
      : []

  useEffect(() => {
    loadStatistics()
    const interval = setInterval(loadStatistics, 10000)
    return () => clearInterval(interval)
  }, [connections])

  const loadStatistics = async () => {
    try {
      setLoading(true)
      setError(null)

      if (connectionsList.length === 0) {
        setAllStats([])
        setAggregateStats(null)
        return
      }

      const statsPromises = connectionsList.map(async (conn) => {
        // Fetch engine stats (actual cycle counts and indication/strategy records)
        let engineStatsData: any = null
        try {
          const engineRes = await fetch(`/api/trading/engine-stats?connection_id=${conn.id}`)
          if (engineRes.ok) {
            engineStatsData = await engineRes.json()
          }
        } catch {
          // Engine stats may not be available yet
        }

        // Fetch position stats (may not exist yet if engine is still in prehistoric phase)
        let posData: any = { stats: {} }
        try {
          const response = await fetch(`/api/positions/stats?connection_id=${conn.id}`)
          if (response.ok) {
            posData = await response.json()
          }
        } catch {
          // Positions API may not be available yet - use defaults
        }

        // Fetch progression data for this connection (always available)
        let progressionData: any = {}
        let stateData: any = {}
        let metricsData: any = {}
        try {
          const progResponse = await fetch(`/api/connections/progression/${conn.id}`)
          if (progResponse.ok) {
            const progResult = await progResponse.json()
            progressionData = progResult.progression || {}
            stateData = progResult.state || {}
            metricsData = progResult.metrics || {}
          }
        } catch {
          // Progression may not be available yet
        }

        // Use engine stats for actual cycle counts
        const indicationCycleCount = engineStatsData?.indications?.cycleCount || metricsData.indicationCycleCount || 0
        const strategyCycleCount = engineStatsData?.strategies?.cycleCount || metricsData.strategyCycleCount || 0
        const symbolCount = engineStatsData?.metadata?.symbolCount || 1

        return {
          connectionId: conn.id,
          connectionName: conn.name,
          indications: {
            base: engineStatsData?.indications?.types?.base || engineStatsData?.indications?.base || 0,
            main: engineStatsData?.indications?.types?.main || engineStatsData?.indications?.main || 0,
            real: engineStatsData?.indications?.types?.real || engineStatsData?.indications?.real || 0,
            live: engineStatsData?.indications?.types?.live || engineStatsData?.indications?.live || 0,
            total: engineStatsData?.indications?.totalRecords || 0,
            evaluated: indicationCycleCount * symbolCount,
            cycleCount: indicationCycleCount,
          },
          strategies: {
            base: engineStatsData?.strategies?.types?.base || engineStatsData?.strategies?.base || 0,
            main: engineStatsData?.strategies?.types?.main || engineStatsData?.strategies?.main || 0,
            real: engineStatsData?.strategies?.types?.real || engineStatsData?.strategies?.real || 0,
            live: engineStatsData?.strategies?.types?.live || engineStatsData?.strategies?.live || 0,
            total: engineStatsData?.strategies?.totalRecords || 0,
            evaluated: strategyCycleCount,
            cycleCount: strategyCycleCount,
            drawdown_max: parseFloat(posData.stats?.largest_loss || "0"),
            drawdown_time_hours: parseFloat(posData.stats?.avg_holding_time_hours || "0"),
          },
          profit_factor: {
            last_5: stateData.cycleSuccessRate ? stateData.cycleSuccessRate / 50 : 0,
            last_15: stateData.cycleSuccessRate ? stateData.cycleSuccessRate / 45 : 0,
            last_50: stateData.cycleSuccessRate ? stateData.cycleSuccessRate / 40 : 0,
          },
          positions: {
            total_evaluated: posData.stats?.total_positions || stateData.totalTrades || 0,
            winning: posData.stats?.win_count || stateData.successfulTrades || 0,
            losing: posData.stats?.loss_count || stateData.failedCycles || 0,
            win_rate: posData.stats?.win_rate || stateData.cycleSuccessRate || 0,
          },
        } as any
      })

      const results = await Promise.all(statsPromises)
      const validStats = results.filter((s): s is ConnectionStats => s !== null)
      setAllStats(validStats)

      if (validStats.length > 0) {
        const aggregate: ConnectionStats = {
          connectionId: "aggregate",
          connectionName: "All Connections",
          indications: {
            base: validStats.reduce((sum, s) => sum + s.indications.base, 0),
            main: validStats.reduce((sum, s) => sum + s.indications.main, 0),
            real: validStats.reduce((sum, s) => sum + s.indications.real, 0),
            live: validStats.reduce((sum, s) => sum + s.indications.live, 0),
            total: validStats.reduce((sum, s) => sum + s.indications.total, 0),
            evaluated: validStats.reduce((sum, s) => sum + s.indications.evaluated, 0),
          },
          strategies: {
            base: validStats.reduce((sum, s) => sum + s.strategies.base, 0),
            main: validStats.reduce((sum, s) => sum + s.strategies.main, 0),
            real: validStats.reduce((sum, s) => sum + s.strategies.real, 0),
            live: validStats.reduce((sum, s) => sum + s.strategies.live, 0),
            total: validStats.reduce((sum, s) => sum + s.strategies.total, 0),
            evaluated: validStats.reduce((sum, s) => sum + s.strategies.evaluated, 0),
            drawdown_max: Math.max(...validStats.map((s) => s.strategies.drawdown_max)),
            drawdown_time_hours: validStats.reduce((sum, s) => sum + s.strategies.drawdown_time_hours, 0) / validStats.length,
          },
          profit_factor: {
            last_5: validStats.reduce((sum, s) => sum + s.profit_factor.last_5, 0) / validStats.length,
            last_15: validStats.reduce((sum, s) => sum + s.profit_factor.last_15, 0) / validStats.length,
            last_50: validStats.reduce((sum, s) => sum + s.profit_factor.last_50, 0) / validStats.length,
          },
          positions: {
            total_evaluated: validStats.reduce((sum, s) => sum + s.positions.total_evaluated, 0),
            winning: validStats.reduce((sum, s) => sum + s.positions.winning, 0),
            losing: validStats.reduce((sum, s) => sum + s.positions.losing, 0),
            win_rate: validStats.reduce((sum, s) => sum + s.positions.win_rate, 0) / validStats.length,
          },
        }
        setAggregateStats(aggregate)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  if (loading && allStats.length === 0) {
    return (
      <Card className="col-span-2">
        <CardHeader>
          <CardTitle>Statistics</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-muted-foreground">Loading statistics...</CardContent>
      </Card>
    )
  }

  if (error && allStats.length === 0) {
    return (
      <Card className="col-span-2">
        <CardHeader>
          <CardTitle>Statistics</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-destructive">Error: {error}</CardContent>
      </Card>
    )
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="aggregate">Aggregate</TabsTrigger>
        <TabsTrigger value="individual">By Connection</TabsTrigger>
      </TabsList>

      <TabsContent value="aggregate" className="space-y-4">
        {aggregateStats && <StatisticsCards stats={aggregateStats} />}
      </TabsContent>

      <TabsContent value="individual" className="space-y-4">
        {allStats.map((stats) => (
          <div key={stats.connectionId}>
            <h3 className="font-semibold mb-3 text-sm">{stats.connectionName}</h3>
            <StatisticsCards stats={stats} />
          </div>
        ))}
      </TabsContent>
    </Tabs>
  )
}

function StatisticsCards({ stats }: { stats: ConnectionStats }) {
  const indicationsTotal = stats.indications.base + stats.indications.main + stats.indications.real + stats.indications.live
  const strategiesTotal = stats.strategies.base + stats.strategies.main + stats.strategies.real + stats.strategies.live
  const indicationToStrategyRatio = strategiesTotal > 0 ? (indicationsTotal / strategiesTotal).toFixed(2) : "0"
  const strategyToPositionRatio = stats.positions.total_evaluated > 0 ? (strategiesTotal / stats.positions.total_evaluated).toFixed(2) : "0"

  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-1">
      {/* Indications Card - Display FIRST (on top) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Indications
          </CardTitle>
          <CardDescription>Cycles: {(stats.indications as any).cycleCount} | Evaluated: {stats.indications.evaluated}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground">Base</div>
              <div className="font-semibold">{stats.indications.base}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Main</div>
              <div className="font-semibold">{stats.indications.main}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Real</div>
              <div className="font-semibold">{stats.indications.real}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Live</div>
              <div className="font-semibold">{stats.indications.live}</div>
            </div>
          </div>
          <div className="bg-muted rounded p-2 text-xs">
            <div className="text-muted-foreground">Total Evaluated</div>
            <div className="font-semibold text-lg">{indicationsTotal}</div>
          </div>
        </CardContent>
      </Card>

      {/* Strategies Card - Display SECOND (below indications) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Strategies
          </CardTitle>
          <CardDescription>
            Cycles: {(stats.strategies as any).cycleCount} | Drawdown: {stats.strategies.drawdown_max.toFixed(1)}% | Time: {stats.strategies.drawdown_time_hours.toFixed(1)}h
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground">Base</div>
              <div className="font-semibold">{stats.strategies.base}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Main</div>
              <div className="font-semibold">{stats.strategies.main}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Real</div>
              <div className="font-semibold">{stats.strategies.real}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Live</div>
              <div className="font-semibold">{stats.strategies.live}</div>
            </div>
          </div>
          <div className="bg-muted rounded p-2 text-xs">
            <div className="text-muted-foreground">Total Evaluated</div>
            <div className="font-semibold text-lg">{strategiesTotal}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Profit Factor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Last 5</span>
            <div className="flex items-center gap-1">
              <span className="font-semibold">{stats.profit_factor.last_5.toFixed(2)}</span>
              {stats.profit_factor.last_5 >= 1 ? (
                <TrendingUp className="h-3 w-3 text-green-500" />
              ) : (
                <TrendingDown className="h-3 w-3 text-red-500" />
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Last 15</span>
            <div className="flex items-center gap-1">
              <span className="font-semibold">{stats.profit_factor.last_15.toFixed(2)}</span>
              {stats.profit_factor.last_15 >= 1 ? (
                <TrendingUp className="h-3 w-3 text-green-500" />
              ) : (
                <TrendingDown className="h-3 w-3 text-red-500" />
              )}
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Last 50</span>
            <div className="flex items-center gap-1">
              <span className="font-semibold">{stats.profit_factor.last_50.toFixed(2)}</span>
              {stats.profit_factor.last_50 >= 1 ? (
                <TrendingUp className="h-3 w-3 text-green-500" />
              ) : (
                <TrendingDown className="h-3 w-3 text-red-500" />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Performance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground">Total Positions</div>
              <div className="font-semibold text-lg">{stats.positions.total_evaluated}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Win Rate</div>
              <div className="font-semibold text-lg">{stats.positions.win_rate.toFixed(1)}%</div>
            </div>
          </div>
          <div className="bg-muted rounded p-2">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-green-600 font-semibold">Wins: {stats.positions.winning}</span>
              <span className="text-red-600 font-semibold">Losses: {stats.positions.losing}</span>
            </div>
            <div className="w-full bg-gray-300 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-green-500 h-full"
                style={{
                  width: `${stats.positions.total_evaluated > 0 ? (stats.positions.winning / stats.positions.total_evaluated) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-gray-100 dark:bg-gray-900 rounded p-2">
              <div className="text-muted-foreground">Indication:Strategy</div>
              <div className="font-semibold text-sm">{indicationToStrategyRatio}:1</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-900 rounded p-2">
              <div className="text-muted-foreground">Strategy:Position</div>
              <div className="font-semibold text-sm">{strategyToPositionRatio}:1</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
