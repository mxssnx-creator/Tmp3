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

interface StageDetail {
  createdSets: number
  avgPosPerSet: number
  avgProfitFactor: number
  avgDrawdownTime: number
  evaluated: number
  passed: number
  failed: number
  passRatio: number
}

interface VariantDetail {
  createdSets: number
  passedSets: number
  entriesCount: number
  avgPosPerSet: number
  avgProfitFactor: number
  avgDrawdownTime: number
  passRate: number
}

// Indication configuration Set-count snapshot — how many DISTINCT Sets the
// engine could enumerate per Main indication type, given the current settings.
// This is a *static* enumeration (possible configurations), not live runtime
// counts. Renders as a row per type at the top of the expanded stats area.
interface IndicationConfigCounts {
  totalPossibleSets: number
  perSetDbCapacity:  number   // 250 default — per-Set position history length
  maxStorablePositions: number
  settings: {
    indicationRangeMin:        number
    indicationRangeMax:        number
    indicationRangeStep:       number
    takeProfitRangeDivisor:    number
    validRangeCount:           number
    optimalBasePositionsLimit: number
  }
  types: Array<{
    type: "direction" | "move" | "active" | "optimal" | "auto"
    label: string
    possibleSets: number
    formula: string
    params: Record<string, string | number>
    description: string
  }>
}

// Live exchange footer — aggregates REAL-exchange positions & account balance
// across every enabled connection. Not the same as pseudo-position counts.
interface ExchangeLiveSummary {
  connections: Array<{
    connectionId: string
    name: string
    exchange: string
    openPositions: number
    longPositions: number
    shortPositions: number
    unrealizedPnl: number
    balance: { total: number; available: number; equity: number; currency: string }
    positions: Array<{ symbol: string; side: string; qty: number; entry: number; mark: number; pnl: number }>
  }>
  totals: {
    openPositions: number
    longPositions: number
    shortPositions: number
    unrealizedPnl: number
    totalBalance:  number
    availableBalance: number
    equity:        number
    currency:      string
  }
  updatedAt: number
}

// Main-stage coordination snapshot — surfaces the per-cycle position context
// (pseudo-positions gating variant selection), how many related variant Sets
// were built fresh vs. reused from the fingerprint cache, and the list of
// variants gated ACTIVE for this cycle. Drives the "Main Coordination" panel
// that sits above the variants table so the operator can verify at a glance
// that the Main stage is actually coordinating based on live trading state.
interface MainCoordination {
  activeVariants: string[]    // e.g. ["default", "trailing"]
  activeVariantCount: number
  lastCreated: number         // variant Sets built fresh last cycle
  lastReused: number          // variant Sets reused from fp-cache last cycle
  totalCreated: number        // cumulative fresh builds
  totalReused: number         // cumulative cache hits
  totalCycles: number         // total Main cycles run
  reuseRate: number           // percent — higher is better
  positionContext: {
    continuous: number        // open pseudo positions right now
    lastWins: number          // winners in the last-N closed (max 5)
    lastLosses: number        // losers  in the last-N closed (max 5)
    prevLosses: number        // losers in the 24h lookback window
    prevTotal: number         // total closed in the 24h lookback window
    updatedAt: number         // ms since epoch when last written
  }
}

interface LiveStats {
  // historic
  historicSymbols: number
  historicSymbolsTotal: number
  historicCycles: number
  historicComplete: boolean
  historicProgress: number
  historicCandles: number
  historicIndicators: number
  // historic — frame/interval counters (big count for 1s timeframes)
  historicFrames: number
  historicFramesMissing: number
  historicTimeframeSec: number
  // realtime
  indicationCycles: number
  strategyCycles: number
  realtimeCycles: number
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
  stratLive: number
  // per-stage strategy detail (count sets validated from prev + avg PF/DDT + avg pos/set)
  stageBase: StageDetail
  stageMain: StageDetail
  stageReal: StageDetail
  stageLive: StageDetail
  // per-variant strategy detail (Default/Trailing/Block/DCA + Overall)
  variantDefault: VariantDetail
  variantTrailing: VariantDetail
  variantBlock: VariantDetail
  variantDca: VariantDetail
  variantOverall: VariantDetail
  // Main-stage coordination snapshot (position context + reuse rate)
  mainCoord: MainCoordination
  // live execution — real exchange positions
  livePositionsOpen: number
  livePositionsCreated: number
  livePositionsClosed: number
  liveOrdersPlaced: number
  liveOrdersFilled: number
  liveWinRate: number
  // windows
  indLast5m: number
  indLast60m: number
  // phase
  phase: string
  engineRunning: boolean
}

const EMPTY_STAGE: StageDetail = {
  createdSets: 0, avgPosPerSet: 0, avgProfitFactor: 0, avgDrawdownTime: 0,
  evaluated: 0, passed: 0, failed: 0, passRatio: 0,
}
const EMPTY_VARIANT: VariantDetail = {
  createdSets: 0, passedSets: 0, entriesCount: 0, avgPosPerSet: 0,
  avgProfitFactor: 0, avgDrawdownTime: 0, passRate: 0,
}
const EMPTY_MAIN_COORD: MainCoordination = {
  activeVariants: ["default"], activeVariantCount: 1,
  lastCreated: 0, lastReused: 0,
  totalCreated: 0, totalReused: 0, totalCycles: 0, reuseRate: 0,
  positionContext: {
    continuous: 0, lastWins: 0, lastLosses: 0,
    prevLosses: 0, prevTotal: 0, updatedAt: 0,
  },
}

