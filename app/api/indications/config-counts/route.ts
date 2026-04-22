import { NextResponse } from "next/server"
import { PositionCalculator } from "@/lib/position-calculator"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * GET /api/indications/config-counts
 *
 * Returns the number of POSSIBLE Independent Sets per Main indication type
 * (direction / move / active / optimal / auto), together with the calc
 * parameters that produced each count (ranges, steps, time variations,
 * drawdown thresholds, etc.).
 *
 * These are *enumeration counts* — the number of distinct configurations the
 * engine will spawn per symbol. Each configuration becomes ONE Independent
 * Set with its own 250-slot position database (tunable). The counts are
 * purely derived from the current settings, so they do NOT reflect live
 * runtime activity — they answer "how many Sets COULD the engine create?"
 *
 * Settings are loaded from `settings:global` in Redis (indication range
 * min / max / step, takeProfitRangeDivisor, optimal base position limit,
 * auto-indication drawdown & time windows), falling back to the defaults
 * baked into PositionCalculator when unset.
 */
export async function GET() {
  try {
    await initRedis()

    // Pull the subset of settings that feeds the calculator.
    // Missing values fall back to the PositionCalculator defaults.
    let settings: any = null
    let optimalBaseCap = 250
    let autoDrawdownHours = 1
    let autoTimeWindows = 3
    try {
      const client = getRedisClient()
      const raw = await client.hgetall("settings:global")
      if (raw && Object.keys(raw).length > 0) {
        const n = (k: string, d: number) => {
          const v = Number(raw[k])
          return Number.isFinite(v) && v > 0 ? v : d
        }
        settings = {
          indicationRangeMin:      n("indication_range_min", 3),
          indicationRangeMax:      n("indication_range_max", 30),
          indicationRangeStep:     n("indication_range_step", 1),
          takeProfitRangeDivisor:  n("takeprofit_range_divisor", 3),
        }
        optimalBaseCap       = n("optimal_base_positions_limit", 250)
        autoDrawdownHours    = n("auto_drawdown_hours", 1)
        autoTimeWindows      = n("auto_time_windows", 3)
      }
    } catch {
      /* settings optional — fall back to defaults */
    }

    const calc = new PositionCalculator(settings ?? undefined)
    // We pass a dummy symbol — the calculator's per-type outputs are
    // symbol-independent (they depend only on settings).
    const analysis = calc.calculateSymbolPositions("__DERIVED__")

    // Extract the raw per-type calc internals so the UI can render a
    // formula row (ranges × price_ratios × variations, etc.). The
    // calculator already stores these in its `description` strings, but
    // we rebuild structured objects here for the UI.
    //
    // ── Helper to rebuild the parameter object without re-running the
    // full enumeration (keeps this endpoint cheap enough to call every
    // 30s from the dashboard without a Redis round-trip per symbol).
    const indicationMin   = settings?.indicationRangeMin ?? 3
    const indicationMax   = settings?.indicationRangeMax ?? 30
    const indicationStep  = settings?.indicationRangeStep ?? 1
    const tpDivisor       = settings?.takeProfitRangeDivisor ?? 3
    const rawRangeCount   = Math.max(0, Math.floor((indicationMax - indicationMin) / indicationStep) + 1)
    // Ranges pruned by the take-profit coordination filter — count
    // only those that survive the `minTakeProfit >= 1 && <= range/2` gate.
    const validRangeCount = (() => {
      let c = 0
      for (let r = indicationMin; r <= indicationMax; r += indicationStep) {
        const minTp = Math.max(1, Math.floor(r / tpDivisor))
        if (minTp >= 1 && minTp <= r / 2) c++
      }
      return c
    })()

    const directionCat = analysis.categories.find((c) => c.subcategory === "Direction Change")
    const moveCat      = analysis.categories.find((c) => c.subcategory === "Move Detection")
    const activeCat    = analysis.categories.find((c) => c.subcategory === "Active Trading")

    // Optimal & Auto are not emitted by the PositionCalculator (they are
    // runtime-adaptive rather than purely combinatorial), so we compute
    // representative counts directly from their settings.
    //
    // Optimal: 1 Set per configurable "step" across the range, gated by
    //          drawdown & performance filters at runtime. Capacity = 250
    //          positions per Set by default.
    // Auto:    1 Set per (drawdown window × time window × direction),
    //          where direction ∈ {long, short} and the windows come from
    //          the auto-indication engine's multi-timeframe analysis
    //          (8h / 1h / 30min / 1-20min).
    const optimalConfigs = validRangeCount * 2   // 2 variations (tight / wide drawdown)
    const autoConfigs    = Math.max(1, autoTimeWindows) * 2 * Math.max(1, Math.round(autoDrawdownHours)) // 2 dirs × N timeframes × drawdown-tiers

    const totalConfigs =
      (directionCat?.configurations ?? 0) +
      (moveCat?.configurations ?? 0) +
      (activeCat?.configurations ?? 0) +
      optimalConfigs +
      autoConfigs

    return NextResponse.json({
      // Top-level summary for at-a-glance display
      totalPossibleSets: totalConfigs,
      perSetDbCapacity: optimalBaseCap,             // 250 default — per-Set position history length
      maxStorablePositions: totalConfigs * optimalBaseCap,
      settings: {
        indicationRangeMin:     indicationMin,
        indicationRangeMax:     indicationMax,
        indicationRangeStep:    indicationStep,
        takeProfitRangeDivisor: tpDivisor,
        rawRangeCount,
        validRangeCount,
        optimalBasePositionsLimit: optimalBaseCap,
        autoDrawdownHours,
        autoTimeWindows,
      },
      // Per-type breakdown — this is what the dashboard renders as 5 rows.
      // Each row shows the RESULT and the FORMULA so the user understands
      // where the number came from (and how changing settings affects it).
      types: [
        {
          type: "direction",
          label: "Direction Change",
          possibleSets: directionCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 price ratios × 6 time variations`,
          params: {
            validRanges:    validRangeCount,
            priceRatios:    5,         // [0.2, 0.4, 0.6, 0.8, 1.0]
            timeVariations: 6,         // 6 time/direction variations
            drawdownGate:   "tp ≥ 1 and ≤ range/2",
          },
          description: directionCat?.description ?? "",
        },
        {
          type: "move",
          label: "Move Detection",
          possibleSets: moveCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 price ratios × 6 time variations`,
          params: {
            validRanges:    validRangeCount,
            priceRatios:    5,
            timeVariations: 6,
            drawdownGate:   "tp ≥ 1 and ≤ range/2",
          },
          description: moveCat?.description ?? "",
        },
        {
          type: "active",
          label: "Active Trading",
          possibleSets: activeCat?.configurations ?? 0,
          formula: `${validRangeCount} valid ranges × 5 active thresholds (1.0–3.0%) × 2 time variations`,
          params: {
            validRanges:    validRangeCount,
            thresholds:     5,         // [1.0, 1.5, 2.0, 2.5, 3.0]
            timeVariations: 2,
            drawdownGate:   "active-volatility ≥ threshold",
          },
          description: activeCat?.description ?? "",
        },
        {
          type: "optimal",
          label: "Optimal (adaptive)",
          possibleSets: optimalConfigs,
          formula: `${validRangeCount} valid ranges × 2 drawdown tiers`,
          params: {
            validRanges:      validRangeCount,
            drawdownTiers:    2,
            dbCapacity:       optimalBaseCap,
            drawdownGate:     "PF ≥ 1.2 & drawdown ≤ tier",
          },
          description: "Adaptive Sets gated by runtime PF + drawdown thresholds; each Set keeps up to the configured DB capacity in history.",
        },
        {
          type: "auto",
          label: "Auto (multi-timeframe)",
          possibleSets: autoConfigs,
          formula: `${autoTimeWindows} timeframes × 2 directions × ${Math.max(1, Math.round(autoDrawdownHours))} drawdown windows`,
          params: {
            timeWindows:      autoTimeWindows,   // 8h / 1h / 30min / 1-20min
            directions:       2,                 // long / short
            drawdownHours:    autoDrawdownHours,
            drawdownGate:     "directionAlignment + optimalSituation",
          },
          description: "Multi-timeframe adaptive Sets; the auto engine uses 8h/1h/30min/1–20min windows with alignment and drawdown gates.",
        },
      ],
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] /api/indications/config-counts error:", error)
    return NextResponse.json(
      { error: "Failed to compute indication config counts" },
      { status: 500 },
    )
  }
}
