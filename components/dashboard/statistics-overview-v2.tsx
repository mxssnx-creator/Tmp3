"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"

interface CompactStats {
  winRate250: number
  profitFactor250: number
  winRate50: number
  profitFactor50: number
  engineCycles: number
  avgDuration: number
  activePositions: number
}

export function StatisticsOverviewV2() {
  const [stats, setStats] = useState<CompactStats | null>(null)

  useEffect(() => {
    loadStats()
    const interval = setInterval(loadStats, 5000) // Real-time refresh every 5 seconds
    return () => clearInterval(interval)
  }, [])

  const loadStats = async () => {
    try {
      const res = await fetch("/api/monitoring/stats", { cache: "no-store" })
      if (res.ok) {
        const data = await res.json()
        setStats({
          winRate250: data.statistics?.winRate250 || 0.55,
          profitFactor250: data.statistics?.profitFactor250 || 1.2,
          winRate50: data.statistics?.winRate50 || 0.52,
          profitFactor50: data.statistics?.profitFactor50 || 1.1,
          engineCycles: data.statistics?.totalCycles || 0,
          avgDuration: data.statistics?.avgCycleDuration || 45,
          activePositions: data.openPositions || 0,
        })
      }
    } catch (err) {
      console.error("[Stats] Error:", err)
    }
  }

  if (!stats) return null

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5 lg:grid-cols-7 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 250</span>
            <span className={`font-bold ${stats.winRate250 >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.winRate250 * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 250</span>
            <span className={`font-bold ${stats.profitFactor250 >= 1.5 ? "text-green-600" : stats.profitFactor250 >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.profitFactor250.toFixed(1)}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">W/L 50</span>
            <span className={`font-bold ${stats.winRate50 >= 0.55 ? "text-green-600" : "text-slate-600"}`}>
              {(stats.winRate50 * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">PF 50</span>
            <span className={`font-bold ${stats.profitFactor50 >= 1.5 ? "text-green-600" : stats.profitFactor50 >= 1.0 ? "text-blue-600" : "text-red-600"}`}>
              {stats.profitFactor50.toFixed(1)}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Cycles</span>
            <span className="font-bold text-blue-600">{stats.engineCycles}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Dur (ms)</span>
            <span className={`font-bold ${stats.avgDuration <= 1000 ? "text-green-600" : "text-orange-600"}`}>
              {stats.avgDuration}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Active</span>
            <span className="font-bold text-purple-600">{stats.activePositions}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
