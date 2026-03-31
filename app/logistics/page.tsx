"use client"


export const dynamic = "force-dynamic"
import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import {
  Info,
  Database,
  TrendingUp,
  CheckCircle2,
  AlertTriangle,
  Bot,
  Layers,
  Activity,
  Clock,
  Zap,
  BarChart3,
  Menu,
} from "lucide-react"
import { AuthGuard } from "@/components/auth-guard"

interface SystemStatus {
  initializationProgress: number
  currentPhase: string
  symbolsLoaded: number
  totalSymbols: number
  prehistoricDataProgress: number
  tradeEngineRunning: boolean
  realTimeStreamConnected: boolean
  indicationsGenerated: number
  strategiesEvaluated: number
  pseudoPositionsCreated: number
  currentInterval: number
  intervalExecutionTime: number
  lastUpdate: string
}

interface WorkflowPhase {
  id: string
  label: string
  status: "complete" | "warning" | "pending"
  detail: string
}

interface QueueData {
  queueSize: number
  queueBacklog?: number
  workflowHealth?: string
  processingPressure?: number
  processingRate: number
  successRate: number
  avgLatency: number
  completedOrders: number
  failedOrders: number
  maxLatency: number
  throughput: number
  workflow?: WorkflowPhase[]
  focusConnection?: {
    id: string
    name: string
    exchange: string
    hasCredentials: boolean
    isActivePanel: boolean
    isDashboardEnabled: boolean
    liveTradeEnabled: boolean
    presetTradeEnabled: boolean
    testStatus: string
  } | null
  progression?: {
    cyclesCompleted: number
    successfulCycles: number
    failedCycles: number
    cycleSuccessRate: number
    totalTrades: number
    totalProfit: number
  } | null
  quickstart?: {
    connectionId?: string
    connectionName?: string
    exchange?: string
    timestamp?: string
    durationMs?: number
  } | null
}

const defaultStatus: SystemStatus = {
  initializationProgress: 0,
  currentPhase: "Initializing",
  symbolsLoaded: 0,
  totalSymbols: 50,
  prehistoricDataProgress: 0,
  tradeEngineRunning: false,
  realTimeStreamConnected: false,
  indicationsGenerated: 0,
  strategiesEvaluated: 0,
  pseudoPositionsCreated: 0,
  currentInterval: 0,
  intervalExecutionTime: 0,
  lastUpdate: new Date().toISOString(),
}

