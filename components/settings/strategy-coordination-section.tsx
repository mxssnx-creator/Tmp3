"use client"

/**
 * Strategy Coordination Settings Section
 *
 * Lives inside the Strategies tab of the Connection Settings dialog and
 * gives the operator a single, organised surface for the *Position-Count
 * coordination* layer added on top of base strategy evaluation. It groups
 * settings that previously lived only as code constants in
 * `lib/strategy-coordinator.ts` into a per-connection, persisted form.
 *
 * Two distinct sub-sections:
 *
 * 1. **Position-Count Axes** — the four step-1 axes that gate
 *    Main-stage related Set creation. Each axis has:
 *      • an enable toggle (the axis can be disabled entirely)
 *      • a max-window slider (1..N; N defaults to spec maxima
 *        12 / 4 / 8 / 8 for prev / last / cont / pause respectively)
 *
 * 2. **Variant Profiles** — the *categorical* variants evaluated on top
 *    of the axes:
 *      • Default       (always on; not toggleable)
 *      • Trailing      (gated on lastWins ≥ 2 + no continuous)
 *      • Block         (gated on continuousCount 1..2; INDEPENDENT of
 *                       Pos-count axes per the user's spec)
 *      • DCA           (gated on prevLosses ≥ 1; INDEPENDENT of axes)
 *      • Pause         (gated on lastPosCount ≥ 1)
 *
 * Block + DCA are flagged "Independent" in the UI so the operator
 * understands they don't fold into the axis windows above.
 *
 * The component is *purely controlled* — it accepts the current
 * `CoordinationSettings` value plus an `onChange` callback. Persistence
 * is the parent dialog's responsibility; the parent already round-trips
 * settings through the connection-settings API.
 */

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export interface CoordinationSettings {
  // ── Position-Count axes ─────────────────────────────────────────────
  axes: {
    prev:  { enabled: boolean; maxWindow: number }
    last:  { enabled: boolean; maxWindow: number }
    cont:  { enabled: boolean; maxWindow: number }
    pause: { enabled: boolean; maxWindow: number }
  }
  // ── Categorical variant profiles ────────────────────────────────────
  variants: {
    trailing: boolean
    block:    boolean
    dca:      boolean
    pause:    boolean
  }
}

/** Spec-aligned defaults — match the constants in strategy-coordinator.ts. */
export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  axes: {
    prev:  { enabled: true,  maxWindow: 12 },
    last:  { enabled: true,  maxWindow: 4  },
    cont:  { enabled: true,  maxWindow: 8  },
    pause: { enabled: true,  maxWindow: 8  },
  },
  variants: {
    trailing: true,
    block:    true,
    dca:      true,
    pause:    true,
  },
}

interface StrategyCoordinationSectionProps {
  value: CoordinationSettings
  onChange: (next: CoordinationSettings) => void
}

// Axis metadata — labels, spec ceilings, and short descriptions. Driven
// off this map so the JSX below stays compact and DRY.
const AXES: Array<{
  key: keyof CoordinationSettings["axes"]
  label: string
  range: string
  ceiling: number
  description: string
}> = [
  {
    key: "prev",
    label: "Previous",
    range: "1–12",
    ceiling: 12,
    description:
      "Closed-position lookback bucket. Step-1 windows control how far back the coordinator reads when validating Sets.",
  },
  {
    key: "last",
    label: "Last (of previous)",
    range: "1–4",
    ceiling: 4,
    description:
      "Magnitude of the last-N wins / losses dimension. Drives the trailing & pause variants' aggressiveness.",
  },
  {
    key: "cont",
    label: "Continuous",
    range: "1–8",
    ceiling: 8,
    description:
      "Open continuous positions. Larger windows allow longer add-on stacks before the gate closes.",
  },
  {
    key: "pause",
    label: "Pause",
    range: "1–8",
    ceiling: 8,
    description:
      "Last-N validation lookback. Wider windows produce more conservative entry configurations.",
  },
]

