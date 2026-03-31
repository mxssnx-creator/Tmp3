"use client"


export const dynamic = "force-dynamic"
// Page with sidebar and exchange selector
import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { IndicationRowCompact } from "@/components/indications/indication-row-compact"
import { IndicationFiltersAdvanced } from "@/components/indications/indication-filters-advanced"
import { Activity, TrendingUp, Zap, RefreshCw, Download, BarChart3 } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { useIndicationUpdates } from "@/lib/use-websocket"
import { PageHeader } from "@/components/page-header"

interface Indication {
  id: string
  symbol: string
  indicationType: string
  direction: "UP" | "DOWN" | "NEUTRAL"
  confidence: number
  strength: number
  timestamp: string
  enabled: boolean
  metadata?: {
    macdValue?: number
    rsiValue?: number
    maValue?: number
    bbUpper?: number
    bbLower?: number
    volatility?: number
  }
}

interface AdvancedFiltersInd {
  symbols: string[]
  symbolInput: string
  indicationTypes: string[]
  directions: string[]
  confidenceRange: [number, number]
  strengthRange: [number, number]
  timeRange: [number, number]
  enabledOnly: boolean
  sortBy: "confidence" | "strength" | "recent"
}

const initialFilters: AdvancedFiltersInd = {
  symbols: [],
  symbolInput: "",
  indicationTypes: [],
  directions: [],
  confidenceRange: [0, 100],
  strengthRange: [0, 100],
  timeRange: [0, 60],
  enabledOnly: false,
  sortBy: "confidence",
}

