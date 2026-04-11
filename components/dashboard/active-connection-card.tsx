"use client"

import { useState, useEffect, useCallback } from "react"
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
  const [liveStats, setLiveStats] = useState<{
    indicationCycles: number
    strategyCycles: number
    indications: number
    strategies: number
    positions: number
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
      console.log(`[v0] [Card] Fetching progression for: ${connection.exchangeName} (${connection.connectionId})`)
      const res = await fetch(`/api/connections/progression/${connection.connectionId}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success && data.progression) {
          console.log(`[v0] [Card] ✓ Progression received: phase=${data.progression.phase}, progress=${data.progression.progress}%, message="${data.progression.message}"`)
          setProgression(data.progression)
        }
      } else {
        console.warn(`[v0] [Card] ⚠ Progression API returned ${res.status}`)
      }
    } catch (error) {
      console.error("[v0] [Card] Failed to fetch progression:", error)
    }
  }, [connection.connectionId, connection.exchangeName])

  useEffect(() => {
    fetchProgression()
    const interval = setInterval(
      fetchProgression,
      progression?.phase && progression.phase !== "idle" && progression.phase !== "stopped" && progression.phase !== "live_trading"
        ? 1000
        : 5000
    )
    
    // Listen for connection toggle events to refresh progression immediately
    const handleConnectionToggled = () => {
      console.log(`[v0] [Card] Detected connection toggle event, refreshing progression...`)
      fetchProgression()
    }
    
    const handleLiveTradeToggled = (event: Event) => {
      const customEvent = event as CustomEvent
      if (customEvent.detail?.connectionId === connection.connectionId) {
        console.log(`[v0] [Card] Detected live trade toggle for this connection, refreshing progression...`)
        fetchProgression()
      }
    }
    
    if (typeof window !== 'undefined') {
      window.addEventListener('connection-toggled', handleConnectionToggled)
      window.addEventListener('live-trade-toggled', handleLiveTradeToggled)
    }
    
    return () => {
      clearInterval(interval)
      if (typeof window !== 'undefined') {
        window.removeEventListener('connection-toggled', handleConnectionToggled)
        window.removeEventListener('live-trade-toggled', handleLiveTradeToggled)
      }
    }
  }, [fetchProgression, progression?.phase])

  // Fetch live engine-stats every 3s when engine is running
  useEffect(() => {
    if (!globalEngineRunning) return

    const fetchLiveStats = async () => {
      try {
        const res = await fetch(
          `/api/trading/engine-stats?connection_id=${connection.connectionId}`,
          { cache: "no-store" }
        )
        if (!res.ok) return
        const data = await res.json()
        const indicationCycles = data.indicationCycleCount || 0
        if (indicationCycles > 0 || (data.totalStrategyCount || 0) > 0) {
          setLiveStats({
            indicationCycles,
            strategyCycles:  data.strategyCycleCount  || 0,
            indications:     data.totalIndicationsCount || 0,
            strategies:      data.totalStrategyCount   || 0,
            positions:       data.positionsCount       || 0,
          })
        }
      } catch { /* non-critical */ }
    }

    fetchLiveStats()
    const interval = setInterval(fetchLiveStats, 3000)
    return () => clearInterval(interval)
  }, [globalEngineRunning, connection.connectionId])

  // Handle Live Trade toggle
  const handleLiveTradeToggle = async (newState: boolean) => {
    const connName = connection.exchangeName
    console.log(`[v0] [Card] Live Trade toggle clicked: ${connName}, current=${liveTrade}, new=${newState}`)
    
    // Validation
    if (newState && !globalEngineRunning) {
      console.log(`[v0] [Card] ✗ Cannot enable live trade - global engine not running`)
      toast.error("Global Trade Engine must be running first")
      return
    }
    if (newState && !connection.isActive) {
      console.log(`[v0] [Card] ✗ Cannot enable live trade - connection not active on dashboard`)
      toast.error("Enable the connection first")
      return
    }
    
    console.log(`[v0] [Card] → Calling live-trade API for ${connName}...`)
    setLiveTradeLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/live-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_live_trade: newState }),
        cache: "no-store"
      })
      
      const data = await res.json().catch(() => ({ error: "Failed to parse response" }))
      console.log(`[v0] [Card] API Response for ${connName}:`, data)
      
      if (res.ok && data.success) {
        console.log(`[v0] [Card] ✓ Live trade ${newState ? "enabled" : "disabled"} for ${connName}`)
        setLiveTrade(newState)
        toast.success(newState ? `Live Trading starting on ${connName}...` : `Live Trading stopped on ${connName}`)
        
        // Dispatch event for system-wide refresh
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("live-trade-toggled", { 
            detail: { connectionId: connection.connectionId, newState } 
          }))
        }
      } else {
        console.log(`[v0] [Card] ✗ API error for ${connName}:`, data.error || data.details)
        toast.error(`Failed to toggle Live Trade: ${data.error || "Unknown error"}`)
        if (data.details) {
          console.log(`[v0] [Card] Error details:`, data.details)
        }
      }
    } catch (error) {
      console.error(`[v0] [Card] Exception toggling live trade for ${connName}:`, error)
      toast.error("Failed to toggle Live Trade")
    } finally {
      setLiveTradeLoading(false)
    }
  }

  // Handle Preset Mode toggle
  const handlePresetModeToggle = async (newState: boolean) => {
    if (newState && !globalEngineRunning) {
      toast.error("Global Trade Engine must be running first")
      return
    }
    if (newState && !connection.isActive) {
      toast.error("Enable the connection first")
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
              {/* Enable toggle */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`enable-${connection.connectionId}`}
                  checked={connection.isActive}
                  onCheckedChange={() => {
                    console.log(`[v0] [Card] Toggle clicked for ${connName}: ${connection.isActive} → ${!connection.isActive}`)
                    onToggle(connection.connectionId, connection.isActive)
                  }}
                  disabled={isToggling || (!globalEngineRunning && !connection.isActive)}
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
                  disabled={liveTradeLoading || !connection.isActive || !globalEngineRunning}
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
                  disabled={presetModeLoading || !connection.isActive || !globalEngineRunning}
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

          {/* Progress bar when engine is active AND connection is enabled */}
          {connection.isActive && globalEngineRunning && phase !== "idle" && phase !== "stopped" && (
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
                
                {/* Live engine stats mini row — shown when engine has processed at least 1 cycle */}
                {liveStats && liveStats.indicationCycles > 0 && phase !== "idle" && phase !== "prehistoric_data" && (
                  <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                    {[
                      { label: "Cycles",     value: liveStats.indicationCycles },
                      { label: "Ind.",       value: liveStats.indications },
                      { label: "Strat.",     value: liveStats.strategies },
                      { label: "Positions",  value: liveStats.positions },
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

                {/* Detailed prehistoric progress display */}
                {phase === "prehistoric_data" && progression?.prehistoricProgress && (
                  <div className="mt-2 p-2 bg-amber-50/50 dark:bg-amber-950/20 rounded border border-amber-200/50 dark:border-amber-800/30 space-y-1">
                    <div className="text-[10px] font-medium text-amber-700 dark:text-amber-400">Historical Data Loading</div>
                    
                    {/* Symbols progress */}
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground">Symbols</span>
                      <span className="font-medium">
                        {progression.prehistoricProgress.symbolsProcessed}/{progression.prehistoricProgress.symbolsTotal}
                      </span>
                    </div>
                    {progression.prehistoricProgress.currentSymbol && (
                      <div className="text-[10px] text-muted-foreground">
                        Processing: <span className="font-mono font-medium">{progression.prehistoricProgress.currentSymbol}</span>
                      </div>
                    )}
                    
                    {/* Candles progress */}
                    {progression.prehistoricProgress.candlesTotal > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">Candles</span>
                        <span className="font-medium">
                          {progression.prehistoricProgress.candlesLoaded}/{progression.prehistoricProgress.candlesTotal}
                        </span>
                      </div>
                    )}
                    
                    {/* Indicators calculated */}
                    {progression.prehistoricProgress.indicatorsCalculated > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">Indicators</span>
                        <span className="font-medium">
                          {progression.prehistoricProgress.indicatorsCalculated}
                        </span>
                      </div>
                    )}
                    
                    {/* Duration */}
                    {progression.prehistoricProgress.duration > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">Duration</span>
                        <span className="font-medium">
                          {(progression.prehistoricProgress.duration / 1000).toFixed(1)}s
                        </span>
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
