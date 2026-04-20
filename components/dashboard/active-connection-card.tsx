"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  ChevronDown,
  Info,
  Settings2,
  Trash2,
  Loader2,
  Wifi,
  WifiOff,
  Clock,
  Activity,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ConnectionInfoDialog } from "@/components/settings/connection-info-dialog"
import { ConnectionSettingsDialog } from "@/components/settings/connection-settings-dialog"
import { ProgressionLogsDialog } from "@/components/dashboard/progression-logs-dialog"
import { VolumeConfigurationPanel } from "@/components/dashboard/volume-configuration-panel"
import { OrderSettingsPanel } from "@/components/dashboard/order-settings-panel"
import { MainTradeCard } from "@/components/dashboard/main-trade-card"
import { PresetTradeCard } from "@/components/dashboard/preset-trade-card"
import type { Connection } from "@/lib/db-types"
import type { ActiveConnection } from "@/lib/active-connections"
import { toast } from "@/lib/simple-toast"

interface ProgressionData {
  phase: string
  progress: number
  message: string
  subPhase: string | null
  startedAt: string | null
  updatedAt: string | null
  details: {
    historicalDataLoaded: boolean
    indicationsCalculated: boolean
    strategiesProcessed: boolean
    liveProcessingActive: boolean
    liveTradingActive: boolean
  }
  prehistoricProgress?: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    candlesTotal: number
    indicatorsCalculated: number
    currentSymbol: string
    duration: number
    percentComplete: number
  }
  error: string | null
}

const PHASE_LABELS: Record<string, string> = {
  disabled: "Disabled",
  idle: "Idle",
  initializing: "Initializing",
  prehistoric_data: "Loading Historical Data",
  indications: "Processing Indications",
  strategies: "Calculating Strategies",
  realtime: "Starting Real-time Processor",
  live_trading: "Live Trading Active",
  stopped: "Stopped",
  error: "Error",
}

const toBoolean = (value: unknown): boolean => value === true || value === "1" || value === "true"

interface ActiveConnectionCardProps {
  connection: ActiveConnection & { details?: Connection }
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onToggle: (connectionId: string, currentState: boolean) => Promise<void>
  onRemove: (connectionId: string, name: string) => Promise<void>
  isToggling: boolean
  isRemoving?: boolean
  globalEngineRunning: boolean
}

