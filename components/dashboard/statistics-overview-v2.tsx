"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"

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
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 250</span>
            <span className={`font-bold ${stats.performance.last250.winRate >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.performance.last250.winRate * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 250</span>
            <span className={`font-bold ${stats.performance.last250.profitFactor >= 1.5 ? "text-green-600" : stats.performance.last250.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.performance.last250.profitFactor.toFixed(1)}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 50</span>
            <span className={`font-bold ${stats.performance.last50.winRate >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.performance.last50.winRate * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 50</span>
            <span className={`font-bold ${stats.performance.last50.profitFactor >= 1.5 ? "text-green-600" : stats.performance.last50.profitFactor >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.performance.last50.profitFactor.toFixed(1)}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Cycles</span>
            <span className="font-bold text-blue-600">{stats.engines.cycles}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Dur (ms)</span>
            <span className={`font-bold ${stats.engines.avgDuration <= 1000 ? "text-green-600" : "text-orange-600"}`}>
              {stats.engines.avgDuration}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Active</span>
            <span className="font-bold text-purple-600">{stats.engines.active}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
