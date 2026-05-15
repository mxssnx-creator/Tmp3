"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Loader2,
  Save,
  RefreshCw,
  Plus,
  X,
  TrendingUp,
  Zap,
  ArrowDownUp,
  ListFilter,
  Sparkles,
  Database,
  Activity,
} from "lucide-react"
import { toast } from "@/lib/simple-toast"
// Collapsed to a single-line import: an earlier edit cycle left a stale
// HMR module record for this file in `.next/cache`, causing the named
// export `StrategyCoordinationSection` to resolve to `undefined` at
// render time ("StrategyCoordinationSection is not defined"). A
// fresh import shape forces the bundler to emit a new module id.
import { StrategyCoordinationSection, DEFAULT_COORDINATION_SETTINGS, type CoordinationSettings } from "@/components/settings/strategy-coordination-section"

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

interface ConnectionSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
  exchange?: string
}

// ─────────────────────────────────────────────────────────────────────
// DATA SHAPES
// ─────────────────────────────────────────────────────────────────────

const INDICATION_TYPES = ["direction", "move", "active", "optimal", "auto"] as const
type IndicationType = (typeof INDICATION_TYPES)[number]

interface IndicationParams {
  enabled: boolean
  range: number
  timeout: number
  interval: number
}
type ChannelProfile = Record<IndicationType, IndicationParams>

const STRATEGY_TYPES = ["base", "main", "real"] as const
type StrategyType = (typeof STRATEGY_TYPES)[number]

interface StrategyParams {
  enabled: boolean
  min_profit_factor: number
  max_drawdown_time: number
  max_positions: number
}
type StrategyChannel = Record<StrategyType, StrategyParams>

type SymbolOrder =
  | "volume_24h"
  | "volume_1h"
  | "volatility_24h"
  | "volatility_1h"
  | "newest"
  | "manual"

interface OverviewSettings {
  volumeFactorBase:   number
  volumeFactorLive:   number
  volumeFactorPreset: number
  marginMode:  "cross" | "isolated"
  volumeType:  "usdt" | "contract" | "spot"
  /**
   * When true: do NOT place exchange-side reduce-only SL/TP control
   * orders for live positions on this connection. The engine instead
   * monitors markPrice each reconcile/sync cycle and force-closes the
   * position via a market reduce-only order when the desired band is
   * crossed. Existing control orders on open positions are swept on the
   * next cycle after the flag flips on.
   */
  useSystemCloseOnly: boolean
}

interface SymbolsSettings {
  symbols:     string[]
  symbolOrder: SymbolOrder
  symbolCount: number
}

const DEFAULT_INDICATION_PROFILE: ChannelProfile = {
  direction: { enabled: true,  range: 5,  timeout: 30, interval: 1 },
  move:      { enabled: true,  range: 10, timeout: 30, interval: 1 },
  active:    { enabled: true,  range: 15, timeout: 60, interval: 5 },
  optimal:   { enabled: false, range: 20, timeout: 60, interval: 5 },
  auto:      { enabled: false, range: 25, timeout: 90, interval: 15 },
}
const DEFAULT_STRATEGY_PROFILE: StrategyChannel = {
  base: { enabled: true, min_profit_factor: 1.10, max_drawdown_time: 180, max_positions: 250 },
  main: { enabled: true, min_profit_factor: 1.15, max_drawdown_time: 180, max_positions: 250 },
  real: { enabled: true, min_profit_factor: 1.20, max_drawdown_time: 180, max_positions: 100 },
}

// ─────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────

