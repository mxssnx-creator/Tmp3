"use client"

/**
 * EngineProgressionTestDialog
 *
 * Single-source-of-truth "Run full engine progression test" UI. The exact same
 * 7-phase script that lives in `scripts/engine-progression-e2e-test.js` —
 * exposed as a one-click button + live dialog so the user doesn't need a
 * terminal.
 *
 * Exercises the full engine lifecycle against the real API:
 *   P1  GET   /api/health                       — dev-server reachable
 *   P2  GET   /api/trade-engine/quick-start/ready  — preflight
 *   P3  POST  /api/trade-engine/quick-start  (enable, symbols=1)
 *                                             — quickstart with ONE symbol
 *   P4  GET   /api/trade-engine/progression   — poll until running
 *   P5  GET   /api/system/verify-engine       — assert prehistoric done,
 *                                               cycles > 0, live trading on
 *   P6  GET   /api/trading/live-positions     — positions endpoint healthy
 *   P7  POST  /api/trade-engine/quick-start  (disable)  — clean teardown
 *
 * Rendered by the `<EngineProgressionTestButton />` export (a small button
 * trigger that opens the detail dialog) so it can be dropped wherever the
 * user wants a "Run Test" button — currently both the dashboard page header
 * and the QuickstartSection control row mount an instance of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react"

type StepStatus = "pending" | "running" | "pass" | "warn" | "fail"

interface TestStep {
  id: string
  label: string
  description: string
  status: StepStatus
  durationMs?: number
  summary?: string
  error?: string
  raw?: any
}

interface TestLog {
  id: number
  ts: number
  level: "info" | "ok" | "warn" | "err"
  msg: string
}

interface OverallReport {
  startedAt: number
  finishedAt?: number
  passed: number
  warned: number
  failed: number
  status: "idle" | "running" | "pass" | "partial" | "fail"
}

const INITIAL_STEPS: Omit<TestStep, "status">[] = [
  {
    id: "P1",
    label: "Server Health",
    description: "GET /api/health — verify dev server is responding.",
  },
  {
    id: "P2",
    label: "QuickStart Preflight",
    description: "GET /api/trade-engine/quick-start/ready — preconditions OK.",
  },
  {
    id: "P3",
    label: "QuickStart Enable (1 symbol)",
    description: "POST /api/trade-engine/quick-start — enable with a single auto-picked top-volatile symbol.",
  },
  {
    id: "P4",
    label: "Engine Progression",
    description: "GET /api/trade-engine/progression — poll until the engine reports running.",
  },
  {
    id: "P5",
    label: "Engine Verification",
    description: "GET /api/system/verify-engine — assert prehistoric complete, cycles > 0, live trading on.",
  },
  {
    id: "P6",
    label: "Live Positions Endpoint",
    description: "GET /api/trading/live-positions — positions endpoint is reachable.",
  },
  {
    id: "P7",
    label: "QuickStart Disable",
    description: "POST /api/trade-engine/quick-start — clean teardown to leave the system idle.",
  },
]

const STEP_TIMEOUT_MS = 25_000
const PROGRESSION_POLL_TIMEOUT_MS = 30_000
const PROGRESSION_POLL_INTERVAL_MS = 2_000

// ─── helpers ────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

async function jsonFetch(url: string, init?: RequestInit, timeoutMs = STEP_TIMEOUT_MS): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await withTimeout(fetch(url, { cache: "no-store", ...init }), timeoutMs)
  let body: any = null
  try { body = await res.json() } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, body }
}

function fmtMs(ms?: number): string {
  if (ms == null) return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

interface DialogProps {
  /** Render the provided trigger instead of the default icon button. */
  trigger?: React.ReactNode
}