export default function IndicationsPage() {
  const { selectedConnectionId } = useExchange()
  const [indications, setIndications] = useState<Indication[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [filters, setFilters] = useState<AdvancedFiltersInd>(initialFilters)

  // Load indications on mount and when connection changes
  useEffect(() => {
    const loadIndications = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = selectedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/indications?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch indications: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setIndications(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Indications] Failed to load:", error)
        toast.error("Failed to load indications")
        setIndications([])
      } finally {
        setIsLoading(false)
      }
    }

    loadIndications()
  }, [selectedConnectionId])

  // Handle real-time indication updates via SSE
  const handleIndicationUpdate = useCallback((update: any) => {
    setIndications((prev) => {
      // Check if indication already exists
      const existingIndex = prev.findIndex((i) => i.id === update.id)
      if (existingIndex >= 0) {
        // Update existing indication
        const updated = [...prev]
        updated[existingIndex] = {
          ...updated[existingIndex],
          direction: update.direction || updated[existingIndex].direction,
          confidence: update.confidence || updated[existingIndex].confidence,
          strength: update.strength || updated[existingIndex].strength,
          timestamp: update.timestamp || new Date().toISOString(),
        }
        return updated
      } else {
        // Add new indication if not in demo mode
        if (!isDemo) {
          const newIndication: Indication = {
            id: update.id,
            symbol: update.symbol,
            indicationType: 'auto',
            direction: update.direction || 'NEUTRAL',
            confidence: update.confidence || 0,
            strength: update.strength || 0,
            timestamp: update.timestamp || new Date().toISOString(),
            enabled: true,
          }
          return [newIndication, ...prev]
        }
        return prev
      }
    })
  }, [isDemo])

  // Subscribe to indication updates via SSE
  useIndicationUpdates(
    selectedConnectionId && selectedConnectionId !== "demo-mode" ? selectedConnectionId : "",
    handleIndicationUpdate
  )

  // Apply filters and sorting with memoization
  const filteredAndSortedIndications = useMemo(() => {
    let result = [...indications]

    // Apply filters
    result = result.filter((ind) => {
      // Symbol filter
      if (filters.symbols.length > 0 && !filters.symbols.includes(ind.symbol)) return false

      // Type filter
      if (filters.indicationTypes.length > 0 && !filters.indicationTypes.includes(ind.indicationType)) return false

      // Direction filter
      if (filters.directions.length > 0 && !filters.directions.includes(ind.direction)) return false

      // Confidence range
      if (ind.confidence < filters.confidenceRange[0] || ind.confidence > filters.confidenceRange[1]) return false

      // Strength range
      if (ind.strength < filters.strengthRange[0] || ind.strength > filters.strengthRange[1]) return false

      // Time range (minutes)
      const minutesOld = (Date.now() - new Date(ind.timestamp).getTime()) / (1000 * 60)
      if (minutesOld > filters.timeRange[1]) return false

      // Enabled only
      if (filters.enabledOnly && !ind.enabled) return false

      return true
    })

    // Apply sorting
    switch (filters.sortBy) {
      case "confidence":
        result.sort((a, b) => b.confidence - a.confidence)
        break
      case "strength":
        result.sort((a, b) => b.strength - a.strength)
        break
      case "recent":
        result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        break
    }

    return result
  }, [indications, filters])

  // Calculate statistics
  const stats = useMemo(() => {
    const total = indications.length
    const enabled = indications.filter((i) => i.enabled).length
    const upSignals = indications.filter((i) => i.direction === "UP").length
    const highConfidence = indications.filter((i) => i.confidence >= 70).length
    const avgConfidence = total > 0 ? indications.reduce((sum, i) => sum + i.confidence, 0) / total : 0

    return { total, enabled, upSignals, highConfidence, avgConfidence }
  }, [indications])

  if (isLoading) {
    return (
     <div className="flex items-center justify-center min-h-screen">
         <div className="text-center">
           <div className="animate-spin rounded-full h-8 w-8 border border-slate-400 border-t-cyan-600 mx-auto mb-4"></div>
           <p className="text-muted-foreground">Loading indications...</p>
         </div>
       </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Indications" description="Trading signals with confidence and strength metrics" />
      <div className="p-4 space-y-4">
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
           { icon: Activity, label: "Enabled", value: stats.enabled, color: "text-green-600" },
           { icon: TrendingUp, label: "Bullish", value: stats.upSignals, color: "text-orange-600" },
           { icon: Zap, label: "High Conf", value: stats.highConfidence, color: "text-yellow-600" },
           { icon: Activity, label: "Avg Conf", value: stats.avgConfidence.toFixed(1) + "%", color: "text-cyan-600" },
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
          <IndicationFiltersAdvanced filters={filters} onFiltersChange={setFilters} />
        </div>

         {/* Results */}
         <div className="lg:col-span-4 space-y-3">
           {/* Results header */}
           <div className="flex items-center justify-between text-xs px-3 py-2 bg-slate-50 rounded border border-border">
             <div className="text-muted-foreground">
               Showing <span className="font-semibold text-cyan-600">{filteredAndSortedIndications.length}</span> of <span className="font-semibold">{indications.length}</span> indications
             </div>
             <div className="text-muted-foreground">
              {filters.sortBy === "recent" && "Sorted by: Most Recent"}
              {filters.sortBy === "confidence" && "Sorted by: Confidence"}
              {filters.sortBy === "strength" && "Sorted by: Strength"}
            </div>
          </div>

          {/* Results list */}
          <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
            {filteredAndSortedIndications.length > 0 ? (
              filteredAndSortedIndications.map((indication, index) => (
                <IndicationRowCompact
                  key={indication.id}
                  indication={indication}
                  onToggle={(id, enabled) => {
                    setIndications((prev) =>
                      prev.map((ind) => (ind.id === id ? { ...ind, enabled } : ind))
                    )
                    toast.success(`Indication ${enabled ? "enabled" : "disabled"}`)
                  }}
                  index={index}
                />
              ))
             ) : (
               <div className="text-center py-12 text-muted-foreground">
                 <div className="text-sm mb-2">No indications match your filters</div>
                <Button variant="outline" size="sm" onClick={() => setFilters(initialFilters)} className="text-xs h-7">
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
