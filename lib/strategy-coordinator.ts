/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 *
 * Flow:
 * 1. BASE: Create one strategy Set per (indication_type × direction) combination
 *          Each Set holds up to 250 config entries. Count = number of Sets.
 * 2. MAIN: Select Sets where avgProfitFactor >= 1.2 (from base).
 *          Expand each Set with position-size / leverage config variants.
 *          Max 250 entries per Set; rearrange by performance when over limit.
 * 3. REAL: Select Sets where avgProfitFactor >= 1.4 (from main).
 *          Exchange-mirrored high-confidence strategies.
 * 4. LIVE: Select best 500 Sets (ranked by profitFactor) for real trading.
 *          One pseudo position per (indication_type, direction) Set.
 *
 * Strategy counts always represent the number of SETS, not individual pseudo positions.
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
} from "@/lib/sets-compaction"

export interface EvaluationMetrics {
  maxDrawdownTime: number
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number      // number of Sets created/evaluated
  passedEvaluation: number  // number of Sets that passed the filter
  failedEvaluation: number  // number of Sets that failed
  avgProfitFactor: number
  avgDrawdownTime: number
}

// One Set = one unique (indication_type × direction) combination at BASE.
// At MAIN we additionally produce related variant Sets derived from a parent
// Base Set — these carry `parentSetKey` (=> the Base Set they derive from)
// and `variant` (=> default / trailing / block / dca). REAL and LIVE stages
// treat them uniformly alongside base-promoted Sets.
export interface StrategySet {
  setKey: string            // e.g. "direction:long" (Base) or "direction:long#block" (Main variant)
  indicationType: string
  direction: "long" | "short"
  avgProfitFactor: number
  avgConfidence: number
  avgDrawdownTime: number
  entryCount: number        // number of config entries in this set (max 250)
  entries: StrategySetEntry[]
  createdAt: string
  
  /**
   * ── Set validity status across stages ──────────────────────────────────
   * 
   * Tracks evaluation state at each stage without duplicating sets.
   * More performant than creating separate set copies for different stages.
   * 
   * Status values:
   *   - "valid_base": Passes BASE→MAIN evaluation (minProfitFactor threshold)
   *   - "valid_main": Passes MAIN→REAL evaluation (higher PF threshold, e.g. 1.4)
   *   - "valid_real": Passes REAL→LIVE evaluation (in top performers)
   *   - "invalid": Failed some evaluation gate
   *   - undefined: Not yet evaluated at this stage
   * 
   * Allows efficient pipeline by checking status before re-evaluating,
   * avoiding duplicate calculations while maintaining set uniqueness.
   */
  status?: "valid_base" | "valid_main" | "valid_real" | "invalid"
  
  /**
   * ── Evaluation reason when status is "invalid" ──────────────────────
   * 
   * Explains why set was rejected in current cycle:
   *   - "insufficient_history": prevPos.count < mainEvalPosCount threshold
   *   - "low_profitfactor": avgProfitFactor < threshold
   *   - "hedge_netted": Hedged out by opposing direction
   *   - "low_performance": Real-stage performance filter
   *   - Other: specific reason for rejection
   */
  rejectionReason?: string
  
  // Lineage — populated at MAIN stage; preserved through REAL/LIVE
  parentSetKey?: string
  variant?: "default" | "trailing" | "block" | "dca" | "pause"
  /**
   * ── Position-count axis windows that this Set satisfies ────────────
   *
   * Spec: *"the created additional related Sets based on Pos counts.. step 1
   * previous 1-12; Last (of previous) 1-4; continuous 1-8 and Pause 1-8
   * so for each validated Base Set.. additional related cnt Sets of > 1000
   * are created and async Calculated.. handled."*
   *
   * Each component records the **integer window** the Set was generated
   * under. We clamp to spec maxima:
   *   - prev   : 0..12  (closed lookback, ctx.prevPosCount)
   *   - last   : 0..4   (the magnitude of last-N wins or losses dimension)
   *   - cont   : 0..8   (open continuous positions, ctx.continuousCount)
   *   - pause  : 0..8   (last-N validation window, ctx.lastPosCount)
   *
   * 0 means "axis not active for this Set" — we still emit it so consumers
   * can dimensionalise stats by axis without re-deriving from ctx.
   *
   * Block + DCA Sets are **independent of these axes** (they fire on
   * `continuousCount >= 1` and `prevLosses >= 1` respectively, which
   * are intrinsic to the variant gates, not on a tagged window). Their
   * axisWindows are still emitted (with `prev`/`pause` populated from
   * ctx, `cont`/`last` left at 0) so the dashboard's per-variant
   * counter blocks can roll up cleanly without special-casing.
   */
  axisWindows?: {
    prev:  number
    last:  number
    cont:  number
    pause: number
    /**
     * Direction the axis-Cartesian Set executes in. Set ONLY on Sets
     * produced by `expandAxisSets()` (the operator-spec'd Cartesian
     * fan-out). Profile-variant Sets and Base Sets inherit direction
     * from `StrategySet.direction` and leave this field undefined.
     *
     * Hedge netting in `evaluateRealSets` uses this field to group
     * Sets by `(symbol × indicationType × triple × outcome)` and keep
     * only the `|long − short|` dominant-direction remainder.
     */
    direction?: "long" | "short"
    /**
     * Stable axis-bucket key —
     * `p{prev}_l{last}_c{cont}_o{pos|neg}_d{long|short}` — used to:
     *   1. Compose the axis-Set's own `setKey` (avoids collisions with
     *      profile-variant Sets sharing the same parent).
     *   2. Drive the hedge-net bucket identity
     *      (`symbol × ind × p|l|c × outcome`).
     *   3. Persist per-bucket net targets for Live partial open/close.
     */
    axisKey?: string
    /**
     * Last-axis outcome categorisation per operator spec:
     *
     *   `pos` = aggregate of parent's last `last` COMPLETED entries was
     *           profitable (mean PF ≥ 1.0).
     *   `neg` = aggregate was unprofitable (mean PF < 1.0).
     *
     * pos / neg Sets are HEDGE-NET-ISOLATED: they represent two
     * different realised market regimes for the same axis triple and
     * must not cancel each other. Bucket identity therefore includes
     * `outcome`.
     */
    outcome?: "pos" | "neg"
  }

  /**
   * Multi-step trailing profile (spec — Settings → Strategy → Trailing).
   *
   * Set at BASE stage when `strategyBaseTrailingEnabled` is on. Threads
   * through Main → Real → Live unchanged; consumed at Live by
   * `PseudoPositionManager.createPosition` to persist the per-position
   * trailing-state machine fields.
   *
   * All three are RATIOS (0.1 ≡ 10 % of price). `stepRatio` is always
   * `stopRatio / 2` per spec.
   *
   * Absent for Sets created when multi-trailing is disabled — those
   * fall back to the legacy single-step path with confidence-based
   * trailing on/off (`bestEntry.confidence ≥ 0.85`).
   */
  trailingProfile?: {
    startRatio: number   // activation gain ratio (e.g. 0.3 ≡ 30 %)
    stopRatio:  number   // trail distance ratio (e.g. 0.1 ≡ 10 %)
    stepRatio:  number   // ratchet increment ratio (= stopRatio / 2)
  }

  /**
   * ── Prev-PI snapshot attached at Base creation ─────────────────────
   *
   * Per operator spec: "make sure strategies are evaluating prev pos and
   * profitfactors min from historic … prev pos cnts are working and
   * added to settings,strategy".
   *
   * Populated by `createBaseSets` from `pi_history:{conn}:{symbol}:{type}:{dir}`
   * and propagated UNCHANGED through Main → Real → Live by `buildVariantSet`
   * and `evaluateRealSets`. Optional — fresh boots / new symbols start
   * with `count = 0` (semantic = "no signal yet, use raw evaluation").
   *
   * Two consumers:
   *   1. createBaseSets uses `profitFactor` to MIN-blend the Set's
   *      `avgProfitFactor` when `count >= prevPosMinCount`. This is the
   *      "evaluating prev pos and profitfactors min from historic"
   *      requirement — historic underperformance pulls the bar down so
   *      Base→Main filters reject it.
   *   2. evaluateRealSets uses `successRate`/`profitFactor` to TUNE
   *      `entries[].sizeMultiplier` and `leverage` per variant — the
   *      "Real stage … accumulation for pos cnts sets … relying to
   *      their base sets configs independent" path.
   */
  prevPos?: {
    count: number
    successRate: number
    profitFactor: number
    avgDDT: number
  }
}

export interface StrategySetEntry {
  id: string
  sizeMultiplier: number
  leverage: number
  positionState: string
  profitFactor: number
  drawdownTime: number
  confidence: number
}

/**
 * Per-cycle position coordination context used by MAIN to decide which
 * additional variant Sets to produce. Fetched ONCE per cycle (via
 * getPositionContext) and threaded through so Base/Main/Real each see the
 * same snapshot without duplicating Redis round-trips.
 */
export interface PositionContext {
  /** Currently-open pseudo positions on the exchange (continuous) */
  continuousCount: number
  /** Count of the most recent N closed positions (default last 5) */
  lastPosCount: number
  /** Total closed positions in the lookback window (default 24h) */
  prevPosCount: number
  /** Number of winners among the last N closed */
  lastWins: number
  /** Number of losers among the last N closed */
  lastLosses: number
  /** Total losers in the lookback window ������������� gates DCA recovery variants */
  prevLosses: number
  /** Per-symbol open position count (for symbol-scoped variant decisions) */
  perSymbolOpen: Record<string, number>
}

// ── Position-Count Cartesian Axis Windows (operator spec) ────────────────────
//
// At Strategy Main, every Base Set that survives the Base→Main gate fans out
// into additional "position-count" Sets along three operator-defined axes
// (plus a direction Cartesian, plus a last-outcome split):
//
//   previous   : 4..12 step 2  → [4, 6, 8, 10, 12]      (5 values, ACTS AS FILTER)
//   last       : 1..4  step 1  → [1, 2, 3, 4]           (4 values, OUTCOME SPLIT)
//   continuous : 1..8  step 1  → [1..8]                 (8 values, POS-COUNT CONTRIB)
//   direction  : long / short                           (2 values)
//
// SEMANTICS PER OPERATOR SPEC:
//
//   • previous (PF FILTER): For each `prev ∈ AXIS_PREV`, compute the
//     aggregate (mean) profit-factor of the parent Base Set's LAST `prev`
//     COMPLETED entries. If aggregate PF < `metrics.minProfitFactor` (the
//     same Main PF threshold used by the Base→Main gate), the entire
//     prev-row is REJECTED for this Base Set — no Sets emitted for that
//     prev value. This implements: "previous 4-12 step 2; Calculate by
//     Minimal Profitfactor as defined for Main".
//
//   • last (OUTCOME SPLIT): For each `last ∈ AXIS_LAST`, classify the
//     parent's LAST `last` COMPLETED entries as either profitable
//     (mean PF ≥ 1.0 → `outcome = "pos"`) or unprofitable
//     (`outcome = "neg"`). Both outcome variants are NOT emitted —
//     only the realised outcome is tagged on the surviving Set,
//     because pos and neg are different market regimes that should
//     NOT hedge-net against each other.  Implements: "last 1-4 step 1;
//     Calculate if Positive or Negative (Combined, own Sets for Pos. and Neg.)".
//
//   • continuous (POS-COUNT CONTRIB): For each `cont ∈ AXIS_CONT`, the
//     emitted Set's `entryCount` = `baseDefault.entryCount + cont`. This
//     is the "positions to be counted, inserted into the positions counts
//     sets" semantic. Per spec: "continuous 3 → add actual and next 2
//     positions to set" → `entryCount = base + 3` (base counts as 1 of 3,
//     +2 more accumulate over subsequent intervals).
//
//   • direction (CARTESIAN): Both long and short axis Sets are emitted
//     regardless of the parent's own direction, so the Real-stage hedge
//     netter has both sides of every bucket to compare.
//
// IMPORTANT — "Do not Calculate the Open Positions, only positions already
// Completed" (operator spec): `baseDefault.entries` is the parent's
// historical entry array, where each entry is an already-completed
// strategy position with a defined `profitFactor`. We treat the full
// `entries` array as completed; open positions are tracked in the
// separate pseudo-position store and never appear here.
//
// NO LOCK — recompute every cycle. The hedge netter in `evaluateRealSets`
// detects per-bucket net-target deltas and the Live stage opens/closes
// partial positions in response. The "no calcs while continuous pos are
// valid" guarantee is satisfied naturally: while a Set's continuous
// window is filling, no new completed entries land → the prev-PF filter
// & last-outcome classification cannot change → the same Set re-emerges
// next cycle unchanged.
//
// FAN-OUT MATH:
//   Worst case (all prev pass + both outcomes possible):
//     5 (prev) × 4 (last) × 8 (cont) × 2 (dir) = 320 Sets / Base
//   Typical (prev filter rejects ~half; outcome split halves last):
//     ~2-3 (prev survivors) × 4 (last, single outcome) × 8 × 2 ≈ 128-192 / Base
//   After Real hedge-net (≤ ½):
//     ≤ 96 effective Sets / Base reaching Live evaluation
const AXIS_PREV     = [4, 6, 8, 10, 12]    as const
const AXIS_LAST     = [1, 2, 3, 4]         as const
const AXIS_CONT     = [1, 2, 3, 4, 5, 6, 7, 8] as const
const AXIS_DIRS     = ["long", "short"]    as const

/**
 * ── Plan-perf Tier 2: precomputed axisKey table ────────────────────
 *
 * The axis-fan-out hot path inside `expandAxisSets` builds an axisKey
 * string per (prev, last, cont, outcome, dir) tuple. With 5 × 4 × 8 ×
 * 2 × 2 = 640 possible tuples, recomputing the template-literal on
 * every Base Set's fan-out (called per (symbol × cycle)) was wasted
 * work — the keys are pure functions of the axis tuple values, never
 * change at runtime.
 *
 * We pre-build the full key table once at module load and look up by
 * (prev, last, cont, outcome, dir) using a flat numeric index. This
 * cuts ~640 string allocations + ~5 concatenations each off every
 * Base-Set fan-out call. At 10 symbols × ~30 base Sets × 1 cycle/sec
 * that's ~190k string allocations/sec eliminated (when the cache
 * misses; on hits we already short-circuit).
 *
 * The encoding (`p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`) is
 * preserved verbatim so existing setKey-derived consumers (Redis
 * keys, `parentSetKey` chain reconstruction, dashboard groupings)
 * continue to match exactly.
 */
const AXIS_OUTCOMES = ["pos", "neg"] as const
type AxisOutcome = (typeof AXIS_OUTCOMES)[number]
type AxisDir = (typeof AXIS_DIRS)[number]
const AXIS_KEY_TABLE: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const prev of AXIS_PREV) {
    for (const last of AXIS_LAST) {
      for (const cont of AXIS_CONT) {
        for (const outcome of AXIS_OUTCOMES) {
          for (const dir of AXIS_DIRS) {
            const k = `${prev}|${last}|${cont}|${outcome}|${dir}`
            m.set(k, `p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`)
          }
        }
      }
    }
  }
  return m
})()
function axisKeyOf(prev: number, last: number, cont: number, outcome: AxisOutcome, dir: AxisDir): string {
  return AXIS_KEY_TABLE.get(`${prev}|${last}|${cont}|${outcome}|${dir}`)!
}

export interface StrategyCoordinatorConfig {
  maxEntriesPerSet?: number   // Default 250 (entries inside one Set)
  maxLiveSets?: number        // Default: max per exchange type (e.g. 500 for bybit, 150 for okx)
  /**
   * Maximum number of REAL Sets that propagate to Live each cycle.
   * Set to Infinity (unlimited) to lift the strategy ceiling — all
   * qualifying Real Sets flow through without a funnel cap. Operator
   * can still prune via preset gates, profit-factor mins, and coordination
   * toggles; this just removes the hard ceiling.
   * Default: Infinity (unlimited).
   */
  maxRealSets?: number
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

export class StrategyCoordinator {
  private connectionId: string
  private config: StrategyCoordinatorConfig = {
    maxEntriesPerSet: 250,
    // Live Sets default is now per-exchange (see setExchangeMaxLive).
    // This is a placeholder; the real value is set during init.
    maxLiveSets: 500,
    // Strategies (Real Sets) are now unlimited by default — no hard cap.
    maxRealSets: Infinity,
    pruneStrategy: "hybrid",
  }

  /**
   * Per-cycle cached coordination settings (axes + variants toggles).
   * The coordinator loads this from connection settings on each flow and
   * respects the operator's toggles for position-count axes and categorical
   * variants (trailing, block, dca, pause). Cached for `_coordinationTtlMs`
   * (5s) to avoid spamming Redis on every symbol's evaluation.
   */
  private _coordinationSettings: {
    axes: {
      prev:  { enabled: boolean; maxWindow: number }
      last:  { enabled: boolean; maxWindow: number }
      cont:  { enabled: boolean; maxWindow: number }
      pause: { enabled: boolean; maxWindow: number }
    }
    variants: {
      trailing: boolean
      block:    boolean
      dca:      boolean
      pause:    boolean
    }
    /**
     * Block-strategy live-position × volume-ratio coordination knobs.
     *
     * The Block variant fires when the per-symbol open-position count is in
     * `[1 .. blockMaxStack-1]` and emits ADD-ON entries that scale on TWO
     * axes simultaneously:
     *
     *   1. **Live position count** — each additional open position on the
     *      symbol multiplies the add-on size by `(1 + (n-1) × ratio)` where
     *      `n = continuousCount` and `ratio = blockVolumeRatio`. At `n=1`
     *      the multiplier is 1.0 (no scaling — first add-on uses raw base
     *      sub-config size). At `n=2` it becomes `(1 + ratio)`.
     *
     *   2. **Operator vol-ratio** — `blockVolumeRatio` is the per-position
     *      additive step (0.25 = +25 % per extra open position). The spec
     *      default 1.0 mirrors the legacy `applyBlockAdjustment` math in
     *      `lib/strategies.ts` so existing presets keep their behaviour.
     *
     * `blockMaxStack` replaces the magic `< 3` literal that used to live
     * inside the variant gate; the operator can now widen or narrow the
     * cap from the Connection Settings dialog without a code change.
     */
    blockVolumeRatio: number
    blockMaxStack:    number
    /**
     * ── Stage-validation min-position thresholds (operator spec) ──────
     *
     * `mainEvalPosCount` — minimum `entryCount` a Base Set must contain
     *   before its profitFactor + drawdownTime are evaluated for
     *   promotion to Main. Below this threshold the Set is SKIPPED at
     *   Main (not validated, not counted as passed). Range 5..50 step 5,
     *   default 15.
     *
     * `realEvalPosCount` — same semantics for Main → Real. Default 10.
     *
     * Skipping (rather than failing) is intentional: low-position Sets
     * naturally re-enter the validation pool on subsequent cycles once
     * enough pseudo-positions have closed. This matches the operator's
     * "if less pos exist in set then do not validate" requirement and
     * preserves count integrity (no false-negative `passed_sets` writes).
     */
    mainEvalPosCount: number
    realEvalPosCount: number
  } = {
    axes: {
      prev:  { enabled: true,  maxWindow: 12 },
      last:  { enabled: true,  maxWindow: 4  },
      cont:  { enabled: true,  maxWindow: 8  },
      pause: { enabled: true,  maxWindow: 8  },
    },
    variants: {
      trailing: true,
      block:    true, // ← ENABLED by default (per spec)
      dca:      true,
      pause:    true,
    },
    blockVolumeRatio: 1.0,
    blockMaxStack:    3,
    mainEvalPosCount: 15,
    realEvalPosCount: 10,
  }
  private _coordinationLoadedAt = 0
  private readonly _coordinationTtlMs = 5_000

  /**
   * Per-cycle snapshot of `pseudo_positions:{conn}:active_config_keys`.
   * Populated at the start of createBaseSets so createMainSets and
   * evaluateRealSets can determine "running-now" without re-issuing
   * SMEMBERS on every (symbol, stage) call.
   *
   * Treated as stale after 30s — if the next createBaseSets did not run
   * for any reason (slow symbol, pause, etc.) Main/Real fall back to a
   * fresh fetch instead of trusting old data.
   */
  private _activeKeysCache: { keys: Set<string>; cycleAt: number } | null = null

  /**
   * Monotonic counter incremented on every executeStrategyFlow call.
   * Used to gate TTL resets (expire) on the progression hash so they
   * fire once every 500 cycles instead of on every cycle.
   */
  private _stratCycleCount = 0

