"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Activity, Zap } from "lucide-react"

// STRATEGIES: Have base/main/real/live types
interface StrategyMetrics {
  type: "base" | "main" | "real" | "live"
  count: number
  winRate: number
  drawdown: number
  drawdownHours: number
  profitFactor250: number
  profitFactor50: number
}

// INDICATIONS: Have direction/move/active/optimal types (INDEPENDENT from strategies)
interface IndicationMetrics {
  type: "direction" | "move" | "active" | "optimal"
  totalCount: number
  avgSignalStrength: number
  lastTrigger: Date | null
  profitFactor: number
}

interface SymbolStats {
  symbol: string
  livePositions: number
  profitFactor250: number
  profitFactor50: number
}

interface PerformanceMetrics {
  last250Positions: {
    total: number
    winning: number
    losing: number
    winRate: number
    profitFactor: number
    totalProfit: number
  }
  last50Positions: {
    total: number
    winning: number
    losing: number
    winRate: number
    profitFactor: number
    totalProfit: number
  }
  last32Hours: {
    totalPositions: number
    totalProfit: number
    profitFactor: number
  }
}

interface StatisticsOverviewV2Props {
  connections?: Array<{ id: string; name: string }> | string
}

export function StatisticsOverviewV2({ connections }: StatisticsOverviewV2Props) {
  const [strategies, setStrategies] = useState<StrategyMetrics[]>([])
  const [indications, setIndications] = useState<IndicationMetrics[]>([])
  const [symbols, setSymbols] = useState<SymbolStats[]>([])
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    return fallback
  }

  useEffect(() => {
    loadStatistics()
    const interval = setInterval(loadStatistics, 15000)
    return () => clearInterval(interval)
  }, [connections])

  const loadStatistics = async () => {
    try {
      setLoading(true)
      setError(null)

      const results = await Promise.allSettled([
        fetch("/api/trading/stats"),
        fetch("/api/main/strategies-evaluation"),
        fetch("/api/main/indications-stats"),
        fetch("/api/exchange-positions/symbols-stats"),
      ])

      // FETCH 1: Performance metrics
      if (results[0].status === "fulfilled" && results[0].value.ok) {
        try {
          const perfData = await results[0].value.json()
          setPerformance({
            last250Positions: {
              total: perfData.last250?.total || 0,
              winning: perfData.last250?.wins || 0,
              losing: perfData.last250?.losses || 0,
              winRate: perfData.last250?.winRate || 0,
              profitFactor: perfData.last250?.profitFactor || 0,
              totalProfit: perfData.last250?.totalProfit || 0,
            },
            last50Positions: {
              total: perfData.last50?.total || 0,
              winning: perfData.last50?.wins || 0,
              losing: perfData.last50?.losses || 0,
              winRate: perfData.last50?.winRate || 0,
              profitFactor: perfData.last50?.profitFactor || 0,
              totalProfit: perfData.last50?.totalProfit || 0,
            },
            last32Hours: {
              totalPositions: perfData.last32h?.total || 0,
              totalProfit: perfData.last32h?.totalProfit || 0,
              profitFactor: perfData.last32h?.profitFactor || 0,
            },
          })
        } catch (e) { console.warn("[Statistics] Failed to parse performance data") }
      }

      // FETCH 2: Strategies metrics
      if (results[1].status === "fulfilled" && results[1].value.ok) {
        try {
          const stratData = await results[1].value.json()
          const strategiesData: StrategyMetrics[] = ["base", "main", "real", "live"].map((type) => ({
            type: type as StrategyMetrics["type"],
            count: stratData.strategies?.[type]?.count || 0,
            winRate: stratData.strategies?.[type]?.winRate || 0,
            drawdown: stratData.strategies?.[type]?.drawdown || 0,
            drawdownHours: stratData.strategies?.[type]?.drawdownHours || 0,
            profitFactor250: stratData.strategies?.[type]?.profitFactor250 || 0,
            profitFactor50: stratData.strategies?.[type]?.profitFactor50 || 0,
          }))
          setStrategies(strategiesData)
        } catch (e) { console.warn("[Statistics] Failed to parse strategies data") }
      }

      // FETCH 3: Indications metrics
      if (results[2].status === "fulfilled" && results[2].value.ok) {
        try {
          const indicData = await results[2].value.json()
          const indicationsData: IndicationMetrics[] = ["direction", "move", "active", "optimal"].map((type) => ({
            type: type as IndicationMetrics["type"],
            totalCount: indicData.indications?.[type]?.count || 0,
            avgSignalStrength: indicData.indications?.[type]?.avgSignalStrength || 0,
            lastTrigger: indicData.indications?.[type]?.lastTrigger ? new Date(indicData.indications[type].lastTrigger) : null,
            profitFactor: indicData.indications?.[type]?.profitFactor || 0,
          }))
          setIndications(indicationsData)
        } catch (e) { console.warn("[Statistics] Failed to parse indications data") }
      }

      // FETCH 4: Symbols stats
      if (results[3].status === "fulfilled" && results[3].value.ok) {
        try {
          const symbolData = await results[3].value.json()
          const normalizedSymbols: SymbolStats[] = (symbolData.symbols || []).slice(0, 22).map((s: any) => ({
            symbol: String(s?.symbol || "UNKNOWN"),
            livePositions: toNumber(s?.livePositions ?? s?.openPositions, 0),
            profitFactor250: toNumber(s?.profitFactor250, 0),
            profitFactor50: toNumber(s?.profitFactor50, 0),
          }))
          setSymbols(normalizedSymbols)
        } catch (e) { console.warn("[Statistics] Failed to parse symbols data") }
      }

      setLoading(false)
    } catch (err) {
      console.error("[Statistics] Error loading data:", err)
      setError("Failed to load statistics")
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <Card className="col-span-full bg-gradient-to-br from-card to-card/50 border-primary/20">
        <CardContent className="pt-6">
          <div className="text-center text-muted-foreground">Loading statistics...</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="col-span-full bg-gradient-to-br from-card to-card/50 border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Trading Statistics Overview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* PERFORMANCE METRICS - Overall trading performance */}
        {performance && (
          <div className="space-y-3 pb-4 border-b">
            <div className="text-sm font-semibold text-muted-foreground">Performance Metrics</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {/* Last 250 Positions */}
              <div className="rounded-lg border bg-card p-3 space-y-1">
                <div className="text-xs text-muted-foreground">Last 250 Positions</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Win Rate</div>
                    <div className="font-semibold">{(performance.last250Positions.winRate * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Profit Factor</div>
                    <div className={`font-semibold ${performance.last250Positions.profitFactor >= 1.5 ? "text-green-600" : performance.last250Positions.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {performance.last250Positions.profitFactor.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="text-xs pt-1 border-t">
                  <div className="text-muted-foreground">Total Profit</div>
                  <div className="font-semibold">${performance.last250Positions.totalProfit.toFixed(2)}</div>
                </div>
              </div>

              {/* Last 50 Positions */}
              <div className="rounded-lg border bg-card p-3 space-y-1">
                <div className="text-xs text-muted-foreground">Last 50 Positions</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Win Rate</div>
                    <div className="font-semibold">{(performance.last50Positions.winRate * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Profit Factor</div>
                    <div className={`font-semibold ${performance.last50Positions.profitFactor >= 1.5 ? "text-green-600" : performance.last50Positions.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {performance.last50Positions.profitFactor.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="text-xs pt-1 border-t">
                  <div className="text-muted-foreground">Total Profit</div>
                  <div className="font-semibold">${performance.last50Positions.totalProfit.toFixed(2)}</div>
                </div>
              </div>

              {/* Last 32 Hours */}
              <div className="rounded-lg border bg-card p-3 space-y-1">
                <div className="text-xs text-muted-foreground">Last 32 Hours</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Positions</div>
                    <div className="font-semibold">{performance.last32Hours.totalPositions}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Profit Factor</div>
                    <div className={`font-semibold ${performance.last32Hours.profitFactor >= 1.5 ? "text-green-600" : performance.last32Hours.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {performance.last32Hours.profitFactor.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="text-xs pt-1 border-t">
                  <div className="text-muted-foreground">Total Profit</div>
                  <div className="font-semibold">${performance.last32Hours.totalProfit.toFixed(2)}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STRATEGIES - base/main/real/live types with smart line format */}
        <div className="space-y-3 pb-4 border-b">
          <div className="text-sm font-semibold text-muted-foreground">Strategy Types</div>
          <div className="space-y-2">
            {strategies.map((strategy) => (
              <div key={strategy.type} className="rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between pb-2 border-b">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize text-xs font-semibold">
                      {strategy.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{strategy.count} strat</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 text-xs md:grid-cols-4">
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Win Rate</span>
                    <span className="font-semibold text-sm">{(strategy.winRate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Drawdown</span>
                    <span className={`font-semibold text-sm ${strategy.drawdown > 20 ? "text-red-600" : strategy.drawdown > 10 ? "text-orange-600" : "text-green-600"}`}>
                      {strategy.drawdown.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Time (h)</span>
                    <span className="font-semibold text-sm">{strategy.drawdownHours.toFixed(1)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">PF Avg</span>
                    <span className={`font-semibold text-sm ${((strategy.profitFactor250 + strategy.profitFactor50) / 2) >= 1.5 ? "text-green-600" : ((strategy.profitFactor250 + strategy.profitFactor50) / 2) >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {((strategy.profitFactor250 + strategy.profitFactor50) / 2).toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-3 border-t mt-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PF (250)</span>
                    <span className={`font-semibold ${strategy.profitFactor250 >= 1.5 ? "text-green-600" : strategy.profitFactor250 >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {strategy.profitFactor250.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PF (50)</span>
                    <span className={`font-semibold ${strategy.profitFactor50 >= 1.5 ? "text-green-600" : strategy.profitFactor50 >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {strategy.profitFactor50.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* INDICATIONS - direction/move/active/optimal types (INDEPENDENT from strategies) */}
        <div className="space-y-3 pb-4 border-b">
          <div className="text-sm font-semibold text-muted-foreground">Indication Types</div>
          <div className="space-y-2">
            {indications.map((indication) => (
              <div key={indication.type} className="rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between pb-2 border-b">
                  <div className="flex items-center gap-2">
                    <Badge 
                      variant="outline" 
                      className={`capitalize text-xs font-semibold ${
                        indication.type === "direction" ? "border-blue-500 text-blue-600" :
                        indication.type === "move" ? "border-green-500 text-green-600" :
                        indication.type === "active" ? "border-orange-500 text-orange-600" :
                        "border-purple-500 text-purple-600"
                      }`}
                    >
                      {indication.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{indication.totalCount} signals</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {indication.lastTrigger ? indication.lastTrigger.toLocaleTimeString() : "Never"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 text-xs md:grid-cols-3">
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Signal Strength</span>
                    <span className={`font-semibold text-sm ${indication.avgSignalStrength >= 0.7 ? "text-green-600" : indication.avgSignalStrength >= 0.4 ? "text-yellow-600" : "text-red-600"}`}>
                      {indication.avgSignalStrength.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Profit Factor</span>
                    <span className={`font-semibold text-sm ${indication.profitFactor >= 1.5 ? "text-green-600" : indication.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
                      {indication.profitFactor.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground text-xs">Total Count</span>
                    <span className="font-semibold text-sm">{indication.totalCount}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* SYMBOLS - Live positions and metrics */}
        {symbols.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-semibold text-muted-foreground">Symbols Overview ({symbols.length})</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {symbols.map((symbol) => (
                <div key={symbol.symbol} className="rounded-lg border bg-card px-2 py-2 text-center hover:bg-card/80 transition-colors min-w-0">
                  <div className="font-semibold text-xs truncate" title={symbol.symbol}>{symbol.symbol}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {symbol.livePositions} live
                  </div>
                  <div className="text-[11px] mt-1 leading-tight">
                    <div className={symbol.profitFactor250 >= 1.5 ? "text-green-600" : symbol.profitFactor250 >= 1.0 ? "text-blue-600" : "text-red-600"}>
                      PF250: {symbol.profitFactor250.toFixed(1)}
                    </div>
                    <div className={symbol.profitFactor50 >= 1.5 ? "text-green-600" : symbol.profitFactor50 >= 1.0 ? "text-blue-600" : "text-red-600"}>
                      PF50: {symbol.profitFactor50.toFixed(1)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer note explaining the architecture */}
        <div className="pt-4 border-t">
          <div className="text-xs text-muted-foreground">
            <strong>Strategies</strong> (base, main, real, live) are complexity levels for trading strategies evaluated on pseudo positions.
            <br />
            <strong>Indications</strong> (direction, move, active, optimal) are independent signal types that drive strategy evaluation.
            <br />
            Direction (trend reversals) • Move (volatility) • Active (volume/activity) • Optimal (combined signals)
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
