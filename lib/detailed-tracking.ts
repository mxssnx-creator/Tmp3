/**
 * Detailed Tracking Module
 * ────────────────────────────────────────────────────────────────────────
 * Provides authoritative read APIs for the dashboard's "Indications" and
 * "Strategies" detail panels.
 *
 * ARCHITECTURE (canonical, matches lib/strategy-coordinator.ts):
 *
 *   ┌──────────┐
 *   │ INDICATIONS (per type, with pseudo-position limit per Set)       │
 *   │   • direction / move / active / active_advanced / optimal / auto │
 *   │   • each indication Set has its own positions (capped by limit)  │
 *   │   • windowed counts: Last 5 / Last 60 min / Active                │
 *   └─────────────┬─────────────────────────────────────────────────────┘
 *                 │ feeds → strategy-coordinator
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ BASE  — INDEPENDENT Sets (one per indication_type × direction)  │
 *   │   • each Base Set has its OWN pseudo-positions (independent)    │
 *   │   • count ≈ 1,000 across symbols (filter: PF >= 1.0)            │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ promote when avgPF >= 1.2 + DDT <= 24h
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ MAIN  — VARIANT Sets per Base (NO new positions; reuse Base's)  │
 *   │   • Default / Trailing / Block / DCA / Pause                    │
 *   │   • Block + DCA: validate Base's COMPLETE positions via gates   │
 *   │   • Trailing: per-base (start, stop) trailing matrix expansion  │
 *   │   • Pos-count variants are validated here via axisWindows tag   │
 *   │     (prev 1-12 × last 1-4 × cont 1-8 × pause 1-8 = up to 384)   │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ promote when avgPF >= 1.4 + DDT <= 16h
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ REAL  — ACCUMULATION stage (cumulative across cycles)           │
 *   │   • This is where multiplied/dimensional sets ACCUMULATE        │
 *   │   • per-axis variant counts: prev / last / cont / pause         │
 *   │   • per-variant counts: default / block / dca / trailing        │
 *   │   • cumulative entries_count grows across cycles                │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ rank by avgPF, take top 500
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ LIVE  — TOP 500 Sets, one pseudo-position per Set on exchange   │
 *   └─────────────────────────────────────────────────────────────────┘
 */

import { getRedisClient } from "@/lib/redis-db"

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface IndicationTracking {
  // Active right now (the important "asked value")
  active: {
    total: number
    byType: Record<string, number>
  }
  // Evaluated counts over time windows
  evaluatedLast5: {
    total: number
    byType: Record<string, number>
  }
  evaluatedLast60min: {
    total: number
    byType: Record<string, number>
  }
  // Pseudo-position limit per indication Set (settings-driven)
  pseudoPositionLimit: number
  // How many of the indication Sets are currently at limit (capacity-bound)
  setsAtLimit: number
  totalIndicationSets: number
}

