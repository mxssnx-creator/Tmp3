"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Play, FileText, RefreshCw, Loader2, TrendingUp, StopCircle, Activity,
  BarChart3, ChevronDown, ChevronUp, Database, Zap, Clock, CheckCircle2,
  Circle, AlertCircle,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { QuickstartComprehensiveLogDialog } from "./quickstart-comprehensive-log-dialog"
import { QuickstartOverviewDialog } from "./quickstart-overview-dialog"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string
  message: string
  type: "info" | "success" | "error" | "warning"
  timestamp: Date
}

interface LiveStats {
  // historic
  historicSymbols: number
  historicSymbolsTotal: number
  historicCycles: number
  historicComplete: boolean
  historicProgress: number
  // realtime
  indicationCycles: number
  strategyCycles: number
  indicationsTotal: number
  strategiesTotal: number
  positionsOpen: number
  successRate: number
  avgCycleMs: number
  isActive: boolean
  // breakdown
  indDirection: number
  indMove: number
  indActive: number
  indOptimal: number
  indAuto: number
  stratBase: number
  stratMain: number
  stratReal: number
  // windows
  indLast5m: number
  indLast60m: number
  // phase
  phase: string
  engineRunning: boolean
}

const EMPTY_STATS: LiveStats = {
  historicSymbols: 0, historicSymbolsTotal: 0, historicCycles: 0,
  historicComplete: false, historicProgress: 0,
  indicationCycles: 0, strategyCycles: 0, indicationsTotal: 0,
  strategiesTotal: 0, positionsOpen: 0, successRate: 0, avgCycleMs: 0, isActive: false,
  indDirection: 0, indMove: 0, indActive: 0, indOptimal: 0, indAuto: 0,
  stratBase: 0, stratMain: 0, stratReal: 0,
  indLast5m: 0, indLast60m: 0, phase: "—", engineRunning: false,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ─── sub-components ───────────────────────────────────────────────────────────

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${active ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded bg-muted/60 px-2 py-1.5 min-w-[52px]">
      <span className="text-[13px] font-bold tabular-nums text-foreground leading-none">{value}</span>
      {sub && <span className="text-[9px] text-muted-foreground leading-none mt-0.5">{sub}</span>}
      <span className="text-[9px] text-muted-foreground leading-none mt-0.5">{label}</span>
    </div>
  )
}

// ─── main component ───────────────────────────────────────────────────────────