const VARIANTS: Array<{
  key: keyof CoordinationSettings["variants"]
  label: string
  badge: string
  axisIndependent: boolean
  description: string
}> = [
  {
    key: "trailing",
    label: "Trailing",
    badge: "Recent winners",
    axisIndependent: false,
    description:
      "Scale-in profile for runs of recent winners with no open position. Higher leverage, longer DDT bias.",
  },
  {
    key: "block",
    label: "Block",
    badge: "Independent · Add-on",
    axisIndependent: true,
    description:
      "Continuation profile that adds to an existing open position (continuousCount 1..2). Evaluated INDEPENDENTLY of position-count axes.",
  },
  {
    key: "dca",
    label: "DCA",
    badge: "Independent · Recovery",
    axisIndependent: true,
    description:
      "Recovery profile after recent losses (prevLosses ≥ 1). Reduce / close states with conservative sizing. Evaluated INDEPENDENTLY of position-count axes.",
  },
  {
    key: "pause",
    label: "Pause",
    badge: "Throttle",
    axisIndependent: false,
    description:
      "Throttles entry size when the last-N closed positions contain losers. 8 sub-configs ramp size DOWN as the lookback widens.",
  },
]

export function StrategyCoordinationSection({
  value,
  onChange,
}: StrategyCoordinationSectionProps) {
  // ── Helpers ─ partial setters for axes & variants. Keeping the
  // mutator surface inline (rather than reducer / context) keeps the
  // component drop-in for the existing dialog's controlled-state
  // pattern.
  const setAxis = (
    key: keyof CoordinationSettings["axes"],
    patch: Partial<{ enabled: boolean; maxWindow: number }>,
  ) => {
    onChange({
      ...value,
      axes: {
        ...value.axes,
        [key]: { ...value.axes[key], ...patch },
      },
    })
  }

  const setVariant = (
    key: keyof CoordinationSettings["variants"],
    enabled: boolean,
  ) => {
    onChange({
      ...value,
      variants: { ...value.variants, [key]: enabled },
    })
  }

  return (
    <div className="space-y-4">
      {/* ── Position-Count Axes card ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Position-Count Axes</CardTitle>
              <CardDescription className="text-xs">
                Step-1 windows that gate Main-stage related Set creation. Each
                validated Base Set fans out into related Sets across these
                axes. Counts surface in the dashboard&apos;s axis strip.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              4 axes
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {AXES.map((axis) => {
            const state = value.axes[axis.key]
            return (
              <div
                key={axis.key}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-semibold capitalize">
                      {axis.label}
                    </Label>
                    <Badge variant="outline" className="text-[10px] tabular-nums">
                      {axis.range}
                    </Badge>
                  </div>
                  <Switch
                    checked={state.enabled}
                    onCheckedChange={(checked) =>
                      setAxis(axis.key, { enabled: checked })
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {axis.description}
                </p>
                <div className="flex items-center gap-3 pt-1">
                  <Label className="text-xs text-muted-foreground min-w-[80px]">
                    Max window
                  </Label>
                  <Slider
                    value={[state.maxWindow]}
                    min={1}
                    max={axis.ceiling}
                    step={1}
                    onValueChange={(v) =>
                      setAxis(axis.key, { maxWindow: v[0] })
                    }
                    disabled={!state.enabled}
                    className="flex-1"
                  />
                  <span className="text-xs font-semibold tabular-nums w-8 text-right">
                    {state.maxWindow}
                  </span>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Variant profiles card ────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Variant Profiles</CardTitle>
              <CardDescription className="text-xs">
                Categorical Set variants evaluated alongside the axes above.
                Block and DCA are evaluated <em>independently</em> of the
                position-count axes per spec.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              4 variants
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {VARIANTS.map((variant) => {
            const enabled = value.variants[variant.key]
            return (
              <div
                key={variant.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label className="text-sm font-semibold capitalize">
                      {variant.label}
                    </Label>
                    <Badge
                      variant={variant.axisIndependent ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {variant.badge}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {variant.description}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    setVariant(variant.key, checked)
                  }
                />
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