export interface StrategyStageTracking {
  base: {
    setsActivelyProcessing: number   // Sets alive this cycle (per-symbol snapshot)
    setsWithOpenPositions: number    // Sets currently holding ≥ 1 open pseudo-position
    setsProgressing: number          // Sets in active calculation this cycle
    setsTotal: number                 // total Base Sets (cumulative)
    setsCurrent: number               // Base Sets in last cycle
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    pseudoPositionLimit: number       // configurable; 25 default
    // Variant configuration (sliders)
    variantCountMin: number           // 10 default
    variantCountMax: number           // 50 default
    variantCountStep: number          // 10 default
  }
  main: {
    // Sets evaluated FROM Base (these became Main candidates)
    evaluatedFromBase: number
    setsCreated: number               // current cycle: variants per qualifying Base
    setsTotal: number                 // cumulative across cycles
    setsWithOpenPositions: number    // CLONED positions from Base — count of Sets actually holding
    setsProgressing: number          // Sets currently in calculation
    avgProfitFactor: number
    avgDrawdownTime: number
    minProfitFactor: number           // gate threshold (e.g. 1.2)
    maxDrawdownTime: number           // gate threshold (e.g. 1440 min)
    // Variant breakdown — Main CLONES Base's positions and strategically
    // adjusts them into new relative Sets (does NOT open new positions).
    variants: {
      default: number
      trailing: number
      block: number                   // clones Base's COMPLETE positions, different config
      dca: number                     // clones Base's COMPLETE positions, recovery config
      pause: number
    }
  }
  real: {
    // ── Accumulation stage ──
    // Multi-dimensional axis expansion accumulates HERE.
    // Real CLONES Main's already-cloned positions and strategically
    // adjusts them across the position-count axis windows.
    setsCurrent: number               // current cycle Real Sets (post filter+sort+cap)
    setsTotal: number                 // cumulative Real Sets across cycles
    setsWithOpenPositions: number    // CLONED positions held — count of Sets with open clones
    setsProgressing: number          // Sets currently in calculation
    evaluatedFromMain: number         // Main Sets evaluated (input to Real)
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    minProfitFactor: number           // 1.4 gate
    maxDrawdownTime: number           // 960 min gate
    // ── Position-count axis accumulation ──
    // prev (1-12) × last (1-4) × cont (1-8) × pause (1-8) = up to 384
    axisAccumulation: {
      prev: Record<string, number>    // window → count of Sets in that window
      last: Record<string, number>
      cont: Record<string, number>
      pause: Record<string, number>
    }
    // Per-variant cumulative counts at Real (post-filter)
    variantsAccumulated: {
      default: number
      trailing: number
      block: number
      dca: number
      pause: number
    }
  }
  live: {
    setsActive: number                // currently on exchange with open positions
    setsWithOpenPositions: number    // alias of setsActive (real exchange orders)
    setsProgressing: number          // Sets being evaluated for live execution
    setsTotal: number                 // best 500 ranked
    avgProfitFactor: number
    cap: number                       // maxLiveSets, default 500
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READ APIS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get indication tracking with windowed counts and active state.
 * Active is the most important "asked value" (not yet expired/closed).
 */
export async function getIndicationTracking(
  connectionId: string,
): Promise<IndicationTracking> {
  const client = getRedisClient()
  const progKey = `progression:${connectionId}`
  const settingsKey = `connection_settings:${connectionId}`

  const [progHash, settingsHash, activeHash] = await Promise.all([
    client.hgetall(progKey).catch(() => ({})),
    client.hgetall(settingsKey).catch(() => ({})),
    client.hgetall(`indications_active:${connectionId}`).catch(() => ({})),
  ])

  const prog = (progHash || {}) as Record<string, string>
  const settings = (settingsHash || {}) as Record<string, string>
  const active = (activeHash || {}) as Record<string, string>

  // Active counts by type
  const types = ["direction", "move", "active", "active_advanced", "optimal", "auto"]
  const byType: Record<string, number> = {}
  let totalActive = 0
  for (const t of types) {
    const v = Number(active[t] || "0")
    byType[t] = v
    totalActive += v
  }

  // Windowed evaluated counts (Last 5, Last 60min)
  // Read from time-windowed counter keys
  const last5Key = `indications_window:${connectionId}:last5`
  const last60Key = `indications_window:${connectionId}:last60min`
  const [w5, w60] = await Promise.all([
    client.hgetall(last5Key).catch(() => ({})),
    client.hgetall(last60Key).catch(() => ({})),
  ])

  const w5Hash = (w5 || {}) as Record<string, string>
  const w60Hash = (w60 || {}) as Record<string, string>

  const last5ByType: Record<string, number> = {}
  const last60ByType: Record<string, number> = {}
  let last5Total = 0
  let last60Total = 0
  for (const t of types) {
    const v5 = Number(w5Hash[t] || "0")
    const v60 = Number(w60Hash[t] || "0")
    last5ByType[t] = v5
    last60ByType[t] = v60
    last5Total += v5
    last60Total += v60
  }

  // Pseudo position limit per indication Set (default 25)
  const pseudoPositionLimit = Number(settings.indicationPseudoPositionLimit || "25")

  // How many indication Sets are currently at their limit
  const setsAtLimit = Number(prog.indication_sets_at_limit || "0")
  const totalIndicationSets = Number(prog.indication_sets_total || prog.indications_count || "0")

  return {
    active: { total: totalActive, byType },
    evaluatedLast5: { total: last5Total, byType: last5ByType },
    evaluatedLast60min: { total: last60Total, byType: last60ByType },
    pseudoPositionLimit,
    setsAtLimit,
    totalIndicationSets,
  }
}

/**
 * Get strategy stage tracking. Reflects the canonical pipeline:
 *   Base (independent) → Main (variants per Base) → Real (accumulation) → Live (top 500)
 */
export async function getStrategyTracking(
  connectionId: string,
): Promise<StrategyStageTracking> {
  const client = getRedisClient()
  const progKey = `progression:${connectionId}`
  const baseDetailKey = `strategy_detail:${connectionId}:base`
  const mainDetailKey = `strategy_detail:${connectionId}:main`
  const realDetailKey = `strategy_detail:${connectionId}:real`
  const settingsKey = `connection_settings:${connectionId}`
  const activeKey = `strategies_active:${connectionId}`

  const [progHash, baseDetail, mainDetail, realDetail, settingsHash, activeHash] =
    await Promise.all([
      client.hgetall(progKey).catch(() => ({})),
      client.hgetall(baseDetailKey).catch(() => ({})),
      client.hgetall(mainDetailKey).catch(() => ({})),
      client.hgetall(realDetailKey).catch(() => ({})),
      client.hgetall(settingsKey).catch(() => ({})),
      client.hgetall(activeKey).catch(() => ({})),
    ])

  const prog = (progHash || {}) as Record<string, string>
  const base = (baseDetail || {}) as Record<string, string>
  const main = (mainDetail || {}) as Record<string, string>
  const real = (realDetail || {}) as Record<string, string>
  const settings = (settingsHash || {}) as Record<string, string>
  const activeStrats = (activeHash || {}) as Record<string, string>

  // Variant breakdowns
  const mainVariants = await readVariantBreakdown(client, connectionId, "main")
  const realVariants = await readVariantBreakdown(client, connectionId, "real")

  // Axis accumulation at Real stage
  const axisAccumulation = await readAxisAccumulation(client, connectionId)

  // Active sets currently processing (counted across symbols)
  let baseActivelyProcessing = 0
  let liveActive = 0
  for (const [k, v] of Object.entries(activeStrats)) {
    if (k.endsWith(":base")) baseActivelyProcessing += Number(v || "0")
    if (k.endsWith(":live")) liveActive += Number(v || "0")
  }

  // Live data: read from `strategy_detail:{conn}:live` for symmetry
  const liveDetailKey = `strategy_detail:${connectionId}:live`
  const liveDetail = (await client.hgetall(liveDetailKey).catch(() => ({}))) as Record<string, string>

  return {
    base: {
      setsActivelyProcessing: baseActivelyProcessing,
      setsWithOpenPositions: Number(base.sets_with_open_positions || "0"),
      setsProgressing: Number(base.sets_progressing || base.created_sets || "0"),
      setsTotal: Number(prog.strategies_base_total || "0"),
      setsCurrent: Number(prog.strategies_base_current || base.created_sets || "0"),
      avgProfitFactor: Number(base.avg_profit_factor || "0"),
      avgDrawdownTime: Number(base.avg_drawdown_time || "0"),
      avgPosPerSet: Number(base.avg_pos_per_set || "0"),
      pseudoPositionLimit: Number(settings.strategyBasePseudoPositionLimit || "25"),
      variantCountMin: Number(settings.strategyVariantCountMin || "10"),
      variantCountMax: Number(settings.strategyVariantCountMax || "50"),
      variantCountStep: Number(settings.strategyVariantCountStep || "10"),
    },
    main: {
      evaluatedFromBase: Number(main.evaluated || "0"),
      setsCreated: Number(prog.strategies_main_current || main.created_sets || "0"),
      setsTotal: Number(prog.strategies_main_total || "0"),
      setsWithOpenPositions: Number(main.sets_with_open_positions || "0"),
      setsProgressing: Number(main.sets_progressing || main.created_sets || "0"),
      avgProfitFactor: Number(main.avg_profit_factor || "0"),
      avgDrawdownTime: Number(main.avg_drawdown_time || "0"),
      minProfitFactor: Number(settings.minProfitFactorMain || "1.2"),
      maxDrawdownTime: Number(settings.maxDrawdownTimeMain || "1440"),
      variants: mainVariants,
    },
    real: {
      setsCurrent: Number(prog.strategies_real_current || real.created_sets || "0"),
      setsTotal: Number(prog.strategies_real_total || "0"),
      setsWithOpenPositions: Number(real.sets_with_open_positions || "0"),
      setsProgressing: Number(real.sets_progressing || real.created_sets || "0"),
      evaluatedFromMain: Number(real.evaluated || "0"),
      avgProfitFactor: Number(real.avg_profit_factor || "0"),
      avgDrawdownTime: Number(real.avg_drawdown_time || "0"),
      avgPosPerSet: Number(real.avg_pos_per_set || "0"),
      minProfitFactor: Number(settings.minProfitFactorReal || "1.4"),
      maxDrawdownTime: Number(settings.maxDrawdownTimeReal || "960"),
      axisAccumulation,
      variantsAccumulated: realVariants,
    },
    live: {
      setsActive: liveActive,
      setsWithOpenPositions: Number(liveDetail.sets_with_open_positions || liveActive),
      setsProgressing: Number(liveDetail.sets_progressing || "0"),
      setsTotal: Number(prog.strategies_live_total || "0"),
      avgProfitFactor: Number(prog.live_avg_profit_factor || "0"),
      cap: Number(settings.maxLiveSets || "500"),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

async function readVariantBreakdown(
  client: any,
  connectionId: string,
  stage: "main" | "real",
): Promise<Record<string, number>> {
  const variants = ["default", "trailing", "block", "dca", "pause"]
  const result: Record<string, number> = {}
  await Promise.all(
    variants.map(async (v) => {
      const key = `strategy_variant_${stage}:${connectionId}:${v}`
      try {
        const h = (await client.hgetall(key)) || {}
        // created_sets is the cumulative variant Set count
        result[v] = Number((h as any).created_sets || "0")
      } catch {
        result[v] = 0
      }
    }),
  )
  return result as any
}

async function readAxisAccumulation(
  client: any,
  connectionId: string,
): Promise<{
  prev: Record<string, number>
  last: Record<string, number>
  cont: Record<string, number>
  pause: Record<string, number>
}> {
  const axes = ["prev", "last", "cont", "pause"]
  const result: Record<string, Record<string, number>> = {
    prev: {},
    last: {},
    cont: {},
    pause: {},
  }
  await Promise.all(
    axes.map(async (axis) => {
      const key = `strategy_axis_real:${connectionId}:${axis}`
      try {
        const h = (await client.hgetall(key)) || {}
        for (const [window, count] of Object.entries(h)) {
          result[axis][window] = Number(count as string)
        }
      } catch { /* leave empty */ }
    }),
  )
  return result as any
}
