"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown } from "lucide-react"

interface CompactStats {
  performance: {
    last250: { winRate: number; profitFactor: number; profit: number }
    last50: { winRate: number; profitFactor: number; profit: number }
  }
  engines: {
    cycles: number
    avgDuration: number
    active: number
  }
}

export function StatisticsOverviewV2() {
  const [stats, setStats] = useState<CompactStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStats()
    const interval = setInterval(loadStats, 10000)
    return () => clearInterval(interval)
  }, [])

  const loadStats = async () => {
    try {
      const [perfRes, engineRes] = await Promise.allSettled([
        fetch("/api/trading/stats", { cache: "no-store" }),
        fetch("/api/trade-engine/status", { cache: "no-store" }),
      ])

      let performance = { last250: { winRate: 0, profitFactor: 0, profit: 0 }, last50: { winRate: 0, profitFactor: 0, profit: 0 } }
      let engines = { cycles: 0, avgDuration: 0, active: 0 }

      if (perfRes.status === "fulfilled" && perfRes.value.ok) {
        const data = await perfRes.value.json()
        performance = {
          last250: {
            winRate: data.last250?.winRate || 0,
            profitFactor: data.last250?.profitFactor || 0,
            profit: data.last250?.totalProfit || 0,
          },
          last50: {
            winRate: data.last50?.winRate || 0,
            profitFactor: data.last50?.profitFactor || 0,
            profit: data.last50?.totalProfit || 0,
          },
        }
      }

      if (engineRes.status === "fulfilled" && engineRes.value.ok) {
        const data = await engineRes.value.json()
        engines = {
          cycles: data.cycles_total || 0,
          avgDuration: data.avg_cycle_ms || 0,
          active: data.active_positions || 0,
        }
      }

      setStats({ performance, engines })
      setLoading(false)
    } catch (err) {
      console.error("[Stats] Error:", err)
      setLoading(false)
    }
  }

  if (loading || !stats) return null

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5 lg:grid-cols-7 text-xs">
          {/* Last 250 Win Rate */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 250</span>
            <span className={`font-bold ${stats.performance.last250.winRate >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.performance.last250.winRate * 100).toFixed(0)}%
            </span>
          </div>

          {/* Last 250 Profit Factor */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 250</span>
            <span className={`font-bold ${stats.performance.last250.profitFactor >= 1.5 ? "text-green-600" : stats.performance.last250.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.performance.last250.profitFactor.toFixed(1)}
            </span>
          </div>

          {/* Last 50 Win Rate */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 50</span>
            <span className={`font-bold ${stats.performance.last50.winRate >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.performance.last50.winRate * 100).toFixed(0)}%
            </span>
          </div>

          {/* Last 50 Profit Factor */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 50</span>
            <span className={`font-bold ${stats.performance.last50.profitFactor >= 1.5 ? "text-green-600" : stats.performance.last50.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.performance.last50.profitFactor.toFixed(1)}
            </span>
          </div>

          {/* Engine Cycles */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Cycles</span>
            <span className="font-bold text-blue-600">{stats.engines.cycles}</span>
          </div>

          {/* Avg Duration */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Dur (ms)</span>
            <span className={`font-bold ${stats.engines.avgDuration <= 1000 ? "text-green-600" : "text-orange-600"}`}>
              {stats.engines.avgDuration}
            </span>
          </div>

          {/* Active Positions */}
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Active</span>
            <span className="font-bold text-purple-600">{stats.engines.active}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
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
