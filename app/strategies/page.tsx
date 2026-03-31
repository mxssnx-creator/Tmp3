"use client"


export const dynamic = "force-dynamic"
// Page with sidebar and exchange selector
import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { StrategyRowCompact } from "@/components/strategies/strategy-row-compact"
import { StrategyFiltersAdvanced } from "@/components/strategies/strategy-filters-advanced"
import { StrategyEngine } from "@/lib/strategies"
import type { StrategyResult } from "@/lib/strategies"
import { Activity, TrendingUp, BarChart3, Settings, RefreshCw, Target, Download } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { PageHeader } from "@/components/page-header"
import { useStrategyUpdates } from "@/lib/use-websocket"

// Define advanced filter type
interface AdvancedFilters {
  dateFrom: string
  dateTo: string
  symbols: string[]
  symbolInput: string
  indicationTypes: string[]
  strategyTypes: string[]
  tpRange: [number, number]
  slRange: [number, number]
  volRange: [number, number]
  profitFactorMin: number
  winRateMin: number
  trailingOnly: boolean
  activeOnly: boolean
  validOnly: boolean
}

const initialAdvancedFilters: AdvancedFilters = {
  dateFrom: "",
  dateTo: "",
  symbols: [],
  symbolInput: "",
  indicationTypes: [],
  strategyTypes: [],
  tpRange: [0, 20],
  slRange: [0, 5],
  volRange: [0.5, 5],
  profitFactorMin: 0,
  winRateMin: 0,
  trailingOnly: false,
  activeOnly: false,
  validOnly: false,
}