export function ConnectionSettingsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
  exchange = "bingx",
}: ConnectionSettingsDialogProps) {
  const [tab, setTab] = useState<"overview" | "symbols" | "indications" | "strategies">("overview")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exchangeKey, setExchangeKey] = useState<string>(exchange)

  // ── Overview state ──────────────────────────────────────────────
  const [overview, setOverview] = useState<OverviewSettings>({
    volumeFactorBase: 1.0,
    volumeFactorLive: 1.0,
    volumeFactorPreset: 1.0,
    marginMode: "cross",
    volumeType: "usdt",
    useSystemCloseOnly: false,
  })

  // ── Symbols state ───────────────────────────────────────────────
  const [symbolsCfg, setSymbolsCfg] = useState<SymbolsSettings>({
    symbols: [],
    symbolOrder: "volume_24h",
    symbolCount: 3,
  })
  const [symbolInput, setSymbolInput] = useState("")
  const [exchangeSymbols, setExchangeSymbols] = useState<string[]>([])
  const [loadingSymbols, setLoadingSymbols] = useState(false)

  // ── Indications & Strategies state (per channel) ────────────────
  const [indMain,   setIndMain]   = useState<ChannelProfile>(DEFAULT_INDICATION_PROFILE)
  const [indPreset, setIndPreset] = useState<ChannelProfile>(DEFAULT_INDICATION_PROFILE)
  const [stratMain,   setStratMain]   = useState<StrategyChannel>(DEFAULT_STRATEGY_PROFILE)
  const [stratPreset, setStratPreset] = useState<StrategyChannel>(DEFAULT_STRATEGY_PROFILE)
  const [coordination, setCoordination] = useState<CoordinationSettings>(DEFAULT_COORDINATION_SETTINGS)

  // ─────────────────────────────────────────────────────────────────
  // LOAD
  // ─────────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      // Settings (volume factors, margin, volume type, symbols, strategies)
      const [settingsRes, indRes, symRes] = await Promise.all([
        fetch(`/api/settings/connections/${connectionId}/settings`).catch(() => null),
        fetch(`/api/settings/connections/${connectionId}/active-indications`).catch(() => null),
        fetch(`/api/settings/connections/${connectionId}/symbols`).catch(() => null),
      ])

      // ── Settings → Overview + Symbols + Strategies ─────────────
      if (settingsRes?.ok) {
        const data = await settingsRes.json()
        const settings = data.settings || {}
        const conn     = data.connection || {}
        setExchangeKey(String(conn.exchange || exchange).toLowerCase())
        setOverview({
          volumeFactorBase:   Number(settings.volume_factor)        ?? Number(conn.volume_factor) ?? 1.0,
          volumeFactorLive:   Number(settings.volume_factor_live)   || 1.0,
          volumeFactorPreset: Number(settings.volume_factor_preset) || 1.0,
          marginMode:  (settings.margin_mode || conn.margin_type || "cross") as "cross" | "isolated",
          volumeType:  (settings.volume_type || (conn.api_type === "futures_inverse" ? "contract" : conn.api_type === "spot" ? "spot" : "usdt")) as "usdt" | "contract" | "spot",
          useSystemCloseOnly: settings.use_system_close_only === true || settings.useSystemCloseOnly === true,
        })
        setSymbolsCfg(prev => ({
          ...prev,
          symbols:     Array.isArray(settings.symbols) ? settings.symbols : prev.symbols,
          symbolOrder: (settings.symbol_order as SymbolOrder) || prev.symbolOrder,
          symbolCount: Number(settings.symbol_count) || prev.symbolCount,
        }))
        if (settings.strategies?.main)   setStratMain(settings.strategies.main)
        if (settings.strategies?.preset) setStratPreset(settings.strategies.preset)
        // Merge saved coord into defaults so older saves (without the
        // Block ratio / max-stack fields, or without some variants) load
        // cleanly and the new sliders aren't fed undefined.
        const coord = settings.coordination_settings || settings.coordinationSettings
        if (coord) {
          setCoordination({
            ...DEFAULT_COORDINATION_SETTINGS,
            ...coord,
            axes:     { ...DEFAULT_COORDINATION_SETTINGS.axes,     ...(coord.axes     || {}) },
            variants: { ...DEFAULT_COORDINATION_SETTINGS.variants, ...(coord.variants || {}) },
            blockVolumeRatio:
              typeof coord.blockVolumeRatio === "number"
                ? coord.blockVolumeRatio
                : DEFAULT_COORDINATION_SETTINGS.blockVolumeRatio,
            blockMaxStack:
              typeof coord.blockMaxStack === "number"
                ? coord.blockMaxStack
                : DEFAULT_COORDINATION_SETTINGS.blockMaxStack,
          })
        }
      }

      // ── Active indications → Main + Preset ─────────────────────
      if (indRes?.ok) {
        const data = await indRes.json()
        if (data?.channels?.main)   setIndMain(data.channels.main)
        if (data?.channels?.preset) setIndPreset(data.channels.preset)
      }

      // ── Available symbols list (used by Symbols tab picker) ────
      if (symRes?.ok) {
        const data = await symRes.json()
        if (Array.isArray(data.symbols)) setExchangeSymbols(data.symbols)
      }
    } catch (err) {
      console.error("[v0] [Settings Dialog] load error:", err)
      toast.error("Load failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }, [connectionId, exchange])

  useEffect(() => { if (open) loadAll() }, [open, loadAll])

  // ─────────────────────────────────────────────────────────────────
  // EXCHANGE SYMBOLS REFRESH
  // ─────────────────────────────────────────────────────────────────

  const refreshExchangeSymbols = useCallback(async () => {
    setLoadingSymbols(true)
    try {
      // Use the top-symbols endpoint when ordering by volume/volatility/listed,
      // otherwise the static cache fallback below.
      const window = symbolsCfg.symbolOrder.includes("1h") ? "1h" : "24h"
      const sortMap: Record<SymbolOrder, string> = {
        volume_24h:     "volume",
        volume_1h:      "volume",
        volatility_24h: "volatility",
        volatility_1h:  "volatility",
        newest:         "listed_at",
        manual:         "volume",
      }
      const sort = sortMap[symbolsCfg.symbolOrder]
      const url = `/api/exchange/${exchangeKey}/top-symbols?window=${window}&sort=${sort}&limit=50`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        const symbols: string[] = (data?.symbols || []).map((s: any) => s.symbol || s).filter(Boolean)
        if (symbols.length > 0) setExchangeSymbols(symbols)
      }
    } catch (err) {
      console.warn("[v0] [Settings Dialog] refresh symbols failed:", err)
    } finally {
      setLoadingSymbols(false)
    }
  }, [exchangeKey, symbolsCfg.symbolOrder])

  // ─────────────────────────────────────────────────────────────────
  // SAVE
  // ─────────────────────────────────────────────────────────────────

  const saveAll = useCallback(async () => {
    setSaving(true)
    try {
      const payload = {
        // Overview
        volume_factor:        overview.volumeFactorBase,
        volume_factor_live:   overview.volumeFactorLive,
        volume_factor_preset: overview.volumeFactorPreset,
        margin_mode: overview.marginMode,
        volume_type: overview.volumeType,
        use_system_close_only: overview.useSystemCloseOnly,
        useSystemCloseOnly:    overview.useSystemCloseOnly, // backwards-compat alias
        // Symbols
        symbols:      symbolsCfg.symbols,
        symbol_order: symbolsCfg.symbolOrder,
        symbol_count: symbolsCfg.symbolCount,
        // Strategies (per channel)
        strategies: {
          main:   stratMain,
          preset: stratPreset,
        },
        // Strategy coordination (axes + variants toggles)
        coordination_settings: coordination,
        coordinationSettings:  coordination, // legacy alias
      }

      const [settingsRes, indRes] = await Promise.all([
        fetch(`/api/settings/connections/${connectionId}/settings`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        }),
        fetch(`/api/settings/connections/${connectionId}/active-indications`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ channels: { main: indMain, preset: indPreset } }),
        }),
      ])

      if (!settingsRes.ok) throw new Error("Settings save failed")
      if (!indRes.ok)      throw new Error("Indications save failed")

      toast.success("Settings saved", { description: `Updated ${connectionName}` })
      window.dispatchEvent(new CustomEvent("connection-settings-updated", { detail: { connectionId } }))
      onOpenChange(false)
    } catch (err) {
      console.error("[v0] [Settings Dialog] save error:", err)
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }, [connectionId, connectionName, overview, symbolsCfg, stratMain, stratPreset, indMain, indPreset, coordination, onOpenChange])

  // ─────────────────────────────────────────────────────────────────
  // SYMBOL HELPERS
  // ─────────────────────────────────────────────────────────────────

  const addSymbol = useCallback((sym: string) => {
    const clean = sym.trim().toUpperCase()
    if (!clean) return
    setSymbolsCfg(prev =>
      prev.symbols.includes(clean) ? prev : { ...prev, symbols: [...prev.symbols, clean] },
    )
    setSymbolInput("")
  }, [])

  const removeSymbol = useCallback((sym: string) => {
    setSymbolsCfg(prev => ({ ...prev, symbols: prev.symbols.filter(s => s !== sym) }))
  }, [])

  const orderLabel: Record<SymbolOrder, string> = {
    volume_24h:     "Top Volume (24h)",
    volume_1h:      "Top Volume (1h)",
    volatility_24h: "Top Volatility (24h)",
    volatility_1h:  "Top Volatility (1h)",
    newest:         "Newest Listings",
    manual:         "Manual",
  }

  const availableSymbols = useMemo(
    () => exchangeSymbols.filter(s => !symbolsCfg.symbols.includes(s)).slice(0, 25),
    [exchangeSymbols, symbolsCfg.symbols],
  )

  // ────────────────────────────────────���────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        {/* Header */}
        <DialogHeader className="px-5 pt-4 pb-3 border-b">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold truncate">
                Update Settings — {connectionName}
              </DialogTitle>
              <DialogDescription className="text-xs">
                Configure volumes, symbols, indications and strategies for this connection.
              </DialogDescription>
            </div>
            <Badge variant="outline" className="text-[10px] uppercase">
              {exchangeKey}
            </Badge>
          </div>
        </DialogHeader>

        {/* Top Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-5 mt-3 grid grid-cols-4 h-9">
            <TabsTrigger value="overview" className="text-xs gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="symbols" className="text-xs gap-1.5">
              <Database className="h-3.5 w-3.5" /> Symbols
            </TabsTrigger>
            <TabsTrigger value="indications" className="text-xs gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Indications
            </TabsTrigger>
            <TabsTrigger value="strategies" className="text-xs gap-1.5">
              <Zap className="h-3.5 w-3.5" /> Strategies
            </TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 px-5 py-4">
            {loading && (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
              </div>
            )}

            {!loading && (
              <>
                {/* OVERVIEW ──────────────────────────────────────── */}
                <TabsContent value="overview" className="mt-0 space-y-5">
                  <SectionHeading icon={ArrowDownUp} title="Volume Factors" subtitle="Multiplier applied to position size for each trade channel." />
                  <VolumeSlider
                    label="Base"
                    description="Default multiplier for the standard pipeline."
                    value={overview.volumeFactorBase}
                    onChange={(v) => setOverview(p => ({ ...p, volumeFactorBase: v }))}
                  />
                  <VolumeSlider
                    label="Live"
                    description="Applied while a Live position is open."
                    value={overview.volumeFactorLive}
                    onChange={(v) => setOverview(p => ({ ...p, volumeFactorLive: v }))}
                  />
                  <VolumeSlider
                    label="Preset"
                    description="Applied to the preset profile when active."
                    value={overview.volumeFactorPreset}
                    onChange={(v) => setOverview(p => ({ ...p, volumeFactorPreset: v }))}
                  />

                  <Separator className="my-4" />
                  <SectionHeading icon={ListFilter} title="Position Mode" subtitle="Margin and volume denomination applied to all orders." />

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Margin Mode</Label>
                      <Select
                        value={overview.marginMode}
                        onValueChange={(v) => setOverview(p => ({ ...p, marginMode: v as "cross" | "isolated" }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cross">Cross Margin</SelectItem>
                          <SelectItem value="isolated">Isolated Margin</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Volume Type</Label>
                      <Select
                        value={overview.volumeType}
                        onValueChange={(v) => setOverview(p => ({ ...p, volumeType: v as "usdt" | "contract" | "spot" }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="usdt">USDT-M Linear</SelectItem>
                          <SelectItem value="contract">Coin-M Inverse</SelectItem>
                          <SelectItem value="spot">Spot</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <Separator className="my-4" />
                  <SectionHeading
                    icon={Zap}
                    title="Close Mechanism"
                    subtitle="Choose whether SL/TP are placed on the venue as control orders, or driven by the engine via system close."
                  />

                  <div className="flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <Label className="text-xs font-medium">Live Trade Without Control Orders (System Close)</Label>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        When ON, the engine does <strong>not</strong> place reduce-only SL/TP orders on the
                        exchange. Every reconcile and sync tick re-evaluates
                        <code className="text-[10px] px-1 mx-0.5 rounded bg-muted">markPrice</code>
                        against the desired SL/TP band and force-closes the position via a single market
                        reduce-only order when crossed. Any leftover exchange control orders on open positions
                        are swept on the next cycle.
                      </p>
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">
                        Live progress check is wired into every ongoing cycle — every close is verified post-fill.
                      </p>
                    </div>
                    <Switch
                      checked={overview.useSystemCloseOnly}
                      onCheckedChange={(checked) => setOverview(p => ({ ...p, useSystemCloseOnly: checked }))}
                    />
                  </div>
                </TabsContent>

                {/* SYMBOLS ──────────────────────────────────────── */}
                <TabsContent value="symbols" className="mt-0 space-y-5">
                  <SectionHeading icon={Database} title="Symbol Selection" subtitle="Choose how the engine ranks and picks symbols from the exchange." />

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Order from Exchange</Label>
                      <Select
                        value={symbolsCfg.symbolOrder}
                        onValueChange={(v) => setSymbolsCfg(p => ({ ...p, symbolOrder: v as SymbolOrder }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(Object.keys(orderLabel) as SymbolOrder[]).map((k) => (
                            <SelectItem key={k} value={k}>{orderLabel[k]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Symbol Count</Label>
                        <span className="text-xs font-mono tabular-nums">{symbolsCfg.symbolCount}</span>
                      </div>
                      <Slider
                        min={1} max={25} step={1}
                        value={[symbolsCfg.symbolCount]}
                        onValueChange={([v]) => setSymbolsCfg(p => ({ ...p, symbolCount: v }))}
                        className="py-2"
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>1</span><span>default 3</span><span>25</span>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Symbol chips */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Selected Symbols ({symbolsCfg.symbols.length})</Label>
                      <Button
                        type="button"
                        size="sm" variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={refreshExchangeSymbols}
                        disabled={loadingSymbols}
                      >
                        {loadingSymbols ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Refresh listings
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 min-h-[2.5rem] rounded-md border border-dashed p-2">
                      {symbolsCfg.symbols.length === 0 && (
                        <span className="text-[11px] text-muted-foreground italic">
                          No symbols selected — engine will use top-{symbolsCfg.symbolCount} from exchange ordering.
                        </span>
                      )}
                      {symbolsCfg.symbols.map((s) => (
                        <Badge key={s} variant="secondary" className="gap-1 pr-1 text-[10px]">
                          {s}
                          <button
                            type="button"
                            className="rounded-sm p-0.5 hover:bg-destructive/20"
                            onClick={() => removeSymbol(s)}
                            aria-label={`Remove ${s}`}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </Badge>
                      ))}
                    </div>

                    <div className="flex gap-2">
                      <Input
                        placeholder="Add symbol e.g. BTCUSDT"
                        value={symbolInput}
                        onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSymbol(symbolInput))}
                        className="h-8 text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs gap-1"
                        onClick={() => addSymbol(symbolInput)}
                      >
                        <Plus className="h-3 w-3" /> Add
                      </Button>
                    </div>

                    {availableSymbols.length > 0 && (
                      <div className="rounded-md border bg-muted/30 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                          Suggested ({orderLabel[symbolsCfg.symbolOrder]})
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {availableSymbols.map((s) => (
                            <button
                              key={s}
                              type="button"
                              className="rounded-md border bg-background px-2 py-0.5 text-[10px] hover:bg-accent"
                              onClick={() => addSymbol(s)}
                            >
                              + {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* INDICATIONS ─────────────────────────────────── */}
                <TabsContent value="indications" className="mt-0">
                  <Tabs defaultValue="main" className="w-full">
                    <TabsList className="grid grid-cols-2 h-8 mb-4 w-fit">
                      <TabsTrigger value="main"   className="text-xs px-4">Main</TabsTrigger>
                      <TabsTrigger value="preset" className="text-xs px-4">Preset</TabsTrigger>
                    </TabsList>
                    <TabsContent value="main">
                      <IndicationProfileEditor profile={indMain} onChange={setIndMain} />
                    </TabsContent>
                    <TabsContent value="preset">
                      <IndicationProfileEditor profile={indPreset} onChange={setIndPreset} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>

                {/* STRATEGIES ─────────────────────────────────── */}
                <TabsContent value="strategies" className="mt-0">
                  <Tabs defaultValue="main" className="w-full">
                    <TabsList className="grid grid-cols-3 h-8 mb-4 w-fit">
                      <TabsTrigger value="main" className="text-xs px-4">Main</TabsTrigger>
                      <TabsTrigger value="preset" className="text-xs px-4">Preset</TabsTrigger>
                      <TabsTrigger value="coordination" className="text-xs px-4">Coordination</TabsTrigger>
                    </TabsList>
                    <TabsContent value="main">
                      <StrategyProfileEditor profile={stratMain} onChange={setStratMain} />
                    </TabsContent>
                    <TabsContent value="preset">
                      <StrategyProfileEditor profile={stratPreset} onChange={setStratPreset} />
                    </TabsContent>
                    <TabsContent value="coordination">
                      <StrategyCoordinationSection value={coordination} onChange={setCoordination} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              </>
            )}
          </ScrollArea>
        </Tabs>

        <DialogFooter className="px-5 py-3 border-t bg-muted/30">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={saveAll} disabled={saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────���────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────

function SectionHeading({
  icon: Icon, title, subtitle,
}: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
    </div>
  )
}

function VolumeSlider({
  label, description, value, onChange,
}: {
  label: string; description: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">{label}</Label>
          <div className="text-[10px] text-muted-foreground">{description}</div>
        </div>
        <span className="text-xs font-mono tabular-nums w-12 text-right">{value.toFixed(2)}×</span>
      </div>
      <Slider
        min={0.1} max={5} step={0.05}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className="py-1"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>0.1×</span><span>1.0×</span><span>5.0×</span>
      </div>
    </div>
  )
}

function IndicationProfileEditor({
  profile, onChange,
}: { profile: ChannelProfile; onChange: (p: ChannelProfile) => void }) {
  const update = (type: IndicationType, patch: Partial<IndicationParams>) => {
    onChange({ ...profile, [type]: { ...profile[type], ...patch } })
  }
  return (
    <div className="space-y-3">
      {INDICATION_TYPES.map((type) => {
        const p = profile[type]
        return (
          <div key={type} className={`rounded-md border p-3 transition-opacity ${p.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => update(type, { enabled: v })}
                />
                <Label className="text-sm font-medium capitalize">{type}</Label>
              </div>
              <Badge variant={p.enabled ? "default" : "outline"} className="text-[9px]">
                {p.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Range" suffix="" min={1} max={100} step={1}
                value={p.range} onChange={(v) => update(type, { range: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Timeout" suffix="s" min={5} max={600} step={5}
                value={p.timeout} onChange={(v) => update(type, { timeout: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Interval" suffix="m" min={1} max={120} step={1}
                value={p.interval} onChange={(v) => update(type, { interval: v })} disabled={!p.enabled}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StrategyProfileEditor({
  profile, onChange,
}: { profile: StrategyChannel; onChange: (p: StrategyChannel) => void }) {
  const update = (type: StrategyType, patch: Partial<StrategyParams>) => {
    onChange({ ...profile, [type]: { ...profile[type], ...patch } })
  }
  return (
    <div className="space-y-3">
      {STRATEGY_TYPES.map((type) => {
        const p = profile[type]
        const accent =
          type === "base" ? "border-orange-300/50 bg-orange-50/30 dark:bg-orange-950/10" :
          type === "main" ? "border-yellow-300/50 bg-yellow-50/30 dark:bg-yellow-950/10" :
          "border-green-300/50 bg-green-50/30 dark:bg-green-950/10"
        return (
          <div key={type} className={`rounded-md border p-3 transition-opacity ${accent} ${p.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => update(type, { enabled: v })}
                />
                <Label className="text-sm font-medium capitalize">{type} Strategy</Label>
              </div>
              <Badge variant={p.enabled ? "default" : "outline"} className="text-[9px]">
                {p.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Min PF" suffix="×" min={1} max={3} step={0.05}
                value={p.min_profit_factor} onChange={(v) => update(type, { min_profit_factor: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Max DDT" suffix="m" min={1} max={1440} step={1}
                value={p.max_drawdown_time} onChange={(v) => update(type, { max_drawdown_time: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Max Pos" suffix="" min={1} max={1000} step={1}
                value={p.max_positions} onChange={(v) => update(type, { max_positions: v })} disabled={!p.enabled}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function NumberField({
  label, value, onChange, suffix, min, max, step, disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix: string
  min: number
  max: number
  step: number
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v)) return
            onChange(Math.max(min, Math.min(max, v)))
          }}
          className="h-8 text-xs pr-7 tabular-nums"
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}
