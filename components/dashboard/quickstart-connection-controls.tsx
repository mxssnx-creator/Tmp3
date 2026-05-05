"use client"

/**
 * QuickStart connection controls — a single compact strip mounted at the
 * top of the QuickStart card. Two responsibilities:
 *
 *   1. Connection picker — lists every BASE connection that is enabled in
 *      Settings but is NOT yet inserted into the Active panel ("Main
 *      connections"). The operator selects one and clicks "Add" to push
 *      it into the Active panel via /api/settings/connections/add-to-active.
 *      Empty state ("All base connections already added") is intentional
 *      — keeps the panel quiet on a steady state but obvious during
 *      bootstrapping a fresh install.
 *
 *   2. Reset DB — destructive button that POSTs to
 *      /api/admin/clear-progressions. The endpoint surgically clears
 *      runtime state (progression logs, set caches, indications,
 *      strategies, tracking, positions, engine state, fingerprint cache,
 *      trades) but PRESERVES credentials and settings. The button
 *      always confirms before firing.
 *
 * Both actions emit a `connections:refresh` window event so the dashboard
 * tabs that own connection lists pick the change up immediately, and a
 * `quickstart:refresh` event so QuickStart's own polling resumes from a
 * clean slate.
 */

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover"
import {
  Plug, Plus, Trash2, Loader2, AlertCircle, CheckCircle2,
} from "lucide-react"
import {
  isBaseConnection, isConnectionEnabled,
} from "@/lib/connection-utils"

interface ConnectionRow {
  id: string
  name: string
  exchange: string
  is_enabled?: string | boolean
  is_active_inserted?: string | boolean
  is_inserted?: string | boolean
  is_enabled_dashboard?: string | boolean
}

function exchangeColor(exchange: string): string {
  const e = (exchange || "").toLowerCase()
  if (e === "bybit") return "text-orange-600 dark:text-orange-400"
  if (e === "bingx") return "text-blue-600 dark:text-blue-400"
  if (e === "binance") return "text-yellow-600 dark:text-yellow-500"
  if (e === "okx") return "text-cyan-600 dark:text-cyan-400"
  return "text-muted-foreground"
}