export function EngineProgressionTestDialog({ trigger }: DialogProps) {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState<TestStep[]>(
    () => INITIAL_STEPS.map((s) => ({ ...s, status: "pending" as const })),
  )
  const [logs, setLogs] = useState<TestLog[]>([])
  const [report, setReport] = useState<OverallReport>({
    startedAt: 0, passed: 0, warned: 0, failed: 0, status: "idle",
  })
  const [running, setRunning] = useState(false)
  const logIdRef = useRef(0)
  const cancelledRef = useRef(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log area to the bottom whenever new entries are appended.
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [logs.length])

  // ── primitives ────────────────────────────────────────────────────────
  const pushLog = useCallback((level: TestLog["level"], msg: string) => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, ts: Date.now(), level, msg }])
  }, [])

  const patchStep = useCallback((index: number, patch: Partial<TestStep>) => {
    setSteps((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" })))
    setLogs([])
    setReport({ startedAt: 0, passed: 0, warned: 0, failed: 0, status: "idle" })
    logIdRef.current = 0
    cancelledRef.current = false
  }, [])

  // ── runner ────────────────────────────────────────────────────────────
  const runTest = useCallback(async () => {
    if (running) return
    resetAll()
    setRunning(true)
    const startedAt = Date.now()
    setReport({ startedAt, passed: 0, warned: 0, failed: 0, status: "running" })
    pushLog("info", "Starting 7-phase engine progression test")

    const markStep = async (
      index: number,
      status: StepStatus,
      patch: Partial<TestStep>,
    ) => {
      patchStep(index, { ...patch, status })
      setReport((r) => ({
        ...r,
        passed: r.passed + (status === "pass" ? 1 : 0),
        warned: r.warned + (status === "warn" ? 1 : 0),
        failed: r.failed + (status === "fail" ? 1 : 0),
      }))
    }

    /**
     * Tiny wrapper to run one phase. Captures the elapsed time, propagates
     * errors into the step row, stops the chain on hard failure, and
     * streams one log line per phase.
     */
    const run = async (
      index: number,
      fn: () => Promise<{ status: "pass" | "warn" | "fail"; summary?: string; error?: string; raw?: any }>,
    ): Promise<"pass" | "warn" | "fail"> => {
      if (cancelledRef.current) return "fail"
      const started = Date.now()
      patchStep(index, { status: "running" })
      const stepId = INITIAL_STEPS[index].id
      pushLog("info", `${stepId} ${INITIAL_STEPS[index].label} — running…`)

      try {
        const result = await fn()
        const durationMs = Date.now() - started
        await markStep(index, result.status, {
          durationMs,
          summary: result.summary,
          error: result.error,
          raw: result.raw,
        })
        pushLog(
          result.status === "pass" ? "ok" : result.status === "warn" ? "warn" : "err",
          `${stepId} ${result.status.toUpperCase()} in ${fmtMs(durationMs)}${result.summary ? ` — ${result.summary}` : ""}`,
        )
        return result.status
      } catch (err) {
        const durationMs = Date.now() - started
        const message = err instanceof Error ? err.message : String(err)
        await markStep(index, "fail", { durationMs, error: message })
        pushLog("err", `${stepId} FAIL in ${fmtMs(durationMs)} — ${message}`)
        return "fail"
      }
    }

    // ── P1: health ───────────────────────────────────────────────────
    const p1 = await run(0, async () => {
      const r = await jsonFetch("/api/health")
      if (!r.ok) return { status: "fail", error: `HTTP ${r.status}`, raw: r.body }
      return { status: "pass", summary: `OK (HTTP ${r.status})`, raw: r.body }
    })
    if (p1 === "fail") return finish()

    // ── P2: preflight ────────────────────────────────────────────────
    await run(1, async () => {
      const r = await jsonFetch("/api/trade-engine/quick-start/ready")
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}`, raw: r.body }
      const ready = Boolean(r.body?.ready)
      return {
        status: ready ? "pass" : "warn",
        summary: ready ? "Preconditions OK" : `Not ready: ${r.body?.reason || "unknown"}`,
        raw: r.body,
      }
    })

    // ── P3: enable with 1 symbol ─────────────────────────────────────
    const p3 = await run(2, async () => {
      const r = await jsonFetch(
        "/api/trade-engine/quick-start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "enable", symbols: 1 }),
        },
        STEP_TIMEOUT_MS,
      )
      if (!r.ok || !r.body?.success) {
        return {
          status: "fail",
          error: r.body?.error || `HTTP ${r.status}`,
          raw: r.body,
        }
      }
      const symbols = Array.isArray(r.body?.symbols) ? r.body.symbols : []
      const symbolSummary =
        symbols.length > 0
          ? `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}: ${symbols.slice(0, 3).join(", ")}`
          : "no symbols reported"
      return {
        status: symbols.length === 1 ? "pass" : "warn",
        summary: `${r.body?.connectionId || "—"} · ${symbolSummary}`,
        raw: r.body,
      }
    })
    if (p3 === "fail") return finish()

    // ── P4: poll progression ─────────────────────────────────────────
    await run(3, async () => {
      const pollStart = Date.now()
      let lastSnapshot: any = null
      let running = false
      while (Date.now() - pollStart < PROGRESSION_POLL_TIMEOUT_MS) {
        if (cancelledRef.current) throw new Error("cancelled")
        const r = await jsonFetch("/api/trade-engine/progression")
        lastSnapshot = r.body
        if (r.ok && r.body?.success && (r.body.runningEngines || 0) > 0) {
          running = true
          break
        }
        await new Promise((res) => setTimeout(res, PROGRESSION_POLL_INTERVAL_MS))
      }
      if (!running) {
        return {
          status: "warn",
          summary: `no running engines after ${(PROGRESSION_POLL_TIMEOUT_MS / 1000).toFixed(0)}s`,
          raw: lastSnapshot,
        }
      }
      const conns = (lastSnapshot?.connections || []) as any[]
      const active = conns.find((c) => c.isEngineRunning) || conns[0]
      return {
        status: "pass",
        summary: `running (${active?.connectionId || "—"} · ${active?.engineState || "active"})`,
        raw: lastSnapshot,
      }
    })

    // ── P5: verify engine ────────────────────────────────────────────
    await run(4, async () => {
      const r = await jsonFetch("/api/system/verify-engine")
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}`, raw: r.body }
      const v = r.body || {}
      const coordinatorRunning = Boolean(v.coordinatorRunning ?? v.coordinator?.running)
      const engineRunning = Boolean(v.engineRunning ?? v.engine?.running)
      const prehistoricDone = Boolean(
        v.prehistoric?.complete ??
        (Number(v.prehistoric?.cyclesCompleted ?? v.prehistoricCyclesCompleted ?? 0) > 0),
      )
      const indCycles = Number(v.indication?.cycles ?? v.indicationCycles ?? 0) || 0
      const stratCycles = Number(v.strategy?.cycles ?? v.strategyCycles ?? 0) || 0
      const realtimeCycles = Number(v.realtime?.cycles ?? v.realtimeCycles ?? 0) || 0

      const checks: string[] = []
      const warnings: string[] = []
      if (coordinatorRunning) checks.push("coordinator ✓"); else warnings.push("coordinator ✗")
      if (engineRunning)      checks.push("engine ✓");       else warnings.push("engine ✗")
      if (prehistoricDone)    checks.push("prehistoric ✓");  else warnings.push("prehistoric pending")
      if (indCycles > 0)      checks.push(`ind:${indCycles}`); else warnings.push("ind:0")
      if (stratCycles > 0)    checks.push(`strat:${stratCycles}`); else warnings.push("strat:0")
      if (realtimeCycles > 0) checks.push(`rt:${realtimeCycles}`); else warnings.push("rt:0")

      const ok =
        coordinatorRunning && engineRunning && prehistoricDone &&
        indCycles > 0 && stratCycles > 0 && realtimeCycles > 0

      return {
        status: ok ? "pass" : warnings.length >= 3 ? "fail" : "warn",
        summary: ok
          ? checks.join(" · ")
          : `${checks.join(" · ")}${warnings.length ? ` · issues: ${warnings.join(", ")}` : ""}`,
        raw: v,
      }
    })

    // ── P6: live-positions reachable ─────────────────────────────────
    await run(5, async () => {
      const r = await jsonFetch("/api/trading/live-positions")
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}`, raw: r.body }
      const positions = Array.isArray(r.body?.positions)
        ? r.body.positions
        : Array.isArray(r.body)
          ? r.body
          : []
      return {
        status: "pass",
        summary: `endpoint healthy (${positions.length} live position${positions.length === 1 ? "" : "s"})`,
        raw: r.body,
      }
    })

    // ── P7: disable ──────────────────────────────────────────────────
    await run(6, async () => {
      const r = await jsonFetch(
        "/api/trade-engine/quick-start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "disable" }),
        },
      )
      if (!r.ok) return { status: "warn", summary: `HTTP ${r.status}`, raw: r.body }
      return {
        status: "pass",
        summary: r.body?.message || "disabled",
        raw: r.body,
      }
    })

    finish()

    function finish() {
      setReport((prev) => {
        const finishedAt = Date.now()
        const failedGate = prev.failed > 0
        const warnGate = prev.warned > 0
        return {
          ...prev,
          finishedAt,
          status: failedGate
            ? prev.passed > 0
              ? "partial"
              : "fail"
            : warnGate
              ? "partial"
              : "pass",
        }
      })
      setRunning(false)
      pushLog("info", "Test complete")
    }
  }, [patchStep, pushLog, resetAll, running])

  // ── derived ───────────────────────────────────────────────────────────
  const completedCount = useMemo(
    () => steps.filter((s) => s.status !== "pending" && s.status !== "running").length,
    [steps],
  )
  const progressPct = Math.round((completedCount / steps.length) * 100)

  // Stop the runner if the dialog closes mid-flight so it doesn't keep
  // polling /progression in the background.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && running) {
      cancelledRef.current = true
      setRunning(false)
      pushLog("warn", "Test cancelled (dialog closed)")
    }
    setOpen(next)
  }, [running, pushLog])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2">
            <FlaskConical className="w-3 h-3" />
            Test
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="w-4 h-4" />
            Engine Progression Test
          </DialogTitle>
          <DialogDescription className="text-xs">
            Runs the canonical 7-phase quick-start → prehistoric → live progression test
            against one auto-picked top-volatile symbol, then cleanly disables the connection.
          </DialogDescription>
        </DialogHeader>

        {/* Progress bar + report badges */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ReportBadge report={report} />
              {report.status !== "idle" && (
                <>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    pass {report.passed} · warn {report.warned} · fail {report.failed}
                  </Badge>
                  {report.finishedAt && (
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {fmtMs(report.finishedAt - report.startedAt)}
                    </Badge>
                  )}
                </>
              )}
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-1.5" />
        </div>

        <Separator />

        {/* Steps */}
        <ScrollArea className="flex-1 min-h-0 pr-3">
          <div className="space-y-2">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}

            {/* Live log tail */}
            {logs.length > 0 && (
              <Card className="p-3 bg-muted/40 border-muted">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground mb-1.5">
                  <Activity className="w-3 h-3" />
                  Live Log
                </div>
                <div className="font-mono text-[10.5px] leading-relaxed space-y-0.5 max-h-48 overflow-auto">
                  {logs.map((l) => (
                    <div
                      key={l.id}
                      className={
                        l.level === "ok"    ? "text-emerald-600 dark:text-emerald-400"
                      : l.level === "warn"  ? "text-amber-600  dark:text-amber-400"
                      : l.level === "err"   ? "text-red-600    dark:text-red-400"
                                             : "text-foreground/70"
                      }
                    >
                      <span className="text-muted-foreground mr-1.5 tabular-nums">
                        {new Date(l.ts).toLocaleTimeString(undefined, { hour12: false })}
                      </span>
                      {l.msg}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </Card>
            )}
          </div>
        </ScrollArea>

        <Separator />

        {/* Controls */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-[11px] text-muted-foreground">
            Enables quick-start with one symbol, verifies progression, disables on completion.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={resetAll}
              disabled={running}
              className="h-7 text-xs px-2 gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={runTest}
              disabled={running}
              className="h-7 text-xs px-3 gap-1"
            >
              {running
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Play className="w-3 h-3" />
              }
              {running ? "Running…" : report.status === "idle" ? "Run Test" : "Re-run"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Standalone trigger button (convenience export) ─────────────────────────

interface ButtonProps {
  /** Size variant — `sm` for dashboard row placements, `header` for the
   * slightly larger header-area treatment. */
  variant?: "sm" | "header"
  /** Optional override class on the trigger. */
  className?: string
}

/**
 * Default-styled "Run Engine Test" button that opens the progression test
 * dialog. Use this component to drop the feature anywhere in the UI.
 */
export function EngineProgressionTestButton({ variant = "sm", className }: ButtonProps) {
  const trigger =
    variant === "header" ? (
      <Button
        size="sm"
        variant="outline"
        className={`h-8 gap-1.5 text-xs px-2.5 border-primary/30 bg-primary/5 hover:bg-primary/10 text-primary ${className ?? ""}`}
      >
        <FlaskConical className="w-3.5 h-3.5" />
        Run Engine Test
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className={`h-7 gap-1 text-[11px] px-2 ${className ?? ""}`}
      >
        <FlaskConical className="w-3 h-3" />
        Engine Test
      </Button>
    )

  return <EngineProgressionTestDialog trigger={trigger} />
}

// ─── internal bits ──────────────────────────────────────────────────────────

function StepRow({ step }: { step: TestStep }) {
  const tone =
    step.status === "pass"    ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/10"
  : step.status === "warn"    ? "border-amber-200   bg-amber-50/60   dark:border-amber-900/40   dark:bg-amber-950/10"
  : step.status === "fail"    ? "border-red-200     bg-red-50/50     dark:border-red-900/40     dark:bg-red-950/10"
  : step.status === "running" ? "border-primary/40  bg-primary/5"
                              : ""

  return (
    <Card className={`p-3 border transition-colors ${tone}`}>
      <div className="flex items-start gap-3">
        <StatusIcon status={step.status} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[10px] font-mono font-semibold text-muted-foreground">{step.id}</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate">{step.label}</span>
            </div>
            {step.durationMs != null && (
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {fmtMs(step.durationMs)}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{step.description}</p>

          {step.summary && (
            <p className="text-[11px] font-mono mt-1.5 text-foreground/80">
              {step.summary}
            </p>
          )}
          {step.error && (
            <p className="text-[11px] font-mono mt-1.5 text-red-600 dark:text-red-400 break-all">
              {step.error}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "running": return <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0 mt-0.5" />
    case "pass":    return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
    case "warn":    return <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
    case "fail":    return <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
    default:        return <Clock className="w-4 h-4 text-muted-foreground/50 shrink-0 mt-0.5" />
  }
}

function ReportBadge({ report }: { report: OverallReport }) {
  const base = "text-[10px] font-semibold px-1.5"
  switch (report.status) {
    case "running": return <Badge className={`${base} bg-primary text-primary-foreground`}>RUNNING</Badge>
    case "pass":    return <Badge className={`${base} bg-emerald-600 text-white hover:bg-emerald-600`}>PASS</Badge>
    case "partial": return <Badge className={`${base} bg-amber-500  text-white hover:bg-amber-500`}>PARTIAL</Badge>
    case "fail":    return <Badge className={`${base} bg-red-600    text-white hover:bg-red-600`}>FAIL</Badge>
    default:        return <Badge variant="outline" className={base}>IDLE</Badge>
  }
}