  /**
   * ── Plan-perf Tier 1: parsed-fingerprint LRU ───────────────────────
   *
   * The fpCache stored in Redis is keyed by `fingerprint → JSON.stringify(set)`.
   * Until this perf pass, every cache HIT cost a full `JSON.parse` of a
   * ~1-4 KB payload — at the upper bound (10 symbols × ~80 variant fps
   * each × 1 cycle/sec) that's ~800 parses/sec, dominating createMainSets
   * CPU. This in-process LRU stores the already-parsed StrategySet so a
   * cache hit costs O(1).
   *
   * Keyed by `fingerprint` directly: fingerprints are deterministic and
   * already encode {connectionId, symbol, baseConfig, variant, posCtx}
   * so collisions across connections/symbols are impossible by
   * construction.
   *
   * Capped at 4 096 entries (≈10 connections × 10 symbols × 40 variants).
   * Eviction is "delete oldest insertion" via Map iteration order.
   *
   * Sets are stored by REFERENCE — callers MUST treat them as
   * read-only. createMainSets only reads, never mutates, so this is
   * safe. If a future caller needs to mutate, they should clone the
   * returned record explicitly.
   */
  private static readonly _FP_LRU_MAX = 4_096
  private static _fpLru: Map<string, StrategySet> = new Map()
  private static _fpLruGet(fp: string): StrategySet | undefined {
    const hit = StrategyCoordinator._fpLru.get(fp)
    if (hit !== undefined) {
      // Touch: re-insert to the back so it survives eviction longer.
      StrategyCoordinator._fpLru.delete(fp)
      StrategyCoordinator._fpLru.set(fp, hit)
    }
    return hit
  }
  private static _fpLruSet(fp: string, set: StrategySet): void {
    if (StrategyCoordinator._fpLru.size >= StrategyCoordinator._FP_LRU_MAX) {
      const oldest = StrategyCoordinator._fpLru.keys().next().value
      if (oldest !== undefined) StrategyCoordinator._fpLru.delete(oldest)
    }
    StrategyCoordinator._fpLru.set(fp, set)
  }

  /**
   * 30-second per-instance cache for `connection_settings.prevPosMinCount`.
   *
   * Plan-perf #2: this HGETALL was firing once per (symbol, cycle) inside
   * `createBaseSets`. At 10 symbols × ~1 cycle/sec that's 10 redundant
   * full-hash reads/sec for a value that the operator changes through a
   * settings dialog (i.e. every ~hour at most). Coalesced to a 30-second
   * lifetime: shared across all symbols on this instance, refreshed
   * cheaply, and far more responsive than the natural cadence of the
   * underlying setting.
   *
   * Cache holds the *parsed* int (not the raw hash) so the read path is
   * branch-free. Sentinel `-1` means "not yet loaded" — first read loads
   * synchronously, subsequent symbol cycles reuse without I/O.
   */
  private _prevPosMinCountValue = -1
  private _prevPosMinCountAt = 0
  private readonly _prevPosMinCountTtlMs = 30_000

  // ── Profit factor thresholds per stage (system-wide defaults) ──────
  //
  // Spec: "Change at Main Trade PF for Base, Main, Real, Live to
  // 0.9 1.0 1.0 1.0 System Overall. Add to Settings Dialog at
  // Strategies with Sliders. Ensure it works systemwide completely."
  //
  // These are NOT `readonly` because `loadAppPFThresholds()` overrides
  // them from the operator's settings (`baseProfitFactor`,
  // `mainProfitFactor`, `realProfitFactor`, `liveProfitFactor`) on
  // every cycle. The values written here are the FALLBACKS used when
  // a setting is missing / NaN / 0 — chosen to match the new spec
  // defaults so a fresh install gates with 0.9/1.0/1.0/1.0 even
  // before the operator touches the sliders.
  //
  // Why split `PF_BASE_MIN` (per-indication entry filter at line ~440)
  // from `METRICS.base.minProfitFactor`? Historically `PF_BASE_MIN`
  // gated INDIVIDUAL indication entries into Base, while the METRICS
  // values gate the AVERAGE-PF of an already-built Set into the next
  // stage. Conceptually the operator wants ONE Base PF knob — so we
  // load the same `baseProfitFactor` into both fields.
  private PF_BASE_MIN = 0.9    // Minimum to enter BASE set
  private PF_MAIN_MIN = 1.0    // Base sets must have avgPF >= 1.0 to enter MAIN
  private PF_REAL_MIN = 1.0    // Main sets must have avgPF >= 1.0 to enter REAL
  private PF_LIVE_MIN = 1.0    // Real sets must have avgPF >= 1.0 to enter LIVE

  // ── PF threshold settings cache (per-cycle) ─────────────────────
  // `loadAppPFThresholds()` hits Redis to pull the operator's slider
  // values. Pulling on every symbol's flow would mean N reads per
  // cycle for an N-symbol universe — wasteful and adds latency. The
  // cache holds the last-load timestamp; refresh is bounded to
  // `_pfTtlMs` so a slider change in the Settings dialog takes at
  // most that long to flow into the engine. 5s is short enough to
  // feel instant in the UI but long enough that a 1Hz cycle with 200
  // symbols only does ~3 Redis reads instead of 1000.
  private _pfThresholdsLoadedAt = 0
  private readonly _pfTtlMs = 5_000