export default function StrategiesPage() {
  const { selectedConnectionId } = useExchange()
  const [strategies, setStrategies] = useState<StrategyResult[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [filters, setFilters] = useState<AdvancedFilters>(initialAdvancedFilters)
  const [sortBy, setSortBy] = useState<"profit" | "trades" | "active">("profit")
  const [isLoading, setIsLoading] = useState(true)

  // Load strategies on component mount and when connection changes
  useEffect(() => {
    const loadStrategies = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = selectedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/strategies?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch strategies: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setStrategies(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Strategies] Failed to load:", error)
        toast.error("Failed to load strategies")
        setStrategies([])
      } finally {
        setIsLoading(false)
      }
    }

    loadStrategies()
  }, [selectedConnectionId])

  // Handle real-time strategy updates via SSE
  const handleStrategyUpdate = useCallback((update: any) => {
    setStrategies((prev) => {
      // Update strategies that match the symbol
      return prev.map((s) => {
        // Check if this is the strategy being updated
        if (s.name === update.symbol) {
          return {
            ...s,
            avg_profit_factor: update.profit_factor || s.avg_profit_factor,
            stats: {
              ...s.stats,
              win_rate: update.win_rate || s.stats.win_rate,
            },
          }
        }
        return s
      })
    })
  }, [])

  // Subscribe to strategy updates via SSE
  useStrategyUpdates(
    selectedConnectionId && selectedConnectionId !== "demo-mode" ? selectedConnectionId : "",
    handleStrategyUpdate
  )

  // Apply advanced filters with memoization for performance
  const filteredAndSortedStrategies = useMemo(() => {
    let result = [...strategies]

    // Apply filters
    result = result.filter((strategy) => {
      // Profit factor filter
      if (strategy.avg_profit_factor < filters.profitFactorMin) return false

      // TP/SL coordinate range filters
      if (strategy.config.takeprofit_factor < filters.tpRange[0] || strategy.config.takeprofit_factor > filters.tpRange[1]) return false
      if (strategy.config.stoploss_ratio < filters.slRange[0] || strategy.config.stoploss_ratio > filters.slRange[1]) return false

      // Volume range filter
      if (strategy.volume_factor < filters.volRange[0] || strategy.volume_factor > filters.volRange[1]) return false

      // Win rate filter (simulated from profit factor)
      const simulatedWinRate = Math.max(0, Math.min(100, (strategy.avg_profit_factor + 2) * 25))
      if (simulatedWinRate < filters.winRateMin) return false

      // Toggle filters
      if (filters.trailingOnly && !strategy.config.trailing_enabled) return false
      if (filters.activeOnly && !strategy.isActive) return false
      if (filters.validOnly && strategy.validation_state !== "valid") return false

      // Strategy type filter
      if (filters.strategyTypes.length > 0) {
        const strategyTypeName = strategy.name.split(" ")[0]
        if (!filters.strategyTypes.some((t) => strategyTypeName.includes(t))) return false
      }

      return true
    })

    // Apply sorting
    switch (sortBy) {
      case "profit":
        result.sort((a, b) => b.avg_profit_factor - a.avg_profit_factor)
        break
      case "trades":
        result.sort((a, b) => b.stats.positions_per_day - a.stats.positions_per_day)
        break
      case "active":
        result.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0))
        break
    }

    return result
  }, [strategies, filters, sortBy])

  // Calculate statistics with memoization
  const stats = useMemo(() => {
    const total = strategies.length
    const active = strategies.filter((s) => s.isActive).length
    const valid = strategies.filter((s) => s.validation_state === "valid").length
    const profitable = strategies.filter((s) => s.avg_profit_factor >= 0.4).length
    const avgProfitFactor = total > 0 ? strategies.reduce((sum, s) => sum + s.avg_profit_factor, 0) / total : 0

    return { total, active, valid, profitable, avgProfitFactor }
  }, [strategies])

   if (isLoading) {
     return (
       <div className="flex items-center justify-center min-h-screen">
         <div className="text-center">
           <div className="animate-spin rounded-full h-8 w-8 border b-2 border-slate-400 border-t-cyan-600 mx-auto mb-4"></div>
           <p className="text-muted-foreground">Loading strategies...</p>
         </div>
       </div>
     )
   }

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      {isDemo && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded p-3 mx-4 mt-4">
          <div className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <span className="text-amber-200">Using demo data - switch to a real exchange connection to see live strategies</span>
          </div>
        </div>
      )}

      <PageHeader title="Strategies" description="Advanced filtering, coordination analysis, and performance metrics" />
      <div className="p-4 space-y-4">
      <div className="flex gap-2">
         </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Download className="h-3 w-3 mr-1" />
            Export
          </Button>
        </div>
      </div>

       {/* Stats cards - compact */}
       <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
         {[
           { icon: BarChart3, label: "Total", value: stats.total, color: "text-blue-600" },
           { icon: Activity, label: "Active", value: stats.active, color: "text-green-600" },
           { icon: Target, label: "Valid", value: stats.valid, color: "text-purple-600" },
           { icon: TrendingUp, label: "Profitable", value: stats.profitable, color: "text-orange-600" },
           { icon: Settings, label: "Avg PF", value: stats.avgProfitFactor.toFixed(2), color: "text-cyan-600" },
         ].map((stat) => (
           <Card key={stat.label} className="border-border bg-slate-50">
             <CardContent className="p-2">
               <div className="flex items-center gap-2">
                 <stat.icon className={`h-3 w-3 ${stat.color}`} />
                 <div className="min-w-0">
                   <div className={`text-lg font-bold ${stat.color}`}>{stat.value}</div>
                   <div className="text-xs text-muted-foreground">{stat.label}</div>
                 </div>
               </div>
             </CardContent>
           </Card>
         ))}
       </div>

      {/* Main content - filters and results */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Filters sidebar */}
        <div className="lg:col-span-1">
          <StrategyFiltersAdvanced filters={filters} onFiltersChange={setFilters} />
        </div>

         {/* Results */}
         <div className="lg:col-span-4 space-y-3">
           {/* Results header */}
           <div className="flex items-center justify-between text-xs">
             <div className="text-muted-foreground">
               Showing <span className="font-semibold text-cyan-600">{filteredAndSortedStrategies.length}</span> of <span className="font-semibold">{strategies.length}</span> strategies
             </div>
            <div className="flex gap-2">
              <Button
                variant={sortBy === "profit" ? "default" : "outline"}
                size="sm"
                onClick={() => setSortBy("profit")}
                className="h-7 text-xs"
              >
                Profit
              </Button>
              <Button
                variant={sortBy === "trades" ? "default" : "outline"}
                size="sm"
                onClick={() => setSortBy("trades")}
                className="h-7 text-xs"
              >
                Trades/Day
              </Button>
              <Button
                variant={sortBy === "active" ? "default" : "outline"}
                size="sm"
                onClick={() => setSortBy("active")}
                className="h-7 text-xs"
              >
                Active
              </Button>
            </div>
          </div>

          {/* Results list */}
          <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
            {filteredAndSortedStrategies.length > 0 ? (
              filteredAndSortedStrategies.map((strategy, index) => (
                <StrategyRowCompact
                  key={strategy.id}
                  strategy={strategy}
                  onToggle={(id, active) => {
                    setStrategies((prev) =>
                      prev.map((s) => (s.id === id ? { ...s, isActive: active } : s))
                    )
                    toast.success(`Strategy ${active ? "activated" : "deactivated"}`)
                  }}
                  minimalProfitFactor={0.4}
                  index={index}
                />
              ))
            ) : (
              <div className="text-center py-12 text-slate-500">
                <div className="text-sm mb-2">No strategies match your filters</div>
                <Button variant="outline" size="sm" onClick={() => setFilters(initialAdvancedFilters)} className="text-xs h-7">
                  Reset Filters
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
