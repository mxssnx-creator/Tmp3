"use client"

import React, { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import {
  BarChart3, RefreshCw, Database, Activity, Zap, TrendingUp,
  ChevronDown, ChevronUp, CheckCircle2, Circle, Clock,
} from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ─── types ────────────────────────────────────────────────────────────────────

interface StratDetail {
  avgPosPerSet: number
  createdSets: number
  avgProfitFactor: number
  avgProcessingTimeMs: number
  evalPct: number
  // Shared optional fields also present on real and live tiers
  avgPosEvalReal?: number
  countPosEval?: number
  avgDrawdownTime?: number
  passRatio?: number
  evaluated?: number
  passed?: number
  failed?: number
  // Live-exclusive fields (populated only for strategyDetail.live)
  winRate?: number
  totalPnl?: number
  avgPnl?: number
  openPositions?: number
  volumeUsdTotal?: number
}

interface StatsResponse {
  historic: {
    symbolsProcessed: number; symbolsTotal: number; candlesLoaded: number
    indicatorsCalculated: number; cyclesCompleted: number; isComplete: boolean; progressPercent: number
  }
  realtime: {
    indicationCycles: number; strategyCycles: number; realtimeCycles: number
    indicationsTotal: number; strategiesTotal: number; positionsOpen: number
    isActive: boolean; successRate: number; avgCycleTimeMs: number
  }
  breakdown: {
    indications: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
    strategies: { base: number; main: number; real: number; live: number; total: number
                  baseEvaluated: number; mainEvaluated: number; realEvaluated: number }
  }
  strategyDetail: { base: StratDetail; main: StratDetail; real: StratDetail; live?: StratDetail }
  windows: { indications: { last5m: number; last60m: number }; strategies: { last5m: number; last60m: number } }
  metadata: { engineRunning: boolean; phase: string; progress: number; message: string; lastUpdate: string }
}

interface LogEntry {
  timestamp: string; level: string; phase: string; message: string; details?: any
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function pct(a: number, b: number) {
  if (!b) return "0%"
  return `${Math.round((a / b) * 100)}%`
}

function StatCell({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded bg-muted/50 p-2 text-center min-w-0">
      <div className={`text-base font-bold tabular-nums truncate ${accent || "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground leading-none mt-0.5">{sub}</div>}
      <div className="text-[10px] text-muted-foreground leading-none mt-0.5">{label}</div>
    </div>
  )
}

// ─── StratSection ─────────────────────────────────────────────────────────────

function StratSection({
  label, count, evaluated, evaluatedOf, detail, accentCls, bgCls,
}: {
  label: string; count: number; evaluated: number; evaluatedOf: number
  detail: StratDetail | undefined; accentCls: string; bgCls: string
}) {
  const evalPct = evaluatedOf > 0 ? Math.round((evaluated / evaluatedOf) * 1000) / 10 : (detail?.evalPct ?? 0)

  return (
    <div className={`rounded-md border p-2.5 space-y-2 ${bgCls}`}>
      {/* header */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold ${accentCls}`}>{label}</span>
        <span className={`text-lg font-bold tabular-nums ${accentCls}`}>{fmt(count)}</span>
      </div>

      {/* eval bar — only for Main and Real */}
      {evaluatedOf > 0 && (
        <div className="space-y-0.5">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Evaluated of {label === "Main" ? "Base" : "Main"}</span>
            <span className="font-medium tabular-nums">{evalPct.toFixed(1)}%</span>
          </div>
          <Progress value={Math.min(100, evalPct)} className="h-1" />
          <div className="text-[9px] text-muted-foreground text-right">
            {fmt(evaluated)} / {fmt(evaluatedOf)} sets
          </div>
        </div>
      )}

      {/* detail metrics */}
      {detail && (
        <div className="grid grid-cols-2 gap-1 text-[10px]">
          {detail.createdSets > 0 && (
            <div className="flex justify-between col-span-2">
              <span className="text-muted-foreground">Created Sets</span>
              <span className="font-medium tabular-nums">{fmt(detail.createdSets)}</span>
            </div>
          )}
          {detail.avgPosPerSet > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg Pos/Set</span>
              <span className="font-medium tabular-nums">{detail.avgPosPerSet.toFixed(2)}</span>
            </div>
          )}
          {detail.avgProfitFactor > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg PF</span>
              <span className="font-medium tabular-nums">{detail.avgProfitFactor.toFixed(3)}</span>
            </div>
          )}
          {detail.avgProcessingTimeMs > 0 && (
            <div className="flex justify-between col-span-2">
              <span className="text-muted-foreground">Avg Proc Time</span>
              <span className="font-medium tabular-nums">{detail.avgProcessingTimeMs.toFixed(1)}ms</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── IndWindow ────────────────────────────────────────────────────────────────

function IndWindow({ label, count, total }: { label: string; count: number; total: number }) {
  const p = total > 0 ? Math.min(100, (count / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-14 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-violet-500/70 rounded-full transition-all" style={{ width: `${p}%` }} />
      </div>
      <span className="w-12 text-right tabular-nums font-medium">{fmt(count)}</span>
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────���───────

export function QuickstartOverviewDialog() {
  const { selectedConnectionId, selectedConnection, selectedExchange } = useExchange()
  const connectionId = selectedConnectionId || "default-bingx-001"
  const connectionLabel = selectedConnection?.name || (selectedExchange || "").toUpperCase() || connectionId

  const [isOpen, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [expandedLog, setExpandedLog] = useState<number | null>(null)
  const pollRef = useRef<NodeJS.Timeout>()

  const load = useCallback(async (silent = false) => {
    if (!connectionId) return
    if (!silent) setLoading(true)
    try {
      const [statsRes, logsRes] = await Promise.all([
        fetch(`/api/connections/progression/${connectionId}/stats`, { cache: "no-store" }),
        fetch(`/api/connections/progression/${connectionId}/logs?t=${Date.now()}`, { cache: "no-store" }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (logsRes.ok) {
        const d = await logsRes.json()
        setLogs((d.logs || d.recentLogs || []).slice(0, 200))
      }
      setLastRefresh(new Date())
    } catch { /* non-critical */ }
    finally { if (!silent) setLoading(false) }
  }, [connectionId])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!isOpen) return
    load()
    pollRef.current = setInterval(() => load(true), 3000)
    return () => clearInterval(pollRef.current)
  }, [isOpen, load])

  const h   = stats?.historic
  const rt  = stats?.realtime
  const bd  = stats?.breakdown
  const sd  = stats?.strategyDetail
  const win = stats?.windows

  const indTypes = [
    { label: "Direction", value: bd?.indications.direction || 0 },
    { label: "Move",      value: bd?.indications.move      || 0 },
    { label: "Active",    value: bd?.indications.active    || 0 },
    { label: "Optimal",   value: bd?.indications.optimal   || 0 },
    { label: "Auto",      value: bd?.indications.auto      || 0 },
  ]
  const totalIndByType = indTypes.reduce((s, r) => s + r.value, 0) || 1
  const evalMain5m  = win?.indications.last5m  || 0
  const evalMain60m = win?.indications.last60m || 0
  const totalIndAll = rt?.indicationsTotal || bd?.indications.total || 0

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1" title="Engine overview">
          <BarChart3 className="h-3.5 w-3.5" />
          Overview
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden p-0">
        {/* header */}
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="w-4 h-4" />
            Engine Overview
            {connectionLabel && (
              <Badge variant="secondary" className="text-[10px] font-normal">{connectionLabel}</Badge>
            )}
            {stats?.metadata?.engineRunning && (
              <Badge className="bg-green-600 text-[10px] h-4 px-1.5">Running</Badge>
            )}
            <Button
              size="icon" variant="ghost" className="ml-auto h-6 w-6"
              onClick={() => load()} disabled={loading} title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
          {lastRefresh && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Updated {lastRefresh.toLocaleTimeString()}
              {stats?.metadata?.phase && stats.metadata.phase !== "—" && (
                <> &bull; <span className="capitalize">{stats.metadata.phase.replace(/_/g, " ")}</span></>
              )}
            </p>
          )}
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0 grid grid-cols-5 h-8 rounded-none border-b bg-transparent px-4">
            {["overview","prehistoric","indications","strategies","logs"].map(tab => (
              <TabsTrigger key={tab} value={tab} className="text-[11px] capitalize h-7 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── Overview ─────────────────────────────────────────────────── */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Historical Processing — shown FIRST, matching the engine's
                own top-to-bottom flow: historic load → live cycles → exec.
                This section was previously buried in the separate
                "prehistoric" tab, which meant users opening the Overview tab
                saw zero historical context up front. */}
            <div className="rounded-md border p-3 space-y-2 bg-blue-50/30 dark:bg-blue-950/20">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Database className="w-3.5 h-3.5 text-blue-500" />
                Historical Processing
                {h?.isComplete ? (
                  <Badge className="bg-green-600 hover:bg-green-600 text-white text-[10px] h-4 px-1.5 ml-auto">Loaded</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto tabular-nums">
                    {h?.progressPercent || 0}%
                  </Badge>
                )}
              </div>
              {!h?.isComplete && (
                <Progress value={h?.progressPercent || 0} className="h-1.5" />
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell
                  label="Symbols"
                  value={`${h?.symbolsProcessed || 0}/${h?.symbolsTotal || 0}`}
                  accent="text-blue-600 dark:text-blue-400"
                />
                <StatCell label="Candles"     value={fmt(h?.candlesLoaded       || 0)} accent="text-sky-600 dark:text-sky-400" />
                <StatCell label="Indicators"  value={fmt(h?.indicatorsCalculated|| 0)} accent="text-teal-600 dark:text-teal-400" />
                <StatCell label="Preh Cycles" value={fmt(h?.cyclesCompleted     || 0)} accent="text-indigo-600 dark:text-indigo-400" />
              </div>
            </div>

            {/* Live Processing counters (Ind Cycles / Strat Cycles / Indications / Positions). */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                Live Processing
                {rt?.isActive && <Badge className="bg-blue-600 text-[10px] h-4 px-1.5 ml-auto">Active</Badge>}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell label="Ind Cycles"   value={fmt(rt?.indicationCycles || 0)}  accent="text-blue-600 dark:text-blue-400" />
                <StatCell label="Strat Cycles" value={fmt(rt?.strategyCycles   || 0)}  accent="text-violet-600 dark:text-violet-400" />
                <StatCell label="Indications"  value={fmt(rt?.indicationsTotal || 0)}  accent="text-green-600 dark:text-green-400" />
                <StatCell label="Positions"    value={fmt(rt?.positionsOpen    || 0)}  accent="text-amber-600 dark:text-amber-400" />
              </div>
            </div>

            {/* time windows */}
            {(evalMain5m > 0 || evalMain60m > 0) && (
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                  Activity Windows
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last 5 min</span>
                    <span className="font-medium tabular-nums">{fmt(evalMain5m)} ind</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last 60 min</span>
                    <span className="font-medium tabular-nums">{fmt(evalMain60m)} ind</span>
                  </div>
                </div>
              </div>
            )}

            {/* strategies compact overview */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Zap className="w-3.5 h-3.5 text-amber-500" />
                Strategies Summary
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <StatCell label="Base" value={fmt(bd?.strategies.base || 0)} accent="text-orange-600 dark:text-orange-400" />
                <StatCell label="Main" value={fmt(bd?.strategies.main || 0)} accent="text-yellow-600 dark:text-yellow-400"
                  sub={bd?.strategies.base ? `${pct(bd.strategies.main, bd.strategies.base)} of Base` : undefined}
                />
                <StatCell label="Real" value={fmt(bd?.strategies.real || 0)} accent="text-green-600 dark:text-green-400"
                  sub={bd?.strategies.main ? `${pct(bd.strategies.real, bd.strategies.main)} of Main` : undefined}
                />
                {/* Live = real exchange positions, tracked locally — so the UI
                    can show exchange-side outcomes without an exchange fetch. */}
                <StatCell label="Live" value={fmt(sd?.live?.createdSets || 0)} accent="text-amber-600 dark:text-amber-400"
                  sub={bd?.strategies.real ? `${pct(sd?.live?.createdSets || 0, bd.strategies.real)} of Real` : undefined}
                />
              </div>
            </div>

            {/* success rate + cycle time */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><TrendingUp className="w-3 h-3" />Success Rate</span>
                  <span className="font-bold tabular-nums">{(rt?.successRate || 0).toFixed(1)}%</span>
                </div>
                <Progress value={rt?.successRate || 0} className="h-1.5" />
              </div>
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-1 font-medium"><Clock className="w-3 h-3" />Avg Cycle</span>
                  <span className="font-bold tabular-nums">{rt?.avgCycleTimeMs || 0}ms</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {[
                    { label: "Historic",    done: h?.isComplete },
                    { label: "Indications", done: (rt?.indicationCycles || 0) > 0 },
                    { label: "Strategies",  done: (rt?.strategyCycles   || 0) > 0 },
                    { label: "Realtime",    done: rt?.isActive },
                  ].map(({ label, done }) => (
                    <Badge key={label} variant={done ? "default" : "secondary"} className="text-[9px] h-4 px-1">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── Prehistoric ───────────────────────────────────────────────── */}
          <TabsContent value="prehistoric" className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-500" />
                <span className="text-sm font-semibold">Prehistoric Processing</span>
                {h?.isComplete
                  ? <Badge className="bg-green-600 text-[10px] ml-auto">Loaded</Badge>
                  : <Badge variant="secondary" className="text-[10px] ml-auto">Processing…</Badge>
                }
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Symbols: {h?.symbolsProcessed || 0} / {h?.symbolsTotal || 0}</span>
                  <span>{h?.progressPercent || 0}%</span>
                </div>
                <Progress value={h?.progressPercent || 0} className="h-2" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatCell label="Symbols"      value={fmt(h?.symbolsProcessed    || 0)} accent="text-blue-600 dark:text-blue-400" />
                <StatCell label="Candles"      value={fmt(h?.candlesLoaded       || 0)} accent="text-sky-600 dark:text-sky-400" />
                <StatCell label="Indicators"   value={fmt(h?.indicatorsCalculated|| 0)} accent="text-teal-600 dark:text-teal-400" />
                <StatCell label="Preh Cycles"  value={fmt(h?.cyclesCompleted     || 0)} accent="text-indigo-600 dark:text-indigo-400" />
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                {[
                  { label: "Data Loaded",   done: h?.isComplete },
                  { label: "Ind Running",   done: (rt?.indicationCycles || 0) > 0 },
                  { label: "Strat Running", done: (rt?.strategyCycles   || 0) > 0 },
                  { label: "Live Active",   done: rt?.isActive },
                ].map(({ label, done }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    {done ? <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" /> : <Circle className="w-3 h-3 text-muted-foreground/30 shrink-0" />}
                    <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── Indications ───────────────────────────────────────────────── */}
          <TabsContent value="indications" className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* time window summary */}
            <div className="grid grid-cols-3 gap-2">
              <StatCell label="Total" value={fmt(totalIndAll)} accent="text-violet-600 dark:text-violet-400" />
              <StatCell label="Last 5min"  value={fmt(evalMain5m)}  sub="rolling window" />
              <StatCell label="Last 60min" value={fmt(evalMain60m)} sub="rolling window" />
            </div>

            {/* per-type bars */}
            <div className="rounded-md border p-3 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-violet-500" />
                  Indication Types
                </span>
                <span className="text-muted-foreground">{fmt(rt?.indicationCycles || 0)} cycles</span>
              </div>
              <div className="space-y-2">
                {indTypes.map(({ label, value }) => (
                  <IndWindow key={label} label={label} count={value} total={totalIndByType} />
                ))}
              </div>
            </div>

            {/* last 5 evaluated (simulated from ratio if not available) */}
            <div className="rounded-md border p-3 space-y-2">
              <div className="text-xs font-semibold">Eval Counts — Last Periods</div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {indTypes.map(({ label, value }) => {
                  const ratio5m  = totalIndAll > 0 && evalMain5m  > 0 ? (value / totalIndAll) * evalMain5m  : 0
                  const ratio60m = totalIndAll > 0 && evalMain60m > 0 ? (value / totalIndAll) * evalMain60m : 0
                  return (
                    <React.Fragment key={label}>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{label} 5m</span>
                        <span className="font-medium tabular-nums">{fmt(Math.round(ratio5m))}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{label} 60m</span>
                        <span className="font-medium tabular-nums">{fmt(Math.round(ratio60m))}</span>
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-1.5">
              <div className="text-xs font-semibold">Realtime Metrics</div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Indication Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.indicationCycles || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Realtime Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.realtimeCycles || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Open Positions</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.positionsOpen || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Cycle Time</span>
                  <span className="font-medium tabular-nums">{rt?.avgCycleTimeMs || 0}ms</span>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── Strategies ────────────────────────────────────────────────── */}
          <TabsContent value="strategies" className="flex-1 overflow-y-auto p-4 space-y-3">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Main strategies are formed from evaluated Base pseudo-position sets, coordinated via pis-count and
              continuous-count factors plus additional strategies — not always new sets but coordinated variable
              mappings for high-frequency evaluation. Real strategies filter Main by highest-confidence coordination.
            </p>

            <StratSection
              label="Base"
              count={bd?.strategies.base || 0}
              evaluated={bd?.strategies.baseEvaluated || 0}
              evaluatedOf={0}
              detail={sd?.base}
              accentCls="text-orange-600 dark:text-orange-400"
              bgCls="bg-orange-50/50 dark:bg-orange-950/20 border-orange-200/50 dark:border-orange-800/30"
            />

            <StratSection
              label="Main"
              count={bd?.strategies.main || 0}
              evaluated={bd?.strategies.mainEvaluated || 0}
              evaluatedOf={bd?.strategies.base || 0}
              detail={sd?.main}
              accentCls="text-yellow-600 dark:text-yellow-400"
              bgCls="bg-yellow-50/50 dark:bg-yellow-950/20 border-yellow-200/50 dark:border-yellow-800/30"
            />

            <StratSection
              label="Real"
              count={bd?.strategies.real || 0}
              evaluated={bd?.strategies.realEvaluated || 0}
              evaluatedOf={bd?.strategies.main || 0}
              detail={sd?.real}
              accentCls="text-green-600 dark:text-green-400"
              bgCls="bg-green-50/50 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/30"
            />

            {/* Live = real exchange positions history, tracked locally in Redis.
                No exchange-history call required — strategyDetail.live is derived
                from the progression counters + closed-position archive. */}
            <StratSection
              label="Live"
              count={sd?.live?.createdSets || 0}
              evaluated={sd?.live?.evaluated || 0}
              evaluatedOf={bd?.strategies.real || 0}
              detail={sd?.live}
              accentCls="text-amber-600 dark:text-amber-400"
              bgCls="bg-amber-50/50 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-800/30"
            />

            <div className="rounded-md border p-2.5">
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Strategy Cycles</span>
                  <span className="font-medium tabular-nums">{fmt(rt?.strategyCycles || 0)}</span>
                </div>
                <div
                  className="flex justify-between"
                  title="Canonical 'total strategies' = Real-stage output. Base → Main → Real is a cascade filter of the same logical strategy — stages are NOT summed together."
                >
                  <span className="text-muted-foreground">Strategies (Real)</span>
                  <span className="font-medium tabular-nums">{fmt(bd?.strategies.total || 0)}</span>
                </div>
                {(bd?.strategies.live || 0) > 0 && (
                  <div className="flex justify-between col-span-2">
                    <span className="text-muted-foreground">Live Strategies</span>
                    <span className="font-medium tabular-nums">{fmt(bd!.strategies.live)}</span>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── Logs ──────────────────────────────────────────────────────── */}
          <TabsContent value="logs" className="flex-1 flex flex-col min-h-0 p-4">
            <div className="flex items-center justify-between pb-2 shrink-0">
              <span className="text-xs text-muted-foreground">{logs.length} entries</span>
              <Button size="sm" variant="outline" onClick={() => load()} disabled={loading} className="h-7 gap-1.5 text-xs">
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
            <ScrollArea className="flex-1 rounded border">
              <div className="p-2 space-y-px">
                {logs.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground py-8">No logs available yet.</p>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx}>
                      <button
                        type="button"
                        onClick={() => setExpandedLog(expandedLog === idx ? null : idx)}
                        className="w-full flex items-start gap-2 text-xs py-1 px-1.5 rounded hover:bg-muted/40 text-left"
                      >
                        <span className="text-muted-foreground shrink-0 tabular-nums font-mono text-[10px] pt-px">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] h-4 px-1 shrink-0 ${
                            log.level === "error"   ? "border-red-400 text-red-600 dark:text-red-400" :
                            log.level === "warning" ? "border-amber-400 text-amber-600 dark:text-amber-400" :
                            "border-border text-muted-foreground"
                          }`}
                        >
                          {log.phase}
                        </Badge>
                        <span className="flex-1 text-foreground break-words">{log.message}</span>
                        {log.details && (
                          expandedLog === idx
                            ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                            : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                        )}
                      </button>
                      {expandedLog === idx && log.details && (
                        <div className="ml-[90px] mb-1 p-1.5 rounded bg-muted/40 font-mono text-[10px] text-muted-foreground overflow-auto max-h-32">
                          <pre>{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