export function QuickstartConnectionControls() {
  const [connections, setConnections] = useState<ConnectionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<
    { ok: boolean; message: string } | null
  >(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // ── data load ──────────────────────────────────────────────────────────
  // The same /api/settings/connections endpoint the rest of the dashboard
  // uses — no separate cache, so the picker reflects the same connection
  // state the user sees in Settings.
  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/settings/connections?t=${Date.now()}`, {
        cache: "no-store",
      })
      const data = await res.json()
      const list: ConnectionRow[] = Array.isArray(data?.connections)
        ? data.connections
        : []
      setConnections(list)
    } catch (err) {
      console.error("[v0] [QSConnectionControls] load failed:", err)
      setConnections([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadConnections()
    // Re-load when other parts of the app emit the standard refresh event.
    const handler = () => loadConnections()
    window.addEventListener("connections:refresh", handler)
    return () => window.removeEventListener("connections:refresh", handler)
  }, [loadConnections])

  // ── derived: addable base connections ──────────────────────────────────
  // The picker only lists base connections (bybit/bingx by current
  // BASE_EXCHANGES list) that are enabled in Settings AND haven't been
  // pushed into the Active panel yet. Anything already inserted is hidden
  // because it'd be a no-op on the server.
  const addable = connections.filter((c) => {
    if (!isBaseConnection(c)) return false
    if (!isConnectionEnabled(c)) return false
    const inserted =
      c.is_active_inserted === "1" ||
      c.is_active_inserted === true ||
      c.is_active_inserted === ("true" as any)
    return !inserted
  })

  // Items already in the Active panel — informational so the operator
  // sees what's already there without having to flip tabs.
  const alreadyAdded = connections.filter((c) => {
    if (!isBaseConnection(c)) return false
    return (
      c.is_active_inserted === "1" ||
      c.is_active_inserted === true ||
      c.is_active_inserted === ("true" as any)
    )
  })

  // ── actions ────────────────────────────────────────────────────────────
  const handleAdd = useCallback(
    async (connectionId: string) => {
      if (!connectionId || adding) return
      setAdding(connectionId)
      try {
        const res = await fetch(
          "/api/settings/connections/add-to-active",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId }),
          },
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data?.success === false) {
          console.warn("[v0] [QSConnectionControls] add failed:", data)
        } else {
          // Tell the rest of the app a new connection was activated.
          window.dispatchEvent(new CustomEvent("connections:refresh"))
          window.dispatchEvent(new CustomEvent("quickstart:refresh"))
        }
        await loadConnections()
      } catch (err) {
        console.error("[v0] [QSConnectionControls] add error:", err)
      } finally {
        setAdding(null)
      }
    },
    [adding, loadConnections],
  )

  const handleReset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    setResetResult(null)
    try {
      const res = await fetch("/api/admin/clear-progressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) {
        setResetResult({
          ok: false,
          message: data?.error || data?.details || `Reset failed (HTTP ${res.status})`,
        })
      } else {
        setResetResult({
          ok: true,
          message: data?.message || "Database cleared",
        })
        // Refresh every consumer of connections / progressions / engine
        // status so the UI reflects the new clean slate immediately.
        window.dispatchEvent(new CustomEvent("connections:refresh"))
        window.dispatchEvent(new CustomEvent("quickstart:refresh"))
        window.dispatchEvent(new CustomEvent("progressions:refresh"))
        await loadConnections()
      }
    } catch (err) {
      setResetResult({
        ok: false,
        message: err instanceof Error ? err.message : "Reset failed",
      })
    } finally {
      setResetting(false)
      // Auto-dismiss the success/error chip after 6s.
      setTimeout(() => setResetResult(null), 6000)
    }
  }, [resetting, loadConnections])

  // ── render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-primary/10 bg-muted/30">
      {/* ── Connection picker ─────────────────────────────────────────── */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] px-2 gap-1.5"
            aria-label="Add base connection to Active panel"
          >
            <Plug className="w-3 h-3" />
            <span>Connections</span>
            <span className="text-muted-foreground tabular-nums">
              {alreadyAdded.length}
              {addable.length > 0 ? `+${addable.length}` : ""}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="px-3 py-2 border-b">
            <p className="text-xs font-semibold">Base connections</p>
            <p className="text-[10px] text-muted-foreground">
              Add an enabled base connection to the Active panel.
            </p>
          </div>

          {/* Already-added group — informational so the operator knows
              what's live without leaving the popover. */}
          {alreadyAdded.length > 0 && (
            <div className="px-3 py-2 border-b">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                In Active panel
              </p>
              <ul className="space-y-1">
                {alreadyAdded.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-1.5 text-[11px]"
                  >
                    <CheckCircle2 className="w-3 h-3 text-green-600" />
                    <span className="font-medium truncate">{c.name}</span>
                    <span className={`uppercase text-[9px] ${exchangeColor(c.exchange)}`}>
                      {c.exchange}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Addable group — the actionable list. */}
          <div className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Available to add
            </p>
            {loading ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading…
              </div>
            ) : addable.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">
                {alreadyAdded.length > 0
                  ? "All enabled base connections are already added."
                  : "No enabled base connections found. Configure one in Settings first."}
              </p>
            ) : (
              <ul className="space-y-1">
                {addable.map((c) => {
                  const busy = adding === c.id
                  return (
                    <li
                      key={c.id}
                      className="flex items-center gap-1.5 text-[11px]"
                    >
                      <Plug className={`w-3 h-3 ${exchangeColor(c.exchange)}`} />
                      <span className="font-medium truncate flex-1">
                        {c.name}
                      </span>
                      <span className={`uppercase text-[9px] ${exchangeColor(c.exchange)}`}>
                        {c.exchange}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[10px] gap-1"
                        onClick={() => handleAdd(c.id)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        Add
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* ── Reset DB ──────────────────────────────────────────────────── */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={resetting}
            className="h-7 text-[11px] px-2 gap-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-300 dark:border-red-900"
            title="Clear runtime DB (progressions, sets, indications, strategies, positions). Credentials and settings are preserved."
          >
            {resetting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            Reset DB
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-600" />
              Reset runtime database?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This will <strong>stop every running engine</strong> and
                  delete all runtime state:
                </p>
                <ul className="list-disc pl-5 text-muted-foreground space-y-0.5 text-xs">
                  <li>Progression logs and engine_progression counters</li>
                  <li>Set caches, preset-sets, fingerprint cache</li>
                  <li>Indications and strategies snapshots</li>
                  <li>Tracking entries, live positions, trade history</li>
                  <li>Engine state, metrics, and runtime breadcrumbs</li>
                </ul>
                <p className="text-xs">
                  <strong>Preserved:</strong> exchange credentials
                  (connections), app settings, migration markers.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReset}
              disabled={resetting}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600 text-white"
            >
              {resetting ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  Clearing…
                </>
              ) : (
                <>
                  <Trash2 className="w-3 h-3 mr-1.5" />
                  Reset
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Inline result chip — auto-dismisses after 6s ─────────────── */}
      {resetResult && (
        <span
          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${
            resetResult.ok
              ? "bg-green-100 dark:bg-green-950/30 text-green-700 dark:text-green-400"
              : "bg-red-100 dark:bg-red-950/30 text-red-700 dark:text-red-400"
          }`}
          role="status"
        >
          {resetResult.ok ? (
            <CheckCircle2 className="w-3 h-3" />
          ) : (
            <AlertCircle className="w-3 h-3" />
          )}
          {resetResult.message}
        </span>
      )}
    </div>
  )
}