  // ── Filter axes (P0-2) ──────────────────────────────────────────────
  // Spec: *"filtering by Profitfactor Minimum, DrawdownTime Maximum"*.
  // The canonical Main/Real/Live filter axes are PF-min + DDT-max ONLY.
  // `confidence` is retained here as advisory metadata (it's shown in
  // diagnostic logs and used by the Live stage's trailing-variant
  // selector `bestEntry.confidence >= 0.85`), but it is NOT a filter
  // axis at any stage. The filter code below reads `minProfitFactor`
  // and `maxDrawdownTime` only.
  // NOT `readonly` — `loadAppPFThresholds()` mutates
  // `.minProfitFactor` on each entry to keep them in sync with the
  // operator's sliders. `maxDrawdownTime` / `confidence` / `description`
  // stay constant (they're not part of this spec change).
  private METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999,
      minProfitFactor: 0.9,   // spec default — operator-tunable
      confidence: 0.3,  // advisory only
      description: "One Set per (indication_type × direction) — all qualifying",
    },
    main: {
      maxDrawdownTime: 300,   // 5 hours — operator spec, validation ceiling at Main
      minProfitFactor: 1.0,   // spec default — operator-tunable
      confidence: 0.5,        // advisory only
      description: "Sets promoted from BASE with profitFactor >= main-threshold + DDT <= 5h, gated by minPositions",
    },
    real: {
      maxDrawdownTime: 300,   // 5 hours — operator spec, validation ceiling at Real
      minProfitFactor: 1.0,   // spec default — operator-tunable
      confidence: 0.65,       // advisory only
      description: "Sets promoted from MAIN with profitFactor >= real-threshold + DDT <= 5h, gated by minPositions",
    },
    live: {
      maxDrawdownTime: 300,   // 5 hours — aligned with Main + Real
      minProfitFactor: 1.0,   // spec default — operator-tunable
      confidence: 0.65,       // advisory only
      description: "Best 500 Sets from REAL (PF >= live-threshold + DDT <= 5h) ready for live trading",
    },
  }

  /**
   * Hydrate PF thresholds from operator settings.
   *
   * Reads `baseProfitFactor`, `mainProfitFactor`, `realProfitFactor`,
   * `liveProfitFactor` from `getAppSettings()` and mirrors them into:
   *   - `PF_*_MIN` (per-indication entry filter at base stage; advisory
   *      promotion floor at later stages)
   *   - `METRICS.{base|main|real|live}.minProfitFactor` (Set-average
   *      gate consumed at lines 695/1117/1468)
   *
   * Bounds: [0.0, 5.0]. The slider UI is [0.0, 2.0] but we accept up
   * to 5.0 to allow operators to set extreme values via API/Redis
   * directly without truncation surprise. NaN / negative / missing
   * values fall back to the spec defaults (0.9/1.0/1.0/1.0).
   *
   * Cached for `_pfTtlMs` (5s). The first call after engine start
   * (and any 5s+ later) actually hits Redis; intermediate calls are
   * O(1) no-ops. This is safe to call from every `executeStrategyFlow`
   * entry — including the per-symbol calls inside the batch loop —
   * because the TTL bounds the work.
   */
  private async loadAppPFThresholds(): Promise<void> {
    const now = Date.now()
    if (now - this._pfThresholdsLoadedAt < this._pfTtlMs) return
    this._pfThresholdsLoadedAt = now
    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const s = (await getAppSettings()) || {}
      const clamp = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) return fallback
        return Math.max(0, Math.min(5, n))
      }
      const basePF = clamp(s.baseProfitFactor, 0.9)
      const mainPF = clamp(s.mainProfitFactor, 1.0)
      const realPF = clamp(s.realProfitFactor, 1.0)
      const livePF = clamp(s.liveProfitFactor, 1.0)

      this.PF_BASE_MIN = basePF
      this.PF_MAIN_MIN = mainPF
      this.PF_REAL_MIN = realPF
      this.PF_LIVE_MIN = livePF
      this.METRICS.base.minProfitFactor = basePF
      this.METRICS.main.minProfitFactor = mainPF
      this.METRICS.real.minProfitFactor = realPF
      this.METRICS.live.minProfitFactor = livePF
    } catch (err) {
      // Don't fail the whole flow on a settings read miss — the
      // already-loaded values (either the defaults or the last
      // successful load) keep gating active. Log once per failure to
      // help diagnose without spamming.
      console.warn(
        `[v0] [StrategyCoordinator] loadAppPFThresholds() failed; using last-known values`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Load coordination settings (axes + variants toggles) from connection settings.
   *
   * The operator can toggle each variant (trailing, block, dca, pause) and each
   * axis (prev, last, cont, pause) via the connection-settings dialog. The
   * toggles flow here on each strategy-flow cycle and gate which variants are
   * evaluated and which axis windows are consulted.
   *
   * Cached for `_coordinationTtlMs` (5s). Falls back to spec defaults on
   * error or missing settings so the coordinator always functions even if
   * the operator never touched the UI.
   */
  private async loadCoordinationSettings(): Promise<void> {
    const now = Date.now()
    if (now - this._coordinationLoadedAt < this._coordinationTtlMs) return
    this._coordinationLoadedAt = now
    try {
      const { getConnection } = await import("@/lib/redis-db")
      const conn = await getConnection(this.connectionId)
      if (!conn) return
      const raw = (conn as any).connection_settings
      const settings = typeof raw === "string" ? JSON.parse(raw) : raw || {}
      const coord = settings.coordination_settings || settings.coordinationSettings
      if (coord?.axes && coord?.variants) {
        // Coerce the block ratio + stack to safe numeric bands. Operators
        // can dial the ratio between 0.25 and 3.0 per add-on (so the worst
        // case at max-stack 3 caps out at 1 + 2×3 = 7× base sub-config
        // size — extreme but bounded). Stack is clamped to 2..8 so the
        // gate predicate (`n >= 1 && n < stack`) always admits at least
        // one stack level when Block is on.
        const ratioRaw = Number(
          coord.blockVolumeRatio ??
            coord.block_volume_ratio ??
            coord.variants.blockVolumeRatio ??
            this._coordinationSettings.blockVolumeRatio,
        )
        const ratio = Number.isFinite(ratioRaw)
          ? Math.min(3.0, Math.max(0.25, ratioRaw))
          : this._coordinationSettings.blockVolumeRatio

        const stackRaw = Number(
          coord.blockMaxStack ??
            coord.block_max_stack ??
            coord.variants.blockMaxStack ??
            this._coordinationSettings.blockMaxStack,
        )
        const stack = Number.isFinite(stackRaw)
          ? Math.min(8, Math.max(2, Math.round(stackRaw)))
          : this._coordinationSettings.blockMaxStack

        // ── Stage-validation min-position counts (operator spec) ─────
        // 5..50 step 5, defaults 15 (Main) / 10 (Real). Snap to the
        // 5-step grid so a value typed via API doesn't bypass slider
        // granularity. Two persistence paths supported:
        //   1. Nested  coord.{mainEvalPosCount,realEvalPosCount}
        //   2. Flat    settings.{mainEvalPosCount,realEvalPosCount}
        //      (top-level mirror written by the dialog for cheap reads)
        const snapPosCount = (raw: unknown, fallback: number): number => {
          const n = Number(raw)
          if (!Number.isFinite(n) || n < 5) return fallback
          return Math.min(50, Math.max(5, Math.round(n / 5) * 5))
        }
        const mainEvalRaw =
          coord.mainEvalPosCount ??
          coord.main_eval_pos_count ??
          (settings as any).mainEvalPosCount ??
          this._coordinationSettings.mainEvalPosCount
        const realEvalRaw =
          coord.realEvalPosCount ??
          coord.real_eval_pos_count ??
          (settings as any).realEvalPosCount ??
          this._coordinationSettings.realEvalPosCount
        const mainEvalPosCount = snapPosCount(mainEvalRaw, this._coordinationSettings.mainEvalPosCount)
        const realEvalPosCount = snapPosCount(realEvalRaw, this._coordinationSettings.realEvalPosCount)

        // Merge with defaults so a partial UI save doesn't strip toggles.
        this._coordinationSettings = {
          axes: {
            prev:  { ...this._coordinationSettings.axes.prev,  ...coord.axes.prev },
            last:  { ...this._coordinationSettings.axes.last,  ...coord.axes.last },
            cont:  { ...this._coordinationSettings.axes.cont,  ...coord.axes.cont },
            pause: { ...this._coordinationSettings.axes.pause, ...coord.axes.pause },
          },
          variants: {
            trailing: coord.variants.trailing !== false,
            block:    coord.variants.block    !== false, // default-on per spec
            dca:      coord.variants.dca      !== false,
            pause:    coord.variants.pause    !== false,
          },
          blockVolumeRatio: ratio,
          blockMaxStack:    stack,
          mainEvalPosCount,
          realEvalPosCount,
        }
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyCoordinator] loadCoordinationSettings() failed; using defaults`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  constructor(connectionId: string, config?: StrategyCoordinatorConfig) {
    this.connectionId = connectionId
    if (config) {
      this.config = { ...this.config, ...config }
    }
    // Set the live-sets limit based on the connection's exchange.
    // This happens synchronously in the constructor; the exchange type
    // is stateless and doesn't need async I/O.
    this.setExchangeMaxLive()
  }

  /**
   * Set `maxLiveSets` based on the connection's exchange.
   * The limit is the maximum position count that the exchange allows,
   * so the Live Sets funnel respects the per-exchange ceiling.
   *
   * Exchange max positions:
   *   - bybit, binance   → 500
   *   - okx, kucoin, gateio, bitget → 150
   *   - mexc, bingx      → 100
   */
  private setExchangeMaxLive(): void {
    // The exchange type is stored in the connectionId or a cache lookup.
    // For now, use a conservative default; the engine-manager or
    // connection-state can override this if needed. In practice, most
    // operators use bybit/binance so 500 is safe. Custom setups can
    // pass `maxLiveSets` in the config param.
    if (!this.config.maxLiveSets || this.config.maxLiveSets === 500) {
      // Default bybit/binance. Operator can pass `config.maxLiveSets`
      // to override for their exchange (e.g. 150 for OKX).
      this.config.maxLiveSets = 500
    }
  }

  /**
   * Execute complete strategy progression flow.
   *
   * Position context is fetched ONCE per cycle and threaded through so Main
   * can generate the correct additional variant Sets without duplicating
   * pseudo-position reads. Callers may also pass a precomputed context
   * (e.g. when running multiple symbols in the same cycle) — we'll reuse it.
   */
  async executeStrategyFlow(
    symbol: string,
    indications: any[],
    isPrehistoric: boolean = false,
    sharedContext?: PositionContext,
  ): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []
    this._stratCycleCount++

    try {
      // ── Hydrate PF thresholds + Coordination settings from operator settings ─
      // 5s TTL inside the loaders bounds Redis pressure; slider/toggle changes
      // in the Settings dialog flow into the engine within ≤5s. We
      // call these on EVERY flow (including per-symbol in batch loops) —
      // the TTL ensures they become no-ops except for the first symbol
      // or the first after a 5s quiet period.
      await Promise.all([
        this.loadAppPFThresholds(),
        this.loadCoordinationSettings(),
      ])

      // Fetch the per-cycle position coordination context once. Prehistoric
      // runs use a neutral context (no open positions, no prior outcomes) so
      // only the always-on `default` variant is produced — that matches the
      // original behaviour for backtests.
      const posCtx: PositionContext = sharedContext
        ?? (isPrehistoric
          ? this.neutralPositionContext()
          : await this.getPositionContext())

      // Refresh per-cycle trailing-matrix cache when this entry-point is
      // called standalone (the batch entry-point invalidates already).
      // `sharedContext` presence is the cheapest tell that we're inside
      // a batch — skip the reset there to keep one read per batch.
      if (!sharedContext) (this as any)._trailingVariantsCache = undefined

      // Sets flow BASE → MAIN → REAL → LIVE. Each stage used to re-read its
      // predecessor's output from Redis via getSettings(); we now pipe the
      // computed arrays directly between stages in memory to eliminate 3
      // Redis round-trips per symbol per cycle. Each stage still persists
      // its own output to Redis for downstream consumers (stats API, dashboard).
      //
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const { result: baseResult, sets: baseSets } = await this.createBaseSets(symbol, indications)
      results.push(baseResult)

      // STAGE 2: MAIN — validate Base Sets AND create additional related
      // variant Sets (Default / Trailing / Block / DCA) gated by posCtx.
      const { result: mainResult, sets: mainSets } = await this.createMainSets(symbol, baseSets, posCtx)
      results.push(mainResult)

      // STAGE 3: REAL — promote Sets with avgPF >= 1.4 (base-promoted AND
      // additional related variants flow uniformly through this filter)
      const { result: realResult, sets: realSets } = await this.evaluateRealSets(symbol, mainSets)
      results.push(realResult)

      // STAGE 4: LIVE — best 500 Sets for execution (skip in prehistoric mode)
      if (!isPrehistoric) {
        const { result: liveResult } = await this.createLiveSets(symbol, realSets)
        results.push(liveResult)
      }

      await this.logStrategyProgression(symbol, results)
      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    }
  }

  /**
   * Run N symbols in a single flow pass, sharing one position-context fetch
   * across all of them. Use this when the engine evaluates many symbols per
   * cycle — it eliminates (N-1) pseudo-position reads vs. calling
   * `executeStrategyFlow` separately for each symbol.
   */
  async executeStrategyFlowBatch(
    items: Array<{ symbol: string; indications: any[] }>,
    isPrehistoric: boolean = false,
  ): Promise<Record<string, StrategyEvaluation[]>> {
    const ctx = isPrehistoric ? this.neutralPositionContext() : await this.getPositionContext()
    // Refresh per-cycle caches so a Settings save in the dashboard takes
    // effect on the very next cycle (no engine restart required).
    ;(this as any)._trailingVariantsCache = undefined
    const out: Record<string, StrategyEvaluation[]> = {}
    // Run per-symbol flows in parallel — they only share the ctx snapshot and
    // each touches distinct symbol-scoped Redis keys.
    await Promise.all(
      items.map(async ({ symbol, indications }) => {
        out[symbol] = await this.executeStrategyFlow(symbol, indications, isPrehistoric, ctx)
      }),
    )
    return out
  }

  // ─── STAGE 1: BASE ───────────────────────────────────────────────────────────

  /**
   * Read the multi-step trailing matrix from Redis settings (mirror-aware).
   * Returns one TrailingProfile per ENABLED `(start, stop)` combo.
   *
   * When the master toggle (`strategyBaseTrailingEnabled`) is off OR no
   * variants are enabled, returns `[]` and the caller falls back to the
   * legacy single-Set path with confidence-based trailing on/off.
   *
   * Cached per-cycle on `this._trailingVariantsCache` so the per-symbol
   * createBaseSets calls in `executeStrategyFlowBatch` share one read.
   */
  private async getEnabledTrailingVariants(): Promise<
    Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string }>
  > {
    if ((this as any)._trailingVariantsCache) return (this as any)._trailingVariantsCache
    try {
      // Lazy import to avoid circular deps in legacy callers
      const { getAppSettings } = await import("@/lib/redis-db")
      const settings = (await getAppSettings()) || {}
      const enabledMaster = settings.strategyBaseTrailingEnabled !== false
      if (!enabledMaster) {
        ;(this as any)._trailingVariantsCache = []
        return []
      }

      const raw = settings.strategyBaseTrailingVariants
      // Support both shapes: stringified JSON (Upstash KV) and array
      let tokens: string[] = []
      if (Array.isArray(raw)) tokens = raw
      else if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) tokens = parsed
        } catch { /* tolerate malformed */ }
      } else if (typeof raw === "string") {
        // Comma-or-whitespace-separated fallback
        tokens = raw.split(/[\s,]+/).filter(Boolean)
      }

      const profiles: Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string }> = []
      for (const token of tokens) {
        if (typeof token !== "string") continue
        const [sStr, kStr] = token.split(":")
        const start = parseFloat(sStr)
        const stop = parseFloat(kStr)
        if (!Number.isFinite(start) || !Number.isFinite(stop)) continue
        if (start <= 0 || stop <= 0) continue
        // tag is the canonical compact identifier used in setKey suffix
        const tag = `t${Math.round(start * 100)}-${Math.round(stop * 100)}`
        profiles.push({ startRatio: start, stopRatio: stop, stepRatio: stop / 2, tag })
      }
      ;(this as any)._trailingVariantsCache = profiles
      return profiles
    } catch (err) {
      console.warn("[v0] [StrategyCoordinator] failed to read trailing variants:", err)
      ;(this as any)._trailingVariantsCache = []
      return []
    }
  }

  /**
   * Create one StrategySet per (indication_type × direction × trailing_variant)
   * combination. Each Set holds multiple config entries (max 250).
   *
   * When multi-step trailing is disabled (or no variants are enabled), the
   * fan-out collapses to one Set per (type × direction) — original behaviour.
   */
  private async createBaseSets(
    symbol: string,
    indications: any[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Group indications by (type × direction)
    const setMap = new Map<string, { indicationType: string; direction: "long" | "short"; indications: any[] }>()

    for (const ind of indications) {
      const direction: "long" | "short" = ind.metadata?.direction === "short" ? "short" : "long"
      const key = `${ind.type || "direction"}:${direction}`
      if (!setMap.has(key)) {
        setMap.set(key, { indicationType: ind.type || "direction", direction, indications: [] })
      }
      setMap.get(key)!.indications.push(ind)
    }

    const baseSets: StrategySet[] = []
    const maxEntries = this.config.maxEntriesPerSet || 250

    // ── Prev-PI batch prefetch (one round-trip, all (type×dir) buckets) ──
    // Per spec: strategies must "evaluate prev pos and profitfactors min
    // from historic … prev pos cnts are working and added to settings,
    // strategy". We fetch the lifetime success/PF/DDT for every (type,
    // direction) bucket this symbol is about to produce a Base Set for,
    // then attach + min-blend below. Fresh boots / new buckets return
    // {count:0, ...} which is treated as "no signal yet" → no blend.
    let posMap: Map<string, import("@/lib/pos-history").PosHistoryStats> = new Map()
    let prevPosMinCount = 5
    try {
      const { getPosHistoryBatch } = await import("@/lib/pos-history")
      const pairs = Array.from(setMap.values()).map((g) => ({
        indicationType: g.indicationType,
        direction: g.direction,
      }))
      // Operator-tunable threshold (Settings → Strategies → Coordination).
      // Read from connection_settings hash; fall back to 5 (≈ statistical
      // smallest meaningful win-rate denominator).
      //
      // 30-second per-instance cache: the operator changes this through a
      // settings dialog, so the natural cadence is ~hourly at fastest. Per-
      // symbol-per-cycle HGETALLs were costing 10 round-trips/sec at 10
      // symbols for a value that almost never moves. The settings dirty-
      // flag broadcast is independent of this cache, so a save still gets
      // picked up within one realtime tick *of the next refresh window*
      // — the cap matches the responsiveness of every other settings
      // value on this code path.
      try {
        const cachedAge = Date.now() - this._prevPosMinCountAt
        if (this._prevPosMinCountValue >= 0 && cachedAge < this._prevPosMinCountTtlMs) {
          prevPosMinCount = this._prevPosMinCountValue
        } else {
          const client = getRedisClient()
          const cs = (await client.hgetall(
            `connection_settings:${this.connectionId}`,
          )) as Record<string, string>
          const v = Number(cs?.prevPosMinCount || cs?.prevPiMinCount || "")
          if (Number.isFinite(v) && v >= 1) prevPosMinCount = Math.min(50, Math.floor(v))
          this._prevPosMinCountValue = prevPosMinCount
          this._prevPosMinCountAt = Date.now()
        }
      } catch { /* default stays */ }
      posMap = await getPosHistoryBatch(this.connectionId, symbol, pairs, prevPosMinCount)
    } catch (posErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} prev-pos prefetch failed:`, posErr)
    }

    // Multi-step trailing matrix — `[]` (= no fan-out) collapses to legacy
    // single-Set-per-(type,direction) behaviour. We use `[null]` as a
    // sentinel "untrailed" pass so the body of the loop is shared between
    // both paths.
    const trailingVariants = await this.getEnabledTrailingVariants()
    const variantPasses: Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string } | null> =
      trailingVariants.length > 0 ? trailingVariants : [null]

    for (const variant of variantPasses) {
      for (const [baseSetKey, group] of setMap.entries()) {
        // Per-variant Set key — keeps each trailing combo as an INDEPENDENT
        // Set throughout the BASE → MAIN → REAL → LIVE flow.
        const setKey = variant ? `${baseSetKey}:${variant.tag}` : baseSetKey

        // Build up to maxEntries config entries for this Set
        const entries: StrategySetEntry[] = []
        let entryIdx = 0

        for (const ind of group.indications) {
          if (entryIdx >= maxEntries) break
          // Always parse as numbers — indication fields may arrive as strings from Redis hgetall
          const rawConf = parseFloat(String(ind.confidence ?? 0.5))
          const conf = Number.isFinite(rawConf) ? rawConf : 0.5
          const rawPF = parseFloat(String(ind.profitFactor ?? ind.profit_factor ?? 0))
          const pfFromPF = Number.isFinite(rawPF) && rawPF > 0 ? rawPF : conf * 2
          const pf = pfFromPF
          if (pf < this.PF_BASE_MIN) continue

          entries.push({
            id: `${setKey}-${entryIdx}`,
            sizeMultiplier: 1.0,
            leverage: 1,
            positionState: "new",
            profitFactor: pf,
            drawdownTime: 0,
            confidence: conf,
          })
          entryIdx++
        }

        if (entries.length === 0) continue

        const rawAvgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
        const avgConf = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

        // ── Prev-PI min-blend on avgProfitFactor ─────────────────────────
        // Operator spec: "evaluating prev pos and profitfactors min from
        // historic". When the historic bucket has at least `prevPosMinCount`
        // closed positions, the Set's avgProfitFactor becomes the MIN of
        // (live indication PF, historic realised PF). Underperforming
        // historic regimes thus pull the bar DOWN so the Base→Main filter
        // rejects them. When the bucket has insufficient data we leave the
        // raw indication-derived PF untouched (= bootstrap path).
        const posStats = posMap.get(`${group.indicationType}|${group.direction}`)
        const blendActive = !!posStats && posStats.count >= prevPosMinCount
        const avgPF = blendActive
          ? Math.min(rawAvgPF, posStats!.profitFactor)
          : rawAvgPF


        const set: StrategySet = {
          setKey,
          indicationType: group.indicationType,
          direction: group.direction,
          avgProfitFactor: avgPF,
          avgConfidence: avgConf,
          avgDrawdownTime: 0,
          entryCount: entries.length,
          entries,
          createdAt: new Date().toISOString(),
          ...(variant && {
            trailingProfile: {
              startRatio: variant.startRatio,
              stopRatio: variant.stopRatio,
              stepRatio: variant.stepRatio,
            },
          }),
          // Attach prev-pos snapshot so Main/Real propagation paths can
          // reach it without re-fetching. Always carry the field even
          // when count==0 — keeps downstream null-checking simple.
          ...(posStats && posStats.count > 0 && {
            prevPos: {
              count: posStats.count,
              successRate: posStats.successRate,
              profitFactor: posStats.profitFactor,
              avgDDT: posStats.avgDDT,
            },
          }),
        }

        baseSets.push(set)
      }
    }

    // Persist BASE sets
    const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
    await setSettings(baseKey, { sets: baseSets, count: baseSets.length, created: new Date() })

    // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts.
    // CRITICAL: Use hincrby (cumulative) not hset (snapshot). Previously each cycle overwrote the
    // value with the current cycle's count, which made the dashboard oscillate between high/low
    // values every few seconds ("jumping more and less"). The per-cycle snapshot is still
    // available in `strategy_detail:{connId}:base` (`created_sets` field).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const detailKey  = `strategy_detail:${this.connectionId}:base`
      const baseAvgPF  = baseSets.length > 0 ? baseSets.reduce((s, st) => s + st.avgProfitFactor, 0) / baseSets.length : 0
      const baseAvgDDT = baseSets.length > 0 ? baseSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / baseSets.length : 0
      // Average config entries per Set — the canonical "positions per Set"
      // metric the dashboard surfaces for each stage. At Base, each entry is
      // one raw indication slot ready for position coordination at Main.
      const baseEntriesTotal  = baseSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const baseAvgPosPerSet  = baseSets.length > 0 ? baseEntriesTotal / baseSets.length : 0

      // ── ACTIVELY-RUNNING NOW snapshot (canonical "alive" definition) ──
      // Per operator spec the dashboard must show counts ONLY for Sets
      // that are ACTIVELY processing — those that either:
      //   (a) currently hold ≥ 1 open pseudo-position, or
      //   (b) have ongoing position formation in progress this cycle.
      // The canonical ground truth is membership in
      // `pseudo_positions:{conn}:active_config_keys`, maintained
      // atomically by PseudoPositionManager (added on open, removed on
      // close). We read it once per cycle and cache on `this` so
      // createMainSets / evaluateRealSets can reuse it without an extra
      // SMEMBERS round-trip.
      const activeKeys = new Set<string>(
        (await client
          .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
          .catch(() => [])) as string[],
      )
      this._activeKeysCache = { keys: activeKeys, cycleAt: Date.now() }
      const baseRunningNow = baseSets.filter((s) => activeKeys.has(s.setKey)).length

      // Fan-out all independent writes. The awaited chain used to add ~8 Redis
      // round-trips to every BASE cycle even when nothing had changed; issuing
      // them concurrently cuts that to a single bounded round-trip window.
      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_base_current", String(baseSets.length)),
        client.hset(detailKey, {
          // ── Legacy per-cycle aggregate fields ─────────────────────────
          // These hold THIS-symbol's values and are overwritten on every
          // (symbol, cycle). They remain for backwards compatibility but
          // the /stats route prefers the cross-symbol sums it computes
          // from the `s:{symbol}:*` per-symbol fields below.
          created_sets:      String(baseSets.length),
          avg_profit_factor: String(baseAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(baseAvgDDT)),
          avg_pos_per_set:   String(baseAvgPosPerSet.toFixed(2)),
          evaluated:         String(baseSets.length),
          passed_sets:       "0",   // will be updated by createMainSets
          entries_total:     String(baseEntriesTotal),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   sets_running_now         = canonical "alive" count: Sets
          //     whose setKey is in `active_config_keys` Redis Set right
          //     now (open pseudo-position OR in-formation). This is the
          //     ONLY count surfaced as "Active" on the dashboard — the
          //     dashboard must hide already-progressed Sets that have
          //     since closed and are no longer doing anything.
          //   sets_with_open_positions = alias of sets_running_now for
          //     dialog labels that prefer position-centric phrasing.
          //   sets_progressing         = Sets in mid-calculation this
          //     cycle (entryCount > 0 means slots are being formed).
          sets_running_now:         String(baseRunningNow),
          sets_with_open_positions: String(baseRunningNow),
          sets_progressing:         String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          updated_at:        String(Date.now()),
          // ── Per-symbol fields (cross-symbol aggregation source) ──────
          // The legacy fields above are overwritten by every symbol's
          // cycle, leaving the dashboard with only the LAST symbol's
          // numbers. To preserve cross-symbol totals & weighted means,
          // we additionally write a `s:{symbol}:*` namespaced bundle
          // per cycle. The /stats route iterates these fields, sums
          // counters, and computes weighted means (weight = createdSets)
          // per symbol. Stale samples (ts older than 5 min) are excluded;
          // very old samples (ts older than 30 min) are pruned.
          [`s:${symbol}:created`]:    String(baseSets.length),
          [`s:${symbol}:entries`]:    String(baseEntriesTotal),
          [`s:${symbol}:running`]:    String(baseRunningNow),
          [`s:${symbol}:progressing`]: String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     "0",  // updated when Main runs
          [`s:${symbol}:evaluated`]:  String(baseSets.length),
          [`s:${symbol}:apf`]:        String(baseAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(baseAvgDDT)),
          [`s:${symbol}:apps`]:       String(baseAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(detailKey, 86400),
        client.set(`strategies:${this.connectionId}:base:count`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:evaluated`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:base:count`, 86400),
        client.expire(`strategies:${this.connectionId}:base:evaluated`, 86400),
      ]
      if (baseSets.length > 0) {
        writes.push(client.hincrby(redisKey, "strategies_base_total", baseSets.length))
        writes.push(client.hincrby(redisKey, "strategies_base_evaluated", baseSets.length))
      }

      // ── ACTIVE-NOW snapshot per (symbol, stage) ───────────────────────
      // The cumulative `strategies_base_total` hincrby above answers
      // "how many Base Sets have been created EVER", but the dashboard
      // Overview asks "how many are alive RIGHT NOW for this symbol".
      // We overwrite a single field per (symbol, stage) every cycle so
      // the latest value is always the most recent count. The stats API
      // hgetalls this hash and aggregates by stage.
      writes.push(
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:base`]:          String(baseSets.length),
          // base:evaluated = same as base (every Base Set IS evaluated at Base stage)
          [`${symbol}:base:evaluated`]: String(baseSets.length),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
      )
      // Gate progression hash TTL reset — 7-day key, refresh every 500 cycles
      if (this._stratCycleCount % 500 === 1) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }
      await Promise.all(writes)
    } catch { /* non-critical */ }

    return {
      result: {
        type: "base",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: baseSets.length,
        failedEvaluation: 0,
        avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
        avgDrawdownTime: 0,
      },
      sets: baseSets,
    }
  }

  // ─── STAGE 2: MAIN ───────────────────────────────────────────────────────────

  /**
   * Validate BASE Sets (avgPF >= 1.2, avgConf >= 0.5, DDT <= 24h) AND create
   * additional RELATED variant Sets for each validated Base Set, gated by
   * per-cycle position coordination context.
   *
   * Per user spec:
   *   "Main validates from Base Sets, then creates additional related Sets
   *    (based on prev pos counts, last pos counts, continuous pos counts,
   *    each with adjusted strategies — Block, DCA, etc.) for each evaluated
   *    Set, IF NOT ALREADY CREATED, and are used for continuous progress to
   *    Real. Real evaluates from Main with the additional related Sets."
   *
   * Implementation:
   *   1. For each Base Set passing validation, produce N "related" Main Sets,
   *      one per ACTIVE variant whose gate predicate passes for the current
   *      PositionContext. Each related Set carries `parentSetKey` = base
   *      setKey + `variant` = one of {default, trailing, block, dca}.
   *   2. Variant expansion uses a curated small config list (≤ 4 per variant,
   *      ≤ 4 active variants) instead of the previous 4×4×4 = 64-entry
   *      Cartesian product. At max this generates ~16 entries per Base
   *      entry — ~4× faster than the old path and no silently-rejected
   *      entries (every config is pre-filtered to satisfy the DDT cap).
   *   3. Fingerprint cache — we record `{baseSetKey, base avgPF bucket,
   *      variant, posCtx bucket}` per generated Set. If the same fingerprint
   *      re-appears next cycle, we reuse the cached Set instead of
   *      regenerating ("IF NOT ALREADY CREATED").
   */
  private async createMainSets(
    symbol: string,
    inputSets?: StrategySet[],
    posCtx?: PositionContext,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Prefer in-memory input (hot-path pipelined from createBaseSets). Fall
    // back to Redis only when called standalone (tests / diagnostics).
    let baseSets: StrategySet[]
    if (inputSets) {
      baseSets = inputSets
    } else {
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      const stored = await getSettings(baseKey)
      baseSets = stored?.sets || []
    }

    const metrics = this.METRICS.main
    const maxEntries = this.config.maxEntriesPerSet || 250
    const ctx = posCtx ?? this.neutralPositionContext()
    const mainSets: StrategySet[] = []

    // ── Stage-validation min-position threshold (operator spec) ────
    // "Main has to evaluate from stage Base with profitfactor for X
    //  pre pseudo positions for specific config … if less pos exist
    //  in set then do not validate."
    // Sets below the threshold are SKIPPED (silent continue) — they
    // re-enter the validation pool on subsequent cycles once their
    // entryCount climbs. Tracked via a single counter so the dashboard
    // can surface "skipped due to insufficient positions" without
    // polluting the passed/failed buckets.
    const mainMinPos = this._coordinationSettings.mainEvalPosCount
    let skippedLowPos = 0

    // ── 1. Fingerprint-cache lookup ────────────────────────────────────────
    // Fetch last cycle's fingerprint map up-front. `fpCacheKey` stores a
    // per-symbol hash of { fingerprint: JSON.stringify(set) } entries. We
    // read it once, check each candidate (baseSet × variant), and rebuild
    // only what's new. This cuts Main regeneration cost to ~0 when nothing
    // upstream has changed.
    const fpCacheKey = `strategies:${this.connectionId}:${symbol}:main:fp`
    const client = getRedisClient()
    const fpCache = ((await client.hgetall(fpCacheKey).catch(() => null)) || {}) as Record<string, string>
    const nextFpCache: Record<string, string> = {}
    let reused = 0

    // ── 2. Variant profiles ─────────────────────────────────────────────
    // The `block` gate must fire when THIS symbol already has an open
    // position — not when any symbol globally does. Patch continuousCount
    // to the per-symbol open count so both gate evaluation and the `cont`
    // axis in axisWindows reflect the per-symbol reality. All other
    // ctx fields (prev, last, pause) remain global / shared as designed.
    const symbolCtx: PositionContext = {
      ...ctx,
      continuousCount: ctx.perSymbolOpen[symbol] ?? 0,
    }
    const activeVariants = this.selectActiveVariants(symbolCtx)

    // Track the freshly-built `default` Main Set per Base so we can fan it
    // out into the operator-spec'd Position-Count Cartesian (prev × last ×
    // cont × dir) AFTER the profile loop completes. Both cache-hit and
    // cache-miss paths populate this map so reuses still trigger fan-out.
    const defaultByBaseKey = new Map<string, StrategySet>()

    // ── 2. Base/variant async processing ────────────────────────����───────────
    // Process all baseSet × variant combinations in parallel for faster throughput.
    // Each combination calls the async buildVariantSet, which previously ran
    // sequentially. Now they all start together and resolve concurrently.
    const buildTasks: Promise<{
      baseSet: StrategySet
      profile: any
      built: StrategySet | null
      fingerprint: string
      cachedSet: StrategySet | null
    }>[] = []

    for (const baseSet of baseSets) {
      // ── Min-positions gate + Status tracking (operator spec) ────────────────────
      // Evaluation requires minimum historical data. Instead of skipping,
      // mark with status="invalid" + rejectionReason so sets persist but
      // won't be evaluated until sufficient data. More efficient than duplicating.
      //
      // Status field allows:
      // - Efficient pipeline by checking status before re-calculating
      // - Dashboard visibility: why sets are delayed
      // - Zero duplication: single set object with state flag
      const liveCount    = baseSet.entryCount ?? baseSet.entries?.length ?? 0
      const histCount    = baseSet.prevPos?.count ?? 0
      const setPosCount  = Math.max(liveCount, histCount)
      
      // Check if we have sufficient history (default mainMinPos = 15)
      const hasHistoricData = histCount > 0
      if (hasHistoricData && histCount < mainMinPos) {
        // Mark as invalid with reason, but keep in map so it can be re-evaluated later
        baseSet.status = "invalid"
        baseSet.rejectionReason = `insufficient_history: ${histCount}/${mainMinPos}`
        skippedLowPos++
        continue
      }

      // Base-level validation - mark status based on pass/fail
      if (baseSet.avgProfitFactor < metrics.minProfitFactor) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = `low_profitfactor: ${baseSet.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
        continue
      }
      if (baseSet.avgDrawdownTime > metrics.maxDrawdownTime) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = `high_drawdowntime: ${baseSet.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
        continue
      }

      // Mark as valid for BASE→MAIN evaluation
      baseSet.status = "valid_base"

      const variantsForThisBase = baseSet.trailingProfile
        ? activeVariants.filter((p) => p.name === "default")
        : activeVariants

      for (const profile of variantsForThisBase) {
        // Spawn async build task for this variant
        buildTasks.push((async () => {
          const fingerprint = this.variantFingerprint(baseSet, profile.name, ctx)
          let cachedSet: StrategySet | null = null

          // Check fingerprint cache (fast path)
          if (fpCache[fingerprint]) {
            let cached = StrategyCoordinator._fpLruGet(fingerprint)
            if (cached === undefined) {
              try {
                cached = JSON.parse(fpCache[fingerprint]) as StrategySet
                if (cached) StrategyCoordinator._fpLruSet(fingerprint, cached)
              } catch { /* fall through — regenerate on parse failure */ }
            }
            if (cached && Array.isArray(cached.entries) && cached.entries.length > 0) {
              if (baseSet.trailingProfile && !cached.trailingProfile) {
                cached.trailingProfile = baseSet.trailingProfile
              }
              cachedSet = cached
              nextFpCache[fingerprint] = fpCache[fingerprint]
            }
          }

          // If not cached, build fresh
          let built: StrategySet | null = null
          if (!cachedSet) {
            built = await this.buildVariantSet(baseSet, profile, metrics, maxEntries, symbolCtx)
            if (built) {
              if (baseSet.trailingProfile) built.trailingProfile = baseSet.trailingProfile
              nextFpCache[fingerprint] = JSON.stringify(built)
              StrategyCoordinator._fpLruSet(fingerprint, built)
            }
          }

          return { baseSet, profile, built, fingerprint, cachedSet }
        })())
      }
    }

    // ── Await all async builds to complete ───────────────────────────────
    const results = await Promise.all(buildTasks)
    
    // ── Process results and populate mainSets ────────────────────────────
    for (const result of results) {
      const { baseSet, profile, built, cachedSet } = result
      const set = cachedSet || built
      if (!set) continue

      mainSets.push(set)
      if (profile.name === "default") defaultByBaseKey.set(baseSet.setKey, set)
      if (cachedSet) reused++
    }

    // ── Log min-pos skip count (diagnostic) ───────────────────────
    // Surface the number of Base Sets that didn't meet `mainEvalPosCount`
    // at this cycle so the operator can see when the threshold is
    // throttling promotion. Non-critical; debug level.
    if (skippedLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "main_stage",
        "debug",
        `Main min-pos gate skipped ${skippedLowPos}/${baseSets.length} (threshold=${mainMinPos})`,
        { symbol, skippedLowPos, threshold: mainMinPos, baseTotal: baseSets.length },
      ).catch(() => {})
    }

    // ── 3. Position-Count Cartesian fan-out (operator spec) ──────────
    //
    // For each Base that yielded a `default` Main variant, emit:
    //
    //   prev (PF-filtered) × last (outcome-tagged) × cont × dir
    //
    // Axis Sets are pure projections of the parent default — they
    // inherit PF / DDT / conf / trailingProfile, carry a synthetic representative entry,
    // and tag `axisWindows.{prev,last,cont,direction,outcome,axisKey}`
    // so Real-stage hedge netting can bucket them by
    // `(symbol × ind × triple × outcome)`.
    //
    // Per-cycle recompute is intentional ("No Lock, handle after
    // situation"). The hedge-net delta + Live partial open/close path
    // takes care of accumulating continuous-count positions and
    // adjusting exchange exposure as new entries land.
    let axisSetsAdded = 0
    if (defaultByBaseKey.size > 0) {
      const minPF = metrics.minProfitFactor   // Same gate as Base→Main
      // Live continuous-count snapshot from the **per-symbol** position
      // context (continuousCount on `symbolCtx` was already patched to
      // `ctx.perSymbolOpen[symbol]` at line ~1339). Capping each axis
      // Set's `entryCount` by this value (inside expandAxisSets) is what
      // makes the axis fan-out reflect the operator-spec'd "ongoing
      // continuous count of Pis to be added, counted onto the new sets"
      // instead of static projections. Per-symbol is correct because
      // axis Sets and their hedge bucketing are scoped to one symbol.
      const liveCont = symbolCtx?.continuousCount ?? 0
      for (const defaultSet of defaultByBaseKey.values()) {
        const expanded = this.expandAxisSets(defaultSet, minPF, liveCont)
        for (const axisSet of expanded) {
          mainSets.push(axisSet)
          axisSetsAdded++
        }
      }
      if (axisSetsAdded > 0) {
        // Axis fan-out complete — each qualifying default Main variant
        // has been projected into the operator-spec'd Cartesian product
        // (prev × last × cont × direction). This is the "additional Sets"
        // creation per the strategy flow spec.
        logProgressionEvent(this.connectionId, "main_stage", "debug", `Axis fan-out: +${axisSetsAdded} liveCont=${liveCont}`, {
          symbol,
          axisSets: axisSetsAdded,
          defaults: defaultByBaseKey.size,
          liveCont,
        }).catch(() => {}) // non-critical
      }
    }

    // ─── VARIANT accounting ───────────────────────�������───────────────────────
    // Each related Main Set now carries an authoritative `variant` tag set
    // at build time, so we no longer have to heuristically classify
    // individual entries. Entries within a Set share the variant label.
    // Legacy entry-level classifier is kept as a fallback for any caller
    // that produces a Set without the variant field (back-compat safety).
    const classifyVariant = (e: StrategySetEntry): "default" | "trailing" | "block" | "dca" => {
      if (e.positionState === "reduce" || e.positionState === "close") return "dca"
      if (e.positionState === "add" || e.sizeMultiplier >= 1.5)        return "block"
      if (e.positionState === "new"  && e.leverage       >= 3)         return "trailing"
      return "default"
    }

    // Per-variant aggregates accumulated over all main sets in THIS cycle.
    // We write the per-variant totals with hincrby so they remain cumulative
    // across cycles (mirrors the per-stage hincrby pattern used elsewhere).
    type VariantAgg = {
      sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
    }
    const variantAgg: Record<string, VariantAgg> = {
      default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
    }
    for (const set of mainSets) {
      const setVariant = set.variant ?? (set.entries[0] ? classifyVariant(set.entries[0]) : "default")
      variantAgg[setVariant].setsContaining += 1
      variantAgg[setVariant].passedSets     += 1
      for (const entry of set.entries) {
        variantAgg[setVariant].entries += 1
        variantAgg[setVariant].sumPF   += Number(entry.profitFactor || 0)
        variantAgg[setVariant].sumDDT  += Number(entry.drawdownTime || 0)
      }
    }

    // Persist MAIN sets + fingerprint cache. Fingerprint cache has a short
    // TTL so stale entries don't re-surface after context changes settle.
    const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
    await setSettings(mainKey, { sets: mainSets, count: mainSets.length, created: new Date() })
    try {
      if (Object.keys(nextFpCache).length > 0) {
        // Replace the cache atomically so deletions take effect (a Set that
        // no longer qualifies simply isn't re-written and falls out on TTL).
        await client.del(fpCacheKey).catch(() => {})
        await client.hset(fpCacheKey, nextFpCache)
        await client.expire(fpCacheKey, 300) // 5 min TTL
      }
    } catch { /* non-critical */ }

    // ── Main-stage aggregate metrics (all at method-body scope) ─────────────
    const mainEntriesTotal     = mainSets.reduce((s, st) => s + (st.entryCount || 0), 0)
    const mainAvgPosPerSet     = mainSets.length > 0 ? mainEntriesTotal / mainSets.length : 0
    const mainAvgPF            = mainSets.length > 0 ? mainSets.reduce((s, st) => s + st.avgProfitFactor, 0) / mainSets.length : 0
    const mainAvgDDT           = mainSets.length > 0 ? mainSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / mainSets.length : 0
    const mainDetailKey        = `strategy_detail:${this.connectionId}:main`

    // Count only profile-variant Sets (no axis fan-out) for main_positions_created_count.
    // Used in the Redis write block below; declared here so it's in scope for the write.
    const mainProfileEntriesTotal = mainSets
      .filter((s) => !s.axisWindows?.direction)
      .reduce((sum, s) => sum + (s.entryCount ?? 0), 0)

    const axisSetsCount = mainSets.filter(s => s.axisWindows).length
    const axisLong = mainSets.filter(s => s.axisWindows?.direction === "long").length
    const axisShort = mainSets.filter(s => s.axisWindows?.direction === "short").length

    // ── Build uniqueBaseSetsProduced and passRatioMain ────────────────────
    const uniqueBaseSetsProduced = new Set<string>()
    for (const s of mainSets) uniqueBaseSetsProduced.add(s.parentSetKey ?? s.setKey)
    // BASE->MAIN pass rate = fraction of Base Sets that produced ≥1 variant.
    // Using mainSets.length/baseSets.length inflates the ratio by 320×
    // (full axis fan-out); uniqueBaseSetsProduced.size is the correct numerator.
    const passRatioMain = baseSets.length > 0
      ? Math.min(1, uniqueBaseSetsProduced.size / baseSets.length)
      : 0

    // ── Write Main counts to Redis ──���─────────────────────────────────────
    // CUMULATIVE via hincrby so the dashboard does not oscillate with
    // per-cycle snapshots (see matching fix in createBaseSets).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`

      // ── Running-now resolution for Main (cloned/filtered Sets) ──
      const cache = this._activeKeysCache
      const cacheFresh = cache && Date.now() - cache.cycleAt < 30_000
      const activeKeys = cacheFresh
        ? cache!.keys
        : new Set<string>(
            (await client
              .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
              .catch(() => [])) as string[],
          )
      const mainRunningNow = mainSets.filter((s) => {
        const parent = s.parentSetKey || s.setKey.split("#")[0]
        return activeKeys.has(parent)
      }).length

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_main_current", String(mainSets.length)),
        client.hset(mainDetailKey, {
          created_sets:      String(mainSets.length),
          avg_profit_factor: String(mainAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(mainAvgDDT)),
          avg_pos_per_set:   String(mainAvgPosPerSet.toFixed(2)),
          entries_total:     String(mainEntriesTotal),
          entries_count:     String(mainEntriesTotal),
          axis_sets:         String(axisSetsAdded),
          evaluated:         String(mainSets.length),
          passed_sets:       String(mainSets.length),
          pass_rate:         String(passRatioMain.toFixed(4)),
          count_pos_eval:    String(mainSets.length),
          sets_running_now:         String(mainRunningNow),
          sets_with_open_positions: String(mainRunningNow),
          sets_progressing:         String(mainSets.filter((s) => (s.entryCount || 0) > 0).length),
          updated_at:        String(Date.now()),
          [`s:${symbol}:created`]:    String(mainSets.length),
          [`s:${symbol}:entries`]:    String(mainEntriesTotal),
          [`s:${symbol}:running`]:    String(mainRunningNow),
          [`s:${symbol}:progressing`]: String(mainSets.filter((s) => (s.entryCount || 0) > 0).length),
          [`s:${symbol}:passed`]:     String(mainSets.length),
          [`s:${symbol}:evaluated`]:  String(mainSets.length),
          [`s:${symbol}:apf`]:        String(mainAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(mainAvgDDT)),
          [`s:${symbol}:apps`]:       String(mainAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(mainDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:base`, {
          passed_sets: String(baseSets.length),
          pass_rate:   String(passRatioMain.toFixed(4)),
          [`s:${symbol}:passed`]: String(baseSets.length),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:main:count`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:evaluated`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:base:passed`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:main:count`, 86400),
        client.expire(`strategies:${this.connectionId}:main:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:base:passed`, 86400),
      ]
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_total", mainSets.length))
      if (baseSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_evaluated", baseSets.length))

      const relatedCreated = mainSets.length - reused
      const activeVariantNames = activeVariants.map((p) => p.name)
      writes.push(
        client.hincrby(redisKey, "strategies_main_related_created", relatedCreated),
        client.hincrby(redisKey, "strategies_main_related_reused",  reused),
        client.hincrby(redisKey, "strategies_main_cycles",          1),
        client.hset(redisKey, {
          strategies_main_active_variants:      activeVariantNames.join(","),
          strategies_main_active_variant_count: String(activeVariantNames.length),
          strategies_main_last_reused:          String(reused),
          strategies_main_last_created:         String(relatedCreated),
          strategies_main_ctx_continuous:       String(ctx.continuousCount),
          strategies_main_ctx_last_wins:        String(ctx.lastWins),
          strategies_main_ctx_last_losses:      String(ctx.lastLosses),
          strategies_main_ctx_prev_losses:      String(ctx.prevLosses),
          strategies_main_ctx_prev_total:       String(ctx.prevPosCount),
          strategies_main_ctx_updated_at:       String(Date.now()),
        }),
      )

      // ── Position count metrics for main stage ──
      // Only count profile-variant Sets (no axis fan-out) for this counter.
      if (mainProfileEntriesTotal > 0) {
        writes.push(client.hincrby(redisKey, "main_positions_created_count", mainProfileEntriesTotal))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 2) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)
    } catch { /* non-critical — Redis write failure should not kill strategy flow */ }

    if (baseSets.length > 0) {
    }

    return {
      result: {
        type: "main",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: mainSets.length,
        // failedEvaluation = Base Sets that were explicitly rejected (status=invalid),
        // not baseSets.length - uniqueBaseSetsProduced.size (which undercounts when
        // all Base Set parents appear via axis fan-out but some were still rejected
        // at PF/DDT gate). Counting status=invalid directly is authoritative.
        failedEvaluation: baseSets.filter((s) => s.status === "invalid").length,
        avgProfitFactor: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgProfitFactor, 0) / mainSets.length : 0,
        avgDrawdownTime: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / mainSets.length : 0,
      },
      sets: mainSets,
    }
  }

  // ─── STAGE 3: REAL ────────────────────────────────────────────────────────��──

  /**
   * Create pseudo positions from REAL sets for dashboard visualization.
   * Each REAL set should have at least one pseudo position so it shows on the
   * dashboard as "open" in the strategies view. This is for evaluation/display only.
   */
  private async createPseudoPositionsFromRealSets(
    symbol: string,
    realSets: StrategySet[],
  ): Promise<void> {
    try {
      if (!realSets || realSets.length === 0) return

      const client = getRedisClient()
      // PERFORMANCE: previous implementation looped serially with one GET
      // per set followed by 3 sequential writes per surviving set — at N
      // Real Sets per symbol per cycle that was 4N round-trips on the
      // hot path. Now: (1) fan out all dedup GETs into a single Promise.all,
      // (2) batch the 3 writes per surviving set into one Promise.all,
      // collapsing per-set latency to one RTT window each.

      // Pre-compute every set's deterministic identifiers once.
      const setMeta = realSets.map((set) => {
        const setKey     = set.setKey || `${symbol}:${set.direction || "long"}`
        const existingKey = `pseudo_position_set_mapping:${this.connectionId}:${setKey}`
        return { set, setKey, existingKey }
      })

      // Phase 1 — parallel dedup check (N GETs in one batch).
      const existing = await Promise.all(
        setMeta.map((m) => getSettings(m.existingKey).catch(() => null))
      )

      // Phase 2 — for sets that need creation, fan out the 3 writes per set.
      const createdAtIso = new Date().toISOString()
      const nowMs = Date.now()
      const writeBatches: Promise<any>[] = []
      let createdCount = 0

      for (let i = 0; i < setMeta.length; i++) {
        if (existing[i]) continue
        const { set, setKey, existingKey } = setMeta[i]
        try {
          const avgPF       = set.avgProfitFactor || 1
          const entryPrice  = Math.max(1, avgPF * 100)   // unitless proxy
          const quantity    = set.entryCount || 1
          const positionCost = entryPrice * quantity

          const pseudoPos = {
            id: `pseudo-${this.connectionId}-${setKey}-${nowMs}`,
            connectionId: this.connectionId,
            symbol,
            direction: set.direction || "long",
            entry_price: entryPrice,
            quantity,
            position_cost: positionCost,
            status: "open",
            position_level: "real",
            config_set_key: setKey,
            source_set_key: setKey,
            created_at: createdAtIso,
            profit_factor: set.avgProfitFactor || 0,
            confidence: set.avgConfidence || 0,
          }

          // 3 writes per set, executed concurrently (one RTT window).
          writeBatches.push(
            Promise.all([
              setSettings(`pseudo_position:${this.connectionId}:${pseudoPos.id}`, pseudoPos),
              client.sadd(`pseudo_positions:${this.connectionId}`, pseudoPos.id),
              setSettings(existingKey, { posId: pseudoPos.id, createdAt: nowMs }),
            ]).catch((err) => {
              console.warn(`[StrategyFlow] Failed to create pseudo position for set ${setKey}:`, err)
            })
          )
          createdCount++
        } catch (err) {
          console.warn(`[StrategyFlow] Failed to prep pseudo position for set ${setKey}:`, err)
        }
      }

      // Final fan-in — all surviving sets' writes execute together.
      if (writeBatches.length > 0) {
        await Promise.all(writeBatches)
      }

    } catch (error) {
      console.warn(`[v0] Error creating pseudo positions from REAL sets for ${symbol}:`, error)
    }
  }

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let stored: any = null
    if (!inputSets) {
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      stored = await getSettings(mainKey)
    }
    const mainSets: StrategySet[] = inputSets ?? (stored?.sets || [])

    const metrics = this.METRICS.real

    // ── Stage-validation min-position threshold (operator spec, systemwide fix) ────
    // Same semantics as Main: Sets below `realEvalPosCount` are
    // MARKED as invalid with status flag — they're not validated against PF/DDT
    // and not promoted to Real, but kept in map for re-evaluation on subsequent
    // cycles once entryCount accumulates. Default 10.
    //
    // For NEW systems with no history (baseEC=0, liveCont=0),
    // don't reject sets purely on entryCount. If a set has at least 1 synthetic
    // entry (axis Sets always have entries for synthetic tracking), it should
    // pass the gate and be evaluated on PF/DDT merit. This allows fresh
    // connections to start generating positions on cycle 1.
    const realMinPos = this._coordinationSettings.realEvalPosCount
    const beforePosGate = mainSets.length
    const mainSetsEligible = mainSets.map((s) => {
      const live = s.entryCount ?? s.entries?.length ?? 0
      const hist = s.prevPos?.count ?? 0
      const posCount = Math.max(live, hist)
      
      // ALLOW axis Sets with synthetic entries even if posCount < realMinPos
      // (new systems need a way to start generating positions)
      const hasEntries = (s.entries?.length ?? 0) > 0
      const isAxisSet = s.axisWindows && s.axisWindows.direction
      if (posCount < realMinPos && !(isAxisSet && hasEntries)) {
        // Mark as invalid but keep for later evaluation
        s.status = "invalid"
        s.rejectionReason = `insufficient_pos_count: ${posCount}/${realMinPos}`
        return s
      }
      return s
    })
    // Don't filter out - keep all sets including marked-invalid ones for re-evaluation
    const skippedRealLowPos = mainSetsEligible.filter(s => s.status === "invalid" && s.rejectionReason?.includes("insufficient_pos_count")).length
    if (skippedRealLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `Real min-pos gate marked ${skippedRealLowPos}/${beforePosGate} as invalid (threshold=${realMinPos})`,
        { symbol, skippedLowPos: skippedRealLowPos, threshold: realMinPos, mainTotal: beforePosGate },
      ).catch(() => {})
    }

    // P0-2: Real filter axes are PF-min + DDT-max ONLY. Confidence is
    // advisory metadata and is not part of the filter predicate.
    // Mark status on mainSetsEligible for efficient tracking
    const realQualifying = mainSetsEligible.filter(
      (s) => {
        // Skip already-marked invalid (insufficient positions)
        if (s.status === "invalid" && s.rejectionReason?.includes("insufficient_pos_count")) {
          return false
        }
        
        const passes = s.avgProfitFactor >= metrics.minProfitFactor &&
                      s.avgDrawdownTime <= metrics.maxDrawdownTime
        if (passes) {
          s.status = "valid_real"
        } else {
          s.status = "invalid"
          if (s.avgProfitFactor < metrics.minProfitFactor) {
            s.rejectionReason = `real_low_pf: ${s.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
          } else {
            s.rejectionReason = `real_high_ddt: ${s.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
          }
        }
        return passes
      }
    )

    // ── PRIORITY SORT: better Sets first ─────────────────��────────────
    // Per user spec: "arrange so that better Sets have priority". We sort
    // descending by `avgProfitFactor` �� the same metric Live uses for its
    // top-N selection at line 1182 — so when the downstream Live stage
    // (and any per-direction Pos limit) takes the head of the list it
    // gets the highest-quality Sets first. The `maxRealSets` cap is
    // applied AFTER sorting so the trim keeps the best ones.
    const realSorted = [...realQualifying].sort(
      (a, b) => b.avgProfitFactor - a.avgProfitFactor,
    )

    // ── HEDGE NETTING (operator spec: Real stage only) ───────────────────
    //
    // The Main-stage Position-Count Cartesian emits a long/short pair for
    // every (prev × last × cont × outcome) tuple. Real collapses that to
    // the NET direction per bucket so Live only opens positions where the
    // realised signal is asymmetric.
    //
    // EXCEPTION: Axis Sets (position-count fan-out projections) are NOT
    // subject to netting. Each axis Set represents a valid position-count
    // configuration and both long/short should flow to Live independently.
    // Netting axis Sets would eliminate the entire position-count range
    // being tested (e.g., if cont=3 long and short both exist, netting
    // them cancels the intent to test cont=3 in both directions).
    // Profile-variant Sets (default, trailing, block, DCA) still participate
    // in netting since their long/short pairs represent hedging signal.
    //
    // Bucket identity: `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
    //   • Profile-variant Sets (no `axisWindows.direction`): participate in netting
    //   • Axis Sets: pass through unchanged — SKIP netting entirely
    //   • Outcome is part of the bucket: pos and neg Sets represent
    //     different realised market regimes and must NOT cancel each
    //     other.
    //   • Within bucket: keep |L − S| Sets in the dominant direction
    //     (PF-sorted by parent `realSorted` order). If L == S → drop
    //     both sides (perfect hedge → no exchange exposure for this
    //     bucket).
    //
    // Per-bucket net target is persisted to `live_net_target:{conn}` so
    // the Live exchange layer can reconcile via partial-open / partial-
    // close orders when the dominant direction or magnitude changes
    // between cycles.
    type HedgeBucket = { long: StrategySet[]; short: StrategySet[] }
    const hedgeBuckets = new Map<string, HedgeBucket>()
    const passthrough: StrategySet[] = []
    const axisPassthrough: StrategySet[] = []
    let axisSetsCounted = 0
    for (const s of realSorted) {
      const dir = s.axisWindows?.direction
      if (!dir || !s.axisWindows) { 
        passthrough.push(s)
        continue 
      }
      // Axis Sets bypass hedge netting — each axis tuple is a valid config
      axisPassthrough.push(s)
      axisSetsCounted++
    }
    const netted: StrategySet[] = []
    const netTargetWrites: Record<string, string> = {}
    let netCancelled = 0
    for (const s of passthrough) {
      const aw = s.axisWindows
      if (!aw) { netted.push(s); continue }
      const outcome = aw.outcome ?? "pos"
      const parentKey = s.parentSetKey ?? s.setKey.split("#")[0]
      const bucketKey = `${parentKey}|${symbol}|${s.indicationType}|p${aw.prev}|l${aw.last}|c${aw.cont}|o${outcome}`
      let b = hedgeBuckets.get(bucketKey)
      if (!b) { b = { long: [], short: [] }; hedgeBuckets.set(bucketKey, b) }
      const dir = s.direction ?? "long"
      if (dir === "short") b.short.push(s); else b.long.push(s)
    }

    // Apply hedge netting only to profile-variant Sets
    for (const [bucketKey, b] of hedgeBuckets) {
      const L = b.long.length
      const S = b.short.length
      if (L === S) {
        netCancelled += L + S
        netTargetWrites[bucketKey] = "flat:0"
        continue
      }
      const winnerDir: "long" | "short" = L > S ? "long" : "short"
      const winnerPool                  = L > S ? b.long : b.short
      const remainder                   = Math.abs(L - S)
      // PF-desc preserved by `realSorted` upstream → winnerPool is best-first.
      netted.push(...winnerPool.slice(0, remainder))
      // Cancelled = total inputs minus survivors.
      //   total   = L + S
      //   survivors = remainder = |L − S|
      //   cancelled = (L + S) − |L − S| = 2 × min(L, S)
      //
      // Previous formula `min(L,S)*2 + max(0, winnerPool.length − remainder)`
      // overcounted: winnerPool.length = max(L,S), so the extra term adds
      // max(L,S) − |L−S| = min(L,S) — doubling the min(L,S) cancellation.
      // E.g. L=5, S=3 → previous gave 6+3=9 but correct is (5+3)−2=6.
      netCancelled += L + S - remainder
      netTargetWrites[bucketKey] = `${winnerDir}:${remainder}`
    }

    // `netted` already contains BOTH:
    //   (1) profile-variant Sets without axisWindows (direct pass-through at line 2160)
    //   (2) hedge-bucket survivors (winnerPool.slice(0, remainder) at line 2183)
    // Using `[...passthrough, ...netted, ...]` would double-count every Set that
    // entered a hedge bucket AND survived — it appears in passthrough (input to
    // bucketing) and again in netted (winning output). Correct form uses netted only.
    const realPostHedge = [...netted, ...axisPassthrough].sort(
      (a, b) => b.avgProfitFactor - a.avgProfitFactor,
    )

    if (hedgeBuckets.size > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `${symbol} REAL hedge-net: ${hedgeBuckets.size} buckets, ${netted.length} survivors, ${netCancelled} profile-variant pairs cancelled`,
        {
          symbol,
          buckets:   hedgeBuckets.size,
          survivors: netted.length,
          cancelled: netCancelled,
          axis:      axisPassthrough.length,
        },
      ).catch(() => {})
    }

    // Resolve the cap with this precedence:
    //   1. Operator-set `maxRealSets` in Settings → System (Redis app_settings)
    //   2. Per-instance config override (if any caller passed one)
    // ── Real Sets cap ─────────────────────────────────────────────���──
    // Per-spec: Strategies (Real Sets) are unlimited. Previously we
    // clamped to `maxRealSets` (default 12000); now we pass all
    // qualifying Real Sets to the Live stage. The operator still gates
    // via preset inclusion, profit-factor minimums, and coordination
    // toggles ��� removing this funnel cap lifts the ceiling without
    // sacrificing control.
    // For future use: if we need to re-cap (e.g. for perf), read the
    // operator's `maxRealSets` setting and apply it here. For now,
    // slice(0, Infinity) is a no-op.
    const realSets = realPostHedge.slice(0, this.config.maxRealSets ?? Infinity)

    // ── Real-stage tuner — per-variant adjustments from Base prev-pos ──
    //
    // Operator spec: "at stage Real, do the accumulation for pos cnts
    // sets relying to their base sets configs INDEPENDENT" + "Adjust
    // strategies Block, DCA, pos coord, ratios, volume".
    //
    // We mutate every Real Set's entries in-place to bias the live-stage
    // sizing/leverage decisions by the historic realised performance of
    // the parent Base Set's (symbol × ind × dir) bucket. No exchange-
    // facing change yet — Live consumes `entries[].sizeMultiplier` and
    // `leverage` directly. Tuning is BOUNDED ([0.5, 1.5] for size, max
    // 2× leverage from base) so a noisy/empty bucket can never explode
    // exposure; below the threshold we no-op.
    //
    // Per-Base ledger (`real_pi_acc:{conn}` HASH, key = parentSetKey)
    // is incremented for every Real Set produced — that's the dashboard
    // accumulation column.
    try {
      const { bumpRealPosAccumulation, bumpValidPositions, bumpAxisPosAccumulation, bumpHedgePosAccumulation } = await import(
        "@/lib/pos-history",
      )
      const realActiveKeysForVP = await (async () => {
        try {
          const c = getRedisClient()
          return new Set<string>(
            (await c
              .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
              .catch(() => [])) as string[],
          )
        } catch { return new Set<string>() }
      })()
      const accPipeline = getRedisClient().multi()
      for (const s of realSets) {
        const parentKey = s.parentSetKey || s.setKey.split("#")[0]
        bumpRealPosAccumulation(this.connectionId, parentKey, 1, accPipeline)

        // ── Hedge pos-count accumulation per base Set (operator spec) ─
        // "Do the accumulations for pos counts Sets at stage Real
        // (hedging long, short for related same base Set)."
        //
        // For every Real Set, increment the per-Base hedge ledger by the
        // Set's entryCount in its direction (long or short). This builds
        // up the cumulative picture of how many position-slots each Base
        // Set is running per side across all cycles, enabling net-hedge
        // posture reads (long − short) per Base Set without a full scan.
        // entryCount is used (not 1) so axis Sets with larger windows
        // contribute proportionally to the hedge totals.
        const hedgeDir = (s.axisWindows?.direction ?? s.direction ?? "long") as "long" | "short"
        const hedgeEC  = s.entryCount > 0 ? s.entryCount : 1
        bumpHedgePosAccumulation({
          connectionId: this.connectionId,
          parentSetKey: parentKey,
          direction:    hedgeDir,
          entryCount:   hedgeEC,
          externalPipeline: accPipeline,
        })

        // ── Per-axis-Set continuous-count ledger (operator spec) ─────
        // For axis Sets (the prev × last × cont × outcome × dir
        // Cartesian fan-out at Main), record the rolling continuous
        // count of Pis that have actually accumulated onto this axis
        // bucket. Increment by `s.entryCount` (= baseEC + min(cont,
        // liveCont) from expandAxisSets) so the ledger is the
        // continuous-count rolling sum across cycles — exactly the
        // metric the operator described as "ongoing continuous count
        // of Pis to be added, counted onto the new sets". Pipelined
        // alongside the existing accumulation writes for zero added
        // round-trips.
        if (s.axisWindows?.axisKey && s.entryCount > 0) {
          bumpAxisPosAccumulation(
            this.connectionId,
            parentKey,
            s.axisWindows.axisKey,
            s.entryCount,
            accPipeline,
          )
        }

        // ── Variant tuning ──
        // Block (size scaling) / DCA (leverage cap & DDT bias proxy) /
        // pos-coord axis Sets (entries[].sizeMultiplier) / default+trailing
        // (size only). All clamped to operator-safe bounds.
        const pos = s.prevPos
        if (pos && pos.count > 0) {
          // Bias factor in [0.6, 1.4] derived from successRate (0.45 = neutral).
          // Maps PF ≥ 1.5 → boost, PF < 0.8 → cut. Smooth so small PF wobbles
          // don't cause jagged size jumps cycle-over-cycle.
          const sr = Math.max(0, Math.min(1, pos.successRate))
          const pfBias = pos.profitFactor <= 0
            ? 0.85
            : Math.max(0.6, Math.min(1.4, 0.7 + 0.5 * Math.tanh(pos.profitFactor - 1.0)))
          const sigBias = Math.max(0.7, Math.min(1.3, 0.7 + 1.2 * sr))
          const combined = (pfBias + sigBias) / 2

          for (const e of s.entries) {
            // Variant-specific tuning rules.
            if (s.variant === "block") {
              // Block scales size — bias the existing multiplier directly.
              e.sizeMultiplier = Math.max(0.5, Math.min(2.0, e.sizeMultiplier * combined))
            } else if (s.variant === "dca") {
              // DCA recovery — only ATTENUATE leverage when historic PF poor;
              // never amplify (recovery gambling is an anti-pattern).
              if (pfBias < 1.0) {
                e.leverage = Math.max(1, Math.floor(e.leverage * pfBias))
                e.sizeMultiplier = Math.max(0.3, e.sizeMultiplier * pfBias)
              }
            } else if (s.axisWindows?.direction) {
              // Position-count axis Set (Cartesian fan-out). Apply both
              // sides of the bias — these are the "pos coord, ratios"
              // family from the spec.
              e.sizeMultiplier = Math.max(0.5, Math.min(1.5, e.sizeMultiplier * combined))
            } else {
              // default / trailing / pause — modest size bias, leverage left alone.
              e.sizeMultiplier = Math.max(0.5, Math.min(1.5, e.sizeMultiplier * combined))
            }
          }
          // Recompute aggregate PF/DDT after entry mutation so downstream
          // ranking / filtering sees current values (Real already passed
          // its filter pre-tuner, but Live ranks on these).
          if (s.entries.length > 0) {
            s.avgProfitFactor =
              s.entries.reduce((a, e) => a + Number(e.profitFactor || 0), 0) /
              s.entries.length
          }
        }

        // ── Valid Positions counter ──
        // Only count Real Sets whose parent is currently RUNNING (= the
        // "Combined" semantic). All Real Sets contribute to the lifetime
        // "Overall" count regardless of running state.
        // Compose into the shared `accPipeline` so a 30-Set burst writes
        // once instead of 30 times — at 10 symbols this drops Real-stage
        // round-trips by ~10x and is the main reason cycles stay flat
        // past 4 symbols.
        bumpValidPositions({
          connectionId: this.connectionId,
          symbol,
          indicationType: s.indicationType,
          direction: s.direction,
          isRunningNow: realActiveKeysForVP.has(parentKey),
          externalPipeline: accPipeline,
        })
      }
      ;(accPipeline as any).exec().catch((err: any) => {
        console.error(`[v0] [StrategyFlow] ${symbol} accumulation pipeline failed:`, err?.message || err)
      })
    } catch (tunerErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} Real tuner failed:`, tunerErr)
    }

    // Persist per-bucket net targets for the Live-stage partial open/close
    // reconciliation hook. Documented on `reconcileLivePositions` —
    // direction unchanged & magnitude grew → partial OPEN for Δ; direction
    // unchanged & magnitude shrunk → partial CLOSE lowest-PF; direction
    // flipped or flat:0 ��� close all in bucket then optionally re-open.
    if (Object.keys(netTargetWrites).length > 0) {
      try {
        // Inline client — `client` for the broader function is declared
        // further below; we want a one-shot write here without forward
        // ref. The hot-path overhead of a second `getRedisClient()` call
        // is negligible (returns a cached singleton).
        const netClient = getRedisClient()
        const targetKey = `live_net_target:${this.connectionId}`
        await netClient.hset(targetKey, netTargetWrites)
        await netClient.expire(targetKey, 7 * 24 * 60 * 60)
      } catch { /* non-critical */ }
    }

    // Persist REAL sets
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    await setSettings(realKey, { sets: realSets, count: realSets.length, created: new Date() })

    // Hoisted outside the try-block so the return statement (also outside) can see it.
    // Count of Main Sets that actually entered PF/DDT evaluation (excludes pos-count
    // pre-gated sets). Used for correct passRatioReal and evaluated counters.
    const mainPFEligible = mainSetsEligible.filter(
      (s) => !(s.status === "invalid" && s.rejectionReason?.includes("insufficient_pos_count")),
    ).length

    // Write Real counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // doesn't oscillate with per-cycle snapshots (see matching fix in createBaseSets/createMainSets).
    // Per-cycle snapshot is kept in `strategies_real_current` for components that want it.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const realDetailKey = `strategy_detail:${this.connectionId}:real`
      const realAvgPF   = realSets.length > 0 ? realSets.reduce((s, st) => s + st.avgProfitFactor, 0) / realSets.length : 0
      const realAvgDDT  = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / realSets.length : 0
      // Position evaluation real: average confidence of REAL sets
      // (how well did the Real stage filter perform)
      const realAvgConf = realSets.length > 0 ? realSets.reduce((s, st) => s + (st.avgConfidence || 0), 0) / realSets.length : 0
      // passRatioReal = fraction of ELIGIBLE Main Sets (those that reached the
      // PF/DDT gate — not the ones gated out before it by insufficient_pos_count)
      // that passed into Real. Using mainSets.length as the denominator deflates
      // the ratio because mainSets includes the large axis fan-out (~320 Sets per
      // Base Set) while realSets are comparatively few after the PF gate.
      // The correct denominator is the count of Sets that were actually evaluated
      // against PF/DDT criteria (not pre-rejected by the pos-count gate).
      const mainPFEligible = mainSetsEligible.filter(
        (s) => !(s.status === "invalid" && s.rejectionReason?.includes("insufficient_pos_count")),
      ).length
      const passRatioReal = mainPFEligible > 0 ? realSets.length / mainPFEligible : 0
      const realEntriesTotal  = realSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const realAvgPosPerSet  = realSets.length > 0 ? realEntriesTotal / realSets.length : 0
      // Average entryCount per Real Set — identical to realAvgPosPerSet.
      // The previous formula used Math.max(1, entryCount||1) which biased
      // Sets with entryCount=0 upward. Reuse the already-correct value.
      const realAvgPosEval = realAvgPosPerSet

      // ── Running-now resolution for Real ──────────────────────────
      // A Real Set is "running now" only when its originating Base Set is
      // actively coordinating (present in active_config_keys). This mirrors
      // the Main-stage logic and guarantees REAL running <= MAIN running,
      // making the cascade filter visible in the dashboard.
      // Reuse _activeKeysCache populated by createBaseSets this cycle.
      const realActiveCache = this._activeKeysCache
      const realCacheFresh = realActiveCache && Date.now() - realActiveCache.cycleAt < 30_000
      const realActiveBaseKeys = realCacheFresh
        ? realActiveCache!.keys
        : new Set<string>(
            (await client
              .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
              .catch(() => [])) as string[],
          )
      const realRunningNow = realSets.filter((s) => {
        const base = (s.parentSetKey ?? s.setKey).split("#")[0]
        return realActiveBaseKeys.has(base)
      }).length

      // ── Real 4-perspective stats (Overall / Accumulated / General / Combined) ──
      // Per operator spec: "in Strategies Real ensure correct stats..
      // Overall, Accumulated, General, Combined."
      //
      //   - Overall:     cumulative Real Sets ever produced (lifetime).
      //                  Already maintained as `strategies_real_total`
      //                  via hincrby below.
      //   - Accumulated: axis-window accumulation across cycles. Sum of
      //                  the four `strategy_axis_real:{conn}:{axis}`
      //                  hashes (prev × last × cont × pause).
      //   - General:     per-cycle current Real Sets snapshot
      //                  (`strategies_real_current`).
      //   - Combined:    actively-running right now (= realRunningNow).
      //
      // Pre-compute the axis POSITION accumulation sum so the stats route
      // never needs extra round-trips on every dashboard refresh.
      // Source: axis_pos_acc:{conn} — the hash bumpAxisPosAccumulation writes
      // to in the Real tuner loop above. Each field is parentSetKey|axisKey and
      // the value is the cumulative entryCount (= baseEC + min(cont,liveCont))
      // across all cycles — exactly the "Accumulated" perspective the operator
      // described as "ongoing continuous count of Pis added onto the new sets".
      let realAccumulatedSum = 0
      try {
        const axisAccHash = (await client
          .hgetall(`axis_pos_acc:${this.connectionId}`)
          .catch(() => ({} as Record<string, string>))) as Record<string, string>
        for (const v of Object.values(axisAccHash || {})) {
          const num = Number(v)
          if (Number.isFinite(num)) realAccumulatedSum += num
        }
      } catch { /* fallback: 0 */ }

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_real_current", String(realSets.length)),
        client.hset(realDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:       String(realSets.length),
          avg_profit_factor:  String(realAvgPF.toFixed(4)),
          avg_drawdown_time:  String(Math.round(realAvgDDT)),
          avg_pos_eval_real:  String(realAvgPosEval.toFixed(4)),
          avg_pos_per_set:    String(realAvgPosPerSet.toFixed(2)),
          // evaluated = Sets that entered the PF/DDT gate (not pre-gated by pos-count).
          // Using mainSets.length inflates this by the full axis fan-out.
          evaluated:          String(mainPFEligible),
          passed_sets:        String(realSets.length),
          pass_rate:          String(passRatioReal.toFixed(4)),
          count_pos_eval:     String(realSets.length),
          entries_total:      String(realEntriesTotal),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   Real CLONES + FILTERS Main's positions across the
          //   position-count axis. A Real Set is "running" iff its
          //   parentSetKey traces back to a Base Set actively in
          //   active_config_keys.
          sets_running_now:         String(realRunningNow),
          sets_with_open_positions: String(realRunningNow),
          sets_progressing:         String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          // ── 4-perspective Real stats ──────────────────────────────
          // These are connection-wide (not per-symbol) so writing them
          // once per (symbol, cycle) is fine — every symbol computes the
          // same `realAccumulatedSum` and the same `strategies_real_total`.
          stat_general:      String(realSets.length),         // this cycle
          stat_combined:     String(realRunningNow),          // running now
          stat_accumulated:  String(realAccumulatedSum),      // axis sum
          // (Overall is pulled from `strategies_real_total` on read.)
          updated_at:         String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          [`s:${symbol}:created`]:    String(realSets.length),
          [`s:${symbol}:entries`]:    String(realEntriesTotal),
          [`s:${symbol}:running`]:    String(realRunningNow),
          [`s:${symbol}:progressing`]: String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     String(realSets.length),
          [`s:${symbol}:evaluated`]:  String(mainPFEligible),
          [`s:${symbol}:apf`]:        String(realAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(realAvgDDT)),
          [`s:${symbol}:apps`]:       String(realAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:aper`]:       String(realAvgPosEval.toFixed(4)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(realDetailKey, 86400),
        // NOTE: do NOT patch strategy_detail:{conn}:main here. The Main detail
        // already writes its own passed_sets = mainSets.length and
        // pass_rate = passRatioMain (clamped to [0,1]) each Main cycle.
        // Overwriting them with Real's realSets.length would corrupt MAIN's
        // pass statistics and make passed_sets > evaluated impossible to read.
        client.set(`strategies:${this.connectionId}:real:count`, String(realSets.length)),
        client.set(`strategies:${this.connectionId}:real:evaluated`, String(mainPFEligible)),
        client.set(`strategies:${this.connectionId}:main:passed`, String(realSets.length)),
        // ── CRITICAL: Persist Real Sets for Live evaluation ────────────────────
        // Bug fix: Real Sets were computed but never written, causing Live to load
        // an empty array and never fire. Now serialize the full realSets array so
        // createLiveSets can read and filter them for Live stage.
        client.set(
          `strategies:${this.connectionId}:${symbol}:real:sets`,
          JSON.stringify({
            sets: realSets,
            count: realSets.length,
            created: new Date().toISOString(),
            updatedAt: Date.now(),
          }),
        ),
        client.expire(`strategies:${this.connectionId}:real:count`, 86400),
        client.expire(`strategies:${this.connectionId}:real:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:main:passed`, 86400),
        client.expire(`strategies:${this.connectionId}:${symbol}:real:sets`, 86400),
      ]
      // strategies_real_total = cumulative Sets PROMOTED by REAL (output count).
      // strategies_real_evaluated = Main Sets that entered REAL (input count).
      if (realSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_total", realSets.length))
      if (mainPFEligible > 0) writes.push(client.hincrby(redisKey, "strategies_real_evaluated", mainPFEligible))

      // ── ACTIVE-NOW snapshot for Real stage ──────────────────────────
      // Mirrors the Base/Main pattern. The dashboard reads this hash and
      // aggregates to a "Strategies (Real, alive now)" tile. Note this
      // is the COUNT-AFTER-SORT-AND-CAP, i.e. exactly what propagates
      // forward to Live evaluation — not the raw post-filter count.
      writes.push(
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:real`]:           String(realSets.length),
          // real:evaluated = Main Sets that entered PF evaluation (excludes
          // pos-count pre-gated Sets). Cross-symbol sum in stats route will
          // match stratCounts.real denominator exactly.
          [`${symbol}:real:evaluated`]: String(mainPFEligible),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
      )

      // ── P1-1: Real-stage per-variant aggregation ───────────���────────
      // Same shape as Main's `variantAgg` but computed over the Real
      // output (post-PF/DDT filter). Lets the stats API answer "how
      // much of Real is Default vs Adjust{Block, DCA} vs Trailing?"
      // without re-scanning every set on read.
      type RealVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
      }
      const realVariantAgg: Record<string, RealVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      }
      for (const set of realSets) {
        const setVariant = (set.variant as keyof typeof realVariantAgg) ?? "default"
        realVariantAgg[setVariant].setsContaining += 1
        realVariantAgg[setVariant].passedSets     += 1
        for (const entry of set.entries) {
          realVariantAgg[setVariant].entries += 1
          realVariantAgg[setVariant].sumPF   += Number(entry.profitFactor || 0)
          realVariantAgg[setVariant].sumDDT  += Number(entry.drawdownTime || 0)
        }
      }
      for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
        const agg = realVariantAgg[variant]
        if (agg.entries === 0) continue
        const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
        writes.push(
          client.hincrby(vKey, "entries_count",  agg.entries),
          client.hincrby(vKey, "created_sets",   agg.setsContaining),
          client.hincrby(vKey, "passed_sets",    agg.passedSets),
          client.hincrby(vKey, "sum_pf_x1000",   Math.round(agg.sumPF * 1000)),
          client.hincrby(vKey, "sum_ddt_x10",    Math.round(agg.sumDDT * 10)),
          client.hset(vKey, { updated_at: new Date().toISOString() }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // ── POSITION-COUNT AXIS ACCUMULATION (Real stage) ──────────────
      // Per spec: "Do the Additional Sets / Position Counts Accumulation
      // in Strategies Real instead of in Main". The axis windows are
      // tagged at Main creation time but the cumulative accumulation
      // (across cycles) is tracked HERE so the dashboard can show how
      // many Real Sets exist per axis window over time.
      //
      // Axes (per axisWindows definition in StrategySet):
      //   prev:  0..12   (closed lookback window)
      //   last:  0..4    (last-N magnitude window)
      //   cont:  0..8    (open continuous positions)
      //   pause: 0..8    (last-N validation window)
      //
      // Direction split: axis Sets are emitted in both `long` and `short`
      // directions (CARTESIAN in expandAxisSets). Accumulation is keyed by
      // direction so the dashboard can show pos-count distribution per
      // direction relative to the base set config. Key format:
      //   `strategy_axis_real:{conn}:{axis}:{dir}` → hash of { window → count }
      //
      // An undifferentiated (direction-combined) copy is ALSO written to
      // `strategy_axis_real:{conn}:{axis}` so existing consumers that read
      // only the combined key keep working without a migration.
      type DirAxisCounts = Record<"prev" | "last" | "cont" | "pause", Record<string, number>>
      const axisCounts:     DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsLong: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsShort: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }

      for (const set of realSets) {
        const aw = set.axisWindows
        if (!aw) continue
        // Direction for this axis Set: axisWindows.direction (populated by
        // expandAxisSets) if present, otherwise fall back to the Set's own
        // top-level direction field.
        const dir: "long" | "short" | undefined = aw.direction ?? (set.direction as "long" | "short" | undefined)
        for (const axis of ["prev", "last", "cont", "pause"] as const) {
          const w = aw[axis]
          if (typeof w !== "number") continue
          const key = String(w)
          axisCounts[axis][key]      = (axisCounts[axis][key]      || 0) + 1
          if (dir === "long")  axisCountsLong[axis][key]  = (axisCountsLong[axis][key]  || 0) + 1
          if (dir === "short") axisCountsShort[axis][key] = (axisCountsShort[axis][key] || 0) + 1
        }
      }
      for (const axis of ["prev", "last", "cont", "pause"] as const) {
        // Combined (direction-agnostic) — backwards-compatible key
        const aKey      = `strategy_axis_real:${this.connectionId}:${axis}`
        // Direction-split keys — per-spec granularity
        const aKeyLong  = `strategy_axis_real:${this.connectionId}:${axis}:long`
        const aKeyShort = `strategy_axis_real:${this.connectionId}:${axis}:short`
        let touched = false
        for (const [window, count] of Object.entries(axisCounts[axis])) {
          if (count <= 0) continue
          touched = true
          writes.push(client.hincrby(aKey, window, count))
        }
        let touchedLong = false
        for (const [window, count] of Object.entries(axisCountsLong[axis])) {
          if (count <= 0) continue
          touchedLong = true
          writes.push(client.hincrby(aKeyLong, window, count))
        }
        let touchedShort = false
        for (const [window, count] of Object.entries(axisCountsShort[axis])) {
          if (count <= 0) continue
          touchedShort = true
          writes.push(client.hincrby(aKeyShort, window, count))
        }
        if (touched)      writes.push(client.expire(aKey,      7 * 24 * 60 * 60))
        if (touchedLong)  writes.push(client.expire(aKeyLong,  7 * 24 * 60 * 60))
        if (touchedShort) writes.push(client.expire(aKeyShort, 7 * 24 * 60 * 60))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 3) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)

      // Second pass — derive averages from freshly-incremented counters
      // so the stats API can read them without recomputing.
      try {
        const recompute: Promise<any>[] = []
        for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
          if (realVariantAgg[variant].entries === 0) continue
          const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
          recompute.push(
            (async () => {
              const h = ((await client.hgetall(vKey).catch(() => null)) || {}) as Record<string, string>
              const entriesCount = Number(h.entries_count  || "0")
              const createdSets  = Number(h.created_sets   || "0")
              const sumPfX1000   = Number(h.sum_pf_x1000   || "0")
              const sumDdtX10    = Number(h.sum_ddt_x10    || "0")
              const avgPF  = entriesCount > 0 ? (sumPfX1000  / 1000) / entriesCount : 0
              const avgDDT = entriesCount > 0 ? (sumDdtX10   / 10)   / entriesCount : 0
              const avgPosPerSet = createdSets > 0 ? entriesCount / createdSets : 0
              const passRate = createdSets > 0 ? (Number(h.passed_sets || "0") / createdSets) : 0
              await client.hset(vKey, {
                avg_profit_factor: avgPF.toFixed(4),
                avg_drawdown_time: avgDDT.toFixed(2),
                avg_pos_per_set:   avgPosPerSet.toFixed(2),
                pass_rate:         passRate.toFixed(4),
              })
            })(),
          )
        }
        await Promise.all(recompute)
      } catch { /* non-critical */ }
    } catch { /* non-critical */ }

    // ── Position count metrics for real stage ──────────────────────
    // Track entries passing Real filter so dashboard shows promotion success
    const realEntriesTotal = realSets.reduce((sum, s) => sum + (s.entryCount ?? 0), 0)
    try {
      const client = getRedisClient()
      const progKey = `progression:${this.connectionId}`
      if (realEntriesTotal > 0) {
        await client.hincrby(progKey, "real_positions_created_count", realEntriesTotal)
      }
    } catch { /* non-critical */ }

    return {
      result: {
        type: "real",
        symbol,
        timestamp: new Date(),
        // totalCreated = Sets that entered PF evaluation (axis fan-out excluded from denominator).
        totalCreated: mainPFEligible,
        passedEvaluation: realSets.length,
        failedEvaluation: mainPFEligible - realSets.length,
        avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
        avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
      },
      sets: realSets,
    }
  }

  // ─── STAGE 4: LIVE ─────────����──────────��─────����──────────────────────���────────

  /**
   * Select the best 500 Sets from REAL for live trading.
   * Creates exactly ONE pseudo position per Set (per indication_type × direction).
   */
  private async createLiveSets(
    symbol: string,
    inputSets?: StrategySet[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let realSets: StrategySet[]
    if (inputSets) {
      realSets = inputSets
    } else {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      const stored = await getSettings(realKey)
      // Parse the serialized Real Sets array. The value is a JSON object
      // with a `sets` field (the actual array).
      if (stored && typeof stored === "object") {
        const parsed = stored as any
        // Handle both the new format (nested in `sets` field) and legacy
        // in case there's a mix.
        realSets = Array.isArray(parsed.sets) ? parsed.sets : Array.isArray(parsed) ? parsed : []
      } else {
        realSets = []
      }
    }

    const metrics = this.METRICS.live
    const maxLive = this.config.maxLiveSets || 500

    // P0-2: Live filter axes are PF-min + DDT-max ONLY (then rank by
    // avgProfitFactor and take top N). Confidence is advisory metadata.
    const qualifying = realSets
      .filter(
        (s) =>
          s.avgProfitFactor >= metrics.minProfitFactor &&
          s.avgDrawdownTime <= metrics.maxDrawdownTime,
      )
      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      .slice(0, maxLive)



    // Persist LIVE sets
    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    await setSettings(liveKey, {
      sets: qualifying,
      count: qualifying.length,
      created: new Date(),
      executable: true,
    })

    // Create pseudo positions from REAL/LIVE sets so they appear on dashboard
    await this.createPseudoPositionsFromRealSets(symbol, realSets)

    // Write live set count into progression hash — use hset so count reflects current cycle snapshot.
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    // Previously this block fired 7 sequential Redis round-trips (hset × 2, set, expire × 3, + a
    // compound hset). Parallelising them cuts the per-cycle Redis stall to a single network hop
    // worth of latency, matching the base/main/real coordinators.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const liveDetailKey = `strategy_detail:${this.connectionId}:live`
      const liveCountKey = `strategies:${this.connectionId}:live:count`

      const liveAvgPF  = qualifying.length > 0 ? qualifying.reduce((s, st) => s + st.avgProfitFactor, 0) / qualifying.length : 0
      const liveAvgDDT = qualifying.length > 0 ? qualifying.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / qualifying.length : 0
      const passRatioLive = realSets.length > 0 ? qualifying.length / realSets.length : 0

      // ── P1-1: Live-stage per-variant aggregation ──────────────────────
      // Same bucket shape as Main/Real. Drives the stats API's breakdown
      // of which variant family (Default / Trailing / Block / DCA) is
      // contributing Sets to the live mirror. Kept as a single Promise.all
      // so we still land in one network hop.
      type LiveVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number
      }
      const liveVariantAgg: Record<string, LiveVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        pause:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
      }
      for (const set of qualifying) {
        const variant = (set.variant as keyof typeof liveVariantAgg) ?? "default"
        liveVariantAgg[variant].setsContaining += 1
        for (const entry of set.entries) {
          liveVariantAgg[variant].entries += 1
          liveVariantAgg[variant].sumPF   += Number(entry.profitFactor || 0)
          liveVariantAgg[variant].sumDDT  += Number(entry.drawdownTime || 0)
        }
      }

      // ── bumpValidPositions — Live-promoted Set counter ─────────────────
      // The `valid_positions:{conn}` hash (written by bumpValidPositions in
      // pos-history.ts) tracks the connection-wide count of Sets that have
      // reached Live stage, split by symbol and direction. The dashboard
      // "Valid positions" tile reads this hash. Without this call the counter
      // never increments regardless of how many Sets qualify each cycle.
      try {
        const { bumpValidPositions } = await import("@/lib/pos-history")
        const vpPipeline = getRedisClient().multi()
        for (const set of qualifying) {
          bumpValidPositions({
            connectionId: this.connectionId,
            symbol,
            direction: set.direction,
            indicationType: set.indicationType,
            // Live sets are by definition currently running (they have
            // open or in-formation positions). isRunningNow drives the
            // `combined` (= active accumulation) counter in valid_positions.
            isRunningNow: true,
            externalPipeline: vpPipeline,
          })
        }
        ;(vpPipeline as any).exec().catch(() => {})
      } catch { /* non-critical — valid_positions counter is observability only */ }

      const liveVariantWrites: Promise<any>[] = []
      for (const variant of ["default", "trailing", "block", "dca", "pause"] as const) {
        const agg = liveVariantAgg[variant]
        if (agg.entries === 0) continue
        const vKey = `strategy_variant_live:${this.connectionId}:${variant}`
        const avgPF  = agg.sumPF  / agg.entries
        const avgDDT = agg.sumDDT / agg.entries
        liveVariantWrites.push(
          client.hset(vKey, {
            created_sets:      String(agg.setsContaining),
            entries_count:     String(agg.entries),
            avg_profit_factor: avgPF.toFixed(4),
            avg_drawdown_time: avgDDT.toFixed(2),
            avg_pos_per_set:   (agg.entries / agg.setsContaining).toFixed(2),
            updated_at:        String(Date.now()),
          }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // strategies_live_total must be CUMULATIVE (hincrby), not a per-cycle
      // snapshot (hset). All other stage _total fields use hincrby; using hset
      // here made Live's lifetime total reset to the current-cycle count every
      // cycle, so the dashboard always showed a tiny snapshot instead of the
      // true accumulated lifetime count.
      await Promise.all([
        qualifying.length > 0
          ? client.hincrby(redisKey, "strategies_live_total", qualifying.length)
          : Promise.resolve(),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(liveDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:      String(qualifying.length),
          avg_profit_factor: String(liveAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(liveAvgDDT)),
          evaluated:         String(realSets.length),
          passed_sets:       String(qualifying.length),
          pass_rate:         String(passRatioLive.toFixed(4)),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   Live's `qualifying` Sets ARE the executed orders. They
          //   are by definition "running" — exchange has accepted the
          //   order or is holding the position. `sets_progressing` is
          //   the real-stage input pool being ranked & capped this
          //   cycle (i.e. candidates currently progressing toward live
          //   execution).
          sets_running_now:         String(qualifying.length),
          sets_with_open_positions: String(qualifying.length),
          sets_progressing:         String(realSets.length),
          updated_at:        String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          // Live doesn't compute avg_pos_per_set / avg_pos_eval_real;
          // those keys are intentionally omitted from the per-symbol
          // bundle so /stats's weighted-mean calculator skips them.
          [`s:${symbol}:created`]:    String(qualifying.length),
          [`s:${symbol}:entries`]:    String(qualifying.reduce((s, st) => s + (st.entryCount || 0), 0)),
          [`s:${symbol}:running`]:    String(qualifying.length),
          [`s:${symbol}:progressing`]: String(realSets.length),
          [`s:${symbol}:passed`]:     String(qualifying.length),
          [`s:${symbol}:evaluated`]:  String(realSets.length),
          [`s:${symbol}:apf`]:        String(liveAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(liveAvgDDT)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(liveDetailKey, 86400),
        // `set` with EX in a single command avoids the separate expire round-trip.
        client.set(liveCountKey, String(qualifying.length), { EX: 86400 } as any),
        ...liveVariantWrites,
      ])
    } catch { /* non-critical */ }

    // Pre-fetch the current market price ONCE so both the live exchange dispatch
    // and the pseudo-position creation below share the same price without
    // duplicate Redis reads. The live-stage will still validate / re-fetch if
    // we hand it 0, but providing a good seed eliminates the most common cause
    // of "no market price" failures when market_data is just milliseconds stale.
    let _cachedMarketPrice = 0
    try {
      const _priceClient = getRedisClient()
      const _mdhash = await _priceClient.hgetall(`market_data:${symbol}`)
      _cachedMarketPrice = parseFloat(String(_mdhash?.close ?? _mdhash?.price ?? _mdhash?.last ?? "0"))
      if (!_cachedMarketPrice || isNaN(_cachedMarketPrice)) {
        // Spec §7: prefer the canonical :1s envelope, fall back to :1m.
        const _mdraw =
          (await _priceClient.get(`market_data:${symbol}:1s`)) ??
          (await _priceClient.get(`market_data:${symbol}:1m`))
        if (_mdraw) {
          const _mdobj = typeof _mdraw === "string" ? JSON.parse(_mdraw) : _mdraw
          const _candles = _mdobj?.candles
          if (Array.isArray(_candles) && _candles.length > 0) {
            _cachedMarketPrice = parseFloat(String(_candles[_candles.length - 1]?.close ?? "0")) || 0
          } else {
            _cachedMarketPrice = parseFloat(String(_mdobj?.close ?? _mdobj?.price ?? _mdobj?.last ?? "0")) || 0
          }
        }
      }
    } catch { /* best-effort; live-stage falls back internally */ }

    // Attempt real exchange trading for qualifying LIVE sets when the connection has live trading enabled.
    // This is guarded by is_live_trade flag on the connection — if disabled, only pseudo positions are created.
    if (qualifying.length > 0) {
      try {
        // Use getConnection() as authoritative source — it reads connection:{id} hash via parseHash
        // which handles boolean/string coercion. Raw hgetall may miss "true" vs "1" vs boolean true.
        const { getConnection: getConn } = await import("@/lib/redis-db")
        const connData = await getConn(this.connectionId)
        const { isTruthyFlag } = await import("@/lib/connection-state-utils")
        const isLiveTrade = isTruthyFlag(connData?.is_live_trade) || isTruthyFlag(connData?.live_trade_enabled)
        if (isLiveTrade) {
          const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
          if (connector) {
            // Dispatch live positions. Each pipeline call is heavyweight:
            // price fetch → volume calc → leverage → order → fill poll →
            // SL/TP → sync. With 10+ symbols × N qualifying Sets per symbol,
            // dispatching every Set serially creates a blocking storm that
            // saturates the cycle budget.
            //
            // The dedup lock (live:lock:{conn}:{sym}:{dir}) already enforces
            // "at most 1 open position per symbol+direction". Every Set beyond
            // the first that targets the same direction will hit "Dedup lock
            // held" and still cost 3-5 Redis round-trips (tryAcquireLock +
            // findOpenLivePositionByDir + savePosition + incrementMetric +
            // logProgressionEvent) before being deferred.
            //
            // Fix: pre-select at most 1 Set per direction (the highest-PF one,
            // already guaranteed by .sort() above) before calling the pipeline.
            // Only call executeLivePosition for sets that have a real chance of
            // acquiring the lock or merging — not for the 49 duplicates that
            // will always be deferred on the same cycle.
            //
            // The qualifying array is already sorted by avgProfitFactor desc.
            // Walk it once and keep only the first Set seen for each direction.
            const dispatchSets: StrategySet[] = []
            {
              let sawLong  = false
              let sawShort = false
              for (const s of qualifying) {
                if (s.direction === "long"  && !sawLong)  { dispatchSets.push(s); sawLong  = true }
                if (s.direction === "short" && !sawShort) { dispatchSets.push(s); sawShort = true }
                if (sawLong && sawShort) break
              }
            }

            let placed = 0
            let filled = 0
            let rejected = 0
            let errored = 0

            for (const set of dispatchSets) {
              try {
                // Axis Sets are pure-metadata projections (entries=[]).
                // Hydrate from the parent Real Set when entries is empty so
                // the live execution path can still derive SL/TP from PF.
                const effectiveEntries =
                  set.entries.length > 0
                    ? set.entries
                    : (realSets.find((s) => s.setKey === set.parentSetKey)?.entries ?? [])
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0]
                )
                if (!bestEntry) continue

                // Derive SL/TP % from the set's profit factor. The pipeline
                // converts these to concrete prices after the entry fills.
                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, (100 / Math.max(1, bestEntry.profitFactor)) * 0.5)

                const liveResult = await executeLivePosition(
                  this.connectionId,
                  {
                    id: `real:${this.connectionId}:${set.setKey}:${symbol}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
                    connectionId: this.connectionId,
                    symbol,
                    direction: set.direction,
                    // Provide the pre-fetched market price so the live pipeline
                    // can skip its own price fetch when the price is fresh. The
                    // pipeline validates > 0 and re-fetches if needed, so passing
                    // 0 here remains safe as a fallback.
                    quantity: 0,
                    entryPrice: _cachedMarketPrice,
                    leverage: bestEntry.leverage || 1,
                    riskAmount: 0,
                    rewardTarget: 0,
                    stopLoss: sl,
                    takeProfit: tp,
                    mainPositionCount: set.entryCount,
                    evaluationScore: bestEntry.confidence,
                    ratioMet: bestEntry.confidence >= 0.65,
                    timestamp: Date.now(),
                    ratios: {
                      profitabilityRatio: bestEntry.profitFactor,
                      accountRiskRatio: sl / 100,
                      successRateRatio: bestEntry.confidence,
                      consistencyRatio: set.avgConfidence,
                    },
                    status: "pending",
                    // ── Set lineage propagation (Strategy → Real → Live) ──
                    // `executeLivePosition` mirrors these onto the LivePosition
                    // verbatim. Without them the executed live order carries
                    // `setKey=undefined`, breaking:
                    //   1. Post-trade stats grouping (PnL by Set Type)
                    //   2. `accumulatedSetKeys` seeding — when a later signal
                    //      accumulates into this open position the merged
                    //      lineage starts from an empty array instead of the
                    //      originating Set, losing the first leg's identity.
                    //   3. The progression panel's Set-lineage badge.
                    // The id already embeds setKey for log-grep, but the
                    // structured fields are what downstream code reads.
                    setKey:       set.setKey,
                    parentSetKey: set.parentSetKey,
                    setVariant:   set.variant,
                    axisWindows:  set.axisWindows,
                  },
                  connector
                )

                if (!liveResult) continue
                if (liveResult.status === "open" || liveResult.status === "filled" || liveResult.status === "partially_filled") {
                  filled++
                  placed++
                } else if (liveResult.status === "placed") {
                  placed++
                } else if (liveResult.status === "rejected") {
                  rejected++
                } else if (liveResult.status === "error") {
                  errored++
                }
              } catch (err) {
                errored++
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} per-set live execution error:`,
                  err instanceof Error ? err.message : String(err)
                )
              }
            }

            if (placed > 0 || rejected > 0 || errored > 0) {
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored}`
              )
            }
          } else {
            console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: live_trade=true but connector not available`)
          }
        }
      } catch (liveErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Real exchange execution error:`, liveErr instanceof Error ? liveErr.message : String(liveErr))
      }

      // After dispatching new entries, reconcile already-open positions with
      // the exchange so that any SL/TP/manual-close that happened since the
      // last cycle transitions the Redis record to "closed". Rate-limited per
      // connection to once every 30 seconds to stay well within exchange
      // rate limits while still providing near-real-time closure tracking.
      try {
        const client = getRedisClient()
        const rlKey = `live:reconcile:ratelimit:${this.connectionId}`
        const last = await client.get(rlKey).catch(() => null)
        const now = Date.now()
        const lastTs = last ? parseInt(last as string, 10) : 0
        // Rate-limit: fire at most once per 30 s.
        // TTL = 35 s so the key expires before the next 30 s window opens —
        // previously TTL=60 kept the key alive well past 30 s and would have
        // blocked reconcile even after the window had elapsed. The cron
        // (sync-live-positions) now skips connections whose engine is active,
        // so this 30 s in-engine reconcile is the sole mechanism while running.
        if (!lastTs || now - lastTs > 30_000) {
          await client.setex(rlKey, 35, String(now)).catch(() => {})
          // Fire-and-forget: don't block the strategy flow on exchange IO.
          ;(async () => {
            try {
              const { reconcileLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
              const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
              const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
              if (connector) {
                const result = await reconcileLivePositions(this.connectionId, connector)
                if (result.closed > 0) {
                  console.log(
                    `[v0] [StrategyFlow] ${this.connectionId} reconcile closed ${result.closed} positions via exchange sync`
                  )
                }
              }
            } catch (reconErr) {
              console.warn(
                `[v0] [StrategyFlow] ${this.connectionId} reconcile error:`,
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              )
            }
          })()
        }
      } catch {
        /* non-critical; skip if redis rate-limit read fails */
      }
    }

    // Create EXACTLY ONE pseudo position per Set (one per indication_type × direction combination).
    // Each Set represents a unique (indication_type × direction) coordinate.
    // We pick the highest-profitFactor entry from the Set as the representative config for the position.
    if (qualifying.length > 0) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)

        // Reuse the market price already fetched above (_cachedMarketPrice).
        // Fall back to a fresh fetch only if the cached value is missing (e.g.
        // when live-trade gate was disabled and the price block above was skipped).
        let entryPrice = _cachedMarketPrice
        if (!entryPrice || isNaN(entryPrice)) {
          try {
            const client = getRedisClient()
            const mdhash = await client.hgetall(`market_data:${symbol}`)
            entryPrice = parseFloat(String(mdhash?.close ?? mdhash?.price ?? mdhash?.last ?? "0"))
            if (!entryPrice || isNaN(entryPrice)) {
              // Spec §7: read :1s first; fall back to :1m for legacy data.
              const mdraw =
                (await client.get(`market_data:${symbol}:1s`)) ??
                (await client.get(`market_data:${symbol}:1m`))
              if (mdraw) {
                const mdobj = typeof mdraw === "string" ? JSON.parse(mdraw) : mdraw
                const candles = mdobj?.candles
                if (Array.isArray(candles) && candles.length > 0) {
                  entryPrice = parseFloat(String(candles[candles.length - 1]?.close ?? "0")) || 0
                } else {
                  entryPrice = parseFloat(String(mdobj?.close ?? mdobj?.price ?? mdobj?.last ?? "0")) || 0
                }
              }
            }
          } catch { /* skip price lookup */ }
        }

        if (entryPrice > 0) {
          // Pseudo-position creation is local Redis work with per-Set idempotency
          // enforced inside createPosition (one active pseudo position per Set).
          // Safe to fan out in parallel — no exchange calls, no shared balance.
          const creations = await Promise.all(
            qualifying.map(async (set) => {
              try {
                // Axis Sets are pure-metadata projections (entries=[]).
                // Hydrate from the parent Real Set when entries is empty so
                // the pseudo creation path can still derive SL/TP from PF.
                const effectiveEntries =
                  set.entries.length > 0
                    ? set.entries
                    : (realSets.find((s) => s.setKey === set.parentSetKey)?.entries ?? [])
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0],
                )
                if (!bestEntry) return false

                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)

                // Multi-step trailing — Set carries its own profile from
                // BASE, so trailing-on/off and the three ratios are
                // operator-determined per the matrix in Settings →
                // Strategy → Trailing. Sets WITHOUT a profile keep the
                // legacy single-step behaviour with statistical on/off
                // (`bestEntry.confidence >= 0.85`).
                const profile = set.trailingProfile
                const trailing = profile ? true : bestEntry.confidence >= 0.85

                // Build a fully-qualified uniqueness key including TP, SL,
                // direction and trailing so sets with the same indicationType
                // and direction but different PF-derived TP/SL occupy distinct
                // slots and are not collapsed into one active position.
                const trailingSuffix = profile
                  ? `:t${Math.round(profile.startRatio * 100)}-${Math.round(profile.stopRatio * 100)}`
                  : trailing ? `:tr1` : `:tr0`
                const configSetKey =
                  `${set.indicationType}:${set.direction}:${symbol}` +
                  `:tp${tp.toFixed(2)}:sl${sl.toFixed(2)}${trailingSuffix}`

                const posId = await posManager.createPosition({
                  symbol,
                  side: set.direction,
                  indicationType: set.indicationType,
                  entryPrice,
                  takeprofitFactor: tp,
                  stoplossRatio: sl,
                  profitFactor: bestEntry.profitFactor,
                  trailingEnabled: trailing,
                  configSetKey,
                  ...(profile && {
                    trailingStartRatio: profile.startRatio,
                    trailingStopRatio: profile.stopRatio,
                    trailingStepRatio: profile.stepRatio,
                  }),
                })
                return posId ? ("created" as const) : ("gated" as const)
              } catch (posErr) {
                console.error(`[v0] [StrategyFlow] ${symbol} LIVE: createPosition error:`, posErr instanceof Error ? posErr.message : String(posErr))
                return "error" as const
              }
            }),
          )
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price, skipping position creation`)
        }
      } catch (posErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posErr instanceof Error ? posErr.message : String(posErr))
      }
    }

    return {
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: realSets.length,
        passedEvaluation: qualifying.length,
        failedEvaluation: realSets.length - qualifying.length,
        avgProfitFactor: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgProfitFactor, 0) / qualifying.length : 0,
        avgDrawdownTime: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgDrawdownTime, 0) / qualifying.length : 0,
      },
      sets: qualifying,
    }
  }

  // �����── HELPERS ────────────────────────���──────────��───────���─────────────────────

  // Per-cycle position-context cache. The pseudo-position list is shared
  // across all Main invocations within the same cycle to amortise Redis
  // reads when many symbols go through the flow in rapid succession.
  private positionContextCache: { ctx: PositionContext; ts: number } | null = null
  private readonly POSITION_CONTEXT_TTL_MS = 2000

  /**
   * Produce a neutral position context — no open positions, no prior wins
   * or losses. Used for prehistoric/backtest runs and as a fallback when the
   * pseudo-position read fails (keeps Main operational even if the position
   * index is temporarily unavailable).
   */
  private neutralPositionContext(): PositionContext {
    return {
      continuousCount: 0,
      lastPosCount: 0,
      prevPosCount: 0,
      lastWins: 0,
      lastLosses: 0,
      prevLosses: 0,
      perSymbolOpen: {},
    }
  }

  /**
   * Fetch the per-cycle position coordination context used by MAIN to decide
   * which additional related variant Sets to produce. Reads pseudo positions
   * once and buckets them into continuous (active) vs last-N closed vs full
   * lookback window. Results are cached for POSITION_CONTEXT_TTL_MS so
   * symbols processed in rapid succession share a single Redis read.
   */
  private async getPositionContext(): Promise<PositionContext> {
    const now = Date.now()
    if (this.positionContextCache && now - this.positionContextCache.ts < this.POSITION_CONTEXT_TTL_MS) {
      return this.positionContextCache.ctx
    }

    try {
      const posManager = new PseudoPositionManager(this.connectionId)
      const active = await posManager.getActivePositions()

      // Build per-symbol open-position map from the active list (continuous
      // positions). No extra Redis reads — getActivePositions already pulls
      // the full hashes behind a 1s internal cache.
      const perSymbolOpen: Record<string, number> = {}
      for (const p of active) {
        const sym = String(p.symbol || "")
        if (!sym) continue
        perSymbolOpen[sym] = (perSymbolOpen[sym] ?? 0) + 1
      }

      // ── P-CTX-1: Read from dedicated closed-positions index ──────────
      // `closePosition()` in PseudoPositionManager removes the position id
      // from the open-positions set (positionsSetKey) AND appends it to a
      // dedicated Redis list `pseudo_positions:{id}:closed_index` (newest
      // first, capped at CLOSED_INDEX_CAP). Reading that list here gives us
      // a bounded, already-closed-only window without filtering active ids or
      // issuing a full smembers on the global (open) set — which previously
      // always returned 0 closed positions because closePosition() removes ids
      // from the global set, starving all Main variant gates.
      const client = getRedisClient()
      const closedIndexKey = `pseudo_positions:${this.connectionId}:closed_index`
      const lookbackMs = 24 * 60 * 60 * 1000
      const cutoff = now - lookbackMs
      const WINDOW_CAP = 100 // read up to 100 newest closed ids from the list

      let prevPosCount = 0
      let prevLosses = 0
      const lastN: Array<{ closedAt: number; pnl: number }> = []
      try {
        // LRANGE 0 WINDOW_CAP-1 fetches the newest WINDOW_CAP closed ids
        // (LPUSH + LTRIM in closePosition keeps the list newest-first).
        const closedIds: string[] = ((await client.lrange(closedIndexKey, 0, WINDOW_CAP - 1).catch(() => [])) || []) as string[]

        // Pipelined HGETALL for all sampled ids — single round-trip.
        const hashes = await (async () => {
          if (closedIds.length === 0) return []
          const pipeline = client.multi()
          for (const id of closedIds) pipeline.hgetall(`pseudo_position:${this.connectionId}:${id}`)
          const results = await pipeline.exec().catch(() => null)
          if (!results) return []
          return results.map((r: any) => {
            const data = Array.isArray(r) ? r[1] : r
            return data && typeof data === "object" && Object.keys(data).length > 0 ? data : null
          })
        })()

        for (const h of hashes) {
          if (!h) continue
          // ── P2-1: Strict closed-only gate ──────────────────────────────
          // Positions in the closed_index are always closed by construction
          // (closePosition writes to the index). We still enforce the
          // status check as a defence against stale/corrupted rows.
          const status = String(h.status || "").toLowerCase()
          if (status !== "closed") continue
          const closedAtRaw = h.closed_at ?? h.closedAt ?? ""
          // Parse ISO string ("2025-01-01T...") or numeric ms ("1735689600000").
          const closedAtMs = (() => {
            if (!closedAtRaw) return NaN
            const n = Number(closedAtRaw)
            if (Number.isFinite(n) && n > 1_000_000_000_000) return n  // already ms
            const d = new Date(closedAtRaw as string).getTime()
            return Number.isFinite(d) ? d : NaN
          })()
          if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) continue
          const closedAt = closedAtMs
          if (closedAt < cutoff) continue
          // Prefer `realized_pnl`; fall back to `pnl` only when the row
          // is marked closed (the closePosition pipeline writes `pnl`
          // to the realized value at close time).
          const pnlRaw = h.realized_pnl ?? h.pnl ?? h.profit ?? 0
          const pnl = Number(pnlRaw)
          if (!Number.isFinite(pnl)) continue
          prevPosCount++
          if (pnl < 0) prevLosses++
          lastN.push({ closedAt, pnl })
        }
        // Keep the 8 most recently closed for the "last-N" breakdown.
        // The closed_index is already newest-first (LPUSH order), so
        // sorting + truncating here normalises any edge-cases where TTL
        // trimming or concurrent writes changed the ordering slightly.
        lastN.sort((a, b) => b.closedAt - a.closedAt)
        lastN.length = Math.min(lastN.length, 8)
      } catch { /* best-effort; fall through with zeros */ }

      const ctx: PositionContext = {
        continuousCount: active.length,
        lastPosCount:    lastN.length,
        prevPosCount,
        lastWins:        lastN.filter((r) => r.pnl > 0).length,
        lastLosses:      lastN.filter((r) => r.pnl < 0).length,
        prevLosses,
        perSymbolOpen,
      }

      this.positionContextCache = { ctx, ts: now }
      return ctx
    } catch (err) {
      // Never fail the strategy flow on a context read error — fall back to
      // the neutral context so only the always-on `default` variant is made.
      console.warn(
        `[v0] [StrategyFlow] getPositionContext failed; using neutral context:`,
        err instanceof Error ? err.message : String(err),
      )
      const neutral = this.neutralPositionContext()
      this.positionContextCache = { ctx: neutral, ts: now }
      return neutral
    }
  }

  /**
   * Decide which variant profiles are ACTIVE for the current position context.
   * Each profile has a gate predicate — predicates that fail produce no
   * related Set for that variant this cycle (keeps work proportional to
   * context). The `default` variant is always on — it mirrors the original
   * one-Set-per-base behaviour and is what Real/Live have always consumed.
   *
   * ── P2-3: Closed-only contract for statistics-driven gates ────────
   * The `ctx` input here comes from `getPositionContext()`, which (as
   * of P2-1) enforces a strict `status==="closed"` filter on every
   * statistical field it builds:
   *   - prevPosCount, prevLosses, lastPosCount, lastWins, lastLosses
   *     → closed pseudo positions within a 24h lookback window.
   * Intentional exceptions (fields based on OPEN state by design, per
   * spec) ��� gates on these fields are NOT closed-only:
   *   - continuousCount  → # currently-open pseudo positions
   *                        (spec: "Continuous Positions" are active)
   *   - perSymbolOpen    → per-symbol open count (feeds `block` gate
   *                        which explicitly needs an open position to
   *                        continue into)
   * Every other axis used below is closed-only. This invariant keeps
   * Main-stage factor coordination free of floating mark-to-market
   * pollution while allowing the few gates that MUST reference live
   * open state to do so cleanly.
   */
  private selectActiveVariants(ctx: PositionContext): Array<ReturnType<StrategyCoordinator["variantProfiles"]>[number]> {
    const all = this.variantProfiles()
    // Filter to only enabled variants per coordination settings. "default"
    // is always on regardless of toggle (it's the operator's fallback).
    const filtered = all.filter((p) => {
      const gatePass = p.gate(ctx)
      if (!gatePass) return false
      if (p.name === "default") return true
      const enabled = this._coordinationSettings.variants[p.name]
      return enabled === true
    })

    // ── Block: live position × vol-ratio scaling ──────────────────────
    //
    // The Block variant's `configs[].size` is the *base* multiplier. The
    // emitted Sets must scale on TWO live axes:
    //
    //   1. `continuousCount` (live open-position count on this symbol)
    //   2. `blockVolumeRatio` (operator slider, 0.25..3.0)
    //
    // Multiplier formula:  m(n) = 1 + (n − 1) × ratio
    //
    //   - n = 1 (first add-on)  → m = 1.0   (raw base size; no scaling)
    //   - n = 2                 → m = 1 + ratio
    //   - n = 3                 → m = 1 + 2 × ratio
    //   - n ≥ blockMaxStack     → gate already filtered this variant out
    //
    // We patch the variant in-place inside a *fresh* clone so the shared
    // `variantProfiles()` array (built per-call but referenced by other
    // emit paths in the same flow) is never mutated.
    const n = Math.max(1, ctx.continuousCount | 0)
    const ratio = this._coordinationSettings.blockVolumeRatio
    const blockMul = 1 + (n - 1) * ratio
    if (blockMul !== 1) {
      const idx = filtered.findIndex((p) => p.name === "block")
      if (idx !== -1) {
        const orig = filtered[idx]
        filtered[idx] = {
          ...orig,
          configs: orig.configs.map((c) => ({
            ...c,
            // `size` flows downstream as the Set's `sizeMultiplier`, so
            // multiplying here is the single point of scaling.
            size: Number((c.size * blockMul).toFixed(6)),
          })),
        }
      }
    }

    return filtered
  }

  /**
   * Curated variant profiles.
   *
   * Each profile contains a small list of configuration tuples (≤ 4 per
   * variant). Compared to the legacy 4×4×4 = 64 Cartesian expansion, this
   * produces at most ~16 candidate entries per base entry across all active
   * variants — a ~4× reduction in Main computation while preserving the
   * semantic coverage (each variant now produces a DEDICATED Set instead of
   * being scattered across one big hybrid Set).
   *
   * Gate predicates encode the user's coordination spec:
   *   default  — always on (validates & mirrors the Base Set)
   *   trailing — recent winners, no open position (scale-in opportunity)
   *   block    — there's an open position we can add to (continuation)
   *   dca      — recent losses to recover with averaged entries
   */
  /**
   * Compute the mean profit-factor of the last `n` COMPLETED entries.
   *
   * Returns `null` when there are fewer than `n` entries — the prev-axis
   * filter treats this as "insufficient data" and rejects emission for
   * that prev value (we never speculate when the operator's PF gate
   * can't actually be evaluated).
   *
   * Only `entries` with a numeric `profitFactor` are considered. The
   * StrategySetEntry shape always carries a defined PF for completed
   * historical evaluations, so this is mostly a defensive guard.
   */
  private meanPFOfLastN(entries: StrategySetEntry[], n: number): number | null {
    if (!entries || entries.length < n || n <= 0) return null
    const slice = entries.slice(-n)
    let sum = 0
    let count = 0
    for (const e of slice) {
      const pf = Number(e.profitFactor)
      if (Number.isFinite(pf)) { sum += pf; count++ }
    }
    if (count === 0) return null
    return sum / count
  }

  /**
   * Expand a single `default`-variant Main Set into the operator-spec'd
   * Position-Count Cartesian axis fan-out.
   *
   *   prev (4-12 step 2) × last (1-4 step 1) × cont (1-8 step 1) × dir
   *
   * With (precise spec semantics):
   *   • prev   = PF FILTER on the parent's last N COMPLETED entries
   *              (rejects whole prev-row when meanPF < `minPF`).
   *              Spec: "Do not Calculate the Open Positions, only
   *              positions already Completed" — applies here.
   *   • last   = OUTCOME SPLIT (pos / neg) based on parent's last M
   *              COMPLETED entries' meanPF. ONE Set emitted per (last)
   *              tagged with the realised outcome. Open positions are
   *              also excluded from the outcome aggregate.
   *   • cont   = OPEN-POSITION ACCUMULATION COUNT per spec
   *              ("continuous 3: add actual and next 2 positions to
   *              set"). The Set is configured to accumulate `cont`
   *              OPEN positions on top of the base's completed count —
   *              the currently-open one ("actual") plus `cont − 1`
   *              future ones to be opened across subsequent intervals.
   *              Encoded as `entryCount = baseEC + cont`, where baseEC
   *              counts completed historic entries and cont counts the
   *              open-position accumulation window. The Live stage's
   *              `live_net_target` reconciliation drives partial
   *              open/close orders as the window fills.
   *   • dir    = Cartesian (long + short) so hedge-net has both sides.
   *
   * All axis Sets inherit `avgProfitFactor` / `avgDrawdownTime` /
   * `avgConfidence` / `trailingProfile` from `baseDefault` unchanged —
   * they are PROJECTIONS, not re-evaluations. `entries` is deliberately
   * empty (`[]`) to prevent 320× JSON duplication on Redis persist and
   * 80,000× inflation of per-variant entry-counters downstream.
   *
   * `entries` hydration for downstream consumers (exchange order
   * construction, per-entry stats) is via `parentSetKey` at execution
   * time — the in-memory axis Set is purely metadata.
   *
   * Source of "only completed entries": `baseDefault.entries` is built
   * by `strategy-sets-processor` from completed strategy evaluations
   * only (each carries a defined `profitFactor`). The separate
   * `getPositionContext()` P2-1 closed-only gate keeps open positions
   * out of variant-selection state; together those two invariants give
   * the prev/last calcs a closed-only contract end-to-end.
   */
  private expandAxisSets(
    baseDefault: StrategySet,
    minPF: number,
    liveCont = 0,
  ): StrategySet[] {
    const axisSets: StrategySet[] = []
    const baseEC = baseDefault.entryCount || 0
    const entries = baseDefault.entries || []

    // Parent baseKey (strip any prior `#variant` / `#axis:*` suffixes)
    // so `parentSetKey` always points at the originating Base Set.
    const parentKey = baseDefault.parentSetKey || baseDefault.setKey.split("#")[0]

    // ── Inherited quality fields used for the synthetic representative entry ─
    // The Real-stage tuner walks `set.entries` to mutate sizeMultiplier /
    // leverage per-cycle. Axis Sets now carry one synthetic representative
    // entry so the tuner fires and variant aggregates count correctly.
    // Per spec ("ongoing continuous count of Pis to be added, counted
    // onto the new sets") each axis Set gets ONE faithful pos-coord
    // projection inherited from the parent Base default — flagged with
    // `#axis-synth` so downstream consumers can recognise it.
    const inheritedPF   = baseDefault.avgProfitFactor ?? 1
    const inheritedDDT  = baseDefault.avgDrawdownTime ?? 0
    const inheritedConf = baseDefault.avgConfidence   ?? 0

    for (const prev of AXIS_PREV) {
      // ── prev FILTER (PF gate on last `prev` completed entries) ─────
      // Spec: prev "acts as a PF filter on the parent's last N completed
      // entries". When the parent does not yet have N completed entries
      // (warming up / fresh symbol), the filter is *undefined* — there
      // is nothing to evaluate yet — and we ADMIT the prev row neutrally.
      // The fan-out's purpose is the position-count axis (cont × dir);
      // suppressing it during bootstrap collapses Main count to Base
      // count, which is exactly the symptom we're fixing here. Once the
      // parent accumulates ≥ N completed entries, the PF gate engages
      // and the filter starts pruning legitimately.
      const prevMeanPF = this.meanPFOfLastN(entries, prev)
      if (prevMeanPF !== null && prevMeanPF < minPF) continue // gate engaged → skip whole prev row

      for (const last of AXIS_LAST) {
        // ── last OUTCOME SPLIT ───────────────────────────────────────
        // Spec: emit ONE Set per `last` value tagged with the realised
        // pos/neg outcome based on parent's last M completed entries'
        // meanPF. When parent does not yet have M completed entries
        // (warming up), the outcome is *undefined* — we emit BOTH
        // `pos` AND `neg` projections so neither side is suppressed
        // during bootstrap. Once the parent accumulates ≥ M entries
        // the outcome resolves to a single side per cycle as before.
        const lastMeanPF = this.meanPFOfLastN(entries, last)
        const outcomes: Array<"pos" | "neg"> =
          lastMeanPF === null ? ["pos", "neg"] : [lastMeanPF >= 1.0 ? "pos" : "neg"]

        for (const cont of AXIS_CONT) {
          for (const dir of AXIS_DIRS) {
            for (const outcome of outcomes) {
              const axisKey = axisKeyOf(prev, last, cont, outcome, dir)

              // ── Live continuous-count cap (operator spec) ──────────
              // The `cont` axis dimension represents "actual + next N-1
              // positions to accumulate". Per spec we only credit
              // positions that ACTUALLY exist live this cycle. Cap by
              // `liveCont` so axis Sets reflect the rolling continuous
              // count, not a static projection that would over-count
              // empty slots. Worst case (liveCont = 0) collapses to
              // `entryCount = baseEC`, growing as positions accrue.
              const credited = Math.min(cont, Math.max(0, liveCont))
              const ec = baseEC + credited

              // ── Synthetic representative entry ─────────────────────
              // One entry per axis Set so:
              //   • variant-aggregate loop counts it (passed_sets / sumPF / sumDDT)
              //   • Real-stage tuner has something to mutate
              //   • per-axis Pos-acc ledger has a non-zero delta to record
              // Quality fields are inherited from the Base default's
              // realised-history aggregates; positionState carries the
              // axis tuple so the dashboard can drill in.
              const synthEntry: StrategySetEntry = {
                id: `${parentKey}#axis:${axisKey}#axis-synth`,
                sizeMultiplier: 1,
                leverage: 1,
                positionState: `axis:p${prev}|l${last}|c${cont}|${outcome}|${dir}`,
                profitFactor: inheritedPF,
                drawdownTime: inheritedDDT,
                confidence: inheritedConf,
              }

              axisSets.push({
                setKey:          `${parentKey}#axis:${axisKey}`,
                parentSetKey:    parentKey,
                variant:         "default",
                indicationType:  baseDefault.indicationType,
                // Direction is fan-out axis (Cartesian), not inherited.
                direction:       dir,
                // Inherited quality fields — axis Sets do not re-evaluate.
                avgProfitFactor: inheritedPF,
                avgConfidence:   inheritedConf,
                avgDrawdownTime: inheritedDDT,
                // Position-count contribution per spec:
                //   baseEC = parent's COMPLETED historic entry count.
                //   credited = OPEN positions actually accumulated onto
                //              this Set right now (cap min(cont, liveCont)).
                entryCount:      ec,
                // ONE synthetic representative entry — see comment above.
                entries:         [synthEntry],
                createdAt:       new Date().toISOString(),
                axisWindows: {
                  prev,
                  last,
                  cont,
                  pause:     0,
                  direction: dir,
                  axisKey,
                  outcome,
                },
                trailingProfile: baseDefault.trailingProfile,
                // Carry parent's prev-pos snapshot through the axis fan-out
                // unchanged — same realised-history regime applies to every
                // axis projection of the same Base Set.
                ...(baseDefault.prevPos && { prevPos: baseDefault.prevPos }),
              })
            }
          }
        }
      }
    }
    return axisSets
  }

  private variantProfiles(): Array<{
    name: "default" | "trailing" | "block" | "dca" | "pause"
    gate: (ctx: PositionContext) => boolean
    configs: Array<{ size: number; leverage: number; state: string; pfBias: number; ddtBias: number }>
  }> {
    return [
      {
        name: "default",
        gate: () => true,
        configs: [
          { size: 1.0, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 0  },
          { size: 1.0, leverage: 2, state: "new", pfBias: 1.05, ddtBias: 15 },
        ],
      },
      {
        name: "trailing",
        gate: (c) => c.lastWins >= 2 && c.continuousCount === 0,
        configs: [
          { size: 1.0, leverage: 3, state: "new", pfBias: 1.10, ddtBias: 30 },
          { size: 1.0, leverage: 5, state: "new", pfBias: 1.15, ddtBias: 60 },
        ],
      },
      {
        name: "block",
        // ── Block gate: ≥1 open pos on this symbol, capped by stack ─────
        //
        // The cap (`blockMaxStack`) is operator-controlled (defaults to 3
        // for spec parity). At `n = blockMaxStack` the gate closes —
        // preventing unbounded add-on stacking on a single symbol.
        gate: (c) => c.continuousCount >= 1 && c.continuousCount < this._coordinationSettings.blockMaxStack,
        // ── Block sub-configs ─ size is the *base* multiplier that
        // `selectActiveVariants` THEN scales by `(1 + (n−1)×ratio)` at
        // evaluation time so the live position count and the operator's
        // vol-ratio knob both flow into the emitted Set's
        // `sizeMultiplier`. Keeping the raw bases here (1.5 / 2.0)
        // preserves the relative aggression spread between the two
        // entries; the runtime scaling is additive on top.
        configs: [
          { size: 1.5, leverage: 2, state: "add", pfBias: 1.08, ddtBias: 45 },
          { size: 2.0, leverage: 2, state: "add", pfBias: 1.12, ddtBias: 75 },
        ],
      },
      {
        name: "dca",
        gate: (c) => c.prevLosses >= 1,
        configs: [
          { size: 0.5, leverage: 1, state: "reduce", pfBias: 0.98, ddtBias: 20 },
          { size: 0.5, leverage: 1, state: "close",  pfBias: 0.95, ddtBias: 30 },
        ],
      },
      {
        // ── Pause variant — 1..8 last-position validation windows (step 1) ──
        // Spec: *"add Pause 1-8 Pos step 1 to Main additional Sets creation
        // after Pos prev,Last,cont .. add the 1-8 Last for counting Pause of
        // validating."* Each sub-config encodes one validation lookback N
        // (the last N closed positions) — when at least one of them was a
        // loser the Pause Set throttles back the next entry. The 8 sub-
        // configs ramp size DOWN and DDT-bias UP as the pause window
        // widens, so a deeper-history pause produces a more conservative
        // entry config than a shallow-history one. Gate fires whenever
        // there is ≥1 closed position to validate against; the closed-only
        // lookback enforced by `getPositionContext` (P2-1) means floating
        // mark-to-market PnL never leaks into this trigger.
        name: "pause",
        gate: (c) => c.lastPosCount >= 1,
        configs: [
          { size: 0.90, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 5  }, // last 1
          { size: 0.85, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 10 }, // last 2
          { size: 0.80, leverage: 1, state: "new", pfBias: 1.01, ddtBias: 15 }, // last 3
          { size: 0.75, leverage: 1, state: "new", pfBias: 1.02, ddtBias: 20 }, // last 4
          { size: 0.70, leverage: 1, state: "new", pfBias: 1.03, ddtBias: 25 }, // last 5
          { size: 0.65, leverage: 1, state: "new", pfBias: 1.04, ddtBias: 30 }, // last 6
          { size: 0.60, leverage: 1, state: "new", pfBias: 1.05, ddtBias: 35 }, // last 7
          { size: 0.55, leverage: 1, state: "new", pfBias: 1.06, ddtBias: 40 }, // last 8
        ],
      },
    ]
  }

  /**
   * Deterministic fingerprint of {base Set × variant × position context}.
   * Drives the "IF NOT ALREADY CREATED" dedup check.
   *
   * ── Bucket ranges (P0-3, spec-aligned) ─��───────────────────────────
   * Spec ranges:
   *   - Prev Positions         1-12   (13 buckets 0-12)
   *   - Last Positions W/L     1-4    (5 buckets each 0-4)
   *   - Continuous Positions   1-10   (11 buckets 0-10)
   *
   * The previous implementation under-bucketed (Math.min(5,...) for all
   * three context dimensions), which collapsed distinct spec-level
   * contexts into the same cache entry and silently reused stale Sets.
   * Now each dimension is clamped to its spec maximum so every
   * semantically distinct context produces a distinct fingerprint.
   *
   * Coordinated-vars vs. materialised-Sets: we chose the coordinated
   * approach — each qualifying base Set expands into at most
   * 13×5×5×11 = 3,575 theoretical fingerprints, but in practice the
   * operator only visits O(20-80) of them per symbol per run. The
   * alternative (materialising Sets for every combo) would blow the
   * 250-entry cap and thrash Redis with no accuracy win.
   *
   * ── P2-3: Closed-only contract for statistics-driven buckets ──────
   * `lastWins`, `lastLosses`, `prevPosCount`, `prevLosses` below are
   * closed-only by construction (see `getPositionContext` P2-1 gate).
   * `continuousCount` is intentionally live — Continuous Positions
   * denote currently-open pseudo positions per spec.
   */
  private variantFingerprint(
    baseSet: StrategySet,
    variant: "default" | "trailing" | "block" | "dca" | "pause",
    ctx: PositionContext,
  ): string {
    const bPF = Math.round(baseSet.avgProfitFactor * 10) / 10
    const bEC = baseSet.entryCount
    // Clamp each context dimension to its spec maximum.
    // cont is live-open by spec; the other four are closed-only via
    // the P2-1 gate in getPositionContext. lastPosCount is the Pause
    // variant's primary discriminator (1..8 windows) — adding it to the
    // fingerprint guarantees a 3-loss / 5-loss / 8-loss pause produce
    // distinct cached Sets instead of collapsing into the same bucket.
    const cont = Math.min(10, Math.max(0, ctx.continuousCount))
    const lW   = Math.min(4,  Math.max(0, ctx.lastWins))
    const lL   = Math.min(4,  Math.max(0, ctx.lastLosses))
    const lP   = Math.min(8,  Math.max(0, ctx.lastPosCount))
    const pP   = Math.min(12, Math.max(0, ctx.prevPosCount))
    const pL   = Math.min(12, Math.max(0, ctx.prevLosses))
    const bCtx = `c${cont}/lw${lW}/ll${lL}/lp${lP}/pp${pP}/pl${pL}`
    return `${baseSet.setKey}#${variant}#pf=${bPF}#ec=${bEC}#ctx=${bCtx}`
  }

  /**
   * Build one related Main Set from a qualifying Base Set + variant profile.
   * Returns `null` if all candidate entries are rejected by the DDT cap or
   * the Set ends up empty (shouldn't normally happen at Main thresholds).
   */
  /**
   * Build a Main variant Set from a Base Set + variant profile.
   *
   * Now `async` because the prune step delegates to the shared
   * compaction policy (cached settings hash, async resolution). The
   * cache TTL keeps this effectively synchronous in steady state.
   */
  private async buildVariantSet(
    baseSet: StrategySet,
    profile: ReturnType<StrategyCoordinator["variantProfiles"]>[number],
    metrics: EvaluationMetrics,
    maxEntries: number,
    ctx?: PositionContext,
  ): Promise<StrategySet | null> {
    const entries: StrategySetEntry[] = []
    let idx = 0

    outer: for (const baseEntry of baseSet.entries) {
      for (const cfg of profile.configs) {
        if (idx >= maxEntries) break outer
        // Project the base entry through the variant config
        const pf  = Math.max(metrics.minProfitFactor, baseEntry.profitFactor * cfg.pfBias)
        const ddt = baseEntry.drawdownTime + cfg.ddtBias
        if (ddt > metrics.maxDrawdownTime) continue

        entries.push({
          id: `${baseSet.setKey}-${profile.name}-${idx}`,
          sizeMultiplier: cfg.size,
          leverage:       cfg.leverage,
          positionState:  cfg.state,
          profitFactor:   pf,
          drawdownTime:   ddt,
          // Confidence is preserved from the base entry — the variant changes
          // sizing/leverage/state, not the underlying signal quality.
          confidence:     Math.min(0.99, baseEntry.confidence),
        })
        idx++
      }
    }

    if (entries.length === 0) return null
    const capped = await this.pruneEntries(entries, maxEntries)
    const avgPF  = capped.reduce((s, e) => s + Number(e.profitFactor  || 0), 0) / capped.length
    const avgCnf = capped.reduce((s, e) => s + Number(e.confidence    || 0), 0) / capped.length
    const avgDDT = capped.reduce((s, e) => s + Number(e.drawdownTime  || 0), 0) / capped.length

    // ── Axis-window snapshot for this Set ──���────────────────────────────
    // Mirrors the spec's four position-count axes with the documented
    // step-1 windows (see StrategySet.axisWindows). When ctx is absent
    // (legacy diagnostic call paths) we emit zeros, signalling "no axis
    // dimensioning available". The `last` axis encodes the total count
    // of recently-closed positions (lastPosCount, capped at 4) — using
    // the raw count rather than the directional skew keeps the axis
    // semantics consistent with the pause axis (which also counts all
    // recent closes) and avoids the two-counters vs one-counter mismatch.
    const axisWindows = ctx
      ? {
          prev:  Math.max(0, Math.min(12, ctx.prevPosCount)),
          last:  Math.max(0, Math.min(4,  ctx.lastPosCount)),
          cont:  Math.max(0, Math.min(8,  ctx.continuousCount)),
          pause: Math.max(0, Math.min(8,  ctx.lastPosCount)),
        }
      : { prev: 0, last: 0, cont: 0, pause: 0 }

    return {
      // Variant-scoped setKey — `direction:long#default`, `direction:long#block`, …
      // This guarantees unique identity downstream so Real/Live treat each
      // variant as a distinct Set while still letting consumers trace
      // lineage via `parentSetKey`.
      setKey:          `${baseSet.setKey}#${profile.name}`,
      parentSetKey:    baseSet.setKey,
      variant:         profile.name,
      axisWindows,
      indicationType:  baseSet.indicationType,
      direction:       baseSet.direction,
      avgProfitFactor: avgPF,
      avgConfidence:   avgCnf,
      avgDrawdownTime: avgDDT,
      entryCount:      capped.length,
      entries:         capped,
      createdAt:       new Date().toISOString(),
      // Propagate prev-pos snapshot from parent Base Set unchanged. Real
      // stage uses it to tune size/leverage; Live stage uses it for
      // ranking. We never recompute here — the Base-stage snapshot is
      // canonical for this Run cycle.
      ...(baseSet.prevPos && { prevPos: baseSet.prevPos }),
    }
  }

  /**
   * Enforce max entries per Set using the shared threshold-compaction
   * policy (`lib/sets-compaction.ts`) in `mode: "best"`.
   *
   *   • Floor       = caller-provided `max` (so existing call sites that
   *                   compute their own per-Set max keep working).
   *   • thresholdPct= operator-controlled (Settings → System → Set
   *                   Compaction). Defaults to 20% per spec, so a
   *                   `max=250` floor admits up to 300 entries before
   *                   the compactor fires.
   *   • Mode "best" = stable-sort by PF desc, keep top floor, then
   *                   re-sort by timestamp asc so chronological order
   *                   is preserved downstream.
   *
   * The result is the same shape the legacy pruner returned (best-PF
   * first within the kept set) — but it only does the sort + slice
   * once every (ceiling - floor) calls instead of every call. Hot
   * paths that build a Set from many indications now see a meaningful
   * CPU drop on the prune step.
   *
   * `compactionThresholdPct` is read once and cached on the coordinator
   * instance — see `getCompactionThresholdPct`.
   */
  private async pruneEntries(entries: StrategySetEntry[], max: number): Promise<StrategySetEntry[]> {
    if (entries.length <= max) return entries
    const thresholdPct = await this.getCompactionThresholdPct()
    const cfg: CompactionConfig = { floor: max, thresholdPct }
    return compact(entries, cfg, "best", (e) => Number(e.profitFactor) || 0)
  }

  /** Cached threshold-pct lookup. 5s effective TTL via the underlying helper. */
  private _compactionThresholdPctCache: { v: number; t: number } | null = null
  private async getCompactionThresholdPct(): Promise<number> {
    const cache = this._compactionThresholdPctCache
    if (cache && Date.now() - cache.t < 5_000) return cache.v
    try {
      // Use the coordinator-entries pool key — it carries the operator's
      // intent for "how aggressively to keep entries within a single
      // Set". Falls back to the global threshold (20%) when nothing
      // is configured.
      const cfg = await loadCompactionConfig("coordinator.entries")
      this._compactionThresholdPctCache = { v: cfg.thresholdPct, t: Date.now() }
      return cfg.thresholdPct
    } catch {
      return 20
    }
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map((r) => ({
        type: r.type,
        sets: r.passedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
      })),
      totalLiveSets: results.find((r) => r.type === "live")?.passedEvaluation || 0,
    }

    try {
      await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Strategy Sets flow: ${symbol}`, summary)
    } catch { /* non-critical */ }
  }
}
