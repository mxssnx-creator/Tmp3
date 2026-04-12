"use client"

export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Info,
  Database,
  TrendingUp,
  Bot,
  Layers,
  Activity,
  Clock,
  Zap,
  BarChart3,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ArrowRight,
  Filter,
  GitBranch,
  Cpu,
  Target,
  Shield,
  Network,
  LineChart,
  ListOrdered,
  Sigma,
} from "lucide-react"
import { AuthGuard } from "@/components/auth-guard"
import { useExchange } from "@/lib/exchange-context"
import { cn } from "@/lib/utils"

// ─── Types ─────────────────────────────────────────────────────────────────

interface EngineStats {
  indicationCycleCount: number
  strategyCycleCount: number
  totalIndicationsCount: number
  totalStrategyCount: number
  baseStrategyCount: number
  mainStrategyCount: number
  realStrategyCount: number
  liveStrategyCount: number
  positionsCount: number
  indicationsByType: Record<string, number>
  cycleSuccessRate: number
  cyclesCompleted: number
}

interface QueueData {
  queueSize: number
  queueBacklog: number
  workflowHealth: string
  processingPressure: number
  processingRate: number
  successRate: number
  avgLatency: number
  completedOrders: number
  failedOrders: number
  maxLatency: number
  throughput: number
  workflow: Array<{ id: string; label: string; status: "complete" | "warning" | "pending"; detail: string }>
  focusConnection: {
    id: string; name: string; exchange: string
    hasCredentials: boolean; isActivePanel: boolean
    isDashboardEnabled: boolean; liveTradeEnabled: boolean
    presetTradeEnabled: boolean; testStatus: string
  } | null
  progression: {
    cyclesCompleted: number; successfulCycles: number
    failedCycles: number; cycleSuccessRate: number
    totalTrades: number; totalProfit: number
  } | null
  quickstart: {
    connectionId?: string; connectionName?: string
    exchange?: string; timestamp?: string; durationMs?: number
  } | null
}

interface MonitoringStats {
  totalPositions: number
  openPositions: number
  totalTrades: number
  dailyPnL: number
  totalCycles: number
  totalIndications: number
  totalStrategies: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function PulseDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", active ? "bg-green-500" : "bg-muted-foreground/40")} />
    </span>
  )
}

// ─── Expandable Section ──────────────────────────────────────────────────────

function Section({
  title, subtitle, icon: Icon, accent = "blue", children, defaultOpen = false, badge,
}: {
  title: string; subtitle?: string; icon: React.ElementType
  accent?: "blue" | "purple" | "green" | "orange" | "red"
  children: React.ReactNode; defaultOpen?: boolean; badge?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const accentMap = {
    blue:   "border-l-blue-500 bg-blue-500/5",
    purple: "border-l-purple-500 bg-purple-500/5",
    green:  "border-l-green-500 bg-green-500/5",
    orange: "border-l-orange-500 bg-orange-500/5",
    red:    "border-l-red-500 bg-red-500/5",
  }
  const iconMap = {
    blue:   "text-blue-500",
    purple: "text-purple-500",
    green:  "text-green-500",
    orange: "text-orange-500",
    red:    "text-red-500",
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            "flex w-full items-start gap-3 rounded-lg border-l-4 p-4 text-left transition-colors hover:bg-muted/30",
            accentMap[accent],
          )}
        >
          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconMap[accent])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{title}</span>
              {badge}
            </div>
            {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-1 space-y-3 rounded-b-lg border-l-2 border-muted pb-3 pl-5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium", mono && "font-mono text-xs")}>{value}</span>
    </div>
  )
}

function Callout({ children, variant = "info" }: { children: React.ReactNode; variant?: "info" | "warn" | "success" }) {
  const map = { info: "text-blue-600 bg-blue-500/10 border-blue-500/20", warn: "text-orange-600 bg-orange-500/10 border-orange-500/20", success: "text-green-600 bg-green-500/10 border-green-500/20" }
  return <div className={cn("rounded border p-3 text-xs leading-relaxed", map[variant])}>{children}</div>
}

// ─── Live Stat Tile ──────────────────────────────────────────────────────────

function StatTile({ label, value, sub, color = "blue" }: { label: string; value: string | number; sub?: string; color?: "blue" | "purple" | "green" | "orange" }) {
  const map = { blue: "bg-blue-500/10 text-blue-500", purple: "bg-purple-500/10 text-purple-500", green: "bg-green-500/10 text-green-500", orange: "bg-orange-500/10 text-orange-500" }
  return (
    <div className={cn("rounded-lg p-4", map[color])}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{typeof value === "number" ? fmt(value) : value}</div>
      {sub && <div className="mt-0.5 text-xs opacity-60">{sub}</div>}
    </div>
  )
}

// ─── Main System Tab ─────────────────────────────────────────────────────────

