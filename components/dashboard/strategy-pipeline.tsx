"use client"

import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  Layers,
  Settings2,
  Workflow,
  Zap,
  ArrowRight,
} from "lucide-react"

interface StrategyTracking {
  base: {
    setsActivelyProcessing: number
    setsWithOpenPositions: number
    setsProgressing: number
    setsTotal: number
    setsCurrent: number
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    pseudoPositionLimit: number
    variantCountMin: number
    variantCountMax: number
    variantCountStep: number
  }
  main: {
    evaluatedFromBase: number
    setsCreated: number
    setsTotal: number
    setsWithOpenPositions: number
    setsProgressing: number
    avgProfitFactor: number
    avgDrawdownTime: number
    minProfitFactor: number
    maxDrawdownTime: number
    variants: {
      default: number
      trailing: number
      block: number
      dca: number
      pause: number
    }
  }
  real: {
    setsCurrent: number
    setsTotal: number
    setsWithOpenPositions: number
    setsProgressing: number
    evaluatedFromMain: number
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    minProfitFactor: number
    maxDrawdownTime: number
    axisAccumulation: {
      prev: Record<string, number>
      last: Record<string, number>
      cont: Record<string, number>
      pause: Record<string, number>
    }
    variantsAccumulated: {
      default: number
      trailing: number
      block: number
      dca: number
      pause: number
    }
  }
  live: {
    setsActive: number
    setsWithOpenPositions: number
    setsProgressing: number
    setsTotal: number
    avgProfitFactor: number
    cap: number
  }
}

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then((r) => r.json())

export function StrategyPipeline({ connectionId }: { connectionId: string }) {
  const { data, isLoading, error } = useSWR<StrategyTracking>(
    `/api/connections/progression/${connectionId}/tracking/strategies`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  )

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading strategy pipeline...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load strategy tracking. {error?.message}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── PIPELINE CASCADE ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Strategy Pipeline Cascade</CardTitle>
          <p className="text-xs text-muted-foreground">
            Base (independent) → Main (variants per Base) → Real (accumulation) → Live (top 500)
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <StageBadge label="Base" count={data.base.setsCurrent} total={data.base.setsTotal} />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge label="Main" count={data.main.setsCreated} total={data.main.setsTotal} />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge
              label="Real"
              count={data.real.setsCurrent}
              total={data.real.setsTotal}
              accent="primary"
            />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge
              label="Live"
              count={data.live.setsActive}
              total={data.live.cap}
              accent="success"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── BASE STAGE ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4" />
            Base — Independent Sets
            <Badge variant="destructive" className="ml-auto font-mono text-[10px]">
              LIMIT-GATED
            </Badge>
            <Badge variant="secondary" className="font-mono">
              {data.base.setsActivelyProcessing} processing
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Each Base Set has its OWN pseudo-positions (independent), one per
            (indication_type × direction). Position Limits + per-Direction caps
            apply HERE only (max 1 long + 1 short).
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.base.setsCurrent} />
            <Metric label="Sets (total)" value={data.base.setsTotal} />
            <Metric label="Avg PF" value={data.base.avgProfitFactor.toFixed(3)} />
            <Metric label="Avg Pos / Set" value={data.base.avgPosPerSet.toFixed(1)} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Active Sets w/ Open Positions"
              value={data.base.setsWithOpenPositions}
              accent="success"
              hint="Sets currently holding ≥ 1 open pseudo-position"
            />
            <Metric
              label="Progressing Sets"
              value={data.base.setsProgressing}
              accent="primary"
              hint="Sets in active calculation this cycle"
            />
          </div>
          <div className="mt-3 rounded-md border bg-muted/30 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Pseudo-position limit per Base Set
            </div>
            <div className="font-mono text-lg tabular-nums">
              {data.base.pseudoPositionLimit}
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Variant count slider: {data.base.variantCountMin}–{data.base.variantCountMax}{" "}
              (step {data.base.variantCountStep})
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── MAIN STAGE ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Workflow className="h-4 w-4" />
            Main — Variant Sets per Base
            <Badge variant="outline" className="ml-auto font-mono text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
              FREE CALCULATION
            </Badge>
            <Badge variant="secondary" className="font-mono">
              {data.main.evaluatedFromBase} evaluated
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Variant Sets <strong>CLONE</strong> Base&apos;s pseudo-positions and
            strategically adjust them into new relative Sets — they do NOT open
            new exchange positions. Block + DCA clone Base&apos;s COMPLETE
            positions through different config gates. NO Position Limits /
            Direction caps — calculated freely. Filter: PF ≥{" "}
            {data.main.minProfitFactor.toFixed(2)}, DDT ≤{" "}
            {data.main.maxDrawdownTime}m
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.main.setsCreated} />
            <Metric label="Sets (total)" value={data.main.setsTotal} />
            <Metric label="Avg PF" value={data.main.avgProfitFactor.toFixed(3)} />
            <Metric
              label="Avg DDT (min)"
              value={Math.round(data.main.avgDrawdownTime)}
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Active Sets w/ Cloned Positions"
              value={data.main.setsWithOpenPositions}
              accent="success"
              hint="Cloned from Base — Sets actually holding adjusted positions"
            />
            <Metric
              label="Progressing Sets"
              value={data.main.setsProgressing}
              accent="primary"
              hint="Sets in active calculation this cycle"
            />
          </div>
          <div className="mt-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Variants per Base Set (cloned & adjusted)
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <VariantBox label="Default" value={data.main.variants.default} />
              <VariantBox label="Trailing" value={data.main.variants.trailing} />
              <VariantBox
                label="Block"
                value={data.main.variants.block}
                hint="Clones Base positions"
              />
              <VariantBox
                label="DCA"
                value={data.main.variants.dca}
                hint="Clones Base positions"
              />
              <VariantBox label="Pause" value={data.main.variants.pause} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── REAL STAGE — ACCUMULATION ───────────────────────────────── */}
      <Card className="border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Settings2 className="h-4 w-4 text-primary" />
            Real — Position-Counts Accumulation
            <Badge variant="outline" className="ml-auto font-mono text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
              FREE CALCULATION
            </Badge>
            <Badge variant="default" className="font-mono">
              {data.real.setsTotal} accumulated
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Multi-axis variant accumulation happens HERE. Real <strong>CLONES
            </strong> Main&apos;s already-cloned positions and strategically
            adjusts them along the position-count axis (prev / last / cont /
            pause). NO new exchange positions opened, NO Position Limits /
            Direction caps. Filter: PF ≥{" "}
            {data.real.minProfitFactor.toFixed(2)}, DDT ≤{" "}
            {data.real.maxDrawdownTime}m
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.real.setsCurrent} />
            <Metric label="Sets (cumulative)" value={data.real.setsTotal} />
            <Metric label="Avg PF" value={data.real.avgProfitFactor.toFixed(3)} />
            <Metric label="Avg Pos / Set" value={data.real.avgPosPerSet.toFixed(1)} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Active Sets w/ Cloned Positions"
              value={data.real.setsWithOpenPositions}
              accent="success"
              hint="Cloned from Main — Sets holding axis-adjusted positions"
            />
            <Metric
              label="Progressing Sets"
              value={data.real.setsProgressing}
              accent="primary"
              hint="Sets in active calculation this cycle"
            />
          </div>

          {/* Position-count axis accumulation */}
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Position-Count Axis Accumulation (cumulative across cycles)
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <AxisCard
                label="Previous (1–12)"
                values={data.real.axisAccumulation.prev}
              />
              <AxisCard
                label="Last (1–4)"
                values={data.real.axisAccumulation.last}
              />
              <AxisCard
                label="Continuous (1–8)"
                values={data.real.axisAccumulation.cont}
              />
              <AxisCard
                label="Pause (1–8)"
                values={data.real.axisAccumulation.pause}
              />
            </div>
          </div>

          {/* Variant accumulation */}
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Variants Accumulated at Real
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <VariantBox
                label="Default"
                value={data.real.variantsAccumulated.default}
              />
              <VariantBox
                label="Trailing"
                value={data.real.variantsAccumulated.trailing}
              />
              <VariantBox
                label="Block"
                value={data.real.variantsAccumulated.block}
              />
              <VariantBox
                label="DCA"
                value={data.real.variantsAccumulated.dca}
              />
              <VariantBox
                label="Pause"
                value={data.real.variantsAccumulated.pause}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── LIVE STAGE ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Zap className="h-4 w-4" />
            Live — Top {data.live.cap} on Exchange
            <Badge variant="default" className="ml-auto font-mono">
              {data.live.setsActive} active
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Best Sets ranked by avgPF, one pseudo-position per Set on exchange
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Active now" value={data.live.setsActive} />
            <Metric label="Cap" value={data.live.cap} />
            <Metric label="Avg PF" value={data.live.avgProfitFactor.toFixed(3)} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Active Sets w/ Open Positions"
              value={data.live.setsWithOpenPositions}
              accent="success"
              hint="Sets with executed orders on the exchange"
            />
            <Metric
              label="Progressing Sets"
              value={data.live.setsProgressing}
              accent="primary"
              hint="Sets being ranked & capped for live execution"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────

