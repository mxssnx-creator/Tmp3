"use client"


export const dynamic = "force-dynamic"
// Page with sidebar and exchange selector
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PositionRowCompact } from "@/components/live-trading/position-row-compact"
import { Activity, TrendingUp, TrendingDown, RefreshCw, Play, Pause, AlertCircle, BarChart3 } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { usePositionUpdates } from "@/lib/use-websocket"
import { PageHeader } from "@/components/page-header"

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  takeProfitPrice?: number
  stopLossPrice?: number
  createdAt: string
  status: "open" | "closing" | "closed"
}

export default function LiveTradingPage() {
  const { selectedConnectionId } = useExchange()
  const [positions, setPositions] = useState<Position[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isEngineRunning, setIsEngineRunning] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [sortBy, setSortBy] = useState<"pnl" | "entry" | "time">("pnl")
  const [filterSide, setFilterSide] = useState<"all" | "long" | "short">("all")

  // Load positions on mount and when connection changes
  useEffect(() => {
    const loadPositions = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = selectedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/positions?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch positions: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setPositions(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Live Trading] Failed to load:", error)
        toast.error("Failed to load positions")
        setPositions([])
      } finally {
        setIsLoading(false)
      }
    }

    loadPositions()
  }, [selectedConnectionId])

  // Handle real-time position updates via SSE
  const handlePositionUpdate = useCallback((update: any) => {
    setPositions((prev) => {
      // Find existing position and update it, or add new one
      const existingIndex = prev.findIndex((p) => p.id === update.id)
      if (existingIndex >= 0) {
        // Update existing position
        const updated = [...prev]
        updated[existingIndex] = {
          ...updated[existingIndex],
          currentPrice: update.currentPrice,
          unrealizedPnl: update.unrealizedPnl,
          unrealizedPnlPercent: update.unrealizedPnlPercent,
          status: update.status || updated[existingIndex].status,
        }
        return updated
      } else {
        // Add new position if not in demo mode
        if (!isDemo) {
          return [
            ...prev,
            {
              id: update.id,
              symbol: update.symbol,
              side: 'LONG',
              entryPrice: update.currentPrice,
              currentPrice: update.currentPrice,
              quantity: 1,
              leverage: 1,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
              createdAt: new Date().toISOString(),
              status: update.status || 'open',
            },
          ]
        }
        return prev
      }
    })
  }, [isDemo])

  // Subscribe to position updates via SSE
  usePositionUpdates(
    selectedConnectionId && selectedConnectionId !== "demo-mode" ? selectedConnectionId : "",
    handlePositionUpdate
  )

  // Simulate real-time price updates (fallback for demo mode)
  useEffect(() => {
    if (!isEngineRunning) return

    const interval = setInterval(() => {
      setPositions((prev) =>
        prev.map((pos) => {
          const priceChange = (Math.random() - 0.5) * 50
          const newPrice = Math.max(1, pos.currentPrice + priceChange)
          const newPnl = (newPrice - pos.entryPrice) * pos.quantity * pos.leverage
          const newPnlPercent = ((newPrice - pos.entryPrice) / pos.entryPrice) * 100

          return {
            ...pos,
            currentPrice: newPrice,
            unrealizedPnl: newPnl,
            unrealizedPnlPercent: newPnlPercent,
          }
        })
      )
    }, 2000)

    return () => clearInterval(interval)
  }, [isEngineRunning])

  // Apply filters and sorting
  const filteredAndSortedPositions = useMemo(() => {
    let result = [...positions]

    // Filter by side
    if (filterSide !== "all") {
      result = result.filter((p) => p.side.toLowerCase() === filterSide)
    }

    // Sort
    switch (sortBy) {
      case "pnl":
        result.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl)
        break
      case "entry":
        result.sort((a, b) => b.entryPrice - a.entryPrice)
        break
      case "time":
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
    }

    return result
  }, [positions, sortBy, filterSide])

  // Calculate stats
  const stats = useMemo(() => {
    const total = positions.length
    const longs = positions.filter((p) => p.side === "LONG").length
    const shorts = positions.filter((p) => p.side === "SHORT").length
    const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
    const profitablePositions = positions.filter((p) => p.unrealizedPnl > 0).length
    const totalCapital = positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0)

    return { total, longs, shorts, totalPnl, profitablePositions, totalCapital }
  }, [positions])

   if (isLoading) {
     return (
       <div className="flex items-center justify-center min-h-screen">
         <div className="text-center">
           <div className="animate-spin rounded-full h-8 w-8 border border-slate-400 border-t-cyan-600 mx-auto mb-4"></div>
           <p className="text-muted-foreground">Loading positions...</p>
         </div>
       </div>
     )
   }

  return (
    <div className="space-y-4">
      <PageHeader title="Live Trading" description="Real-time position monitoring and management" />
      <div className="p-4 space-y-4">
      <div className="flex gap-2">
        <Button
          variant={isEngineRunning ? "default" : "outline"}
          size="sm"
          onClick={() => setIsEngineRunning(!isEngineRunning)}
          className="h-8 text-xs"
        >
            {isEngineRunning ? (
              <>
                <Pause className="h-3 w-3 mr-1" />
                Stop Simulation
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1" />
                Start Simulation
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Engine status */}
      {isEngineRunning && (
        <div className="bg-green-500/10 border border-green-500/20 rounded p-3">
          <div className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-green-400 animate-pulse flex-shrink-0" />
            <span className="text-green-200">Live trading engine running - prices updating in real-time</span>
          </div>
        </div>
      )}

       {/* Stats cards */}
       <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
         {[
           { icon: BarChart3, label: "Open", value: stats.total, color: "text-blue-600" },
           { icon: TrendingUp, label: "Long", value: stats.longs, color: "text-green-600" },
           { icon: TrendingDown, label: "Short", value: stats.shorts, color: "text-red-600" },
           { icon: Activity, label: "Profitable", value: stats.profitablePositions, color: "text-yellow-600" },
           { icon: AlertCircle, label: "Total PnL", value: stats.totalPnl.toFixed(2) + " USDT", color: stats.totalPnl >= 0 ? "text-green-600" : "text-red-600" },
           { icon: BarChart3, label: "Capital", value: "$" + (stats.totalCapital / 1000).toFixed(0) + "k", color: "text-cyan-600" },
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

       {/* Filters and controls */}
       <div className="flex items-center justify-between text-xs px-3 py-2 bg-slate-50 rounded border border-border">
         <div className="text-muted-foreground">
           Showing <span className="font-semibold text-cyan-600">{filteredAndSortedPositions.length}</span> positions
         </div>
        <div className="flex gap-2">
          <div className="flex gap-1">
            <Button
              variant={filterSide === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterSide("all")}
              className="h-7 text-xs"
            >
              All
            </Button>
            <Button
              variant={filterSide === "long" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterSide("long")}
              className="h-7 text-xs"
            >
              Long
            </Button>
            <Button
              variant={filterSide === "short" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterSide("short")}
              className="h-7 text-xs"
            >
              Short
            </Button>
          </div>
          <div className="border-l border-border pl-2 flex gap-1">
            <Button
              variant={sortBy === "pnl" ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy("pnl")}
              className="h-7 text-xs"
            >
              PnL
            </Button>
            <Button
              variant={sortBy === "entry" ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy("entry")}
              className="h-7 text-xs"
            >
              Entry
            </Button>
            <Button
              variant={sortBy === "time" ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy("time")}
              className="h-7 text-xs"
            >
              Time
            </Button>
          </div>
        </div>
      </div>

      {/* Positions list */}
      <div className="space-y-1.5 max-h-[calc(100vh-350px)] overflow-y-auto">
        {filteredAndSortedPositions.length > 0 ? (
          filteredAndSortedPositions.map((position, index) => (
            <PositionRowCompact
              key={position.id}
              position={position}
              onClose={(id) => {
                setPositions((prev) => prev.filter((p) => p.id !== id))
                toast.success("Position closed")
              }}
              onModify={(id) => {
                toast.info("Position modification UI would open here")
              }}
              index={index}
            />
          ))
         ) : (
           <div className="text-center py-12 text-muted-foreground">
             <div className="text-sm">No positions found</div>
           </div>
         )}
      </div>
    </div>
  )
}
