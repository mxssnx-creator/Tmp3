"use client"

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Play, FileText, Settings, Zap, RefreshCw, Loader2, TrendingUp } from "lucide-react"

interface VolatileSymbolState {
  symbol: string | null
  exchange: string | null
  priceChangePercent: number | null
  loading: boolean
  error: string | null
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

  const handleStartEngine = async () => {
    if (starting) return
    setStarting(true)
    try {
      const symbol = volatileSymbol.symbol || "BTCUSDT"
      console.log("[v0] [Quickstart] Starting engine with symbol:", symbol)
      window.dispatchEvent(new CustomEvent("engine-state-changed", { detail: { symbol, mode: "single" } }))
    } finally {
      setStarting(false)
    }
  }

  const handleRefreshStatus = async () => {
    setVolatileSymbol(s => ({ ...s, loading: true }))
    // Re-fetch volatile symbol
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
    window.dispatchEvent(new Event("engine-state-changed"))
  }

  return (
    <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
      <div className="p-3 space-y-2.5">

        {/* Header row: title + volatile symbol badge */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold">Quickstart</span>
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
            variant="default"
            onClick={handleStartEngine}
            disabled={starting || volatileSymbol.loading}
            className="h-7 text-xs px-2.5 flex items-center gap-1"
          >
            {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {volatileSymbol.symbol ? `Start (${volatileSymbol.symbol})` : "Start Engine"}
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
            variant="outline"
            onClick={() => window.dispatchEvent(new Event("open-settings"))}
            className="h-7 text-xs px-2.5 flex items-center gap-1"
          >
            <Settings className="w-3 h-3" />
            Settings
          </Button>
        </div>

        {/* Log buttons — second row */}
        <div className="flex flex-wrap gap-1.5 pt-1.5 border-t border-border/30">
          {[
            { label: "Logs", event: "open-logs-dialog" },
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
