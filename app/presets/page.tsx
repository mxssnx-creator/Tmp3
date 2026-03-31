"use client"


export const dynamic = "force-dynamic"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { useState, useMemo, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PresetCardCompact } from "@/components/presets/preset-card-compact"
import { Plus, RefreshCw, Download, BarChart3 } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

export default function PresetsPage() {
  const { selectedConnectionId } = useExchange()
  const [presets, setPresets] = useState<PresetTemplate[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [sortBy, setSortBy] = useState<"name" | "profit" | "winrate">("profit")
  const [filterType, setFilterType] = useState<string | null>(null)

  // Load presets on mount and when connection changes
  useEffect(() => {
    const loadPresets = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = selectedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/presets?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch presets: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setPresets(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Presets] Failed to load:", error)
        toast.error("Failed to load presets")
        setPresets([])
      } finally {
        setIsLoading(false)
      }
    }

    loadPresets()
  }, [selectedConnectionId])

  const strategyTypes = Array.from(new Set(presets.map((p) => p.strategyType)))

  const filteredAndSorted = useMemo(() => {
    let result = [...presets]

    if (filterType) {
      result = result.filter((p) => p.strategyType === filterType)
    }

    switch (sortBy) {
      case "profit":
        result.sort((a, b) => b.stats.avgProfit - a.stats.avgProfit)
        break
      case "winrate":
        result.sort((a, b) => b.stats.winRate - a.stats.winRate)
        break
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name))
        break
    }

    return result
  }, [presets, sortBy, filterType])

  const stats = useMemo(() => {
    const total = presets.length
    const enabled = presets.filter((p) => p.enabled).length
    const avgProfit = presets.reduce((sum, p) => sum + p.stats.avgProfit, 0) / total
    const avgWinRate = presets.reduce((sum, p) => sum + p.stats.winRate, 0) / total

    return { total, enabled, avgProfit, avgWinRate }
  }, [presets])

  return (
    <div className="space-y-4 p-4">
       {/* Header */}
       <div className="flex items-center justify-between">
         <div>
           <h1 className="text-2xl font-bold">Trading Presets</h1>
           <p className="text-xs text-muted-foreground mt-1">Pre-configured strategy templates</p>
         </div>
        <div className="flex gap-2">
          <Button size="sm" className="h-8 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            New Preset
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

       {/* Stats */}
       <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
         {[
           { label: "Total", value: stats.total, color: "text-blue-600" },
           { label: "Enabled", value: stats.enabled, color: "text-green-600" },
           { label: "Avg Profit", value: stats.avgProfit.toFixed(2) + "%", color: stats.avgProfit > 0 ? "text-green-600" : "text-red-600" },
           { label: "Avg WR", value: stats.avgWinRate.toFixed(0) + "%", color: "text-cyan-600" },
         ].map((stat) => (
           <Card key={stat.label} className="border-border bg-slate-50">
             <CardContent className="p-2">
               <div className={`text-lg font-bold ${stat.color}`}>{stat.value}</div>
               <div className="text-xs text-muted-foreground">{stat.label}</div>
             </CardContent>
           </Card>
         ))}
       </div>

       {/* Filters */}
       <div className="flex items-center justify-between text-xs px-3 py-2 bg-slate-50 rounded border border-border">
        <div className="flex gap-1">
          <Button
            variant={filterType === null ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType(null)}
            className="h-7 text-xs"
          >
            All ({presets.length})
          </Button>
          {strategyTypes.map((type) => (
            <Button
              key={type}
              variant={filterType === type ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterType(type)}
              className="h-7 text-xs"
            >
              {type} ({presets.filter((p) => p.strategyType === type).length})
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          <Button
            variant={sortBy === "profit" ? "default" : "outline"}
            size="sm"
            onClick={() => setSortBy("profit")}
            className="h-7 text-xs"
          >
            Profit
          </Button>
          <Button
            variant={sortBy === "winrate" ? "default" : "outline"}
            size="sm"
            onClick={() => setSortBy("winrate")}
            className="h-7 text-xs"
          >
            Win Rate
          </Button>
          <Button
            variant={sortBy === "name" ? "default" : "outline"}
            size="sm"
            onClick={() => setSortBy("name")}
            className="h-7 text-xs"
          >
            Name
          </Button>
        </div>
      </div>

      {/* Presets list */}
      <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
        {filteredAndSorted.length > 0 ? (
          filteredAndSorted.map((preset) => (
            <PresetCardCompact
              key={preset.id}
              preset={preset}
              onToggle={(id, enabled) => {
                setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, enabled } : p)))
              }}
              onStart={(id) => {
                toast.success("Preset started")
              }}
              onDelete={(id) => {
                setPresets((prev) => prev.filter((p) => p.id !== id))
                toast.success("Preset deleted")
              }}
              onDuplicate={(id) => {
                const preset = presets.find((p) => p.id === id)
                if (preset) {
                  setPresets((prev) => [...prev, { ...preset, id: `${preset.id}-copy`, name: `${preset.name} (Copy)` }])
                  toast.success("Preset duplicated")
                }
              }}
            />
          ))
        ) : (
          <div className="text-center py-12 text-slate-500">
            <div className="text-sm">No presets found</div>
          </div>
        )}
      </div>
    </div>
  )
}