function StatusCards({ systemStatus }: { systemStatus: SystemStatus }) {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Initialization</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-bold">{systemStatus.initializationProgress}%</span>
            </div>
            <Progress value={systemStatus.initializationProgress} className="h-2" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Symbols Loaded</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-2xl font-bold">
              {systemStatus.symbolsLoaded}/{systemStatus.totalSymbols}
            </div>
            <Progress
              value={systemStatus.totalSymbols > 0 ? (systemStatus.symbolsLoaded / systemStatus.totalSymbols) * 100 : 0}
              className="h-2"
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Prehistoric Data</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Loading</span>
              <span className="font-bold">{systemStatus.prehistoricDataProgress}%</span>
            </div>
            <Progress value={systemStatus.prehistoricDataProgress} className="h-2" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Current Interval</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-2xl font-bold">#{systemStatus.currentInterval}</div>
            <div className="text-xs text-muted-foreground">
              Exec time: {systemStatus.intervalExecutionTime.toFixed(0)}ms
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function RealTimeActivity({ systemStatus }: { systemStatus: SystemStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Real-Time Activity
        </CardTitle>
        <CardDescription>Current system processing metrics</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-blue-500/10 p-3">
              <Zap className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Indications Generated</div>
              <div className="text-2xl font-bold">{systemStatus.indicationsGenerated}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-purple-500/10 p-3">
              <BarChart3 className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Strategies Evaluated</div>
              <div className="text-2xl font-bold">{systemStatus.strategiesEvaluated}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-green-500/10 p-3">
              <TrendingUp className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Pseudo Positions</div>
              <div className="text-2xl font-bold">{systemStatus.pseudoPositionsCreated}</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function WorkflowPhaseCard({ queueData }: { queueData: QueueData | null }) {
  if (!queueData?.workflow?.length) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5" />
          Quickstart Workflow
        </CardTitle>
        <CardDescription>Live readiness state for logistics, processing, and engine activation</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Workflow Health</div>
            <div className="mt-1 text-lg font-semibold capitalize">{queueData.workflowHealth || "unknown"}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Queue Backlog</div>
            <div className="mt-1 text-lg font-semibold">{queueData.queueBacklog || 0}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Processing Pressure</div>
            <div className="mt-1 text-lg font-semibold">{queueData.processingPressure || 0}%</div>
            <Progress value={queueData.processingPressure || 0} className="mt-2 h-2" />
          </div>
        </div>
        {queueData.workflow.map((phase) => (
          <div key={phase.id} className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div>
              <div className="font-medium">{phase.label}</div>
              <div className="text-sm text-muted-foreground">{phase.detail}</div>
            </div>
            <Badge
              variant={phase.status === "complete" ? "default" : phase.status === "warning" ? "secondary" : "outline"}
              className="shrink-0"
            >
              {phase.status}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function FocusConnectionCard({ queueData }: { queueData: QueueData | null }) {
  if (!queueData?.focusConnection) return null

  const focus = queueData.focusConnection
  const progression = queueData.progression

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Focus Connection
        </CardTitle>
        <CardDescription>Primary connection driving current logistics and progression visibility</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="text-sm text-muted-foreground">Connection</div>
          <div className="font-semibold">{focus.name}</div>
          <div className="text-xs text-muted-foreground uppercase">{focus.exchange}</div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Connection State</div>
          <div className="font-semibold">{focus.testStatus}</div>
          <div className="text-xs text-muted-foreground">
            Credentials: {focus.hasCredentials ? "Configured" : "Missing"}
          </div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Progression</div>
          <div className="font-semibold">{progression?.cyclesCompleted || 0} cycles</div>
          <div className="text-xs text-muted-foreground">
            Success rate: {Math.round(progression?.cycleSuccessRate || 0)}%
          </div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Processing Flags</div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant={focus.isActivePanel ? "default" : "outline"}>Active Panel</Badge>
            <Badge variant={focus.isDashboardEnabled ? "default" : "outline"}>Dashboard Enabled</Badge>
            <Badge variant={focus.liveTradeEnabled ? "default" : "outline"}>Live Trade</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function QuickstartStatusCard({ queueData }: { queueData: QueueData | null }) {
  if (!queueData?.quickstart) return null
  const run = queueData.quickstart

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5" />
          Last Quickstart Run
        </CardTitle>
        <CardDescription>Cross-system quickstart status used by overview/tracking/logistics</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div>
          <div className="text-sm text-muted-foreground">Connection</div>
          <div className="font-semibold">{run.connectionName || run.connectionId || "N/A"}</div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Exchange</div>
          <div className="font-semibold uppercase">{run.exchange || "N/A"}</div>
        </div>
        <div>
          <div className="text-sm text-muted-foreground">Completed</div>
          <div className="font-semibold">
            {run.timestamp ? new Date(run.timestamp).toLocaleString() : "N/A"}
            {typeof run.durationMs === "number" ? ` (${run.durationMs}ms)` : ""}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MainSystemTab({ systemStatus }: { systemStatus: SystemStatus }) {
  return (
    <div className="space-y-6">
      <Alert className="border-l-4 border-l-primary">
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Main System Trade Mode:</strong> Uses step-based indication calculations (Direction, Move,
          Active types with 3-30 step ranges) generating up to 250 pseudo positions per indication.
        </AlertDescription>
      </Alert>

      <Card className="border-l-4 border-l-blue-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 font-bold text-white">1</div>
            Initialization Phase
          </CardTitle>
          <CardDescription>System startup and prehistoric data loading</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 font-medium">1.1 Load System Settings from Database</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>{'Trade Engine Interval: 1.0s (default)'}</div>
              <div>{'Real Positions Interval: 0.3s'}</div>
              <div>{'Market Data Timeframe: 1 second'}</div>
              <div>{'Time Range History: 5 days'}</div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 font-medium">1.2 Load Symbols</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>{'Mode: Main Symbols -> Use configured list + forced symbols'}</div>
              <div>{'Mode: Exchange Symbols -> Fetch top N by volume'}</div>
              <div className="font-medium text-primary">
                Result: {systemStatus.symbolsLoaded} unique symbols loaded
              </div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 flex items-center gap-2 font-medium">
              1.3 Load Prehistoric Data (Async per Symbol)
              <Badge className="bg-blue-500 text-white">Parallel</Badge>
            </div>
            <div className="ml-4 space-y-2 text-sm">
              <div className="text-muted-foreground">All symbols processed simultaneously (concurrency limit: 10)</div>
              <div className="rounded border bg-background p-3">
                <Progress value={systemStatus.prehistoricDataProgress} className="h-2" />
                <div className="mt-2 text-xs font-mono text-primary">
                  Progress: {systemStatus.prehistoricDataProgress}% complete
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 font-medium">1.4 Initialize Market Data Stream</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>Connect to exchange WebSocket, subscribe to all symbols</div>
              <div className="flex items-center gap-2">
                <span>Status:</span>
                <Badge variant={systemStatus.realTimeStreamConnected ? "default" : "secondary"} className="text-xs">
                  {systemStatus.realTimeStreamConnected ? "Connected" : "Connecting"}
                </Badge>
              </div>
            </div>
          </div>
          {systemStatus.initializationProgress >= 100 && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <AlertDescription>
                <strong>Initialization Complete:</strong> System ready and Trade Engine running
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {systemStatus.tradeEngineRunning && (
        <Card className="border-l-4 border-l-purple-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500 font-bold text-white">2</div>
              Trade Interval Loop (1.0s)
            </CardTitle>
            <CardDescription>Indications - Strategies - Pseudo Positions - Logging (Non-Overlapping)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <strong>Non-Overlapping Execution:</strong> New interval starts ONLY after previous completes.
                Current execution time: {systemStatus.intervalExecutionTime.toFixed(0)}ms
              </AlertDescription>
            </Alert>
            <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
              <div className="mb-3 flex items-center gap-2 font-medium">
                2.1 Process Indications (Base Pseudo Positions)
                <Badge className="bg-blue-500 text-white">Parallel by Symbol</Badge>
              </div>
              <div className="rounded border bg-background p-3 text-sm">
                <div className="mb-2 font-medium text-green-600">Indication Types:</div>
                <div className="ml-4 space-y-1 text-muted-foreground">
                  <div>Direction Type (3-30 step ranges): Reversal trading</div>
                  <div>Move Type (3-30 step ranges): Trend following</div>
                  <div>Active Type (0.5-2.5% thresholds): Breakout strategies</div>
                  <div>Optimal Type (Advanced): High-precision validated configs</div>
                </div>
                <div className="mt-3 rounded bg-primary/5 p-2 text-xs">
                  <div className="flex justify-between"><span>Indications Generated:</span><span className="font-bold">{systemStatus.indicationsGenerated}</span></div>
                  <div className="flex justify-between"><span>Current Interval:</span><span className="font-bold">#{systemStatus.currentInterval}</span></div>
                </div>
              </div>
            </div>
            <div className="rounded-lg border-l-4 border-l-purple-500 bg-purple-500/5 p-4">
              <div className="mb-3 flex items-center gap-2 font-medium">
                2.2 Evaluate Strategies
                <Badge className="bg-purple-500 text-white">Sequential</Badge>
              </div>
              <div className="rounded border bg-background p-3 text-sm">
                <div className="mb-2 font-medium text-purple-600">Strategy Evaluation:</div>
                <div className="ml-4 space-y-1 text-muted-foreground">
                  <div>Take Profit: 11 levels (0.5% to 5.0%)</div>
                  <div>Stop Loss: 21 levels (0.1% to 2.0%)</div>
                  <div>Trailing: 4 modes (OFF, Standard, Aggressive, Conservative)</div>
                  <div>Total combinations: 924 per indication</div>
                </div>
                <div className="mt-3 rounded bg-purple-500/10 p-2 text-xs">
                  <div className="flex justify-between"><span>Strategies Evaluated:</span><span className="font-bold">{systemStatus.strategiesEvaluated}</span></div>
                </div>
              </div>
            </div>
            <div className="rounded-lg border-l-4 border-l-green-500 bg-green-500/5 p-4">
              <div className="mb-3 flex items-center gap-2 font-medium">
                2.3 Create Pseudo Positions
                <Badge className="bg-green-500 text-white">Database Write</Badge>
              </div>
              <div className="rounded border bg-background p-3 text-sm">
                <div className="mb-2 font-medium text-green-600">Position Creation:</div>
                <div className="ml-4 space-y-1 text-muted-foreground">
                  <div>{'Filter by profit_factor >= 0.6'}</div>
                  <div>Max 250 positions per configuration</div>
                  <div>Track performance metrics</div>
                </div>
                <div className="mt-3 rounded bg-green-500/10 p-2 text-xs">
                  <div className="flex justify-between"><span>Pseudo Positions Created:</span><span className="font-bold">{systemStatus.pseudoPositionsCreated}</span></div>
                </div>
              </div>
            </div>
            <div className="rounded-lg border-l-4 border-l-orange-500 bg-orange-500/5 p-4">
              <div className="mb-3 flex items-center gap-2 font-medium">
                2.4 System Logging
                <Badge className="bg-orange-500 text-white">Async</Badge>
              </div>
              <div className="rounded border bg-background p-3 text-sm text-muted-foreground">
                <div>Log all indications, strategies, and positions</div>
                <div>Performance metrics tracking</div>
                <div>Last update: {new Date(systemStatus.lastUpdate).toLocaleTimeString()}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {systemStatus.tradeEngineRunning && (
        <Card className="border-l-4 border-l-green-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500 font-bold text-white">3</div>
              Position Management
            </CardTitle>
            <CardDescription>Real positions monitoring and execution</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border-l-4 border-l-green-500 bg-green-500/5 p-4">
              <div className="mb-2 font-medium">3.1 Promote to Real Positions</div>
              <div className="ml-4 space-y-1 text-sm text-muted-foreground">
                <div>{'Monitor pseudo position performance, promote best (profit_factor >= 0.8)'}</div>
                <div>Place orders on exchange, track real-time P&L</div>
              </div>
            </div>
            <div className="rounded-lg border-l-4 border-l-green-500 bg-green-500/5 p-4">
              <div className="mb-2 font-medium">3.2 Monitor and Update (0.2s interval)</div>
              <div className="ml-4 space-y-1 text-sm text-muted-foreground">
                <div>Fetch position updates from exchange</div>
                <div>Update trailing stops, execute TP/SL, close positions</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function PresetModeTab() {
  return (
    <div className="space-y-6">
      <Alert className="border-l-4 border-l-primary">
        <Database className="h-4 w-4" />
        <AlertDescription>
          <strong>Preset Mode:</strong> Uses predefined technical indicators (RSI, MACD, Bollinger, etc.)
          for both calculations and live trade execution in one engine.
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Preset Mode Workflow</CardTitle>
          <CardDescription>Indicator-based trading system (calculation + execution)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 font-medium">1. Technical Indicators</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>RSI, MACD, Bollinger Bands, Parabolic SAR</div>
              <div>EMA, SMA, Stochastic Oscillator, ADX</div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-purple-500 bg-purple-500/5 p-4">
            <div className="mb-2 font-medium">2. Signal Generation</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>{'Each indicator generates: BUY, SELL, or NEUTRAL'}</div>
              <div>{'Confluence: 2+ indicators must agree, filter by profit_factor >= 0.6'}</div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-green-500 bg-green-500/5 p-4">
            <div className="mb-2 font-medium">3. Position Execution</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>Create base pseudo positions, track performance</div>
              <div>Promote best to real positions, execute on exchange</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function TradingBotsTab() {
  return (
    <div className="space-y-6">
      <Alert className="border-l-4 border-l-primary">
        <Bot className="h-4 w-4" />
        <AlertDescription>
          <strong>Trading Bots:</strong> Automated trading strategies with custom configurations and risk management.
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Bot Trading Configuration</CardTitle>
          <CardDescription>Manage automated trading bots</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border-l-4 border-l-blue-500 bg-blue-500/5 p-4">
            <div className="mb-2 font-medium">Bot Types</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>Grid Trading, DCA, Arbitrage, Market Making</div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-purple-500 bg-purple-500/5 p-4">
            <div className="mb-2 font-medium">Configuration</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>Symbol selection, price range, grid spacing, volume per order, TP/SL</div>
            </div>
          </div>
          <div className="rounded-lg border-l-4 border-l-green-500 bg-green-500/5 p-4">
            <div className="mb-2 font-medium">Monitoring</div>
            <div className="ml-4 space-y-1 text-sm text-muted-foreground">
              <div>Real-time P&L, order execution status, performance analytics, risk metrics</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LogisticsPage() {
  const [activeTab, setActiveTab] = useState("main")
  const [systemStatus, setSystemStatus] = useState<SystemStatus>(defaultStatus)
  const [loading, setLoading] = useState(true)
  const [queueData, setQueueData] = useState<QueueData | null>(null)

  const fetchSystemStatus = useCallback(async () => {
    try {
      console.log("[v0] [Logistics] Fetching system status...")
      const [statusRes, statsRes, queueRes] = await Promise.all([
        fetch("/api/trade-engine/status", { cache: "no-store" }),
        fetch("/api/main/system-stats-v3", { cache: "no-store" }),
        fetch("/api/logistics/queue", { cache: "no-store" }),
      ])

      const status = statusRes.ok ? await statusRes.json() : null
      const stats = statsRes.ok ? await statsRes.json() : null
      const queue = queueRes.ok ? await queueRes.json() : null

      if (stats) {
        console.log("[v0] [Logistics] Stats received:", stats)
        setSystemStatus({
          initializationProgress: status?.running ? 100 : 0,
          currentPhase: status?.running ? "Running" : "Stopped",
          symbolsLoaded: stats?.symbolsCount || 15,
          totalSymbols: stats?.symbolsCount || 15,
          prehistoricDataProgress: status?.running ? 100 : 0,
          tradeEngineRunning: status?.running === true,
          realTimeStreamConnected: status?.running === true,
          indicationsGenerated: stats?.cycleStats?.indicationCycles || 0,
          strategiesEvaluated: stats?.cycleStats?.strategyCycles || 0,
          pseudoPositionsCreated: stats?.totalPositions || 0,
          currentInterval: stats?.cycleStats?.cycleCount || 0,
          intervalExecutionTime: stats?.cycleStats?.cycleDurationMs || 0,
          lastUpdate: new Date().toISOString(),
        })
      }

      if (queue) {
        console.log("[v0] [Logistics] Queue data:", queue)
        setQueueData(queue)
      }
    } catch (error) {
      console.error("[v0] [Logistics] Error fetching status:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSystemStatus()
    const interval = setInterval(fetchSystemStatus, 2000)
    return () => clearInterval(interval)
  }, [fetchSystemStatus])

  return (
    <AuthGuard>
      <div className="flex min-h-screen w-full flex-col bg-background">
        <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-14 items-center gap-4 px-4">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Toggle menu">
              <Menu className="h-4 w-4" />
            </Button>
            <div className="flex flex-1 items-center justify-between">
              <h1 className="text-lg font-semibold">System Logistics</h1>
              <div className="flex items-center gap-2">
                <Badge variant={systemStatus.tradeEngineRunning ? "default" : "secondary"} className="gap-1">
                  {systemStatus.tradeEngineRunning ? <Activity className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                  {systemStatus.tradeEngineRunning ? "Running" : "Initializing"}
                </Badge>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 space-y-6 p-6">
          <StatusCards systemStatus={systemStatus} />
          <RealTimeActivity systemStatus={systemStatus} />
          <WorkflowPhaseCard queueData={queueData} />
          <FocusConnectionCard queueData={queueData} />
          <QuickstartStatusCard queueData={queueData} />

          {/* Order Queue Logistics */}
          {queueData && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5" />
                  Order Queue Logistics
                </CardTitle>
                <CardDescription>Real-time order processing metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-6">
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Queue Size</div>
                    <div className="text-2xl font-bold text-blue-500">{queueData.queueSize || 0}</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Processing Rate</div>
                    <div className="text-2xl font-bold text-green-500">{queueData.processingRate || 0}/s</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Success Rate</div>
                    <div className="text-2xl font-bold text-purple-500">{queueData.successRate || 0}%</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Avg Latency</div>
                    <div className="text-2xl font-bold text-orange-500">{queueData.avgLatency || 0}ms</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Completed</div>
                    <div className="text-2xl font-bold text-green-600">{queueData.completedOrders || 0}</div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">Failed</div>
                    <div className="text-2xl font-bold text-red-500">{queueData.failedOrders || 0}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Separator />

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full max-w-md grid-cols-3">
              <TabsTrigger value="main" className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Main System
              </TabsTrigger>
              <TabsTrigger value="preset" className="flex items-center gap-2">
                <Database className="h-4 w-4" />
                Preset Mode
              </TabsTrigger>
              <TabsTrigger value="bot" className="flex items-center gap-2">
                <Bot className="h-4 w-4" />
                Trading Bots
              </TabsTrigger>
            </TabsList>

            <TabsContent value="main" className="mt-6">
              <MainSystemTab systemStatus={systemStatus} />
            </TabsContent>
            <TabsContent value="preset" className="mt-6">
              <PresetModeTab />
            </TabsContent>
            <TabsContent value="bot" className="mt-6">
              <TradingBotsTab />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </AuthGuard>
  )
}