export function ActiveConnectionCard({
  connection,
  expanded,
  onExpand,
  onToggle,
  onRemove,
  isToggling,
  isRemoving = false,
  globalEngineRunning,
}: ActiveConnectionCardProps) {
  const [progression, setProgression] = useState<ProgressionData | null>(null)
  const [infoDialogOpen, setInfoDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [logsDialogOpen, setLogsDialogOpen] = useState(false)
  const [liveTrade, setLiveTrade] = useState(false)
  const [presetMode, setPresetMode] = useState(false)
  const [liveTradeLoading, setLiveTradeLoading] = useState(false)
  const [presetModeLoading, setPresetModeLoading] = useState(false)
  const [liveVolumeFactor, setLiveVolumeFactor] = useState(1.0)
  const [presetVolumeFactor, setPresetVolumeFactor] = useState(1.0)
  const [orderType, setOrderType] = useState<"market" | "limit">("market")
  const [volumeType, setVolumeType] = useState<"usdt" | "contract">("usdt")
  const [mainTradeStatus, setMainTradeStatus] = useState<"idle" | "active" | "paused" | "stopped">("idle")
  const [presetTradeStatus, setPresetTradeStatus] = useState<"idle" | "active" | "paused" | "stopped">("idle")
  // Live engine-stats counters displayed under the progress bar
  // Ref to current phase — used inside stable interval callback to avoid recreating on every phase change
  const phaseRef = useRef<string>("idle")
  const [liveStats, setLiveStats] = useState<{
    indicationCycles: number
    strategyCycles: number
    indications: number
    strategies: number
    positions: number
  } | null>(null)
  const [prehistoricStats, setPrehistoricStats] = useState<{
    // Indication breakdown
    indicationsDirection: number
    indicationsMove: number
    indicationsActive: number
    indicationsOptimal: number
    indicationsAuto: number
    indicationsTotal: number
    // Strategy stages
    stratBase: number
    stratMain: number
    stratReal: number
    stratLive: number
    // Stage ratios and metrics
    basePassRatio: number
    mainPassRatio: number
    realPassRatio: number
    avgProfitFactorBase: number
    avgProfitFactorMain: number
    avgProfitFactorReal: number
    avgDrawdownTimeBase: number
    avgDrawdownTimeMain: number
    avgDrawdownTimeReal: number
    avgPosEvalReal: number
    // Evaluated / passed counts per stage
    baseEvaluated: number
    basePassed: number
    mainEvaluated: number
    mainPassed: number
    realEvaluated: number
    realPassed: number
    countPosEvalReal: number
    // Live exchange execution metrics
    liveOrdersPlaced: number
    liveOrdersFilled: number
    liveOrdersFailed: number
    liveOrdersRejected: number
    liveOrdersSimulated: number
    livePositionsCreated: number
    livePositionsClosed: number
    livePositionsOpen: number
    liveWins: number
    liveVolumeUsdTotal: number
    liveFillRate: number
    liveWinRate: number
    // Prehistoric metadata
    rangeDays: number
    timeframeSeconds: number
    intervalsProcessed: number
    missingIntervalsLoaded: number
    currentSymbol: string
    isComplete: boolean
  } | null>(null)
  const details = connection.details

  // Sync local toggle states from connection details
  useEffect(() => {
    if (details) {
      setLiveTrade(toBoolean(details.is_live_trade))
      setPresetMode(toBoolean(details.is_preset_trade))
    }
  }, [details])

  // Poll progression
  const fetchProgression = useCallback(async () => {
    try {
      const res = await fetch(`/api/connections/progression/${connection.connectionId}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success && data.progression) {
          setProgression(data.progression)
        }
      }
    } catch {
      // Non-critical polling — swallow silently
    }
  }, [connection.connectionId])

  // Keep phaseRef current so the stable interval can read it without recreating
  useEffect(() => {
    phaseRef.current = progression?.phase || "idle"
  }, [progression?.phase])

  useEffect(() => {
    fetchProgression()

    // Single stable interval — reads phaseRef.current on each tick to decide the next delay.
    // Using a self-scheduling timeout so interval length adapts without recreating the effect.
    let timeoutId: ReturnType<typeof setTimeout>
    const scheduleNext = () => {
      const phase = phaseRef.current
      const isActivePhase = phase && phase !== "idle" && phase !== "stopped" && phase !== "live_trading" && phase !== "disabled"
      const delay = isActivePhase ? 2000 : 5000
      timeoutId = setTimeout(async () => {
        await fetchProgression()
        scheduleNext()
      }, delay)
    }
    scheduleNext()

    const handleConnectionToggled = () => { fetchProgression() }
    const handleLiveTradeToggled = (event: Event) => {
      const customEvent = event as CustomEvent
      if (customEvent.detail?.connectionId === connection.connectionId) {
        fetchProgression()
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("connection-toggled", handleConnectionToggled)
      window.addEventListener("live-trade-toggled", handleLiveTradeToggled)
    }

    return () => {
      clearTimeout(timeoutId)
      if (typeof window !== "undefined") {
        window.removeEventListener("connection-toggled", handleConnectionToggled)
        window.removeEventListener("live-trade-toggled", handleLiveTradeToggled)
      }
    }
  }, [fetchProgression, connection.connectionId])

  // Fetch live stats every 4s from the canonical /stats endpoint (per-connection, cumulative)
  useEffect(() => {
    if (!connection.isActive && !globalEngineRunning) {
      setLiveStats(null)
      return
    }

    const fetchLiveStats = async () => {
      try {
        // Use canonical stats endpoint — same source as progression info, per-connection
        const res = await fetch(
          `/api/connections/progression/${connection.connectionId}/stats`,
          { cache: "no-store" }
        )
        if (!res.ok) return
        const data = await res.json()
        setLiveStats({
          indicationCycles: data.realtime?.indicationCycles  || data.indicationCycleCount  || 0,
          strategyCycles:   data.realtime?.strategyCycles    || data.strategyCycleCount    || 0,
          indications:      data.realtime?.indicationsTotal  || data.totalIndicationsCount || 0,
          strategies:       data.realtime?.strategiesTotal   || data.totalStrategyCount    || 0,
          positions:        data.realtime?.positionsOpen     || data.positionsCount        || 0,
        })

        // Also populate prehistoric stats from the same response
        const bd = data.breakdown || {}
        const sd = data.strategyDetail || {}
        const pm = data.prehistoricMeta || {}
        const ind = bd.indications || {}
        const strat = bd.strategies || {}
        setPrehistoricStats({
          indicationsDirection: ind.direction || 0,
          indicationsMove:      ind.move      || 0,
          indicationsActive:    ind.active    || 0,
          indicationsOptimal:   ind.optimal   || 0,
          indicationsAuto:      ind.auto      || 0,
          indicationsTotal:     ind.total     || 0,
          stratBase:  strat.base || 0,
          stratMain:  strat.main || 0,
          stratReal:  strat.real || 0,
          stratLive:  strat.live || 0,
          basePassRatio:       sd.base?.passRatio      || 0,
          mainPassRatio:       sd.main?.passRatio      || 0,
          realPassRatio:       sd.real?.passRatio      || 0,
          avgProfitFactorBase: sd.base?.avgProfitFactor || 0,
          avgProfitFactorMain: sd.main?.avgProfitFactor || 0,
          avgProfitFactorReal: sd.real?.avgProfitFactor || 0,
          avgDrawdownTimeBase: sd.base?.avgDrawdownTime || 0,
          avgDrawdownTimeMain: sd.main?.avgDrawdownTime || 0,
          avgDrawdownTimeReal: sd.real?.avgDrawdownTime || 0,
          avgPosEvalReal:      sd.real?.avgPosEvalReal  || 0,
          // Evaluated / passed counts from per-stage detail
          baseEvaluated:    sd.base?.evaluated   || (strat.base || 0),
          basePassed:       sd.base?.passed       || (strat.main || 0),
          mainEvaluated:    sd.main?.evaluated   || (strat.main || 0),
          mainPassed:       sd.main?.passed       || (strat.real || 0),
          realEvaluated:    sd.real?.evaluated   || (strat.real || 0),
          realPassed:       sd.real?.passed       || (strat.real || 0),
          countPosEvalReal: sd.real?.countPosEval || 0,
          // Live exchange execution
          liveOrdersPlaced:      json?.liveExecution?.ordersPlaced     || 0,
          liveOrdersFilled:      json?.liveExecution?.ordersFilled     || 0,
          liveOrdersFailed:      json?.liveExecution?.ordersFailed     || 0,
          liveOrdersRejected:    json?.liveExecution?.ordersRejected   || 0,
          liveOrdersSimulated:   json?.liveExecution?.ordersSimulated  || 0,
          livePositionsCreated:  json?.liveExecution?.positionsCreated || 0,
          livePositionsClosed:   json?.liveExecution?.positionsClosed  || 0,
          livePositionsOpen:     json?.liveExecution?.positionsOpen    || 0,
          liveWins:              json?.liveExecution?.wins             || 0,
          liveVolumeUsdTotal:    json?.liveExecution?.volumeUsdTotal   || 0,
          liveFillRate:          json?.liveExecution?.fillRate         || 0,
          liveWinRate:           json?.liveExecution?.winRate          || 0,
          rangeDays:               pm.rangeDays              || 1,
          timeframeSeconds:        pm.timeframeSeconds        || 1,
          intervalsProcessed:      pm.intervalsProcessed      || 0,
          missingIntervalsLoaded:  pm.missingIntervalsLoaded  || 0,
          currentSymbol:           pm.currentSymbol           || "",
          isComplete:              pm.isComplete              || false,
        })
      } catch { /* non-critical */ }
    }

    fetchLiveStats()
    const interval = setInterval(fetchLiveStats, 4000)
    return () => clearInterval(interval)
  }, [globalEngineRunning, connection.connectionId, connection.isActive])

  // Handle Live Trade toggle
  const handleLiveTradeToggle = async (newState: boolean) => {
    const connName = connection.exchangeName
    // Validation — connection must be enabled first
    if (newState && !connection.isActive) {
      toast.error("Enable the connection toggle first")
      return
    }

    setLiveTradeLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/live-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_live_trade: newState }),
        cache: "no-store"
      })

      const data = await res.json().catch(() => ({ error: "Failed to parse response" }))

      if (res.ok && data.success) {
        setLiveTrade(newState)
        toast.success(newState ? `Live Trading starting on ${connName}...` : `Live Trading stopped on ${connName}`)
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("live-trade-toggled", {
            detail: { connectionId: connection.connectionId, newState }
          }))
        }
      } else {
        toast.error(`Failed to toggle Live Trade: ${data.error || "Unknown error"}`)
      }
    } catch {
      toast.error("Failed to toggle Live Trade")
    } finally {
      setLiveTradeLoading(false)
    }
  }

  // Handle Preset Mode toggle
  const handlePresetModeToggle = async (newState: boolean) => {
    if (newState && !connection.isActive) {
      toast.error("Enable the connection toggle first")
      return
    }
    setPresetModeLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/preset-toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_preset_trade: newState }),
      })
      if (res.ok) {
        setPresetMode(newState)
        toast.success(newState ? "Preset Mode engine starting..." : "Preset Mode engine stopped")
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }))
        toast.error(err.error || "Failed to toggle Preset Mode")
      }
    } catch {
      toast.error("Failed to toggle Preset Mode")
    } finally {
      setPresetModeLoading(false)
    }
  }

  const phase = progression?.phase || "idle"
  const progress = progression?.progress || 0
  const isRunning = phase === "live_trading"
  const isStarting = phase !== "idle" && phase !== "stopped" && phase !== "live_trading" && phase !== "error" && progress < 100
  const hasError = phase === "error"

  const cardBorderClass = isRunning
    ? "border-green-300 dark:border-green-800"
    : isStarting
      ? "border-amber-300 dark:border-amber-800"
      : hasError
        ? "border-red-300 dark:border-red-800"
        : "border-border"

  const statusBadge = isRunning
    ? { label: "Live", className: "bg-green-600 text-white" }
    : isStarting
      ? { label: "Starting...", className: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" }
      : hasError
        ? { label: "Error", className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" }
        : connection.isActive && !globalEngineRunning
          ? { label: "Paused", className: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" }
          : connection.isActive
            ? { label: "Ready", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" }
            : { label: "Off", className: "text-muted-foreground" }

  const connName = details?.name || connection.connectionId
  const testStatus = details?.last_test_status

  return (
    <>
      <Collapsible open={expanded} onOpenChange={onExpand}>
        <Card className={`transition-colors ${cardBorderClass}`}>
          <CardHeader className="pb-2 px-4 pt-4">
            {/* Row 1: Name, exchange badge, status badge, expand button */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {connection.isActive ? (
                    <Wifi className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <CardTitle className="text-sm font-semibold truncate">{connName}</CardTitle>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {details?.exchange || connection.exchangeName}
                </Badge>
                <Badge variant="secondary" className={`text-[10px] shrink-0 ${statusBadge.className}`}>
                  {statusBadge.label}
                </Badge>
                {testStatus && (
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${
                      testStatus === "success"
                        ? "border-green-300 text-green-700 dark:text-green-400"
                        : testStatus === "error" || testStatus === "failed"
                          ? "border-red-300 text-red-700 dark:text-red-400"
                          : ""
                    }`}
                  >
                    {testStatus === "success" ? "Tested" : testStatus === "error" || testStatus === "failed" ? "Test Failed" : testStatus}
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* Info button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setInfoDialogOpen(true)}
                  title="Connection Info"
                >
                  <Info className="h-3.5 w-3.5" />
                </Button>
                {/* Settings button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setSettingsDialogOpen(true)}
                  title="Connection Settings"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
                {/* Logs button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setLogsDialogOpen(true)}
                  title="Procedure Logs"
                >
                  <Activity className="h-3.5 w-3.5" />
                </Button>
                {/* Expand toggle */}
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
              </div>
            </div>

            {/* Row 2: Connection info line */}
            <CardDescription className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
              {details?.api_type && (
                <span className="capitalize">{details.api_type.replace(/_/g, " ")}</span>
              )}
              {details?.connection_method && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="capitalize">{details.connection_method}</span>
                </>
              )}
              {details?.margin_type && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="capitalize">{details.margin_type}</span>
                </>
              )}
              {!details?.is_testnet && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="text-green-600 dark:text-green-400 font-medium">Live</span>
                </>
              )}
              {details?.last_test_time && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-3 w-3" />
                    {new Date(details.last_test_time).toLocaleTimeString()}
                  </span>
                </>
              )}
            </CardDescription>

            {/* Row 3: Three toggle switches */}
            <div className="flex items-center gap-4 mt-2.5 pt-2 border-t border-border/50">
              {/* Enable toggle — no pre-condition on global engine; toggle-dashboard API starts the engine */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`enable-${connection.connectionId}`}
                  checked={connection.isActive}
                  onCheckedChange={() => {
                    onToggle(connection.connectionId, connection.isActive)
                  }}
                  disabled={isToggling}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`enable-${connection.connectionId}`}
                  className="text-xs font-medium cursor-pointer"
                >
                  {isToggling ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Enable
                    </span>
                  ) : (
                    "Enable"
                  )}
                </Label>
              </div>

              <Separator orientation="vertical" className="h-4" />

              {/* Live Trade toggle */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`live-${connection.connectionId}`}
                  checked={liveTrade}
                  onCheckedChange={handleLiveTradeToggle}
                  disabled={liveTradeLoading || !connection.isActive}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`live-${connection.connectionId}`}
                  className={`text-xs font-medium cursor-pointer ${
                    liveTrade ? "text-green-600 dark:text-green-400" : ""
                  }`}
                >
                  {liveTradeLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Live Trade
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" /> Live Trade
                    </span>
                  )}
                </Label>
              </div>

              <Separator orientation="vertical" className="h-4" />

              {/* Preset Mode toggle */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`preset-${connection.connectionId}`}
                  checked={presetMode}
                  onCheckedChange={handlePresetModeToggle}
                  disabled={presetModeLoading || !connection.isActive}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`preset-${connection.connectionId}`}
                  className={`text-xs font-medium cursor-pointer ${
                    presetMode ? "text-purple-600 dark:text-purple-400" : ""
                  }`}
                >
                  {presetModeLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Preset Mode
                    </span>
                  ) : (
                    "Preset Mode"
                  )}
                </Label>
              </div>

              {/* Spacer + Remove */}
              <div className="ml-auto">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                      disabled={isRemoving}
                    >
                      {isRemoving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove from Active List</AlertDialogTitle>
                      <AlertDialogDescription>
                        {`Remove "${connName}" from active connections? All engines will be stopped.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex gap-2 justify-end">
                      <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => onRemove(connection.connectionId, connName)}
                        disabled={isRemoving}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        {isRemoving ? (
                          <span className="flex items-center gap-2">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Removing...
                          </span>
                        ) : (
                          "Remove"
                        )}
                      </AlertDialogAction>
                    </div>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </CardHeader>

          {/* Per-connection stats row — shown whenever active with data, even in idle/stopped phases */}
          {connection.isActive && liveStats && (phase === "idle" || phase === "stopped" || phase === "disabled") && (
            <CardContent className="pt-0 pb-2 px-4">
              <div className="flex items-center gap-3 flex-wrap pt-1 border-t border-border/40">
                {[
                  { label: "Cycles",    value: liveStats.indicationCycles },
                  { label: "Ind.",      value: liveStats.indications },
                  { label: "Strat.",    value: liveStats.strategies },
                  { label: "Positions", value: liveStats.positions },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-center gap-1 text-[10px]">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-semibold tabular-nums">
                      {value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          )}

          {/* Progress bar when engine has active progression data */}
          {(connection.isActive || phase === "live_trading") && phase !== "idle" && phase !== "stopped" && phase !== "disabled" && (
            <CardContent className="pt-0 pb-3 px-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">
                    {PHASE_LABELS[phase] || phase}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
                {progression?.message && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {progression.message}
                    {progression.subPhase && <span className="ml-1">- {progression.subPhase}</span>}
                  </p>
                )}
                
                {/* Per-connection engine stats — always shown when connection is active */}
                {liveStats && phase !== "prehistoric_data" && (
                  <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                    {[
                      { label: "Cycles",    value: liveStats.indicationCycles },
                      { label: "Ind.",      value: liveStats.indications },
                      { label: "Strat.",    value: liveStats.strategies },
                      { label: "Positions", value: liveStats.positions },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center gap-1 text-[10px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-semibold tabular-nums">
                          {value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Rich prehistoric progress display */}
                {(phase === "prehistoric_data" || (prehistoricStats && (prehistoricStats.indicationsTotal > 0 || prehistoricStats.stratBase > 0))) && (
                  <div className="mt-2 p-2 bg-amber-50/50 dark:bg-amber-950/20 rounded border border-amber-200/50 dark:border-amber-800/30 space-y-2">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                        Historical Processing
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px]">
                        {prehistoricStats && (
                          <>
                            <span className="text-muted-foreground">
                              {prehistoricStats.rangeDays}d range
                            </span>
                            <span className="text-muted-foreground/50">|</span>
                            <span className="text-muted-foreground font-mono">
                              {prehistoricStats.timeframeSeconds === 1 ? "1s" : `${prehistoricStats.timeframeSeconds}s`}
                            </span>
                            {prehistoricStats.isComplete && (
                              <>
                                <span className="text-muted-foreground/50">|</span>
                                <span className="text-green-600 dark:text-green-400 font-medium">complete</span>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Symbols & candles row */}
                    {progression?.prehistoricProgress && (
                      <div className="flex items-center gap-3 text-[10px]">
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">Symbols</span>
                          <span className="font-medium tabular-nums">
                            {progression.prehistoricProgress.symbolsProcessed}/{progression.prehistoricProgress.symbolsTotal}
                          </span>
                        </div>
                        {progression.prehistoricProgress.candlesLoaded > 0 && (
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Candles</span>
                            <span className="font-medium tabular-nums">
                              {progression.prehistoricProgress.candlesLoaded >= 1000
                                ? `${(progression.prehistoricProgress.candlesLoaded / 1000).toFixed(1)}K`
                                : progression.prehistoricProgress.candlesLoaded}
                            </span>
                          </div>
                        )}
                        {prehistoricStats && prehistoricStats.intervalsProcessed > 0 && (
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Intervals</span>
                            <span className="font-medium tabular-nums">
                              {prehistoricStats.intervalsProcessed >= 1000
                                ? `${(prehistoricStats.intervalsProcessed / 1000).toFixed(1)}K`
                                : prehistoricStats.intervalsProcessed}
                            </span>
                          </div>
                        )}
                        {prehistoricStats && prehistoricStats.currentSymbol && phase === "prehistoric_data" && (
                          <div className="flex items-center gap-1 ml-auto">
                            <span className="text-muted-foreground">Now:</span>
                            <span className="font-mono font-medium text-[9px]">{prehistoricStats.currentSymbol}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Indications breakdown */}
                    {prehistoricStats && prehistoricStats.indicationsTotal > 0 && (
                      <div className="space-y-0.5">
                        <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Indications ({prehistoricStats.indicationsTotal.toLocaleString()})</div>
                        <div className="grid grid-cols-5 gap-1">
                          {[
                            { label: "Dir", value: prehistoricStats.indicationsDirection },
                            { label: "Move", value: prehistoricStats.indicationsMove },
                            { label: "Act", value: prehistoricStats.indicationsActive },
                            { label: "Opt", value: prehistoricStats.indicationsOptimal },
                            { label: "Auto", value: prehistoricStats.indicationsAuto },
                          ].map(({ label, value }) => (
                            <div key={label} className="text-center">
                              <div className="text-[8px] text-muted-foreground">{label}</div>
                              <div className="text-[10px] font-semibold tabular-nums">
                                {value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Strategy stages breakdown */}
                    {prehistoricStats && (prehistoricStats.stratBase > 0 || prehistoricStats.stratMain > 0 || prehistoricStats.stratReal > 0) && (
                      <div className="space-y-1">
                        <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Strategy Sets</div>
                        {/* Stage rows: Base → Main → Real */}
                        {[
                          {
                            label: "Base",
                            count:     prehistoricStats.stratBase,
                            evaluated: prehistoricStats.baseEvaluated,
                            passed:    prehistoricStats.basePassed,
                            passRatio: prehistoricStats.basePassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorBase,
                            avgDDT:    prehistoricStats.avgDrawdownTimeBase,
                            avgPosEval: null as number | null,
                            countPosEval: null as number | null,
                            color: "text-blue-600 dark:text-blue-400",
                          },
                          {
                            label: "Main",
                            count:     prehistoricStats.stratMain,
                            evaluated: prehistoricStats.mainEvaluated,
                            passed:    prehistoricStats.mainPassed,
                            passRatio: prehistoricStats.mainPassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorMain,
                            avgDDT:    prehistoricStats.avgDrawdownTimeMain,
                            avgPosEval: null as number | null,
                            countPosEval: null as number | null,
                            color: "text-purple-600 dark:text-purple-400",
                          },
                          {
                            label: "Real",
                            count:     prehistoricStats.stratReal,
                            evaluated: prehistoricStats.realEvaluated,
                            passed:    prehistoricStats.realPassed,
                            passRatio: prehistoricStats.realPassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorReal,
                            avgDDT:    prehistoricStats.avgDrawdownTimeReal,
                            avgPosEval: prehistoricStats.avgPosEvalReal,
                            countPosEval: prehistoricStats.countPosEvalReal,
                            color: "text-green-600 dark:text-green-400",
                          },
                        ].map(({ label, count, evaluated, passed, passRatio, avgPF, avgDDT, avgPosEval, countPosEval, color }) => (
                          count > 0 && (
                            <div key={label} className="space-y-0.5">
                              {/* Main row: label, sets count, pass ratio, PF */}
                              <div className="flex items-center gap-2 text-[10px]">
                                <span className={`font-semibold w-7 shrink-0 ${color}`}>{label}</span>
                                <span className="font-semibold tabular-nums">
                                  {count >= 1000 ? `${(count / 1000).toFixed(1)}K` : count} sets
                                </span>
                                {evaluated > 0 && (
                                  <span className="text-muted-foreground">
                                    eval <span className="text-foreground font-medium tabular-nums">
                                      {evaluated >= 1000 ? `${(evaluated / 1000).toFixed(1)}K` : evaluated}
                                    </span>
                                    {passed > 0 && (
                                      <span className="text-foreground font-medium tabular-nums ml-0.5">
                                        /{passed >= 1000 ? `${(passed / 1000).toFixed(1)}K` : passed} pass
                                      </span>
                                    )}
                                  </span>
                                )}
                                {passRatio > 0 && (
                                  <span className="text-muted-foreground">
                                    <span className={`font-medium ${passRatio >= 50 ? "text-green-600 dark:text-green-400" : passRatio >= 25 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                                      {passRatio.toFixed(1)}%
                                    </span>
                                  </span>
                                )}
                                <span className="text-muted-foreground ml-auto">
                                  PF <span className={`font-medium ${avgPF >= 1.4 ? "text-green-600 dark:text-green-400" : avgPF >= 1.0 ? "text-foreground" : "text-red-500"}`}>
                                    {avgPF > 0 ? avgPF.toFixed(2) : "—"}
                                  </span>
                                </span>
                                <span className="text-muted-foreground">
                                  DDT <span className="text-foreground font-medium">
                                    {avgDDT > 0 ? `${Math.round(avgDDT)}m` : "—"}
                                  </span>
                                </span>
                              </div>
                              {/* Real-stage extra row: PosEval avg + count */}
                              {avgPosEval !== null && (
                                <div className="flex items-center gap-2 text-[10px] pl-7">
                                  <span className="text-muted-foreground">PosEval avg</span>
                                  <span className={`font-medium ${avgPosEval >= 0.7 ? "text-green-600 dark:text-green-400" : avgPosEval >= 0.4 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                                    {avgPosEval > 0 ? avgPosEval.toFixed(3) : "—"}
                                  </span>
                                  {countPosEval !== null && countPosEval > 0 && (
                                    <span className="text-muted-foreground">
                                      count <span className="text-foreground font-medium tabular-nums">{countPosEval}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        ))}
                      </div>
                    )}

                    {/* Missing intervals info */}
                    {prehistoricStats && prehistoricStats.missingIntervalsLoaded > 0 && (
                      <div className="text-[9px] text-muted-foreground">
                        Loaded {prehistoricStats.missingIntervalsLoaded.toLocaleString()} missing intervals
                      </div>
                    )}
                  </div>
                )}
                
                {progression?.error && (
                  <p className="text-[11px] text-red-500 font-medium truncate">
                    {progression.error}
                  </p>
                )}
              </div>
            </CardContent>
          )}

          {/* Expanded details with modern configuration panels */}
          <CollapsibleContent>
            <CardContent className="pt-0 pb-4 px-4 space-y-4">
              <Separator className="mb-3" />

              {/* Connection Details */}
              {details && (
                <div className="grid grid-cols-3 gap-x-4 gap-y-2.5 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Exchange</div>
                    <div className="font-medium">{details.exchange}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">API Type</div>
                    <div className="font-medium capitalize">{details.api_type?.replace(/_/g, " ") || "-"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Method</div>
                    <div className="font-medium capitalize">{details.connection_method || "-"}</div>
                  </div>
                </div>
              )}

              <Separator />

              {/* Volume Configuration Panel */}
              <VolumeConfigurationPanel
                liveVolumeFactor={liveVolumeFactor}
                presetVolumeFactor={presetVolumeFactor}
                onLiveVolumeChange={setLiveVolumeFactor}
                onPresetVolumeChange={setPresetVolumeFactor}
                orderType={orderType}
                onOrderTypeChange={setOrderType}
                volumeType={volumeType}
                onVolumeTypeChange={setVolumeType}
              />

              <Separator />

              {/* Order Settings Panel */}
              <OrderSettingsPanel
                orderType={orderType}
                marketSettings={{ slippageTolerance: 1, autoExecution: true }}
                limitSettings={{ priceOffset: 0.5, timeoutSeconds: 300 }}
              />

              <Separator />

              {/* Main Trade Card */}
              <MainTradeCard
                config={{
                  enabled: true,
                  status: mainTradeStatus,
                  entrySettings: {
                    indicationBased: true,
                    confirmationRequired: 2,
                    sizeCalculationMethod: "percentage",
                  },
                  exitSettings: {
                    takeProfitPercent: 5,
                    stopLossPercent: 2,
                    trailingStopEnabled: false,
                  },
                  positionManagement: {
                    maxPositionsTotal: 10,
                    maxPerSymbol: 2,
                    positionScaling: true,
                    partialExitRules: "None",
                  },
                  statistics: {
                    activePositions: 3,
                    unrealizedPnL: 1245.5,
                    unrealizedPnLPercent: 2.45,
                    winRate: 65,
                    maxDailyDrawdown: 1.2,
                    averageEntryPrice: 0,
                  },
                }}
                onStatusChange={setMainTradeStatus}
              />

              <Separator />

              {/* Preset Trade Card */}
              <PresetTradeCard
                config={{
                  enabled: true,
                  status: presetTradeStatus,
                  activePreset: "preset-1",
                  presetType: "auto-optimal",
                  availablePresets: [
                    {
                      id: "preset-1",
                      name: "Auto-Optimal",
                      description: "Auto-tuned indicators and strategies",
                      type: "auto-optimal",
                      createdDate: "2024-03-15",
                      backtestScore: 87.5,
                    },
                    {
                      id: "preset-2",
                      name: "Conservative",
                      description: "Low-risk conservative trading",
                      type: "conservative",
                      createdDate: "2024-03-10",
                      backtestScore: 72.3,
                    },
                  ],
                  autoUpdateEnabled: true,
                  statistics: {
                    coordinatedPositions: 5,
                    testProgress: 0,
                    activeTrades: 3,
                    presetPnL: 2450.75,
                    presetPnLPercent: 3.2,
                    expectedWinRate: 72,
                  },
                }}
                onStatusChange={setPresetTradeStatus}
              />

              {/* Engine progression details when running */}
              {progression && phase !== "idle" && phase !== "stopped" && phase !== "disabled" && (
                <div className="mt-3 pt-3 border-t">
                  <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                    Engine Progression
                  </h4>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Phase</div>
                      <div className="font-medium">{PHASE_LABELS[phase] || phase}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Progress</div>
                      <div className="font-medium tabular-nums">{progress}%</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Updated</div>
                      <div className="font-medium">
                        {progression.updatedAt ? new Date(progression.updatedAt).toLocaleTimeString() : "-"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Historical</div>
                      <Badge variant={progression.details?.historicalDataLoaded ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.historicalDataLoaded ? "Loaded" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Indications</div>
                      <Badge variant={progression.details?.indicationsCalculated ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.indicationsCalculated ? "Done" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Strategies</div>
                      <Badge variant={progression.details?.strategiesProcessed ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.strategiesProcessed ? "Done" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Live Processing</div>
                      <Badge variant={progression.details?.liveProcessingActive ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.liveProcessingActive ? "Active" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Live Trading</div>
                      <Badge variant={progression.details?.liveTradingActive ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.liveTradingActive ? "Active" : "Pending"}
                      </Badge>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Dialogs */}
      <ConnectionInfoDialog
        open={infoDialogOpen}
        onOpenChange={setInfoDialogOpen}
        connectionId={connection.connectionId}
        connectionName={connName}
      />
      <ConnectionSettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
        connectionId={connection.connectionId}
        connectionName={connName}
      />
      <ProgressionLogsDialog
        open={logsDialogOpen}
        onOpenChange={setLogsDialogOpen}
        connectionId={connection.connectionId}
        connectionName={connName}
        progression={progression}
      />
    </>
  )
}