function MainSystemTab({ stats, engineRunning }: { stats: EngineStats | null; engineRunning: boolean }) {
  const indTotal = stats?.totalIndicationsCount || 0
  const strTotal = stats?.totalStrategyCount || 0
  const indCycles = stats?.indicationCycleCount || 0
  const strCycles = stats?.strategyCycleCount || 0
  const byType = stats?.indicationsByType || {}

  return (
    <div className="space-y-4">
      <Alert className="border-l-4 border-l-primary">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm leading-relaxed">
          <strong>Main System Trade Mode</strong> uses step-based indication calculations across four indication types
          (Direction, Move, Active, Optimal). Each type generates signals from 3-30 step ranges, which feed into a
          multi-stage strategy evaluation pipeline (Base → Main → Real → Live). The engine runs in a non-overlapping
          1-second interval loop per active connection.
        </AlertDescription>
      </Alert>

      {/* Live counters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Indication Cycles" value={indCycles} sub="total cycles completed" color="blue" />
        <StatTile label="Indications Total" value={indTotal} sub={`${indCycles > 0 ? Math.round(indTotal / indCycles) : 0}/cycle avg`} color="blue" />
        <StatTile label="Strategy Cycles" value={strCycles} sub="evaluation cycles" color="purple" />
        <StatTile label="Strategy Sets" value={strTotal} sub="total evaluated" color="purple" />
      </div>

      {/* Phase 1: Initialization */}
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">1</div>
            Initialization Phase
          </CardTitle>
          <CardDescription>System startup, symbol loading, and prehistoric data pre-computation</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="1.1  Load System Settings" icon={Database} accent="blue"
            subtitle="Trade interval, data timeframe, risk parameters — fetched from Redis on startup">
            <InfoRow label="Trade Engine Interval" value="1.0 s (configurable)" />
            <InfoRow label="Real Positions Interval" value="0.3 s" />
            <InfoRow label="Market Data Timeframe" value="1 second candles" />
            <InfoRow label="Time Range History" value="5 days of OHLCV data" />
            <InfoRow label="Concurrency Limit" value="10 parallel symbol loads" />
            <Callout>
              Settings are stored in Redis at <code className="font-mono">settings:trade_engine_state:{"{connectionId}"}</code> and are
              re-read every restart. Changes to intervals take effect on the next engine restart.
            </Callout>
          </Section>

          <Section title="1.2  Load Symbols" icon={ListOrdered} accent="blue"
            subtitle="Two modes: Main Symbols (configured list) or Exchange Symbols (top N by 24h volume)">
            <InfoRow label="Mode A — Main Symbols" value="Configured list + forced symbols" />
            <InfoRow label="Mode B — Exchange Symbols" value="Fetch top N by volume from exchange API" />
            <InfoRow label="Deduplication" value="SADD into Redis set, unique only" />
            <InfoRow label="Minimum symbols" value="1 (at least one active symbol required)" />
            <Callout>
              In QuickStart mode a single most-volatile symbol from the selected exchange is used, determined by the
              largest absolute 1-hour price change percentage fetched from <code className="font-mono">/api/exchange/{"{ex}"}/top-symbols</code>.
            </Callout>
          </Section>

          <Section title="1.3  Prehistoric Data Loading" icon={Clock} accent="blue"
            badge={<Badge className="bg-blue-500 text-white text-xs">Parallel</Badge>}
            subtitle="Historical OHLCV candles fetched and stored for all symbols before real-time processing begins">
            <InfoRow label="Parallelism" value="All symbols processed simultaneously" />
            <InfoRow label="Concurrency cap" value="10 symbols at once" />
            <InfoRow label="Candle range" value="5 days × 1-second intervals = ~432,000 candles per symbol" />
            <InfoRow label="Storage" value={<code className="font-mono text-xs">prehistoric:{"{connId}"}:{"{symbol}"}:candles</code>} />
            <InfoRow label="Completion flag" value={<code className="font-mono text-xs">prehistoric:{"{connId}"}:{"{symbol}"}:completed</code>} />
            <Callout>
              Prehistoric data is used by StepBasedIndicators to compute initial indication baselines.
              Without it, the indication processor falls back to live candles only (reduced accuracy).
              Progress is tracked in <code className="font-mono">prehistoric:{"{connId}"}:symbols</code> Redis set.
            </Callout>
          </Section>

          <Section title="1.4  Market Data Stream" icon={Network} accent="blue"
            subtitle="WebSocket connection to exchange — subscribes to real-time tick data for all loaded symbols">
            <InfoRow label="Protocol" value="Exchange WebSocket API" />
            <InfoRow label="Subscriptions" value="One channel per symbol (1s kline/candle)" />
            <InfoRow label="Reconnect policy" value="Exponential backoff, auto-reconnect on disconnect" />
            <InfoRow label="Data format" value="OHLCV candles + volume ticks" />
            <Callout variant="success">
              Once connected the system emits a <code className="font-mono">market_data:{"{connId}"}:{"{symbol}"}</code> Redis stream entry
              per candle close, which triggers the indication processor cycle.
            </Callout>
          </Section>
        </CardContent>
      </Card>

      {/* Phase 2: Trade Interval Loop */}
      <Card className="border-l-4 border-l-purple-500">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-500 text-xs font-bold text-white">2</div>
            Trade Interval Loop
            <Badge variant="outline" className="ml-auto text-xs">Every 1.0 s — Non-Overlapping</Badge>
          </CardTitle>
          <CardDescription>
            Indications → Strategies → Pseudo Positions → Logging. A new interval starts only after the previous one completes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="2.1  Process Indications" icon={Zap} accent="blue"
            badge={<Badge className="bg-blue-500 text-white text-xs">Parallel by Symbol</Badge>}
            subtitle="StepBasedIndicators runs across all loaded symbols simultaneously, yielding 4 indication types per symbol"
            defaultOpen={engineRunning}>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { type: "direction", label: "Direction", desc: "3–30 step reversal ranges. Identifies price reversal probability.", count: byType["direction"] || 0 },
                { type: "move",      label: "Move",      desc: "3–30 step trend-following ranges. Validates momentum direction.",  count: byType["move"]      || 0 },
                { type: "active",    label: "Active",    desc: "0.5–2.5% threshold breakouts. Detects high-volatility entries.",  count: byType["active"]    || 0 },
                { type: "optimal",   label: "Optimal",   desc: "High-precision validated configs. Combines multiple filters.",    count: byType["optimal"]   || 0 },
              ].map(t => (
                <div key={t.type} className="rounded border bg-background p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-blue-500">{t.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{fmt(t.count)} signals</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{t.desc}</div>
                </div>
              ))}
            </div>
            <InfoRow label="Total indications this session" value={<span className="font-bold text-blue-500">{fmt(indTotal)}</span>} />
            <InfoRow label="Cycles completed" value={<span className="font-bold">{fmt(indCycles)}</span>} />
            <InfoRow label="Storage" value={<code className="font-mono text-xs">progression:{"{connId}"} → indications_*_count</code>} />
            <Callout>
              Each symbol in the loaded set is processed concurrently. The indication processor reads the latest OHLCV candle from
              the market data stream, derives the primary direction from close vs. open, computes body/wick ratio for confidence scoring,
              then generates 8 indications (4 types × 2 directions: long + short) per cycle.
            </Callout>
          </Section>

          <Section title="2.2  Strategy Evaluation — Base Stage" icon={GitBranch} accent="purple"
            subtitle="Groups indications into Sets (one per type × direction), evaluates TP/SL/trailing combinations"
            defaultOpen={engineRunning}>
            <InfoRow label="Set composition" value="1 per (indication_type × direction)" />
            <InfoRow label="Max sets per cycle" value="8 (4 types × 2 directions)" />
            <InfoRow label="Base sets this session" value={<span className="font-bold text-purple-500">{fmt(stats?.baseStrategyCount || 0)}</span>} />
            <InfoRow label="TP levels" value="11 levels: 0.5% → 5.0% in 0.45% steps" />
            <InfoRow label="SL levels" value="21 levels: 0.1% → 2.0% in 0.095% steps" />
            <InfoRow label="Trailing modes" value="4 — OFF, Standard, Aggressive, Conservative" />
            <InfoRow label="Total combinations" value="11 × 21 × 4 = 924 per Set" />
            <Callout>
              Base stage filters by <code className="font-mono">profit_factor ≥ 0.55</code>. Only Sets passing this threshold
              are promoted to Main stage evaluation. Sets are stored in Redis at
              <code className="font-mono"> strategies:{"{connId}"}:base:count</code>.
            </Callout>
          </Section>

          <Section title="2.3  Strategy Evaluation — Main Stage" icon={Filter} accent="purple"
            subtitle="Promoted Base Sets undergo stricter profit factor and consistency evaluation">
            <InfoRow label="Input" value="Sets from Base that passed profit_factor ≥ 0.55" />
            <InfoRow label="Main threshold" value="profit_factor ≥ 0.65" />
            <InfoRow label="Consistency check" value="Minimum 3 consecutive passing cycles" />
            <InfoRow label="Main sets this session" value={<span className="font-bold text-purple-500">{fmt(stats?.mainStrategyCount || 0)}</span>} />
            <InfoRow label="Storage" value={<code className="font-mono text-xs">progression:{"{connId}"} → strategies_main_total</code>} />
            <Callout>
              Main stage adds a consistency dimension — a Set must pass the profit factor threshold across
              multiple consecutive cycles before being promoted to Real. This filters out noise and transient signals.
            </Callout>
          </Section>

          <Section title="2.4  Strategy Evaluation — Real Stage" icon={Target} accent="purple"
            subtitle="Only the strongest sets reach Real — these represent genuine trading opportunities">
            <InfoRow label="Input" value="Sets that passed Main (consistency + profit factor)" />
            <InfoRow label="Real threshold" value="profit_factor ≥ 0.75 + confidence ≥ 0.65" />
            <InfoRow label="Real sets this session" value={<span className="font-bold text-purple-500">{fmt(stats?.realStrategyCount || 0)}</span>} />
            <InfoRow label="Live sets promoted" value={<span className="font-bold text-green-500">{fmt(stats?.liveStrategyCount || 0)}</span>} />
            <Callout variant="success">
              Real sets that also satisfy the Live criteria (connection has <code className="font-mono">is_live_trade=1</code>) trigger
              actual exchange orders through <code className="font-mono">executeLivePosition()</code> in <code className="font-mono">live-stage.ts</code>.
              Without live trading enabled, they remain as pseudo positions only.
            </Callout>
          </Section>

          <Section title="2.5  Pseudo Positions" icon={LineChart} accent="green"
            subtitle="Virtual positions tracking strategy performance without real capital at risk">
            <InfoRow label="Creation filter" value="profit_factor ≥ 0.6 at any stage" />
            <InfoRow label="Max per configuration" value="250 pseudo positions" />
            <InfoRow label="Active positions" value={<span className="font-bold text-green-500">{fmt(stats?.positionsCount || 0)}</span>} />
            <InfoRow label="Storage key" value={<code className="font-mono text-xs">pseudo_positions:{"{connId}"}</code>} />
            <InfoRow label="Per-position hash" value={<code className="font-mono text-xs">pseudo_position:{"{connId}"}:{"{id}"}</code>} />
            <Callout>
              Each pseudo position records entry price, direction, TP/SL levels, trailing mode, and running P&L.
              The position manager evaluates open positions every interval, closing those that hit TP or SL and
              computing realized profit_factor for strategy ranking feedback.
            </Callout>
          </Section>

          <Section title="2.6  System Logging" icon={Database} accent="orange"
            subtitle="Async — all indications, strategies, and positions are persisted to Redis log streams">
            <InfoRow label="Log key" value={<code className="font-mono text-xs">engine:logs:{"{connId}"}</code>} />
            <InfoRow label="Format" value="Redis LIST of JSON entries (LPUSH, capped)" />
            <InfoRow label="Flush frequency" value="Every 10 cycles or on-demand" />
            <InfoRow label="Metrics" value={<code className="font-mono text-xs">progression:{"{connId}"} HASH</code>} />
            <Callout variant="warn">
              Logging is fully async and never blocks the trade loop. If Redis is unavailable, metrics are dropped
              silently — the engine continues uninterrupted. Logs are capped to prevent unbounded growth.
            </Callout>
          </Section>
        </CardContent>
      </Card>

      {/* Phase 3: Position Management */}
      <Card className="border-l-4 border-l-green-500">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-xs font-bold text-white">3</div>
            Position Management
          </CardTitle>
          <CardDescription>Promotion to real positions, live order execution, and P&L tracking</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="3.1  Promote to Real Positions" icon={TrendingUp} accent="green"
            subtitle="Best-performing pseudo positions are promoted and placed as real orders on the exchange">
            <InfoRow label="Promotion threshold" value="profit_factor ≥ 0.8 over ≥ 5 cycles" />
            <InfoRow label="Gate" value="Connection must have is_live_trade=1 AND valid credentials" />
            <InfoRow label="Execution" value="Market order via ExchangeConnectorFactory" />
            <InfoRow label="Risk" value="Minimal quantity with exchange-level TP/SL" />
            <Callout variant="success">
              Real position execution flows through <code className="font-mono">live-stage.ts → executeLivePosition()</code>.
              The connector factory resolves the correct exchange adapter (BingX, Bybit, etc.) and places the order.
              Order IDs and fill prices are stored back into the pseudo position hash for P&L tracking.
            </Callout>
          </Section>

          <Section title="3.2  Position Monitoring — 0.3 s Interval" icon={Activity} accent="green"
            subtitle="Open positions are monitored every 300ms for TP/SL hit, trailing stop adjustment, and P&L update">
            <InfoRow label="Monitor interval" value="0.3 s (separate from trade loop)" />
            <InfoRow label="Trailing stop update" value="Re-priced on each tick if price moves favorably" />
            <InfoRow label="TP/SL execution" value="Closes position and records realized P&L" />
            <InfoRow label="Max open real positions" value="Configurable per connection (default: 5)" />
            <Callout>
              The position monitor fetches live price from the market data stream (not a separate API call).
              This avoids rate-limit issues with the exchange REST API and keeps latency under 50ms.
            </Callout>
          </Section>

          <Section title="3.3  Strategy Feedback Loop" icon={Sigma} accent="green"
            subtitle="Closed position outcomes feed back into strategy ranking to improve future Set selection">
            <InfoRow label="Feedback metric" value="Realized profit_factor of closed pseudo positions" />
            <InfoRow label="Ranking update" value="Exponential moving average over last 20 closures" />
            <InfoRow label="Effect" value="Higher-ranked Sets promoted faster in future cycles" />
            <Callout variant="info">
              This closed-loop feedback is what differentiates the Main System from simple indicator-based systems.
              Over time, indication types and TP/SL configurations that consistently produce positive outcomes
              receive higher weights and are preferred during Set creation.
            </Callout>
          </Section>
        </CardContent>
      </Card>

      {/* Data Flow Diagram */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowRight className="h-4 w-4" />
            Data Flow Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div className="flex min-w-max items-center gap-2 text-sm">
              {[
                { label: "Market Data", sub: "WebSocket candle", color: "bg-blue-500/10 border-blue-500/30 text-blue-500" },
                { label: "Indications", sub: `${fmt(indTotal)} total`, color: "bg-blue-500/10 border-blue-500/30 text-blue-500" },
                { label: "Base Sets", sub: `${fmt(stats?.baseStrategyCount || 0)} sets`, color: "bg-purple-500/10 border-purple-500/30 text-purple-500" },
                { label: "Main Sets", sub: `${fmt(stats?.mainStrategyCount || 0)} sets`, color: "bg-purple-500/10 border-purple-500/30 text-purple-500" },
                { label: "Real Sets", sub: `${fmt(stats?.realStrategyCount || 0)} sets`, color: "bg-green-500/10 border-green-500/30 text-green-500" },
                { label: "Live Orders", sub: `${fmt(stats?.liveStrategyCount || 0)} sets`, color: "bg-green-500/20 border-green-500/50 text-green-600" },
              ].map((node, i, arr) => (
                <div key={i} className="flex items-center gap-2">
                  <div className={cn("rounded border px-3 py-2 text-center", node.color)}>
                    <div className="font-medium">{node.label}</div>
                    <div className="text-xs opacity-70">{node.sub}</div>
                  </div>
                  {i < arr.length - 1 && <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Preset Mode Tab ─────────────────────────────────────────────────────────

function PresetModeTab() {
  return (
    <div className="space-y-4">
      <Alert className="border-l-4 border-l-primary">
        <Database className="h-4 w-4" />
        <AlertDescription className="text-sm leading-relaxed">
          <strong>Preset Mode</strong> uses predefined classic technical indicators (RSI, MACD, Bollinger Bands, etc.)
          for signal generation and live trade execution in a single unified engine. Unlike Main System,
          Preset Mode does not build pseudo positions first — it acts directly when confluence is met.
        </AlertDescription>
      </Alert>

      <Card className="border-l-4 border-l-blue-500">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Preset Mode Workflow</CardTitle>
          <CardDescription>Indicator-based signals → confluence filter → direct execution</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="1. Technical Indicator Calculation" icon={LineChart} accent="blue" defaultOpen
            subtitle="Classic indicators computed on each candle close across all loaded symbols">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { name: "RSI (14)", desc: "Relative Strength Index — overbought/oversold detection" },
                { name: "MACD (12/26/9)", desc: "Moving Average Convergence Divergence — momentum" },
                { name: "Bollinger Bands (20,2)", desc: "Volatility envelope — breakout detection" },
                { name: "Parabolic SAR", desc: "Trend reversal stop-and-reverse indicator" },
                { name: "EMA (9/21/50)", desc: "Exponential Moving Averages — trend direction" },
                { name: "Stochastic (14,3,3)", desc: "Momentum oscillator — overbought/oversold" },
                { name: "ADX (14)", desc: "Average Directional Index — trend strength filter" },
                { name: "SMA (50/200)", desc: "Simple Moving Averages — long-term trend context" },
              ].map(ind => (
                <div key={ind.name} className="rounded border bg-background p-2.5 text-sm">
                  <div className="font-medium text-blue-500">{ind.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{ind.desc}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="2. Signal Generation & Confluence" icon={Filter} accent="purple"
            subtitle="Each indicator votes BUY, SELL, or NEUTRAL — minimum 2 must agree for a signal to be emitted">
            <InfoRow label="Minimum confluence" value="2 indicators must agree on direction" />
            <InfoRow label="Signal threshold" value="profit_factor ≥ 0.6 after backtesting signal quality" />
            <InfoRow label="Outputs" value="BUY, SELL, or no signal (NEUTRAL suppressed)" />
            <InfoRow label="Weighting" value="Trend-strength indicators (ADX, EMA) have higher weight" />
            <Callout>
              Confluence prevents single-indicator false positives. An RSI oversold alone is insufficient —
              at least one trend-confirming indicator (EMA cross, MACD, ADX) must agree before a signal is emitted.
            </Callout>
          </Section>

          <Section title="3. Position Execution" icon={Target} accent="green"
            subtitle="Validated signals are immediately placed as real orders on the exchange">
            <InfoRow label="Order type" value="Market order at current price" />
            <InfoRow label="TP calculation" value="ATR-based (1.5× ATR from entry)" />
            <InfoRow label="SL calculation" value="ATR-based (1.0× ATR from entry)" />
            <InfoRow label="Position sizing" value="Fixed risk % of account per trade" />
            <Callout variant="success">
              Preset Mode connects to the same ExchangeConnectorFactory as Main System for order placement.
              This means BingX, Bybit, and other supported exchanges are all handled transparently.
            </Callout>
          </Section>

          <Section title="4. Monitoring & Analytics" icon={BarChart3} accent="orange"
            subtitle="Real-time P&L, order execution status, and performance metrics">
            <InfoRow label="P&L update frequency" value="Every 0.3 s (same as Main System)" />
            <InfoRow label="Analytics stored" value="Win rate, avg profit, max drawdown, Sharpe-like ratio" />
            <InfoRow label="Alerts" value="Consecutive losses trigger auto-pause (configurable)" />
            <Callout variant="warn">
              Preset Mode has no learning feedback loop — indicator parameters are fixed. For dynamic market adaptation,
              use Main System with its strategy ranking feedback.
            </Callout>
          </Section>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Trading Bots Tab ────────────────────────────────────────────────────────

function TradingBotsTab() {
  return (
    <div className="space-y-4">
      <Alert className="border-l-4 border-l-primary">
        <Bot className="h-4 w-4" />
        <AlertDescription className="text-sm leading-relaxed">
          <strong>Trading Bots</strong> are automated strategies that run continuously with custom configurations,
          independent of both Main System and Preset Mode. Each bot type has distinct mechanics and risk profiles.
        </AlertDescription>
      </Alert>

      <Card className="border-l-4 border-l-blue-500">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bot Types & Mechanics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Section title="Grid Trading Bot" icon={Layers} accent="blue" defaultOpen
            subtitle="Places buy and sell orders at fixed price intervals (grid lines) to capture range-bound oscillation">
            <InfoRow label="Strategy" value="Buy low / sell high within a defined price range" />
            <InfoRow label="Grid lines" value="5–50 configurable levels" />
            <InfoRow label="Per-order size" value="Total capital ÷ number of grid levels" />
            <InfoRow label="Profit source" value="Each grid level crossing earns the grid spacing % as profit" />
            <InfoRow label="Best market" value="Sideways / ranging markets with clear support and resistance" />
            <Callout>
              Grid bots require defining an upper and lower price bound. If price breaks outside the range,
              the bot stops and waits for re-entry (or can be configured to follow price with dynamic re-centering).
            </Callout>
          </Section>

          <Section title="DCA (Dollar Cost Averaging) Bot" icon={TrendingUp} accent="purple"
            subtitle="Buys at regular intervals or on price drops to reduce average entry cost over time">
            <InfoRow label="Strategy" value="Accumulate position on dips, take profit on recovery" />
            <InfoRow label="Entry spacing" value="Every N% price drop from last entry" />
            <InfoRow label="Max orders" value="Configurable (default: 5 safety orders)" />
            <InfoRow label="Take profit" value="% above average entry price across all DCA orders" />
            <InfoRow label="Best market" value="Downtrending with expected recovery (mean-reversion)" />
            <Callout variant="warn">
              DCA bots can accumulate large positions in a sustained downtrend. Use with appropriate capital
              allocation and a maximum safety order count to limit exposure.
            </Callout>
          </Section>

          <Section title="Arbitrage Bot" icon={GitBranch} accent="orange"
            subtitle="Exploits price differences between exchanges or trading pairs simultaneously">
            <InfoRow label="Type" value="Inter-exchange arbitrage (e.g. BingX vs Bybit)" />
            <InfoRow label="Detection" value="Monitor bid/ask spread across exchanges in real-time" />
            <InfoRow label="Execution" value="Simultaneous buy on lower exchange, sell on higher" />
            <InfoRow label="Min spread" value="Must exceed combined fees + slippage to be profitable" />
            <InfoRow label="Latency sensitivity" value="High — sub-100ms execution required" />
            <Callout variant="warn">
              Arbitrage opportunities are short-lived (milliseconds). This bot requires both exchanges to have
              active API connections and sufficient balance on each side.
            </Callout>
          </Section>

          <Section title="Market Making Bot" icon={Activity} accent="green"
            subtitle="Continuously posts limit buy and sell orders around the mid-price to capture the bid-ask spread">
            <InfoRow label="Strategy" value="Post orders at mid ± configurable spread" />
            <InfoRow label="Inventory management" value="Adjusts quote size based on existing position" />
            <InfoRow label="Spread" value="Configurable in % (typical: 0.05–0.5%)" />
            <InfoRow label="Refresh frequency" value="Re-prices every N seconds or on fill" />
            <InfoRow label="Best market" value="Liquid pairs with tight spreads and high volume" />
            <Callout>
              Market making bots assume risk of holding inventory. They profit when orders on both sides fill,
              but can accumulate directional exposure in trending markets. Inventory limits are critical.
            </Callout>
          </Section>

          <Section title="Configuration Parameters" icon={Cpu} accent="blue"
            subtitle="Common configuration fields across all bot types">
            <InfoRow label="Symbol" value="Trading pair (e.g. BTCUSDT)" />
            <InfoRow label="Exchange" value="Target exchange connection" />
            <InfoRow label="Capital allocation" value="USDT amount or % of account" />
            <InfoRow label="Leverage" value="1× (spot) to 20× (futures, risk-dependent)" />
            <InfoRow label="Stop Loss" value="Global SL % to halt bot on large drawdown" />
            <InfoRow label="Take Profit" value="Global TP % target per session" />
            <InfoRow label="Auto-restart" value="Resume after TP/SL hit or manual pause" />
          </Section>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Queue & Workflow Card ────────────────────────────────────────────────────

function QueueCard({ queueData }: { queueData: QueueData | null }) {
  if (!queueData) return null

  const healthColor = queueData.workflowHealth === "healthy"
    ? "text-green-500" : queueData.workflowHealth === "degraded"
    ? "text-orange-500" : "text-red-500"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Order Queue &amp; Workflow
          </CardTitle>
          <Badge variant="outline" className={cn("capitalize", healthColor)}>
            {queueData.workflowHealth || "unknown"}
          </Badge>
        </div>
        <CardDescription>Real-time order processing metrics and workflow readiness</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {[
            { label: "Queue Size",      value: queueData.queueSize || 0,        color: "text-blue-500" },
            { label: "Processing Rate", value: `${queueData.processingRate || 0}/s`, color: "text-green-500" },
            { label: "Success Rate",    value: `${queueData.successRate || 0}%`, color: "text-purple-500" },
            { label: "Avg Latency",     value: `${queueData.avgLatency || 0}ms`, color: "text-orange-500" },
            { label: "Completed",       value: queueData.completedOrders || 0,   color: "text-green-600" },
            { label: "Failed",          value: queueData.failedOrders || 0,      color: "text-red-500" },
          ].map(m => (
            <div key={m.label} className="space-y-1">
              <div className="text-xs text-muted-foreground">{m.label}</div>
              <div className={cn("text-xl font-bold tabular-nums", m.color)}>{m.value}</div>
            </div>
          ))}
        </div>

        {typeof queueData.processingPressure === "number" && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Processing Pressure</span>
              <span className="font-medium">{queueData.processingPressure}%</span>
            </div>
            <Progress value={queueData.processingPressure} className="h-2" />
          </div>
        )}

        {queueData.workflow && queueData.workflow.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workflow Phases</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {queueData.workflow.map(phase => (
                <div key={phase.id} className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{phase.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{phase.detail}</div>
                  </div>
                  <Badge
                    variant={phase.status === "complete" ? "default" : phase.status === "warning" ? "secondary" : "outline"}
                    className="shrink-0 text-xs"
                  >
                    {phase.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Focus Connection Card ────────────────────────────────────────────────────

function FocusCard({ queueData }: { queueData: QueueData | null }) {
  if (!queueData?.focusConnection) return null
  const fc = queueData.focusConnection
  const prog = queueData.progression

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4" />
          Focus Connection
          <Badge className="ml-2">{fc.exchange.toUpperCase()}</Badge>
        </CardTitle>
        <CardDescription>Primary connection driving current logistics, progression, and engine activity</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Connection</div>
            <div className="font-semibold">{fc.name}</div>
            <div className="text-xs text-muted-foreground uppercase">{fc.exchange}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="font-semibold">{fc.testStatus}</div>
            <div className="text-xs text-muted-foreground">Credentials: {fc.hasCredentials ? "Configured" : "Missing"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Progression</div>
            <div className="font-semibold">{prog?.cyclesCompleted || 0} cycles</div>
            <div className="text-xs text-muted-foreground">Success: {Math.round(prog?.cycleSuccessRate || 0)}%</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Active Flags</div>
            <div className="flex flex-wrap gap-1">
              <Badge variant={fc.isActivePanel ? "default" : "outline"} className="text-xs">Panel</Badge>
              <Badge variant={fc.isDashboardEnabled ? "default" : "outline"} className="text-xs">Dashboard</Badge>
              <Badge variant={fc.liveTradeEnabled ? "default" : "outline"} className="text-xs">Live Trade</Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LogisticsPage() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId || "bingx-x01"

  const [activeTab, setActiveTab] = useState("main")
  const [engineStats, setEngineStats] = useState<EngineStats | null>(null)
  const [queueData, setQueueData] = useState<QueueData | null>(null)
  const [monitoringStats, setMonitoringStats] = useState<MonitoringStats | null>(null)
  const [engineRunning, setEngineRunning] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [statsRes, queueRes, monRes] = await Promise.all([
        fetch(`/api/trading/engine-stats?connection_id=${connectionId}`, { cache: "no-store" }),
        fetch("/api/logistics/queue", { cache: "no-store" }),
        fetch("/api/monitoring/stats", { cache: "no-store" }),
      ])

      if (statsRes.ok) {
        const d = await statsRes.json()
        setEngineStats({
          indicationCycleCount: d.indicationCycleCount || 0,
          strategyCycleCount:   d.strategyCycleCount   || 0,
          totalIndicationsCount: d.totalIndicationsCount || 0,
          totalStrategyCount:   d.totalStrategyCount   || 0,
          baseStrategyCount:    d.baseStrategyCount    || 0,
          mainStrategyCount:    d.mainStrategyCount    || 0,
          realStrategyCount:    d.realStrategyCount    || 0,
          liveStrategyCount:    d.liveStrategyCount    || 0,
          positionsCount:       d.positionsCount       || 0,
          indicationsByType:    d.indicationsByType    || {},
          cycleSuccessRate:     d.cycleSuccessRate     || 100,
          cyclesCompleted:      d.cyclesCompleted      || 0,
        })
        setEngineRunning((d.indicationCycleCount || 0) > 0)
      }

      if (queueRes.ok) setQueueData(await queueRes.json())
      if (monRes.ok)   setMonitoringStats(await monRes.json())
      setLastUpdate(new Date())
    } catch { /* non-critical */ }
    finally { if (!silent) setLoading(false) }
  }, [connectionId])

  useEffect(() => {
    fetchAll()
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => fetchAll(true), 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchAll])

  const indTotal   = engineStats?.totalIndicationsCount || 0
  const strTotal   = engineStats?.totalStrategyCount    || 0
  const indCycles  = engineStats?.indicationCycleCount  || 0
  const strCycles  = engineStats?.strategyCycleCount    || 0
  const positions  = engineStats?.positionsCount        || 0

  return (
    <AuthGuard>
      <div className="flex min-h-screen w-full flex-col bg-background font-sans">
        {/* Header */}
        <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-14 items-center gap-4 px-4 lg:px-6">
            <div className="flex flex-1 items-center gap-3">
              <Activity className="h-5 w-5 text-primary" />
              <h1 className="text-base font-semibold">System Logistics</h1>
              <Badge variant="outline" className="hidden sm:flex gap-1.5 text-xs">
                <PulseDot active={engineRunning} />
                {engineRunning ? "Engine Running" : "Engine Stopped"}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground hidden sm:block">
                {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : "Loading..."}
              </span>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fetchAll()} title="Refresh">
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 space-y-5 p-4 lg:p-6">

          {/* Top KPI Strip */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "Ind. Cycles",   value: indCycles,  color: "blue"   as const },
              { label: "Indications",   value: indTotal,   color: "blue"   as const },
              { label: "Strat. Cycles", value: strCycles,  color: "purple" as const },
              { label: "Strat. Sets",   value: strTotal,   color: "purple" as const },
              { label: "Positions",     value: positions,  color: "green"  as const },
              { label: "Success Rate",  value: `${Math.round(engineStats?.cycleSuccessRate || 0)}%`, color: "green" as const },
            ].map(k => (
              <Card key={k.label} className="py-3">
                <CardContent className="px-4 py-0">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className={cn("text-2xl font-bold tabular-nums mt-0.5",
                    k.color === "blue" ? "text-blue-500" : k.color === "purple" ? "text-purple-500" : "text-green-500"
                  )}>
                    {typeof k.value === "number" ? fmt(k.value) : k.value}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Strategy Stage Breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <BarChart3 className="h-4 w-4 text-purple-500" />
                Strategy Pipeline — Current Cycle
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-0 overflow-x-auto">
                {[
                  { label: "Base",  value: engineStats?.baseStrategyCount || 0, color: "bg-purple-500/20 text-purple-500 border-purple-500/30" },
                  { label: "Main",  value: engineStats?.mainStrategyCount || 0, color: "bg-purple-500/30 text-purple-600 border-purple-500/40" },
                  { label: "Real",  value: engineStats?.realStrategyCount || 0, color: "bg-purple-500/50 text-purple-700 border-purple-500/60" },
                  { label: "Live",  value: engineStats?.liveStrategyCount || 0, color: "bg-green-500/20 text-green-500 border-green-500/30" },
                ].map((stage, i, arr) => (
                  <div key={stage.label} className="flex items-center">
                    <div className={cn("flex min-w-[90px] flex-col items-center rounded border px-4 py-3", stage.color)}>
                      <div className="text-xs font-medium uppercase tracking-wide">{stage.label}</div>
                      <div className="mt-1 text-xl font-bold tabular-nums">{stage.value}</div>
                      <div className="mt-0.5 text-xs opacity-60">sets</div>
                    </div>
                    {i < arr.length - 1 && <ChevronRight className="mx-1 h-4 w-4 shrink-0 text-muted-foreground" />}
                  </div>
                ))}
                <div className="ml-4 flex-1 text-xs text-muted-foreground leading-relaxed hidden lg:block">
                  Sets narrow at each stage as stricter criteria are applied:<br />
                  Base (pf ≥ 0.55) → Main (pf ≥ 0.65 + consistency) → Real (pf ≥ 0.75 + confidence ≥ 0.65) → Live (is_live_trade=1)
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Indication Type Breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Zap className="h-4 w-4 text-blue-500" />
                Indications by Type — Cumulative
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {["direction", "move", "active", "optimal"].map(type => {
                  const count = engineStats?.indicationsByType?.[type] || 0
                  const pct = indTotal > 0 ? Math.round(count / indTotal * 100) : 0
                  return (
                    <div key={type} className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="tabular-nums text-muted-foreground">{fmt(count)}</span>
                      </div>
                      <Progress value={pct} className="h-2" />
                      <div className="text-xs text-muted-foreground">{pct}% of total</div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Queue, Focus, Monitoring */}
          <QueueCard queueData={queueData} />
          <FocusCard queueData={queueData} />

          {monitoringStats && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Shield className="h-4 w-4 text-green-500" />
                  Global Monitoring Summary
                </CardTitle>
                <CardDescription>Aggregate across all active connections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    { label: "Total Positions", value: monitoringStats.totalPositions },
                    { label: "Open Positions",  value: monitoringStats.openPositions  },
                    { label: "Total Trades",    value: monitoringStats.totalTrades    },
                    { label: "All Ind. Cycles", value: monitoringStats.totalCycles    },
                    { label: "All Indications", value: monitoringStats.totalIndications },
                    { label: "All Strategies",  value: monitoringStats.totalStrategies  },
                  ].map(m => (
                    <div key={m.label}>
                      <div className="text-xs text-muted-foreground">{m.label}</div>
                      <div className="text-xl font-bold tabular-nums mt-0.5">{fmt(m.value || 0)}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Mode Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full max-w-md grid-cols-3">
              <TabsTrigger value="main" className="flex items-center gap-1.5 text-xs sm:text-sm">
                <Layers className="h-3.5 w-3.5" /> Main System
              </TabsTrigger>
              <TabsTrigger value="preset" className="flex items-center gap-1.5 text-xs sm:text-sm">
                <Database className="h-3.5 w-3.5" /> Preset Mode
              </TabsTrigger>
              <TabsTrigger value="bot" className="flex items-center gap-1.5 text-xs sm:text-sm">
                <Bot className="h-3.5 w-3.5" /> Trading Bots
              </TabsTrigger>
            </TabsList>

            <TabsContent value="main" className="mt-5">
              <MainSystemTab stats={engineStats} engineRunning={engineRunning} />
            </TabsContent>
            <TabsContent value="preset" className="mt-5">
              <PresetModeTab />
            </TabsContent>
            <TabsContent value="bot" className="mt-5">
              <TradingBotsTab />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </AuthGuard>
  )
}