const EMPTY_STATS: LiveStats = {
  historicSymbols: 0, historicSymbolsTotal: 0, historicCycles: 0,
  historicComplete: false, historicProgress: 0, historicCandles: 0, historicIndicators: 0,
  historicFrames: 0, historicFramesMissing: 0, historicTimeframeSec: 1,
  indicationCycles: 0, strategyCycles: 0, realtimeCycles: 0, indicationsTotal: 0,
  strategiesTotal: 0, positionsOpen: 0, successRate: 0, avgCycleMs: 0, isActive: false,
  indDirection: 0, indMove: 0, indActive: 0, indOptimal: 0, indAuto: 0,
  stratBase: 0, stratMain: 0, stratReal: 0, stratLive: 0,
  stageBase:  { ...EMPTY_STAGE }, stageMain: { ...EMPTY_STAGE },
  stageReal:  { ...EMPTY_STAGE }, stageLive: { ...EMPTY_STAGE },
  variantDefault:  { ...EMPTY_VARIANT }, variantTrailing: { ...EMPTY_VARIANT },
  variantBlock:    { ...EMPTY_VARIANT }, variantDca:      { ...EMPTY_VARIANT },
  variantOverall:  { ...EMPTY_VARIANT },
  mainCoord: {
    ...EMPTY_MAIN_COORD,
    positionContext: { ...EMPTY_MAIN_COORD.positionContext },
  },
  livePositionsOpen: 0, livePositionsCreated: 0, livePositionsClosed: 0,
  liveOrdersPlaced: 0, liveOrdersFilled: 0, liveWinRate: 0,
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

// ─── main component ─�����─────────────────────────────────────────────────────────

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

  // Quickstart controls — how many top-volatile symbols to process (1-10)
  // and whether live exchange trading is currently enabled for the connection.
  const [symbolCount, setSymbolCount] = useState<number>(1)
  const [liveTradeActive, setLiveTradeActive] = useState<boolean>(false)
  const [liveTradeLoading, setLiveTradeLoading] = useState<boolean>(false)
  // Connection the quickstart actually bound to on last start (or the
  // component default) — used as the target for the Live toggle.
  const [activeConnectionId, setActiveConnectionId] = useState<string>(connectionId)

  // ── Indication configuration Set-count snapshot (static enumeration) ─
  // Pulled from /api/indications/config-counts. Refreshed every 60s since it
  // is derived from settings — not runtime state — so it rarely changes.
  const [configCounts, setConfigCounts] = useState<IndicationConfigCounts | null>(null)

  // ── Live exchange summary (positions + balance) ──────────────────────
  // Pulled from /api/exchange/live-summary. Polled every 10s whenever the
  // expanded panel is open so the footer feels live without hammering Redis.
  const [liveSummary, setLiveSummary] = useState<ExchangeLiveSummary | null>(null)

  const logsEndRef = useRef<HTMLDivElement>(null)
  const pollRef    = useRef<NodeJS.Timeout>()
  const configPollRef = useRef<NodeJS.Timeout>()
  const livePollRef   = useRef<NodeJS.Timeout>()

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

      // Normaliser for per-stage detail blocks — a shared shape used across
      // base / main / real / live so the UI can reuse one renderer.
      const stage = (d: any): StageDetail => ({
        createdSets:     Number(d?.createdSets     ?? 0) || 0,
        avgPosPerSet:    Number(d?.avgPosPerSet    ?? 0) || 0,
        avgProfitFactor: Number(d?.avgProfitFactor ?? 0) || 0,
        avgDrawdownTime: Number(d?.avgDrawdownTime ?? 0) || 0,
        evaluated:       Number(d?.evaluated       ?? 0) || 0,
        passed:          Number(d?.passed          ?? 0) || 0,
        failed:          Number(d?.failed          ?? 0) || 0,
        passRatio:       Number(d?.passRatio       ?? 0) || 0,
      })
      const variant = (d: any): VariantDetail => ({
        createdSets:     Number(d?.createdSets     ?? 0) || 0,
        passedSets:      Number(d?.passedSets      ?? 0) || 0,
        entriesCount:    Number(d?.entriesCount    ?? 0) || 0,
        avgPosPerSet:    Number(d?.avgPosPerSet    ?? 0) || 0,
        avgProfitFactor: Number(d?.avgProfitFactor ?? 0) || 0,
        avgDrawdownTime: Number(d?.avgDrawdownTime ?? 0) || 0,
        passRate:        Number(d?.passRate        ?? 0) || 0,
      })
      // Main-stage coordination snapshot (position context, cache reuse).
      // Nullish-safe: the /stats endpoint only added this block in a later
      // version; fall back to the EMPTY_MAIN_COORD so older backends don't
      // break the dashboard.
      const mainCoordRaw = s.mainCoordination ?? {}
      const mainCoord: MainCoordination = {
        activeVariants:     Array.isArray(mainCoordRaw.activeVariants)
          ? mainCoordRaw.activeVariants.filter((v: any) => typeof v === "string")
          : ["default"],
        activeVariantCount: Number(mainCoordRaw.activeVariantCount ?? 0) || 0,
        lastCreated:        Number(mainCoordRaw.lastCreated        ?? 0) || 0,
        lastReused:         Number(mainCoordRaw.lastReused         ?? 0) || 0,
        totalCreated:       Number(mainCoordRaw.totalCreated       ?? 0) || 0,
        totalReused:        Number(mainCoordRaw.totalReused        ?? 0) || 0,
        totalCycles:        Number(mainCoordRaw.totalCycles        ?? 0) || 0,
        reuseRate:          Number(mainCoordRaw.reuseRate          ?? 0) || 0,
        positionContext: {
          continuous: Number(mainCoordRaw.positionContext?.continuous ?? 0) || 0,
          lastWins:   Number(mainCoordRaw.positionContext?.lastWins   ?? 0) || 0,
          lastLosses: Number(mainCoordRaw.positionContext?.lastLosses ?? 0) || 0,
          prevLosses: Number(mainCoordRaw.positionContext?.prevLosses ?? 0) || 0,
          prevTotal:  Number(mainCoordRaw.positionContext?.prevTotal  ?? 0) || 0,
          updatedAt:  Number(mainCoordRaw.positionContext?.updatedAt  ?? 0) || 0,
        },
      }

      setStats({
        historicSymbols:       s.historic?.symbolsProcessed    || 0,
        historicSymbolsTotal:  s.historic?.symbolsTotal        || 0,
        historicCycles:        s.historic?.cyclesCompleted     || 0,
        historicComplete:      s.historic?.isComplete          || false,
        historicProgress:      s.historic?.progressPercent     || 0,
        historicCandles:       s.historic?.candlesLoaded       || 0,
        historicIndicators:    s.historic?.indicatorsCalculated || 0,
        historicFrames:        s.historic?.framesProcessed     || 0,
        historicFramesMissing: s.historic?.framesMissingLoaded || 0,
        historicTimeframeSec:  s.historic?.timeframeSeconds    || 1,
        indicationCycles:      indCycles,
        strategyCycles:        stratCycles,
        realtimeCycles:        s.realtime?.realtimeCycles      || 0,
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
        stratLive:             s.breakdown?.strategies?.live   || 0,
        // Per-stage strategy detail (sets validated from prev + avg PF/DDT + avg pos/set)
        stageBase:             stage(s.strategyDetail?.base),
        stageMain:             stage(s.strategyDetail?.main),
        stageReal:             stage(s.strategyDetail?.real),
        stageLive:             stage(s.strategyDetail?.live),
        // Per-variant strategy detail (Default/Trailing/Block/DCA + Overall)
        variantDefault:        variant(s.strategyVariants?.default),
        variantTrailing:       variant(s.strategyVariants?.trailing),
        variantBlock:          variant(s.strategyVariants?.block),
        variantDca:            variant(s.strategyVariants?.dca),
        variantOverall:        variant(s.strategyVariants?.overall),
        mainCoord,
        // Live exchange execution — from liveExecution block of the /stats endpoint
        livePositionsOpen:     s.liveExecution?.positionsOpen    || 0,
        livePositionsCreated:  s.liveExecution?.positionsCreated || 0,
        livePositionsClosed:   s.liveExecution?.positionsClosed  || 0,
        liveOrdersPlaced:      s.liveExecution?.ordersPlaced     || 0,
        liveOrdersFilled:      s.liveExecution?.ordersFilled     || 0,
        liveWinRate:           s.liveExecution?.winRate          || 0,
        indLast5m:             s.windows?.indications?.last5m     || 0,
        indLast60m:            s.windows?.indications?.last60m    || 0,
        phase:                 s.metadata?.phase || (indCycles > 0 ? "realtime" : "—"),
        engineRunning:         s.metadata?.engineRunning || indCycles > 0,
      })
      // NOTE: do NOT auto-set isRunning here — isRunning tracks user-initiated sessions only.
      // engineRunning in stats reflects the server state independently.
    } catch { /* non-critical */ }
    finally { if (!silent) setLoadingStats(false) }
  }, [connectionId])

  // ── fetch volatile symbol ──────────────────────────────────────────────────
  const loadSymbol = useCallback(async (showSpinner = true) => {
    if (showSpinner) setVolatileSymbol(s => ({ ...s, loading: true }))
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
      setVolatileSymbol(s => ({ ...s, loading: false }))
    }
  }, [selectedConnectionId, selectedExchange])

  useEffect(() => {
    // Run immediately and whenever exchange selection changes
    loadSymbol(true)
    // Also refresh the volatile symbol every 60 seconds so it stays current
    const symbolInterval = setInterval(() => loadSymbol(false), 60_000)
    return () => clearInterval(symbolInterval)
  }, [loadSymbol])

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

  // ── Poll indication config-counts (settings-derived, slow cadence) ────────
  // 60s when expanded, 5min otherwise. This endpoint only changes when the
  // operator edits connection settings, so aggressive polling would be waste.
  useEffect(() => {
    clearInterval(configPollRef.current)
    const fetchConfig = () =>
      fetch("/api/indications/config-counts", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: IndicationConfigCounts | null) => { if (d) setConfigCounts(d) })
        .catch(() => { /* non-critical */ })
    fetchConfig()
    const interval = expanded ? 60_000 : 300_000
    configPollRef.current = setInterval(fetchConfig, interval)
    return () => clearInterval(configPollRef.current)
  }, [expanded])

  // ── Poll live exchange summary (positions + balance) ──────────────────────
  // 10s when expanded, 30s otherwise. Kept lightweight — this endpoint just
  // reads already-materialised Redis hashes, so frequent polling is fine.
  useEffect(() => {
    clearInterval(livePollRef.current)
    const fetchLive = () =>
      fetch("/api/exchange/live-summary", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: ExchangeLiveSummary | null) => { if (d) setLiveSummary(d) })
        .catch(() => { /* non-critical */ })
    fetchLive()
    const interval = expanded ? 10_000 : 30_000
    livePollRef.current = setInterval(fetchLive, interval)
    return () => clearInterval(livePollRef.current)
  }, [expanded])

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
      setActiveConnectionId(conn.id)
      // Seed live state from whatever the connection already says
      setLiveTradeActive(conn.is_live_trade === "1" || conn.is_live_trade === true)

      const clampedCount = Math.max(1, Math.min(10, symbolCount))
      addLog(
        clampedCount === 1
          ? "Fetching most volatile symbol (1h)..."
          : `Fetching top ${clampedCount} volatile symbols (1h)...`,
        "info",
      )
      const ex = (conn.exchange || "bingx").toLowerCase()
      const symRes = await fetch(
        `/api/exchange/${ex}/top-symbols?limit=${clampedCount}&t=${Date.now()}`,
        { cache: "no-store" },
      )
      let chosen: string[] = ["BTCUSDT"]
      if (symRes.ok) {
        const sym = await symRes.json()
        // Prefer the new symbolList (string[]) → fall back to the object list → single symbol
        const list: string[] =
          (Array.isArray(sym.symbolList) && sym.symbolList.length > 0)
            ? sym.symbolList
            : (Array.isArray(sym.symbols) && sym.symbols.length > 0 && typeof sym.symbols[0] === "object")
              ? sym.symbols.map((s: any) => s.symbol).filter(Boolean)
              : (sym.symbol ? [sym.symbol] : [])
        if (list.length > 0) chosen = list
        const top = chosen[0]
        addLog(`Selected: ${chosen.join(", ")} (top: ${sym.priceChangePercent?.toFixed(2) ?? "—"}% 1h)`, "success")
        setVolatileSymbol({ symbol: top, exchange: ex, pct: sym.priceChangePercent ?? null, loading: false })
      }

      addLog(`Starting trade engine with ${chosen.length} symbol${chosen.length > 1 ? "s" : ""}...`, "info")
      const startRes = await fetch("/api/trade-engine/quick-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: conn.id, symbols: chosen }),
      })

      if (startRes.ok) {
        addLog("Trade engine started successfully", "success")
        setIsRunning(true)
        addLog(`Processing live data for: ${chosen.join(", ")}`, "info")
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
    await loadSymbol(true)
    await fetchStats(true)
    await refreshLiveTradeStatus()
  }

  // ── live-trade toggle ─────────────────────────────────────────────────────
  // Enables or disables real exchange trading for the active connection via
  // /api/settings/connections/[id]/live-trade. The server validates that
  // credentials exist and starts the independent live-trade engine.
  const refreshLiveTradeStatus = useCallback(async () => {
    const id = activeConnectionId || connectionId
    if (!id) return
    try {
      const res = await fetch(`/api/settings/connections?t=${Date.now()}`, { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      const conns: any[] = Array.isArray(data) ? data : (data?.connections || [])
      const conn = conns.find(c => c.id === id)
      if (conn) {
        setLiveTradeActive(conn.is_live_trade === "1" || conn.is_live_trade === true)
      }
    } catch { /* non-critical */ }
  }, [activeConnectionId, connectionId])

  const handleToggleLiveTrade = async () => {
    if (liveTradeLoading) return
    const id = activeConnectionId || connectionId
    if (!id) {
      addLog("No connection selected — start the engine first", "warning")
      return
    }
    const nextState = !liveTradeActive
    setLiveTradeLoading(true)
    addLog(`${nextState ? "Enabling" : "Disabling"} LIVE exchange trading...`, "info")
    try {
      const res = await fetch(`/api/settings/connections/${id}/live-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_live_trade: nextState }),
      })
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok || body?.success === false) {
        const hint = body?.hint ? ` — ${body.hint}` : ""
        addLog(`Live toggle failed: ${body?.error || res.statusText}${hint}`, "error")
        return
      }
      setLiveTradeActive(nextState)
      addLog(
        nextState
          ? "LIVE exchange trading ENABLED — real orders will be placed"
          : "LIVE exchange trading disabled",
        nextState ? "success" : "info",
      )
      // Refresh stats immediately so the Live counter reflects the new engine
      setTimeout(() => fetchStats(true), 1000)
    } catch (err) {
      addLog(`Live toggle error: ${err instanceof Error ? err.message : String(err)}`, "error")
    } finally {
      setLiveTradeLoading(false)
    }
  }

  // Sync live-trade status on mount and whenever the active connection changes
  useEffect(() => {
    refreshLiveTradeStatus()
  }, [refreshLiveTradeStatus])

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
        {/* ── action row ───────────────────────────────────��─────────────── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={isRunning ? "destructive" : "default"}
            onClick={isRunning ? handleStop : handleStart}
            disabled={starting || volatileSymbol.loading}
            className="h-7 text-xs px-2.5 gap-1"
          >
            {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : isRunning ? <StopCircle className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {starting
              ? "Starting..."
              : isRunning
                ? "Stop"
                : volatileSymbol.symbol
                  ? symbolCount === 1
                    ? `Start (${volatileSymbol.symbol})`
                    : `Start (top ${symbolCount})`
                  : "Start Engine"}
          </Button>

          {/* Symbol count selector — controls how many top-volatile symbols the quickstart processes. */}
          <div
            className="flex items-center gap-1 h-7 px-1.5 rounded-md border bg-muted/30"
            title="Number of top-volatile symbols to process (1-10)"
          >
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Symbols</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0 rounded text-xs"
              onClick={() => setSymbolCount(c => Math.max(1, c - 1))}
              disabled={symbolCount <= 1 || isRunning || starting}
              aria-label="Decrease symbol count"
            >
              −
            </Button>
            <span className="text-xs font-semibold tabular-nums w-4 text-center">{symbolCount}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0 rounded text-xs"
              onClick={() => setSymbolCount(c => Math.min(10, c + 1))}
              disabled={symbolCount >= 10 || isRunning || starting}
              aria-label="Increase symbol count"
            >
              +
            </Button>
          </div>

          {/* Live exchange-trading toggle — fires /api/settings/connections/[id]/live-trade */}
          <Button
            size="sm"
            variant={liveTradeActive ? "default" : "outline"}
            onClick={handleToggleLiveTrade}
            disabled={liveTradeLoading}
            className={`h-7 text-xs px-2.5 gap-1 ${liveTradeActive ? "bg-green-600 hover:bg-green-700 text-white" : ""}`}
            title={liveTradeActive ? "Live exchange trading is ON — click to disable" : "Enable live exchange trading"}
            aria-pressed={liveTradeActive}
          >
            {liveTradeLoading
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : (
                <span className={`relative flex h-2 w-2 ${liveTradeActive ? "" : "opacity-40"}`}>
                  {liveTradeActive && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-300 opacity-75" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${liveTradeActive ? "bg-white" : "bg-muted-foreground"}`} />
                </span>
              )
            }
            Live{liveTradeActive ? " ON" : ""}
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

        {/* ── historical processing row (always visible, BEFORE live stats) ──
            Shows prehistoric load status up-front so users can see how much
            historical context the engine has behind it before we show any
            realtime cycle counters. This mirrors the ordering the engine
            itself follows: historic data is loaded first, then live loops
            start — so the dashboard should read the same way top-to-bottom.
         */}
        <div
          className={`flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 ${
            stats.historicComplete
              ? "bg-green-50/50 dark:bg-green-950/20 border-green-500/20"
              : "bg-blue-50/40 dark:bg-blue-950/20 border-blue-500/20"
          }`}
        >
          <div className="flex items-center gap-1.5 shrink-0">
            <Database className={`w-3.5 h-3.5 ${stats.historicComplete ? "text-green-600 dark:text-green-500" : "text-blue-600 dark:text-blue-500"}`} />
            <span className="text-[11px] font-semibold text-foreground">Historical</span>
            {stats.historicComplete ? (
              <Badge className="bg-green-600 hover:bg-green-600 text-white h-4 text-[9px] px-1.5 py-0">Loaded</Badge>
            ) : (
              <Badge variant="secondary" className="h-4 text-[9px] px-1.5 py-0 tabular-nums">
                {stats.historicProgress}%
              </Badge>
            )}
          </div>

          {/* inline progress bar when still loading — keeps the row slim */}
          {!stats.historicComplete && (
            <div className="flex-1 min-w-[80px] max-w-[160px] h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500/70 rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(0, stats.historicProgress))}%` }}
              />
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 ml-auto">
            <MiniStat
              label="Symbols"
              value={`${stats.historicSymbols}/${stats.historicSymbolsTotal || "—"}`}
            />
            {/* Frames — the BIG count when timeframe=1s. Each frame = one
                timeframe-interval tick processed by the config-set processor.
                At 1s over 8h this is ~28,800 per symbol, which is the
                "big number" the dashboard used to miss entirely. */}
            {stats.historicFrames > 0 && (
              <MiniStat
                label={stats.historicTimeframeSec === 1 ? "Frames 1s" : `Frames ${stats.historicTimeframeSec}s`}
                value={fmt(stats.historicFrames)}
                sub={stats.historicFramesMissing > 0 ? `${fmt(stats.historicFramesMissing)} new` : undefined}
              />
            )}
            {stats.historicCandles > 0 && (
              <MiniStat label="Candles" value={fmt(stats.historicCandles)} />
            )}
            {stats.historicIndicators > 0 && (
              <MiniStat label="Indicators" value={fmt(stats.historicIndicators)} />
            )}
            <MiniStat label="P-Cycles" value={fmt(stats.historicCycles)} />
          </div>
        </div>

        {/* ── live processing row (always visible, AFTER historical) ───── */}
        <div className="flex flex-wrap gap-1.5">
          <MiniStat label="Ind Cycles"   value={fmt(stats.indicationCycles)}  />
          <MiniStat label="Indications"  value={fmt(stats.indicationsTotal)}   />
          <MiniStat label="Strategies"   value={fmt(stats.strategiesTotal)}    />
          <MiniStat label="Positions"    value={fmt(stats.positionsOpen)}      />
          {/* Live positions — real exchange positions mirrored by the live engine.
              Always shown (even at 0) so users can see the counter spin up. */}
          <div
            className={`flex flex-col items-center justify-center rounded px-2 py-1.5 min-w-[52px] border ${
              stats.livePositionsOpen > 0
                ? "bg-green-50 dark:bg-green-950/30 border-green-300 dark:border-green-900/50"
                : "bg-muted/60 border-transparent"
            }`}
            title={`Live positions open on exchange · Filled ${stats.liveOrdersFilled}/${stats.liveOrdersPlaced} · WR ${stats.liveWinRate.toFixed(1)}%`}
          >
            <span className={`text-[13px] font-bold tabular-nums leading-none ${
              stats.livePositionsOpen > 0 ? "text-green-700 dark:text-green-400" : "text-foreground"
            }`}>
              {fmt(stats.livePositionsOpen)}
            </span>
            <span className="text-[9px] text-muted-foreground leading-none mt-0.5 flex items-center gap-0.5">
              {liveTradeActive && stats.livePositionsOpen > 0 && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                </span>
              )}
              Live Pos
            </span>
          </div>
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
                {stats.historicFrames > 0 && (
                  <MiniStat
                    label={`Frames ${stats.historicTimeframeSec}s`}
                    value={fmt(stats.historicFrames)}
                    sub={stats.historicFramesMissing > 0 ? `${fmt(stats.historicFramesMissing)} missing` : undefined}
                  />
                )}
                {stats.historicCandles > 0 && (
                  <MiniStat label="Candles" value={fmt(stats.historicCandles)} />
                )}
                {stats.historicIndicators > 0 && (
                  <MiniStat label="Indicators" value={fmt(stats.historicIndicators)} />
                )}
              </div>
            </div>

            {/* processing cycles overview */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <Activity className="w-3.5 h-3.5 text-blue-500" />
                Processing Cycles
                {stats.realtimeCycles > 0 && (
                  <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                    Realtime {fmt(stats.realtimeCycles)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <MiniStat label="Ind Cycles"  value={fmt(stats.indicationCycles)} sub={stats.realtimeCycles > 0 ? `${((stats.indicationCycles / Math.max(stats.realtimeCycles, 1)) * 100).toFixed(0)}% rt` : undefined} />
                <MiniStat label="Strat Cycles" value={fmt(stats.strategyCycles)}  sub={stats.indicationCycles > 0 ? `${((stats.strategyCycles / Math.max(stats.indicationCycles, 1)) * 100).toFixed(0)}% of ind` : undefined} />
                {stats.realtimeCycles > 0 && (
                  <MiniStat label="RT Cycles" value={fmt(stats.realtimeCycles)} />
                )}
                <MiniStat label="Indications" value={fmt(stats.indicationsTotal)} sub={stats.indicationCycles > 0 ? `${(stats.indicationsTotal / Math.max(stats.indicationCycles, 1)).toFixed(1)}/cyc` : undefined} />
                <MiniStat label="Strategies"  value={fmt(stats.strategiesTotal)}  sub={stats.strategyCycles > 0 ? `${(stats.strategiesTotal / Math.max(stats.strategyCycles, 1)).toFixed(1)}/cyc` : undefined} />
              </div>
            </div>

            {/* ── Indication Configuration Possible Counts (Sets) ────────
                Renders the *possible* Set enumeration per Main indication
                type (direction / move / active / optimal / auto), derived
                purely from the current settings. Each row shows:
                  • the number of Independent Sets this type could spawn
                  • the formula (ranges × ratios × variations, etc.)
                  • the calc parameters (ranges, steps, time windows,
                    drawdown gate) so the operator understands what drives
                    the number.
                NOTE: this is CAPACITY — the engine may generate fewer at
                runtime based on live gating. Summing the five type totals
                gives the theoretical ceiling of Sets per symbol.
             */}
            {configCounts && (
              <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                    <Database className="w-3.5 h-3.5 text-cyan-500" />
                    Indication Config — Possible Sets
                  </div>
                  <span
                    className="text-[10px] text-muted-foreground tabular-nums"
                    title="Sum of possible Independent Sets across all 5 Main indication types, per symbol. Each Set has its own position DB (capacity shown)."
                  >
                    Total {fmt(configCounts.totalPossibleSets)} Sets
                    {" · "}
                    <span className="text-muted-foreground/70">
                      {configCounts.perSetDbCapacity}/Set DB
                    </span>
                  </span>
                </div>

                {/* Settings-drive hint row: ranges & divisor */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
                  <span>
                    range <span className="text-foreground tabular-nums">
                      {configCounts.settings.indicationRangeMin}–{configCounts.settings.indicationRangeMax}
                    </span> step <span className="text-foreground tabular-nums">
                      {configCounts.settings.indicationRangeStep}
                    </span>
                  </span>
                  <span>
                    tp-divisor <span className="text-foreground tabular-nums">
                      {configCounts.settings.takeProfitRangeDivisor}
                    </span>
                  </span>
                  <span>
                    valid ranges <span className="text-foreground tabular-nums">
                      {configCounts.settings.validRangeCount}
                    </span>
                  </span>
                </div>

                {/* Per-type rows */}
                <div className="space-y-1">
                  {configCounts.types.map((t) => {
                    const pct = configCounts.totalPossibleSets > 0
                      ? Math.min(100, (t.possibleSets / configCounts.totalPossibleSets) * 100)
                      : 0
                    // color-code each indication type with a distinct hue so the
                    // row reads at a glance.
                    const hue: Record<string, string> = {
                      direction: "bg-violet-500/70",
                      move:      "bg-sky-500/70",
                      active:    "bg-amber-500/70",
                      optimal:   "bg-emerald-500/70",
                      auto:      "bg-rose-500/70",
                    }
                    return (
                      <div key={t.type} className="space-y-0.5">
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className="w-14 text-foreground shrink-0 font-medium capitalize">
                            {t.type}
                          </span>
                          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${hue[t.type] ?? "bg-muted-foreground/40"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-12 text-right tabular-nums font-semibold">
                            {fmt(t.possibleSets)}
                          </span>
                          <span className="w-10 text-right tabular-nums text-muted-foreground">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                        <div
                          className="pl-16 text-[9px] text-muted-foreground/80 truncate"
                          title={`${t.formula}${t.description ? " — " + t.description : ""}`}
                        >
                          {t.formula}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

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
                      <span className="w-8 text-right tabular-nums text-muted-foreground">{pct.toFixed(0)}%</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* strategies breakdown
                Base → Main → Real → Live is a CASCADE FILTER (eval → filter →
                adjust → promote). Each stage operates on the SURVIVORS of the
                previous stage, so the four counters are NOT additive — each
                ratio below is stage-over-previous pass rate. The header total
                is the canonical strategy count = Real-stage output only. */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <BarChart3 className="w-3.5 h-3.5 text-amber-500" />
                Strategies
                <span
                  className="ml-auto text-[10px] text-muted-foreground font-normal"
                  title="Canonical total = Real-stage output. Base/Main are intermediate filter stages of the same strategy, not separate counts."
                >
                  Final (Real) {fmt(stats.stratReal)}
                </span>
              </div>
              <p className="text-[9px] text-muted-foreground/80 -mt-1 leading-tight">
                Cascade filter — each stage filters the survivors of the previous stage. Counts are <em>not</em> added together.
              </p>
              <div className="grid grid-cols-4 gap-1.5 text-center text-[10px]">
                {[
                  { label: "Base",   sub: "eval",    value: stats.stratBase, color: "text-orange-600 dark:text-orange-400", ratio: null },
                  { label: "Main",   sub: "filter",  value: stats.stratMain, color: "text-yellow-600 dark:text-yellow-400", ratio: stats.stratBase > 0 ? `${((stats.stratMain / stats.stratBase) * 100).toFixed(0)}% pass` : null },
                  { label: "Real",   sub: "adjust",  value: stats.stratReal, color: "text-green-600 dark:text-green-400",   ratio: stats.stratMain > 0 ? `${((stats.stratReal / stats.stratMain) * 100).toFixed(0)}% pass` : null },
                  { label: "Live",   sub: "promote", value: stats.stratLive, color: "text-blue-600 dark:text-blue-400",     ratio: stats.stratReal > 0 ? `${((stats.stratLive / stats.stratReal) * 100).toFixed(0)}% live` : null },
                ].map(({ label, sub, value, color, ratio }) => (
                  <div key={label} className="rounded bg-muted/60 py-1.5 px-1">
                    <div className={`text-sm font-bold tabular-nums ${color}`}>{fmt(value)}</div>
                    <div className="text-muted-foreground">
                      {label}
                      <span className="text-[9px] text-muted-foreground/70"> ({sub})</span>
                    </div>
                    {ratio && <div className="text-[9px] text-muted-foreground/70">{ratio}</div>}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Strategy Stages — detailed per-stage metrics ───────────
                Shows sets validated from prev stage (passed count), avg
                positions per Set, avg profit factor and avg drawdown time
                for each stage of the BASE → MAIN → REAL → LIVE flow.

                These values come from `strategy_detail:{connId}:{stage}`
                Redis hashes, written by StrategyCoordinator after each
                cycle. Missing columns render as "—" when the stage hasn't
                produced work yet (e.g. Real before any Main set passes).
             */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <BarChart3 className="w-3.5 h-3.5 text-green-600 dark:text-green-500" />
                Strategy Stages — Validated Sets & Averages
                <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                  From prev stage
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border/40">
                      <th className="text-left py-1 pr-2 font-medium">Stage</th>
                      <th className="text-right py-1 px-1 font-medium" title="Sets that passed the filter from the previous stage">Valid/Prev</th>
                      <th className="text-right py-1 px-1 font-medium" title="Average config entries per Set (position coordinations)">Pos/Set</th>
                      <th className="text-right py-1 px-1 font-medium" title="Average profit factor across validated Sets">PF</th>
                      <th className="text-right py-1 pl-1 font-medium" title="Average drawdown time in minutes">DDT m</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: "Base", color: "text-orange-600 dark:text-orange-400", d: stats.stageBase, prev: 0 },
                      { label: "Main", color: "text-yellow-600 dark:text-yellow-400", d: stats.stageMain, prev: stats.stageBase.createdSets },
                      { label: "Real", color: "text-green-600 dark:text-green-400",   d: stats.stageReal, prev: stats.stageMain.createdSets },
                      { label: "Live", color: "text-blue-600 dark:text-blue-400",     d: stats.stageLive, prev: stats.stageReal.createdSets },
                    ].map(({ label, color, d, prev }) => (
                      <tr key={label} className="border-b border-border/20 last:border-0">
                        <td className={`py-1 pr-2 font-semibold ${color}`}>{label}</td>
                        <td className="text-right py-1 px-1">
                          {fmt(d.passed || d.createdSets)}
                          <span className="text-muted-foreground">/{prev > 0 ? fmt(prev) : "—"}</span>
                          {d.passRatio > 0 && (
                            <span className="text-muted-foreground/70 text-[9px] ml-1">{d.passRatio.toFixed(0)}%</span>
                          )}
                        </td>
                        <td className="text-right py-1 px-1">{d.avgPosPerSet > 0 ? d.avgPosPerSet.toFixed(1) : "—"}</td>
                        <td className="text-right py-1 px-1">{d.avgProfitFactor > 0 ? d.avgProfitFactor.toFixed(2) : "—"}</td>
                        <td className="text-right py-1 pl-1">{d.avgDrawdownTime > 0 ? Math.round(d.avgDrawdownTime) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Main-stage Coordination snapshot ────────────────────────
                Shows how the Main stage is coordinating RIGHT NOW:
                  • active variants gated ON by the live position context
                  • cache reuse rate (higher = Main isn't re-expanding
                    unchanged Base Sets every cycle = cheaper + faster)
                  • the position-context snapshot (open positions, recent
                    wins/losses) that drives which variants are active
                This gives the operator an immediate yes/no answer to
                "is the Main stage coordinating correctly?" without
                having to read the variants table.
             */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <Activity className="w-3.5 h-3.5 text-emerald-500" />
                Main Coordination
                <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                  {stats.mainCoord.totalCycles > 0 ? `${fmt(stats.mainCoord.totalCycles)} cycles` : "idle"}
                </span>
              </div>
              {/* Active variants pills — green = active this cycle, muted = gated off */}
              <div className="flex flex-wrap items-center gap-1 text-[10px]">
                <span className="text-muted-foreground mr-1">Active variants:</span>
                {(["default", "trailing", "block", "dca"] as const).map((v) => {
                  const active = stats.mainCoord.activeVariants.includes(v)
                  return (
                    <span
                      key={v}
                      className={
                        "rounded px-1.5 py-0.5 font-medium tabular-nums " +
                        (active
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                          : "bg-muted/60 text-muted-foreground/70")
                      }
                      title={active ? "Gated active this cycle" : "Gated off by position context"}
                    >
                      {v}
                    </span>
                  )
                })}
                <span className="ml-auto text-muted-foreground">
                  {stats.mainCoord.activeVariantCount}/4
                </span>
              </div>

              {/* Grid: reuse metrics | position context */}
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                {/* Reuse / creation metrics */}
                <div className="rounded bg-muted/40 p-1.5 space-y-0.5">
                  <div className="text-muted-foreground text-[9px] uppercase tracking-wide">
                    Related Sets
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {fmt(stats.mainCoord.totalReused)}
                    </span>
                    <span className="text-muted-foreground">reused</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {stats.mainCoord.reuseRate > 0 ? `${stats.mainCoord.reuseRate.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold tabular-nums">
                      {fmt(stats.mainCoord.totalCreated)}
                    </span>
                    <span className="text-muted-foreground">created</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      last: {stats.mainCoord.lastCreated}+{stats.mainCoord.lastReused}
                    </span>
                  </div>
                </div>

                {/* Position context — drives variant gating */}
                <div className="rounded bg-muted/40 p-1.5 space-y-0.5">
                  <div className="text-muted-foreground text-[9px] uppercase tracking-wide">
                    Position Context
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold tabular-nums">
                      {stats.mainCoord.positionContext.continuous}
                    </span>
                    <span className="text-muted-foreground">open</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">{stats.mainCoord.positionContext.lastWins}W</span>
                      {" / "}
                      <span className="text-rose-600 dark:text-rose-400">{stats.mainCoord.positionContext.lastLosses}L</span>
                      <span className="text-muted-foreground/70"> last5</span>
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold tabular-nums">
                      {stats.mainCoord.positionContext.prevTotal}
                    </span>
                    <span className="text-muted-foreground">closed 24h</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      <span className="text-rose-600 dark:text-rose-400">{stats.mainCoord.positionContext.prevLosses}L</span>
                      <span className="text-muted-foreground/70"> / total</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Strategy Variants — per-type breakdown ─────────────────
                The Main stage now produces one DEDICATED Set per active
                variant (linked to its Base parent via parentSetKey):
                  Default  — always on: validates the Base Set
                  Trailing — recent winners with no open position
                  Block    — open position available to add to
                  DCA      — recent losses to recover
                Each row shows cumulative Sets containing that variant,
                total position-coordination entries emitted, avg positions
                per Set, and the weighted PF/DDT across entries of the
                variant. The "Overall" row is a createdSets-weighted mean
                across all four variants.
             */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                <BarChart3 className="w-3.5 h-3.5 text-sky-500" />
                Strategy Variants — PF &amp; DDT per Type
                <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                  Positions @ Main
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border/40">
                      <th className="text-left py-1 pr-2 font-medium">Type</th>
                      <th className="text-right py-1 px-1 font-medium" title="Sets containing ≥1 entry of this variant">Sets</th>
                      <th className="text-right py-1 px-1 font-medium" title="Total position-coordination entries of this variant">Entries</th>
                      <th className="text-right py-1 px-1 font-medium" title="Average entries per Set for this variant">Pos/Set</th>
                      <th className="text-right py-1 px-1 font-medium">PF</th>
                      <th className="text-right py-1 pl-1 font-medium">DDT m</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: "Default",  color: "text-slate-600  dark:text-slate-400",  d: stats.variantDefault  },
                      { label: "Trailing", color: "text-cyan-600   dark:text-cyan-400",   d: stats.variantTrailing },
                      { label: "Block",    color: "text-fuchsia-600 dark:text-fuchsia-400", d: stats.variantBlock   },
                      { label: "DCA",      color: "text-amber-600  dark:text-amber-400",  d: stats.variantDca      },
                    ].map(({ label, color, d }) => (
                      <tr key={label} className="border-b border-border/20">
                        <td className={`py-1 pr-2 font-semibold ${color}`}>{label}</td>
                        <td className="text-right py-1 px-1">{fmt(d.createdSets)}</td>
                        <td className="text-right py-1 px-1">{fmt(d.entriesCount)}</td>
                        <td className="text-right py-1 px-1">{d.avgPosPerSet > 0 ? d.avgPosPerSet.toFixed(1) : "—"}</td>
                        <td className="text-right py-1 px-1">{d.avgProfitFactor > 0 ? d.avgProfitFactor.toFixed(2) : "—"}</td>
                        <td className="text-right py-1 pl-1">{d.avgDrawdownTime > 0 ? Math.round(d.avgDrawdownTime) : "—"}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border/40 font-semibold">
                      <td className="py-1 pr-2 text-foreground">Overall</td>
                      <td className="text-right py-1 px-1">{fmt(stats.variantOverall.createdSets)}</td>
                      <td className="text-right py-1 px-1">{fmt(stats.variantOverall.entriesCount)}</td>
                      <td className="text-right py-1 px-1">
                        {stats.variantOverall.createdSets > 0
                          ? (stats.variantOverall.entriesCount / Math.max(1, stats.variantOverall.createdSets)).toFixed(1)
                          : "—"}
                      </td>
                      <td className="text-right py-1 px-1">{stats.variantOverall.avgProfitFactor > 0 ? stats.variantOverall.avgProfitFactor.toFixed(2) : "—"}</td>
                      <td className="text-right py-1 pl-1">{stats.variantOverall.avgDrawdownTime > 0 ? Math.round(stats.variantOverall.avgDrawdownTime) : "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* processing status pills */}
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {[
                { label: "Prehistoric",  done: stats.historicComplete },
                { label: "Indications",  done: stats.indicationCycles > 0 },
                { label: "Strategies",   done: stats.strategyCycles > 0 },
                { label: "Realtime",     done: stats.isActive },
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

            {/* ── Live Exchange Positions & Account Balance (footer) ───
                Real-exchange snapshot across ALL enabled connections. This
                is intentionally the LAST block in the quickstart card so
                the operator can see, at the end of the status scroll, what
                is actually live on the exchange right now.

                Totals row renders: total open positions (long/short split),
                unrealised PnL, total + available balance, equity. Below it
                we show a compact row per connection with its own open-
                position count, PnL and balance — useful when running
                multiple accounts simultaneously.
             */}
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <Activity className="w-3.5 h-3.5 text-emerald-500" />
                  Live Exchange — Positions &amp; Balance
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {liveSummary
                    ? `${liveSummary.connections.length} conn${liveSummary.connections.length === 1 ? "" : "s"}`
                    : "loading…"}
                </span>
              </div>

              {/* Totals row — top-level roll-up across connections */}
              <div className="flex flex-wrap gap-1.5">
                <MiniStat
                  label="Open Pos"
                  value={fmt(liveSummary?.totals.openPositions ?? 0)}
                  sub={liveSummary
                    ? `${liveSummary.totals.longPositions}L / ${liveSummary.totals.shortPositions}S`
                    : undefined}
                />
                <MiniStat
                  label="Unrealised PnL"
                  value={(() => {
                    const v = liveSummary?.totals.unrealizedPnl ?? 0
                    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`
                  })()}
                  sub={liveSummary?.totals.currency}
                />
                <MiniStat
                  label="Balance"
                  value={(liveSummary?.totals.totalBalance ?? 0).toFixed(2)}
                  sub={liveSummary?.totals.currency}
                />
                <MiniStat
                  label="Available"
                  value={(liveSummary?.totals.availableBalance ?? 0).toFixed(2)}
                  sub={liveSummary?.totals.currency}
                />
                <MiniStat
                  label="Equity"
                  value={(liveSummary?.totals.equity ?? 0).toFixed(2)}
                  sub={liveSummary?.totals.currency}
                />
              </div>

              {/* Per-connection compact rows (only when >1 connection or >0 positions) */}
              {liveSummary && liveSummary.connections.length > 0 && (
                <div className="space-y-0.5 pt-1">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[9px] uppercase tracking-wide text-muted-foreground/70 pb-0.5 border-b border-border/40">
                    <span>Connection</span>
                    <span className="text-right">Pos</span>
                    <span className="text-right">PnL</span>
                    <span className="text-right">Balance</span>
                  </div>
                  {liveSummary.connections.map((c) => (
                    <div
                      key={c.connectionId}
                      className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[10px] items-baseline"
                    >
                      <span className="truncate">
                        <span className="font-medium">{c.name}</span>
                        {c.exchange && (
                          <span className="text-muted-foreground/70 ml-1">
                            {c.exchange}
                          </span>
                        )}
                      </span>
                      <span className="text-right tabular-nums">
                        {c.openPositions}
                        {c.openPositions > 0 && (
                          <span className="text-muted-foreground/70 ml-1">
                            {c.longPositions}L/{c.shortPositions}S
                          </span>
                        )}
                      </span>
                      <span
                        className={
                          "text-right tabular-nums " +
                          (c.unrealizedPnl > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : c.unrealizedPnl < 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-muted-foreground")
                        }
                      >
                        {c.unrealizedPnl >= 0 ? "+" : ""}{c.unrealizedPnl.toFixed(2)}
                      </span>
                      <span className="text-right tabular-nums">
                        {c.balance.total.toFixed(2)}
                        <span className="text-muted-foreground/70 ml-0.5">
                          {c.balance.currency}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {liveSummary && liveSummary.connections.length === 0 && (
                <div className="text-[10px] text-muted-foreground text-center py-1">
                  No enabled connections — enable a connection to see live positions &amp; balance.
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