function StageBadge({
  label,
  count,
  total,
  accent,
}: {
  label: string
  count: number
  total: number
  accent?: "primary" | "success"
}) {
  const ringClass =
    accent === "primary"
      ? "border-primary/40 bg-primary/5"
      : accent === "success"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-border bg-card"
  return (
    <div className={`flex flex-1 flex-col rounded-md border px-3 py-2 ${ringClass}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xl tabular-nums">{count}</span>
        <span className="text-xs text-muted-foreground">/ {total} total</span>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  accent,
  hint,
}: {
  label: string
  value: number | string
  accent?: "primary" | "success"
  hint?: string
}) {
  const ringClass =
    accent === "primary"
      ? "border-primary/40 bg-primary/5"
      : accent === "success"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-border bg-card"
  return (
    <div className={`rounded-md border p-2 ${ringClass}`} title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function VariantBox({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-base tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function AxisCard({
  label,
  values,
}: {
  label: string
  values: Record<string, number>
}) {
  const entries = Object.entries(values).sort(([a], [b]) => Number(a) - Number(b))
  const total = entries.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums">{total}</span>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1">
        {entries.length === 0 ? (
          <span className="col-span-4 text-[10px] text-muted-foreground">
            no data
          </span>
        ) : (
          entries.map(([w, v]) => (
            <div
              key={w}
              className="flex items-center justify-between rounded bg-muted/50 px-1 text-[10px]"
              title={`window=${w} → ${v}`}
            >
              <span className="text-muted-foreground">{w}</span>
              <span className="font-mono tabular-nums">{v}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