export function QuickstartSection() {
  const { selectedConnectionId, selectedExchange } = useExchange()
  // Default to bingx-x01 — the canonical BingX base connection ID used by the engine
  const connectionId = selectedConnectionId || "bingx-x01"

  // volatile symbol for start button label
  const [volatileSymbol, setVolatileSymbol] = useState<{ symbol: string | null; exchange: string | null; pct: number | null; loading: boolean }>({
    symbol: null, exchange: null, pct: null, loading: true,
  })

  const [starting, setStarting] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS)
  const [loadingStats, setLoadingStats] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const pollRef    = useRef<NodeJS.Timeout>()

  // ── fetch live stats ──────────────────────────────────────────────────────
  const fetchStats = useCallback(async (silent = false) => {
    if (!connectionId) return
    if (!silent) setLoadingStats(true)
    try {
      // Primary: /stats endpoint (full breakdown)
      const res = await fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" })
      if (!res.ok) return
      const s = await res.json()

      let indCycles  = s.realtime?.indicationCycles || 0
      let stratCycles = s.realtime?.strategyCycles  || 0
      let indTotal   = s.realtime?.indicationsTotal || 0
      let stratTotal = s.realtime?.strategiesTotal  || 0
      let indDir     = s.breakdown?.indications?.direction || 0
      let indMove    = s.breakdown?.indications?.move     || 0
      let indAct     = s.breakdown?.indications?.active   || 0
      let indOpt     = s.breakdown?.indications?.optimal  || 0
      let indAuto    = s.breakdown?.indications?.auto     || 0
      let stratBase  = s.breakdown?.strategies?.base      || 0
      let stratMain  = s.breakdown?.strategies?.main      || 0
      let stratReal  = s.breakdown?.strategies?.real      || 0

      // Fallback: if /stats returned all zeros, try engine-stats (confirmed working)
      if (indCycles === 0 && stratCycles === 0 && indTotal === 0) {
        try {
          const er = await fetch(`/api/trading/engine-stats?connection_id=${connectionId}`, { cache: "no-store" })
          if (er.ok) {
            const e = await er.json()
            indCycles  = e.indicationCycleCount  || 0
            stratCycles = e.strategyCycleCount    || 0
            indTotal   = e.totalIndicationsCount  || 0
            stratTotal = e.totalStrategyCount     || 0
            indDir     = e.indicationsByType?.direction || 0
            indMove    = e.indicationsByType?.move      || 0
            indAct     = e.indicationsByType?.active    || 0
            indOpt     = e.indicationsByType?.optimal   || 0
            indAuto    = e.indicationsByType?.auto      || 0
            stratBase  = e.baseStrategyCount  || 0
            stratMain  = e.mainStrategyCount  || 0
            stratReal  = e.realStrategyCount  || 0
          }
        } catch { /* non-critical */ }
      }

      setStats({
        historicSymbols:       s.historic?.symbolsProcessed    || 0,
        historicSymbolsTotal:  s.historic?.symbolsTotal        || 0,
        historicCycles:        s.historic?.cyclesCompleted     || 0,
        historicComplete:      s.historic?.isComplete          || false,
        historicProgress:      s.historic?.progressPercent     || 0,
        indicationCycles:      indCycles,
        strategyCycles:        stratCycles,
        indicationsTotal:      indTotal,
        strategiesTotal:       stratTotal,
        positionsOpen:         s.realtime?.positionsOpen       || 0,
        successRate:           s.realtime?.successRate         || 0,
        avgCycleMs:            s.realtime?.avgCycleTimeMs      || 0,
        isActive:              s.realtime?.isActive            || indCycles > 0,
        indDirection:          indDir,
        indMove:               indMove,
        indActive:             indAct,
        indOptimal:            indOpt,
        indAuto:               indAuto,
        stratBase:             stratBase,
        stratMain:             stratMain,
        stratReal:             stratReal,
        indLast5m:             s.windows?.indications?.last5m     || 0,
        indLast60m:            s.windows?.indications?.last60m    || 0,
        phase:                 s.metadata?.phase || (indCycles > 0 ? "realtime" : "—"),
        engineRunning:         s.metadata?.engineRunning || indCycles > 0,
      })
      if (indCycles > 0 && !isRunning) setIsRunning(true)
    } catch { /* non-critical */ }
    finally { if (!silent) setLoadingStats(false) }
  }, [connectionId, isRunning])

  // ── fetch volatile symbol ──────────────────────────────────────────────────
  useEffect(() => {
    async function loadSymbol() {
      setVolatileSymbol(s => ({ ...s, loading: true }))
      try {
        const connRes = await fetch("/api/settings/connections?t=" + Date.now(), { cache: "no-store" })
        if (!connRes.ok) throw new Error("no connections")
        const data = await connRes.json()
        const conns: any[] = Array.isArray(data) ? data : (data?.connections || [])

        const isActive = (c: any) =>
          c.is_active_inserted === "1" || c.is_active_inserted === true ||
          c.is_assigned === "1" || c.is_assigned === true ||
          c.is_active === "1" || c.is_active === true ||
          c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true

        // 1st: exact match on selectedConnectionId
        // 2nd: any active connection matching the selectedExchange name
        // 3rd: any active connection
        // 4th: first connection
        const conn =
          conns.find(c => c.id === selectedConnectionId) ||
          conns.find(c => isActive(c) && (c.exchange || "").toLowerCase() === (selectedExchange || "").toLowerCase()) ||
          conns.find(c => isActive(c)) ||
          conns[0]

        if (!conn) {
          setVolatileSymbol(s => ({ ...s, loading: false }))
          return
        }

        const ex = (conn.exchange || "bingx").toLowerCase()
        const symRes = await fetch(`/api/exchange/${ex}/top-symbols?t=` + Date.now(), { cache: "no-store" })
        if (!symRes.ok) throw new Error("no symbols")
        const sym = await symRes.json()
        setVolatileSymbol({ symbol: sym.symbol || "BTCUSDT", exchange: ex, pct: sym.priceChangePercent ?? null, loading: false })
      } catch {
        setVolatileSymbol({ symbol: "BTCUSDT", exchange: (selectedExchange || "bingx").toLowerCase(), pct: null, loading: false })
      }
    }
    // Run immediately and whenever exchange selection changes
    loadSymbol()
  }, [selectedConnectionId, selectedExchange])

  // ── auto-scroll logs ───────────────────────────────────────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs])

  // ── poll stats always (fast when expanded/running, slow otherwise) ────────
  useEffect(() => {
    clearInterval(pollRef.current)
    fetchStats()
    // Always poll: fast (3s) when expanded or running, slower (10s) otherwise
    const interval = (expanded || isRunning) ? 3000 : 10000
    pollRef.current = setInterval(() => fetchStats(true), interval)
    return () => clearInterval(pollRef.current)
  }, [expanded, isRunning, fetchStats])

  // ── log helper ─────────────────────────────────────────────────────────────
  const addLog = (msg: string, type: LogEntry["type"] = "info") =>
    setLogs(prev => [...prev, { id: Math.random().toString(), message: msg, type, timestamp: new Date() }])

  // ── start / stop ───────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (starting || isRunning) return
    setStarting(true)
    setLogs([])
    addLog("Initializing connection...", "info")
    try {
      const connRes = await fetch("/api/settings/connections?t=" + Date.now(), { cache: "no-store" })
      if (!connRes.ok) throw new Error("Failed to get connections")
      const data = await connRes.json()
      const conns: any[] = Array.isArray(data) ? data : (data?.connections || [])
      const isActive = (c: any) =>
        c.is_active_inserted === "1" || c.is_active_inserted === true ||
        c.is_assigned === "1" || c.is_assigned === true ||
        c.is_active === "1" || c.is_active === true ||
        c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true

      // Always use the exchange-selected connection first
      const conn =
        conns.find(c => c.id === selectedConnectionId) ||
        conns.find(c => isActive(c) && (c.exchange || "").toLowerCase() === (selectedExchange || "").toLowerCase()) ||
        conns.find(c => isActive(c)) ||
        conns[0]
      if (!conn) throw new Error("No active connections found")
      addLog(`Connected to ${conn.exchange?.toUpperCase() || "exchange"}`, "success")

      addLog("Fetching most volatile symbol (1h)...", "info")
      const ex = (conn.exchange || "bingx").toLowerCase()
      const symRes = await fetch(`/api/exchange/${ex}/top-symbols?t=` + Date.now(), { cache: "no-store" })
      let symbol = "BTCUSDT"
      if (symRes.ok) {
        const sym = await symRes.json()
        symbol = sym.symbol || "BTCUSDT"
        addLog(`Symbol: ${symbol} (${sym.priceChangePercent?.toFixed(2) || "—"}% 1h)`, "success")
        setVolatileSymbol({ symbol, exchange: ex, pct: sym.priceChangePercent ?? null, loading: false })
      }

      addLog("Starting trade engine...", "info")
      const startRes = await fetch("/api/trade-engine/quick-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: conn.id, symbols: [symbol] }),
      })

      if (startRes.ok) {
        addLog("Trade engine started successfully", "success")
        setIsRunning(true)
        addLog(`Processing live ${symbol} data...`, "info")
      } else {
        const body = await startRes.json().catch(() => ({}))
        addLog(body?.message || "Engine already running — monitoring active", "warning")
        setIsRunning(true)
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, "error")
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    addLog("Stopping engine...", "info")
    setIsRunning(false)
    addLog("Engine stopped", "success")
  }

  const handleRefresh = async () => {
    setVolatileSymbol(s => ({ ...s, loading: true }))
    try {
      if (volatileSymbol.exchange) {
        const res = await fetch(`/api/exchange/${volatileSymbol.exchange}/top-symbols?t=` + Date.now(), { cache: "no-store" })
        if (res.ok) {
          const sym = await res.json()
          setVolatileSymbol(s => ({ ...s, symbol: sym.symbol || s.symbol, pct: sym.priceChangePercent ?? s.pct, loading: false }))
          return
        }
      }
    } catch { /* non-critical */ }
    setVolatileSymbol(s => ({ ...s, loading: false }))
    await fetchStats()
  }

  const logColor = (type: string) => {
    switch (type) {
      case "success": return "text-green-600 dark:text-green-400"
      case "error":   return "text-red-600 dark:text-red-400"
      case "warning": return "text-amber-600 dark:text-amber-400"
      default:        return "text-blue-600 dark:text-blue-400"
    }
  }

  const totalInd = stats.indicationsTotal || 1
  const indTypes = [
    { label: "Dir",  value: stats.indDirection },
    { label: "Move", value: stats.indMove      },
    { label: "Act",  value: stats.indActive    },
    { label: "Opt",  value: stats.indOptimal   },
    { label: "Auto", value: stats.indAuto      },
  ]

  return (
    <Card className="border-primary/20 overflow-hidden">
      {/* ── compact header bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border-b border-primary/10">
        {/* status dot + label */}
        <StatusDot active={stats.engineRunning || isRunning} />
        <span className="text-xs font-semibold text-foreground">Engine</span>
        {(stats.engineRunning || isRunning) && (
          <Badge variant="default" className="h-4 text-[10px] px-1.5 py-0">Running</Badge>
        )}
        {stats.phase && stats.phase !== "—" && (
          <Badge variant="outline" className="h-4 text-[9px] px-1.5 py-0 capitalize hidden sm:inline-flex">
            {stats.phase.replace(/_/g, " ")}
          </Badge>
        )}

        {/* volatile symbol */}
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <TrendingUp className="w-3 h-3 shrink-0" />
          {volatileSymbol.loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : volatileSymbol.symbol ? (
            <>
              <span className="font-semibold text-foreground font-mono">{volatileSymbol.symbol}</span>
              {volatileSymbol.pct !== null && (
                <span className={`text-[10px] tabular-nums ${volatileSymbol.pct >= 0 ? "text-green-600" : "text-red-500"}`}>
                  {volatileSymbol.pct >= 0 ? "+" : ""}{volatileSymbol.pct.toFixed(2)}%
                </span>
              )}
            </>
          ) : <span>—</span>}
          {volatileSymbol.exchange && (
            <span className="text-[9px] uppercase bg-muted px-1 py-0.5 rounded">{volatileSymbol.exchange}</span>
          )}
        </div>
      </div>

      <div className="p-2.5 space-y-2">
        {/* ── action row ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={isRunning ? "destructive" : "default"}
            onClick={isRunning ? handleStop : handleStart}
            disabled={starting || volatileSymbol.loading}
            className="h-7 text-xs px-2.5 gap-1"
          >
            {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : isRunning ? <StopCircle className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {starting ? "Starting..." : isRunning ? "Stop" : volatileSymbol.symbol ? `Start (${volatileSymbol.symbol})` : "Start Engine"}
          </Button>

          <Button
            size="sm" variant="outline"
            onClick={handleRefresh}
            disabled={volatileSymbol.loading || loadingStats}
            className="h-7 text-xs px-2 gap-1"
          >
            {(volatileSymbol.loading || loadingStats)
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RefreshCw className="w-3 h-3" />
            }
            Refresh
          </Button>

          {/* dialog launchers */}
          <QuickstartOverviewDialog />
          <QuickstartComprehensiveLogDialog />

          {/* legacy event buttons */}
          {[
            { label: "Progression", event: "open-progression-logs" },
            { label: "Indications", event: "open-indications-logs" },
            { label: "Strategies",  event: "open-strategies-logs"  },
          ].map(({ label, event }) => (
            <Button
              key={event}
              size="sm" variant="ghost"
              onClick={() => window.dispatchEvent(new CustomEvent(event))}
              className="h-7 text-[11px] px-2 gap-1"
            >
              <FileText className="w-2.5 h-2.5" />
              {label}
            </Button>
          ))}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(e => !e)}
            className="h-7 text-[11px] px-2 gap-1 ml-auto"
            aria-expanded={expanded}
          >
            <Activity className="w-3 h-3" />
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </Button>
        </div>

        {/* ── quick stats row (always visible) ──────────────────────────── */}
        <div className="flex flex-wrap gap-1.5">
          <MiniStat label="Ind Cycles"   value={fmt(stats.indicationCycles)}  />
          <MiniStat label="Indications"  value={fmt(stats.indicationsTotal)}   />
          <MiniStat label="Strategies"   value={fmt(stats.strategiesTotal)}    />
          <MiniStat label="Positions"    value={fmt(stats.positionsOpen)}      />
          <MiniStat label="Success"      value={`${stats.successRate.toFixed(0)}%`} />
          {stats.avgCycleMs > 0 && (
            <MiniStat label="Avg Cycle"  value={`${stats.avgCycleMs}ms`}      />
          )}
          {stats.indLast5m > 0 && (
            <MiniStat label="5m Ind"     value={fmt(stats.indLast5m)}          sub="last 5min" />
          )}
          {stats.indLast60m > 0 && (
            <MiniStat label="60m Ind"    value={fmt(stats.indLast60m)}         sub="last 60min" />
          )}
        </div>

        {/* ── expanded panel ─────────────────────────────────────────────── */}
        {expanded && (
          <div className="space-y-2 pt-1 border-t border-border/40">

            {/* historic / prehistoric processing */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <Database className="w-3.5 h-3.5 text-blue-500" />
                Prehistoric Processing
                {stats.historicComplete
                  ? <CheckCircle2 className="w-3 h-3 text-green-500 ml-auto" />
                  : <Circle className="w-3 h-3 text-muted-foreground/40 ml-auto" />
                }
                <span className="text-muted-foreground font-normal ml-0.5">
                  {stats.historicComplete ? "Loaded" : `${stats.historicProgress}%`}
                </span>
              </div>
              {!stats.historicComplete && (
                <Progress value={stats.historicProgress} className="h-1" />
              )}
              <div className="flex flex-wrap gap-1.5">
                <MiniStat label="Symbols"    value={`${stats.historicSymbols}/${stats.historicSymbolsTotal}`} />
                <MiniStat label="Preh Cycles" value={fmt(stats.historicCycles)} />
              </div>
            </div>

            {/* indications breakdown */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <Zap className="w-3.5 h-3.5 text-violet-500" />
                  Indications
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  Total {fmt(stats.indicationsTotal)}
                  {stats.indLast5m > 0 ? ` · 5m: ${fmt(stats.indLast5m)}` : ""}
                  {stats.indLast60m > 0 ? ` · 60m: ${fmt(stats.indLast60m)}` : ""}
                </span>
              </div>
              <div className="space-y-1">
                {indTypes.map(({ label, value }) => {
                  const pct = Math.min(100, (value / totalInd) * 100)
                  return (
                    <div key={label} className="flex items-center gap-2 text-[10px]">
                      <span className="w-7 text-muted-foreground shrink-0">{label}</span>
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-10 text-right tabular-nums font-medium">{fmt(value)}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* strategies breakdown */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <BarChart3 className="w-3.5 h-3.5 text-amber-500" />
                Strategies
                <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                  Total {fmt(stats.stratBase + stats.stratMain + stats.stratReal)}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                {[
                  { label: "Base", value: stats.stratBase, color: "text-orange-600 dark:text-orange-400" },
                  { label: "Main", value: stats.stratMain, color: "text-yellow-600 dark:text-yellow-400" },
                  { label: "Real", value: stats.stratReal, color: "text-green-600 dark:text-green-400"   },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded bg-muted/60 py-1.5 px-1">
                    <div className={`text-sm font-bold tabular-nums ${color}`}>{fmt(value)}</div>
                    <div className="text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* processing status pills */}
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {[
                { label: "Historic",   done: stats.historicComplete },
                { label: "Indications", done: stats.indicationCycles > 0 },
                { label: "Strategies",  done: stats.strategyCycles > 0 },
                { label: "Realtime",    done: stats.isActive },
              ].map(({ label, done }) => (
                <div key={label} className={`flex items-center gap-1 px-2 py-0.5 rounded-full border ${done ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400" : "border-border bg-muted/30 text-muted-foreground"}`}>
                  {done ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5 opacity-40" />}
                  {label}
                </div>
              ))}
              {stats.avgCycleMs > 0 && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-border bg-muted/30 text-muted-foreground">
                  <Clock className="w-2.5 h-2.5" />
                  {stats.avgCycleMs}ms avg
                </div>
              )}
            </div>

            {/* startup logs */}
            {logs.length > 0 && (
              <div className="rounded-md border bg-muted/20">
                <ScrollArea className="h-[120px] p-2">
                  <div className="space-y-0.5">
                    {logs.map(log => (
                      <div key={log.id} className="flex gap-2 text-[10px]">
                        <span className="text-muted-foreground shrink-0 font-mono">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                        <span className={`flex-1 ${logColor(log.type)}`}>{log.message}</span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
