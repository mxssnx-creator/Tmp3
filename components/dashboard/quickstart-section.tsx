"use client"

import { useState, useEffect, useRef } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Play, FileText, Settings, Zap, RefreshCw, Loader2, TrendingUp, StopCircle, Activity, BarChart3 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QuickstartComprehensiveLogDialog } from "./quickstart-comprehensive-log-dialog"

interface VolatileSymbolState {
  symbol: string | null
  exchange: string | null
  priceChangePercent: number | null
  loading: boolean
  error: string | null
}

interface LogEntry {
  id: string
  message: string
  type: "info" | "success" | "error" | "warning"
  timestamp: Date
}

interface EngineStats {
  cycles: number
  successRate: number
  indications: number
  strategies: number
  positions: number
  profit: number
}

export function QuickstartSection() {
  const [volatileSymbol, setVolatileSymbol] = useState<VolatileSymbolState>({
    symbol: null,
    exchange: null,
    priceChangePercent: null,
    loading: true,
    error: null,
  })
  const [starting, setStarting] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<EngineStats>({
    cycles: 0,
    successRate: 0,
    indications: 0,
    strategies: 0,
    positions: 0,
    profit: 0,
  })
  const logsEndRef = useRef<HTMLDivElement>(null)
  const statsIntervalRef = useRef<NodeJS.Timeout>()

  // On mount: load first active connection's exchange, then fetch most volatile symbol
  useEffect(() => {
    async function loadVolatileSymbol() {
      try {
        // Step 1: get active connections
        const connRes = await fetch("/api/settings/connections?t=" + Date.now(), {
          cache: "no-store",
        })
        if (!connRes.ok) throw new Error("Could not load connections")
        const connData = await connRes.json()
        const connections: any[] = Array.isArray(connData) ? connData : (connData?.connections || [])

        // Find first active/enabled connection
        const active = connections.find(
          c => c.is_active === "1" || c.is_active === true || c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
        ) || connections[0]

        if (!active) {
          setVolatileSymbol(s => ({ ...s, loading: false, error: "No connections found" }))
          return
        }

        const exchange = (active.exchange || "binance").toLowerCase()

        // Step 2: fetch most volatile symbol from that exchange
        const symRes = await fetch(`/api/exchange/${exchange}/top-symbols?t=` + Date.now(), {
          cache: "no-store",
        })
        if (!symRes.ok) throw new Error("Could not fetch volatile symbol")
        const symData = await symRes.json()

        setVolatileSymbol({
          symbol: symData.symbol || "BTCUSDT",
          exchange,
          priceChangePercent: symData.priceChangePercent ?? null,
          loading: false,
          error: null,
        })
      } catch (err) {
        console.warn("[v0] [Quickstart] Failed to load volatile symbol:", err instanceof Error ? err.message : err)
        setVolatileSymbol({ symbol: "BTCUSDT", exchange: null, priceChangePercent: null, loading: false, error: null })
      }
    }

    loadVolatileSymbol()
  }, [])

  // Auto-scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // Fetch live stats when running
  useEffect(() => {
    if (!isRunning) return

    const fetchStats = async () => {
      try {
        const res = await fetch("/api/connections/progression/default-bingx-001", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()

        setStats({
          cycles: data.state?.cyclesCompleted || 0,
          successRate: data.state?.cycleSuccessRate || 0,
          indications: data.metrics?.indicationsCount || (data.state?.indicationEvaluatedDirection || 0),
          strategies: data.metrics?.totalStrategiesEvaluated || (data.state?.strategyEvaluatedReal || 0),
          positions: data.metrics?.intervalsProcessed || 0,
          profit: data.state?.totalProfit || 0,
        })
      } catch (err) {
        console.error("[v0] [Quickstart] Failed to fetch stats:", err)
      }
    }

    fetchStats()
    statsIntervalRef.current = setInterval(fetchStats, 2000)

    return () => {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
    }
  }, [isRunning])

  const addLog = (message: string, type: "info" | "success" | "error" | "warning" = "info") => {
    const entry: LogEntry = {
      id: Math.random().toString(),
      message,
      type,
      timestamp: new Date(),
    }
    setLogs(prev => [...prev, entry])
  }

  const handleStartEngine = async () => {
    if (starting || isRunning) return
    setStarting(true)
    setLogs([])
    addLog("🚀 Starting engine test...", "info")

    try {
      addLog("Step 1: Initializing connection...", "info")
      const connRes = await fetch("/api/settings/connections?t=" + Date.now(), { cache: "no-store" })
      if (!connRes.ok) throw new Error("Failed to get connections")
      const connections = await connRes.json()
      const active = connections.find((c: any) => c.is_active === "1" || c.is_active === true) || connections[0]
      if (!active) throw new Error("No active connections")
      addLog(`✓ Connected to ${active.exchange}`, "success")

      addLog("Step 2: Fetching market data...", "info")
      const exchange = (active.exchange || "binance").toLowerCase()
      const symRes = await fetch(`/api/exchange/${exchange}/top-symbols?t=` + Date.now(), { cache: "no-store" })
      if (symRes.ok) {
        const symData = await symRes.json()
        addLog(`✓ Market data loaded: ${symData.symbol || "BTCUSDT"}`, "success")
      }

      addLog("Step 3: Starting trade engine...", "info")
      const startRes = await fetch("/api/trade-engine/quick-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: active.id || "default-bingx-001" }),
      })

      if (startRes.ok) {
        addLog("✓ Trade engine started", "success")
        setIsRunning(true)
        addLog("Engine is now running and processing live data", "info")
      } else {
        addLog("⚠ Engine already running or unavailable", "warning")
        setIsRunning(true)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      addLog(`❌ Error: ${message}`, "error")
    } finally {
      setStarting(false)
    }
  }

  const handleStopEngine = async () => {
    try {
      addLog("Stopping engine...", "info")
      setIsRunning(false)
      setStats({
        cycles: 0,
        successRate: 0,
        indications: 0,
        strategies: 0,
        positions: 0,
        profit: 0,
      })
      addLog("✓ Engine stopped", "success")
    } catch (err) {
      addLog(`❌ Failed to stop: ${err instanceof Error ? err.message : String(err)}`, "error")
    }
  }

  const handleRefreshStatus = async () => {
    setVolatileSymbol(s => ({ ...s, loading: true }))
    try {
      if (volatileSymbol.exchange) {
        const symRes = await fetch(`/api/exchange/${volatileSymbol.exchange}/top-symbols?t=` + Date.now(), {
          cache: "no-store",
        })
        if (symRes.ok) {
          const symData = await symRes.json()
          setVolatileSymbol(s => ({
            ...s,
            symbol: symData.symbol || s.symbol,
            priceChangePercent: symData.priceChangePercent ?? s.priceChangePercent,
            loading: false,
          }))
          return
        }
      }
    } catch (_) {}
    setVolatileSymbol(s => ({ ...s, loading: false }))
  }

  const getLogColor = (type: string) => {
    switch (type) {
      case "success": return "text-green-600 dark:text-green-400"
      case "error": return "text-red-600 dark:text-red-400"
      case "warning": return "text-amber-600 dark:text-amber-400"
      default: return "text-blue-600 dark:text-blue-400"
    }
  }

  return (
    <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
      <div className="p-3 space-y-2.5">

        {/* Header row: title + volatile symbol badge */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold">Quickstart Test</span>
            {isRunning && <Badge variant="default" className="h-4 text-[10px]">Running</Badge>}
          </div>

          {/* Volatile symbol indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="w-3 h-3" />
            <span className="font-mono">
              {volatileSymbol.loading ? (
                <Loader2 className="w-3 h-3 animate-spin inline" />
              ) : volatileSymbol.symbol ? (
                <>
                  <span className="font-semibold text-foreground">{volatileSymbol.symbol}</span>
                  {volatileSymbol.priceChangePercent !== null && (
                    <span className="ml-1 text-amber-500">
                      {volatileSymbol.priceChangePercent > 0 ? "+" : ""}
                      {volatileSymbol.priceChangePercent.toFixed(2)}%
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </span>
            {volatileSymbol.exchange && (
              <span className="uppercase text-[10px] bg-muted px-1.5 py-0.5 rounded">
                {volatileSymbol.exchange}
              </span>
            )}
          </div>
        </div>

        {/* Primary action buttons */}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant={isRunning ? "destructive" : "default"}
            onClick={isRunning ? handleStopEngine : handleStartEngine}
            disabled={starting || volatileSymbol.loading}
            className="h-7 text-xs px-2.5 flex items-center gap-1"
          >
            {starting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : isRunning ? (
              <StopCircle className="w-3 h-3" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            {isRunning ? "Stop" : volatileSymbol.symbol ? `Start (${volatileSymbol.symbol})` : "Start Engine"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleRefreshStatus}
            disabled={volatileSymbol.loading}
            className="h-7 text-xs px-2.5 flex items-center gap-1"
          >
            {volatileSymbol.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </Button>

          <Button
            size="sm"
            variant={showDetails ? "default" : "outline"}
            onClick={() => setShowDetails(!showDetails)}
            className="h-7 text-xs px-2.5 flex items-center gap-1 ml-auto"
          >
            <Activity className="w-3 h-3" />
            {showDetails ? "Hide" : "Show"} Details
          </Button>
        </div>

        {/* Expanded details section */}
        {showDetails && (
          <Tabs defaultValue="logs" className="w-full">
            <TabsList className="grid w-full grid-cols-2 h-7">
              <TabsTrigger value="logs" className="text-xs h-6">Logs</TabsTrigger>
              <TabsTrigger value="stats" className="text-xs h-6">Stats</TabsTrigger>
            </TabsList>

            <TabsContent value="logs" className="mt-2">
              <ScrollArea className="h-[220px] border border-border rounded-md p-2 text-xs">
                {logs.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">Logs will appear here when engine is running</p>
                ) : (
                  <div className="space-y-1">
                    {logs.map((log) => (
                      <div key={log.id} className="flex gap-2 text-xs">
                        <span className="text-muted-foreground flex-shrink-0 font-mono text-[10px]">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                        <span className={`flex-1 ${getLogColor(log.type)}`}>{log.message}</span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="stats" className="mt-2">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Cycles", value: stats.cycles, icon: "🔄" },
                  { label: "Indications", value: stats.indications, icon: "📊" },
                  { label: "Strategies", value: stats.strategies, icon: "🎯" },
                  { label: "Positions", value: stats.positions, icon: "📈" },
                  { label: "Success %", value: stats.successRate.toFixed(1), icon: "✓" },
                  { label: "Profit $", value: stats.profit.toFixed(2), icon: "$" },
                ].map((stat) => (
                  <Card key={stat.label} className="p-2 bg-muted/50">
                    <div className="text-[10px] text-muted-foreground">{stat.label}</div>
                    <div className="text-lg font-bold flex items-center gap-1">
                      <span>{stat.icon}</span>
                      <span>{stat.value}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}

        {/* Log buttons — second row with comprehensive dialog */}
        <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-border/30">
          {/* New comprehensive log dialog with Overall and Live Logs */}
          <QuickstartComprehensiveLogDialog />
          
          {/* Legacy buttons - kept for backward compatibility */}
          {[
            { label: "Progression", event: "open-progression-logs" },
            { label: "Indications", event: "open-indications-logs" },
            { label: "Strategies", event: "open-strategies-logs" },
          ].map(({ label, event }) => (
            <Button
              key={event}
              size="sm"
              variant="ghost"
              onClick={() => window.dispatchEvent(new CustomEvent(event))}
              className="h-6 text-[11px] px-2 flex items-center gap-1"
            >
              <FileText className="w-2.5 h-2.5" />
              {label}
            </Button>
          ))}
        </div>

      </div>
    </Card>
  )
}
